"""Answer generation from retrieved chunks, via Groq (cloud) - reusing
the same GROQ_API_KEY already configured for the live Next.js app's
.env.local. Retrieval and storage are local/offline per the README's
"hybrid local/cloud models" recommendation (section 6.2): local
retrieval -> local reranker -> cloud frontier model. Swapping this one
function for a local Ollama call later is a contained change if you
decide you want the answer step offline too - nothing else in this
folder needs to change for that.
"""

import json
import os
import re
from types import SimpleNamespace

import requests
from groq import Groq, APIStatusError

import hallucination_check
from common import load_dotenv_from_repo, DEFAULT_GROQ_MODEL, OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL
from retrieve import get_complete_citation_text

SYSTEM_PROMPT = """You are a UK planning and building-regulations assistant. \
Answer ONLY using the numbered evidence extracts provided below - never from \
general knowledge, and never invent a citation, policy number, or page. \
Cite every claim inline using its evidence number in square brackets, e.g. [1]. \
If a CURRENT PROJECT STATE block is provided above the evidence, you may state \
facts directly from it - site details, matched constraints, stage, open \
questions - without a [N] citation, since those come from an authoritative \
site/GIS record rather than the evidence extracts; still cite the evidence \
extracts for everything else, especially policy interpretation. \
If neither the project state nor the evidence contains enough to answer, say \
so plainly instead of guessing. \
Keep the answer concise and direct."""

# Self-RAG-style claim verification/repair pass (architecture plan section
# 17/52) - only run when retrieve()'s Corrective-RAG confidence check
# comes back medium/low (section 10's "use extra verification only for
# genuinely difficult/low-confidence cases" principle), so the normal
# high-confidence path stays a single Groq call. This checks the drafted
# answer's claims against the same evidence, and repairs (not rewrites)
# anything unsupported - it must not add new claims of its own.
VERIFY_PROMPT = """You are checking a drafted answer against its numbered evidence \
extracts for a UK planning/building-regulations assistant. For each claim in the \
answer, confirm it is directly supported by the evidence it cites. If every claim \
is supported, return the answer completely unchanged. If a claim is NOT supported \
by its cited evidence, rewrite ONLY that claim/sentence - either remove the \
unsupported part or explicitly flag it as not confirmed by the retrieved evidence \
- and leave every other sentence untouched. Never add a new claim, citation, or \
piece of information that wasn't in the drafted answer. Return only the corrected \
answer text, nothing else - no preamble, no explanation of what you changed."""


# Found the hard way 2026-09-22 (same class of bug already fixed for
# proposal_review.py on 2026-09-18): this repo's Groq org is capped at
# 8000 tokens/minute per request ("Request too large ... Limit 8000,
# Requested 10853" on a perfectly ordinary broad question). Unlike
# proposal_review.py's fixed MAX_EVIDENCE_CHUNKS, a chunk count alone
# isn't a safe proxy for size here: get_complete_citation_text()
# (retrieve.py) expands every citation toward sentence-complete
# boundaries, up to its own MAX_EXPANSION_CHARS=6000 per side - the
# right fix for citation accuracy, but it means a handful of already-
# expanded citations can now blow the token budget in a way small
# fixed-size chunks never could. Capped by TOTAL CONTEXT SIZE instead,
# and by DROPPING whichever chunks don't fit rather than truncating the
# joined string - a citation the model sees is either complete, with a
# real evidence block behind it, or entirely absent; never a dangling
# "[N]" marker with half its evidence text cut off. At a conservative
# ~3.5 chars/token, 16000 chars is ~4500 tokens - comfortable headroom
# under 8000 alongside the system prompt, question, and completion
# budget below.
MAX_CONTEXT_CHARS = 16000

# Read timeout for a local Ollama call. Deliberately generous compared to
# Groq's cloud latency: a 7B-class model on ordinary consumer hardware
# (CPU, or a modest GPU) can genuinely take a couple of minutes for a
# long answer, especially the first call after the model has to load
# into memory - a short timeout here would misreport "Ollama isn't
# running" for what's actually just a slow local machine. The connect
# timeout stays short (a few seconds) since a closed port fails
# instantly either way.
OLLAMA_TIMEOUT_SECONDS = (5, 180)


