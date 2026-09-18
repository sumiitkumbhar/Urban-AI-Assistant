"""Proposal compliance review (added 2026-09-18, per explicit request:
"upload company proposal documents ... assess based on our corpus and
tell suggestions, what needs to be changed"). Given an uploaded proposal
document (a Design & Access Statement / planning statement, typically)
and a site (an existing project_state.py project, or a postcode/lat-lon),
this:

  1. Extracts the proposal's own text (reusing ingest.py's own
     extract_pages() - the identical PDF-extraction path every corpus
     document already goes through, so behavior/limitations stay
     consistent: text-native PDFs extract cleanly, scanned/image-only
     pages - e.g. a page that's mostly a site plan or elevation drawing -
     come back empty and are reported separately as "not assessed",
     never silently misread as blank/compliant content).
  2. Resolves the site's real GIS constraints - either from an existing
     project_state.py project (constraints_json, already matched and
     cached) or a fresh gis_lookup.site_constraints() call for a
     postcode/lat-lon, mirroring site_context.py's own site-resolution
     logic exactly so the two paths can never disagree about what "the
     site's constraints" means.
  3. Runs a fixed set of standard UK-planning assessment topics (design,
     housing/land use, parking/access, heritage/conservation area,
     listed buildings, Article 4, Green Belt, flood risk, fire
     safety/building regulations) through orchestrate() - the same
     multi-agent domain classifier every other query in this project
     uses - scoped to the site's geography. A constraint-specific topic
     (heritage, listed buildings, Article 4, Green Belt, flood risk) is
     only included when the site's own constraints actually raise it -
     querying Article 4 policy for a site with no Article 4 direction
     would just waste a retrieval call and dilute the evidence set with
     irrelevant chunks, the same principle site_context.py's
     _describe_constraints() already follows.
  4. Merges/dedupes the retrieved chunks across topics into one numbered
     evidence set (answer.py's own build_context()), then makes exactly
     ONE Groq call - not one per topic, so a single coherent report
     comes back rather than N disconnected mini-answers - asking for a
     structured JSON list of issues: what the proposal is missing,
     unclear about, or appears not to comply with, why (citing evidence
     by [N]), and a concrete suggested change. Mirrors answer.py's own
     "cite everything, never invent" system-prompt discipline and its
     _extract_first_json_object() parsing helper.

Deliberately does NOT add the uploaded proposal into the corpus/index -
this is a one-off assessment of a document someone hands in, not new
reference material for local-rag to answer future unrelated queries
from. If a document should become permanent corpus content, that's a
job for ingest.py/council_ingest.py, not this module.
"""

import json
import os
from pathlib import Path

from groq import Groq, APIStatusError

from common import load_dotenv_from_repo, DEFAULT_GROQ_MODEL
from answer import build_context, _extract_first_json_object
from orchestrate import orchestrate
from site_context import _describe_constraints, _lpa_reference_to_geography

# (retrieval query, constraint_key). constraint_key is None for topics
# that always apply regardless of the site's constraints; otherwise it
# names the site_constraints()/constraints_json block that must have at
# least one match before this topic is even queried - see
# _select_topics(). Phrased to reuse common.py's own DOMAIN_KEYWORDS
# where a natural match exists (e.g. "conservation area", "fire safety",
# "flood risk") so orchestrate() actually scopes these to the right
# domain agent instead of falling back to an unscoped search.
STANDARD_TOPICS = [
    ("design, scale and massing", None),
    ("housing and land use policy", None),
    ("parking, access and highways", None),
    ("heritage impact and conservation area design guidance", "conservation_areas"),
    ("impact on a listed building and its setting", "listed_buildings"),
    ("Article 4 direction and permitted development rights", "article_4_directions"),
    ("Green Belt policy and very special circumstances", "green_belt"),
    ("flood risk, the Sequential Test and the Exception Test", "flood_risk_zones"),
    ("fire safety and building regulations", None),
]

