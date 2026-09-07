# Proposal: move the planning corpus to local PostgreSQL + pgvector

**Status: proposal only. No code changed, nothing migrated.**
Written 2026-09-07 against the verified live schema (PROJECT_STATE.md §11d).

---

## Summary

Splitting the corpus onto local Postgres is **technically a small change** — the
corpus touches only **4 call sites** in the whole codebase, `pg` is already a
dependency, and the SQL is plain Postgres + pgvector with nothing Supabase-
specific in it.

The catch is not technical. **A local database cannot back a public portfolio
URL.** That trade-off, and how to keep both, is section 11 — read that before
approving anything.

---

## 1. Is Docker the right local setup?

**Yes, with the official `pgvector/pgvector` image.** Recommended over the
alternatives for this repo:

| Option | Verdict |
|---|---|
| **Docker + `pgvector/pgvector`** | **Recommended.** pgvector pre-built, no compiling, version pinned in a compose file that lives in the repo, trivially reproducible and trivially deleted. |
| Postgres.app | Simple, but pgvector must be built/installed separately per Postgres version — a manual step that is easy to get wrong and impossible to pin in the repo. |
| Homebrew `postgresql@N` + `pgvector` | Works (`brew install pgvector`), but couples the database to the machine's brew state and mixes it with anything else using that Postgres. |
| Supabase CLI local stack | Reproduces Supabase locally, but pulls Auth/Storage/Realtime/Studio containers this project does not use. Heavier for no benefit. |

Docker also keeps the corpus **isolated from the machine** — one volume to back
up, one command to reset.

**Prerequisite to check first:** Docker Desktop's disk image has its own size
cap (commonly ~64 GB default, adjustable in settings). The full corpus estimate
below is ~3 GB, so this is comfortable, but confirm before bulk ingestion.

## 2. Versions

- **PostgreSQL 17** (or 16). Both are well within pgvector support; 17 unless
  something else pins you lower.
- **pgvector 0.8.x** — pin an exact tag such as `pgvector/pgvector:pg17`, then
  record the resolved version in the compose file.

*Not verified live:* I could not fetch the pgvector release page this session
(rate limit), so treat the exact patch version as "confirm at install" rather
than as checked fact. `select extversion from pg_extension where extname='vector';`
after setup, and record it.

**Two capabilities worth using, both post-0.7:**
- **HNSW indexes** — materially better recall/latency than IVFFlat, and no
  `lists` parameter to mistune (the current database has `lists=100` on 422
  rows, which is badly wrong; see §11d).
- **`halfvec`** — 2-byte floats. For 768 dimensions that is **1.5 KB/vector
  instead of 3 KB**, roughly halving embedding storage at negligible recall
  cost for this use case. Relevant to §10, and available on Supabase too.

## 3. Will the existing schema and RPCs run unchanged?

**Yes — essentially verbatim.** I checked the actual SQL rather than assuming.

`match_rag_chunks` and `match_rag_chunks_fulltext` use only:
`vector` / `<=>` (pgvector), `tsvector`, `to_tsvector`, `websearch_to_tsquery`,
`ts_rank_cd`, generated columns, GIN indexes, and `language sql` functions.

**Every one of those is standard PostgreSQL or pgvector.** There is no
`auth.uid()`, no RLS policy, no `supabase_functions`, no PostgREST-specific
construct, no Supabase extension. Supabase is being used here as ordinary
managed Postgres.

Two mechanical notes:
- Functions are called through PostgREST today (`.rpc(...)`). Locally they can
  stay as functions called with `select * from match_rag_chunks($1,$2,$3,$4)`,
  or the SQL can be inlined into the query. **Keeping them as functions is
  preferred** — same SQL, same behaviour, one code path.
- `create extension if not exists vector;` must run once on the local database.
  Supabase does this for you.

## 4. Supabase-specific code (audited, not assumed)

