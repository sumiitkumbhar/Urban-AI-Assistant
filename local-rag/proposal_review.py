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
     evidence set (answer.py's own build_context()), then assesses the
     proposal's FULL text against it - not just a truncated first ~2
     pages (added 2026-09-23, per explicit request: "a detailed
     generated report... more context"). Because the account's Groq
     tier caps a single request at ~8000 tokens (see MAX_COMPLETION_TOKENS'
     comment), one document-wide call can't hold the whole proposal - so
     the proposal text is split into ordered, page-respecting chunks
     (_split_proposal_into_chunks()) and each chunk gets its own Groq
     call (CHUNK_REVIEW_SYSTEM_PROMPT) against the SAME evidence set/
     citation numbering, asking for issues and required-content checklist
     status found in that chunk specifically. Results are merged across
     chunks (_merge_issues(), _merge_checklist() - a checklist item only
     ends up "missing" if NO chunk found it "present" anywhere in the
     document, since a single chunk can only see its own excerpt). Before
     the final write-up, one more Groq call (VERIFY_SYSTEM_PROMPT,
     _verify_issues() - added 2026-09-24, applying karpathy/llm-council's
     "have a second model check the first one's work" pattern) cross-
     checks each issue's claim against the SAME cited evidence, and
     annotates it "verified"/"verification_note" in place - a genuine
     second opinion, not a rubber stamp, and scoped to one extra call for
     the whole report rather than one per issue. Then one final, short
     Groq call (SUMMARY_SYSTEM_PROMPT) writes the narrative summary
     paragraph from the merged findings - cheap, because by then the real
     analysis is already done and it only needs to describe it, not
     re-derive it from raw evidence + proposal text.
     Every issue/checklist note is written as real prose with citations
     woven into the sentences themselves ("the site sits within a
     conservation area [5], which places specific design constraints..."
     rather than a citation list bolted on after a terse clause) - added
     2026-09-18 per explicit request: "make it descriptive and more
     detailed... in-text citations". Mirrors answer.py's own "cite
     everything, never invent" system-prompt discipline and its
     _extract_first_json_object() parsing helper throughout.

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

import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from common import load_dotenv_from_repo, DEFAULT_GROQ_MODEL, LOCAL_RAG_DIR

# Shared logger name with service.py ("local-rag") so a schema/repair
# failure logged from here (see _call_json_with_repair()'s own comment)
# lands in the same log stream/config as every other server-side log line,
# rather than needing a second logger config to actually be seen - added
# 2026-09-28 per explicit request to log model/backend/finish_reason/raw
# response length on a structured-output failure, which previously wasn't
# logged anywhere at all (only returned inside the report's own parse_error
# text, which a human has to be reading the report to ever notice).
from answer import (
    build_context, _extract_first_json_object, _setup_backend, _backend_error_message,
)
from orchestrate import orchestrate
from site_context import _describe_constraints, _lpa_reference_to_geography

logger = logging.getLogger("local-rag")

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
    # below (see CHUNK_REVIEW_SYSTEM_PROMPT's "checklist" field) has real
    # evidence to check against, rather than relying on whatever the
    # other topics happened to retrieve. Deliberately always-applies
    # (constraint_key=None): every proposal needs to be checked for
    # required content, regardless of which constraints the site has.
    ("required content and mandatory sections of a planning application, "
     "design and access statement, or supporting documents", None),
]

# Shared context for every prompt/cap below (found the hard way
# 2026-09-18): this repo's Groq org is on a tier capped at ~8000
# tokens/minute per request ("Request too large ... Limit 8000,
# Requested 11845"). Every call this module makes - chunk scan or
# summary - has to stay comfortably under that on its own, AND the
# module has to pace consecutive calls so they don't blow the same
# rolling-minute budget together (see _call_groq_json()'s retry/backoff
# and review_proposal()'s pacing between chunk calls).

# Checklist catalog prompt (added 2026-09-28, "freeze the checklist"
# fix): generates the required-content checklist ONCE per review, before
# any proposal excerpt is scanned - previously CHUNK_REVIEW_SYSTEM_PROMPT
# (now CHUNK_REVIEW_SYSTEM_PROMPT_LEGACY below) asked EVERY chunk call to
# independently invent its own checklist item names from the same
# evidence, so the same real-world requirement could come back "Fire
# safety information" from one excerpt and "Fire safety information
# statement" from another - _merge_checklist()'s pure whitespace/case
# normalization (_norm_key) cannot tell those apart, so they'd fragment
# into two rows (or, worse, two genuinely different requirements that
# happen to start with similar words would silently merge into one).
# This call only needs the evidence + site constraints (never the
# proposal text itself - the checklist is what a proposal like this
# SHOULD contain, which the evidence alone establishes), so it can run
# once, before the chunk loop, at roughly the same cost as one chunk
# call - see _generate_checklist_catalog(). Every chunk call then
# assesses the SAME fixed list (see the new CHUNK_REVIEW_SYSTEM_PROMPT
# below), so merging by stable key (_merge_checklist_by_key()) replaces
# the old fuzzy name-matching entirely, for as long as this call keeps
# succeeding - see review_proposal()'s own fallback-to-legacy comment for
# what happens when it doesn't.
#
# SUPERSEDED 2026-09-28 (same-day follow-up, token-budget fix): this
# prompt asked for the checklist across EVERY applicable topic (up to 9)
# against the FULL merged evidence set (up to MAX_EVIDENCE_CHUNKS=10
# citations, each possibly expanded to sentence-complete boundaries) in
# ONE call, PLUS a 1-2 sentence cited "note" per item - a real production
# run on backend=ollama/deepseek-r1:7b showed exactly why that's too
# much for a local reasoning model sharing one completion budget between
# its own <think> block and the JSON answer: finish_reason='length' on
# both the original call AND its repair attempt (the repair attempt
# resends the SAME oversized prompt, so it hit the identical wall - see
# _call_json_with_repair()'s own updated docstring below). Kept here,
# unused, as the historical record of the single-call design - genuinely
# dead, not a live fallback (see _generate_checklist_catalog()'s own
# docstring for the batched replacement, CHECKLIST_BATCH_SYSTEM_PROMPT
# below).
CHECKLIST_CATALOG_SYSTEM_PROMPT = """You are a UK planning compliance reviewer preparing the \
required-content checklist for a proposal review BEFORE reading the proposal document itself. \
You are given: (1) the site's known constraints (if any), and (2) numbered policy evidence \
extracts from UK planning/building-regulation sources. Build a checklist of specific items \
(named statements, assessments, plans, or sections - e.g. "heritage statement", "flood risk \
assessment", "site location plan") that the evidence indicates a proposal for this site should \
include. Base this ONLY on what the evidence actually says is required for this site's \
circumstances - never a generic assumption about what proposals usually contain. This checklist \
is generated ONCE and then used, unchanged, to assess every excerpt of the proposal document, so \
name each item clearly and give it a short, stable, lowercase-with-hyphens key (e.g. \
"flood-risk-assessment") that a later step can reference - two different items must never share \
a key. Cite the evidence number(s) that establish each item's requirement as part of the note, \
and write a 1-2 sentence note explaining why it's required, with an inline citation like [4] as \
part of the sentence. If the evidence doesn't clearly establish any specific required item, \
return an empty checklist rather than inventing generic ones. Respond with JSON only, no other \
text, no markdown fencing, in this exact shape: {"checklist_catalog": [{"key": \
"short-stable-key", "item": "short name of the required item", "citations": [4], "note": "1-2 \
sentences with an inline [N] citation - why it's required"}]}"""

# Checklist BATCH prompt (2026-09-28, replacing the single-call
# CHECKLIST_CATALOG_SYSTEM_PROMPT above as the LIVE path): the same job -
# name the required-content items a proposal for this site should
# include, from evidence alone - but scoped to a SMALL bounded batch of
# evidence citations (CHECKLIST_BATCH_EVIDENCE_SIZE at a time, see
# _generate_checklist_catalog()) and asking for a MINIMAL schema only:
# id/requirement/source_ids, no explanatory "note" prose.
#
# 2026-09-28 (truncation follow-up, items 4/5): shrunk again after a
# live single-evidence-item batch STILL truncated at 600 tokens
# (evidence_ids=[1], prompt_chars~7913, ~1978 estimated input tokens -
# i.e. the INPUT was small; the OUTPUT budget was the actual bottleneck,
# confirmed by inspecting the raw truncated response - see
# CHECKLIST_DEBUG_LOG_RAW_RESPONSE). Two further cuts: (1) the "topic"
# field is dropped entirely - it was never actually read by the catalog-
# building loop below (only rule_id/requirement/source_refs were), so it
# was pure wasted output budget on every single item; (2) an explicit
# per-item word cap and a per-batch item cap, with a deterministic
# truncated_requirements flag the model sets instead of trying to fit an
# unbounded number of items into a bounded budget - "return fewer items
# plus an honest flag" is a request this budget can actually satisfy;
# "return every item, however many there are" is not.
#
# Two independent, additive fixes to the same root cause (a reasoning
# model's own <think> block competing with the JSON answer for one
# shared completion budget): (1) a smaller prompt needs less budget in
# the first place, and (2) a plainer, extraction-only schema needs less
# OUTPUT once it's actually answering - explanatory prose ("why this
# matters", suggested wording) is exactly the kind of open-ended writing
# that invites a reasoning model to think at length before committing to
# an answer; a bare structured-extraction ask doesn't. Long
# explanations/suggested changes/report prose/risk commentary belong at
# a LATER stage (the per-chunk assessment already writes those, see
# CHUNK_REVIEW_SYSTEM_PROMPT below), never in this one.
CHECKLIST_BATCH_SYSTEM_PROMPT = """You are extracting required-content checklist items for a UK \
planning proposal review, from a SMALL batch of numbered policy evidence extracts (and the \
site's known constraints, if any). This is structured extraction, not analysis or explanation - \
identify only specific named items (statements, assessments, plans, or sections - e.g. "heritage \
statement", "flood risk assessment", "site location plan") that THIS evidence batch establishes \
as required for this site's circumstances. Base this ONLY on what the evidence actually says - \
never a generic assumption about what proposals usually contain - and return an empty items list \
if this batch doesn't clearly establish any specific required item; other batches cover the rest \
of the evidence, so an empty result here is normal and expected, not a failure. Give each item a \
short id (any short stable label, e.g. "TEMP-001" - uniqueness across batches is handled by the \
caller, so it only needs to be unique within your own response), and the requirement itself as a \
SHORT NAMED ITEM, NOT a sentence or paragraph - just what the item is called, 40 words maximum, \
no exceptions - and the evidence number(s) from THIS batch that establish it. Do not write \
explanations, reasoning, suggested changes, topic labels, or any commentary about why an item \
matters - name the item and cite its evidence, nothing else, and write no prose of any kind \
outside the JSON object itself. Return AT MOST {max_items} items for this batch. If the evidence \
genuinely establishes more than {max_items} distinct requirements, return only the {max_items} \
most clearly established ones and set "truncated_requirements" to true - do not try to fit more \
items into fewer words, and do not omit the flag. Respond with JSON only, no other text, no \
markdown fencing, in this exact shape: {{"items": [{{"id": "TEMP-001", "requirement": "short \
name of the required item", "source_ids": [4]}}], "truncated_requirements": false}}"""



# Per-chunk prompt (added 2026-09-23, replacing the old single-shot
# REVIEW_SYSTEM_PROMPT below it; rewritten 2026-09-28 to assess a FIXED,
# already-generated checklist - see CHECKLIST_CATALOG_SYSTEM_PROMPT above
# and review_proposal()'s own comment - instead of inventing checklist
# item names itself): asks for issues found in ONE excerpt of a larger
# proposal document, plus a status for every item in the fixed checklist,
# not a summary - the summary is written once, cheaply, from the merged
# results (see SUMMARY_SYSTEM_PROMPT) instead of being redundantly
# attempted on every excerpt. Critically, a checklist item NOT found in
# this excerpt must still come back "missing" here (never omitted) - the
# caller (_merge_checklist_by_key()) is what turns "missing in every
# excerpt that mentioned it" into a real "missing from the whole
# document" vs. "actually present, just in a different excerpt" - a
# single chunk call has no way to know which of those is true on its
# own, so it always reports what IT sees and leaves the merge to decide.
CHUNK_REVIEW_SYSTEM_PROMPT = """You are a UK planning compliance reviewer. You are given: (1) \
the site's known constraints (if any), (2) numbered policy evidence extracts from UK planning/ \
building-regulation sources, (3) a FIXED CHECKLIST of required items already established for \
this review (do not add, remove, rename, or re-key any item - only report what THIS excerpt \
shows for each one), and (4) ONE EXCERPT of a larger proposal document submitted for that site - \
other excerpts of the same document are being reviewed separately by other calls and merged \
with this one afterward, so judge only what THIS excerpt itself shows. \
Do two things, weaving citations directly into your prose as square-bracketed numbers, e.g. \
"the site sits within a conservation area [5], which places specific design constraints on roof \
profiles [6]." \
First, identify specific issues visible in this excerpt: anything it does not address, appears \
to conflict with, or should state more clearly given the applicable policy or constraint. For \
each issue, write a fuller explanation of 2-4 sentences (not a single clause): state the \
specific policy or constraint requirement and cite it inline as part of the sentence, explain \
why it matters for this site, and describe what is actually missing or unclear in this excerpt. \
An issue's "topic" is a SHORT, ORDINARY-ENGLISH PHRASE describing what the issue is about (e.g. \
"Fire safety information", "Parking provision") - it is completely separate from the fixed \
checklist's "key" values below and must NEVER be one of those keys or any other computer-style \
hyphenated identifier; write it exactly as you would say it aloud, never as "fire-safety-info" \
or similar. \
Second, for EVERY item in the fixed checklist (using its exact "key"), report "present" if THIS \
EXCERPT clearly includes it, "missing" if this excerpt does not contain it, or "unclear" if this \
excerpt is ambiguous or only partially covers it - always report your best reading of what THIS \
excerpt shows, even if you suspect it might appear elsewhere in the document, since the caller \
merges findings across every excerpt afterward. You must return exactly one status entry per \
checklist key, every time, with no keys skipped and no new keys invented. \
Rules that apply throughout: cite evidence using its number in square brackets as part of the \
sentence wherever a claim depends on it, not only in a trailing list - never invent a citation, \
policy number, or page, and never cite evidence that doesn't actually support the point. Also \
still return the citation numbers you used for each issue as a separate numeric array (for \
cross-referencing), even though the same numbers already appear inline in your prose. If there \
isn't enough evidence to assess a topic or establish a requirement, say so plainly rather than \
guessing - and if this excerpt is clearly just a cover page, table of contents, or similar with \
nothing substantive to assess, it's fine to return an empty issues array (but you must still \
return a status - "unclear" is fine - for every checklist key). \
Respond with JSON only, no other text, no markdown fencing, in this exact shape: \
{"issues": [{"topic": "short topic label", "issue": "a 2-4 sentence explanation with inline [N] \
citations woven into the prose", "citations": [1, 3], "suggested_change": "a specific, \
actionable change"}], "item_status": [{"key": "<one of the given checklist keys, exactly>", \
"status": "present"|"missing"|"unclear", "citations": [4], "note": "1-2 sentences with an \
inline [N] citation - what THIS excerpt shows, and if missing or unclear, what to add"}]}"""

# Legacy per-chunk prompt (this WAS CHUNK_REVIEW_SYSTEM_PROMPT until
# 2026-09-28). NO LONGER CALLED from review_proposal() as of the same-day
# follow-up fix: this used to be a silent fallback for when
# _generate_checklist_catalog() failed even after a repair retry, but a
# live report showed exactly why that's unsafe - an unfrozen, per-chunk-
# invented checklist is not reproducible run to run, so review_proposal()
# now hard-fails the whole review instead of dropping into this path (see
# its own comment at the catalog-generation call site). Left here,
# genuinely dead, rather than deleted: it's the historical record of how
# the pre-freeze checklist worked, and _merge_checklist() below still
# documents the fuzzy-matching problem freezing was built to solve.
CHUNK_REVIEW_SYSTEM_PROMPT_LEGACY = """You are a UK planning compliance reviewer. You are given: (1) \
the site's known constraints (if any), (2) numbered policy evidence extracts from UK planning/ \
building-regulation sources, and (3) ONE EXCERPT of a larger proposal document submitted for \
that site - other excerpts of the same document are being reviewed separately by other calls \
and merged with this one afterward, so judge only what THIS excerpt itself shows. \
Do two things, weaving citations directly into your prose as square-bracketed numbers, e.g. \
"the site sits within a conservation area [5], which places specific design constraints on roof \
profiles [6]." \
First, identify specific issues visible in this excerpt: anything it does not address, appears \
to conflict with, or should state more clearly given the applicable policy or constraint. For \
each issue, write a fuller explanation of 2-4 sentences (not a single clause): state the \
specific policy or constraint requirement and cite it inline as part of the sentence, explain \
why it matters for this site, and describe what is actually missing or unclear in this excerpt. \
Second, build a checklist of specific items (named statements, assessments, plans, or sections \
- e.g. "heritage statement", "flood risk assessment", "site location plan") that the evidence \
indicates a proposal like this should include. Base this ONLY on what the evidence actually says \
is required for this site's circumstances - never a generic assumption about what proposals \
usually contain. For each checklist item, mark it "present" if THIS EXCERPT clearly includes it, \
"missing" if this excerpt does not contain it, or "unclear" if this excerpt is ambiguous or only \
partially covers it - always report your best reading of what THIS excerpt shows, even if you \
suspect it might appear elsewhere in the document, since the caller merges findings across every \
excerpt afterward. Write a note of 1-2 sentences explaining why it's required (with an inline \
citation) and, if missing or unclear in this excerpt, what to add. \
Rules that apply throughout: cite evidence using its number in square brackets as part of the \
sentence wherever a claim depends on it, not only in a trailing list - never invent a citation, \
policy number, or page, and never cite evidence that doesn't actually support the point. Also \
still return the citation numbers you used for each issue/checklist item as a separate numeric \
array (for cross-referencing), even though the same numbers already appear inline in your \
prose. If this excerpt already addresses a topic or checklist item adequately, mark it "present" \
rather than flagging it as an issue. If there isn't enough evidence to assess a topic or \
establish a requirement, say so plainly rather than guessing - and if this excerpt is clearly \
just a cover page, table of contents, or similar with nothing substantive to assess, it's fine \
to return empty issues/checklist arrays rather than inventing findings. \
Respond with JSON only, no other text, no markdown fencing, in this exact shape: \
{"issues": [{"topic": "short topic label", "issue": "a 2-4 sentence explanation with inline [N] \
citations woven into the prose", "citations": [1, 3], "suggested_change": "a specific, \
actionable change"}], "checklist": [{"item": "short name of the required item", "status": \
"present"|"missing"|"unclear", "citations": [4], "note": "1-2 sentences with an inline [N] \
citation - why it's required and, if missing or unclear in this excerpt, what to add"}]}"""

# Final synthesis prompt (added 2026-09-23): runs once per report, after
# every chunk has been scanned and merged, so it's cheap - no raw evidence
# or proposal text in its input at all, just the already-merged issues/
# checklist (compact JSON), which is far smaller than either. Explicitly
# told to reuse only citation numbers that already appear in that input,
# never invent new ones, since this call never sees the evidence table
# itself to check a number against.
SUMMARY_SYSTEM_PROMPT = """You are a UK planning compliance reviewer. You have already completed \
a full assessment of a proposal document against site constraints and policy evidence; you are \
given the site's constraints (if any) and the already-finalized list of issues and required- \
content checklist results from that assessment, as JSON. Write a "summary": a real narrative \
paragraph of 3-5 sentences - not a one-line blurb - that reads like the opening of an advisory \
letter: describe the site and its constraints, characterize what the proposal covers, and \
preview the main concerns, weaving citations directly into the sentences themselves in square \
brackets, e.g. "the site sits within a conservation area [5], which places specific design \
constraints on roof profiles [6]." Every factual claim needs an inline citation like that, as \
part of the sentence, not listed separately afterward - and every citation number you use MUST \
already appear somewhere in the issues/checklist JSON you were given; never invent a new number. \
Respond with JSON only, no other text, no markdown fencing, in this exact shape: \
{"summary": "a 3-5 sentence narrative with inline [N] citations woven into the prose"}"""

# Second-opinion verification prompt (added 2026-09-24, per explicit
# request to apply karpathy/llm-council's "have another model check the
# first one's work" pattern here - see _verify_issues()). Runs ONCE per
# report, not once per issue, against the SAME evidence context the chunk
# calls already built (reused verbatim - same numbering) - deliberately
# does NOT re-examine the proposal text at all: the first reviewer already
# established what the proposal does/doesn't say, so this pass only asks
# a narrower question - "does the CITED evidence actually back this
# specific claim, or is it being over-read/misapplied" - which is both
# cheaper (no proposal text in the prompt) and a more honest scope for a
# single extra call to actually get right.
VERIFY_SYSTEM_PROMPT = """You are an independent second reviewer checking another reviewer's UK \
planning compliance findings for accuracy. You are given the same numbered policy evidence \
extracts the first reviewer used, and a list of issues they flagged, each with the evidence \
citation numbers they cited. You are NOT re-reading the proposal document - only checking \
whether each finding's claim actually matches what the CITED evidence itself says. For each \
issue: does evidence [N] actually say what the issue claims it says, and is the citation \
genuinely relevant to the claim (not just topically similar)? Mark "supported": true if the \
evidence backs the claim as stated; false if the evidence doesn't actually say that, is being \
over-read, or the citation is misapplied to a different point than the one it's cited for. Don't \
second-guess whether the underlying policy itself is reasonable, and don't mark something \
unsupported just because you'd have worded it differently - only flag a genuine mismatch between \
the claim and the evidence it cites. Respond with JSON only, no other text, no markdown \
fencing, in this exact shape: {"verifications": [{"topic": "<must exactly match one of the \
given issue topics>", "supported": true|false, "note": "one sentence explaining the mismatch if \
supported is false, otherwise an empty string"}]}"""

# Hard cap on the merged/deduped evidence set, applied AFTER merging across
# every topic - without this, more applicable constraint topics (a site
# with conservation area + Article 4 + flood risk all matched) directly
# inflates evidence size with no ceiling, which is exactly the kind of
# per-topic multiplication that blew the token budget above. Chunks are
# sorted by rerank_score first so the cap keeps the best evidence across
# ALL topics, not just however many happen to fit from the first topics
# processed. Raised 8 -> 10 alongside the 2026-09-23 "more context" rewrite
# below - each chunk call now has its own completion budget instead of
# sharing one with the whole proposal text, so there's a bit more room for
# a richer evidence pool without touching the per-call ceiling.
MAX_EVIDENCE_CHUNKS = 10
# Per-chunk-call completion budget. Lower than the old single-shot
# MAX_COMPLETION_TOKENS (2200) because a chunk call no longer writes a
# summary - all its budget goes to issues/checklist for one excerpt - but
# the document gets MAX_PROPOSAL_CHUNKS of these calls now instead of one,
# so total assessment detail across a full report is well up on before.
# reasoning_effort="low" (below) is what keeps this from repeating the
# empty-content failure a bigger completion budget alone can't fix.
MAX_COMPLETION_TOKENS = 1700
# SUMMARY_SYSTEM_PROMPT's call is short (no evidence/proposal text, just
# the merged findings) and only writes one paragraph, so it needs far less.
SUMMARY_MAX_COMPLETION_TOKENS = 500
# VERIFY_SYSTEM_PROMPT's call includes the full evidence_block again (same
# size as one chunk call's share of it) but a much shorter completion - one
# short verdict per issue, not prose paragraphs - so it needs less than a
# chunk call but more than the summary call.
VERIFY_MAX_COMPLETION_TOKENS = 900
# Caps the verification call's own input size, independent of how many
# issues the report actually found - without this, a document that
# produces an unusually large number of issues (many chunks, many distinct
# findings) could grow this ONE extra call's prompt without bound. Issues
# beyond this cap simply aren't verified (see _verify_issues()'s own
# docstring for what an unverified issue means to a caller) rather than
# growing the call - a best-effort quality layer should degrade by doing
# less, not by risking the same 8000-token ceiling every other call here
# has to respect.
MAX_ISSUES_TO_VERIFY = 8

# --- Checklist batching (2026-09-28, token-budget fix) ------------------
# How many evidence citations go into ONE checklist-generation call - see
# CHECKLIST_BATCH_SYSTEM_PROMPT/_generate_checklist_catalog() above/below.
# Bounded deliberately small: the whole point is that a batch this size,
# with a minimal extraction-only schema, needs far less completion budget
# than the old single call over the FULL evidence set (up to
# MAX_EVIDENCE_CHUNKS=10, plus every applicable topic's worth of
# checklist items, plus a cited note per item) ever did - "prefer several
# small bounded calls over one giant one," not a bigger token budget on
# the same oversized call. 3 keeps a typical MAX_EVIDENCE_CHUNKS=10
# review to 3-4 batch calls, each covering a genuinely small amount of
# source text.
CHECKLIST_BATCH_EVIDENCE_SIZE = 3
# Completion budget for ONE checklist batch call. Deliberately NOT sized
# up defensively the way document_edit.py's MAX_COMPLETION_TOKENS was
# (900 -> 3000, see that constant's own comment) - a bigger number alone
# doesn't fix an architecture that hands a reasoning model too much to
# do in one pass, it just delays when the same failure shows up again on
# a larger document. This is real headroom for a SMALL batch + a MINIMAL
# schema + (for Ollama) reasoning disabled outright (see
# CHECKLIST_STAGE_OLLAMA_THINK below) - if a single-evidence-item batch
# still truncates at this budget, _generate_checklist_catalog() treats
# that as a genuine OUTPUT_TRUNCATED failure for that one item rather
# than retrying at the same size (see _run_checklist_batch()'s own
# docstring).
CHECKLIST_BATCH_MAX_COMPLETION_TOKENS = 600
# Explicit, checklist-stage-ONLY override for Ollama's reasoning-model
# "think" control (deepseek-r1, qwen3, and similar hybrid-reasoning
# models support a top-level "think": false in Ollama's /api/chat to
# skip their internal <think> block entirely - see
# _OllamaChatCompletions.create()'s own think= parameter in answer.py).
# False (not None) specifically for this ONE stage: checklist-item
# extraction is structured classification, not open-ended reasoning, so
# it doesn't need the reasoning pass at all, and skipping it frees the
# WHOLE completion budget above for the actual JSON answer instead of
# splitting it with reasoning tokens nothing downstream ever reads. This
# is deliberately NOT a global model/backend setting - every other Ollama
# call in this module (chunk review, verify, summary) is unaffected,
# still reasons normally, since only _generate_checklist_catalog() reads
# this constant, and only when backend="ollama" (see review_proposal()'s
# own call site) - never sent to Groq (see _call_groq_json()'s think=
# docstring paragraph for why).
CHECKLIST_STAGE_OLLAMA_THINK = False

# Max checklist items ONE batch call may return before it must set
# truncated_requirements=true instead of continuing indefinitely (item 5,
# 2026-09-28 truncation follow-up) - a batch of CHECKLIST_BATCH_EVIDENCE_SIZE
# citations rarely needs more than a handful of named items each, so this
# is generous headroom, not a tight fit.
CHECKLIST_MAX_ITEMS_PER_BATCH = 8

# Item 7 (2026-09-28 truncation follow-up), replacing the previous
# behavior of treating ANY single-evidence-item OUTPUT_TRUNCATED as an
# immediately unrecoverable failure: a live run proved a single-citation
# batch (the smallest possible unit - splitting has nowhere further to
# go) can still truncate at CHECKLIST_BATCH_MAX_COMPLETION_TOKENS (600),
# with a small, ordinary-sized prompt (prompt_chars~7913, ~1978
# estimated input tokens) - i.e. input size was NOT the bottleneck, the
# output budget was. Rung 0 is CHECKLIST_BATCH_MAX_COMPLETION_TOKENS
# itself (already tried once by the time this ladder is consulted - see
# _generate_checklist_catalog()'s _run_with_split()); rungs 1-3 are the
# escalation _generate_checklist_catalog() tries, IN ORDER, stopping the
# moment one succeeds or the failure kind stops being OUTPUT_TRUNCATED
# (more budget cannot fix a parse error or a model/connection error).
# This is deliberately bounded (never an unbounded/global max_tokens
# increase - see the user's own explicit instruction) and deliberately
# NEVER a same-size repeat of the request that just failed - "do not
# recursively retry the same impossible single-item request."
CHECKLIST_SINGLE_ITEM_BUDGET_LADDER = (CHECKLIST_BATCH_MAX_COMPLETION_TOKENS, 1200, 1800, 2400)

# Item 1 (2026-09-28 truncation follow-up): "before changing architecture
# again," inspect what a truncated response actually contains - is the
# budget being spent on reasoning, prose before the JSON, an oversized
# JSON body, or malformed repetition. OFF by default (this is explicitly
# a temporary, development-only diagnostic, not a standing production
# log) - set LOCAL_RAG_CHECKLIST_DEBUG_RAW=1 to enable. When on, logs
# ONLY the model's own raw response (first/last 300 chars, never the
# evidence/document text that produced it) whenever a checklist batch
# call fails to parse. See _log_checklist_raw_diagnostics().
CHECKLIST_DEBUG_LOG_RAW_RESPONSE = os.environ.get("LOCAL_RAG_CHECKLIST_DEBUG_RAW") == "1"

# Item 6 (2026-09-28 truncation follow-up): opt-in Ollama native
# structured-output control (see answer.py's _OllamaChatCompletions.
# create() own format= parameter/docstring) - a JSON Schema the model's
# response is constrained to match, instead of relying only on prompt
# wording ("Respond with JSON only..."). Explicitly NOT assumed to be
# supported by whatever Ollama version is actually installed - this
# session's own sandbox has no way to query that (no reachable Ollama
# instance from here - see the project status doc). Defaulted ON for the
# checklist stage specifically because _checklist_batch_raw_call() below
# confirms support empirically at call time (one automatic retry WITHOUT
# the schema if the server rejects the request with it) rather than
# trusting an assumption - set LOCAL_RAG_CHECKLIST_STRUCTURED_OUTPUT=0 to
# disable outright and skip straight to prompt-only JSON mode.
CHECKLIST_USE_OLLAMA_STRUCTURED_OUTPUT = (
    os.environ.get("LOCAL_RAG_CHECKLIST_STRUCTURED_OUTPUT", "1") != "0"
)
# The JSON Schema itself - deliberately mirrors CHECKLIST_BATCH_SYSTEM_PROMPT's
# own {"items": [...], "truncated_requirements": bool} shape exactly, so
# a model honoring this schema and a model only following the prompt
# text produce the identical wire shape either way.
CHECKLIST_BATCH_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "requirement": {"type": "string"},
                    "source_ids": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["id", "requirement", "source_ids"],
            },
        },
        "truncated_requirements": {"type": "boolean"},
    },
    "required": ["items"],
}

