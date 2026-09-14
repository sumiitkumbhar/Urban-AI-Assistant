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

SYSTEM_PROMPT = """You are a UK planning and building-regulations assistant. \
Answer ONLY using the numbered evidence extracts provided below - never from \
general knowledge, and never invent a citation, policy number, or page. \
Cite every claim inline using its evidence number in square brackets, e.g. [1]. \
If the evidence does not contain enough to answer, say so plainly instead of guessing. \
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
    numbers since there's no separate web-source track here."""
    blocks = []
    citations = []
    for i, c in enumerate(chunks, start=1):
        blocks.append(
            f"[{i}] {c['doc_filename']} (page {c['page']}):\n{c['text']}"
        )
        citations.append({
            "id": i,
            "doc": c["doc_filename"],
            "page": c["page"],
            "domain": c["domain"],
            "geography": c["geography"],
            "rerank_score": round(c.get("rerank_score", 0.0), 4),
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


def generate_answer(query, chunks, coverage=None, model=DEFAULT_GROQ_MODEL):
    """coverage is the dict retrieve() now returns alongside chunks
    (architecture plan section 52) - optional so this still works if a
    caller passes chunks straight from somewhere else, but query_cli.py
    and service.py always pass it through."""
    confidence = coverage.get("confidence") if coverage else None

    if not chunks:
        return {
            "answer": "I don't have any indexed material relevant to this question.",
            "citations": [],
            "confidence": confidence or "low",
            "verified": False,
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
        }

    context, citations = build_context(chunks)
    client = Groq(api_key=api_key)

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

    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Evidence:\n\n{context}\n\n---\n\nQuestion: {query}"},
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

    return {
        "answer": answer_text,
        "citations": citations,
        "confidence": confidence,
        "verified": verified,
    }
