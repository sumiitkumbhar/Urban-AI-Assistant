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
import logging
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
    GRAPH_MAX_RELATED, GRAPH_EXPANSION_BOOST, CHUNK_OVERLAP_CHARS,
    DEBUG_RETRIEVAL,
)
from graph_build import load_graph

logger = logging.getLogger("local-rag")

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


# A citation's raw extract is one fixed-size retrieval chunk, so it can
# legitimately start or end mid-sentence at whichever character the
# sliding window happened to land on (see chunk_page_text() in
# ingest.py) - real, not a bug, but unhelpful to read in isolation.
# get_citation_context() recovers the surrounding sentence(s) by walking
# to the neighboring chunk_id(s) on each side (chunks for one document
# are appended in reading order during ingestion, so chunk_id-1/+1 is
# "the previous/next piece of text", as long as it's still the same
# document - checked via sha256, the same "same file" signal already
# used elsewhere in this project rather than trusting doc_filename,
# which can collide across council/curated corpus rows) and stitching
# them into one continuous passage.

def _merge_overlap(a, b, max_overlap=CHUNK_OVERLAP_CHARS):
    """Join two adjacent chunks' text, removing the duplicated overlap
    chunk_page_text() deliberately carries a tail of the previous chunk
    into the next one for embedding continuity (up to CHUNK_OVERLAP_CHARS
    characters) - naively concatenating would repeat that tail verbatim
    in the stitched passage. Finds the longest suffix of `a` that's also
    a prefix of `b`, within the known overlap budget, and drops it from
    `b` before joining. Falls back to a plain join if no overlap is
    found (e.g. the two chunks aren't actually adjacent in the source
    text, just adjacent in chunk_id - harmless, just means no text is
    trimmed)."""
    cap = min(max_overlap, len(a), len(b))
    for overlap_len in range(cap, 0, -1):
        if a[-overlap_len:] == b[:overlap_len]:
            return a + b[overlap_len:]
    return a + "\n\n" + b


def get_citation_context(chunk_id, window=1):
    """Returns the target chunk plus up to `window` neighboring chunks on
    each side from the same source document, stitched into one
    continuous passage - the "show me more surrounding paragraphs"
    control, for going beyond the single sentence-complete passage
    get_complete_citation_text() already returns by default (see that
    function; build_context() in answer.py uses it for every citation
    up front, not just this one on manual request). Returns None if
    chunk_id isn't a known chunk.

    The outer edges of the stitched passage are trimmed to a genuine
    sentence boundary when one is found within the grabbed window, using
    the same helpers get_complete_citation_text() uses, so a bigger
    manual window doesn't just relocate the mid-sentence cut further
    out - complete_before/complete_after report whether that trim found
    a real boundary (False means the window itself was too small to
    reach one; the caller can ask again with a larger window)."""
    chunks = _load_chunk_texts()
    chunk_id = str(chunk_id)
    target = chunks.get(chunk_id)
    if target is None:
        return None

    try:
        target_idx = int(chunk_id)
    except ValueError:
        return None

    sha = target.get("sha256")

    def collect(step):
        collected = []
        idx = target_idx
        for _ in range(max(0, window)):
            idx += step
            neighbor = chunks.get(f"{idx:08d}")
            if neighbor is None or neighbor.get("sha256") != sha:
                break
            collected.append(neighbor)
        return collected

    before = list(reversed(collect(-1)))
    after = collect(1)
    ordered = before + [target] + after

    stitched = ordered[0]["text"]
    for c in ordered[1:]:
        stitched = _merge_overlap(stitched, c["text"])

    stitched, complete_before = _trim_to_sentence_start(stitched)
    stitched, complete_after = _trim_to_sentence_end(stitched)

    return {
        "chunk_id": chunk_id,
        "doc_filename": target["doc_filename"],
        "page_start": ordered[0]["page"],
        "page_end": ordered[-1]["page"],
        "expanded_before": len(before) > 0,
        "expanded_after": len(after) > 0,
        "complete_before": complete_before,
        "complete_after": complete_after,
        "text": stitched,
    }


# --- Boundary-aware, always-on citation completion -------------------
#
# get_citation_context() above is the *manual* "Show more context" path:
# a fixed, small window, fetched only when the user clicks. It doesn't
# solve the actual problem - a citation's raw extract can start or end
# mid-sentence (or, worse, mid-clause of a single long sentence, e.g.
# "...permitted development rights do not apply unless" cut right before
# the exception that reverses the sentence's meaning) - because most
# citations are *never* expanded, so most cut-off text is simply never
# fixed. A legal/policy clause read incomplete can read as saying the
# opposite of what it actually says, so this can't be opt-in.
#
# get_complete_citation_text() is the fix: called for every citation
# by default (see answer.py's build_context()), not behind a click. It
# walks as many neighboring same-document chunks as it takes (bounded,
# so one malformed document can't pull in the whole file) to reach a
# genuine sentence boundary on each side, then trims the stitched
# passage to exactly that boundary - so what's shown is always whole
# sentences, never a fragment. When a boundary genuinely can't be found
# within the cap (extremely long unbroken sentence, or a run of
# malformed/OCR'd text with no punctuation), it says so honestly via
# complete_before/complete_after rather than silently presenting a still
# -incomplete passage as whole.