# Item 2 (2026-09-28 truncation follow-up): "checklist catalogue creation
# is primarily structured extraction/normalization/classification - it
# does not need a reasoning-heavy model... make checklist generation
# separately configurable, while leaving the rest of the application's
# model selection unchanged." None (the default) means "use whatever
# model the review is already running under" - completely unchanged
# behavior. Set to a model name already pulled in the user's local Ollama
# (confirm with `ollama list` - this session has no way to inspect or
# choose one on the user's behalf, and never downloads/replaces a model
# without being asked) to run ONLY the checklist stage under a different,
# ideally non-reasoning/instruct model with reliable JSON output, while
# chunk assessment/verify/summary keep using the review's normal model
# untouched (see review_proposal()'s own call site for where this is
# read and applied).
COMPLIANCE_CHECKLIST_MODEL = os.environ.get("COMPLIANCE_CHECKLIST_MODEL") or None

# --- Determinism / reproducibility instrumentation (2026-09-28) ---------
# Phases 1/5/6/8 of the determinism remediation plan: run instrumentation,
# deterministic inference settings, and a failing reproducibility
# baseline BEFORE the fixed rule/checklist catalog (still awaiting
# product approval of the schema - see the project's architecture docs)
# replaces the model-invented catalog this module still generates today.
#
# A fixed seed passed to every model call this module makes, best-effort:
# Groq's OpenAI-compatible API accepts `seed` and documents it as
# best-effort determinism (not a hard guarantee - the underlying serving
# infra can still vary run to run), and Ollama's native /api/chat
# endpoint (see answer.py's _OllamaChatCompletions.create()) honors
# options.seed for local backends/models that support it. Neither
# backend nor every model is guaranteed to actually honor it, so this is
# one layer of several (alongside temperature=0 on every classification
# call below) toward reproducible runs, not a substitute for the 10-run
# regression test that actually proves it (scripts/reproducibility_test.py).
DETERMINISTIC_SEED = 7182026
# Bumped whenever CHECKLIST_CATALOG_SYSTEM_PROMPT/CHUNK_REVIEW_SYSTEM_PROMPT's
# instructions, the checklist JSON shape, or how catalog items are keyed
# changes in a way that could change what "same proposal, same checklist"
# means across two code versions. Placeholder until the real, product-
# approved rule-catalog schema (jurisdiction/topic/source/requirement/
# version - see the pending schema proposal) replaces the model-invented
# catalog this module still generates at review time. Recorded on every
# review result so two runs compared later (by
# scripts/reproducibility_test.py, or by hand) can tell whether a
# divergence is a real regression or just "these ran under two different
# checklist schema versions."
CHECKLIST_SCHEMA_VERSION = "unversioned-model-generated-v2-minimal-id-schema"