class _OllamaResponse:
    """Shim matching the one shape every caller in this file reads off a
    Groq chat-completion response - resp.choices[0].message.content -
    so _verify_and_repair()/_check_groundedness()/generate_answer() can
    call client.chat.completions.create(...) without caring whether the
    actual backend is Groq's SDK object or this plain wrapper around a
    local Ollama HTTP call."""

    def __init__(self, content, finish_reason="stop"):
        # finish_reason: mirrors Groq's convention ("stop"/"length"/...)
        # from Ollama's own done_reason field (see _OllamaChatCompletions
        # .create() below) - added 2026-09-25 after proposal_review.py's
        # _call_groq_json() (shared by the Groq and Ollama paths) crashed
        # with AttributeError reading completion.choices[0].finish_reason
        # on this shim, which previously left the attribute out entirely
        # since no caller in THIS file happened to read it.
        self.choices = [
            SimpleNamespace(
                message=SimpleNamespace(content=content),
                finish_reason=finish_reason,
            )
        ]


class _OllamaStreamChunk:
    """Shim matching the one shape stream_answer() reads off a Groq
    streaming chunk - chunk.choices[0].delta.content."""

    def __init__(self, delta_text):
        self.choices = [SimpleNamespace(delta=SimpleNamespace(content=delta_text))]


class _OllamaChatCompletions:
    """Just enough of the groq/openai `.chat.completions.create(...)`
    surface for this file's own call sites to work unchanged against a
    local Ollama instance - not a general-purpose client. Talks to
    Ollama's native /api/chat endpoint (not its OpenAI-compatible one):
    that endpoint streams newline-delimited JSON objects, one per line,
    which is simpler to parse correctly with `requests` than the
    OpenAI-compatible endpoint's SSE "data: {...}" framing, and Ollama
    has supported /api/chat since well before it added OpenAI
    compatibility, so this doesn't depend on a newer Ollama version."""

    def __init__(self, base_url):
        self._base_url = base_url.rstrip("/")

    def create(self, model, messages, temperature=0.1, max_tokens=800, stream=False, seed=None,
               think=None, format=None):
        url = f"{self._base_url}/api/chat"
        # See the num_ctx comment below for why this is computed here,
        # before payload is built, rather than inline in the dict.
        estimated_input_tokens = sum(
            len(str(m.get("content") or "")) for m in messages
        ) // 4
        payload = {
            "model": model,
            "messages": messages,
            "stream": stream,
            # 2026-09-25: added num_ctx. Without it Ollama loads the
            # model with its own default context window (observed via
            # `ollama ps`: 4096 tokens) regardless of what num_predict
            # asks for - that 4096 covers the ENTIRE exchange (system
            # prompt + retrieved evidence + reasoning + JSON answer),
            # not just the output. deepseek-r1 (a reasoning model) writes
            # a <think>...</think> block before answering, so real
            # retrieved evidence in the prompt was leaving too little of
            # that 4096 for reasoning-plus-answer - causing intermittent
            # "model did not return a parseable rewrite" failures that
            # raising document_edit.py's own MAX_COMPLETION_TOKENS alone
            # didn't fix (num_predict can't produce more output than the
            # context window has room for).
            #
            # 2026-09-25 (later same day): the first fix (below,
            # max(8192, max_tokens*4)) only scaled with the OUTPUT budget
            # and silently assumed the INPUT was small - true for a
            # single-paragraph rewrite, false for document_edit.py's
            # find_target_paragraph(), whose prompt lists every
            # paragraph in the document (up to MAX_PARAGRAPHS_IN_LISTING
            # = 200, ~100 chars each). Live-tested against a real 89-
            # paragraph document: that listing alone is already close to
            # 8192 tokens, leaving too little room for deepseek-r1's own
            # <think> reasoning on top - reproduced live as "Could not
            # parse the model's paragraph match." Fixed by actually
            # measuring the request, not just the response: estimate
            # input size from the real messages (a plain chars/4 estimate
            # - rough, but this only needs to be in the right order of
            # magnitude, not exact) and size num_ctx off BOTH ends of the
            # exchange plus real headroom for reasoning, rather than
            # just the output. deepseek-r1:7b's own max is 131072
            # (confirmed via /api/show) so even a generous estimate here
            # is nowhere near its ceiling, and this hardware (M5 Pro /
            # 24GB unified memory) was already running the model at 100%
            # GPU with room to spare.
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
                "num_ctx": max(8192, (estimated_input_tokens + max_tokens) * 2),
            },
        }
        # 2026-09-28: best-effort determinism, matching the Groq-side
        # `seed` param proposal_review.py now sends on every call it
        # makes. Ollama's native /api/chat endpoint reads seed from
        # options.seed (not a top-level field), and only when a caller
        # actually asked for one - omitted entirely otherwise so this
        # never changes behavior for callers that don't pass seed
        # (e.g. document_edit.py's existing calls).
        if seed is not None:
            payload["options"]["seed"] = seed
        # think (2026-09-28, checklist-batch token-budget fix): Ollama's
        # native /api/chat control for hybrid-reasoning models
        # (deepseek-r1, qwen3, and similar) to skip their internal
        # <think>...</think> block entirely - a TOP-LEVEL request field,
        # not nested under "options" like everything else above. None
        # (the default) omits it entirely, so every existing caller of
        # this method is completely unaffected. Explicit False is what
        # proposal_review.py's checklist-generation stage passes (see
        # CHECKLIST_STAGE_OLLAMA_THINK) - structured extraction doesn't
        # need the reasoning pass, and skipping it frees the WHOLE
        # num_predict budget above for the actual JSON answer instead of
        # splitting it with reasoning tokens the caller never reads. A
        # model or Ollama version that doesn't support "think" control
        # should simply ignore an unrecognized field rather than error -
        # if that assumption ever turns out wrong for some real Ollama
        # version, the caller still gets a real response either way,
        # just without the budget savings this is meant to buy.
        if think is not None:
            payload["think"] = think
        # format (2026-09-28, checklist single-evidence-batch truncation
        # follow-up): Ollama's native /api/chat structured-output control
        # - a TOP-LEVEL request field, matching "think"'s placement above,
        # not nested under "options". Accepts either the literal string
        # "json" (loose JSON-mode, already effectively what every caller
        # gets via prompt instructions alone) or a full JSON Schema object
        # (strict structured output - the model's response is constrained
        # to match the schema, supported by Ollama versions recent enough
        # to include this feature; not assumed here to be the version
        # actually installed - see proposal_review.py's
        # CHECKLIST_USE_OLLAMA_STRUCTURED_OUTPUT and
        # _checklist_batch_raw_call()'s own fallback for how a caller
        # confirms this empirically rather than assuming it). None (the
        # default) omits the field entirely, so every existing caller of
        # this method - including every checklist call when structured
        # output is disabled or its own retry-without-schema fallback
        # fires - is completely unaffected. If the installed Ollama
        # doesn't recognize this field, the safest failure mode is it
        # being ignored by a permissive server; if it instead causes an
        # HTTP error, that surfaces to the caller as an ordinary
        # RequestException through resp.raise_for_status() below, which
        # _checklist_batch_raw_call() specifically catches and retries
        # once without a schema - this method itself makes no assumption
        # either way, it just forwards what it was asked to send.
        if format is not None:
            payload["format"] = format
        if not stream:
            resp = requests.post(url, json=payload, timeout=OLLAMA_TIMEOUT_SECONDS)
            resp.raise_for_status()
            data = resp.json()
            content = (data.get("message") or {}).get("content", "")
            finish_reason = data.get("done_reason") or "stop"
            return _OllamaResponse(content, finish_reason=finish_reason)
        return self._stream(url, payload)

    def _stream(self, url, payload):
        resp = requests.post(url, json=payload, stream=True, timeout=OLLAMA_TIMEOUT_SECONDS)
        resp.raise_for_status()
        for line in resp.iter_lines():
            if not line:
                continue
            data = json.loads(line)
            content = (data.get("message") or {}).get("content", "")
            if content:
                yield _OllamaStreamChunk(content)
            if data.get("done"):
                return


