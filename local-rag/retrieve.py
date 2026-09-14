"""Hybrid retrieval: dense (Qdrant) + sparse (BM25) + exact-reference
boost, fused with Reciprocal Rank Fusion, then reranked locally with a
small cross-encoder. This is the offline equivalent of the old app's
searchRAG() [dense+fulltext RPCs, fuseWithRRF] + rerankWithGroq(), except
the rerank step is a local model instead of an LLM call (section 10 of
the README: "This is too expensive for the normal path... Use LLM
reranking only for genuinely difficult/low-confidence cases" - this file
only implements the cheap default path).
"""

import functools
import pickle
import re

from qdrant_client import QdrantClient
from sentence_transformers import CrossEncoder, SentenceTransformer

from common import (
    QDRANT_PATH, QDRANT_COLLECTION, BM25_PATH, CHUNKS_PATH,
    EMBEDDING_MODEL_NAME, EMBEDDING_QUERY_PREFIX, RERANKER_MODEL_NAME,
    STATUS_BOOST, CONFIDENCE_TOP_SCORE_HIGH, CONFIDENCE_TOP_SCORE_LOW,
    MIN_SOURCE_DIVERSITY_FOR_HIGH,
)

RRF_K = 60  # standard constant for reciprocal rank fusion

# Matches section 41's example list - deliberately simple/conservative:
# a false match here only adds a small score boost, it never filters
# anything out, so a slightly-too-eager pattern is low-risk.
EXACT_REFERENCE_PATTERNS = [
    re.compile(r"\bpolicy\s+[a-z]{0,2}\d+[a-z]?\b", re.I),
    re.compile(r"\bparagraph\s+\d+\b", re.I),
    re.compile(r"\bapproved\s+document\s+[a-z]\b", re.I),
    re.compile(r"\bsection\s+\d+\b", re.I),
    re.compile(r"\bregulation\s+\d+\b", re.I),
]


@functools.lru_cache(maxsize=1)
def _load_chunk_texts():
    """chunk_id -> full chunk dict, loaded once per process and cached -
    both indexes only store an id; this is what turns an id back into
    text + metadata without re-reading chunks.jsonl on every query."""
    chunks = {}
    with open(CHUNKS_PATH) as f:
        import json
        for line in f:
            c = json.loads(line)
            chunks[c["chunk_id"]] = c
    return chunks


@functools.lru_cache(maxsize=1)
def _load_embedder():
    return SentenceTransformer(EMBEDDING_MODEL_NAME)


@functools.lru_cache(maxsize=1)
def _load_reranker():
    return CrossEncoder(RERANKER_MODEL_NAME)


@functools.lru_cache(maxsize=1)
def _load_qdrant():
    return QdrantClient(path=str(QDRANT_PATH))


@functools.lru_cache(maxsize=1)
def _load_bm25():
    with open(BM25_PATH, "rb") as f:
        data = pickle.load(f)
    return data["bm25"], data["chunk_ids"]


def _dense_search(query, top_k):
    model = _load_embedder()
    vec = model.encode(EMBEDDING_QUERY_PREFIX + query, normalize_embeddings=True).tolist()
    client = _load_qdrant()
    # client.search() was removed in newer qdrant-client (requirements.txt
    # pins >=1.9,<2, and pip resolved that to 1.16.1, which dropped it) -
    # query_points() is the current replacement; it returns a
    # QueryResponse wrapping the same ScoredPoint list under .points.
    result = client.query_points(collection_name=QDRANT_COLLECTION, query=vec, limit=top_k)
    # rank position, not raw score, is what RRF needs
    return [str(h.id) for h in result.points]


def _sparse_search(query, top_k):
    bm25, chunk_ids = _load_bm25()
    tokens = re.findall(r"[a-z0-9]+", query.lower())
    if not tokens:
        return []
    scores = bm25.get_scores(tokens)
    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
    return [chunk_ids[i] for i in ranked if scores[i] > 0]


def _exact_reference_boost(query):
    """Returns the literal reference strings found in the query (e.g.
    "policy d3"), lowercased - used to nudge chunks that literally
    contain the same reference to the front before fusion."""
    found = []
    for pattern in EXACT_REFERENCE_PATTERNS:
        found.extend(m.group(0).lower() for m in pattern.finditer(query))
    return found


def _reciprocal_rank_fusion(*ranked_lists, k=RRF_K):
    scores = {}
    for ranked in ranked_lists:
        for rank, chunk_id in enumerate(ranked):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)


