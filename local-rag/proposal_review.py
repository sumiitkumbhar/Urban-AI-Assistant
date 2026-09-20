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
     comes back rather than N disconnected mini-answers - asking for TWO
     things in one structured JSON response: a list of issues (what the
     proposal is missing, unclear about, or appears not to comply with,
     why, citing evidence by [N], and a concrete suggested change), and
     a checklist of the specific items (statements, assessments, plans)
     the evidence indicates a proposal like this should include, each
     marked present/missing/unclear against the proposal's own text
     (added 2026-09-18, per explicit request: "tell if any of the
     clauses are remaining to put inside the proposal... suggest what
     things to be included" - see REVIEW_SYSTEM_PROMPT and STANDARD_TOPICS'
     dedicated "required content" topic). Mirrors answer.py's own "cite
     everything, never invent" system-prompt discipline and its
     _extract_first_json_object() parsing helper. The summary and each
     issue/checklist note are written as real prose with citations woven
     into the sentences themselves ("the site sits within a conservation
     area [5], which places specific design constraints..." rather than a
     citation list bolted on after a terse clause) - added 2026-09-18 per
     explicit request: "make it descriptive and more detailed... in-text
     citations".

Deliberately does NOT add the uploaded proposal into the corpus/index -
this is a one-off assessment of a document someone hands in, not new
reference material for local-rag to answer future unrelated queries
from. If a document should become permanent corpus content, that's a
job for ingest.py/council_ingest.py, not this module.