# A capital letter, a digit (numbered clause, e.g. "12.3(a)"), an
# opening quote/bracket, or a bullet/dash marker - what a genuine
# sentence or clause is expected to start with. Anything else (a
# lowercase letter, mid-word) means the text in hand continues a
# sentence that started earlier, off the front of what's shown.
_SENTENCE_START_RE = re.compile(r'^[A-Z0-9"‘’“(\[•–—\-]')

# A boundary between one sentence and the next: terminal punctuation,
# an optional closing quote/bracket, then whitespace (or end of text).
_SENTENCE_BOUNDARY_RE = re.compile(r'[.!?][\'")’”\]]*(?:\s+|$)')

# Mirrors ExpandableCitation.tsx's looksTruncated() tail heuristic
# (dangling conjunction, open paren, trailing colon/comma, a bare list-
# item number) so the server and the client agree on what "ends cleanly"
# means - kept in sync deliberately rather than factored out, since one
# lives in Python and the other in TypeScript.
_DANGLING_TAIL_RE = re.compile(
    r'\b(and|or|to|of|for|with|including|which|that|where|when|if|than|'
    r'see|paragraph|paragraphs)$',
    re.IGNORECASE,
)
_LIST_STUB_RE = re.compile(r'^(\d+\.|[a-z]\.)$', re.IGNORECASE)

# Safety caps on how far get_complete_citation_text() will walk/grow -
# generous enough to recover a genuinely long sentence, small enough
# that a document with no punctuation for pages can't balloon a single
# citation into half the file.
MAX_EXPANSION_CHUNKS = 6
MAX_EXPANSION_CHARS = 6000


def _starts_cleanly(text):
    t = text.lstrip()
    return not t or bool(_SENTENCE_START_RE.match(t))


def _ends_cleanly(text):
    t = text.rstrip()
    if not t:
        return True
    last_line = t.splitlines()[-1].strip()
    if _DANGLING_TAIL_RE.search(last_line):
        return False
    if re.search(r'[:;,(-]$', last_line):
        return False
    if _LIST_STUB_RE.match(last_line):
        return False
    return bool(re.search(r'[.!?"’”)\]]$', last_line))


# --- Sentence-span detection: SaT model when available, regex fallback ---
#
# _trim_to_sentence_start()/_trim_to_sentence_end() below need to find
# real sentence boundaries inside an already-expanded passage, not just
# decide whether the target chunk's own edge looks clean (that's still
# _starts_cleanly()/_ends_cleanly() above - a separate, cheaper check).
# A plain terminal-punctuation regex misreads plenty of real UK planning
# text: "Section 12.3(a)" and "Policy DM1." both contain periods that
# aren't sentence ends, and OCR/PDF-extracted text drops punctuation
# entirely often enough to matter. wtpsplit's SaT models segment text
# with a small transformer instead of punctuation rules and are
# noticeably more robust on exactly this kind of messy source text -
# see https://github.com/segment-any-text/wtpsplit. It's an optional
# dependency (pip install wtpsplit): _load_sentence_segmenter() returns
# None if it isn't installed or fails to load, and _sentence_spans()
# falls back to the regex splitter in that case, so nothing here
# breaks if the package is absent - this is a purely additive upgrade.

@functools.lru_cache(maxsize=1)
def _load_sentence_segmenter():
    """Lazily loads wtpsplit's SaT sentence-boundary model, once per
    process, mirroring _load_embedder()/_load_reranker() below. Returns
    None (cached, so this is only attempted once) if the optional
    wtpsplit package isn't installed, or if the model fails to load for
    any reason - callers must treat None as "use the regex fallback",
    never raise on it."""
    try:
        from wtpsplit import SaT
    except ImportError:
        return None
    try:
        # sat-3l-sm: the small 3-layer SaT checkpoint - accurate enough
        # for this job and light enough to run on CPU per-request
        # without a noticeable latency hit, same "small model, CPU,
        # negligible per-query cost" reasoning as _load_embedder()'s
        # device="cpu" choice below.
        return SaT("sat-3l-sm")
    except Exception:
        logger.warning(
            "wtpsplit is installed but its SaT model failed to load - "
            "falling back to the regex sentence splitter for citation "
            "boundary trimming.", exc_info=True,
        )
        return None


