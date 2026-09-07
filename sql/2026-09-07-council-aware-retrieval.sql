-- =============================================================================
-- Migration: council-aware retrieval
-- =============================================================================
-- Written against the VERIFIED live schema (see PROJECT_STATE.md section 11d),
-- not against assumptions. Run in the Supabase SQL Editor.
--
-- SAFETY: additive. Every new column is nullable or defaulted, and both RPCs
-- keep their existing parameters with the new ones defaulted to null - so the
-- application behaves exactly as it does today until it starts passing the new
-- arguments. The one destructive statement (step 5) drops a duplicate index
-- that is byte-for-byte redundant; it is called out separately and can be
-- skipped without affecting correctness.
--
-- Verified facts this migration relies on:
--   documents: id, region NOT NULL, jurisdiction_level, doc_type, title NOT NULL,
--              source_path NOT NULL, source_url, year, citation_ref, updated_at,
--              created_at
--   chunks:    id, document_id FK, chunk_index, content, page, clause, section,
--              region NOT NULL, doc_type, embedding vector, created_at,
--              page_label, clause_label, content_tsv
--   Only document id=815 ("National Planning Policy Framework", uk,
--   planning_policy) has chunks - 422 of them. All other 614 rows are empty.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Council identity, scope, provenance and version fields on documents
-- -----------------------------------------------------------------------------
alter table public.documents
  add column if not exists scope          text,
  add column if not exists lpa_slugs      text[],
  add column if not exists lpa_names      text[],
  add column if not exists plan_status    text,
  add column if not exists content_sha256 text;

-- Backfill before applying NOT NULL, so existing rows stay valid.
update public.documents set scope       = 'local'   where scope is null;
update public.documents set plan_status = 'unknown' where plan_status is null;

alter table public.documents
  alter column scope set default 'local',
  alter column scope set not null,
  alter column plan_status set default 'unknown',
  alter column plan_status set not null;

alter table public.documents drop constraint if exists documents_scope_check;
alter table public.documents
  add constraint documents_scope_check check (scope in ('national', 'local'));

-- 'unknown' is a first-class value: the tracker carries no reliable adoption
-- status, and a fabricated one is worse than an honest absence.
alter table public.documents drop constraint if exists documents_plan_status_check;
alter table public.documents
  add constraint documents_plan_status_check
  check (plan_status in ('adopted', 'emerging', 'superseded', 'unknown'));

-- -----------------------------------------------------------------------------
-- 2. Mark national policy
-- -----------------------------------------------------------------------------
-- The NPPF is the national layer. Local Plans get scope='local' plus their own
-- lpa_slugs at ingestion time.
do $$
declare
  n_total int;
  n_with_chunks int;
begin
  update public.documents
     set scope = 'national', lpa_slugs = null, lpa_names = null
   where doc_type = 'planning_policy' and region = 'uk';
  get diagnostics n_total = row_count;

  -- Rows with no chunks are ingestion debris: they can never be returned by
  -- retrieval, so their scope value is cosmetic. Report both numbers so the
  -- distinction is visible rather than assumed.
  select count(*) into n_with_chunks
    from public.documents d
   where d.scope = 'national'
     and exists (select 1 from public.chunks c where c.document_id = d.id);

  raise notice 'scope=national set on % rows, of which % actually have chunks',
    n_total, n_with_chunks;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Indexes for the new filters
-- -----------------------------------------------------------------------------
-- Array containment (d.lpa_slugs @> array['reading']) is the council filter.
create index if not exists documents_lpa_slugs_gin
  on public.documents using gin (lpa_slugs);

create index if not exists documents_scope_idx
  on public.documents (scope);

-- -----------------------------------------------------------------------------
-- 4. Ingestion idempotency
-- -----------------------------------------------------------------------------
-- Same PDF bytes => same hash => skip instead of re-embedding and appending a
-- duplicate set of chunks. Partial index so existing rows (hash null) are
-- unaffected and multiple nulls remain allowed.
create unique index if not exists documents_content_sha256_key
  on public.documents (content_sha256)
  where content_sha256 is not null;

-- -----------------------------------------------------------------------------
-- 5. Remove the duplicate vector index  (the only destructive statement)
-- -----------------------------------------------------------------------------
-- idx_chunks_embedding and idx_chunks_embedding_cosine are both
-- ivfflat (embedding vector_cosine_ops) WITH (lists='100') - the same index
-- twice, costing double writes and storage. Keeping idx_chunks_embedding.
-- Skip this line if you would rather verify independently first.
drop index if exists public.idx_chunks_embedding_cosine;

