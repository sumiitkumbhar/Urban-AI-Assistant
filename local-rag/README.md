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

It ingests the whole corpus except confirmed exact-duplicate copies (10
byte-identical PDFs the Phase 1 triage flagged) - see `corpus_manifest.json`
and `Urban_AI_Corpus_Triage.xlsx` in the Corpus folder for the full
per-file triage. That's a deliberate widening from the original
ACTIVE_CORE/ACTIVE_SUPPORTING-only default (76 of 202 files): it now
also pulls in REFERENCE_ONLY material - historic/superseded policy
versions, consultation drafts, conservation-area audits for areas with
no chosen demo site yet - so it's worth knowing that a query can now
surface an outdated version of a policy alongside the current one with
no automatic preference between them (each chunk does carry the
manifest's `status` field for a future filtering pass to use - retrieval
doesn't do that yet). The non-PDF biodiversity-metric calculator
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
  +-- dense search (Qdrant, local BGE embeddings)
  +-- sparse search (BM25 over the same chunks)
  |        \
  |         +-- exact-reference boost (regex for "Policy D3",
  |             "Paragraph 135", "Approved Document B", etc.)
  |
  +-- Reciprocal Rank Fusion
  |
  +-- local cross-encoder rerank (top ~8)
  |
  +-- Groq (cloud) generates the cited answer
```

Local: embeddings, vector storage, sparse search, reranking. Cloud: only
the final answer-writing call, via the same `GROQ_API_KEY` the Next.js
app already uses - matches the README's "hybrid local/cloud" recommendation
(section 6.2) rather than the fully-local-only option, since that would
additionally need a local LLM runtime (Ollama wasn't found reachable from
the bridge session that built this - if you do have it running and want
the answer step local too, `answer.py` is the one place to change).

## Known limitations / good next increments

- **Chunking is page + paragraph based**, not the structure-aware
  chapter/section/clause chunker the README describes as the target
  (section 39). Works reasonably for prose; a table-heavy page (CIL
  rates, biodiversity metrics) will chunk awkwardly.
- **No OCR.** A handful of older/scanned PDFs may extract little or no
  text - `data/ingest.log` will show a 0-chunk warning for any file like
  that.
- **No document-version/temporal metadata yet** (section 20) beyond the
  triage's `status` field - if a superseded and a current version of the
  same document both end up ACTIVE_CORE, both get retrieved with no
  automatic preference for the current one.
- **Authority-hierarchy weighting** (national > London > Westminster,
  section 42) isn't implemented - retrieval currently treats all
  geographies equally within a query.