Functions as a first-pass planning adviser, not a professional one - every
successful assessment carries a DISCLAIMER (see below) saying so plainly,
since a specific, citation-backed report can otherwise read as a final
judgement rather than a starting point for a real review.
"""

import json
import os
import re
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
    # Added 2026-09-18 per explicit request ("tell if any of the clauses
    # are remaining to put inside the proposal... suggest what things to
    # be included") - a dedicated topic so the requirements checklist
    # below (see REVIEW_SYSTEM_PROMPT's "checklist" field) has real
    # evidence to check against, rather than relying on whatever the
    # other topics happened to retrieve. Deliberately always-applies
    # (constraint_key=None): every proposal needs to be checked for
    # required content, regardless of which constraints the site has.
    ("required content and mandatory sections of a planning application, "
     "design and access statement, or supporting documents", None),
]

REVIEW_SYSTEM_PROMPT = """You are a UK planning compliance reviewer writing a proper advisory \
report, not a bare list of bullet points. You are given: (1) the site's known constraints (if \
any), (2) numbered policy evidence extracts from UK planning/building-regulation sources, and \
(3) the full text of a proposal document submitted for that site. \
Write a "summary" as a real narrative paragraph of 3-5 sentences - not a one-line blurb - that \
reads like the opening of an advisory letter: describe the site and its constraints, \
characterize what the proposal covers, and preview the main concerns, weaving citations \
directly into the sentences themselves in square brackets, e.g. "the site sits within a \
conservation area [5], which places specific design constraints on roof profiles [6]." Every \
factual claim in the summary needs an inline citation like that, as part of the sentence, not \
listed separately afterward. \
Then do two things, in the same inline-citation style throughout. \
First, identify specific issues: anything the proposal does not address, appears to conflict \
with, or should state more clearly given the applicable policy or constraint. For each issue, \
write a fuller explanation of 2-4 sentences (not a single clause): state the specific policy or \
constraint requirement and cite it inline as part of the sentence, explain why it matters for \
this site, and describe what is actually missing or unclear in the proposal. \
Second, build a checklist of specific items (named statements, assessments, plans, or sections \
- e.g. "heritage statement", "flood risk assessment", "site location plan") that the evidence \
indicates a proposal like this should include. Base this ONLY on what the evidence actually says \
is required for this site's circumstances - never a generic assumption about what proposals \
usually contain. For each checklist item, mark it "present" if the proposal document text \
clearly includes it, "missing" if it does not appear at all, or "unclear" if it's ambiguous or \
only partially covered, and write a note of 1-2 sentences explaining why it's required (with an \
inline citation) and, if missing or unclear, what to add. \
Rules that apply throughout: cite evidence using its number in square brackets as part of the \
sentence wherever a claim depends on it, not only in a trailing list - never invent a citation, \
policy number, or page, and never cite evidence that doesn't actually support the point. Also \
still return the citation numbers you used for each issue/checklist item as a separate numeric \
array (for cross-referencing), even though the same numbers already appear inline in your \
prose. If the proposal already addresses a topic or checklist item adequately, mark it "present" \
rather than flagging it as an issue. If there isn't enough evidence to assess a topic or \
establish a requirement, say so plainly rather than guessing. \
Respond with JSON only, no other text, no markdown fencing, in this exact shape: \
{"summary": "a 3-5 sentence narrative with inline [N] citations woven into the prose", "issues": \
[{"topic": "short topic label", "issue": "a 2-4 sentence explanation with inline [N] citations \
woven into the prose", "citations": [1, 3], "suggested_change": "a specific, actionable \
change"}], "checklist": [{"item": "short name of the required item", "status": \
"present"|"missing"|"unclear", "citations": [4], "note": "1-2 sentences with an inline [N] \
citation - why it's required and, if missing or unclear, what to add"}]}"""

# Real budget, not just a safety net (found the hard way 2026-09-18): this
# repo's Groq org is on a tier capped at 8000 tokens/minute per request
# ("Request too large ... Limit 8000, Requested 11845" - the original
# 60000-char cap alone was ~12-15k tokens, before even adding the evidence
# context). At a conservative ~3.5 chars/token for dense policy/proposal
# prose:
#   REVIEW_SYSTEM_PROMPT (~1000 tokens as of the "descriptive, in-text
#   citations" rewrite 2026-09-18 - up from ~610 when the checklist
#   instructions were added, ~350 before that) + proposal text + evidence
#   context (bounded by MAX_EVIDENCE_CHUNKS) + MAX_COMPLETION_TOKENS must
#   stay comfortably under 8000. Each prompt expansion so far has grown
#   BOTH the prompt itself and the expected completion (longer narrative
#   summary, longer per-issue explanations), so MAX_PROPOSAL_CHARS keeps
#   absorbing the cut - evidence quality (MAX_EVIDENCE_CHUNKS) is kept up
#   instead, since richer inline citations need a bigger evidence pool to
#   draw on, not a smaller one; the proposal text was already truncated
#   before (and truncation is reported to the caller via
#   "proposal_truncated"), so trimming it further degrades the result
#   less than trimming evidence or the completion budget would.
MAX_PROPOSAL_CHARS = 5000
# Hard cap on the merged/deduped evidence set, applied AFTER merging across
# every topic - without this, more applicable constraint topics (a site
# with conservation area + Article 4 + flood risk all matched) directly
# inflates evidence size with no ceiling, which is exactly the kind of
# per-topic multiplication that blew the token budget above. Chunks are
# sorted by rerank_score first so the cap keeps the best evidence across
# ALL topics, not just however many happen to fit from the first topics
# processed.
MAX_EVIDENCE_CHUNKS = 8
# Raised again 2026-09-18 (1024 -> 1400 -> 2200): the "descriptive, more
# detail, in-text citations" rewrite asks for a 3-5 sentence narrative
# summary plus 2-4 sentence explanations per issue (previously a single
# clause each) - real prose, not just structured fields, needs real room.
# reasoning_effort="low" (below) is what keeps this from repeating the
# empty-content failure a bigger completion budget alone can't fix.
MAX_COMPLETION_TOKENS = 2200

# Attached to every successful assessment (CLI report and API response
# alike, since service.py's /proposal-review just spreads review_proposal()'s
# return dict) - added 2026-09-18 at the user's own request, after
# confirming this tool functions as a first-pass adviser: it should say so
# plainly rather than let a specific, confidently-worded report read as a
# final professional judgement. Kept short and attached to the data, not
# just mentioned in chat, so it survives however the report is delivered -
# CLI, curl, or (once built) a browser UI.
DISCLAIMER = (
    "This is an automated first-pass check against the indexed corpus and the site's "
    "GIS-matched constraints - not professional planning or legal advice. It can only "
    "flag what the corpus and constraints actually cover, and it can still miss things "
    "or misjudge relevance. Treat each issue as something to verify, not a final answer, "
    "and have a qualified planning consultant or solicitor review anything before it is "
    "submitted or relied on."
)


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


def _resolve_site(document_texts, project_id=None, postcode=None, lat=None, lon=None):
    """Returns (site_constraints_dict_or_None, geography_or_None,
    error_or_None, site_detection_or_None). Mirrors
    site_context.build_site_context()'s own site-resolution logic so a
    project-scoped review and a fresh-postcode review can never
    disagree about what "the site" means. project_id takes priority
    when given, reusing the project's already-matched, cached
    constraints_json rather than a second live GIS lookup - the same
    reuse project_state.py's own build_context_summary() already relies
    on. site_constraints_dict can legitimately be None (no postcode/
    lat-lon on the project, or none given at all) - the review still
    runs, just without a constraint-specific topic list or a
    constraint_summary.

    When none of project_id/postcode/lat/lon is given at all (added
    2026-09-19, per explicit request: "find the postcode based on the
    documents... or if postcode is not mentioned then... look up the
    postcode based on the name"), falls back to site_lookup.detect_site()
    on the proposal's own text before giving up - site_detection is
    that function's result (None unless this fallback fired), returned
    alongside the resolved site so the caller/report can be explicit
    about a site that was guessed rather than given."""
    if project_id is not None:
        import project_state

        project = project_state.get_project(project_id)
        if project is None:
            return None, None, f"No project with id {project_id}.", None
        return project.get("constraints"), project.get("geography"), None, None

    from gis_lookup import geocode_postcode, site_constraints

    site_detection = None
    if lat is not None and lon is not None:
        point = (lat, lon)
    elif postcode:
        point = geocode_postcode(postcode)
        if not point:
            return None, None, f"Postcode {postcode!r} not found.", None
    else:
        from site_lookup import detect_site

        site_detection = detect_site(document_texts)
        if not site_detection:
            return None, None, (
                "Provide project_id, or postcode, or lat/lon - couldn't auto-detect a "
                "postcode or a site name from the uploaded document(s) either, so there's "
                "no site to check GIS constraints against."
            ), None
        point = (site_detection["lat"], site_detection["lon"])

    site = site_constraints(*point)
    lpa = site["local_planning_authority"]
    geography = _lpa_reference_to_geography(lpa["reference"] if lpa else None)
    return site, geography, None, site_detection


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
    site, geography, error, site_detection = _resolve_site(
        document_texts, project_id, postcode, lat, lon
    )
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
            "site_detection": site_detection,
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
            "site_detection": site_detection,
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
    # reasoning_effort="low" added 2026-09-18: openai/gpt-oss-120b is a
    # reasoning model - it spends tokens "thinking" before it writes the
    # actual JSON answer, and that thinking counts against max_tokens like
    # everything else. The single-array "issues" prompt left enough of the
    # 1024-token budget for a real answer after its (short) reasoning; the
    # two-array "issues" + "checklist" prompt made reasoning long enough
    # that it consumed the entire budget and left literally nothing for
    # the answer (content came back empty, finish_reason "length" - found
    # the hard way running this against a real Westminster D&AS). Capping
    # reasoning effort is the right fix, not just raising max_tokens
    # further - that would only buy a bit more headroom before the same
    # thing happens on a harder proposal, and pushes back toward the 8000
    # TPM ceiling. Isolated in _call_groq() so an older groq SDK that
    # doesn't recognize the kwarg degrades to the old behavior instead of
    # crashing outright.
    def _call_groq():
        kwargs = dict(
            model=model,
            messages=[
                {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.1,
            max_tokens=MAX_COMPLETION_TOKENS,
        )
        try:
            return client.chat.completions.create(reasoning_effort="low", **kwargs)
        except TypeError:
            return client.chat.completions.create(**kwargs)

    try:
        completion = _call_groq()
    except APIStatusError as e:
        return {
            "error": (
                f"The assessment call to Groq failed ({e}). If this is a token-per-minute "
                "rate limit, the combined evidence + proposal text was too large for the "
                "account's tier - try again with a shorter proposal document/fewer pages, "
                "or wait a minute and retry."
            ),
            "geography": geography,
            "site_detection": site_detection,
            "constraint_summary": constraint_summary,
            "topics_checked": topics,
            "topics_failed": [t for t, _ in failed_topics],
            "evidence_citations": citations,
            "proposal_truncated": truncated,
        }
    raw = completion.choices[0].message.content or ""
    finish_reason = completion.choices[0].finish_reason
    json_text = _extract_first_json_object(raw)
    assessment_failed = False
    if json_text:
        try:
            assessment = json.loads(json_text)
        except Exception:
            assessment_failed = True
    else:
        assessment_failed = True

    if assessment_failed:
        # Deliberately NOT {"issues": [], "checklist": []} here - that
        # would print/render as a clean "no issues found" result, which is
        # exactly the kind of confident-looking-but-ungrounded output this
        # tool is built to never produce (see the zero-evidence guard
        # above). None is a distinct, unmissable "this didn't work" -
        # every caller (CLI, report_render.py) checks assessment_failed
        # before treating issues/checklist as real.
        assessment = {"summary": None, "issues": None, "checklist": None}
        parse_error = (
            "The model did not return a parseable assessment - raw response was "
            f"{'empty' if not raw.strip() else 'not valid JSON'} (finish_reason="
            f"{finish_reason!r}). This is a real failure, not \"no issues found\" - most "
            "likely the model used its whole token budget on internal reasoning before "
            "writing an answer. Try again; if it keeps happening, this proposal/evidence "
            "combination may need a larger MAX_COMPLETION_TOKENS."
        )
    else:
        parse_error = None

    return {
        "geography": geography,
        "site_detection": site_detection,
        "constraint_summary": constraint_summary,
        "topics_checked": topics,
        "topics_failed": [t for t, _ in failed_topics],
        "evidence_citations": citations,
        "assessment": assessment,
        "assessment_failed": assessment_failed,
        "parse_error": parse_error,
        "proposal_truncated": truncated,
        "disclaimer": DISCLAIMER,
    }


# --------------------------------------------------------------------------
# Follow-up chat grounding (service.py's /proposal-review-chat) - added
# 2026-09-19, per explicit request: "after uploading the documents the
# user can have the convo related to this... to and fro discussion can
# happen." Builds a plain-text summary of an already-completed review
# (the same shape report_render.py renders) for injection into a normal
# /query-style call as `project_context` - see answer.py's
# _build_user_content(), which already knows how to fold arbitrary extra
# context in ahead of the retrieved evidence. This is deliberately NOT a
# separate retrieval path: a follow-up question still runs a full
# orchestrate() against the corpus (so it can answer things the original
# review never touched), it just also carries the review's own findings
# into the prompt so answers stay consistent with what's already on the
# report, instead of contradicting it or re-deriving it from scratch.
# --------------------------------------------------------------------------

_REVIEW_CITE_RE = re.compile(r"\[(\d+)\]")


def _strip_review_citation_markers(text):
    """Drops a review's own [N] evidence markers before folding its text
    into a follow-up prompt. Those numbers index the review's evidence
    table (evidence_citations, sent back with the original /proposal-
    review response) - they mean nothing to THIS call's own evidence,
    which build_context() numbers fresh per request (see answer.py). If
    a review's "[5]" leaked into the injected context unchanged, the
    model could cite it as if it were one of this answer's own sources,
    which would be wrong - so every marker is stripped, not renumbered."""
    return re.sub(r"\s+", " ", _REVIEW_CITE_RE.sub("", text or "")).strip()


def build_review_context_text(review):
    """review is a plain dict shaped like the /proposal-review response's
    own fields (geography, constraint_summary, and assessment.summary /
    .issues / .checklist) - callers pass exactly what the frontend
    already has in hand from that earlier response, no reshaping. Skips
    empty sections rather than printing "Site: None" noise; returns ""
    if the review is empty/missing entirely, so a caller with nothing to
    inject doesn't have to special-case it."""
    if not review:
        return ""
    lines = [
        "The user already ran a compliance review on this site earlier in "
        "the conversation. Treat the following as established context - "
        "answer the follow-up question using it plus your own retrieval "
        "below, and don't contradict a finding here without saying so."
    ]
    site_line = review.get("geography") or ""
    if review.get("constraint_summary"):
        site_line = f"{site_line} - {review['constraint_summary']}" if site_line else review["constraint_summary"]
    if site_line:
        lines.append(f"Site: {site_line}")
    if review.get("document_names"):
        lines.append(f"Document(s) reviewed: {', '.join(review['document_names'])}")

    assessment = review.get("assessment") or {}
    if assessment.get("summary"):
        lines.append(f"Review summary: {_strip_review_citation_markers(assessment['summary'])}")

    issues = assessment.get("issues") or []
    if issues:
        lines.append("Issues the review flagged:")
        for issue in issues:
            topic = issue.get("topic", "")
            body = _strip_review_citation_markers(issue.get("issue", ""))
            change = _strip_review_citation_markers(issue.get("suggested_change", ""))
            lines.append(f"  - [{topic}] {body} (suggested change: {change})")

    checklist = assessment.get("checklist") or []
    if checklist:
        lines.append("Required-content checklist:")
        for item in checklist:
            note = _strip_review_citation_markers(item.get("note", ""))
            lines.append(f"  - {item.get('status', '')}: {item.get('item', '')} - {note}")

    return "\n".join(lines)
