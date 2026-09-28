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
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import requests as _requests

from common import DATA_DIR, CHUNKS_PATH, QDRANT_PATH, BM25_PATH, OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL
from answer import generate_answer, stream_answer
from orchestrate import orchestrate
from site_context import build_site_context, _describe_constraints, _find_map_citations
from site_lookup import find_postcode_in_text
from map_images import MAP_IMAGES_DIR
import project_state as project_state_module
import memory as memory_module
from retrieve import _load_embedder, _load_reranker, _load_qdrant, _load_bm25, _load_chunk_texts, get_citation_context
import hallucination_check

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

# Serves the map images map_images.render_map_image() renders on demand
# (see site_context.py's _find_map_citations()) - mounted before any
# request can reach it, and the directory is created up front since
# StaticFiles refuses to mount over a path that doesn't exist yet even
# though nothing needs to be in it until the first map citation renders.
MAP_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/map-images", StaticFiles(directory=str(MAP_IMAGES_DIR)), name="map_images")

# Serves the Markdown/PDF reports /proposal-review writes to reports/ (see
# that endpoint below) - same mount-a-static-dir pattern as /map-images
# just above, added 2026-09-19 so a browser can actually preview/download
# the generated PDF instead of it only existing as a path on this machine's
# disk. Created up front for the same StaticFiles-refuses-a-missing-dir
# reason as MAP_IMAGES_DIR.
REPORTS_DIR = Path(__file__).parent / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/reports", StaticFiles(directory=str(REPORTS_DIR)), name="reports")

# Serves the persisted original documents document_edit.save_document()
# writes under documents/<doc_id>/ (original.pdf) - added 2026-09-23 for
# live in-place clause editing, see document_edit.py's own module
# docstring. Same mount-a-static-dir pattern as /reports and
# /map-images above. Mounted at /document-files, NOT /documents -
# the GET /documents/{doc_id} and POST /documents/{doc_id}/edit-clause
# API routes below also live under /documents/*, and Starlette
# resolves routes in registration order: a Mount("/documents", ...)
# registered here (near the top of the file) would silently claim
# every /documents/* request - including those two API routes,
# appended much further down - before they ever got a chance to run,
# 404ing from inside the static app instead. A different mount path
# avoids the collision entirely rather than relying on route order.
from document_edit import DOCUMENTS_DIR

DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/document-files", StaticFiles(directory=str(DOCUMENTS_DIR)), name="document_files")


class GroundednessCheckRequest(BaseModel):
    # See hallucination_check.py's module docstring for what this
    # endpoint is for: an independent, non-LLM-as-judge cross-check
    # that both this service's own answer.py and Cloud mode's
    # app/api/rag-chat/route.ts call - premise is the retrieved
    # source excerpts, hypothesis is the generated answer text.
    premise: str
    hypothesis: str


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
    # Structured project state (architecture-plan section 22/23/28,
    # Phase 7's first slice) - when set, this query is answered "in the
    # context of" that project: project_state.build_context_summary()
    # is injected as extra context alongside the retrieved evidence
    # (see answer.py's _build_user_content()), and - only when the
    # caller didn't already pass an explicit `geography` above - the
    # project's own stored geography is used to scope retrieval, so a
    # project-scoped query doesn't need the caller to repeat the
    # authority on every request.
    project_id: int | None = None
    # Fully-local generation (added 2026-09-24, opt-in - see answer.py's
    # generate_answer()/stream_answer() `backend` parameter and
    # common.py's OLLAMA_BASE_URL/DEFAULT_OLLAMA_MODEL). "groq" (default,
    # unchanged) answers via Groq's cloud API, same as every request
    # before this field existed. "ollama" answers via a local Ollama
    # instance instead, so nothing about this one query - not just
    # retrieval - leaves the machine. Retrieval itself is unaffected
    # either way; this only changes which model drafts the answer text.
    backend: str = "groq"


def _resolve_project_context(project_id, geography):
    """Shared by /query and /query/stream: looks up the project (404 if
    it doesn't exist), builds its context summary, and defaults
    `geography` from the project's own stored geography when the caller
    didn't already pass one explicitly. Also resolves map citations from
    the project's own already-matched constraints (site_context.py's
    _describe_constraints()/_find_map_citations() - the exact same shape
    as gis_lookup.site_constraints(), since project_state.py's
    constraints_json is just that result persisted), so a project-scoped
    query gets the same visual citation /site-answer already produces,
    without a second live GIS lookup. Returns (project_context,
    geography, map_citations)."""
    if project_id is None:
        return None, geography, []
    project = project_state_module.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}.")
    project_context = project_state_module.build_context_summary(project_id)
    if geography is None:
        geography = project["geography"]
    map_citations = []
    if project.get("constraints"):
        _, area_names = _describe_constraints(project["constraints"])
        map_citations = _find_map_citations(area_names, project["geography"])
    return project_context, geography, map_citations


