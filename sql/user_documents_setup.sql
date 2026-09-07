-- User-uploaded document RAG: lets someone attach a PDF/DOCX/image to a
-- conversation and have its content retrieved alongside the shared
-- NPPF/regulatory corpus whenever they ask a question in that same chat
-- (e.g. "what can be done in this scenario as per NPPF" after uploading a
-- site plan or a scanned letter). Run this once in the Supabase SQL Editor
-- (same convention as sql/chat_history_setup.sql and
-- sql/hybrid_search_setup.sql).
--
-- Kept in its own tables, NOT mixed into the shared documents/chunks
-- corpus tables, on purpose:
--   - every query here is scoped by conversation_id (enforced in
--     application code - see lib/userDocuments.ts), so one visitor's
--     upload can never leak into another visitor's answers
--   - it can't bloat or pollute the shared corpus every other user's
--     questions are retrieved against
--   - it's bulk-deleted for free via "on delete cascade" from
--     conversations, so an old anonymous chat's uploads don't linger
--     forever

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists user_documents (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  visitor_id text,
  filename text not null,
  file_type text not null, -- 'pdf' | 'docx' | 'image'
  status text not null default 'processing', -- 'processing' | 'ready' | 'failed'
  error text,
  chunk_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists user_documents_conversation_idx
  on user_documents (conversation_id, created_at asc);

create table if not exists user_document_chunks (
  id bigserial primary key,
  document_id uuid not null references user_documents(id) on delete cascade,
  -- Denormalized onto every chunk row (rather than joined through
  -- user_documents each query) so match_user_document_chunks below can
  -- filter with a single indexed equality check - this table is queried
  -- on every chat turn in a conversation that has an upload.
  conversation_id uuid not null references conversations(id) on delete cascade,
  chunk_index int not null,
  -- Page the chunk came from for a PDF (1-based); null for DOCX/image
  -- uploads, which have no page concept - mirrors how the shared
  -- `chunks` table's page_from/page_to already work for citations.
  page_number int,
  content text not null,
  embedding vector(768) not null,
  created_at timestamptz not null default now()
);

create index if not exists user_document_chunks_conversation_idx
  on user_document_chunks (conversation_id);

-- IVFFlat needs a reasonable row count to train useful lists against;
-- per-conversation corpora here are typically small (a handful of
-- documents), so this index matters less than the one on the shared
-- `chunks` table, but it's cheap insurance for conversations that
-- accumulate a lot of uploads.
create index if not exists user_document_chunks_embedding_idx
  on user_document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Same shape philosophy as match_rag_chunks_fulltext in
-- sql/hybrid_search_setup.sql: a plain SQL function the app calls via
-- supabase.rpc(...). No full-text companion here - conversation-scoped
-- corpora are small enough that vector similarity alone is plenty, and it
-- keeps the merge logic in app/api/rag-chat/route.ts simple.
drop function if exists match_user_document_chunks(vector(768), uuid, int);

create or replace function match_user_document_chunks(
  query_embedding vector(768),
  match_conversation_id uuid,
  match_count int default 12
)
returns table (
  id bigint,
  document_id uuid,
  chunk_index int,
  page_number int,
  content text,
  distance float
)
language sql stable
as $$
  select
    c.id,
    c.document_id,
    c.chunk_index,
    c.page_number,
    c.content,
    (c.embedding <=> query_embedding) as distance
  from user_document_chunks c
  where c.conversation_id = match_conversation_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- No RLS policies: same rationale as chat_history_setup.sql - only ever
-- touched server-side with the Supabase service-role key, and ownership
-- (visitor_id / conversation_id) is checked in application code.
