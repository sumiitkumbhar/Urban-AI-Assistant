# Local RAG (offline corpus retrieval)

The offline equivalent of `app/api/rag-chat/route.ts`'s `searchRAG()` +
`rerankWithGroq()` + `generateAnswer()` chain, reading from your local
`~/Desktop/Corpus` instead of Supabase. Built per Phase 2/3 of
`URBAN_AI_ARCHITECTURE_README.md`.

## What it is / isn't (read this first)

This proves offline retrieval works end to end - ask a question, get a
cited answer, no Supabase involved. It is **not yet wired into the live
Next.js chat UI** - that's Phase 4 orchestration work, deliberately left
for later per the README's own "don't build everything at once" rule.
Right now it's a standalone service you can query directly (CLI or HTTP)
to test and validate before deciding how/whether to connect it to the
app.

It ingests the whole corpus except confirmed exact-duplicate copies (17
byte-identical PDFs the Phase 1 triage flagged) - see `corpus_manifest.json`
and `Urban_AI_Corpus_Triage.xlsx` in the Corpus folder for the full
per-file triage. That's a deliberate widening from the original
ACTIVE_CORE/ACTIVE_SUPPORTING-only default (76 of 202 files): it now
also pulls in REFERENCE_ONLY material - historic/superseded policy
versions, consultation drafts, conservation-area audits for areas with
no chosen demo site yet - so a query can surface an outdated version of a
policy alongside the current one. `retrieve.py` now gives current-status
material a small score boost over historic/superseded/draft versions
(each chunk carries the manifest's `status` field), so it's a soft
preference rather than a hard filter - a historic version can still win
if it's a genuinely stronger match, it just doesn't tie with the current
one by default anymore. The non-PDF biodiversity-metric calculator
spreadsheets (.xlsx/.xlsm) are attempted but always skipped with a
logged warning - they need spreadsheet-specific extraction this pipeline
doesn't have.

## One-time setup

Double-click **"Setup and Ingest Local RAG.command"** on your Desktop.
This has to run in your own Terminal, not through Claude - the bridge
Claude reaches your Mac through runs in an isolated sandbox with a
different OS underneath, so any Python packages installed *there*
(compiled ones like torch especially) can't run on your actual Mac. That
script:

1. Creates a venv in this folder (`local-rag/venv`) if one doesn't exist.
2. Installs `requirements.txt` into it (first run downloads two small
   local models too - a ~130MB embedder and a ~90MB reranker - both
   cached after that).
3. Runs `ingest.py`, which reads every eligible PDF, chunks it, embeds
   it, and builds the local Qdrant + BM25 indexes under `data/`. Takes a
   few minutes on 76 files; progress is printed and also logged to
   `data/ingest.log`.

Re-run it any time the corpus or the triage manifest changes - it
rebuilds `data/` from scratch rather than trying to update it in place.

## Using it

Quick manual test, no server needed:

```bash
source venv/bin/activate
python3 query_cli.py "what does policy d3 say about design"
```

As an HTTP service (mirrors `voice-service`'s own pattern - a FastAPI
app with file logging, on its own port so it can run alongside the
Next.js app and voice-service):

```bash
source venv/bin/activate
uvicorn service:app --host 0.0.0.0 --port 8010
```

```bash
curl -s -X POST http://localhost:8010/query \
  -H "Content-Type: application/json" \
  -d '{"question": "what does policy d3 say about design"}'
```

## How retrieval works

```
question
  |
  +-- dense search (Qdrant, local BGE embeddings) <-- semantic search,
  |                                                    always runs
  +-- sparse search (BM25 over the same chunks)
  |        \
  |         +-- exact-reference boost (regex for "Policy D3",
  |             "Paragraph 135", "Approved Document B", etc.)
  |         +-- graph-expanded reference boost (smaller boost for
  |             references that co-occur with the query's named
  |             reference in the cross-reference graph - e.g. a query
  |             about Policy D3 also nudges up chunks about Policy D2,
  |             if the corpus keeps mentioning them together)
  |         +-- current-status boost (nudges current material over
  |             historic/superseded/draft versions of the same policy)
  |
  +-- Reciprocal Rank Fusion
  |
  +-- local cross-encoder rerank (top ~8)
  |
  +-- Corrective-RAG-style confidence check (assess_coverage() in
  |   retrieve.py) - if low-confidence, automatically retries once with
  |   a wider net before giving up
  |
  +-- Groq (cloud) generates the cited answer, told explicitly when
  |   confidence is low/medium
  |
  +-- Self-RAG-style verification/repair pass (only for low/medium
      confidence - skipped on the normal high-confidence path to keep
      that path a single Groq call)
```

**Agentic/Multi-Agent RAG (`orchestrate.py`)** sits in front of all of
the above. Most queries only ever touch one subject area, so
`orchestrate()` classifies the query (a free, local keyword match
against `DOMAIN_KEYWORDS` in `common.py` - no LLM call) and, if it names
just one domain (or none), runs the exact pipeline above completely
unchanged - no orchestration overhead. Only when a query's wording
genuinely spans more than one domain (e.g. "would converting this listed
building's basement need fire safety upgrades and affordable housing
contributions" touches heritage + building_regulations + planning) does
it fan out into that many domain-scoped "agents" - each just the same
`retrieve()` call above, filtered to its own domain's chunks - and fuse
their evidence (dedup, sorted by rerank score, confidence = the worst of
the agents that fired) before the single downstream Groq call writes the
answer. There is still only ever one LLM call per query, no matter how
many agents ran - retrieval is local and free, so running it more than
once costs nothing, but a second/third Groq call would (rate limit and
cost), so the orchestrator never adds one. `query_cli.py` prints an
"Agents" section whenever more than one fired; `service.py` returns them
under `coverage["agents"]`. One failed agent (an exception in its
retrieve() call) is recorded and skipped rather than failing the whole
request.

Local: embeddings, vector storage, sparse search, the cross-reference
graph, reranking, the confidence check. Cloud: the answer-writing call
(and, only when confidence is low/medium, one extra verification call),
via the same `GROQ_API_KEY` the Next.js app already uses - matches the
README's "hybrid local/cloud" recommendation (section 6.2) rather than
the fully-local-only option, since that would additionally need a local
LLM runtime (Ollama wasn't found reachable from the bridge session that
built this - if you do have it running and want the answer step local
too, `answer.py` is the one place to change).

**Graph RAG (`graph_build.py`)** builds a cross-reference graph from the
same chunks ingest.py already extracted - no new PDF parsing, no LLM
calls, no new paid service. It captures which documents mention which
exact references (Policy D3, Paragraph 135, ...) and which references
tend to appear in the same chunk as each other. At query time, if you
name a reference, related references from the graph get a small
secondary boost on top of the existing dense+sparse search - this is
purely additive, dense (semantic) and sparse search always run
unchanged. Rebuilt automatically every time you re-run `ingest.py`; if
`data/reference_graph.pkl` doesn't exist yet (older `data/` folders),
retrieval just skips this signal rather than erroring.

`retrieve(query)` returns `(chunks, coverage)` instead of just a chunk
list - `coverage` has `confidence` (`"high"`/`"medium"`/`"low"`),
`top_rerank_score`, `source_count`, `reasons`, `related_references`
(from the graph), and `broadened_from_top_k` (set when the confidence
check triggered a retry). `query_cli.py` prints this after every
answer; `service.py` returns it under `"coverage"` in the JSON response.

## Known limitations / good next increments

- **Chunking is page + paragraph based**, not the structure-aware
  chapter/section/clause chunker the README describes as the target
  (section 39). Works reasonably for prose; a table-heavy page (CIL
  rates, biodiversity metrics) will chunk awkwardly.
- **No OCR.** A handful of older/scanned PDFs may extract little or no
  text - `data/ingest.log` will show a 0-chunk warning for any file like
  that.
- **Document-version/temporal preference is a soft boost, not a real
  policy** (section 20) - `status: current` chunks get a small score
  nudge over historic/superseded/draft ones (see "How retrieval works"
  above), but there's no hard filtering, no `effective_from`/
  `effective_until` date logic, and no way to deliberately ask for the
  historic version of something.
- **Confidence thresholds are untuned** - `CONFIDENCE_TOP_SCORE_HIGH`/
  `_LOW` in `common.py` are reasonable starting guesses for the
  ms-marco-MiniLM-L-6-v2 cross-encoder's raw score range, not calibrated
  against real queries against the full 185-file corpus yet. Revisit
  once there's a decent sample of real query/answer pairs to look at.
- **Authority-hierarchy weighting** (national > London > Westminster,
  section 42) isn't implemented - retrieval currently treats all
  geographies equally within a query.
- **Graph RAG is a first cut, not real entity/relation extraction** -
  `graph_build.py` only catches the same regex-matchable references
  retrieve.py already looked for (Policy D3, Paragraph 135, Approved
  Document B, Section N, Regulation N), and "related" only means "kept
  appearing in the same chunk" - it doesn't understand *why* two
  references are related, or catch a reference written out in prose
  ("the London Plan", "this SPD") instead of an exact pattern. Real
  entity/relation extraction (spaCy or an LLM pass) is the noted next
  upgrade in `graph_build.py`'s module docstring.
- **Agentic/Multi-Agent orchestration's query classifier is regex
  keyword-matching, not an LLM call** (`DOMAIN_KEYWORDS` in `common.py`)
  - deliberate, to keep decomposition free/local, but it means a query
  about a domain using none of its listed phrasing won't route to that
  domain's specialist agent. Same style of limitation as Graph RAG's
  regex-based reference extraction - a real classifier (a small local
  model, or an LLM pass) is the noted upgrade path if this proves too
  narrow in practice.
- **Orchestration has been verified end-to-end on the real corpus**
  - built and unit-tested (mocked retrieval), then run for real on a
  genuinely cross-domain query. The first real run caught an actual bug:
  domain-scoped agents were searching with the same narrow unscoped
  `top_k` before filtering, so a domain that wasn't the dominant theme
  of the query text could get 0 results even when relevant chunks
  existed. Fixed by widening the dense/sparse candidate pool
  (`top_k * 8`) before filtering when a `domain_filter` is set. A
  second real run after the fix confirmed all three agents returning
  real evidence (planning, heritage, and building_regulations all
  non-zero), with the synthesized answer visibly improved by citing
  sources across all three domains.
