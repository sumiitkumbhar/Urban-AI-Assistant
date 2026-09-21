"""Answer generation from retrieved chunks, via Groq (cloud) - reusing
the same GROQ_API_KEY already configured for the live Next.js app's
.env.local. Retrieval and storage are local/offline per the README's
"hybrid local/cloud models" recommendation (section 6.2): local
retrieval -> local reranker -> cloud frontier model. Swapping this one
function for a local Ollama call later is a contained change if you
decide you want the answer step offline too - nothing else in this
folder needs to change for that.
"""

import os

from groq import Groq

from common import load_dotenv_from_repo, DEFAULT_GROQ_MODEL
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
    silently drops a citation over this."""
    blocks = []
    citations = []
    for i, c in enumerate(chunks, start=1):
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

        blocks.append(
            f"[{i}] {c['doc_filename']} (page {c['page']}):\n{text}"
        )
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


GROUNDEDNESS_JUDGE_PROMPT = """You are a strict fact-checking judge. You do NOT answer questions - you only grade whether an already-written ANSWER is actually backed by the given SOURCE EXCERPTS.

Score groundedness 0-100:
- 100 = every substantive claim in the ANSWER is directly supported by the SOURCE EXCERPTS.
- 50 = some claims are supported, others are not backed by the excerpts (invented, assumed, or from general knowledge instead of the excerpts).
- 0 = the ANSWER is unsupported by, or contradicts, the SOURCE EXCERPTS.

Do not reward good writing, confident tone, or plausibility. Only reward factual grounding in the given excerpts. List any specific claims in the ANSWER that are NOT backed by the excerpts (empty array if none).

Respond with JSON only, no other text, no markdown fencing:
{"groundedness": <integer 0-100>, "unsupportedClaims": ["short claim", "..."]}"""


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
            max_tokens=600,
        )
        raw = (completion.choices[0].message.content or "").strip()
        json_text = _extract_first_json_object(raw)
        if not json_text:
            return None, []

        import json

        parsed = json.loads(json_text)
        score = parsed.get("groundedness")
        groundedness = (
            max(0, min(100, round(score))) if isinstance(score, (int, float)) else None
        )
        claims = parsed.get("unsupportedClaims")
        unsupported_claims = (
            [c for c in claims if isinstance(c, str) and c.strip()][:5]
            if isinstance(claims, list) else []
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


def generate_answer(query, chunks, coverage=None, model=DEFAULT_GROQ_MODEL, project_context=None):
    """coverage is the dict retrieve() now returns alongside chunks
    (architecture plan section 52) - optional so this still works if a
    caller passes chunks straight from somewhere else, but query_cli.py
    and service.py always pass it through. project_context, if given, is
    project_state.py's build_context_summary() output - see
    _build_user_content()."""
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

    load_dotenv_from_repo()
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return {
            "answer": (
                "GROQ_API_KEY isn't set (checked the repo's .env.local) - retrieval "
                "worked, but I can't call the answer model without it."
            ),
            "citations": [],
            "retrieved_only": True,
            "confidence": confidence,
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }

    context, citations = build_context(chunks)
    client = Groq(api_key=api_key)

    system_prompt = _build_system_prompt(confidence)

    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _build_user_content(query, context, project_context)},
        ],
        temperature=0.1,
        max_tokens=800,
    )
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

    return {
        "answer": answer_text,
        "citations": citations,
        "confidence": confidence,
        "verified": verified,
        "groundedness": groundedness,
        "unsupported_claims": unsupported_claims,
    }


def stream_answer(query, chunks, coverage=None, model=DEFAULT_GROQ_MODEL, project_context=None):
    """Streaming counterpart to generate_answer() (architecture-plan
    Phase 5's "streaming" item). Yields ("delta", text) tuples as the
    draft answer streams in from Groq, followed by exactly one
    ("done", result) tuple where result is the same dict shape
    generate_answer() returns (answer, citations, confidence, verified,
    groundedness, unsupported_claims).

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

    load_dotenv_from_repo()
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        yield "done", {
            "answer": (
                "GROQ_API_KEY isn't set (checked the repo's .env.local) - retrieval "
                "worked, but I can't call the answer model without it."
            ),
            "citations": [],
            "retrieved_only": True,
            "confidence": confidence,
            "verified": False,
            "groundedness": None,
            "unsupported_claims": [],
        }
        return

    context, citations = build_context(chunks)
    client = Groq(api_key=api_key)
    system_prompt = _build_system_prompt(confidence)

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

    yield "done", {
        "answer": answer_text,
        "citations": citations,
        "confidence": confidence,
        "verified": verified,
        "groundedness": groundedness,
        "unsupported_claims": unsupported_claims,
    }