class _OllamaClient:
    """Drop-in stand-in for a Groq() client, scoped to exactly the one
    attribute path (`.chat.completions.create`) this file actually
    calls - see _OllamaChatCompletions above."""

    def __init__(self, base_url):
        self.chat = SimpleNamespace(completions=_OllamaChatCompletions(base_url))


def _setup_backend(backend, model):
    """Resolves (client, error_types, model, early_error) for either
    "groq" (default, unchanged behavior) or "ollama" (opt-in, fully
    local - see common.py's OLLAMA_BASE_URL/DEFAULT_OLLAMA_MODEL for the
    background). error_types is the exception tuple generate_answer()/
    stream_answer() should catch around the actual chat-completion call
    and turn into a friendly in-band message instead of a raw traceback
    or a dead connection - APIStatusError for Groq (rate limits, etc.,
    the existing 2026-09-22 fix), requests' RequestException for Ollama
    (connection refused because Ollama isn't running, a model that
    hasn't been pulled, a timeout on slow hardware).

    early_error is set only when the backend can't even be attempted -
    today that's just "groq" with no GROQ_API_KEY configured (the
    existing behavior, unchanged). There's no equivalent up-front check
    for Ollama: unlike an API key, "is Ollama actually reachable" can
    only be answered by trying the call, so that failure surfaces via
    error_types at call time instead, with a message that tells the
    user what to check (see the callers' except blocks)."""
    if backend == "ollama":
        load_dotenv_from_repo()
        base_url = os.environ.get("OLLAMA_BASE_URL", OLLAMA_BASE_URL)
        resolved_model = model or os.environ.get("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL)
        return _OllamaClient(base_url), (requests.exceptions.RequestException,), resolved_model, None

    load_dotenv_from_repo()
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return None, None, None, (
            "GROQ_API_KEY isn't set (checked the repo's .env.local) - retrieval "
            "worked, but I can't call the answer model without it."
        )
    resolved_model = model or DEFAULT_GROQ_MODEL
    return Groq(api_key=api_key), (APIStatusError,), resolved_model, None


def _backend_error_message(backend, error):
    """Human-readable text for whatever error_types (see _setup_backend()
    above) actually caught - kept as its own function since both
    generate_answer() and stream_answer() need the identical message for
    the identical failure."""
    if backend == "ollama":
        return (
            f"Couldn't reach the local Ollama server ({error}). Make sure Ollama is "
            "running (the desktop app starts it automatically, or run `ollama serve`) "
            "and that the model is pulled, e.g. `ollama pull deepseek-r1:7b` - or "
            "whichever model OLLAMA_MODEL in .env.local names."
        )
    return (
        f"The answer call to Groq failed ({error}). If this is a token-per-minute "
        "rate limit, try a narrower question (one policy/document at a time) "
        "or wait a minute and retry."
    )


def build_context(chunks):
    """Numbered evidence blocks the model can cite by index, and the
    parallel citation list the caller returns alongside the answer -
    same shape as the old app's [D1]/[D2] citation markers, just plain
    numbers since there's no separate web-source track here.

    Each citation's text is expanded to sentence-complete evidence by
    default via get_complete_citation_text() - not the raw single-chunk
    c["text"], and not gated behind a "Show more context" click. A
    citation is what both the model and the user read as ground truth
    for a claim; a chunk boundary that happens to land mid-clause (e.g.
    cutting "...unless the local planning authority has confirmed..."
    right before "unless") can flip what the source text actually says,
    and that risk doesn't go away just because most citations are never
    manually expanded. Falls back to the raw chunk text only if
    chunk_id is missing or the lookup fails for some reason - never
    silently drops a citation over this.

    Chunks are consumed best-first (sorted by rerank_score) and cut off
    once MAX_CONTEXT_CHARS is reached - see that constant's own comment
    for why a size budget, not just a chunk-count cap, is what this
    pipeline actually needs. The single best chunk is always included
    even if it alone exceeds the budget, so a cap never produces an
    empty context."""
    ordered = sorted(chunks, key=lambda c: c.get("rerank_score", 0.0), reverse=True)
    blocks = []
    citations = []
    total_chars = 0
    for c in ordered:
        chunk_id = c.get("chunk_id")
        complete_before = complete_after = None
        text = c["text"]
        if chunk_id is not None:
            try:
                complete = get_complete_citation_text(chunk_id)
            except Exception:
                complete = None
            if complete is not None:
                text = complete["text"]
                complete_before = complete["complete_before"]
                complete_after = complete["complete_after"]

        i = len(blocks) + 1
        block = f"[{i}] {c['doc_filename']} (page {c['page']}):\n{text}"
        if blocks and total_chars + len(block) > MAX_CONTEXT_CHARS:
            continue
        total_chars += len(block)
        blocks.append(block)
        citations.append({
            "id": i,
            "doc": c["doc_filename"],
            "page": c["page"],
            "domain": c["domain"],
            "geography": c["geography"],
            "rerank_score": round(c.get("rerank_score", 0.0), 4),
            # Sentence-complete by default (see the function docstring
            # above) - not the raw single fixed-size retrieval chunk.
            "text": text,
            # The chunk's own id in the corpus-wide chunks.jsonl/Qdrant
            # index - still threaded through so the frontend's "Show
            # more context" control can pull in additional surrounding
            # paragraphs beyond the sentence-complete text above, via
            # GET /citation-context/{id}. See retrieve.py's
            # get_citation_context() for that manual-expansion path.
            "chunk_id": chunk_id,
            # True once get_complete_citation_text() found a genuine
            # sentence boundary on that side; False means it hit its
            # expansion cap without one (pathological/unpunctuated
            # source text) and the text may still be cut - None means
            # no chunk_id was available to check at all (e.g. a
            # non-local-rag citation source). The frontend should only
            # show a "still might be cut off" indicator when this is
            # explicitly False, not whenever it's merely absent.
            "complete_before": complete_before,
            "complete_after": complete_after,
        })
    return "\n\n---\n\n".join(blocks), citations


# Matches a bare inline citation marker like "[3]" - what the model
# actually writes, per SYSTEM_PROMPT's "e.g. [1]" instruction below, and
# what build_context()'s own evidence-block labels above use ("[3]
# filename.pdf (page 7):..."). Deliberately NOT the format ChatInterface.tsx
# expects to see in the CHAT-DISPLAYED answer text ([D1], [D2] - the
# format app/api/rag-chat/route.ts's cloud-path prompts use, and what
# transformCitations() in both local-rag-chat/route.ts and
# local-rag-proposal-review-chat/route.ts already prefix every citation's
# id with, in anticipation of exactly this). See _prefix_citation_markers()
# below for why the rewrite happens there instead of here.
_CITATION_MARKER_RE = re.compile(r'\[(\d+)\]')


def _prefix_citation_markers(text):
    """Rewrites this module's own "[N]" citation markers into the "[DN]"
    format the chat frontend's InlineCitation matcher actually looks for
    (components/chat/ChatInterface.tsx's regex is /\[(?:D|W)\d+\]/ - a
    bare "[1]" never matches it, so it renders as plain dead text with no
    click-to-source-card interactivity). This is a real, previously-silent
    bug: local-rag citations have never been clickable inline, only in the
    separate Sources list below the answer.

    Deliberately done here, as a deterministic string rewrite of the
    model's OWN output, rather than by asking the model to write "[D1]"
    directly (asking Groq to change its output format is less reliable
    than just rewriting whatever number it already wrote) or by changing
    build_context()'s shared evidence-block numbering above (proposal_
    review.py also calls build_context() for the compliance-review PDF
    report, which has its own separate system prompt and its own plain-
    "[N]" linkifier - report_render.py's _CITE_RE - so changing the
    shared numbering would risk breaking that pipeline's citation links
    too). Only ever applied to the final chat-facing answer text in
    generate_answer()/stream_answer(), never to build_context()'s
    evidence blocks, the citations list, or anything the verify/
    groundedness LLM passes see - they're calibrated against the
    evidence blocks' own "[N]" labels, so this stays purely a display-
    layer rewrite applied last."""
    return _CITATION_MARKER_RE.sub(lambda m: f"[D{m.group(1)}]", text)


def _verify_and_repair(query, answer_text, context, client, model):
    """One extra Groq call, gated by low/medium confidence in
    generate_answer() below - see VERIFY_PROMPT for what it's allowed to
    change. Best-effort: any failure here (rate limit, network) falls
    back to the original drafted answer rather than blocking the
    response entirely."""
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": VERIFY_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Evidence:\n\n{context}\n\n---\n\nQuestion: {query}"
                    f"\n\n---\n\nDrafted answer:\n{answer_text}"
                ),
            },
        ],
        temperature=0.0,
        max_tokens=800,
    )
    return completion.choices[0].message.content