def _compute_run_fingerprint(document_texts, backend, model, seed, checklist_schema_version):
    """Content-addressed identity for one review RUN's deterministic
    inputs - distinct from checklist_snapshot_path's own fingerprint
    (that one identifies just the frozen checklist; this one identifies
    the whole run: which document bytes went in, and which backend/
    model/seed/schema version processed them). Two reviews of the "same"
    proposal that come back with two different run_fingerprints were NOT
    run under identical conditions - that's the first thing to check
    before treating any difference in their results as a real
    reproducibility bug rather than an intentional config change
    (different backend, a model override, a checklist schema bump).
    sha256 of the ordered document text hashes + config, truncated to 16
    hex chars - same convention checklist_snapshot_path already uses."""
    doc_hashes = [hashlib.sha256(text.encode("utf-8")).hexdigest() for _, text in document_texts]
    payload = json.dumps({
        "doc_hashes": doc_hashes,
        "backend": backend,
        "model": model,
        "seed": seed,
        "checklist_schema_version": checklist_schema_version,
    }, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

# Proposal text is split into ordered, page-respecting chunks
# (_split_proposal_into_chunks()) instead of being truncated to a single
# flat character cap - added 2026-09-23, per explicit request: "a detailed
# generated report... more context" (the old MAX_PROPOSAL_CHARS = 5000 cap
# only ever assessed roughly the first two pages of anything longer).
# PROPOSAL_CHUNK_CHARS keeps each individual chunk call's proposal-text
# share small enough, alongside the shared evidence context and prompt, to
# stay well under the same ~8000-token request ceiling the old cap was
# protecting. MAX_PROPOSAL_CHUNKS bounds the worst case (a very long
# document) to a fixed number of sequential Groq calls rather than
# open-ended - a document longer than PROPOSAL_CHUNK_CHARS *
# MAX_PROPOSAL_CHUNKS characters still has its tail dropped, exactly like
# the old flat truncation did, just several times further into the
# document (reported the same way, via "proposal_truncated").
PROPOSAL_CHUNK_CHARS = 6000
MAX_PROPOSAL_CHUNKS = 5

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
    error_or_None, site_detection_or_None, site_resolution_note_or_None).
    error is set ONLY for genuinely invalid input the caller gave explicitly
    (a project_id that doesn't exist, a postcode that doesn't geocode) -
    review_proposal() treats a non-None error as fatal (see its own `if
    error:` check, right after calling this). site_resolution_note is the
    non-fatal counterpart: set only when nothing was given AND nothing could
    be inferred from the document either, so the review continues with no
    site-specific constraints instead of hard-failing (2026-09-28 - see this
    function's own final branch for the reasoning). Mirrors
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
            return None, None, f"No project with id {project_id}.", None, None
        return project.get("constraints"), project.get("geography"), None, None, None

    from gis_lookup import geocode_postcode, site_constraints

    site_detection = None
    if lat is not None and lon is not None:
        point = (lat, lon)
    elif postcode:
        point = geocode_postcode(postcode)
        if not point:
            return None, None, f"Postcode {postcode!r} not found.", None, None
    else:
        from site_lookup import detect_site

        site_detection = detect_site(document_texts)
        if not site_detection:
            # 2026-09-28: NOT a hard failure any more (this used to `return
            # None, None, "<message>", None`, which review_proposal() treats
            # as fatal via its own `if error:` check). Explicit request:
            # "missing postcode should not hard-fail the entire compliance
            # review... use postcode = null, site_context = unknown, and
            # continue where possible. Only return 400 for genuinely invalid
            # input." Nothing given AND nothing inferrable from the document
            # is a recoverable "we don't know the site" state, not invalid
            # input - unlike the two branches above (an explicit project_id
            # that doesn't exist, or an explicit postcode that doesn't
            # geocode), which stay fatal since the caller DID give us
            # something and it was wrong. review_proposal() already handles
            # site=None gracefully elsewhere (see `_describe_constraints(site)
            # if site else ([], [])` right after its call to this function) -
            # this just reaches that same safe path instead of a 400.
            return None, None, None, None, (
                "Couldn't auto-detect a postcode or a site name from the uploaded "
                "document(s), and none was provided - this review ran without any "
                "site-specific GIS constraints. Provide a postcode for a "
                "site-specific check."
            )
        point = (site_detection["lat"], site_detection["lon"])

    site = site_constraints(*point)
    lpa = site["local_planning_authority"]
    geography = _lpa_reference_to_geography(lpa["reference"] if lpa else None)
    return site, geography, None, site_detection, None


# --------------------------------------------------------------------------
# Multi-chunk assessment helpers (added 2026-09-23, "more context" rewrite)
# --------------------------------------------------------------------------

# Matches the point right before a "[Page N]" block that extract_proposal_text()
# inserted (always preceded by a blank line when it's not the very first line
# of a document's text - see that function's "\n\n".join(texts)), or right
# before a new "DOCUMENT: name" header that review_proposal() itself inserts
# between multiple uploaded files ("\n\n===\n\nDOCUMENT: ..."). Splitting on
# both means a chunk boundary never falls mid-page AND never merges two
# different uploaded documents' pages into one chunk.
_CHUNK_BOUNDARY_RE = re.compile(r"(?=\n\n\[Page \d+\]\n)|(?=\n\n===\n\nDOCUMENT: )")
_PAGE_MARKER_RE = re.compile(r"\[Page \d+\]")


def _split_proposal_into_chunks(proposal_text, chunk_chars=PROPOSAL_CHUNK_CHARS,
                                 max_chunks=MAX_PROPOSAL_CHUNKS):
    """Groups the proposal's page-marked blocks into ordered chunks of up to
    chunk_chars characters each, never splitting a single page's text across
    two chunks (a page whose own text alone exceeds chunk_chars is kept
    whole anyway - a rare oversized page is a better outcome than silently
    truncating mid-sentence). Caps at max_chunks: a document whose pages
    don't fit in that many chunks has its tail dropped, same as the old
    flat MAX_PROPOSAL_CHARS truncation did, just far further into the
    document (see PROPOSAL_CHUNK_CHARS/MAX_PROPOSAL_CHUNKS's own comment).

    Returns (chunks, truncated, total_pages) where total_pages is the
    number of "[Page N]" markers found in the FULL proposal_text (before
    any truncation), for a caller that wants to report "analyzed N of M
    page-sections" - not currently surfaced further than proposal_truncated,
    but computed up front here since it's nearly free."""
    total_pages = len(_PAGE_MARKER_RE.findall(proposal_text))
    parts = [p for p in _CHUNK_BOUNDARY_RE.split(proposal_text) if p.strip()]
    if not parts:
        return [], False, total_pages

    chunks = []
    current = ""
    for part in parts:
        if current and len(current) + len(part) > chunk_chars:
            chunks.append(current)
            current = part
        else:
            current += part
    if current:
        chunks.append(current)

    truncated = len(chunks) > max_chunks
    chunks = chunks[:max_chunks]
    return chunks, truncated, total_pages


def _norm_key(s):
    """Loose match key for merging model-generated names across separate
    Groq calls (checklist item names, issue topics) - same normalization
    _strip_review_citation_markers() already applies to whitespace, plus
    case-folding, since the model's own phrasing of the same item name can
    vary slightly in case between calls even when it means the same thing."""
    return re.sub(r"\s+", " ", (s or "").strip().lower())


_CHECKLIST_STATUS_RANK = {"present": 2, "unclear": 1, "missing": 0}


def _merge_checklist(chunk_checklists):
    """NO LONGER CALLED from review_proposal() as of the 2026-09-28 hard-fail
    follow-up (see CHUNK_REVIEW_SYSTEM_PROMPT_LEGACY's own comment) - kept
    for the historical record of the fuzzy-matching problem checklist
    freezing (_merge_checklist_by_key()) was built to solve.

    chunk_checklists: one list of {"item","status","citations","note"}
    dicts per proposal chunk (in chunk order). Merges by normalized item
    name, keeping the highest-ranked status found across every chunk that
    named it (present > unclear > missing) - a single chunk marking
    something "missing" only means it didn't see it in ITS excerpt, not
    that it's actually absent from the whole document, so a "present" found
    by any other chunk always wins. Preserves first-seen order so the
    checklist reads top-to-bottom roughly in document order."""
    merged = {}
    order = []
    for items in chunk_checklists:
        for item in items or []:
            key = _norm_key(item.get("item"))
            if not key:
                continue
            if key not in merged:
                merged[key] = dict(item)
                order.append(key)
                continue
            current_rank = _CHECKLIST_STATUS_RANK.get(merged[key].get("status"), 0)
            new_rank = _CHECKLIST_STATUS_RANK.get(item.get("status"), 0)
            if new_rank > current_rank:
                merged[key] = dict(item)
    return [merged[key] for key in order]


def _merge_issues(chunk_issues):
    """chunk_issues: one list of {"topic","issue","citations",
    "suggested_change"} dicts per proposal chunk. Concatenates across
    chunks in order, deduping only near-identical repeats (same normalized
    topic AND the same leading ~120 characters of issue text) - a
    genuinely different observation raised under the same topic label from
    a different part of the document is common and worth keeping, so this
    errs toward keeping a possible duplicate over silently dropping a real,
    distinct finding."""
    merged = []
    seen = set()
    for items in chunk_issues:
        for item in items or []:
            key = (_norm_key(item.get("topic")), _norm_key(item.get("issue"))[:120])
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    return merged


def _slugify_key(text, existing_keys):
    """Turns a model-provided (or item-name-derived) key into a safe,
    unique, lowercase-hyphenated identifier - defensive normalization for
    _generate_checklist_catalog(), since a model can return a key with
    spaces/punctuation/mixed case, or (rarely) the same key twice for two
    different items. A collision gets a numeric suffix rather than
    silently overwriting the first item - two genuinely different
    requirements must never end up sharing one identity."""
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-") or "item"
    candidate = slug
    n = 2
    while candidate in existing_keys:
        candidate = f"{slug}-{n}"
        n += 1
    return candidate


def _call_json_with_repair(client, model, system_prompt, user_content, max_tokens,
                            backend="groq", error_types=(Exception,), repair_label="call",
                            temperature=0.1, think=None):
    """Wraps _call_groq_json() with exactly ONE repair attempt when the
    call itself succeeded but the response couldn't be parsed as JSON -
    added 2026-09-28 after a real production report showed finish_reason
    ='stop' on 2 of 3 failed excerpts: the model finished normally but
    still produced text that didn't parse, which a token-budget
    explanation alone doesn't cover - a second attempt with an explicit,
    narrower instruction is cheap and plausibly fixes exactly that class
    of failure, and is a materially different, additive safeguard from
    _call_groq_json()'s own 429/413 retry (that one retries a FAILED API
    call; this one retries a SUCCESSFUL call that came back malformed).

    Never repairs an actual API failure (call_error set) - retrying a
    genuinely failed call with a different prompt wouldn't address why it
    failed, and _call_groq_json() already has its own retry/backoff for
    the transient cases (429/413) worth retrying.

    Also never appropriate for an OUTPUT_TRUNCATED response (finish_reason
    == "length") - added 2026-09-28 after a live checklist-generation
    failure showed both the original AND (via this exact function) the
    repair attempt truncating identically. Resending the same
    user_content (plus a short "return ONLY the JSON object" instruction)
    doesn't shrink the prompt, so a response that ran out of budget
    mid-JSON hits the exact same wall again - repair only ever helps a
    genuinely MALFORMED-but-complete response (finish_reason == "stop"
    with unparseable text). This function itself doesn't branch on
    finish_reason (existing callers - chunk review, the summary call -
    are unchanged and still repair-retry unconditionally, since neither
    of those showed this failure mode); the checklist-generation stage's
    own _run_checklist_batch() checks finish_reason itself and skips
    calling this function entirely when it's "length", taking a
    different recovery path (splitting the batch smaller) instead.

    Logs every failure (both the original and, if it also fails, the
    repair attempt) via the module logger with model/backend/
    finish_reason/raw response length, so a persistent schema failure is
    diagnosable from server logs rather than only from the report's own
    parse_error text - added per explicit request ("log: model, backend,
    finish_reason, token usage, raw response length, schema error").
    Token usage isn't logged per-call here: neither Groq's nor Ollama's
    OpenAI-compatible client surfaces prompt/completion token counts on
    every SDK version this codebase supports without extra probing, and
    raw response length is the honest, always-available substitute for
    "how much came back" - see the log line below.

    Returns the same (parsed_or_None, raw, finish_reason, error) shape as
    _call_groq_json() - error is None on success (first try or repair),
    otherwise a human-readable string describing why both attempts
    failed."""
    parsed, raw, finish_reason, call_error = _call_groq_json(
        client, model, system_prompt, user_content, max_tokens,
        backend=backend, error_types=error_types, temperature=temperature, think=think,
    )
    if call_error:
        logger.warning(
            f"[{repair_label}] API call failed - backend={backend} model={model} "
            f"error={call_error!r}"
        )
        return None, raw, finish_reason, call_error
    if parsed is not None:
        return parsed, raw, finish_reason, None

    logger.warning(
        f"[{repair_label}] unparseable response - backend={backend} model={model} "
        f"finish_reason={finish_reason!r} raw_len={len(raw)} - retrying once with a "
        "repair prompt"
    )
    repair_content = (
        user_content
        + "\n\n---\n\nYour previous response could not be parsed: it was not a single "
        "valid JSON object matching the required shape. This is a repair attempt - respond "
        "with ONLY the JSON object described in the system prompt above. No markdown code "
        "fences, no explanation before or after it, no text of any kind outside the JSON "
        "object itself."
    )
    parsed2, raw2, finish_reason2, call_error2 = _call_groq_json(
        client, model, system_prompt, repair_content, max_tokens,
        backend=backend, error_types=error_types, temperature=temperature, think=think,
    )
    if call_error2:
        logger.warning(
            f"[{repair_label}] repair attempt's API call also failed - error={call_error2!r}"
        )
        return None, raw2, finish_reason2, (
            f"the model's response could not be parsed, and the repair attempt failed: {call_error2}"
        )
    if parsed2 is not None:
        logger.info(f"[{repair_label}] repair attempt succeeded")
        return parsed2, raw2, finish_reason2, None

    logger.warning(
        f"[{repair_label}] repair attempt also unparseable - backend={backend} model={model} "
        f"finish_reason={finish_reason2!r} raw_len={len(raw2)}"
    )
    return None, raw2, finish_reason2, (
        "the model did not return a parseable result even after a repair attempt "
        f"(finish_reason={finish_reason2!r})"
    )


# Distinct failure kinds for a checklist batch call (2026-09-28, item 8
# of the token-budget fix) - replaces a single generic "unparseable"
# label, which told a reader THAT something failed but not what kind.
# OUTPUT_TRUNCATED (finish_reason == "length" - the real, now-fixed
# recurring cause seen live) needs a completely different recovery
# (split the batch smaller, never repair-retry at the same size) than
# JSON_PARSE_ERROR (finish_reason == "stop" but the text still didn't
# parse - a genuine schema-repair candidate), MODEL_ERROR (the API call
# itself failed - connection refused, model not pulled, etc.), TIMEOUT
# (the call timed out - its own kind rather than folded into MODEL_ERROR,
# since a slow-hardware timeout on an otherwise-working Ollama install
# means something different to a diagnosing human than a hard connection
# failure does), or EMPTY_RESULT (the model returned literally nothing -
# distinct from a legitimate empty items list, which is a normal SUCCESS
# for a batch whose evidence doesn't establish any requirement).
_CHECKLIST_FAILURE_OUTPUT_TRUNCATED = "OUTPUT_TRUNCATED"
_CHECKLIST_FAILURE_JSON_PARSE_ERROR = "JSON_PARSE_ERROR"
_CHECKLIST_FAILURE_MODEL_ERROR = "MODEL_ERROR"
_CHECKLIST_FAILURE_TIMEOUT = "TIMEOUT"
_CHECKLIST_FAILURE_EMPTY_RESULT = "EMPTY_RESULT"


def _log_checklist_raw_diagnostics(label, citations_batch, raw):
    """Dev-only (see CHECKLIST_DEBUG_LOG_RAW_RESPONSE) - item 1 of the
    2026-09-28 truncation follow-up: "before changing architecture again,"
    inspect what a truncated/unparseable response actually contains.
    Logs the MODEL's own raw response head/tail plus two cheap content
    signals - never the evidence/document text that prompted it, only
    the model's own output, which is what's actually in question here.
    Only called when a checklist batch call failed to parse (empty,
    truncated, or malformed), to distinguish whether the completion
    budget went to: reasoning (has_think_block=True), prose before the
    JSON (starts_with_json=False but has_think_block=False), an
    oversized JSON body (starts_with_json=True but still truncated), or
    malformed repetition (visible directly in response_tail)."""
    text = raw or ""
    stripped = text.lstrip()
    looks_like_json = stripped.startswith("{") or stripped.startswith("[")
    has_think_block = "<think" in text.lower()
    logger.info(
        f"checklist batch raw-response diagnostics [{label}] "
        f"evidence_ids={[c['id'] for c in citations_batch]}: "
        f"starts_with_json={looks_like_json} has_think_block={has_think_block} "
        f"response_head={text[:300]!r} response_tail={text[-300:]!r}"
    )


def _format_evidence_batch(citations_batch, constraint_summary):
    """Rebuilds a small evidence_block string for ONE bounded batch of
    citations, reusing each citation's REAL global id/doc/page/text
    (from answer.build_context()'s own citations list) rather than
    renumbering - so a checklist item's source_ids stay valid citation
    numbers against the SAME evidence set the rest of the review (chunk
    assessment, verification) already uses, even though this one stage
    now only ever sees a few of them per call."""
    blocks = [
        f"[{c['id']}] {c['doc']} (page {c['page']}):\n{c['text']}"
        for c in citations_batch
    ]
    evidence_block = "Evidence:\n\n" + "\n\n---\n\n".join(blocks) + "\n\n---\n\n"
    if constraint_summary:
        evidence_block += f"Site constraints: the site is {constraint_summary}.\n\n---\n\n"
    return evidence_block


def _checklist_batch_raw_call(client, model, user_content, backend, error_types, think,
                               max_tokens, citations_batch, label, json_schema=None):
    """One raw CHECKLIST_BATCH_SYSTEM_PROMPT call + full token diagnostics
    (item 5 of the fix, logged for EVERY call, success or failure, not
    only reconstructable after one) + failure-kind classification (item
    8) - shared by both the normal attempt and the one allowed repair
    attempt in _run_checklist_batch() below. Does NOT itself decide
    whether a repair should be attempted - that finish_reason-aware
    branching lives in the caller (item 7: a truncated response must
    never reach a same-size repair here).

    json_schema (item 6, 2026-09-28 truncation follow-up): when set,
    tries the call WITH Ollama's native structured-output "format"
    control first; if the SERVER itself rejects the request because of
    it (an error_types exception - the installed Ollama runtime may not
    support format=<schema>, or may reject this particular shape), that
    is caught HERE and the call is retried exactly once more with
    json_schema=None (falling back to prompt-only JSON mode) - this is
    the "confirm against the actual installed runtime first" behavior:
    empirical, at call time, rather than assumed ahead of time. A
    genuine model/timeout/connection failure on the FALLBACK attempt is
    then treated as an ordinary failure, same as any other call.

    Returns (items_list_or_None, finish_reason, failure_kind_or_None,
    detail_or_None) - items_list is [] (not None) for a genuine,
    successful "this batch's evidence establishes no requirement"
    result; only None signals an actual failure."""
    prompt_chars = len(CHECKLIST_BATCH_SYSTEM_PROMPT) + len(user_content)
    t0 = time.monotonic()
    parsed, raw, finish_reason, call_error = _call_groq_json(
        client, model, CHECKLIST_BATCH_SYSTEM_PROMPT, user_content, max_tokens,
        backend=backend, error_types=error_types, temperature=0.0, think=think,
        json_schema=json_schema,
    )
    if call_error and json_schema is not None:
        logger.warning(
            f"checklist batch [{label}]: structured-output request failed ({call_error}) - "
            "retrying once without json_schema (installed Ollama runtime may not support "
            "format=<schema>, or rejected this schema shape)"
        )
        parsed, raw, finish_reason, call_error = _call_groq_json(
            client, model, CHECKLIST_BATCH_SYSTEM_PROMPT, user_content, max_tokens,
            backend=backend, error_types=error_types, temperature=0.0, think=think,
            json_schema=None,
        )
    elapsed = time.monotonic() - t0
    logger.info(
        f"checklist batch diagnostics [{label}]: "
        f"evidence_ids={[c['id'] for c in citations_batch]} "
        f"prompt_chars={prompt_chars} est_input_tokens={prompt_chars // 4} "
        f"max_output_tokens={max_tokens} think={think} "
        f"json_schema={'yes' if json_schema is not None else 'no'} "
        f"finish_reason={finish_reason!r} response_chars={len(raw or '')} "
        f"parsed={'yes' if parsed is not None else 'no'} "
        f"items_returned={len((parsed or {}).get('items') or []) if parsed else 0} "
        f"elapsed_s={elapsed:.1f}"
    )
    if parsed is not None and parsed.get("truncated_requirements"):
        logger.warning(
            f"checklist batch [{label}]: model reported truncated_requirements=true "
            f"(more than CHECKLIST_MAX_ITEMS_PER_BATCH={CHECKLIST_MAX_ITEMS_PER_BATCH} "
            f"distinct requirements) for evidence_ids={[c['id'] for c in citations_batch]}"
        )
    if call_error:
        kind = (
            _CHECKLIST_FAILURE_TIMEOUT if "timeout" in str(call_error).lower()
            else _CHECKLIST_FAILURE_MODEL_ERROR
        )
        if CHECKLIST_DEBUG_LOG_RAW_RESPONSE:
            _log_checklist_raw_diagnostics(label, citations_batch, raw)
        return None, finish_reason, kind, call_error
    if not (raw or "").strip():
        if CHECKLIST_DEBUG_LOG_RAW_RESPONSE:
            _log_checklist_raw_diagnostics(label, citations_batch, raw)
        return None, finish_reason, _CHECKLIST_FAILURE_EMPTY_RESULT, (
            "the model returned an empty response"
        )
    if finish_reason == "length":
        if CHECKLIST_DEBUG_LOG_RAW_RESPONSE:
            _log_checklist_raw_diagnostics(label, citations_batch, raw)
        return None, finish_reason, _CHECKLIST_FAILURE_OUTPUT_TRUNCATED, (
            f"response truncated at max_output_tokens={max_tokens} before valid JSON completed"
        )
    if parsed is not None and isinstance(parsed.get("items"), list):
        return parsed["items"][:CHECKLIST_MAX_ITEMS_PER_BATCH], finish_reason, None, None
    if CHECKLIST_DEBUG_LOG_RAW_RESPONSE:
        _log_checklist_raw_diagnostics(label, citations_batch, raw)
    return None, finish_reason, _CHECKLIST_FAILURE_JSON_PARSE_ERROR, (
        f"unparseable response (finish_reason={finish_reason!r})"
    )


def _run_checklist_batch(client, model, citations_batch, constraint_summary, backend,
                          error_types, think, max_tokens, json_schema=None):
    """Runs one bounded checklist-generation batch, with the item-7
    recovery split: an OUTPUT_TRUNCATED response is NEVER repair-retried
    at the same size here - the caller (_generate_checklist_catalog())
    is the one that actually splits the batch smaller (or, for a
    single-evidence-item batch that has nowhere smaller to go, escalates
    the completion budget instead - see CHECKLIST_SINGLE_ITEM_BUDGET_LADDER).
    A genuinely malformed-but-complete response (finish_reason != "length")
    gets exactly one ordinary repair attempt inline - this is the
    "reserve schema-repair retries for finish_reason != length" carve-out
    (item 7).

    json_schema: forwarded to _checklist_batch_raw_call() unchanged for
    both the primary and repair attempts (item 6) - see that function's
    own docstring for the structured-output-with-fallback behavior.

    Returns (items_list_or_None, failure_kind_or_None, detail_or_None) -
    same failure-kind/detail shape as _checklist_batch_raw_call()."""
    evidence_block = _format_evidence_batch(citations_batch, constraint_summary)
    items, finish_reason, kind, detail = _checklist_batch_raw_call(
        client, model, evidence_block, backend, error_types, think, max_tokens,
        citations_batch, "primary", json_schema=json_schema,
    )
    if items is not None:
        return items, None, None
    if kind != _CHECKLIST_FAILURE_JSON_PARSE_ERROR:
        # OUTPUT_TRUNCATED / MODEL_ERROR / TIMEOUT / EMPTY_RESULT - none of
        # these get a same-size repair (item 7); the caller decides what
        # to do next (split smaller / escalate budget for OUTPUT_TRUNCATED,
        # just record the failure for everything else).
        return None, kind, detail

    logger.warning(
        f"checklist batch: unparseable response (finish_reason={finish_reason!r}, "
        "not truncated) - retrying once with a repair prompt (item 7's carve-out)"
    )
    repair_content = (
        evidence_block
        + "\n\n---\n\nYour previous response could not be parsed: it was not a single "
        "valid JSON object matching the required shape. This is a repair attempt - respond "
        "with ONLY the JSON object described in the system prompt above. No markdown code "
        "fences, no explanation before or after it, no text of any kind outside the JSON "
        "object itself."
    )
    items2, _finish_reason2, kind2, detail2 = _checklist_batch_raw_call(
        client, model, repair_content, backend, error_types, think, max_tokens,
        citations_batch, "repair", json_schema=json_schema,
    )
    if items2 is not None:
        logger.info("checklist batch: repair attempt succeeded")
        return items2, None, None
    return None, kind2, detail2


def _generate_checklist_catalog(client, model, citations, constraint_summary, backend="groq",
                                 error_types=(Exception,), think=None, json_schema=None):
    """Generates the required-content checklist as several small, bounded
    calls over batches of evidence citations (CHECKLIST_BATCH_EVIDENCE_SIZE
    at a time - see CHECKLIST_BATCH_SYSTEM_PROMPT's own comment for why
    this replaced the old single call over the FULL evidence set), made
    ONCE per review overall (across all its batch calls combined) - not
    once per chunk. "retrieve evidence -> generate checklist per bounded
    group -> validate each small JSON object -> merge deterministically,"
    per the 2026-09-28 token-budget fix this implements, replacing "all
    evidence -> one giant checklist-generation call."

    A batch that truncates (finish_reason == "length") is split in half
    and each half retried, recursively, down to a single evidence
    citation - never repaired at the same size (see _run_checklist_batch()
    's own updated docstring for why a same-size retry doesn't help a
    genuinely-too-large input for the model actually being used).

    2026-09-28 (truncation follow-up, items 3/7): a live run proved
    splitting alone isn't always enough - a SINGLE citation batch still
    truncated at CHECKLIST_BATCH_MAX_COMPLETION_TOKENS (600), with a
    small, ordinary prompt (~1978 estimated input tokens), proving the
    OUTPUT budget was the actual bottleneck, not the input size.
    Splitting has nowhere smaller to go once a batch is down to one
    citation, so that case now escalates the completion budget instead,
    through CHECKLIST_SINGLE_ITEM_BUDGET_LADDER's higher rungs, stopping
    the moment a rung succeeds OR the failure kind stops being
    OUTPUT_TRUNCATED (more budget cannot fix a parse/model/connection
    error) - explicitly bounded, explicitly never a same-size repeat of
    the exact request that just failed ("do not recursively retry the
    same impossible single-item request").

    citations: answer.build_context()'s own citation list (id/doc/page/
    text), NOT a pre-joined evidence_block string - batching needs to
    slice individual citations, and reusing their real ids keeps every
    checklist item's source_ids valid against the SAME citation numbers
    the rest of the review (chunk assessment, verification) already
    cites.

    json_schema: forwarded unchanged to every _run_checklist_batch() call
    this makes (item 6) - see _checklist_batch_raw_call()'s own docstring
    for the structured-output-with-fallback behavior.

    Merging is deterministic: batches run in citations' own (already
    rerank-score-sorted) order, and within a batch, items are kept in
    the order the model returned them - the same evidence set run twice
    under identical deterministic settings (temperature=0, seed, and for
    Ollama think=False - see CHECKLIST_STAGE_OLLAMA_THINK) produces
    batches in the same order with the same content, so _slugify_key()'s
    collision-suffix behavior (first item claims the bare slug, a later
    collision gets '-2', '-3', ...) resolves identically run to run.

    Returns (catalog_list_or_None, error_or_None) - same shape as before
    this fix, so review_proposal()'s call site and its hard-fail-on-None
    behavior (see that function's own comment - "never silently fall
    back to the unstable per-chunk-invented checklist") are unchanged.
    Only returns None when EVERY batch (after its own recursive split-
    and-retry, plus any single-item budget escalation) failed to produce
    even one usable item - a partial result (some batches succeeded,
    some genuinely failed) still returns the items that DID succeed,
    with every failure logged individually (see
    _checklist_batch_raw_call's diagnostics), since a checklist covering
    most of the evidence is more useful than hard-failing the whole
    review over one stubborn batch - the review-level hard-fail stays
    reserved for the case where NO usable checklist could be built at
    all, exactly as before this fix."""
    batches = [
        citations[i:i + CHECKLIST_BATCH_EVIDENCE_SIZE]
        for i in range(0, len(citations), CHECKLIST_BATCH_EVIDENCE_SIZE)
    ]

    def _run_with_split(batch):
        items, kind, detail = _run_checklist_batch(
            client, model, batch, constraint_summary, backend, error_types, think,
            CHECKLIST_BATCH_MAX_COMPLETION_TOKENS, json_schema=json_schema,
        )
        if items is not None:
            return items, []
        if kind != _CHECKLIST_FAILURE_OUTPUT_TRUNCATED:
            return [], [([c["id"] for c in batch], kind, detail)]
        if len(batch) > 1:
            mid = len(batch) // 2
            left_items, left_fail = _run_with_split(batch[:mid])
            right_items, right_fail = _run_with_split(batch[mid:])
            return left_items + right_items, left_fail + right_fail
        # Item 7: a single-evidence-item batch has nowhere smaller to
        # split to. The rung already tried (CHECKLIST_BATCH_MAX_COMPLETION_TOKENS)
        # is CHECKLIST_SINGLE_ITEM_BUDGET_LADDER[0] - try the REMAINING
        # rungs, in order, stopping at the first success or the first
        # non-truncation failure. This never repeats the exact same
        # request at the exact same budget twice.
        last_kind, last_detail = kind, detail
        for budget in CHECKLIST_SINGLE_ITEM_BUDGET_LADDER[1:]:
            items2, kind2, detail2 = _run_checklist_batch(
                client, model, batch, constraint_summary, backend, error_types, think,
                budget, json_schema=json_schema,
            )
            if items2 is not None:
                logger.info(
                    "checklist single-item batch: budget escalation to "
                    f"{budget} tokens succeeded for evidence_ids={[c['id'] for c in batch]}"
                )
                return items2, []
            last_kind, last_detail = kind2, detail2
            if kind2 != _CHECKLIST_FAILURE_OUTPUT_TRUNCATED:
                break
        return [], [([c["id"] for c in batch], last_kind, last_detail)]

    seen_keys = set()
    catalog = []
    failures = []
    for batch in batches:
        items, batch_failures = _run_with_split(batch)
        failures.extend(batch_failures)
        for entry in items:
            requirement = (entry.get("requirement") or "").strip()
            if not requirement:
                continue
            key_source = entry.get("id") or requirement
            key = _slugify_key(key_source, seen_keys)
            seen_keys.add(key)
            catalog.append({
                "key": key,
                "item": requirement,
                "citations": entry.get("source_ids") or [],
                "note": "",
            })

    if failures:
        logger.warning(
            f"checklist catalog: {len(failures)} evidence-batch failure(s) after "
            "split-retry/budget-escalation - "
            + "; ".join(
                f"evidence_ids={ids} kind={kind} detail={detail}"
                for ids, kind, detail in failures
            )
        )

    if not catalog:
        detail = (
            "; ".join(f"{kind}: {detail}" for _ids, kind, detail in failures)
            or "no evidence batches were run"
        )
        return None, f"the model did not return a usable checklist from any evidence batch ({detail})"
    return catalog, None


def _merge_checklist_by_key(catalog, chunk_item_status_lists):
    """catalog: the frozen checklist_catalog (list of {"key","item",
    "citations","note"}) generated ONCE per review by
    _generate_checklist_catalog(). chunk_item_status_lists: one list of
    {"key","status","citations","note"} dicts per successfully-assessed
    proposal chunk, keyed against that SAME catalog - unlike the legacy
    _merge_checklist() below (fuzzy name matching across independently-
    invented per-chunk lists), every chunk here is reporting a status for
    the SAME fixed set of keys, so merging is exact dict lookup, not text
    similarity - this is what actually gives a checklist item a stable
    identity across chunks within one run.

    Keeps the highest-ranked status seen for each key (present > unclear
    > missing), same reasoning as _CHECKLIST_STATUS_RANK/_merge_checklist.
    A key no successful chunk reported a status for (should not happen
    when the model follows CHUNK_REVIEW_SYSTEM_PROMPT's "one status entry
    per key, always" instruction, but models don't always follow
    instructions) defaults to "unclear", not "missing" - silence is not
    evidence of absence when we don't actually know why it's silent."""
    best = {}
    for statuses in chunk_item_status_lists:
        for entry in statuses or []:
            key = entry.get("key")
            if not key:
                continue
            rank = _CHECKLIST_STATUS_RANK.get(entry.get("status"), 0)
            if key not in best or rank > _CHECKLIST_STATUS_RANK.get(best[key].get("status"), -1):
                best[key] = entry
    merged = []
    for cat_item in catalog:
        key = cat_item.get("key")
        hit = best.get(key)
        if hit:
            merged.append({
                "key": key,
                "item": cat_item.get("item", ""),
                "status": hit.get("status") or "unclear",
                "citations": hit.get("citations") or cat_item.get("citations") or [],
                "note": hit.get("note") or cat_item.get("note") or "",
            })
        else:
            merged.append({
                "key": key,
                "item": cat_item.get("item", ""),
                "status": "unclear",
                "citations": cat_item.get("citations") or [],
                "note": "No excerpt reported a status for this item.",
            })
    return merged


def _humanize_topic_if_key(topic, catalog_by_key):
    """Defensive guard against a real regression found 2026-09-28 (live
    report: issue headings rendered as raw slugs like
    "fire-safety-information-required" instead of prose, which also broke
    report_render.py's _topic_icon_svg() keyword matching since that
    function matches against real words, not slugs). With the frozen
    checklist catalog now visible to the chunk call as a list of
    {"key","item"} objects, the model sometimes echoes a catalog KEY into
    an issue's "topic" field instead of writing the natural-language
    label CHUNK_REVIEW_SYSTEM_PROMPT actually asks for. Rather than trust
    prompt wording alone to prevent this - this codebase's own standing
    rule, see review_proposal()'s "never trust the LLM's own restraint"
    comment on the empty-evidence guard - this is enforced in code: any
    topic that IS a catalog key, or slugifies to one, is swapped for that
    catalog entry's human-readable "item" name instead."""
    if not topic:
        return topic
    if topic in catalog_by_key:
        return catalog_by_key[topic]["item"]
    slug = _slugify_key(topic, set())
    if slug in catalog_by_key:
        return catalog_by_key[slug]["item"]
    return topic


def _retry_after_seconds(error):
    """Best-effort read of a 429/413 APIStatusError's Retry-After (or
    x-ratelimit-reset-*) response header, so a rate-limited call waits
    exactly as long as Groq says rather than a guessed fixed delay. Returns
    None (caller falls back to a fixed default) if the error has no
    response/headers, the header is missing, or it's not a plain number -
    older groq SDK versions and non-HTTP errors are all covered by this
    just returning None rather than raising."""
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None) if response is not None else None
    if not headers:
        return None
    for header_name in ("retry-after", "x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"):
        value = headers.get(header_name)
        if not value:
            continue
        try:
            return max(0.0, float(str(value).rstrip("s")))
        except ValueError:
            continue
    return None