-- -----------------------------------------------------------------------------
-- 6. Retrieval RPCs: expose provenance + council fields, add optional filters
-- -----------------------------------------------------------------------------
-- Return type changes, so these must be dropped and recreated rather than
-- CREATE OR REPLACE'd. New parameters default to null => existing 4-argument
-- calls from the app keep working unchanged.
--
-- filter_lpa_slug semantics (the point of the whole migration):
--   null            -> no council constraint (today's behaviour)
--   'reading'       -> national documents OR documents whose lpa_slugs
--                      contains 'reading'. Other councils' Local Plans are
--                      excluded, which is what stops one council's policy
--                      being presented as another's.

-- Drop EVERY existing overload of both functions by name rather than by a
-- guessed argument list. A `drop function ... (vector, double precision, int,
-- text)` that does not match the live signature exactly is a silent no-op, and
-- the CREATE that follows would then fail with "cannot change return type of
-- existing function" - leaving the migration half-applied. This cannot miss.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('match_rag_chunks', 'match_rag_chunks_fulltext')
  loop
    raise notice 'dropping %', fn.sig;
    execute format('drop function %s', fn.sig);
  end loop;
end
$$;


create or replace function public.match_rag_chunks(
  query_embedding  vector,
  match_threshold  double precision,
  match_count      int,
  filter_region    text default null,
  filter_lpa_slug  text default null,
  filter_scope     text default null
)
returns table (
  id              bigint,
  region          text,
  jurisdiction    text,
  doc_title       text,
  doc_path        text,
  doc_url         text,
  doc_kind        text,
  scope           text,
  lpa_slugs       text[],
  lpa_names       text[],
  plan_status     text,
  clause_label    text,
  section_heading text,
  citation_full   text,
  content         text,
  distance        double precision,
  page_from       numeric,
  page_to         numeric
)
language sql
stable
as $function$
  select
    c.id,
    coalesce(c.region, d.region)      as region,
    d.jurisdiction_level              as jurisdiction,
    d.title                           as doc_title,
    d.source_path                     as doc_path,
    d.source_url                      as doc_url,
    coalesce(c.doc_type, d.doc_type)  as doc_kind,
    d.scope,
    d.lpa_slugs,
    d.lpa_names,
    d.plan_status,
    coalesce(c.clause_label, c.clause) as clause_label,
    c.section                          as section_heading,
    d.citation_ref                     as citation_full,
    c.content,
    (c.embedding <=> query_embedding)  as distance,
    nullif(c.page, '')::numeric        as page_from,
    nullif(c.page, '')::numeric        as page_to
  from chunks c
  join documents d on d.id = c.document_id
  where (filter_region is null or coalesce(c.region, d.region) = filter_region)
    and (filter_scope  is null or d.scope = filter_scope)
    and (
      filter_lpa_slug is null
      or d.scope = 'national'
      or d.lpa_slugs @> array[filter_lpa_slug]
    )
    and (1 - (c.embedding <=> query_embedding)) >= match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$function$;


create or replace function public.match_rag_chunks_fulltext(
  query_text       text,
  query_embedding  vector,
  match_count      int,
  filter_region    text default null,
  filter_lpa_slug  text default null,
  filter_scope     text default null
)
returns table (
  id              bigint,
  region          text,
  jurisdiction    text,
  doc_title       text,
  doc_path        text,
  doc_url         text,
  doc_kind        text,
  scope           text,
  lpa_slugs       text[],
  lpa_names       text[],
  plan_status     text,
  clause_label    text,
  section_heading text,
  citation_full   text,
  content         text,
  distance        double precision,
  page_from       numeric,
  page_to         numeric,
  rank            double precision
)
language sql
stable
as $function$
  select
    c.id,
    coalesce(c.region, d.region)      as region,
    d.jurisdiction_level              as jurisdiction,
    d.title                           as doc_title,
    d.source_path                     as doc_path,
    d.source_url                      as doc_url,
    coalesce(c.doc_type, d.doc_type)  as doc_kind,
    d.scope,
    d.lpa_slugs,
    d.lpa_names,
    d.plan_status,
    coalesce(c.clause_label, c.clause) as clause_label,
    c.section                          as section_heading,
    d.citation_ref                     as citation_full,
    c.content,
    (c.embedding <=> query_embedding)  as distance,
    nullif(c.page, '')::numeric        as page_from,
    nullif(c.page, '')::numeric        as page_to,
    ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', query_text))::double precision as rank
  from chunks c
  join documents d on d.id = c.document_id
  where (filter_region is null or coalesce(c.region, d.region) = filter_region)
    and (filter_scope  is null or d.scope = filter_scope)
    and (
      filter_lpa_slug is null
      or d.scope = 'national'
      or d.lpa_slugs @> array[filter_lpa_slug]
    )
    and c.content_tsv @@ websearch_to_tsquery('english', query_text)
  order by rank desc
  limit match_count;
$function$;

commit;

-- -----------------------------------------------------------------------------
-- Verification (run after committing)
-- -----------------------------------------------------------------------------
select scope, plan_status, count(*) from public.documents group by 1, 2 order by 3 desc;

-- Should return the NPPF's chunks: national policy is visible even when a
-- council filter is applied.
-- select count(*) from public.match_rag_chunks_fulltext(
--   'green belt', (select embedding from public.chunks limit 1), 10, 'uk', 'reading');