def _extract_first_json_object(text):
    """Groq's JSON-mode responses occasionally wrap the object in stray
    prose or markdown fencing despite the prompt saying not to - find the
    first balanced {...} block rather than assuming the whole response is
    clean JSON. Returns None if no balanced object is found."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


# Decompose-then-verify, not a single holistic 0-100 guess: asking an
# LLM to eyeball one number for an entire answer is exactly the kind of
# judgment LLMs are least consistent at. Splitting the answer into atomic
# claims first and verifying each independently - then scoring
# supported/total - is what Ragas's actual faithfulness metric does; the
# old single-score prompt only approximated that name, not the method.
# Kept field-for-field identical to the cloud path's mirrored prompt in
# app/api/rag-chat/route.ts's checkGroundedness() on purpose - see
# _check_groundedness()'s docstring below for why that parity matters.
GROUNDEDNESS_JUDGE_PROMPT = """You are a strict fact-checking judge. You do NOT answer questions - you grade whether an already-written ANSWER is backed by the given SOURCE EXCERPTS, one claim at a time.

Step 1: Break the ANSWER into individual atomic factual claims - one discrete assertion per claim. A sentence asserting two facts (e.g. a date and a location) becomes two separate claims. Ignore claims that are pure hedging, formatting, or "I don't know" - grade only assertions of fact.

