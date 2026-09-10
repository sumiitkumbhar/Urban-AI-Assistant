-- Answer cache: a two-layer "memory" that sits in front of the RAG
-- pipeline for stateless questions (no visitorId/conversationId - see
-- the cacheEligible check in app/api/rag-chat/route.ts). Layer 1 is an
-- in-process Map (lib/answerCache.ts) for exact-repeat wording within
-- one running server - instant, but gone on restart. This migration is
-- Layer 2: it persists across restarts and is shared by every request
-- hitting this Supabase project, and it matches on MEANING (cosine
-- similarity over the question's embedding), not just exact text, so
-- "can I convert my loft" and "loft conversion rules" can both hit the
-- same cached answer.
--
-- On a hit, the ENTIRE stored RagResponse JSON is replayed as-is,
-- skipping the embedding call, both Supabase retrieval RPCs, and every
-- Groq call (rerank / generate / groundedness / voice humanize) that a
-- fresh answer would otherwise pay for one at a time.
--
-- Deliberately scoped to stateless requests only: a cached answer is
-- never built from a visitor's own uploaded documents or conversation
-- history, so nothing personal can ever be served back to someone else
-- from this table. See the comment above cacheEligible in route.ts for
-- the full list of conditions.
--
-- Run this once in the Supabase SQL editor (same as the other files in
-- this directory).

create table if not exists qa_cache (
  id bigint generated always as identity primary key,

  -- Trimmed/lowercased/whitespace-collapsed retrieval query - exact-match
  -- key for Layer 1 and a cheap pre-filter here.
  question_normalized text not null,

  -- Truncated to 768 dims, same as chunks.embedding - see
  -- EMBEDDING_DIMENSIONS in lib/embeddings.ts.
  question_embedding vector(768) not null,

  -- Council slug this answer is scoped to, or the literal string
  -- 'NATIONAL' for questions with no specific authority. Answers differ
  -- by council, so this is part of the match, never just a label.
  council_scope text not null default 'NATIONAL',

  -- body.region ('india' | 'uk' | 'usa'), or the literal string 'any'
  -- when the caller didn't specify one. Kept NOT NULL (rather than
  -- nullable) purely so the unique index below can be a plain
  -- multi-column index instead of an expression index - simpler to
  -- upsert against from the Supabase JS client.
  region text not null default 'any',

  -- speechText is only populated for voice-mode responses, so a
  -- voice-mode answer and a text-mode answer for the same question are
  -- cached separately rather than one silently missing speech audio.
  voice_mode boolean not null default false,

  -- The exact JSON object returned to the client (RagResponse) for this
  -- question - replayed byte-for-byte on a hit except for
  -- metadata.processing_time, which is overwritten with the (near-zero)
  -- time the cache lookup itself took.
  response jsonb not null,

  hit_count int not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz
);

-- Layer 1 warms itself from a Layer-2 hit, and a Layer-2 store happens
-- once per distinct (question, scope, region, voice_mode) - this keeps
-- a second identical question from ever writing a duplicate row instead
-- of refreshing the existing one.
create unique index if not exists qa_cache_exact_idx
  on qa_cache (question_normalized, council_scope, region, voice_mode);

-- Approximate nearest-neighbor index for the semantic lookup. lists=100
-- is a reasonable default for a cache table that's expected to stay in
-- the thousands-of-rows range, not millions - revisit if it grows much
-- larger than that.
create index if not exists qa_cache_embedding_idx
  on qa_cache using ivfflat (question_embedding vector_cosine_ops)
  with (lists = 100);

-- Semantic lookup. Deliberately conservative similarity_threshold
-- default (0.93) - a false-positive cache hit hands back a wrong answer
-- with total confidence, which is worse than the cache miss it's meant
-- to avoid. max_age_seconds guards against ever serving a stale answer
-- forever if the underlying documents get re-ingested/updated - pass
-- the same freshness window you're comfortable with (default here: 6
-- hours) rather than relying on this table being cleared manually.
drop function if exists match_qa_cache(vector(768), text, text, boolean, float, int, int);

create or replace function match_qa_cache(
  query_embedding vector(768),
  filter_council_scope text,
  filter_region text,
  filter_voice_mode boolean,
  similarity_threshold float default 0.93,
  max_age_seconds int default 21600,
  match_count int default 1
)
returns table (
  id bigint,
  response jsonb,
  similarity float
)
language sql stable
as $$
  select
    c.id,
    c.response,
    1 - (c.question_embedding <=> query_embedding) as similarity
  from qa_cache c
  where c.council_scope = filter_council_scope
    and c.region = filter_region
    and c.voice_mode = filter_voice_mode
    and c.created_at > now() - make_interval(secs => max_age_seconds)
    and 1 - (c.question_embedding <=> query_embedding) >= similarity_threshold
  order by c.question_embedding <=> query_embedding asc
  limit match_count;
$$;

-- Atomic hit-count bump, called fire-and-forget on every cache hit so
-- two concurrent hits on the same row can't race and lose an
-- increment the way a read-then-write from the application would.
create or replace function bump_qa_cache_hit(row_id bigint)
returns void
language sql
as $$
  update qa_cache
  set hit_count = hit_count + 1,
      last_hit_at = now()
  where id = row_id;
$$;