REVIEW_SYSTEM_PROMPT = """You are a UK planning compliance reviewer. You are given: \
(1) the site's known constraints (if any), (2) numbered policy evidence extracts \
from UK planning/building-regulation sources, and (3) the full text of a proposal \
document submitted for that site. \
Compare the proposal against the evidence and the site's constraints. Identify \
specific issues: anything the proposal does not address, appears to conflict with, \
or should state more clearly given the applicable policy or constraint. For each \
issue, cite the evidence that supports it using its number in square brackets, e.g. \
[2] - never invent a citation, policy number, or page, and never cite evidence that \
doesn't actually support the point. If the proposal already addresses a topic \
adequately, do not flag it. If there isn't enough evidence to assess a topic, say so \
rather than guessing. \
Respond with JSON only, no other text, no markdown fencing, in this exact shape: \
{"summary": "one or two sentence overview", "issues": [{"topic": "short topic label", \
"issue": "what's missing, unclear, or non-compliant", "citations": [1, 3], \
"suggested_change": "a specific, actionable change"}]}"""

# Real budget, not just a safety net (found the hard way 2026-09-18): this
# repo's Groq org is on a tier capped at 8000 tokens/minute per request
# ("Request too large ... Limit 8000, Requested 11845" - the original
# 60000-char cap alone was ~12-15k tokens, before even adding the evidence
# context). At a conservative ~3.5 chars/token for dense policy/proposal
# prose, 12000 chars is roughly 3400 tokens - leaving room for the system
# prompt (~350 tokens), the evidence context (bounded by MAX_EVIDENCE_CHUNKS
# below), and MAX_COMPLETION_TOKENS, comfortably under the 8000 limit.
MAX_PROPOSAL_CHARS = 12000
# Hard cap on the merged/deduped evidence set, applied AFTER merging across
# every topic - without this, more applicable constraint topics (a site
# with conservation area + Article 4 + flood risk all matched) directly
# inflates evidence size with no ceiling, which is exactly the kind of
# per-topic multiplication that blew the token budget above. Chunks are
# sorted by rerank_score first so the cap keeps the best evidence across
# ALL topics, not just however many happen to fit from the first topics
# processed.
MAX_EVIDENCE_CHUNKS = 10
MAX_COMPLETION_TOKENS = 1024


def extract_proposal_text(pdf_path):
    """Returns (full_text, pages_with_text, pages_without_text, error).
    Reuses ingest.py's own extract_pages() - the identical extraction
    path every corpus document already goes through - rather than a
    second, possibly-inconsistent PDF-reading implementation. A page
    that comes back with no extractable text is reported in
    pages_without_text rather than silently dropped, since for a
    proposal document that's very likely to be a drawing/site plan/
    elevation - content this text-only pipeline was never built to read
    (see ingest.py's extract_pages() docstring for why)."""
    from ingest import extract_pages
    from pypdf import PdfReader

    pdf_path = Path(pdf_path)
    try:
        total_pages = len(PdfReader(str(pdf_path)).pages)
    except Exception as e:
        return None, [], [], f"Could not open {pdf_path.name}: {e}"

    pages_with_text = []
    texts = []
    for page_num, text in extract_pages(pdf_path):
        pages_with_text.append(page_num)
        texts.append(f"[Page {page_num}]\n{text}")
    pages_without_text = [p for p in range(1, total_pages + 1) if p not in pages_with_text]
    return "\n\n".join(texts), pages_with_text, pages_without_text, None


def _select_topics(site):
    """Only include a constraint-specific topic when that constraint was
    actually matched (site[constraint_key]["matches"] non-empty) -
    mirrors _describe_constraints()'s own "only describe what was
    actually matched" rule, so a site with no Article 4 direction
    doesn't waste a retrieval call (and dilute the evidence set) on
    Article 4 policy. Works on both a live site_constraints() result and
    a project's stored constraints_json - same shape, same reason
    _describe_constraints() itself handles both (see its docstring)."""
    topics = []
    for query, constraint_key in STANDARD_TOPICS:
        if constraint_key is None:
            topics.append(query)
            continue
        block = (site or {}).get(constraint_key) or {}
        if block.get("matches"):
            topics.append(query)
    return topics