# A plain chat question is routed through the GIS site-constraints path
# (see _resolve_retrieval() below) only when it both names a real,
# geocodable UK postcode AND reads like it's actually asking about site
# constraints - not just any planning question that happens to mention a
# postcode ("what's the housing target for SW1V 3LX" should stay a plain
# geography-scoped question, not silently get re-scoped into a
# constraint-check question the user didn't ask). Deliberately
# conservative in a second way too: free-text addresses/place names
# ("is 10 Downing Street in a conservation area") are NOT resolved here,
# only exact postcodes - reliably pulling an address out of an arbitrary
# sentence needs real NER, not a regex, and a wrong guess here would
# silently mis-scope what would otherwise be a normal chat answer.
# site_lookup.resolve_address() (used by /site-answer and project
# creation, where the caller supplies the address on its own rather than
# embedded in a longer question) remains the place for that.
_SITE_CONSTRAINT_KEYWORDS_RE = re.compile(
    r"\b("
    r"conservation area|listed build|article\s*4|green belt|"
    r"flood (risk|zone)|sssi|site of special scientific interest|"
    r"aonb|area of outstanding natural beauty|ancient woodland|"
    r"tree preservation|\btpo\b|"
    r"site constraint|planning constraint|what constraints|which constraints"
    r")",
    re.IGNORECASE,
)


def _detect_site_postcode(question):
    if not _SITE_CONSTRAINT_KEYWORDS_RE.search(question or ""):
        return None
    return find_postcode_in_text(question)


def _resolve_retrieval(req):
    """Shared by /query and /query/stream: decides what actually gets
    retrieved and what question gets asked of the LLM. Three paths, in
    order:

      1. project_id set - orchestrate() scoped to the project's stored
         geography (existing behavior, unchanged from before today).
      2. No project_id, but the question looks like a site-constraint
         check (see _detect_site_postcode() above) - routed through
         site_context.build_site_context(), the same "context/policy
         engine" /site-answer already uses, so "what constraints apply
         to SW1V 3LX" gets a real GIS lookup folded into the question
         instead of just hoping the text corpus happens to mention that
         postcode. Falls back to plain orchestrate() on ANY problem from
         the GIS path (bad postcode match, GIS Postgres unreachable,
         etc., caught broadly and logged) - this must never break what
         would otherwise be a normal chat query.
      3. Neither - plain orchestrate(), unchanged from before today.

    Returns (chunks, coverage, question_for_llm, project_context,
    site_constraints_result, map_citations). question_for_llm is
    req.question unless path 2 actually produced a constraint-augmented
    question; site_constraints_result is the resolved site_constraints()
    result for path 2, or None otherwise - attached to the response so a
    future UI can show it without changing what the LLM is asked."""
    project_context, geography, map_citations = _resolve_project_context(
        req.project_id, req.geography
    )

    if req.project_id is None:
        postcode = _detect_site_postcode(req.question)
        if postcode:
            try:
                ctx = build_site_context(
                    postcode=postcode, extra_question=req.question,
                    top_k=req.top_k, rerank_top_n=req.rerank_top_n,
                )
            except Exception:
                logger.exception(
                    f"Site-context lookup failed for postcode {postcode!r} "
                    f"detected in a chat question - falling back to plain retrieval"
                )
                ctx = {"error": "lookup failed"}
            if "error" not in ctx:
                return (
                    ctx["chunks"], ctx["coverage"], ctx["policy_question"],
                    project_context, ctx["site_constraints"], ctx["map_citations"],
                )

    chunks, coverage = orchestrate(
        req.question, top_k=req.top_k, rerank_top_n=req.rerank_top_n,
        geography_filter=geography,
    )
    return chunks, coverage, req.question, project_context, None, map_citations


def _auto_log_query_event(project_id, question, answer_text):
    """Auto-logs a "query" episodic-memory event whenever a project-
    scoped /query or /query/stream call finishes - this is what makes a
    project's episodic history (memory.py) fill in from normal chat use
    rather than requiring a separate manual step. Deliberately
    best-effort: any failure (memory tables not yet applied, DB down) is
    logged and swallowed, never turned into a 500 for what was otherwise
    a successful answer - the same "never let a side-effect break the
    real response" instinct as the groundedness/conflict-detection
    LLM-judge calls elsewhere in this project."""
    if project_id is None:
        return
    try:
        memory_module.log_event(
            project_id, "query", question[:200],
            detail=f"A: {(answer_text or '')[:500]}", source="auto",
        )
    except Exception:
        logger.exception(f"Failed to auto-log query event for project {project_id}")


@app.get("/health")
def health():
    ready = CHUNKS_PATH.exists() and QDRANT_PATH.exists() and BM25_PATH.exists()
    return {"status": "ok" if ready else "not_ingested"}


@app.get("/ollama/status")
def ollama_status():
    """Lets the frontend check, before offering the fully-local backend
    toggle, whether Ollama is actually reachable right now and which
    models it has pulled - rather than only finding out at answer time
    via generate_answer()'s own error message (see answer.py's
    _backend_error_message()). Hits Ollama's own /api/tags (lists
    locally-installed models, no side effects) with a short timeout,
    since this is meant to be a quick UI check, not a query. Best-effort
    like every other optional-dependency check in this service: any
    failure here just means "not available", never a 500 - Ollama simply
    not being installed/running is an entirely normal state for most
    users, not an error."""
    try:
        resp = _requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=2)
        resp.raise_for_status()
        models = [m.get("name") for m in resp.json().get("models", []) if m.get("name")]
        return {
            "available": True,
            "models": models,
            "default_model": DEFAULT_OLLAMA_MODEL,
            "default_model_pulled": DEFAULT_OLLAMA_MODEL in models,
        }
    except Exception:
        return {"available": False, "models": [], "default_model": DEFAULT_OLLAMA_MODEL, "default_model_pulled": False}