Step 2: For each claim, judge independently whether it is directly supported by the SOURCE EXCERPTS - stated there, or something the excerpts directly imply. A claim is NOT supported if it is merely plausible, general knowledge, or something the excerpts leave unstated.

Do not let the ANSWER's writing quality, tone, or confidence affect your judgment on any claim - grade only factual grounding, claim by claim.

Respond with JSON only, no other text, no markdown fencing:
{"claims": [{"claim": "<short paraphrase, under 15 words>", "supported": <true|false>}, ...]}

If the ANSWER makes no factual claims (e.g. it's a clarifying question, a refusal, or "the documents don't cover this"), return {"claims": []}."""


def _check_groundedness(query, answer_text, context, client, model):
    """Claim-level groundedness (architecture-plan section 52/Phase 5's
    "claim-level groundedness" item) - Ragas-style "faithfulness"
    LLM-as-judge, deliberately mirroring the cloud path's own
    checkGroundedness() in app/api/rag-chat/route.ts field-for-field
    (same 0-100 scale, same {groundedness, unsupportedClaims} shape) so
    ChatInterface.tsx's existing groundedness badge - already built for
    the cloud path, previously always null for local mode because this
    check didn't exist here - renders identically for both.

    This is a genuinely different signal from retrieve.py's
    Corrective-RAG confidence: confidence asks "did we find material
    that looks relevant to the question", this asks "does the answer we
    actually wrote say anything the retrieved material doesn't support."
    A high-confidence retrieval can still produce a claim the model
    invented; a low-confidence retrieval can still produce an answer
    that honestly and fully sticks to the thin evidence it had. Runs
    unconditionally whenever there's a generated answer to grade (not
    gated by confidence, unlike _verify_and_repair() above) - grading
    only the answers retrieve() already flagged as shaky would defeat
    the point of an independent check. Best-effort: any failure (rate
    limit, malformed JSON, network) yields (None, []), same as the cloud
    path's own fallback, rather than blocking the response."""
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": GROUNDEDNESS_JUDGE_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"QUESTION:\n{query}\n\nSOURCE EXCERPTS:\n{context}"
                        f"\n\nANSWER TO GRADE:\n{answer_text}"
                    ),
                },
            ],
            temperature=0.0,
            # Bumped from 600: a per-claim JSON array is longer than one
            # holistic score, and a longer answer means more claims to list.
            max_tokens=1200,
        )
        raw = (completion.choices[0].message.content or "").strip()
        json_text = _extract_first_json_object(raw)
        if not json_text:
            return None, []

        import json

        parsed = json.loads(json_text)
        claims = parsed.get("claims")
        if not isinstance(claims, list):
            return None, []

        valid_claims = [
            c
            for c in claims
            if isinstance(c, dict)
            and isinstance(c.get("claim"), str)
            and c.get("claim").strip()
            and isinstance(c.get("supported"), bool)
        ]
        if not valid_claims:
            # No gradeable claims (refusal, clarifying question, "not
            # covered") - nothing to score. Same semantics as the old
            # "no context" None fallback: absence of a number, not a
            # claim of perfection.
            return None, []

        supported_count = sum(1 for c in valid_claims if c["supported"])
        llm_groundedness = round(100 * supported_count / len(valid_claims))
        unsupported_claims = [
            c["claim"].strip() for c in valid_claims if not c["supported"]
        ][:5]

        # Independent cross-check (hallucination_check.py) - doesn't share
        # a model family with whatever generated answer_text, so it can
        # catch what a self-grading LLM judge might wave through.
        # Pessimistic combination on purpose: either signal finding a
        # problem is enough to lower the score, neither can inflate it
        # past what the other found. Fail-open - if HHEM isn't available
        # (not yet downloaded, offline, load error), the LLM score stands
        # alone, exactly like before this cross-check existed.
        hhem_groundedness = hallucination_check.score_groundedness(context, answer_text)
        groundedness = (
            min(llm_groundedness, round(hhem_groundedness))
            if hhem_groundedness is not None
            else llm_groundedness
        )
        return groundedness, unsupported_claims
    except Exception:
        return None, []



