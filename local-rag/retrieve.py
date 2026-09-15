"""Hybrid retrieval: dense (Qdrant/semantic) + sparse (BM25) + exact-
reference boost + graph-expanded reference boost, fused with Reciprocal
Rank Fusion, then reranked locally with a small cross-encoder. This is
the offline equivalent of the old app's searchRAG() [dense+fulltext
RPCs, fuseWithRRF] + rerankWithGroq(), except the rerank step is a local
model instead of an LLM call (section 10 of the README: "This is too
expensive for the normal path... Use LLM reranking only for genuinely
difficult/low-confidence cases" - this file only implements the cheap
default path).

The graph signal (architecture plan section 52's Graph RAG, see
graph_build.py) is additive on top of dense+sparse, never a replacement
for either - semantic (Qdrant) search always runs, on every query,
exactly as before.
"""

import functools
import pickle
import re
from collections import Counter

from qdrant_client import QdrantClient
from sentence_transformers import CrossEncoder, SentenceTransformer

from common import (
    QDRANT_PATH, QDRANT_COLLECTION, BM25_PATH, CHUNKS_PATH,
    EMBEDDING_MODEL_NAME, EMBEDDING_QUERY_PREFIX, RERANKER_MODEL_NAME,
    STATUS_BOOST, CONFIDENCE_TOP_SCORE_HIGH, CONFIDENCE_TOP_SCORE_LOW,
    MIN_SOURCE_DIVERSITY_FOR_HIGH, EXACT_REFERENCE_PATTERNS,
    GRAPH_MAX_RELATED, GRAPH_EXPANSION_BOOST,
)
from graph_build import load_graph

RRF_K = 60  # standard constant for reciprocal rank fusion


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
    # device="cpu" - see ingest.py's build_qdrant_index() comment for why:
    # MPS (Apple Silicon GPU) memory is shared with the rest of the Mac
    # and can run out under normal system load; CPU has no such ceiling.
    # A single query's embedding is small enough that this cost is
    # negligible per-request.
    return SentenceTransformer(EMBEDDING_MODEL_NAME, device="cpu")


@functools.lru_cache(maxsize=1)
def _load_reranker():
    return CrossEncoder(RERANKER_MODEL_NAME, device="cpu")


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


@functools.lru_cache(maxsize=1)
def _load_graph():
    # Returns None if data/reference_graph.pkl doesn't exist yet (e.g.
    # ingest.py hasn't been re-run since this feature was added) - see
    # graph_build.load_graph()'s docstring. Cached like every other
    # _load_* helper here so it's only read from disk once per process.
    return load_graph()


def _graph_expand_references(references):
    """Graph RAG's 'graph signals' input to the fusion layer
    (architecture plan section 52) - looks up references that frequently
    co-occur with the query's named reference(s) in the cross-reference
    graph graph_build.py builds during ingestion, and returns up to
    GRAPH_MAX_RELATED of them as extra references to give a smaller
    secondary boost. This is additive - it never replaces or skips the
    dense (semantic/Qdrant) or sparse (BM25) search above, it only adds
    one more scoring signal on the results they already found. Returns
    [] (not an error) if the graph hasn't been built yet, or the query
    named no exact reference to expand from."""
    graph = _load_graph()
    if graph is None or not references:
        return []

    related = Counter()
    for ref in references:
        if ref not in graph:
            continue
        for neighbor in graph.neighbors(ref):
            if graph.nodes[neighbor].get("kind") != "reference":
                continue
            if neighbor in references:
                continue
            related[neighbor] += graph[ref][neighbor].get("weight", 1)

    return [ref for ref, _count in related.most_common(GRAPH_MAX_RELATED)]


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