def _call_groq_json(client, model, system_prompt, user_content, max_tokens,
                     backend="groq", error_types=(Exception,), max_retries=1,
                     temperature=0.1, seed=DETERMINISTIC_SEED, think=None,
                     json_schema=None):
    """Shared model call + JSON-parse path for every call this module makes
    (chunk scans, the final summary) - factored out of what used to be
    review_proposal()'s own inline _call_groq() closure so multiple call
    sites (now one per proposal chunk, plus one for the summary) share the
    exact same reasoning_effort/rate-limit/parsing handling instead of
    drifting apart. Despite the name (kept for now - this is still the
    Groq-shaped JSON-mode call path, just no longer Groq-only), works for
    either backend as of 2026-09-25: backend/error_types come from
    answer._setup_backend(), the same helper document_edit.py's model
    calls already use for the Ollama migration - error_types is whatever
    exception type that backend's client actually raises (APIStatusError
    for Groq, requests.exceptions.RequestException for Ollama), so the
    retry/backoff logic below only ever catches real transport/API
    failures for the backend actually in use, never accidentally the
    other one's exception type.

    Returns (parsed_dict_or_None, raw_text, finish_reason, error_or_None).
    error is a short human-readable string on a real failure (API error
    after retries exhausted, or an unparseable response) - the caller
    decides what a failure means for its own piece of the report (skip a
    chunk vs. fail the summary) rather than this function deciding for
    everyone.

    Retries ONCE on a 429/413 APIStatusError (Groq's "token-per-minute
    rate limit" failure mode - see MAX_COMPLETION_TOKENS' comment - now
    more likely to be hit mid-report since a report can make several of
    these calls in a row) - sleeps for the error's own Retry-After header
    when present (_retry_after_seconds()), else a fixed fallback, then
    tries exactly once more before giving up and reporting the failure to
    the caller. Ollama errors (connection refused, model not pulled, a
    slow-hardware timeout) have no status_code/Retry-After to read, so
    _retry_after_seconds() harmlessly returns None and the retry check
    below (status in (429, 413)) is simply never true for them - they
    fail straight through to the caller after one attempt, which is
    correct: unlike Groq's shared-account rate limit, retrying a genuinely
    unreachable local Ollama server on a fixed delay wouldn't help.

    think (2026-09-28, checklist-batch token-budget fix): None (the
    default, unchanged behavior for every existing caller) omits the
    field entirely. Explicit True/False is forwarded as a top-level
    "think" flag - the Ollama /api/chat control for hybrid-reasoning
    models (deepseek-r1, qwen3, etc.) to skip their internal <think>
    block entirely, freeing the WHOLE completion budget for the actual
    answer instead of splitting it with reasoning tokens a caller never
    reads anyway for structured extraction. Only ever set by a caller
    that already knows it's talking to Ollama (see
    _generate_checklist_catalog()) - never sent to Groq's real API,
    which doesn't have this field and might not silently ignore an
    unrecognized one the way a permissive HTTP endpoint would.

    json_schema (2026-09-28, truncation follow-up, item 6): None (the
    default) omits the field entirely - unchanged behavior for every
    existing caller. Otherwise forwarded as a top-level "format" field -
    Ollama's native structured-output control (see
    _OllamaChatCompletions.create()'s own format= docstring in
    answer.py). Like think=, only ever set by a caller that already
    knows it's talking to Ollama; this function does not itself check
    backend before including it in kwargs - the caller's own gating is
    what keeps it away from Groq."""
    kwargs = dict(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
    )
    # Best-effort determinism (see DETERMINISTIC_SEED's own comment) -
    # omitted entirely when a caller explicitly passes seed=None, so
    # this stays opt-out-able rather than forced on every possible
    # future caller of this shared helper.
    if seed is not None:
        kwargs["seed"] = seed
    if think is not None:
        kwargs["think"] = think
    if json_schema is not None:
        kwargs["format"] = json_schema

    def _do_call():
        # Two independent optional extras stacked onto the base kwargs -
        # reasoning_effort (Groq-only, a real accepted param on Groq's
        # client) and think (Ollama-only, added directly to our own
        # _OllamaChatCompletions.create() signature in answer.py - see
        # think's own docstring paragraph above). Neither backend's
        # client accepts the OTHER one's extra, so this tries with both,
        # falls back to whichever the actual client accepts, and only
        # ever drops down to the bare kwargs (no reasoning_effort, no
        # think) if both extras are unsupported - never raises TypeError
        # up to the caller.
        try:
            return client.chat.completions.create(reasoning_effort="low", **kwargs)
        except TypeError:
            pass
        try:
            return client.chat.completions.create(**kwargs)
        except TypeError:
            return client.chat.completions.create(
                **{k: v for k, v in kwargs.items() if k != "think"}
            )

    completion = None
    api_error = None
    for attempt in range(max_retries + 1):
        try:
            completion = _do_call()
            api_error = None
            break
        except error_types as e:
            api_error = e
            status = getattr(e, "status_code", None)
            if attempt < max_retries and status in (429, 413):
                wait = _retry_after_seconds(e)
                time.sleep(wait if wait is not None else 15)
                continue
            break

    if api_error is not None:
        return None, "", None, _backend_error_message(backend, api_error)

    raw = completion.choices[0].message.content or ""
    finish_reason = completion.choices[0].finish_reason
    json_text = _extract_first_json_object(raw)
    if not json_text:
        return None, raw, finish_reason, None
    try:
        return json.loads(json_text), raw, finish_reason, None
    except Exception:
        return None, raw, finish_reason, None


