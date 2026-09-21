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
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from common import DATA_DIR, CHUNKS_PATH, QDRANT_PATH, BM25_PATH
from answer import generate_answer, stream_answer
from orchestrate import orchestrate
from site_context import build_site_context, _describe_constraints, _find_map_citations
from map_images import MAP_IMAGES_DIR
import project_state as project_state_module
import memory as memory_module
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


@app.post("/query")
def query(req: QueryRequest):
    t0 = time.time()
    project_context, geography, map_citations = _resolve_project_context(
        req.project_id, req.geography
    )
    chunks, coverage = orchestrate(
        req.question, top_k=req.top_k, rerank_top_n=req.rerank_top_n,
        geography_filter=geography,
    )
    t1 = time.time()
    result = generate_answer(req.question, chunks, coverage=coverage, project_context=project_context)
    t2 = time.time()

    _auto_log_query_event(req.project_id, req.question, result.get("answer"))

    logger.info(
        f"query={req.question!r} chunks={len(chunks)} confidence={coverage['confidence']} "
        f"retrieval_ms={(t1-t0)*1000:.0f} generation_ms={(t2-t1)*1000:.0f}"
    )
    return {
        **result,
        "coverage": coverage,
        "map_citations": map_citations,
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
    project_context, geography, map_citations = _resolve_project_context(
        req.project_id, req.geography
    )
    chunks, coverage = orchestrate(
        req.question, top_k=req.top_k, rerank_top_n=req.rerank_top_n,
        geography_filter=geography,
    )
    t1 = time.time()

    def event_stream():
        yield f"event: coverage\ndata: {json.dumps(coverage)}\n\n"
        for kind, payload in stream_answer(
            req.question, chunks, coverage=coverage, project_context=project_context
        ):
            if kind == "delta":
                yield f"event: delta\ndata: {json.dumps({'text': payload})}\n\n"
            else:  # "done"
                t2 = time.time()
                result = {
                    **payload,
                    "coverage": coverage,
                    "map_citations": map_citations,
                    "retrieval_ms": round((t1 - t0) * 1000, 1),
                    "generation_ms": round((t2 - t1) * 1000, 1),
                }
                _auto_log_query_event(req.project_id, req.question, payload.get("answer"))
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


# --- Structured project state (architecture-plan section 22/23/28,
# Phase 7's first slice) - thin HTTP wrapping around project_state.py's
# CRUD functions, which do all the real work (including turning "no such
# project" into None); this layer's only job is None -> 404.


class ProjectCreateRequest(BaseModel):
    name: str
    postcode: str | None = None
    lat: float | None = None
    lon: float | None = None


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
            req.name, postcode=req.postcode, lat=req.lat, lon=req.lon
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
    with tempfile.TemporaryDirectory() as tmp:
        saved_paths = []
        for upload in files:
            dest = _Path(tmp) / upload.filename
            dest.write_bytes(await upload.read())
            saved_paths.append(dest)
            text, _pages_with_text, pages_without_text, error = extract_proposal_text(dest)
            if error:
                raise HTTPException(status_code=400, detail=f"{upload.filename}: {error}")
            document_texts.append((upload.filename, text))
            if pages_without_text:
                pages_not_assessed[upload.filename] = pages_without_text

        result = review_proposal(
            document_texts, project_id=project_id, postcode=postcode, lat=lat, lon=lon,
        )
        if result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])

        # Extracting site photos (extract_report_images) and rendering the
        # PDF both need the uploaded files on disk, so this runs while the
        # temp dir is still alive - it's gone the moment the `with` exits.
        document_names = [name for name, _ in document_texts]
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
        f"postcode={postcode!r} geography={result.get('geography')} "
        f"issues={len(result['assessment'].get('issues', []))} "
        f"total_ms={(t1-t0)*1000:.0f}"
    )
    return {
        **result,
        "pages_not_assessed": pages_not_assessed,
        "report_files": report_files,
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