@app.get("/citation-context/{chunk_id}")
def citation_context(chunk_id: str, window: int = 1):
    """Neighboring-chunk context for one citation, used by the chat UI's
    "show more context" control to pull in additional surrounding
    paragraphs beyond the sentence-complete text every citation already
    carries by default (see answer.py's build_context(), which calls
    retrieve.py's get_complete_citation_text() for every citation up
    front - this endpoint is for "more than one sentence", not for
    fixing a mid-sentence cut, since that's no longer something a user
    has to click to fix). window is clamped to a small range - this is
    meant to recover a paragraph or two, not fetch half the document
    into a citation card. See retrieve.py's get_citation_context()
    docstring for how chunks are stitched and boundary-trimmed."""
    window = max(1, min(window, 3))
    ctx = get_citation_context(chunk_id, window=window)
    if ctx is None:
        raise HTTPException(status_code=404, detail=f"No chunk with id {chunk_id}.")
    return ctx


@app.post("/groundedness/check")
def groundedness_check(req: GroundednessCheckRequest):
    """HTTP entry point for hallucination_check.py's independent
    groundedness cross-check, so Cloud mode (app/api/rag-chat/route.ts,
    a completely separate Node/TS pipeline) can call the same HHEM model
    this service already loads for local mode, over the network, rather
    than needing a JS/ONNX port of it - see hallucination_check.py's
    docstring for why. Cloud mode calls this only when LOCAL_RAG_HHEM_URL
    is set (see .env.example) and treats any failure - including this
    service simply not running - as "no cross-check available", the same
    fail-open contract this module already has internally."""
    score = hallucination_check.score_groundedness(req.premise, req.hypothesis)
    return {"score": score}