def _resolve_site(project_id=None, postcode=None, lat=None, lon=None):
    """Returns (site_constraints_dict_or_None, geography_or_None,
    error_or_None). Mirrors site_context.build_site_context()'s own
    site-resolution logic so a project-scoped review and a fresh-
    postcode review can never disagree about what "the site" means.
    project_id takes priority when given, reusing the project's
    already-matched, cached constraints_json rather than a second live
    GIS lookup - the same reuse project_state.py's own
    build_context_summary() already relies on. site_constraints_dict can
    legitimately be None (no postcode/lat-lon on the project, or none
    given at all) - the review still runs, just without a
    constraint-specific topic list or a constraint_summary."""
    if project_id is not None:
        import project_state

        project = project_state.get_project(project_id)
        if project is None:
            return None, None, f"No project with id {project_id}."
        return project.get("constraints"), project.get("geography"), None

    from gis_lookup import geocode_postcode, site_constraints

    if lat is not None and lon is not None:
        point = (lat, lon)
    elif postcode:
        point = geocode_postcode(postcode)
        if not point:
            return None, None, f"Postcode {postcode!r} not found."
    else:
        return None, None, "Provide project_id, or postcode, or lat/lon."

    site = site_constraints(*point)
    lpa = site["local_planning_authority"]
    geography = _lpa_reference_to_geography(lpa["reference"] if lpa else None)
    return site, geography, None