def _build_system_prompt(confidence):
    """Shared by generate_answer() and stream_answer() so the two paths'
    system prompts can never quietly drift apart - the confidence-aware
    note appended here is what tells the model to hedge/double-check on
    medium/low-confidence retrieval, and both the streaming and
    non-streaming answer paths need to say the exact same thing."""
    system_prompt = SYSTEM_PROMPT
    if confidence == "low":
        system_prompt += (
            "\n\nNote: automated retrieval confidence for this query is LOW "
            "- the evidence above may be thin or only loosely related. Say so "
            "explicitly in the answer rather than answering with unwarranted "
            "confidence."
        )
    elif confidence == "medium":
        system_prompt += (
            "\n\nNote: automated retrieval confidence for this query is MEDIUM "
            "- double-check that each claim you make is actually backed by its "
            "cited evidence before stating it."
        )
    return system_prompt


def _build_user_content(query, context, project_context=None):
    """Shared by generate_answer() and stream_answer() - prepends the
    structured "CURRENT PROJECT STATE" block (project_state.py's
    build_context_summary(), architecture-plan section 26) ahead of the
    retrieved evidence when a caller passes one, so the model sees both
    what's currently true about the project and what the text corpus
    says. Deliberately NOT folded into the retrieval query itself - see
    build_context_summary()'s own docstring for why that would pollute
    embedding search with proposal details that aren't semantically
    about the question being asked."""
    user_content = f"Evidence:\n\n{context}\n\n---\n\nQuestion: {query}"
    if project_context:
        user_content = f"{project_context}\n\n---\n\n{user_content}"
    return user_content


