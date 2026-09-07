-- Hybrid search setup: adds Postgres full-text search alongside the
-- existing pgvector similarity search, so exact terms (clause numbers,
-- policy references, defined terms like "Policy S3") that dense
-- embeddings tend to blur past can still be found directly. Run this
-- once in the Supabase SQL editor.
--
-- app/api/rag-chat/route.ts's searchRAG() now calls match_rag_chunks
-- (vector) and match_rag_chunks_fulltext (keyword, defined below) in
-- parallel and merges the two ranked lists with Reciprocal Rank Fusion.

-- 1. Generated tsvector column + GIN index for fast full-text search.
--    "generated always as ... stored" keeps it automatically in sync
--    with content - no trigger needed, no re-ingestion needed for
--    existing rows (Postgres backfills it when the column is added).
alter table chunks
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english', content)) stored;

create index if not exists chunks_content_tsv_idx
  on chunks using gin(content_tsv);

-- 2. Full-text search function. Same return shape as match_rag_chunks
--    (see sql/ or the earlier match_rag_chunks migration) so the
--    application can map both result sets with one function. It still
--    computes a REAL cosine distance against query_embedding, even
--    though the candidate set and ordering here come from ts_rank, not
--    distance - that way every chunk, whichever search path found it,
--    carries a genuine, comparable similarity score downstream (this is
--    what the confidence badges and the topSimilarity gate both read).
drop function if exists match_rag_chunks_fulltext(text, vector(768), int, text);

create or replace function match_rag_chunks_fulltext(
  query_text text,
  query_embedding vector(768),
  match_count int,
  filter_region text default null
)
returns table (
  id bigint,
  region text,
  jurisdiction text,
  doc_title text,
  doc_path text,
  doc_kind text,
  clause_label text,
  section_heading text,
  citation_full text,
  content text,
  distance float,
  page_from numeric,
  page_to numeric,
  rank float
)
language sql stable
as $$
  select
    c.id,
    coalesce(c.region, d.region) as region,
    d.jurisdiction_level as jurisdiction,
    d.title as doc_title,
    d.source_path as doc_path,
    coalesce(c.doc_type, d.doc_type) as doc_kind,
    coalesce(c.clause_label, c.clause) as clause_label,
    c.section as section_heading,
    d.citation_ref as citation_full,
    c.content,
    (c.embedding <=> query_embedding) as distance,
    nullif(c.page, '')::numeric as page_from,
    nullif(c.page, '')::numeric as page_to,
    ts_rank_cd(c.content_tsv, websearch_to_tsquery('english', query_text)) as rank
  from chunks c
  join documents d on d.id = c.document_id
  where (filter_region is null or coalesce(c.region, d.region) = filter_region)
    and c.content_tsv @@ websearch_to_tsquery('english', query_text)
  order by rank desc
  limit match_count;
$$;