def review_proposal(document_texts, project_id=None, postcode=None, lat=None, lon=None,
                     model=DEFAULT_GROQ_MODEL, top_k=15, rerank_top_n=6):
    """document_texts: list of (filename, extracted_text) pairs - see
    extract_proposal_text(). Returns a dict with the site/constraint
    context, the topics actually checked, the merged evidence citations,
    and the structured assessment - or {"error": ...} if the site
    couldn't be resolved or the answer model isn't configured.

    top_k/rerank_top_n default smaller than answer.py's generate_answer()
    (25/8) because this runs one retrieval call per topic (up to 9, most
    sites fewer since constraint-specific topics are skipped when not
    applicable) rather than one - a real cost multiplier worth trimming
    per-call for, since local retrieval is fast but not free of wall-clock
    time, and the merged evidence set only needs to be big enough to
    support one synthesis call, not exhaustive."""
    site, geography, error = _resolve_site(project_id, postcode, lat, lon)
    if error:
        return {"error": error}

    phrases, _area_names = _describe_constraints(site) if site else ([], [])
    constraint_summary = " and ".join(phrases) if phrases else None

    topics = _select_topics(site)

    # Each topic's orchestrate() call is wrapped individually - a real
    # bug found 2026-09-18 the hard way: orchestrate()'s multi-agent
    # fan-out path (_run_agent()) already catches a failed domain
    # agent's exception internally ("graceful degradation", see
    # orchestrate.py's module docstring), but its single/no-domain path
    # calls retrieve() directly with no try/except at all - so a topic
    # whose query happens to classify into 0 or 1 domain propagates an
    # uncaught exception (confirmed for real: a locked embedded-Qdrant
    # store, e.g. a `uvicorn service:app` left running elsewhere,
    # crashes with RuntimeError: "Storage folder ... is already accessed
    # by another instance"). Without this try/except, one bad topic
    # would crash the entire review instead of the review reporting
    # which topic couldn't be checked and continuing with the rest.
    all_chunks = []
    seen = set()
    failed_topics = []
    for topic in topics:
        query = topic + (f", for a site {constraint_summary}" if constraint_summary else "")
        try:
            chunks, _coverage = orchestrate(
                query, top_k=top_k, rerank_top_n=rerank_top_n, geography_filter=geography
            )
        except Exception as e:
            failed_topics.append((topic, str(e)))
            continue
        for c in chunks:
            key = (c["doc_filename"], c["page"], c["text"][:80])
            if key not in seen:
                seen.add(key)
                all_chunks.append(c)

    # Never let the assessment call run with zero evidence - the other
    # real bug found the same day: when every topic's retrieval silently
    # came back empty (same root cause as above, but via the multi-agent
    # path's own internal try/except swallowing the same lock error
    # instead of raising it - "graceful degradation" only prevents a
    # crash, it does not mean the query actually succeeded), the model
    # still produced a confident, specifically-worded compliance report
    # with citation markers [1]-[5] anyway, DESPITE REVIEW_SYSTEM_PROMPT
    # explicitly saying "If there isn't enough evidence to assess a
    # topic, say so rather than guessing." A UK-planning compliance
    # report a real company might act on is exactly the wrong place to
    # trust an LLM's own restraint over a hard guard - so this refuses
    # to call the model at all when there is no real evidence, rather
    # than hoping it says so itself.
    if not all_chunks:
        if failed_topics:
            detail = "; ".join(f"{t!r}: {e}" for t, e in failed_topics)
            hint = (
                "This looks like a retrieval failure, not a genuine lack of matching "
                "policy - check whether another process (e.g. a `uvicorn service:app` "
                "left running in another terminal tab) is holding a lock on the local "
                "Qdrant index at data/qdrant, and stop it before retrying. "
            )
        else:
            detail = "no matching evidence was found for any checked topic"
            hint = ""
        return {
            "error": (
                "No policy evidence could be retrieved for any of the checked topics, "
                "so no assessment was generated - an assessment without real evidence "
                f"would just be a guess, however confident it reads. {hint}Detail: {detail}"
            ),
            "geography": geography,
            "constraint_summary": constraint_summary,
            "topics_checked": topics,
            "topics_failed": [t for t, _ in failed_topics],
        }

    # Cap AFTER merging (see MAX_EVIDENCE_CHUNKS's own comment above) -
    # best evidence across every topic wins, not just whatever the first
    # few topics happened to contribute.
    all_chunks.sort(key=lambda c: c.get("rerank_score", 0.0), reverse=True)
    all_chunks = all_chunks[:MAX_EVIDENCE_CHUNKS]

    context, citations = build_context(all_chunks)

    proposal_text = "\n\n===\n\n".join(
        f"DOCUMENT: {name}\n{text}" for name, text in document_texts
    )
    truncated = len(proposal_text) > MAX_PROPOSAL_CHARS
    if truncated:
        proposal_text = proposal_text[:MAX_PROPOSAL_CHARS]

    load_dotenv_from_repo()
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return {
            "error": "GROQ_API_KEY isn't set (checked the repo's .env.local) - "
                     "retrieval worked, but the assessment call needs it.",
            "geography": geography,
            "constraint_summary": constraint_summary,
            "topics_checked": topics,
            "topics_failed": [t for t, _ in failed_topics],
            "evidence_citations": citations,
        }

    client = Groq(api_key=api_key)
    user_content = f"Evidence:\n\n{context}\n\n---\n\n"
    if constraint_summary:
        user_content += f"Site constraints: the site is {constraint_summary}.\n\n---\n\n"
    user_content += f"Proposal document text:\n\n{proposal_text}"

    # Found the hard way 2026-09-18: an uncaught APIStatusError here (e.g.
    # a 413 "Request too large" token-per-minute rate limit) crashed the
    # whole CLI with a raw traceback instead of a clear message - the same
    # "never let a real failure look like an ugly stack trace" instinct as
    # every other Groq call in this project (generate_answer()'s missing-
    # API-key early return, _check_groundedness()'s best-effort catch).
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.1,
            max_tokens=MAX_COMPLETION_TOKENS,
        )
    except APIStatusError as e:
        return {
            "error": (
                f"The assessment call to Groq failed ({e}). If this is a token-per-minute "
                "rate limit, the combined evidence + proposal text was too large for the "
                "account's tier - try again with a shorter proposal document/fewer pages, "
                "or wait a minute and retry."
            ),
            "geography": geography,
            "constraint_summary": constraint_summary,
            "topics_checked": topics,
            "topics_failed": [t for t, _ in failed_topics],
            "evidence_citations": citations,
            "proposal_truncated": truncated,
        }
    raw = completion.choices[0].message.content or ""
    json_text = _extract_first_json_object(raw)
    parse_error = None
    if json_text:
        try:
            assessment = json.loads(json_text)
        except Exception:
            assessment = {"summary": raw.strip(), "issues": []}
            parse_error = "Model response wasn't valid JSON - showing raw text as the summary."
    else:
        assessment = {"summary": raw.strip(), "issues": []}
        parse_error = "Model response wasn't valid JSON - showing raw text as the summary."

    return {
        "geography": geography,
        "constraint_summary": constraint_summary,
        "topics_checked": topics,
        "topics_failed": [t for t, _ in failed_topics],
        "evidence_citations": citations,
        "assessment": assessment,
        "parse_error": parse_error,
        "proposal_truncated": truncated,
    }