def generate_answer(query, chunks, coverage=None, model=None, project_context=None, backend="groq"):
    """coverage is the dict retrieve() now returns alongside chunks
    (architecture plan section 52) - optional so this still works if a
    caller passes chunks straight from somewhere else, but query_cli.py
    and service.py always pass it through. project_context, if given, is
    project_state.py's build_context_summary() output - see
    _build_user_content().

    backend selects which model actually generates the answer: "groq"
    (default, unchanged from before this parameter existed) calls Groq's
    cloud API; "ollama" calls a local Ollama instance instead, so the
    generation step - not just retrieval - stays entirely on this
    machine. See common.py's OLLAMA_BASE_URL/DEFAULT_OLLAMA_MODEL and
    _setup_backend() above for how the local path is configured.
    model, if given, overrides the backend's own default model name
    (DEFAULT_GROQ_MODEL / DEFAULT_OLLAMA_MODEL) - leave it None to use
    whichever default matches the chosen backend."""
    confidence = coverage.get("confidence") if coverage else None

    if not chunks:
        return {
            "answer": "I don't have any indexed material relevant to this question.",
            "citations": [],
            "confidence": confidence or "low",
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }

    client, error_types, model, early_error = _setup_backend(backend, model)
    if early_error:
        return {
            "answer": early_error,
            "citations": [],
            "retrieved_only": True,
            "confidence": confidence,
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }

    context, citations = build_context(chunks)
    system_prompt = _build_system_prompt(confidence)

    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": _build_user_content(query, context, project_context)},
            ],
            temperature=0.1,
            max_tokens=800,
        )
    except error_types as e:
        # Found the hard way 2026-09-22 (same class of bug already fixed
        # in proposal_review.py 2026-09-18): an uncaught APIStatusError
        # here - most often a 413 "Request too large" token-per-minute
        # rate limit - used to crash the whole request with a raw
        # traceback instead of a clear message. MAX_CONTEXT_CHARS in
        # build_context() above is the real fix (keeps requests under
        # budget in the first place); this is the safety net for
        # whatever still gets through it. Extended 2026-09-24 to also
        # catch the Ollama backend's own failure mode (server not
        # running, model not pulled) - see _backend_error_message().
        return {
            "answer": _backend_error_message(backend, e),
            "citations": citations,
            "confidence": confidence,
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }
    answer_text = completion.choices[0].message.content

    # Self-RAG-style reflect/repair pass - only for medium/low confidence,
    # so the common high-confidence path stays one Groq call (section 10's
    # cost principle). A verification failure never blocks the answer.
    verified = False
    if confidence in ("low", "medium"):
        try:
            answer_text = _verify_and_repair(query, answer_text, context, client, model)
            verified = True
        except Exception:
            pass

    groundedness, unsupported_claims = _check_groundedness(
        query, answer_text, context, client, model
    )

    # Rewritten last, after every LLM pass above has already read/graded
    # the model's own "[N]" markers - see _prefix_citation_markers()'s
    # docstring for why this is a pure display-layer rewrite, not a
    # prompt change.
    answer_text = _prefix_citation_markers(answer_text)

    return {
        "answer": answer_text,
        "citations": citations,
        "confidence": confidence,
        "verified": verified,
        "groundedness": groundedness,
        "unsupported_claims": unsupported_claims,
    }