@app.post("/query")
def query(req: QueryRequest):
    t0 = time.time()
    (
        chunks, coverage, question_for_llm, project_context,
        site_constraints_result, map_citations,
    ) = _resolve_retrieval(req)
    t1 = time.time()
    result = generate_answer(
        question_for_llm, chunks, coverage=coverage, project_context=project_context,
        backend=req.backend,
    )
    t2 = time.time()

    _auto_log_query_event(req.project_id, req.question, result.get("answer"))

    logger.info(
        f"query={req.question!r} chunks={len(chunks)} confidence={coverage['confidence']} "
        f"backend={req.backend} retrieval_ms={(t1-t0)*1000:.0f} generation_ms={(t2-t1)*1000:.0f}"
        + (f" site_constraint_postcode_detected=True" if site_constraints_result else "")
    )
    return {
        **result,
        "coverage": coverage,
        "map_citations": map_citations,
        "site_constraints": site_constraints_result,
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
    stream_answer(). Four named SSE event types, in order:

      event: coverage  - the retrieval coverage dict, sent immediately
                          (before any answer text) so a client can show
                          the confidence/agents badge right away.
      event: delta      - {"text": "..."} for each token/fragment as it
                          arrives from Groq.
      event: done        - exactly once, the final result (answer,
                          citations, map_citations, confidence, verified,
                          groundedness, unsupported_claims, coverage,
                          timings) - see stream_answer()'s docstring for
                          why this final answer can differ slightly from
                          the concatenation of every delta.
    """
    t0 = time.time()
    (
        chunks, coverage, question_for_llm, project_context,
        site_constraints_result, map_citations,
    ) = _resolve_retrieval(req)
    t1 = time.time()

    def event_stream():
        yield f"event: coverage\ndata: {json.dumps(coverage)}\n\n"
        try:
            for kind, payload in stream_answer(
                question_for_llm, chunks, coverage=coverage, project_context=project_context,
                backend=req.backend,
            ):
                if kind == "delta":
                    yield f"event: delta\ndata: {json.dumps({'text': payload})}\n\n"
                else:  # "done"
                    t2 = time.time()
                    result = {
                        **payload,
                        "coverage": coverage,
                        "map_citations": map_citations,
                        "site_constraints": site_constraints_result,
                        "retrieval_ms": round((t1 - t0) * 1000, 1),
                        "generation_ms": round((t2 - t1) * 1000, 1),
                    }
                    _auto_log_query_event(req.project_id, req.question, payload.get("answer"))
                    logger.info(
                        f"query(stream)={req.question!r} chunks={len(chunks)} "
                        f"confidence={coverage['confidence']} backend={req.backend} "
                        f"retrieval_ms={(t1-t0)*1000:.0f} generation_ms={(t2-t1)*1000:.0f}"
                    )
                    yield f"event: done\ndata: {json.dumps(result)}\n\n"
        except Exception as e:
            # Belt-and-suspenders on top of stream_answer()'s own
            # APIStatusError handling (found the hard way 2026-09-22,
            # see answer.py's stream_answer() docstring/comments) - ANY
            # uncaught exception reaching this generator used to abort
            # the HTTP response mid-stream with no "done" event at all,
            # which the Next.js proxy surfaced as an opaque "Error: Load
            # failed" no matter what actually went wrong. Whatever this
            # catches now, the client still gets exactly one well-formed
            # "done" event instead of a dead connection.
            logger.error(f"query(stream) failed unexpectedly: {e}")
            yield f"event: done\ndata: {json.dumps({'answer': f'Something went wrong generating this answer ({e}). Please try again.', 'citations': [], 'confidence': None, 'verified': False, 'groundedness': None, 'unsupported_claims': []})}\n\n"

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
    # Free-text address/place name fallback (added 2026-09-21) - tried
    # only when postcode and lat/lon are both absent, via
    # site_lookup.resolve_address(). Less certain than an exact
    # postcode, so the response's geocode_detail names which stage
    # actually resolved it.
    address: str | None = None
    question: str | None = None
    top_k: int = 25
    rerank_top_n: int = 8
    # Same opt-in fully-local generation switch as QueryRequest.backend
    # above - a postcode-triggered query (see the Next.js proxy's
    # extractPostcode()) routes through this endpoint instead of /query,
    # so it needs the same field or the toggle would silently stop
    # applying the moment a question happens to mention a postcode.
    backend: str = "groq"


@app.post("/site-answer")
def site_answer(req: SiteAnswerRequest):
    t0 = time.time()
    ctx = build_site_context(
        postcode=req.postcode, lat=req.lat, lon=req.lon, address=req.address,
        extra_question=req.question, top_k=req.top_k, rerank_top_n=req.rerank_top_n,
    )
    if "error" in ctx:
        return ctx
    t1 = time.time()
    result = generate_answer(
        ctx["policy_question"], ctx["chunks"], coverage=ctx["coverage"], backend=req.backend,
    )
    t2 = time.time()

    logger.info(
        f"site-answer postcode={req.postcode!r} lat={req.lat} lon={req.lon} "
        f"address={req.address!r} geography={ctx['geography']} "
        f"question={ctx['policy_question']!r} "
        f"confidence={ctx['coverage']['confidence']} backend={req.backend} "
        f"retrieval_ms={(t1-t0)*1000:.0f} generation_ms={(t2-t1)*1000:.0f}"
    )
    return {
        **result,
        "site_constraints": ctx["site_constraints"],
        "geography": ctx["geography"],
        "policy_question": ctx["policy_question"],
        "map_citations": ctx["map_citations"],
        "coverage": ctx["coverage"],
        "geocode_detail": ctx["geocode_detail"],
        "retrieval_ms": round((t1 - t0) * 1000, 1),
        "generation_ms": round((t2 - t1) * 1000, 1),
    }


# --- Structured project state (architecture-plan section 22/23/28,
# Phase 7's first slice) - thin HTTP wrapping around project_state.py's
# CRUD functions, which do all the real work (including turning "no such
# project" into None); this layer's only job is None -> 404.


class ProjectCreateRequest(BaseModel):
    name: str
    postcode: str | None = None
    lat: float | None = None
    lon: float | None = None
    # Free-text address/place name fallback (added 2026-09-21), tried
    # only when postcode and lat/lon are both absent - see
    # project_state.create_project()'s docstring.
    address: str | None = None


class ProjectUpdateRequest(BaseModel):
    # All optional - only fields actually set are passed through to
    # project_state.update_project(), which itself restricts writes to
    # UPDATABLE_FIELDS (site identity is not editable via this endpoint).
    name: str | None = None
    proposed_use: str | None = None
    units: int | None = None
    storeys: int | None = None
    floorspace_sqm: float | None = None
    height_m: float | None = None
    stage: str | None = None


class QuestionCreateRequest(BaseModel):
    question: str


@app.post("/projects")
def create_project(req: ProjectCreateRequest):
    try:
        return project_state_module.create_project(
            req.name, postcode=req.postcode, lat=req.lat, lon=req.lon,
            address=req.address,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/projects")
def list_projects():
    return project_state_module.list_projects()


@app.get("/projects/{project_id}")
def get_project(project_id: int):
    project = project_state_module.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}.")
    return project


@app.patch("/projects/{project_id}")
def update_project(project_id: int, req: ProjectUpdateRequest):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    project = project_state_module.update_project(project_id, **fields)
    if project is None:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}.")
    return project


@app.post("/projects/{project_id}/refresh-constraints")
def refresh_constraints(project_id: int):
    project = project_state_module.refresh_constraints(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}.")
    return project


@app.post("/projects/{project_id}/questions")
def add_question(project_id: int, req: QuestionCreateRequest):
    question = project_state_module.add_open_question(project_id, req.question)
    if question is None:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}.")
    return question


@app.patch("/projects/{project_id}/questions/{question_id}")
def resolve_question(project_id: int, question_id: int):
    # project_id is part of the URL for a consistent REST shape but
    # isn't otherwise needed - project_state.resolve_open_question()
    # looks the question up by its own id, which is already unique.
    question = project_state_module.resolve_open_question(question_id)
    if question is None:
        raise HTTPException(status_code=404, detail=f"No question with id {question_id}.")
    return question


# --- Episodic/semantic memory + conflict detection (memory.py,
# architecture-plan section 23's remaining Phase 7 tiers, 2026-09-18) -
# same thin-HTTP-wrapper pattern as the /projects endpoints above: all
# the real logic lives in memory.py, this layer only turns None/ValueError
# into 404/400.


class EventCreateRequest(BaseModel):
    event_type: str
    summary: str
    detail: str | None = None


class ConflictUpdateRequest(BaseModel):
    status: str


@app.post("/projects/{project_id}/events")
def create_event(project_id: int, req: EventCreateRequest):
    try:
        event = memory_module.log_event(
            project_id, req.event_type, req.summary, detail=req.detail, source="manual"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if event is None:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}.")
    return event


@app.get("/projects/{project_id}/events")
def list_events(project_id: int):
    return memory_module.list_events(project_id)


@app.get("/projects/{project_id}/conflicts")
def list_project_conflicts(project_id: int):
    return memory_module.list_conflicts(project_id=project_id)


@app.patch("/conflicts/{conflict_id}")
def update_conflict(conflict_id: int, req: ConflictUpdateRequest):
    try:
        conflict = memory_module.resolve_conflict(conflict_id, req.status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if conflict is None:
        raise HTTPException(status_code=404, detail=f"No conflict with id {conflict_id}.")
    return conflict


@app.get("/lpa-knowledge/{geography}")
def get_lpa_knowledge(geography: str):
    return memory_module.get_lpa_knowledge(geography)


@app.post("/lpa-knowledge/{geography}/distill")
def distill_lpa_knowledge(geography: str):
    return memory_module.distill_lpa_knowledge(geography)


# --- Proposal compliance review (2026-09-18) - accepts one or more
# uploaded proposal documents (a Design & Access Statement/planning
# statement, typically) plus a site (project_id, or postcode, or
# lat/lon - the same three ways every other site-aware endpoint here
# accepts a site) and assesses the proposal against the corpus + the
# site's real GIS constraints. Multipart/form-data, not JSON, since this
# endpoint takes file uploads - see proposal_review.py's module
# docstring for the full pipeline; this is a thin HTTP wrapper, same
# pattern as every other endpoint in this file.


@app.post("/proposal-review")
async def proposal_review_endpoint(
    files: list[UploadFile] = File(...),
    project_id: int | None = Form(None),
    postcode: str | None = Form(None),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
    # 2026-09-25: "groq" (default, unchanged) / "ollama" (fully local) -
    # same choice /query, /site-answer, and /documents/{doc_id}/edit-clause
    # already offer, now available for compliance reviews too, so nothing
    # in the app is forced through Groq once "Fully local" is on.
    backend: str = Form("groq"),
):
    """curl example:
      curl -s -X POST http://localhost:8010/proposal-review \
        -F "files=@/path/to/Design and Access Statement.pdf" \
        -F "postcode=SW1V 3LX"

    Also writes a Markdown + PDF report (report_render.py - infographics,
    status chips, a risk badge, an image gallery pulled from the proposal
    itself) to local-rag/reports/ and returns their paths under
    "report_files" - the same advisory write-up proposal_review_cli.py
    saves next to the input PDF, added 2026-09-18 so an HTTP caller gets
    a real downloadable document too, not just JSON.
    """
    import tempfile
    from pathlib import Path as _Path

    from proposal_review import extract_proposal_text, review_proposal
    from report_render import build_reports, report_slug

    t0 = time.time()
    document_texts = []
    pages_not_assessed = {}
    report_files = {}
    # 2026-09-28 diagnostics pass: endpoint-level stage logging, added
    # after a live "502 from the Next.js proxy, 400 from this endpoint,
    # repeatedly" report - the proxy was flattening every non-2xx upstream
    # response into an opaque 502 with no visibility into WHICH stage
    # actually failed or why (see app/api/local-rag-proposal-review/
    # route.ts's matching 2026-09-28 fix). These logs, plus
    # review_proposal()'s own internal stage logs, mean a future "it got
    # stuck/failed" report is diagnosable straight from this service's
    # own terminal output, without needing a live debugging session.
    logger.info(
        f"proposal-review: request accepted - files={[f.filename for f in files]} "
        f"project_id={project_id} postcode={postcode!r} backend={backend}"
    )
    with tempfile.TemporaryDirectory() as tmp:
        saved_paths = []
        for upload in files:
            dest = _Path(tmp) / upload.filename
            dest.write_bytes(await upload.read())
            saved_paths.append(dest)
            logger.info(f"proposal-review: extracting {upload.filename}")
            text, _pages_with_text, pages_without_text, error = extract_proposal_text(dest)
            if error:
                logger.warning(f"proposal-review: extraction FAILED for {upload.filename} - {error}")
                raise HTTPException(status_code=400, detail=f"{upload.filename}: {error}")
            document_texts.append((upload.filename, text))
            if pages_without_text:
                pages_not_assessed[upload.filename] = pages_without_text
            logger.info(
                f"proposal-review: extraction complete for {upload.filename} - "
                f"{len(_pages_with_text)} page(s) with text, {len(pages_without_text)} without"
            )

        result = review_proposal(
            document_texts, project_id=project_id, postcode=postcode, lat=lat, lon=lon,
            backend=backend,
        )
        if result.get("error"):
            logger.warning(f"proposal-review: review FAILED - {result['error']}")
            raise HTTPException(status_code=400, detail=result["error"])

        # Extracting site photos (extract_report_images) and rendering the
        # PDF both need the uploaded files on disk, so this runs while the
        # temp dir is still alive - it's gone the moment the `with` exits.
        document_names = [name for name, _ in document_texts]

        # Persist each uploaded document (original PDF + paragraph-split
        # text) so it survives past this one response and can be edited
        # live via chat afterward - see document_edit.py's own module
        # docstring. Best-effort per file: a persistence failure shouldn't
        # break the review response the user is actually waiting on.
        from document_edit import extract_paragraphs_from_pdf, save_document

        documents = []
        for upload, dest in zip(files, saved_paths):
            try:
                paragraphs = extract_paragraphs_from_pdf(dest)
                doc_id = save_document(
                    upload.filename, dest.read_bytes(), paragraphs,
                    meta={
                        "geography": result.get("geography"),
                        "project_id": project_id,
                        "postcode": postcode,
                    },
                )
                documents.append({
                    "doc_id": doc_id,
                    "filename": upload.filename,
                    # Points at the REGENERATED current.pdf (built from
                    # paragraphs.json by save_document(), see
                    # document_edit.py's 2026-09-23 module docstring
                    # update), not the raw original.pdf - this is now the
                    # one and only document view DocumentPanel shows, so
                    # it needs to be the version that later edits will
                    # also update in place. version=1 matches what
                    # save_document() just wrote to meta.json.
                    "url": f"/document-files/{doc_id}/current.pdf?v=1",
                    "paragraph_count": len(paragraphs),
                    "version": 1,
                })
            except Exception as e:
                logger.warning(f"Could not persist {upload.filename} for live editing: {e}")

        # Persist the review's own editable prose as its own addressable
        # "report document" (2026-09-25, Report-tab correction to the
        # inline-editing milestone: editing happens against the
        # AI-generated report, never the uploaded source - see
        # document_edit.py's "Report-block editing" section for the full
        # design). Additive, alongside the source documents[] persistence
        # just above, never instead of it. Best-effort, same reasoning as
        # that loop: a persistence failure here shouldn't break the
        # review response the user is actually waiting on - it just means
        # this review's Report tab won't be editable this time.
        report_doc_id, report_blocks = None, []
        try:
            from document_edit import save_report_blocks
            source_doc_ids = [d["doc_id"] for d in documents]
            report_doc_id, role_map = save_report_blocks(result, document_names, source_doc_ids)
            if role_map:
                report_blocks = [
                    {"localId": lid, "kind": role["kind"], "index": role["index"]}
                    for lid, role in role_map.items()
                ]
        except Exception as e:
            logger.warning(f"Could not persist report blocks for live editing: {e}")

        logger.info("proposal-review: report rendering starting")
        reports = build_reports(result, document_names, pdf_paths=saved_paths)
        reports_dir = _Path(__file__).parent / "reports"
        reports_dir.mkdir(exist_ok=True)
        slug = report_slug(result)
        md_path = reports_dir / f"{slug}.md"
        md_path.write_text(reports["markdown"], encoding="utf-8")
        report_files["markdown"] = str(md_path)
        report_files["markdown_url"] = f"/reports/{slug}.md"
        report_files["markdown_filename"] = f"{slug}.md"
        if reports["pdf_bytes"] is not None:
            pdf_path = reports_dir / f"{slug}.pdf"
            pdf_path.write_bytes(reports["pdf_bytes"])
            report_files["pdf"] = str(pdf_path)
            report_files["pdf_url"] = f"/reports/{slug}.pdf"
            report_files["pdf_filename"] = f"{slug}.pdf"
        else:
            report_files["pdf_error"] = reports["pdf_error"]
        # Live animated HTML view (2026-09-21, "animated report visuals") -
        # same /reports StaticFiles mount already serving the .md/.pdf,
        # just a third extension. Independent of the PDF above (see
        # build_reports' own docstring) so a WeasyPrint failure still
        # leaves this available, and vice versa.
        if reports.get("live_html") is not None:
            html_path = reports_dir / f"{slug}.html"
            html_path.write_text(reports["live_html"], encoding="utf-8")
            report_files["html"] = str(html_path)
            report_files["html_url"] = f"/reports/{slug}.html"
            report_files["html_filename"] = f"{slug}.html"
        else:
            report_files["html_error"] = reports.get("live_html_error")

    t1 = time.time()
    logger.info(
        f"proposal-review files={[f.filename for f in files]} project_id={project_id} "
        f"postcode={postcode!r} geography={result.get('geography')} backend={backend} "
        f"issues={len(result['assessment'].get('issues', []))} "
        f"total_ms={(t1-t0)*1000:.0f}"
    )
    return {
        **result,
        "pages_not_assessed": pages_not_assessed,
        "report_files": report_files,
        "documents": documents,
        # report_doc_id/report_blocks (2026-09-25): the Report tab's own
        # editable identity, separate from documents[].doc_id above (the
        # source proposal). None/[] when persistence failed - the
        # frontend's Report tab just isn't selectable/editable that time,
        # same "degrade, don't break the review" contract as documents[].
        "report_doc_id": report_doc_id,
        "report_blocks": report_blocks,
        "total_ms": round((t1 - t0) * 1000, 1),
    }


class ProposalReviewChatRequest(BaseModel):
    """Follow-up Q&A after a /proposal-review call - added 2026-09-19,
    per explicit request for "to and fro discussion" once a report is
    generated. `review` is exactly what /proposal-review already handed
    the frontend back (geography, constraint_summary, assessment) plus
    the document names it already knows from the upload itself - no
    server-side review storage, the caller just replays what it has.
    See proposal_review.build_review_context_text()'s own docstring for
    why this is a normal /query call with that folded in as context,
    not a separate retrieval path."""
    question: str
    review: dict
    project_id: int | None = None
    top_k: int = 25
    rerank_top_n: int = 8


@app.post("/proposal-review-chat")
def proposal_review_chat(req: ProposalReviewChatRequest):
    from proposal_review import build_review_context_text

    t0 = time.time()
    project_context, geography, map_citations = _resolve_project_context(
        req.project_id, req.review.get("geography")
    )
    review_text = build_review_context_text(req.review)
    # Both contexts are plain prose blocks meant for the same slot
    # (answer.py's _build_user_content() prepends whichever project_context
    # it's given ahead of the retrieved evidence) - concatenate rather than
    # pick one, so a project-scoped review-chat still gets project_state's
    # own summary too.
    combined_context = (
        f"{project_context}\n\n---\n\n{review_text}" if project_context else review_text
    )
    chunks, coverage = orchestrate(
        req.question, top_k=req.top_k, rerank_top_n=req.rerank_top_n,
        geography_filter=geography,
    )
    t1 = time.time()
    result = generate_answer(
        req.question, chunks, coverage=coverage, project_context=combined_context or None
    )
    t2 = time.time()

    _auto_log_query_event(req.project_id, req.question, result.get("answer"))

    logger.info(
        f"proposal-review-chat question={req.question!r} chunks={len(chunks)} "
        f"confidence={coverage['confidence']} retrieval_ms={(t1-t0)*1000:.0f} "
        f"generation_ms={(t2-t1)*1000:.0f}"
    )
    return {
        **result,
        "coverage": coverage,
        "map_citations": map_citations,
        "retrieval_ms": round((t1 - t0) * 1000, 1),
        "generation_ms": round((t2 - t1) * 1000, 1),
    }


class EditClauseRequest(BaseModel):
    """Body for POST /documents/{doc_id}/edit-clause - added 2026-09-23,
    see document_edit.py's own module docstring for the full feature.
    instruction is free text, e.g. "paragraph 4 needs to mention cycle
    parking" or "the bit about parking is too vague, tie it to policy" -
    find_target_paragraph() locates the one paragraph it's about,
    rewrite_paragraph() rewrites only that paragraph.

    backend added 2026-09-24 (step 3 of the interactive-document-editing
    plan, architecture section 53) - same "groq" (default, unchanged) /
    "ollama" (fully local) choice already offered on /query and
    /site-answer, now available for document edits too."""
    instruction: str
    geography: str | None = None
    backend: str = "groq"


@app.get("/documents/{doc_id}")
def get_document(doc_id: str):
    """Returns a document's current paragraphs (after any edits already
    applied) plus its stored metadata - what the frontend re-fetches to
    reload the editable preview, e.g. after a page refresh."""
    from document_edit import load_paragraphs, load_meta

    paragraphs = load_paragraphs(doc_id)
    if paragraphs is None:
        raise HTTPException(status_code=404, detail=f"No document with id {doc_id!r}.")
    meta = load_meta(doc_id) or {}
    version = meta.get("version", 1)
    return {
        "doc_id": doc_id,
        "paragraphs": paragraphs,
        "meta": meta,
        "version": version,
        "pdf_url": f"/document-files/{doc_id}/current.pdf?v={version}",
    }


@app.post("/documents/{doc_id}/edit-clause")
def edit_clause(doc_id: str, req: EditClauseRequest):
    """Rewrites exactly one paragraph of a persisted document per a chat
    instruction, grounded against the policy corpus - see
    document_edit.edit_document_clause()'s own docstring. Returns the
    single changed paragraph (id, page, original/revised text,
    rationale, citations) so the frontend can patch just that one block
    of the live preview; every other paragraph is untouched on both the
    server and the client."""
    from document_edit import edit_document_clause

    t0 = time.time()
    result = edit_document_clause(
        doc_id, req.instruction, geography=req.geography, backend=req.backend,
    )
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    t1 = time.time()

    logger.info(
        f"edit-clause doc_id={doc_id} paragraph_id={result['paragraph_id']} "
        f"backend={req.backend} instruction={req.instruction!r} total_ms={(t1-t0)*1000:.0f}"
    )
    return {**result, "total_ms": round((t1 - t0) * 1000, 1)}


# --- Phase 2: propose/choose/reject/revert (2026-09-25, architecture plan ---
# section 53) - the real alternatives-before-replace endpoints, additive to
# /documents/{doc_id}/edit-clause above (which stays exactly as it is, the
# backward-compatible one-shot path). See document_edit.py's own "Phase 2"
# section docstring for the full design.


class ProposeEditRequest(BaseModel):
    """Body for POST /documents/{doc_id}/propose-edit. `issues` is the
    active compliance review's own merged issue list (proposal_review.py's
    {"topic","issue",...} shape, unchanged) - passed through by the
    frontend from its own `activeReview` state, since a review isn't
    stored server-side anywhere a doc_id could look it back up. Optional:
    an empty/omitted list just means plain paragraph matching, same as
    edit-clause today.

    `target_local_id`/`selected_text` (2026-09-25, inline-block-editing
    milestone) are optional and both None on the original chat-driven
    path (unchanged). When the frontend already knows the exact target -
    the user selected text inside a specific block in the interactive
    document view - it sends that block's id here instead of making the
    backend re-guess it; see document_edit.propose_edit()'s own
    docstring for the full split."""
    instruction: str
    geography: str | None = None
    backend: str = "groq"
    issues: list[dict] | None = None
    mode: str = "edit"
    target_local_id: int | None = None
    selected_text: str | None = None


@app.post("/documents/{doc_id}/propose-edit")
def propose_edit_route(doc_id: str, req: ProposeEditRequest):
    """Resolves the target paragraph - either explicitly given
    (`target_local_id`, the selection-driven path) or optionally
    issue-augmented and guessed (`find_target_paragraph()`/
    `match_compliance_issue()`, the original chat-driven path) - and
    generates alternatives (three grounded rewrites, or one exact
    replacement - see document_edit.propose_edit()'s own docstring) -
    writes a `patches` row + `patch_alternatives` row(s) and returns them
    for the user to choose from. Writes NOTHING to `blocks`: the live
    document is untouched until a later `.../choose` call. Returns
    {"error": ...} -> HTTP 400 on any failure, same convention as every
    other best-effort call in this project."""
    from document_edit import propose_edit

    t0 = time.time()
    result = propose_edit(
        doc_id, req.instruction, geography=req.geography, backend=req.backend,
        issues=req.issues, mode=req.mode,
        target_local_id=req.target_local_id, selected_text=req.selected_text,
    )
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    t1 = time.time()

    logger.info(
        f"propose-edit doc_id={doc_id} paragraph_id={result['paragraph_id']} "
        f"matched_issue={(result.get('matched_issue') or {}).get('topic')!r} "
        f"backend={req.backend} instruction={req.instruction!r} total_ms={(t1-t0)*1000:.0f}"
    )
    return {**result, "total_ms": round((t1 - t0) * 1000, 1)}


class ChoosePatchRequest(BaseModel):
    alternative_index: int
    expected_doc_version: int


@app.post("/documents/{doc_id}/patches/{patch_id}/choose")
def choose_patch_route(doc_id: str, patch_id: str, req: ChoosePatchRequest):
    """Applies one of propose-edit's three alternatives for real - the
    patch validator (staleness/citation-integrity/content-drift) runs
    here, at the moment of choosing, and only on success is the new
    revision written and current.pdf regenerated. Idempotent: choosing
    an already-applied patch again returns the same result rather than
    writing twice (see document_store.choose_patch()'s own docstring)."""
    from document_edit import choose_edit

    result = choose_edit(doc_id, patch_id, req.alternative_index, req.expected_doc_version)
    if result.get("error"):
        raise HTTPException(status_code=409, detail=result["error"])
    logger.info(
        f"choose-patch doc_id={doc_id} patch_id={patch_id} "
        f"alternative_index={req.alternative_index} already_applied={result.get('already_applied')}"
    )
    return result


@app.post("/documents/{doc_id}/patches/{patch_id}/reject")
def reject_patch_route(doc_id: str, patch_id: str):
    """Keeps the original wording - marks the proposal rejected, writes
    nothing else."""
    from document_edit import reject_edit

    result = reject_edit(doc_id, patch_id)
    if result.get("error"):
        raise HTTPException(status_code=409, detail=result["error"])
    return result


class RefinePatchRequest(BaseModel):
    """Body for POST /documents/{doc_id}/patches/{patch_id}/refine - the
    "Custom" refinement box (2026-09-26 six-area polish pass). Operates
    on a still-open (status="proposed") patch's own already-generated
    alternatives; never applies anything itself."""
    instruction: str
    backend: str = "groq"
    model: str | None = None


@app.post("/documents/{doc_id}/patches/{patch_id}/refine")
def refine_patch_route(doc_id: str, patch_id: str, req: RefinePatchRequest):
    """Generates ONE new alternative from the patch's existing
    alternatives plus a refinement instruction ("use option 2 but
    shorter", "combine options 1 and 3"...) and appends it to the same
    patch. Writes nothing to blocks/block_revisions - the result is just
    one more choosable alternative; the existing .../choose route is
    what actually applies it, unchanged."""
    from document_edit import refine_alternatives

    result = refine_alternatives(doc_id, patch_id, req.instruction, backend=req.backend, model=req.model)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    logger.info(
        f"refine-patch doc_id={doc_id} patch_id={patch_id} backend={req.backend} "
        f"instruction={req.instruction!r} new_index={result.get('index')}"
    )
    return result


class RevertBlockRequest(BaseModel):
    to_revision_id: str
    expected_doc_version: int


@app.post("/documents/{doc_id}/blocks/{local_id}/revert")
def revert_block_route(doc_id: str, local_id: int, req: RevertBlockRequest):
    """Undo - writes a NEW revision equal to an older one's text (never
    deletes/rewrites history). Deliberately skips the content-drift
    guard (see document_store.revert_block()'s own docstring for why)."""
    from document_edit import revert_edit

    result = revert_edit(doc_id, local_id, req.to_revision_id, req.expected_doc_version)
    if result.get("error"):
        raise HTTPException(status_code=409, detail=result["error"])
    logger.info(f"revert-block doc_id={doc_id} local_id={local_id} version={result.get('version')}")
    return result


@app.post("/documents/{doc_id}/regenerate-report")
def regenerate_report_route(doc_id: str):
    """Report-tab analog of choose_edit()/revert_edit()'s own current.pdf
    regeneration, added 2026-09-25 for report-block editing:
    doc_id here is a report_doc_id (from /proposal-review's
    report_doc_id field), not a source document. Re-runs
    report_render.build_reports() against the report's current,
    possibly-edited prose and overwrites the same reports/<slug> files
    the original review wrote - see document_edit.regenerate_report_
    files()'s own docstring. The frontend calls this once, right after a
    successful choose-patch, to refresh reportFiles.pdf_url/html_url -
    it is NOT called automatically by choose_patch_route/revert_block_
    route above, which stay completely generic/unaware of report vs.
    source documents."""
    from document_edit import regenerate_report_files

    result = regenerate_report_files(doc_id)
    if result.get("error"):
        raise HTTPException(status_code=400, detail=result["error"])
    logger.info(f"regenerate-report doc_id={doc_id} version={result.get('version')}")
    return result


@app.get("/documents/{doc_id}/blocks/{local_id}/history")
def block_history_route(doc_id: str, local_id: int):
    """The ordered, immutable revision history of one block - what a
    future "view history" UI or an Undo affordance's own confirmation
    can read from, and what this session's Undo button uses to show
    when there's nothing left to undo (history length <= 1)."""
    import document_store as store

    if not store.document_exists(doc_id):
        raise HTTPException(status_code=404, detail=f"No document with id {doc_id!r}.")
    history = store.get_block_history(doc_id, local_id)
    return {"doc_id": doc_id, "local_id": local_id, "history": history}