def _regex_sentence_spans(text):
    """Splits `text` into (start, end) character spans using the plain
    terminal-punctuation regex - the fallback used when wtpsplit isn't
    installed or its model didn't load. Covers the whole string with no
    gaps, same contract _sentence_spans() promises its callers."""
    spans = []
    start = 0
    for m in _SENTENCE_BOUNDARY_RE.finditer(text):
        spans.append((start, m.end()))
        start = m.end()
    if start < len(text):
        spans.append((start, len(text)))
    return spans


def _sentence_spans(text):
    """Returns a list of (start, end) character offsets, one per
    detected sentence, covering the whole of `text` with no gaps. Uses
    the SaT model via _load_sentence_segmenter() when available for
    real sentence-boundary detection on messy source text; falls back
    to _regex_sentence_spans() otherwise (or if segmentation itself
    raises - a segmenter hiccup on one citation shouldn't break the
    citation, just make it fall back to the coarser splitter)."""
    if not text:
        return []
    segmenter = _load_sentence_segmenter()
    if segmenter is not None:
        try:
            sentences = [s for s in segmenter.split(text) if s.strip()]
            spans = []
            pos = 0
            for s in sentences:
                idx = text.index(s.strip(), pos)
                spans.append((idx, idx + len(s.strip())))
                pos = idx + len(s.strip())
            if spans:
                return spans
        except Exception:
            logger.warning(
                "SaT sentence segmentation failed on a citation passage - "
                "falling back to the regex splitter for this call.",
                exc_info=True,
            )
    return _regex_sentence_spans(text)


def _trim_to_sentence_start(text):
    """Drops any leading sentence fragment, keeping only whole sentences
    from the second detected sentence span onward (the first span is
    treated as the fragment, since _starts_cleanly() already ruled out
    the case where it's a genuine whole sentence). Returns
    (trimmed_text, found_boundary) - found_boundary is False if there
    was only one sentence span to find (no real boundary to trim to),
    meaning the caller should not claim completeness."""
    if _starts_cleanly(text):
        return text, True
    spans = _sentence_spans(text)
    if len(spans) < 2:
        return text, False
    return text[spans[1][0]:], True


def _trim_to_sentence_end(text):
    """Drops any trailing sentence fragment, keeping only whole sentences
    up to the second-to-last detected sentence span (the last span is
    treated as the fragment, mirroring _trim_to_sentence_start() above).
    Returns (trimmed_text, found_boundary) with the same honesty
    contract."""
    if _ends_cleanly(text):
        return text, True
    spans = _sentence_spans(text)
    if len(spans) < 2:
        return text, False
    return text[:spans[-2][1]].rstrip(), True


def get_complete_citation_text(
    chunk_id, max_expansion_chunks=MAX_EXPANSION_CHUNKS, max_expansion_chars=MAX_EXPANSION_CHARS
):
    """Sentence-complete evidence text for one citation: the target
    chunk, expanded with as many neighboring same-document chunks as it
    takes (within the caps above) to reach a genuine sentence boundary
    on each side, then trimmed to exactly those boundaries. Returns None
    if chunk_id isn't a known chunk - same contract as
    get_citation_context()."""
    chunks = _load_chunk_texts()
    chunk_id = str(chunk_id)
    target = chunks.get(chunk_id)
    if target is None:
        return None
    try:
        target_idx = int(chunk_id)
    except ValueError:
        return None

    sha = target.get("sha256")

    def walk(step):
        collected = []
        idx = target_idx
        for _ in range(max(0, max_expansion_chunks)):
            idx += step
            neighbor = chunks.get(f"{idx:08d}")
            if neighbor is None or neighbor.get("sha256") != sha:
                break
            collected.append(neighbor)
        return collected

    text = target["text"]
    before_chunks = []
    after_chunks = []
    complete_before = _starts_cleanly(text)
    complete_after = _ends_cleanly(text)

    if not complete_before:
        before_chunks = list(reversed(walk(-1)))
        stitched_before = None
        for c in before_chunks:
            stitched_before = (
                c["text"] if stitched_before is None else _merge_overlap(stitched_before, c["text"])
            )
        combined = _merge_overlap(stitched_before, text) if stitched_before else text
        trimmed, found = _trim_to_sentence_start(combined)
        if len(trimmed) - len(text) > max_expansion_chars:
            # Hit the cap before a real boundary showed up - keep the
            # capped amount of extra context, but don't claim it's whole.
            trimmed = trimmed[-(max_expansion_chars + len(text)):]
            found = False
        text = trimmed
        complete_before = found

    if not complete_after:
        after_chunks = walk(1)
        stitched_after = None
        for c in after_chunks:
            stitched_after = (
                c["text"] if stitched_after is None else _merge_overlap(stitched_after, c["text"])
            )
        combined = _merge_overlap(text, stitched_after) if stitched_after else text
        trimmed, found = _trim_to_sentence_end(combined)
        if len(trimmed) - len(text) > max_expansion_chars:
            trimmed = trimmed[: len(text) + max_expansion_chars]
            found = False
        text = trimmed
        complete_after = found

    ordered = before_chunks + [target] + after_chunks
    return {
        "chunk_id": chunk_id,
        "doc_filename": target["doc_filename"],
        "page_start": ordered[0]["page"],
        "page_end": ordered[-1]["page"],
        "expanded_before": len(before_chunks) > 0,
        "expanded_after": len(after_chunks) > 0,
        "complete_before": complete_before,
        "complete_after": complete_after,
        "text": text,
    }


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
    # 2026-09-28 determinism pass: explicit tie-break on chunk_id so two
    # chunks scoring identically never depend on incidental index order
    # (this was already effectively stable via range()'s own ascending
    # order + Python's stable sort, but that was incidental, not a
    # documented guarantee - making it explicit here matches the same
    # treatment given to every other ranking step below).
    ranked = sorted(
        range(len(scores)), key=lambda i: (-scores[i], chunk_ids[i]),
    )[:top_k]
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
    # 2026-09-28 determinism pass: explicit chunk_id tie-break (see
    # _sparse_search()'s own comment on this same change) rather than
    # relying on dict insertion order alone to be deterministic.
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))


