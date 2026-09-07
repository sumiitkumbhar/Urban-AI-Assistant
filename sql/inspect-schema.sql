-- =============================================================================
-- READ-ONLY schema inspection. Run in the Supabase SQL Editor.
-- =============================================================================
-- Nothing here writes, alters, or drops anything. Its purpose is to establish
-- what the database ACTUALLY contains before any council-aware retrieval work
-- is designed against it, because the documents/chunks DDL is not in this repo
-- and the assistant's network cannot reach Supabase to look.
--
-- TIP: sql/inspect-schema-oneshot.sql runs all of this as ONE query returning
-- a single JSON cell - easier to copy. Use this file only if you prefer to run
-- the checks separately.
--
-- Run each block and send back the output. Block 5 is also the "database size
-- before" baseline for the pilot storage measurement.
-- =============================================================================

-- 1. Exact columns of documents and chunks (incl. vector dimensions via udt_name)
select
  table_name,
  ordinal_position as pos,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('documents', 'chunks')
order by table_name, ordinal_position;

-- 2. The retrieval RPCs as they actually exist (not as the repo assumes)
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('match_rag_chunks', 'match_rag_chunks_fulltext')
order by p.proname;

-- 3. Indexes (tells us which vector index type is in use, and its cost)
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('documents', 'chunks')
order by tablename, indexname;

-- 4. Constraints (needed before adding any unique key for idempotency)
select
  tc.table_name,
  tc.constraint_name,
  tc.constraint_type,
  string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as columns
from information_schema.table_constraints tc
left join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
 and kcu.table_schema = tc.table_schema
where tc.table_schema = 'public'
  and tc.table_name in ('documents', 'chunks')
group by tc.table_name, tc.constraint_name, tc.constraint_type
order by tc.table_name, tc.constraint_type;

-- 5. Current size and volume - the "before" baseline for the pilot
select
  pg_size_pretty(pg_database_size(current_database())) as database_size,
  pg_size_pretty(pg_total_relation_size('public.chunks'))    as chunks_total,
  pg_size_pretty(pg_relation_size('public.chunks'))          as chunks_heap,
  pg_size_pretty(pg_indexes_size('public.chunks'))           as chunks_indexes,
  pg_size_pretty(pg_total_relation_size('public.documents')) as documents_total;

select
  (select count(*) from public.documents) as documents_rows,
  (select count(*) from public.chunks)    as chunks_rows;

-- 6. What is already in the corpus (confirms whether anything beyond the NPPF
--    was ever ingested, and which region/doc_type values are really in use)
select region, doc_type, count(*) as docs
from public.documents
group by region, doc_type
order by docs desc;

select id, title, region, jurisdiction_level, doc_type, source_path, source_url
from public.documents
order by id
limit 20;

-- 7. Does the column the ingester writes to actually exist?
--    (chromaIngest.ts inserts source_url; if this returns 0 rows, every
--     ingestion insert will fail immediately.)
select count(*) as source_url_column_exists
from information_schema.columns
where table_schema = 'public' and table_name = 'documents' and column_name = 'source_url';