def _retrieve_once(query, top_k, rerank_top_n, references, expanded_references, domain_filter=None, geography_filter=None):
    # Dense (semantic/Qdrant) and sparse (BM25) search both always run,
    # on every query, unaffected by whether references/expanded_references
    # are empty - the graph signal below only re-scores what they found.
    #
    # BUG FOUND ON REAL VERIFICATION (2026-09-14, first real run of
    # orchestrate.py): a domain-scoped agent asks the SAME full,
    # multi-topic query text as every other agent - e.g. for "would
    # converting this listed building's basement into a flat need fire
    # safety upgrades and affordable housing contributions", the
    # heritage and building_regulations agents got 0 chunks each, only
    # planning got results. Root cause: dense_search()/sparse_search()
    # were called with the *unscoped* top_k (25) regardless of
    # domain_filter, so only ~25-50 globally-top-ranked chunks (across
    # the whole 24k+-chunk corpus) were ever fetched before filtering -
    # and a long mixed-topic query's top ~25 global matches skew toward
    # whichever domain's wording it echoes most (here, planning - lots
    # of "housing"/"contributions" chunks), even though the corpus does
    # have plenty of genuinely relevant heritage/building_regs material.
    # Widening the *fused list truncation* (what the comment below used
    # to say) didn't help, because the fused list itself was never
    # bigger than 2*top_k to begin with - the real fix has to widen how
    # many candidates dense/sparse search themselves pull before a
    # domain filter gets applied, so a domain that isn't the dominant
    # theme of the raw query text still gets a fair, wide net to be
    # found in. Both are cheap local operations (embedded Qdrant +
    # in-memory BM25 over the full corpus) even at this width.
    scoped = domain_filter or geography_filter
    search_top_k = top_k * 8 if scoped else top_k
    dense_ids = _dense_search(query, search_top_k)
    sparse_ids = _sparse_search(query, search_top_k)
    fused = _reciprocal_rank_fusion(dense_ids, sparse_ids)

    chunks = _load_chunk_texts()

    # With dense/sparse already widened above when scoped (domain and/or
    # geography), look at the whole fused list rather than re-truncating
    # it a second time - it's already bounded (at most 2*search_top_k
    # entries).
    fused_window = len(fused) if scoped else top_k * 2
    candidates = []
    for chunk_id, rrf_score in fused[:fused_window]:
        chunk = chunks.get(chunk_id)
        if not chunk:
            continue
        if domain_filter and chunk.get("domain") != domain_filter:
            # Multi-Agent RAG's per-domain scoping (architecture plan
            # section 52/orchestrate.py) - a domain-scoped "agent" only
            # sees its own slice of the corpus. Applied after fusion
            # rather than as a separate per-domain index: same dense+
            # sparse search either way, just narrowed before rerank -
            # cheaper than maintaining N separate Qdrant collections for
            # a corpus this size (185 documents).
            continue
        if geography_filter and chunk.get("geography") not in (geography_filter, "national"):
            # Council/geography scoping - added 2026-09-15, mirroring the
            # live app's Supabase migration (sql/2026-09-07-council-aware-
            # retrieval.sql) filter_lpa_slug semantics exactly: a national
            # document (the NPPF) is always in scope regardless of which
            # council/geography was asked about, only local material
            # outside the requested geography is excluded. This closes
            # the same "policy bleed" gap that migration fixed on the
            # cloud path - previously `geography` was stored on every
            # chunk (see corpus_manifest.json) but never actually
            # enforced here, only displayed by query_cli.py. Simplified
            # to an exact string match (no hierarchy - e.g. "westminster"
            # does not automatically also match a "greater_london" chunk)
            # since nothing else in the corpus currently encodes that
            # hierarchy either; revisit if/when that's needed.
            continue
        boost = 0.0
        text_lower = chunk["text"].lower()
        if references and any(ref in text_lower for ref in references):
            boost += 0.05  # small, deliberate nudge - see module docstring
        elif expanded_references and any(ref in text_lower for ref in expanded_references):
            # Graph-expanded reference (e.g. query named Policy D3, this
            # chunk mentions Policy D2 which co-occurs with D3 elsewhere
            # in the corpus) - smaller boost than a direct match, and
            # mutually exclusive with the direct-match boost above so a
            # chunk with the literal reference doesn't get penalized
            # relative to one that only has a related one.
            boost += GRAPH_EXPANSION_BOOST
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


def retrieve(query, top_k=25, rerank_top_n=8, allow_broaden=True, domain_filter=None, geography_filter=None):
    """Returns (chunks, coverage): up to rerank_top_n chunk dicts (full
    text + metadata), best first, after dense (semantic) + sparse
    fusion, graph-signal boosting, and local cross-encoder reranking -
    plus a coverage/confidence dict from assess_coverage(). This is what
    answer.py builds the evidence context from.

    Corrective-RAG-style broadening (architecture plan section 52): if
    the first pass comes back low-confidence, automatically retry once
    with a wider net (bigger top_k, same query - not a query rewrite,
    see section 8) before giving up and returning weak results. Only
    retries once (allow_broaden=False on the retry, implicitly, since
    we return directly) so a genuinely under-covered topic doesn't
    spiral into ever-larger searches.

    Graph RAG (architecture plan section 52): references named in the
    query are expanded, via the cross-reference graph, into related
    references that get a smaller secondary boost - computed once here
    and reused across both the first pass and any broadened retry, and
    surfaced in coverage["related_references"] so callers (query_cli.py)
    can show it. This never substitutes for the dense/semantic search
    above; it only adds one more signal on top of it.

    domain_filter (Multi-Agent RAG, architecture plan section 52,
    orchestrate.py): when set, scopes this call to chunks whose `domain`
    metadata matches - this is what makes a "specialist agent" specialist.
    None (the default) means unscoped, exactly the pre-orchestration
    behaviour - orchestrate.py itself decides when scoping is worth it
    for a given query; retrieve() just needs to know how to do it when
    asked.

    geography_filter (council/geography scoping, added 2026-09-15):
    when set, scopes this call to chunks whose `geography` metadata
    exactly matches, plus anything tagged "national" (e.g. the NPPF)
    regardless of which geography was asked for - see the inline comment
    in _retrieve_once() for the full reasoning. None (the default) means
    unscoped. Independent of domain_filter - both can be set at once."""
    references = _exact_reference_boost(query)
    expanded_references = _graph_expand_references(references)

    results = _retrieve_once(
        query, top_k, rerank_top_n, references, expanded_references, domain_filter, geography_filter
    )
    coverage = assess_coverage(results, references)
    coverage["related_references"] = expanded_references

    if coverage["confidence"] == "low" and allow_broaden and top_k < 75:
        wider_top_k = min(top_k * 3, 75)
        wider_results = _retrieve_once(
            query, wider_top_k, rerank_top_n, references, expanded_references,
            domain_filter, geography_filter
        )
        wider_coverage = assess_coverage(wider_results, references)
        wider_coverage["broadened_from_top_k"] = top_k
        wider_coverage["related_references"] = expanded_references
        return wider_results, wider_coverage

    coverage["broadened_from_top_k"] = None
    return results, coverage
