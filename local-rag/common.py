# Shared paths, config and the chunk record shape used by every script in
# this folder. Centralized here so ingest.py / retrieve.py / answer.py /
# service.py / query_cli.py all agree on where things live without each
# hardcoding its own copy of the same five paths.
#
# Why this exists at all (read this before touching paths): the offline
# corpus was triaged from a session that reaches your Mac through a
# sandboxed bridge, NOT your real Terminal - that bridge's own filesystem
# is a separate, temporary Linux sandbox, so anything it pip-installs
# (compiled packages like torch) is a Linux binary that cannot run on your
# actual macOS Python. Every file in this folder is plain, portable Python
# source (safe to have been written that way) but the venv itself, and the
# one-time ingest run, have to happen in YOUR OWN Terminal on your actual
# Mac - see "Setup and Ingest Local RAG.command" on your Desktop.

import os
from pathlib import Path

LOCAL_RAG_DIR = Path(__file__).resolve().parent
REPO_DIR = LOCAL_RAG_DIR.parent

# Corpus location. This has already moved once - it started at
# ~/Desktop/Corpus, then got reorganized (by hand, on the Mac) into
# ~/Desktop/Urban AI Corpus/Corpus - so rather than hardcoding one path,
# this picks whichever of the known locations actually exists on disk.
# Override with CORPUS_DIR in the environment any time it moves again.
def _resolve_corpus_dir():
    override = os.environ.get("CORPUS_DIR")
    if override:
        return Path(override)
    candidates = [
        Path.home() / "Desktop" / "Urban AI Corpus" / "Corpus",  # current
        Path.home() / "Desktop" / "Corpus",  # original location
    ]
    for c in candidates:
        if c.exists():
            return c
    # Nothing found - fall back to the current-layout guess. ingest.py
    # checks CORPUS_DIR.exists() itself and prints a clear error naming
    # this exact path plus the CORPUS_DIR env var override if it's wrong.
    return candidates[0]


CORPUS_DIR = _resolve_corpus_dir()

# The triage manifest built during Phase 1 (corpus_manifest.json, sitting
# beside this file) - filename -> bucket/domain/geography/doc_type/notes.
# ingest.py reads this to decide what to embed at all: only ACTIVE_CORE
# and ACTIVE_SUPPORTING participate in default retrieval, matching
# section 37 of the architecture README.
MANIFEST_PATH = LOCAL_RAG_DIR / "corpus_manifest.json"

DATA_DIR = LOCAL_RAG_DIR / "data"
CHUNKS_PATH = DATA_DIR / "chunks.jsonl"
QDRANT_PATH = DATA_DIR / "qdrant"
BM25_PATH = DATA_DIR / "bm25_index.pkl"
QDRANT_COLLECTION = "regulatory_knowledge"  # matches section 21 of the README

# Embedding model: a small, CPU-friendly BGE model. BGE's own docs call
# for prefixing the QUERY (never the passage) with this instruction string
# for asymmetric retrieval - get it wrong and recall quietly gets worse
# without throwing any error, so it's centralized here rather than
# duplicated (and risking drift) between ingest.py and retrieve.py.
EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBEDDING_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
EMBEDDING_DIM = 384

RERANKER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"

CHUNK_TARGET_CHARS = 1000
CHUNK_OVERLAP_CHARS = 150

# Corrective-RAG-style confidence thresholds and document-status boost
# (architecture plan section 52, "next-increment" items 1-2: turn the
# retrieval-quality confidence check on, and start using each chunk's
# `status` field instead of treating current/historic/superseded
# material as equally preferred). Centralized here for the same reason
# EMBEDDING_QUERY_PREFIX is: retrieve.py and answer.py both need to
# agree on what "low confidence" means without duplicating the numbers.
#
# STATUS_BOOST is a small nudge added to a chunk's fused score, same
# mechanism as retrieve.py's exact-reference boost - it never filters
# anything out, it just breaks ties in favour of current material when
# a current and a historic/superseded version of the same policy both
# come back for the same query (the known trade-off documented in
# ingest.py's docstring and README.md).
STATUS_BOOST = {
    "current": 0.03,
    "future": 0.0,
    "consultation": -0.02,
    "draft": -0.02,
    "supporting_evidence": 0.0,
    "historic": -0.04,
    "superseded": -0.05,
}

# Cross-encoder rerank scores below this are "low confidence" (Corrective
# RAG's confidence check); at/above this are "high confidence". Anything
# in between is "medium". These are the raw ms-marco-MiniLM-L-6-v2 scores
# from retrieve.py's reranker - not calibrated probabilities - so treat
# them as directional, not absolute; revisit once real queries have been
# run against the full 185-file corpus.
CONFIDENCE_TOP_SCORE_HIGH = 0.55
CONFIDENCE_TOP_SCORE_LOW = 0.15
MIN_SOURCE_DIVERSITY_FOR_HIGH = 2

DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"


def load_dotenv_from_repo():
    """.env.local lives at the repo root (Next.js convention) - reuse the
    same GROQ_API_KEY the live app already has configured rather than
    asking you to set it up a second time in a different place."""
    from dotenv import load_dotenv
    env_path = REPO_DIR / ".env.local"
    if env_path.exists():
        load_dotenv(env_path)