`lib/supabase.ts` is 30 lines: a lazily-constructed `createClient(url, key)`
using `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. No auth, storage,
realtime or RLS anywhere.

Full corpus coupling — **4 call sites**:

| File | Call | Moves? |
|---|---|---|
| `app/api/rag-chat/route.ts:2271` | `.rpc("match_rag_chunks")` | → local |
| `app/api/rag-chat/route.ts:2277` | `.rpc("match_rag_chunks_fulltext")` | → local |
| `lib/chromaIngest.ts` | `.from("documents").insert()` | → local |
| `lib/chromaIngest.ts` | `.from("chunks").insert()` | → local |

Everything else stays on Supabase and is untouched:

| Concern | Tables | Call sites |
|---|---|---|
| Conversation memory | `conversations`, `chat_messages` | ~11 |
| Uploaded documents | `user_documents`, `user_document_chunks`, `match_user_document_chunks` | ~8 |

**The split you proposed maps exactly onto the code.** The corpus is the part
that is both large and read-only; conversation data is small, write-heavy, and
genuinely benefits from being hosted.

## 5. The `searchCorpus()` interface — yes, and it is the key to the whole plan

```ts
// lib/corpus/types.ts
export interface CorpusSearchParams {
  queryEmbedding: number[];
  queryText: string;
  region?: string | null;
  lpaSlug?: string | null;     // council-aware retrieval
  scope?: "national" | "local" | null;
  topK?: number;
  threshold?: number;
}

export interface CorpusRepository {
  searchVector(p: CorpusSearchParams): Promise<CorpusChunk[]>;
  searchFulltext(p: CorpusSearchParams): Promise<CorpusChunk[]>;
  insertDocument(doc: CorpusDocumentInput): Promise<number>;
  insertChunks(documentId: number, chunks: CorpusChunkInput[]): Promise<number>;
  findByContentHash(sha256: string): Promise<number | null>;  // idempotency
}
```

Two implementations — `SupabaseCorpusRepository` (today's code, moved) and
`PostgresCorpusRepository` (`pg` Pool) — selected by one env var. `searchRAG()`
keeps its RRF merge, reranking, gating and citation logic **completely
unchanged**; it stops calling `.rpc()` directly and calls the repository
instead.

Because both implementations return the same shape, this also gives you:
- a way to run local for development and Supabase for the public deploy **from
  the same codebase**, which section 11 depends on;
- somewhere honest to put the idempotency and hash logic;
- the ability to A/B the two backends on identical queries.

This is the one piece of new abstraction I would introduce. It is small, it is
justified by a real second implementation, and it is not a RAG rewrite.

## 6. Connecting Next.js to local Postgres safely

- **`pg` is already a dependency** (`pg@^8.16.3`, `@types/pg` in devDeps). No
  new package.
- Use a module-scoped `Pool` with a small `max` (5–10), created lazily exactly
  like `getSupabase()` does today, so `next build` never needs a live database.
- Bind Postgres to **`127.0.0.1:5432` only** (`ports: "127.0.0.1:5432:5432"` in
  compose). Not `0.0.0.0` — that would expose it to the local network.
- Server-only: the corpus module must never be imported by a client component,
  and the connection string must **never** use a `NEXT_PUBLIC_` name. All
  corpus routes are already `runtime = "nodejs"`.
- Local dev over loopback does not need TLS; a hosted Postgres later will.
- Credentials in `.env.local`, which is already gitignored and verified clean.

## 7. Environment variables

```bash
# Which backend serves the corpus. Absent or "supabase" = today's behaviour.
CORPUS_BACKEND=postgres          # supabase | postgres

# Only read when CORPUS_BACKEND=postgres
CORPUS_DATABASE_URL=postgresql://urbanai:<password>@127.0.0.1:5432/urbanai_corpus

# Unchanged - still Supabase, for conversations and uploads
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Defaulting `CORPUS_BACKEND` to `supabase` means **the app works exactly as it
does today if the variable is missing** — no forced migration, and the public
deploy keeps working untouched.

## 8. The 422 NPPF chunks: migrate or re-ingest?

**Re-ingest locally. Do not migrate.**

- The source PDF is already in the repo (`documents-to-ingest/`), so there is
  nothing to download.
- 422 chunks re-embedded sequentially at the existing rate limit is roughly
  10–15 minutes, unattended, and free.
- It exercises the local ingestion path end to end — which is exactly what you
  want proven before ingesting councils.
- Migrating instead means exporting `vector` literals, matching dimensions and
  re-inserting, for a corpus small enough that the export tooling costs more
  than re-running the pipeline.

Keep the Supabase copy untouched as a fallback until local retrieval is proven.
Migration only becomes the better option once the corpus is large enough that
re-embedding is slow or rate-limited — worth revisiting at 50+ councils.

## 9. Council-aware retrieval, provenance, dedup — all unchanged

`sql/2026-09-07-council-aware-retrieval.sql` **runs on local Postgres as-is.**
Everything in it is standard: `text[]` columns, GIN index on the array, check
constraints, a partial unique index on `content_sha256`, and the two recreated
functions.