def _log_retrieval_debug(query, results, coverage, domain_filter=None, geography_filter=None):
    """LOCAL_RAG_DEBUG_RETRIEVAL=1 (see common.py) - prints, for one
    retrieve() call: the query, every retrieved chunk in its final
    RERANKED ORDER with its cross-encoder SCORE, SOURCE ID (doc_filename)
    and PAGE NUMBER, and the coverage/confidence verdict retrieve()
    computed from them. This is the retrieval half of the debug mode the
    2026-09-29 Cloud-vs-Local retrieval-parity investigation asked for -
    see answer.py's _log_context_debug() for the other half (what of
    this actually reached the model's final context). Never called
    unless the env var is set - zero cost/behavior change otherwise."""
    logger.info("=== LOCAL_RAG_DEBUG_RETRIEVAL: retrieve() ===")
    logger.info("QUERY: %r", query)
    if domain_filter or geography_filter:
        logger.info(
            "FILTERS: domain_filter=%r geography_filter=%r",
            domain_filter, geography_filter,
        )
    if not results:
        logger.info("RETRIEVED CHUNKS: none")
    for rank, chunk in enumerate(results, start=1):
        logger.info(
            "RERANKED ORDER #%d: chunk_id=%s score=%.4f source_id=%s page=%s "
            "domain=%s status=%s text_preview=%r",
            rank,
            chunk.get("chunk_id"),
            chunk.get("rerank_score", 0.0),
            chunk.get("doc_filename"),
            chunk.get("page"),
            chunk.get("domain"),
            chunk.get("status"),
            (chunk.get("text") or "")[:160],
        )
    logger.info(
        "COVERAGE: confidence=%s top_rerank_score=%s source_count=%s "
        "reasons=%s broadened_from_top_k=%s",
        coverage.get("confidence"),
        coverage.get("top_rerank_score"),
        coverage.get("source_count"),
        coverage.get("reasons"),
        coverage.get("broadened_from_top_k"),
    )


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

    # 2026-09-28 determinism pass: explicit chunk_id tie-break, same
    # reasoning as _sparse_search()/_reciprocal_rank_fusion() above.
    candidates.sort(key=lambda cs: (-cs[1], cs[0]["chunk_id"]))
    candidates = candidates[:top_k]
    if not candidates:
        return []

    reranker = _load_reranker()
    pairs = [(query, c["text"]) for c, _ in candidates]
    cross_scores = reranker.predict(pairs)
    # 2026-09-28 determinism pass: explicit chunk_id tie-break. Matters
    # more here than upstream - two distinct chunks scoring identically
    # (or within float noise of each other) on the cross-encoder is a
    # real, observed case, not just a theoretical one, since it's a much
    # coarser model than the dense/sparse scores feeding it.
    reranked = sorted(
        zip(candidates, cross_scores),
        key=lambda x: (-float(x[1]), x[0][0]["chunk_id"]),
    )

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
        if DEBUG_RETRIEVAL:
            _log_retrieval_debug(
                query, wider_results, wider_coverage, domain_filter, geography_filter
            )
        return wider_results, wider_coverage

    coverage["broadened_from_top_k"] = None
    if DEBUG_RETRIEVAL:
        _log_retrieval_debug(query, results, coverage, domain_filter, geography_filter)
    return results, coverage
