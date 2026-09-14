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


def generate_answer(query, chunks, model=DEFAULT_GROQ_MODEL):
    if not chunks:
        return {
            "answer": "I don't have any indexed material relevant to this question.",
            "citations": [],
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
        }

    context, citations = build_context(chunks)
    client = Groq(api_key=api_key)
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Evidence:\n\n{context}\n\n---\n\nQuestion: {query}"},
        ],
        temperature=0.1,
        max_tokens=800,
    )
    answer_text = completion.choices[0].message.content

    return {"answer": answer_text, "citations": citations}
