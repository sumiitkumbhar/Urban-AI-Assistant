-- =============================================================================
-- READ-ONLY schema inspection - ONE query, ONE result cell.
-- =============================================================================
-- Supabase's SQL Editor only shows the LAST result set when several statements
-- are run together, so everything is bundled into a single JSON value here.
-- Run this, click the result cell, copy it, and send it back.
--
-- Nothing here writes, alters or drops anything.
-- (sql/inspect-schema.sql has the same checks split into readable blocks if
--  you would rather run them one at a time.)
-- =============================================================================

select jsonb_pretty(jsonb_build_object(

  'source_url_column_exists', (
    select count(*) from information_schema.columns
    where table_schema='public' and table_name='documents' and column_name='source_url'
  ),

  'columns', (
    select jsonb_agg(jsonb_build_object(
      'table', table_name, 'pos', ordinal_position, 'column', column_name,
      'type', data_type, 'udt', udt_name, 'nullable', is_nullable, 'default', column_default
    ) order by table_name, ordinal_position)
    from information_schema.columns
    where table_schema='public' and table_name in ('documents','chunks')
  ),

  'functions', (
    select jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'args', pg_get_function_identity_arguments(p.oid),
      'definition', pg_get_functiondef(p.oid)
    ) order by p.proname)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('match_rag_chunks','match_rag_chunks_fulltext')
  ),

  'indexes', (
    select jsonb_agg(jsonb_build_object('table', tablename, 'name', indexname, 'def', indexdef)
                     order by tablename, indexname)
    from pg_indexes
    where schemaname='public' and tablename in ('documents','chunks')
  ),

  'constraints', (
    select jsonb_agg(x order by x->>'table')
    from (
      select jsonb_build_object(
        'table', tc.table_name, 'name', tc.constraint_name, 'type', tc.constraint_type,
        'columns', string_agg(kcu.column_name, ', ' order by kcu.ordinal_position)
      ) as x
      from information_schema.table_constraints tc
      left join information_schema.key_column_usage kcu
        on kcu.constraint_name=tc.constraint_name and kcu.table_schema=tc.table_schema
      where tc.table_schema='public' and tc.table_name in ('documents','chunks')
      group by tc.table_name, tc.constraint_name, tc.constraint_type
    ) s
  ),

  'sizes', jsonb_build_object(
    'database',        pg_size_pretty(pg_database_size(current_database())),
    'chunks_total',    pg_size_pretty(pg_total_relation_size('public.chunks')),
    'chunks_heap',     pg_size_pretty(pg_relation_size('public.chunks')),
    'chunks_indexes',  pg_size_pretty(pg_indexes_size('public.chunks')),
    'documents_total', pg_size_pretty(pg_total_relation_size('public.documents'))
  ),

  'counts', jsonb_build_object(
    'documents', (select count(*) from public.documents),
    'chunks',    (select count(*) from public.chunks)
  ),

  'corpus_breakdown', (
    select jsonb_agg(jsonb_build_object('region', region, 'doc_type', doc_type, 'docs', docs)
                     order by docs desc)
    from (select region, doc_type, count(*) as docs
          from public.documents group by region, doc_type) t
  ),

  'sample_documents', (
    select jsonb_agg(to_jsonb(d) order by d.id)
    from (select id, title, region, jurisdiction_level, doc_type, source_path
          from public.documents order by id limit 15) d
  )

)) as inspection;