def _verify_issues(client, model, evidence_block, issues, backend="groq", error_types=(Exception,)):
    """Second-opinion pass over a report's already-merged issues (added
    2026-09-24 - see VERIFY_SYSTEM_PROMPT's own comment for why this is
    ONE call for the whole report, not one per issue, and why it re-checks
    against the evidence rather than the proposal text). Returns a dict
    keyed by _norm_key(topic) -> {"supported": bool, "note": str} for
    every issue it actually verified - deliberately NOT one entry per
    issue in `issues`: an issue whose key is missing from the result
    (because it was past MAX_ISSUES_TO_VERIFY, or this whole call failed)
    was simply never checked, which the caller must treat as "unknown",
    never silently as "verified true". Best-effort like the summary call:
    returns {} on any failure (a missing API key already got caught much
    earlier in review_proposal, a parse failure or rate-limit exhaustion
    here just means this optional layer didn't run) rather than blocking
    or discarding the real, already-completed issues themselves."""
    if not issues:
        return {}
    to_check = issues[:MAX_ISSUES_TO_VERIFY]
    user_content = (
        evidence_block
        + "Issues flagged by the first reviewer, as JSON - check each one's claim against "
        "the evidence above:\n\n"
        + json.dumps([
            {
                "topic": issue.get("topic"),
                "issue": issue.get("issue"),
                "citations": issue.get("citations"),
            }
            for issue in to_check
        ])
    )
    # temperature=0 (2026-09-28 determinism pass): supported/not-supported
    # is a classification verdict, same reasoning as the chunk-scan call.
    parsed, _raw, _finish_reason, _error = _call_groq_json(
        client, model, VERIFY_SYSTEM_PROMPT, user_content, VERIFY_MAX_COMPLETION_TOKENS,
        backend=backend, error_types=error_types, temperature=0,
    )
    if not parsed:
        return {}
    verdicts = {}
    for v in parsed.get("verifications") or []:
        key = _norm_key(v.get("topic"))
        if not key:
            continue
        verdicts[key] = {
            "supported": bool(v.get("supported", True)),
            "note": v.get("note") or "",
        }
    return verdicts


