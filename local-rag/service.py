"""Local RAG as an HTTP service, mirroring voice-service/app.py's own
pattern (FastAPI, file logging, a lifespan hook that loads the heavy
models once at startup rather than per-request) so this folder fits the
same operational shape as the rest of the app.

Run it:
    source venv/bin/activate
    uvicorn service:app --host 0.0.0.0 --port 8010

Then:
    curl -s -X POST http://localhost:8010/query \
      -H "Content-Type: application/json" \
      -d '{"question": "what does policy d3 say about design"}'

Port 8010 is deliberately different from voice-service's 8008 and the
Next.js app's 3000, so all three can run side by side.
"""

import json
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from common import DATA_DIR, CHUNKS_PATH, QDRANT_PATH, BM25_PATH
from answer import generate_answer, stream_answer
from orchestrate import orchestrate
from site_context import build_site_context
from retrieve import _load_embedder, _load_reranker, _load_qdrant, _load_bm25, _load_chunk_texts

LOG_FILE = DATA_DIR / "service.log"
DATA_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(LOG_FILE)],
)
logger = logging.getLogger("local-rag")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not CHUNKS_PATH.exists() or not QDRANT_PATH.exists() or not BM25_PATH.exists():
        logger.error(
            "No index found under data/ - run `python3 ingest.py` first. "
            "The service will start but every query will fail until you do."
        )
    else:
        logger.info("Loading embedding model, reranker, Qdrant and BM25 index...")
        t0 = time.time()
        _load_embedder()
        _load_reranker()
        _load_qdrant()
        _load_bm25()
        _load_chunk_texts()
        logger.info(f"Ready in {time.time() - t0:.1f}s.")
    yield


app = FastAPI(title="Urban AI - Local RAG", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    question: str
    top_k: int = 25
    rerank_top_n: int = 8
    # Council/geography scoping (added 2026-09-15) - mirrors the live
    # app's Supabase filter_lpa_slug semantics: None means unscoped
    # (search everything), a value like "westminster" restricts local
    # material to that geography while national documents (e.g. the
    # NPPF) remain in scope regardless. See retrieve.py's docstring.
    geography: str | None = None


@app.get("/health")
def health():
    ready = CHUNKS_PATH.exists() and QDRANT_PATH.exists() and BM25_PATH.exists()
    return {"status": "ok" if ready else "not_ingested"}


@app.post("/query")
def query(req: QueryRequest):
    t0 = time.time()
    chunks, coverage = orchestrate(
        req.question, top_k=req.top_k, rerank_top_n=req.rerank_top_n,
        geography_filter=req.geography,
    )
    t1 = time.time()
    result = generate_answer(req.question, chunks, coverage=coverage)
    t2 = time.time()

    logger.info(
        f"query={req.question!r} chunks={len(chunks)} confidence={coverage['confidence']} "
        f"retrieval_ms={(t1-t0)*1000:.0f} generation_ms={(t2-t1)*1000:.0f}"
    )
    return {
        **result,
        "coverage": coverage,
        "retrieval_ms": round((t1 - t0) * 1000, 1),
        "generation_ms": round((t2 - t1) * 1000, 1),
    }


@app.post("/query/stream")
def query_stream(req: QueryRequest):
    """Server-Sent Events counterpart to /query (architecture-plan Phase
    5's "streaming" item) - retrieval (orchestrate()) still runs to
    completion first, same as /query, since there's nothing to stream
    from a local Qdrant/BM25 lookup that typically finishes in a couple
    of seconds; only the Groq generation call - the actual latency a
    user waits through - streams token-by-token via answer.py's
    stream_answer(). Three named SSE event types, in order:

      event: coverage  - the retrieval coverage dict, sent immediately
                          (before any answer text) so a client can show
                          the confidence/agents badge right away.
      event: delta      - {"text": "..."} for each token/fragment as it
                          arrives from Groq.
      event: done        - exactly once, the final result (answer,
                          citations, confidence, verified, groundedness,
                          unsupported_claims, coverage, timings) - see
                          stream_answer()'s docstring for why this final
                          answer can differ slightly from the
                          concatenation of every delta.
    """
    t0 = time.time()
    chunks, coverage = orchestrate(
        req.question, top_k=req.top_k, rerank_top_n=req.rerank_top_n,
        geography_filter=req.geography,
    )
    t1 = time.time()

    def event_stream():
        yield f"event: coverage\ndata: {json.dumps(coverage)}\n\n"
        for kind, payload in stream_answer(req.question, chunks, coverage=coverage):
            if kind == "delta":
                yield f"event: delta\ndata: {json.dumps({'text': payload})}\n\n"
            else:  # "done"
                t2 = time.time()
                result = {
                    **payload,
                    "coverage": coverage,
                    "retrieval_ms": round((t1 - t0) * 1000, 1),
                    "generation_ms": round((t2 - t1) * 1000, 1),
                }
                logger.info(
                    f"query(stream)={req.question!r} chunks={len(chunks)} "
                    f"confidence={coverage['confidence']} "
                    f"retrieval_ms={(t1-t0)*1000:.0f} generation_ms={(t2-t1)*1000:.0f}"
                )
                yield f"event: done\ndata: {json.dumps(result)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


class SiteAnswerRequest(BaseModel):
    # Site constraints/context/policy engine (architecture-plan section
    # 27's final step) - given a site, ask GIS/PostGIS
    # (local-rag/gis/gis_lookup.py, a separate database from this
    # service's own Qdrant index) what constraints actually apply, turn
    # the real matches into a policy question, and let this service's
    # own orchestrate()/generate_answer() answer it exactly like any
    # other query - see site_context.py's module docstring.
    postcode: str | None = None
    lat: float | None = None
    lon: float | None = None
    question: str | None = None
    top_k: int = 25
    rerank_top_n: int = 8


@app.post("/site-answer")
def site_answer(req: SiteAnswerRequest):
    t0 = time.time()
    ctx = build_site_context(
        postcode=req.postcode, lat=req.lat, lon=req.lon, extra_question=req.question,
        top_k=req.top_k, rerank_top_n=req.rerank_top_n,
    )
    if "error" in ctx:
        return ctx
    t1 = time.time()
    result = generate_answer(ctx["policy_question"], ctx["chunks"], coverage=ctx["coverage"])
    t2 = time.time()

    logger.info(
        f"site-answer postcode={req.postcode!r} lat={req.lat} lon={req.lon} "
        f"geography={ctx['geography']} question={ctx['policy_question']!r} "
        f"confidence={ctx['coverage']['confidence']} "
        f"retrieval_ms={(t1-t0)*1000:.0f} generation_ms={(t2-t1)*1000:.0f}"
    )
    return {
        **result,
        "site_constraints": ctx["site_constraints"],
        "geography": ctx["geography"],
        "policy_question": ctx["policy_question"],
        "map_citations": ctx["map_citations"],
        "coverage": ctx["coverage"],
        "retrieval_ms": round((t1 - t0) * 1000, 1),
        "generation_ms": round((t2 - t1) * 1000, 1),
    }