So `scope`, `lpa_slugs`, `lpa_names`, `plan_status`, `source_url` provenance,
and hash-based deduplication behave identically on either backend — which is
the point of doing the migration file first and the backend decision second.

The local database is arguably a *better* home for it: schema changes need no
dashboard, migrations are ordinary files, and there is no free-tier ceiling
forcing corpus decisions.

## 10. Storage for all 446 unique Local Plans (local Postgres)

Grounded in real measurements, not theory: the NPPF measured **2.7 chunks/page**
and **919 chars/chunk** with this repo's chunker, and the live database shows
**≈6.5 KB/chunk of data** (heap + TOAST) at `vector(768)` float4.

| Avg pages/plan | Chunks | Data (float4) | Data (halfvec) | + HNSW + GIN | Total (halfvec) |
|---|---|---|---|---|---|
| 150 | ~181,000 | ~1.2 GB | ~0.9 GB | ~0.8 GB | **~1.7 GB** |
| 250 | ~301,000 | ~2.0 GB | ~1.5 GB | ~1.3 GB | **~2.8 GB** |
| 400 | ~482,000 | ~3.1 GB | ~2.4 GB | ~2.0 GB | **~4.4 GB** |

**On a Mac this is a non-issue** — a few GB against hundreds. The 500 MB ceiling
disappears entirely, and with it the pressure to shrink the corpus for the wrong
reasons.

Two honest caveats: page counts are still estimates (no PDFs downloaded yet), and
ingesting ~300k chunks means ~300k Gemini embedding calls — at the current
sequential rate-limited pace that is **days of wall-clock time**, not hours.
Storage stops being the constraint; embedding throughput becomes it.

## 11. Deployment consequences — read this before approving

This is the real cost, and it cuts against "portfolio-ready".

### Local development / demo
Ideal. Full corpus, no ceiling, fast, free, no network round-trip to Supabase
for retrieval. Best possible version of the app.

### Public hosted portfolio — **this is the problem**
A Postgres running on your MacBook **cannot serve a deployed site**. If the app
is on Vercel, it cannot reach `127.0.0.1` on your laptop. Exposing it via a
tunnel means your Mac must be awake, online and publicly reachable — not a
portfolio you can link to on a CV.

So the corpus backend and the public deploy have to be answered together:

| Option | Public link works? | Cost | Corpus size |
|---|---|---|---|
| **A. Local for dev, Supabase free for the public deploy** | Yes | £0 | Full locally; curated ~30–60 councils publicly |
| **B. Hosted Postgres** (Neon / Railway / Fly / Render) | Yes | £0 on small free tiers, then paid | Free tiers are also ~0.5 GB — the same ceiling reappears |
| **C. Supabase Pro** | Yes | ~$25/mo | 8 GB — full corpus |
| **D. Local only, demo by video + repo** | No live link | £0 | Full |

**Recommendation: A.** The `searchCorpus()` interface makes it a one-env-var
difference, and it is the only option that gives you both an unconstrained
corpus for development *and* a working public URL at zero cost. A curated
30–60 council public deploy demonstrates the architecture just as convincingly
as 446 — your own reasoning, and I agree with it.

### Future production
If this ever becomes real, the corpus wants managed Postgres with pgvector
(Supabase Pro, Neon, RDS). The repository interface means that is a
configuration change, not a rewrite — which is the main long-term argument for
building it now rather than later.

---

## Proposed sequence (on approval)

1. `docker-compose.yml` + `sql/local-corpus-init.sql` (extension, schema, the
   council-aware migration applied from the start). **No app code touched.**
2. Verify: extension version, schema created, functions callable.
3. Introduce `CorpusRepository` + the Supabase implementation, switch
   `searchRAG()` to it. `CORPUS_BACKEND` unset → identical behaviour. Type-check
   and confirm nothing changed.
4. Add the Postgres implementation. Re-ingest the NPPF locally. Compare
   retrieval on both backends for the same questions.
5. Only then: the five-council pilot, locally, with real storage measured.

Steps 1–2 are reversible by deleting a container. Step 3 is behaviour-preserving
by construction. Nothing is migrated away from Supabase at any point.

## What I would not do

- **No ChromaDB or other vector database.** The stack is already Postgres +
  pgvector, the SQL is portable, and a second engine would mean a genuine RAG
  rewrite plus a second thing to host. There is no technical reason here.
- **No change to conversation/upload storage.** Small, write-heavy, needs to be
  hosted for a public deploy. Supabase is the right home.
- **No RAG pipeline rewrite.** RRF merge, reranking, gating, groundedness and
  citations stay exactly as they are.