def stream_answer(query, chunks, coverage=None, model=None, project_context=None, backend="groq"):
    """Streaming counterpart to generate_answer() (architecture-plan
    Phase 5's "streaming" item). Yields ("delta", text) tuples as the
    draft answer streams in, followed by exactly one ("done", result)
    tuple where result is the same dict shape generate_answer() returns
    (answer, citations, confidence, verified, groundedness,
    unsupported_claims).

    result["answer"] is authoritative and can differ slightly from the
    concatenation of every "delta" text seen: the Self-RAG repair pass
    (only for low/medium confidence, same gating as generate_answer())
    and the groundedness check both still run AFTER the stream
    finishes - there's no way to re-verify a claim while it's still
    mid-stream. This trades a small chance of the final text silently
    correcting a couple of words for real token-by-token latency on
    every query. A caller that needs the streamed text to be guaranteed
    byte-for-byte final should use generate_answer() instead - this
    generator exists purely for perceived-latency UX (time-to-first-
    token), not as a stricter replacement.

    project_context, if given, is project_state.py's
    build_context_summary() output - see _build_user_content().

    backend/model: same meaning as generate_answer()'s own params - see
    that function's docstring and _setup_backend() above. Ollama's
    /api/chat streams newline-delimited JSON the same way Groq's SDK
    streams chunk objects, so the "delta"/"done" contract below is
    identical regardless of which backend is chosen.
    """
    confidence = coverage.get("confidence") if coverage else None

    if not chunks:
        yield "done", {
            "answer": "I don't have any indexed material relevant to this question.",
            "citations": [],
            "confidence": confidence or "low",
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }
        return

    client, error_types, model, early_error = _setup_backend(backend, model)
    if early_error:
        yield "done", {
            "answer": early_error,
            "citations": [],
            "retrieved_only": True,
            "confidence": confidence,
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }
        return

    context, citations = build_context(chunks)
    system_prompt = _build_system_prompt(confidence)

    try:
        stream = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": _build_user_content(query, context, project_context)},
            ],
            temperature=0.1,
            max_tokens=800,
            stream=True,
        )

        answer_parts = []
        for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                answer_parts.append(delta)
                yield "delta", delta
        answer_text = "".join(answer_parts)
    except error_types as e:
        # Same fix as generate_answer() above, adapted for a generator -
        # found the hard way 2026-09-22: an uncaught APIStatusError here
        # (e.g. a 413 token-per-minute rate limit) used to propagate all
        # the way up through service.py's SSE generator and abruptly
        # close the HTTP connection mid-stream - no "done" event, no
        # error message, just a dead socket. The Next.js proxy
        # (app/api/local-rag-chat/stream/route.ts) saw that as
        # "TypeError: terminated" / "other side closed" and returned a
        # 500, which the frontend showed as an opaque "Error: Load
        # failed" - true but useless to a user asking a perfectly
        # reasonable question. Yielding a "done" event with the real
        # explanation keeps the SSE contract intact (exactly one "done",
        # same shape generate_answer() returns) instead of killing the
        # connection. Extended 2026-09-24 for the Ollama backend's own
        # failure mode (server not running, model not pulled, or a
        # request that timed out on slow local hardware) - see
        # _backend_error_message().
        yield "done", {
            "answer": _backend_error_message(backend, e),
            "citations": citations,
            "confidence": confidence,
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }
        return

    verified = False
    if confidence in ("low", "medium"):
        try:
            answer_text = _verify_and_repair(query, answer_text, context, client, model)
            verified = True
        except Exception:
            pass

    groundedness, unsupported_claims = _check_groundedness(
        query, answer_text, context, client, model
    )

    # Same last-step rewrite as generate_answer() above - the streamed
    # "delta" events above still carry the model's raw "[N]" markers
    # (there's no way to rewrite mid-stream without the marker's digits
    # possibly splitting across two deltas), but result["answer"] in this
    # "done" event is already documented as authoritative and allowed to
    # differ slightly from the concatenated deltas (see this function's
    # own docstring on the repair pass) - this is the same kind of
    # trailing correction, not a new precedent.
    answer_text = _prefix_citation_markers(answer_text)

    yield "done", {
        "answer": answer_text,
        "citations": citations,
        "confidence": confidence,
        "verified": verified,
        "groundedness": groundedness,
        "unsupported_claims": unsupported_claims,
    }