def review_proposal(document_texts, project_id=None, postcode=None, lat=None, lon=None,
                     backend="groq", model=None, top_k=15, rerank_top_n=6):
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
    logger.info(f"review_proposal: request accepted, {len(document_texts)} document(s), "
                f"project_id={project_id} postcode={postcode!r} backend={backend}")
    site, geography, error, site_detection, site_resolution_note = _resolve_site(
        document_texts, project_id, postcode, lat, lon
    )
    if error:
        logger.info(f"review_proposal: site resolution FAILED (fatal) - {error}")
        return {"error": error}
    logger.info(
        f"review_proposal: site detection complete - "
        f"{'resolved' if site else 'no site-specific constraints'}"
        + (f" ({site_resolution_note})" if site_resolution_note else "")
    )

    phrases, _area_names = _describe_constraints(site) if site else ([], [])
    constraint_summary = " and ".join(phrases) if phrases else None

    topics = _select_topics(site)
    logger.info(f"review_proposal: retrieval starting - {len(topics)} topic(s) to check")

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
    # Per-topic retrieval confidence ("high"/"medium"/"low", from
    # retrieve.assess_coverage() via orchestrate()'s own return) collected
    # here so review_proposal() can report an honest, separate
    # "evidence_confidence" for the WHOLE review (see below, "the weakest
    # link" reasoning) - added 2026-09-28 per explicit request to keep
    # compliance score, assessment coverage, and evidence/grounding
    # confidence as three genuinely separate numbers, never merged into
    # one. Previously this same coverage dict was fetched and immediately
    # discarded (named _coverage) - it wasn't unused because it was
    # useless, just because nothing downstream consumed it yet.
    topic_confidences = []
    for topic in topics:
        query = topic + (f", for a site {constraint_summary}" if constraint_summary else "")
        try:
            chunks, topic_coverage = orchestrate(
                query, top_k=top_k, rerank_top_n=rerank_top_n, geography_filter=geography
            )
        except Exception as e:
            failed_topics.append((topic, str(e)))
            continue
        topic_confidences.append((topic_coverage or {}).get("confidence"))
        for c in chunks:
            key = (c["doc_filename"], c["page"], c["text"][:80])
            if key not in seen:
                seen.add(key)
                all_chunks.append(c)

    # Aggregate to the WEAKEST topic's confidence, not an average or the
    # best one - a compliance conclusion is only as strong as its weakest
    # supporting evidence, and a topic that failed to retrieve at all
    # (failed_topics) is at least as bad as "low" confidence, since it
    # contributed no evidence whatsoever. "unknown" only when there is
    # no retrieval-confidence signal at all to aggregate (e.g. every
    # topic came back with no confidence field for some reason) - never
    # silently treated as "high".
    _CONFIDENCE_RANK = {"high": 2, "medium": 1, "low": 0}
    _valid_confidences = [c for c in topic_confidences if c in _CONFIDENCE_RANK]
    if failed_topics:
        evidence_confidence = "low"
    elif not _valid_confidences:
        evidence_confidence = "unknown"
    else:
        evidence_confidence = min(_valid_confidences, key=lambda c: _CONFIDENCE_RANK[c])

    # Never let the assessment call run with zero evidence - the other
    # real bug found the same day: when every topic's retrieval silently
    # came back empty (same root cause as above, but via the multi-agent
    # path's own internal try/except swallowing the same lock error
    # instead of raising it - "graceful degradation" only prevents a
    # crash, it does not mean the query actually succeeded), the model
    # still produced a confident, specifically-worded compliance report
    # with citation markers [1]-[5] anyway, DESPITE CHUNK_REVIEW_SYSTEM_PROMPT
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
            "evidence_confidence": evidence_confidence,
            "compliance_status": "failed",
            "site_resolution_note": site_resolution_note,
        }

    # Cap AFTER merging (see MAX_EVIDENCE_CHUNKS's own comment above) -
    # best evidence across every topic wins, not just whatever the first
    # few topics happened to contribute.
    all_chunks.sort(key=lambda c: c.get("rerank_score", 0.0), reverse=True)
    all_chunks = all_chunks[:MAX_EVIDENCE_CHUNKS]

    logger.info(
        f"review_proposal: retrieval complete - {len(all_chunks)} evidence chunk(s), "
        f"{len(failed_topics)} topic(s) failed, evidence_confidence={evidence_confidence!r}"
    )
    context, citations = build_context(all_chunks)

    proposal_text = "\n\n===\n\n".join(
        f"DOCUMENT: {name}\n{text}" for name, text in document_texts
    )
    # See _split_proposal_into_chunks()'s own docstring/comment - this is the
    # 2026-09-23 replacement for the old flat MAX_PROPOSAL_CHARS truncation,
    # covering several times more of the document via one Groq call per chunk
    # instead of silently dropping everything past the first ~2 pages.
    proposal_chunks, truncated, total_pages = _split_proposal_into_chunks(proposal_text)

    # 2026-09-25: was a hardcoded GROQ_API_KEY/Groq() check - now goes
    # through the same answer._setup_backend() every other model call in
    # this codebase uses, so a compliance review can run on backend=
    # "ollama" (fully local, zero Groq calls, zero cost) exactly like
    # chat answers and document edits already can. resolved_model is
    # DEFAULT_OLLAMA_MODEL/DEFAULT_GROQ_MODEL unless the caller passed an
    # explicit model= override.
    client, error_types, resolved_model, early_error = _setup_backend(backend, model)
    # Run instrumentation (2026-09-28): identity of what actually produced
    # this result. Recorded on every result from here on, including the
    # early-failure ones below where model/backend are already known -
    # "backend/model identity is currently not stored in the result, even
    # though Cloud and Local use different models" was the explicit gap
    # this closes: two runs must never look comparable in a report/UI
    # while actually coming from different inference stacks.
    run_fingerprint = _compute_run_fingerprint(
        document_texts, backend, resolved_model, DETERMINISTIC_SEED, CHECKLIST_SCHEMA_VERSION,
    )
    if early_error:
        return {
            "error": early_error,
            "geography": geography,
            "site_detection": site_detection,
            "constraint_summary": constraint_summary,
            "topics_checked": topics,
            "topics_failed": [t for t, _ in failed_topics],
            "evidence_citations": citations,
            "evidence_confidence": evidence_confidence,
            "compliance_status": "failed",
        }
    evidence_block = f"Evidence:\n\n{context}\n\n---\n\n"
    if constraint_summary:
        evidence_block += f"Site constraints: the site is {constraint_summary}.\n\n---\n\n"

    # One Groq call per proposal chunk (see CHUNK_REVIEW_SYSTEM_PROMPT's own
    # comment for why this replaces the old single call over a flat-truncated
    # proposal_text) - _call_groq_json() carries over the same "never let a
    # real failure look like an ugly stack trace" handling the old inline
    # _call_groq() had (found the hard way 2026-09-18: an uncaught
    # APIStatusError, e.g. a 413 token-per-minute rate limit, used to crash
    # the whole CLI), plus a retry with backoff since a multi-call report is
    # more likely to run into that limit mid-report than the old one-call
    # version ever was. The short sleep between calls (not before the first)
    # is a heuristic to reduce - not guarantee - how often that happens in
    # the first place; the retry/backoff in _call_groq_json() is the real
    # safety net for when pacing alone isn't enough (e.g. another process or
    # browser tab is spending the same account's budget concurrently).
    # Checklist catalog: generated ONCE per review, not once per chunk -
    # see CHECKLIST_CATALOG_SYSTEM_PROMPT/_generate_checklist_catalog()'s
    # own comments for why (2026-09-28, "freeze the checklist" fix).
    #
    # 2026-09-28 follow-up, per explicit request after a live report showed
    # 18 issues / 24 missing items at "100% assessment coverage" built on a
    # checklist that had silently fallen back to the legacy per-chunk-
    # invented path: "stop falling back to the old per-excerpt checklist...
    # the review should fail gracefully... do not silently switch to an
    # unstable checklist architecture." If the catalog call fails even
    # after _call_json_with_repair()'s own repair retry, this now hard-
    # fails the WHOLE review right here - no chunk is assessed, no score
    # is ever computed - rather than falling back to
    # CHUNK_REVIEW_SYSTEM_PROMPT_LEGACY/_merge_checklist() (still defined
    # below, but no longer called from anywhere: kept only as a documented,
    # dead reference for how the old per-chunk-invented path used to work,
    # not as a live fallback).
    logger.info("review_proposal: checklist catalog stage starting")
    # think=CHECKLIST_STAGE_OLLAMA_THINK only for backend="ollama" - never
    # sent to Groq (see _call_groq_json()'s think= docstring paragraph).
    # Checklist-generation-specific per explicit instruction: every other
    # Ollama call this module makes (chunk review, verify, summary) still
    # reasons normally, unaffected by this.
    #
    # checklist_model (item 2, 2026-09-28 truncation follow-up):
    # COMPLIANCE_CHECKLIST_MODEL, when set, overrides ONLY this call's
    # model - resolved_model (and everything else in this review: chunk
    # assessment, verify, summary) is completely unaffected. None (the
    # default) means "use resolved_model, exactly as before this fix" -
    # this session cannot inspect which models are actually installed in
    # the user's local Ollama, so no default override is chosen here;
    # it's opt-in only, by the user explicitly setting the env var to a
    # model they've confirmed is pulled locally.
    checklist_model = COMPLIANCE_CHECKLIST_MODEL or resolved_model
    if COMPLIANCE_CHECKLIST_MODEL:
        logger.info(
            f"review_proposal: checklist stage using COMPLIANCE_CHECKLIST_MODEL="
            f"{COMPLIANCE_CHECKLIST_MODEL!r} instead of resolved_model={resolved_model!r}"
        )
    catalog, catalog_error = _generate_checklist_catalog(
        client, checklist_model, citations, constraint_summary, backend=backend,
        error_types=error_types,
        think=(CHECKLIST_STAGE_OLLAMA_THINK if backend == "ollama" else None),
        json_schema=(
            CHECKLIST_BATCH_JSON_SCHEMA
            if (backend == "ollama" and CHECKLIST_USE_OLLAMA_STRUCTURED_OUTPUT)
            else None
        ),
    )
    if catalog is None:
        return {
            "error": (
                "Assessment incomplete: checklist generation failed. "
                f"{catalog_error} Falling back to the older, less stable per-excerpt "
                "checklist is disabled, so this review was not run."
            ),
            "geography": geography,
            "site_detection": site_detection,
            "constraint_summary": constraint_summary,
            "topics_checked": topics,
            "topics_failed": [t for t, _ in failed_topics],
            "evidence_citations": citations,
            "proposal_truncated": truncated,
            "evidence_confidence": evidence_confidence,
            "compliance_status": "failed",
            "assessment_failed": True,
            "checklist_frozen": False,
            "model_used": resolved_model,
            "backend_used": backend,
            "checklist_version": CHECKLIST_SCHEMA_VERSION,
            "run_fingerprint": run_fingerprint,
            "site_resolution_note": site_resolution_note,
        }
    checklist_frozen = True
    logger.info(f"review_proposal: checklist frozen ({len(catalog)} item(s)) - "
                f"assessment stage starting, {len(proposal_chunks)} document chunk(s)")
    # Built once, reused by _humanize_topic_if_key() in the chunk loop
    # below - see that function's own docstring for why this exists.
    catalog_by_key = {c["key"]: c for c in catalog}

    # Persist the frozen checklist to disk BEFORE any chunk is assessed
    # (explicit request: "persist the resulting checklist before document
    # assessment begins") - makes the exact checklist a given review ran
    # against inspectable/diffable after the fact (e.g. by
    # scripts/reproducibility_test.py, or by hand across two production
    # runs of the "same" proposal) independent of whatever the report UI
    # shows. Filename is content-addressed (sha256 of the catalog's own
    # key+item pairs) so two runs that froze an IDENTICAL checklist share
    # one file instead of writing a duplicate every time - a checklist
    # that's actually reproducible across runs should produce the same
    # hash, and a divergent hash is itself a signal worth being able to
    # spot by just looking at the directory listing.
    checklist_snapshot_path = None
    try:
        checklist_dir = LOCAL_RAG_DIR / "reports" / "checklists"
        checklist_dir.mkdir(parents=True, exist_ok=True)
        catalog_fingerprint = hashlib.sha256(
            json.dumps(
                [{"key": c["key"], "item": c["item"]} for c in catalog],
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()[:16]
        snapshot_file = checklist_dir / f"{catalog_fingerprint}.json"
        if not snapshot_file.exists():
            snapshot_file.write_text(json.dumps({
                "catalog_fingerprint": catalog_fingerprint,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "checklist_catalog": catalog,
            }, indent=2))
        checklist_snapshot_path = str(snapshot_file)
    except OSError as e:
        # Persistence is a safeguard, not a gate - a disk/permission
        # failure here shouldn't take down a review that otherwise has a
        # perfectly good frozen checklist in memory; just log it.
        logger.warning(f"could not persist checklist snapshot: {e}")

    chunk_issues_lists = []
    chunk_item_status_lists = []
    failed_chunks = []
    for i, chunk_text in enumerate(proposal_chunks):
        if i > 0:
            time.sleep(3)
        # checklist_frozen is always True by this point - the alternative
        # (CHUNK_REVIEW_SYSTEM_PROMPT_LEGACY) returned early above.
        catalog_block = json.dumps([{"key": c["key"], "item": c["item"]} for c in catalog])
        user_content = (
            evidence_block
            + "Fixed checklist for this review (report a status for EVERY key, "
            f"unchanged):\n{catalog_block}\n\n---\n\n"
            + f"Proposal document excerpt:\n\n{chunk_text}"
        )
        system_prompt = CHUNK_REVIEW_SYSTEM_PROMPT
        # _call_json_with_repair() (2026-09-28), not the bare
        # _call_groq_json() this used to call directly: a real production
        # report showed finish_reason='stop' (the model finished cleanly)
        # on 2 of 3 failed excerpts, not just finish_reason='length' - a
        # token-budget explanation alone doesn't cover that, but a repair
        # retry with an explicit "return ONLY the JSON object" instruction
        # plausibly does, and is logged either way for diagnosis.
        # temperature=0 (2026-09-28 determinism pass): this call assigns a
        # PASS/FAIL/UNCLEAR-style status per checklist key and flags
        # issues - a classification decision, not narrative prose, so it
        # gets the same lowest-randomness treatment as the checklist
        # catalog call. SUMMARY_SYSTEM_PROMPT's call deliberately keeps
        # its own default temperature - "AI writes the explanation, code/
        # rules determine the compliance state and score" only holds if
        # the calls that determine state/score are the deterministic ones.
        parsed, _raw, finish_reason, call_error = _call_json_with_repair(
            client, resolved_model, system_prompt, user_content, MAX_COMPLETION_TOKENS,
            backend=backend, error_types=error_types, temperature=0,
            repair_label=f"chunk {i + 1}/{len(proposal_chunks)}",
        )
        if call_error:
            failed_chunks.append(call_error)
            continue
        if parsed is None:
            failed_chunks.append(
                "the model did not return a parseable result for one excerpt of the "
                f"document (finish_reason={finish_reason!r}), even after a repair retry"
            )
            continue
        chunk_issues = parsed.get("issues") or []
        for issue in chunk_issues:
            issue["topic"] = _humanize_topic_if_key(issue.get("topic"), catalog_by_key)
        chunk_issues_lists.append(chunk_issues)
        chunk_item_status_lists.append(parsed.get("item_status") or [])

    if not proposal_chunks:
        failed_chunks = failed_chunks or ["the proposal document had no extractable text to assess"]

    # Assessment coverage (2026-09-28, points 1-2 of the reliability fix):
    # how much of the document was actually, successfully assessed - kept
    # as its own field, entirely separate from the compliance score itself
    # and from evidence_confidence (retrieval quality) above, so none of
    # the three ever gets silently merged into another. total_units is
    # floored at 1 only for the percentage's own arithmetic (division by
    # zero guard) when there were literally no chunks to begin with -
    # assessed_units stays 0 in that case regardless.
    total_units = len(proposal_chunks)
    assessed_units = max(total_units - len(failed_chunks), 0) if total_units else 0
    assessment_coverage = {
        "assessed_units": assessed_units,
        "total_units": total_units,
        "pct": round(100 * assessed_units / total_units) if total_units else 0,
        "complete": total_units > 0 and assessed_units == total_units,
    }

    # Mirrors the old "never let the assessment call run with zero evidence"
    # guard (see the all_chunks check above) at the assessment-output level
    # instead: if every single chunk call failed (or there were no chunks to
    # begin with), there is nothing real to show - report a clear failure
    # rather than an empty-but-confident-looking "no issues found" result.
    if not chunk_issues_lists and not chunk_item_status_lists:
        return {
            "error": (
                "No part of the proposal document could be assessed, so no report was "
                f"generated. Detail: {'; '.join(failed_chunks)}"
            ),
            "geography": geography,
            "site_detection": site_detection,
            "constraint_summary": constraint_summary,
            "topics_checked": topics,
            "topics_failed": [t for t, _ in failed_topics],
            "evidence_citations": citations,
            "proposal_truncated": truncated,
            "assessment_coverage": assessment_coverage,
            "evidence_confidence": evidence_confidence,
            "compliance_status": "failed",
            "assessment_failed": True,
        }

    # A checklist item only ends up "missing" here if NO chunk found it
    # "present" anywhere in the document - see _merge_checklist_by_key()'s
    # (frozen mode) or _merge_checklist()'s (legacy mode) own docstring for
    # why that's the correct merge, not just "last chunk wins" or "first
    # chunk wins".
    issues = _merge_issues(chunk_issues_lists)
    checklist = _merge_checklist_by_key(catalog, chunk_item_status_lists)

    # Second-opinion verification pass (added 2026-09-24, karpathy/llm-
    # council's "have another model check the first one's work" pattern -
    # see VERIFY_SYSTEM_PROMPT/_verify_issues()'s own comments). One more
    # sequential Groq call, same pacing reasoning as the inter-chunk sleep
    # above. Annotates each issue in place with "verified"/
    # "verification_note" when a verdict came back - an issue with neither
    # key was simply never checked (past MAX_ISSUES_TO_VERIFY, or this
    # call failed/timed out), which is a different, weaker claim than
    # "verified": True and must be read that way by every caller
    # (report_render.py, the frontend) - never treat a missing key as a
    # pass.
    if issues:
        time.sleep(3)
        verdicts = _verify_issues(
            client, resolved_model, evidence_block, issues, backend=backend, error_types=error_types,
        )
        for issue in issues:
            verdict = verdicts.get(_norm_key(issue.get("topic")))
            if verdict is None:
                continue
            issue["verified"] = verdict["supported"]
            if not verdict["supported"] and verdict["note"]:
                issue["verification_note"] = verdict["note"]

    # Final synthesis call (SUMMARY_SYSTEM_PROMPT): cheap, since by now the
    # real analysis is done - it only describes the merged issues/checklist,
    # it doesn't re-derive them from raw evidence + proposal text again.
    summary_user_content = ""
    if constraint_summary:
        summary_user_content += f"Site constraints: the site is {constraint_summary}.\n\n---\n\n"
    summary_user_content += (
        "Completed assessment (issues and required-content checklist), as JSON:\n\n"
        + json.dumps({"issues": issues, "checklist": checklist})
    )
    summary_parsed, _raw, _finish_reason, summary_error = _call_groq_json(
        client, resolved_model, SUMMARY_SYSTEM_PROMPT, summary_user_content, SUMMARY_MAX_COMPLETION_TOKENS,
        backend=backend, error_types=error_types,
    )
    summary = (summary_parsed or {}).get("summary") if summary_parsed else None

    # Deliberately NOT assessment_failed=True just because the summary or a
    # handful of chunks failed - issues/checklist are real, verified results
    # from the chunks that DID succeed, and report_render.py hides
    # everything (not just the summary) when assessment_failed is set (see
    # its own "no risk badge, no issues, no checklist" comment) - that would
    # throw away real findings over a partial failure. assessment_failed
    # stays reserved for "nothing usable came back at all" (handled above).
    # compliance_status carries the real distinction the old boolean
    # couldn't: "final" (full coverage - the compliance score/risk badge is
    # safe to treat as a completed answer), "incomplete" (some excerpts
    # failed - real findings are shown, but no definitive score/risk badge
    # should be presented as though the whole document was checked; see
    # report_render.py's own compliance_status handling), or "failed"
    # (nothing usable at all, handled above). This is what makes points 1/2/
    # 5 of the 2026-09-28 reliability fix real: a parser/model failure can
    # now never silently read as "compliant" or "non-compliant" - it reads
    # as "incomplete" or "failed", never as a clean result.
    notes = []
    if failed_chunks:
        notes.append(
            f"{len(failed_chunks)} of {max(len(proposal_chunks), 1)} document excerpt(s) could "
            "not be assessed and were skipped: " + "; ".join(failed_chunks)
        )
    if summary_error or not summary:
        notes.append(
            "The narrative summary could not be generated, but the issues and checklist "
            "below are real, completed results, not a fallback."
        )
    parse_error = " ".join(notes) if notes else None
    # Explicit per the 2026-09-28 follow-up request: "100% assessment
    # coverage is misleading unless BOTH checklist frozen successfully AND
    # all assessment units completed are true." checklist_frozen is always
    # True by the time this line runs (the catalog-failure case returned
    # early, above) - but the condition is spelled out in full rather than
    # collapsed to just assessment_coverage["complete"], so this line stays
    # correct on its own even if a future change reintroduces a path where
    # checklist_frozen can be False here.
    compliance_status = (
        "final" if (checklist_frozen and assessment_coverage["complete"]) else "incomplete"
    )
    logger.info(f"review_proposal: complete - compliance_status={compliance_status!r} "
                f"issues={len(issues)} checklist_items={len(checklist)}")

    return {
        "geography": geography,
        "site_detection": site_detection,
        "constraint_summary": constraint_summary,
        "topics_checked": topics,
        "topics_failed": [t for t, _ in failed_topics],
        "evidence_citations": citations,
        "assessment": {"summary": summary, "issues": issues, "checklist": checklist},
        "assessment_failed": False,
        "compliance_status": compliance_status,
        "assessment_coverage": assessment_coverage,
        "evidence_confidence": evidence_confidence,
        "checklist_frozen": checklist_frozen,
        "checklist_snapshot_path": checklist_snapshot_path,
        "parse_error": parse_error,
        "proposal_truncated": truncated,
        "proposal_pages_total": total_pages,
        "disclaimer": DISCLAIMER,
        "model_used": resolved_model,
        "backend_used": backend,
        "checklist_version": CHECKLIST_SCHEMA_VERSION,
        "run_fingerprint": run_fingerprint,
        "site_resolution_note": site_resolution_note,
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