def assess_coverage(results, references):
    """Corrective-RAG-style confidence check (architecture plan section
    16/52) - cheap, deterministic signals on the already-reranked
    results, no extra LLM call. retrieve() uses this to decide whether
    to broaden the search once; answer.py uses it to decide whether the
    extra groundedness-verification pass is worth the LLM call, and to
    tell the model (and the user) when the evidence is thin rather than
    answering with unwarranted confidence."""
    if not results:
        return {
            "confidence": "low",
            "top_rerank_score": None,
            "source_count": 0,
            "reasons": ["no evidence retrieved for this query"],
        }

    top_score = results[0]["rerank_score"]
    sources = {c["doc_filename"] for c in results}
    reasons = []

    if top_score >= CONFIDENCE_TOP_SCORE_HIGH:
        confidence = "high"
    elif top_score < CONFIDENCE_TOP_SCORE_LOW:
        confidence = "low"
        reasons.append(f"top rerank score {top_score:.2f} is weak")
    else:
        confidence = "medium"
        reasons.append(f"top rerank score {top_score:.2f} is middling")

    if confidence == "high" and len(sources) < MIN_SOURCE_DIVERSITY_FOR_HIGH:
        confidence = "medium"
        reasons.append("all top evidence comes from a single document")

    if references:
        top_texts = " ".join(c["text"].lower() for c in results[:3])
        if not any(ref in top_texts for ref in references):
            if confidence == "high":
                confidence = "medium"
            reasons.append(
                f"query named an exact reference ({', '.join(references)}) "
                "not found verbatim in the top evidence"
            )

    return {
        "confidence": confidence,
        "top_rerank_score": round(float(top_score), 4),
        "source_count": len(sources),
        "reasons": reasons,
    }


def _retrieve_once(query, top_k, rerank_top_n):
    dense_ids = _dense_search(query, top_k)
    sparse_ids = _sparse_search(query, top_k)
    fused = _reciprocal_rank_fusion(dense_ids, sparse_ids)

    chunks = _load_chunk_texts()
    references = _exact_reference_boost(query)

    candidates = []
    for chunk_id, rrf_score in fused[: top_k * 2]:
        chunk = chunks.get(chunk_id)
        if not chunk:
            continue
        boost = 0.0
        if references:
            text_lower = chunk["text"].lower()
            if any(ref in text_lower for ref in references):
                boost += 0.05  # small, deliberate nudge - see module docstring
        # Prefer current material over historic/superseded/draft versions
        # of the same policy without hard-filtering anything out - see
        # STATUS_BOOST in common.py.
        boost += STATUS_BOOST.get(chunk.get("status"), 0.0)
        candidates.append((chunk, rrf_score + boost))

    candidates.sort(key=lambda cs: cs[1], reverse=True)
    candidates = candidates[:top_k]
    if not candidates:
        return []

    reranker = _load_reranker()
    pairs = [(query, c["text"]) for c, _ in candidates]
    cross_scores = reranker.predict(pairs)
    reranked = sorted(zip(candidates, cross_scores), key=lambda x: x[1], reverse=True)

    results = []
    for (chunk, _rrf), cross_score in reranked[:rerank_top_n]:
        result = dict(chunk)
        result["rerank_score"] = float(cross_score)
        results.append(result)
    return results


def retrieve(query, top_k=25, rerank_top_n=8, allow_broaden=True):
    """Returns (chunks, coverage): up to rerank_top_n chunk dicts (full
    text + metadata), best first, after dense+sparse fusion and local
    cross-encoder reranking - plus a coverage/confidence dict from
    assess_coverage(). This is what answer.py builds the evidence
    context from.

    Corrective-RAG-style broadening (architecture plan section 52): if
    the first pass comes back low-confidence, automatically retry once
    with a wider net (bigger top_k, same query - not a query rewrite,
    see section 8) before giving up and returning weak results. Only
    retries once (allow_broaden=False on the retry, implicitly, since
    we return directly) so a genuinely under-covered topic doesn't
    spiral into ever-larger searches."""
    results = _retrieve_once(query, top_k, rerank_top_n)
    references = _exact_reference_boost(query)
    coverage = assess_coverage(results, references)

    if coverage["confidence"] == "low" and allow_broaden and top_k < 75:
        wider_top_k = min(top_k * 3, 75)
        wider_results = _retrieve_once(query, wider_top_k, rerank_top_n)
        wider_coverage = assess_coverage(wider_results, references)
        wider_coverage["broadened_from_top_k"] = top_k
        return wider_results, wider_coverage

    coverage["broadened_from_top_k"] = None
    return results, coverage
