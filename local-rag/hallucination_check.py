"""Independent, non-LLM-as-judge groundedness cross-check.

_check_groundedness() in answer.py (and its mirror, checkGroundedness()
in app/api/rag-chat/route.ts) grade an answer by asking Groq to list its
claims and verify each one - a real improvement over a single holistic
score, but still an LLM grading text that a similarly-trained LLM wrote,
which is a known self-grading bias: a judge tends to go easy on writing
that "sounds like" its own.

This module adds a second, independent signal using Vectara's
HHEM-2.1-Open (vectara/hallucination_evaluation_model) - a small (100M
param, FLAN-T5-based, Apache-2.0) model trained specifically to score
whether a hypothesis is factually consistent with a premise, with no
relationship to Groq's model family at all. See:
https://huggingface.co/vectara/hallucination_evaluation_model

torch and transformers are already installed here as dependencies of
sentence-transformers/wtpsplit (see requirements.txt), so this adds a
one-time ~400MB model download the first time it runs, not a new
package. Fail-open throughout, mirroring retrieve.py's wtpsplit-missing
fallback: any failure (offline on first run, OOM, model-load error)
returns None rather than blocking a response, and the caller falls back
to the LLM-judge score alone - exactly today's behavior.
"""

from __future__ import annotations

from typing import Optional

_model = None
_load_failed = False


def _get_model():
    """Lazily loads the HHEM model once per process. Safe to call from
    every request - after the first successful (or failed) load, this
    is just a dict-free in-memory check, no disk or network I/O."""
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model
    try:
        from transformers import AutoModelForSequenceClassification

        _model = AutoModelForSequenceClassification.from_pretrained(
            "vectara/hallucination_evaluation_model", trust_remote_code=True
        )
    except Exception:
        _load_failed = True
        _model = None
    return _model


# HHEM's context window is nominally unlimited, but a multi-thousand-word
# retrieved-context blob is both slow to score and unlike what the model
# was validated on (summarization-style premises). Capped the same way
# citation expansion is capped elsewhere in this codebase, so this stays
# fast enough to run on every answer rather than needing an opt-in gate.
MAX_PREMISE_CHARS = 6000


def score_groundedness(premise: str, hypothesis: str) -> Optional[float]:
    """Returns a 0-100 factual-consistency score for `hypothesis` (the
    generated answer) against `premise` (the retrieved source excerpts),
    or None if the model isn't available or either input is empty. Never
    raises - any error is a None, same fail-open contract as the rest of
    this module."""
    if not premise or not premise.strip() or not hypothesis or not hypothesis.strip():
        return None
    model = _get_model()
    if model is None:
        return None
    try:
        trimmed_premise = premise[:MAX_PREMISE_CHARS]
        scores = model.predict([(trimmed_premise, hypothesis)])
        score = float(scores[0])
        return max(0.0, min(100.0, round(score * 100, 1)))
    except Exception:
        return None
