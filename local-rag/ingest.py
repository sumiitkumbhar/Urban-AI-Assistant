#!/usr/bin/env python3
"""One-time (re-run whenever the corpus changes) ingestion pipeline.

Run this from your own Terminal, inside this folder's venv:

    source venv/bin/activate
    python3 ingest.py

What it does, matching sections 37/39/40 of the architecture README:

  1. Reads corpus_manifest.json (the Phase-1 triage) and ingests every
     file EXCEPT confirmed exact-duplicate copies (byte-identical PDFs
     the triage flagged with a `duplicate_group` - indexing the same
     text twice under two filenames just pads out every result list with
     a redundant hit). This is a deliberate widening from the original
     ACTIVE_CORE/ACTIVE_SUPPORTING-only default (76 of 202 files) to "all
     of it" per an explicit later request - it now also pulls in
     REFERENCE_ONLY material (historic/superseded policy versions,
     consultation drafts, conservation-area audits for areas with no
     chosen demo site yet) and the handful of unlabeled "data-N.pdf"
     files. Each chunk still carries the manifest's `status` field
     (current/historic/superseded/consultation/etc, per README section
     20), so a future retrieval pass can filter or de-prioritize
     non-current material - retrieve.py doesn't do that yet, so right
     now a historic and a current version of the same policy can both
     come back for the same query with no automatic preference between
     them. Non-PDF files (the .xlsx/.xlsm biodiversity-metric calculator
     tools) are still attempted but will fail to open as a PDF and get
     logged as a WARN + skipped - they need a spreadsheet-specific
     extraction path this pipeline doesn't have, not PDF text chunking.
  2. Extracts text page-by-page with pypdf, splits it into ~1000-char
     overlapping chunks, and keeps the source page number on every chunk
     (this is an MVP paragraph/page chunker, not the structure-aware
     chapter/section/clause detector the README describes as the target -
     upgrading that is a good next increment once this baseline works).
  3. Writes every chunk + its metadata to data/chunks.jsonl - the single
     source of truth both indexes below are built from, so either index
     can be rebuilt independently without re-parsing every PDF.
  4. Embeds every NEW or changed chunk with a local sentence-transformers
     model - a persistent embedding_cache.pkl (keyed by each chunk's own
     text hash) means a chunk whose exact text was already embedded in a
     prior run is reused rather than recomputed - then writes every
     chunk's vector (cached or fresh) into a local (no server, no Docker)
     Qdrant collection on disk under data/qdrant/.
  5. Builds a BM25 lexical index over the same chunks and pickles it to
     data/bm25_index.pkl - this is the "sparse/lexical search" half of
     the hybrid retrieval in section 9, needed because dense embeddings
     alone are unreliable for exact references like "Policy D3".

Safe to re-run, and genuinely incremental as of 2026-09-17: text
extraction (build_chunks(), cached in data/extraction_cache.pkl, keyed by
each file's own sha256 - already computed by both corpus_manifest.json
and council_ingest.py) and embedding (build_qdrant_index(), cached in
data/embedding_cache.pkl, keyed by each chunk's own text) are both
skipped for any file/chunk whose content hasn't changed since the last
successful run - a re-run after downloading N more council PDFs only
pays the real PDF-parsing/embedding cost for those N, not the hundreds
already indexed. The Qdrant collection, BM25 index, and reference graph
are still rebuilt from scratch every run regardless of caching (cheap
relative to extraction/embedding - upserting already-known vectors and
rebuilding BM25/the graph from the full chunk set is seconds, not
minutes), so there's never a risk of the index drifting out of sync with
chunks.jsonl, and no separate "resume" code path that could itself go
stale. Both caches are versioned (chunking params / embedding model
name, see load_extraction_cache()/load_embedding_cache()) so a config
change that would invalidate old cached data discards the whole cache
automatically rather than silently serving stale chunks/vectors. Delete
data/extraction_cache.pkl and/or data/embedding_cache.pkl by hand to
force a full from-scratch rebuild if ever needed (e.g. suspected
corruption) - everything downstream tolerates an empty/missing cache the
same as a first-ever run.
"""

import hashlib
import json
import pickle
import re
import shutil
import sys
import time
from pathlib import Path

from pypdf import PdfReader
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer

from common import (
    CORPUS_DIR, MANIFEST_PATH, DATA_DIR, CHUNKS_PATH, QDRANT_PATH, BM25_PATH,
    GRAPH_PATH, QDRANT_COLLECTION, EMBEDDING_MODEL_NAME, EMBEDDING_DIM,
    CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS, MAP_GRAPHIC_FILENAMES,
    MAP_DOCUMENTS_PATH, EXTRACTION_CACHE_PATH, EMBEDDING_CACHE_PATH,
)
from graph_build import build_graph, save_graph

INGEST_LOG = DATA_DIR / "ingest.log"


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(INGEST_LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_manifest():
    if not MANIFEST_PATH.exists():
        log(f"ERROR: manifest not found at {MANIFEST_PATH}")
        sys.exit(1)
    with open(MANIFEST_PATH) as f:
        rows = json.load(f)
    # Everything except confirmed exact-duplicate copies - see the module
    # docstring for why this is wider than the original ACTIVE_CORE/
    # ACTIVE_SUPPORTING-only default.
    active = [r for r in rows if not r.get("duplicate_group")]
    skipped = len(rows) - len(active)
    from collections import Counter
    bucket_counts = Counter(r["bucket"] for r in active)
    log(f"manifest loaded: {len(rows)} total files, {len(active)} eligible for ingestion "
        f"(skipping {skipped} confirmed exact-duplicate copies) - by bucket: "
        f"{dict(bucket_counts)}")
    return active


def load_council_manifest():
    """UK council Local Plans downloaded by council_ingest.py (data/
    council_manifest.json) - a separate, additive track from the curated
    corpus_manifest.json above. Returns [] if council_ingest.py hasn't
    been run yet (or found nothing to download), so this is a no-op for
    anyone who hasn't touched that script - the existing corpus-only
    pipeline is unaffected."""
    from common import COUNCIL_MANIFEST_PATH  # local import: optional dependency
    if not COUNCIL_MANIFEST_PATH.exists():
        return []
    with open(COUNCIL_MANIFEST_PATH) as f:
        rows = json.load(f)
    if rows:
        log(f"council manifest loaded: {len(rows)} council Local Plan(s) "
            f"(from council_ingest.py, see data/council_download_status.json)")
    return rows


def extract_pages(pdf_path):
    """Yields (page_number, text) for every page with extractable text.
    Scanned/image-only pages come back empty and are skipped - this
    corpus is almost entirely text-native PDFs (GOV.UK exports, council
    SPDs), so OCR wasn't built for this first pass.

    Some GOV.UK PDFs (e.g. Approved Document exports) are AES-encrypted
    for permissions (no owner password needed to read them, but pypdf
    still needs the `cryptography` package to decrypt the object stream -
    it's in requirements.txt for that reason). len(reader.pages) is what
    actually triggers that decryption, not PdfReader() itself, so it has
    to be inside this try too or a single encrypted/corrupt file kills
    the whole ingestion run instead of just being skipped."""
    try:
        reader = PdfReader(str(pdf_path))
        num_pages = len(reader.pages)
    except Exception as e:
        log(f"  WARN: could not open {pdf_path.name}: {e}")
        return
    for i in range(1, num_pages + 1):
        try:
            text = reader.pages[i - 1].extract_text() or ""
        except Exception as e:
            log(f"  WARN: page {i} of {pdf_path.name} failed to extract: {e}")
            continue
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if text:
            yield i, text


def chunk_page_text(text, target=CHUNK_TARGET_CHARS, overlap=CHUNK_OVERLAP_CHARS):
    """Paragraph-aware sliding window: builds chunks out of whole
    paragraphs so a chunk boundary doesn't land mid-sentence when
    avoidable, falling back to a hard character split for a single
    paragraph longer than the target on its own."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        paragraphs = [text]

    chunks = []
    current = ""
    for para in paragraphs:
        if len(para) > target * 2:
            if current:
                chunks.append(current)
                current = ""
            for i in range(0, len(para), target):
                chunks.append(para[i:i + target])
            continue
        candidate = (current + "\n\n" + para) if current else para
        if len(candidate) > target and current:
            chunks.append(current)
            # keep a tail of the previous chunk as overlap for continuity
            tail = current[-overlap:] if len(current) > overlap else current
            current = tail + "\n\n" + para
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def _text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_extraction_cache():
    """Per-file cache of already-extracted-and-chunked (page, text) pieces,
    keyed by the file's own content sha256. Lets a re-run skip PDF
    parsing entirely for any file whose bytes haven't changed since the
    last successful run - the common case once new council PDFs are just
    being added to an already-indexed pile, not replacing it. Versioned
    by the current chunking parameters so an edit to
    CHUNK_TARGET_CHARS/CHUNK_OVERLAP_CHARS (or the chunker logic itself)
    can't silently keep serving chunks built under different settings -
    any mismatch discards the whole cache rather than trusting stale
    data. A missing/corrupt cache file is treated the same as an empty
    one (first-run behaviour), never a fatal error."""
    if not EXTRACTION_CACHE_PATH.exists():
        return {}
    try:
        with open(EXTRACTION_CACHE_PATH, "rb") as f:
            saved = pickle.load(f)
        if saved.get("params") != (CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS):
            log("extraction cache: chunking parameters changed since it was built - "
                "discarding, will re-extract every file this run")
            return {}
        return saved.get("entries", {})
    except Exception as e:
        log(f"  WARN: could not load extraction cache ({e}), starting fresh")
        return {}


def save_extraction_cache(entries):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(EXTRACTION_CACHE_PATH, "wb") as f:
        pickle.dump({"params": (CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS), "entries": entries}, f)


def load_embedding_cache():
    """Per-chunk-text cache of already-computed embedding vectors, keyed
    by a hash of the chunk's own text - robust even if a file's chunk
    boundaries shift slightly, since it's the content that's cached, not
    a file/position identity. This is what skips the actually expensive
    step (the sentence-transformers forward pass) for any chunk whose
    exact text was embedded in a prior run. Versioned by
    EMBEDDING_MODEL_NAME so switching models can't silently mix vectors
    from two different embedding spaces into the same collection."""
    if not EMBEDDING_CACHE_PATH.exists():
        return {}
    try:
        with open(EMBEDDING_CACHE_PATH, "rb") as f:
            saved = pickle.load(f)
        if saved.get("model") != EMBEDDING_MODEL_NAME:
            log("embedding cache: embedding model changed since it was built - "
                "discarding, will re-embed every chunk this run")
            return {}
        return saved.get("entries", {})
    except Exception as e:
        log(f"  WARN: could not load embedding cache ({e}), starting fresh")
        return {}


def save_embedding_cache(entries):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(EMBEDDING_CACHE_PATH, "wb") as f:
        pickle.dump({"model": EMBEDDING_MODEL_NAME, "entries": entries}, f)


def split_out_map_documents(active_files):
    """Separates pure map-graphic PDFs (MAP_GRAPHIC_FILENAMES - see
    common.py for why these are excluded from text chunking) from
    everything that should go through the normal extract/chunk/embed
    pipeline below. Returns (text_files, map_files)."""
    text_files = [r for r in active_files if r["filename"] not in MAP_GRAPHIC_FILENAMES]
    map_files = [r for r in active_files if r["filename"] in MAP_GRAPHIC_FILENAMES]
    return text_files, map_files


def write_map_documents(map_files):
    """Sidecar index of map-graphic PDFs that were excluded from the text
    index, for the planned visual-citation feature (attach the real map
    next to a GIS conservation-area/policy-area lookup result instead of
    text-searching it) - not consumed by anything yet, but keeps the list
    in one machine-readable place rather than re-deriving it later."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "filename": r["filename"],
            "doc_type": r["doc_type"],
            "domain": r["domain"],
            "geography": r["geography"],
            "bucket": r["bucket"],
        }
        for r in map_files
    ]
    with open(MAP_DOCUMENTS_PATH, "w") as f:
        json.dump(records, f, indent=2)
    log(f"wrote {len(records)} map-graphic documents to {MAP_DOCUMENTS_PATH} "
        f"(excluded from text index - visual reference only)")


def build_chunks(active_files):
    chunks = []
    extraction_cache = load_extraction_cache()
    cache_dirty = False
    reused_files = 0
    for i, row in enumerate(active_files, start=1):
        # Council files (council_ingest.py) store an absolute path already
        # (they live under data/council_pdfs/, not the curated CORPUS_DIR);
        # the original corpus's filenames are always relative to CORPUS_DIR.
        raw_path = Path(row["filename"])
        path = raw_path if raw_path.is_absolute() else CORPUS_DIR / row["filename"]
        if not path.exists():
            log(f"  WARN: {row['filename']} listed in manifest but not found in {CORPUS_DIR}")
            continue

        # Doc-level metadata (display_name/bucket/status/domain/geography/
        # doc_type) always comes fresh from `row` below, cache hit or not -
        # only the expensive PDF-parse-and-chunk step is what gets skipped.
        # This is deliberate: it's exactly what would have prevented the
        # earlier manifest-staleness bug (a citation-name fix not taking
        # effect until a full re-run) from being possible in the first
        # place, rather than reintroducing that risk via caching.
        file_hash = row.get("sha256")
        cached_pieces = extraction_cache.get(file_hash) if file_hash else None
        if cached_pieces is not None:
            log(f"[{i}/{len(active_files)}] {row['filename']}: unchanged (sha256 matches a prior run) - "
                f"reusing {len(cached_pieces)} cached chunk(s), skipping re-extraction")
            pieces = cached_pieces
            reused_files += 1
        else:
            log(f"[{i}/{len(active_files)}] extracting {row['filename']}")
            pieces = []
            try:
                for page_num, page_text in extract_pages(path):
                    for piece in chunk_page_text(page_text):
                        pieces.append((page_num, piece))
            except Exception as e:
                # One bad file should never sink a 76-file run - log it and
                # move on rather than losing everything already extracted.
                log(f"  WARN: {row['filename']} failed unexpectedly, skipping: {e}")
                pieces = []
            log(f"    -> {len(pieces)} chunks")
            if file_hash and pieces:
                extraction_cache[file_hash] = pieces
                cache_dirty = True

        for page_num, piece in pieces:
            chunk_id = f"{len(chunks):08d}"
            chunks.append({
                "chunk_id": chunk_id,
                "text": piece,
                "doc_filename": row.get("display_name") or row["filename"],
                "page": page_num,
                "bucket": row["bucket"],
                "status": row["status"],
                "domain": row["domain"],
                "geography": row["geography"],
                "doc_type": row["doc_type"],
                "sha256": row["sha256"],
            })

    if reused_files:
        log(f"extraction cache: reused {reused_files}/{len(active_files)} file(s) unchanged since a "
            f"prior run (skipped re-parsing their PDFs entirely)")
    if cache_dirty:
        save_extraction_cache(extraction_cache)
    return chunks


def write_chunks_jsonl(chunks):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(CHUNKS_PATH, "w") as f:
        for c in chunks:
            f.write(json.dumps(c) + "\n")
    log(f"wrote {len(chunks)} chunks to {CHUNKS_PATH}")


def build_qdrant_index(chunks):
    if QDRANT_PATH.exists():
        shutil.rmtree(QDRANT_PATH)
    QDRANT_PATH.mkdir(parents=True, exist_ok=True)

    # Chunk-content-hash cache: only chunks whose exact text was NOT
    # embedded in a prior run need the actual model.encode() call. The
    # Qdrant collection itself is still rebuilt from scratch every run
    # (wiped above) since re-upserting already-known vectors is cheap -
    # only the encode() pass is worth skipping.
    embedding_cache = load_embedding_cache()
    hashes = [_text_hash(c["text"]) for c in chunks]
    to_embed_idx = [i for i, h in enumerate(hashes) if h not in embedding_cache]
    cache_hits = len(chunks) - len(to_embed_idx)
    if cache_hits:
        log(f"embedding cache: reusing {cache_hits}/{len(chunks)} chunk embedding(s) unchanged since "
            f"a prior run - need to embed {len(to_embed_idx)} new/changed chunk(s)")

    if to_embed_idx:
        log(f"loading embedding model {EMBEDDING_MODEL_NAME} (first run downloads it, ~130MB)")
        # device="cpu" is deliberate, not a placeholder - sentence-transformers
        # auto-selects Apple Silicon's MPS backend otherwise, which shares
        # memory with everything else running on the Mac and can hit
        # "MPS backend out of memory" mid-ingestion if other apps are using a
        # lot of RAM at the time (hit for real on 2026-09-15, ~3264/24469
        # chunks in). bge-small is a ~130MB model - CPU encoding is slower but
        # has no shared-memory ceiling to hit, and this only runs once per
        # ingestion, not per query.
        model = SentenceTransformer(EMBEDDING_MODEL_NAME, device="cpu")
        batch_size = 64
        for start in range(0, len(to_embed_idx), batch_size):
            batch_idx = to_embed_idx[start:start + batch_size]
            texts = [chunks[i]["text"] for i in batch_idx]
            # Passages are embedded WITHOUT the query instruction prefix -
            # BGE's asymmetric setup only prefixes the query side (see
            # EMBEDDING_QUERY_PREFIX in common.py / retrieve.py).
            vectors = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
            for i, vec in zip(batch_idx, vectors):
                embedding_cache[hashes[i]] = vec.astype("float32")
            if (start // batch_size) % 10 == 0:
                log(f"  embedded {min(start + batch_size, len(to_embed_idx))}/{len(to_embed_idx)} new chunks")
        save_embedding_cache(embedding_cache)
    else:
        log("embedding cache covered every chunk this run - no model load needed")

    client = QdrantClient(path=str(QDRANT_PATH))
    # QDRANT_PATH was just wiped and recreated above, so there's never an
    # existing collection to replace here - create_collection() is the
    # current, non-deprecated call (recreate_collection() warns it'll be
    # removed, the same way client.search() already was - see retrieve.py).
    client.create_collection(
        collection_name=QDRANT_COLLECTION,
        vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
    )

    upsert_batch_size = 256
    for start in range(0, len(chunks), upsert_batch_size):
        batch = list(zip(chunks[start:start + upsert_batch_size], hashes[start:start + upsert_batch_size]))
        points = [
            PointStruct(id=int(c["chunk_id"]), vector=embedding_cache[h].tolist(), payload=c)
            for c, h in batch
        ]
        client.upsert(collection_name=QDRANT_COLLECTION, points=points)

    log(f"Qdrant collection '{QDRANT_COLLECTION}' built at {QDRANT_PATH} "
        f"({len(chunks)} points total: {cache_hits} reused from the embedding cache, "
        f"{len(to_embed_idx)} newly embedded)")


def build_bm25_index(chunks):
    tokenized = [re.findall(r"[a-z0-9]+", c["text"].lower()) for c in chunks]
    bm25 = BM25Okapi(tokenized)
    with open(BM25_PATH, "wb") as f:
        pickle.dump({"bm25": bm25, "chunk_ids": [c["chunk_id"] for c in chunks]}, f)
    log(f"BM25 index built and saved to {BM25_PATH}")


def main():
    log("=== Urban AI local RAG ingestion starting ===")
    log(f"corpus dir: {CORPUS_DIR}")
    if not CORPUS_DIR.exists():
        log(f"ERROR: corpus dir does not exist: {CORPUS_DIR} "
            f"(set CORPUS_DIR env var if it's somewhere else)")
        sys.exit(1)

    active_files = load_manifest()
    council_files = load_council_manifest()
    active_files += council_files
    text_files, map_files = split_out_map_documents(active_files)
    log(f"{len(map_files)} of {len(active_files)} files are map-graphic PDFs - "
        f"excluded from text chunking (see MAP_GRAPHIC_FILENAMES in common.py), "
        f"{len(text_files)} go through the normal pipeline")
    write_map_documents(map_files)
    chunks = build_chunks(text_files)
    if not chunks:
        log("ERROR: no chunks produced - nothing to index. Check the warnings above.")
        sys.exit(1)
    write_chunks_jsonl(chunks)
    build_qdrant_index(chunks)
    build_bm25_index(chunks)

    # Graph RAG (architecture plan section 52) - built from the same
    # in-memory chunks, no extra PDF parsing needed. Additive: dense
    # (semantic/Qdrant) and sparse (BM25) search above are unaffected;
    # this only gives retrieve.py one more optional signal to use.
    reference_graph = build_graph(chunks, log=log)
    save_graph(reference_graph)
    log(f"reference graph saved to {GRAPH_PATH}")

    log(f"=== done: {len(chunks)} chunks from {len(text_files)} documents indexed "
        f"({len(map_files)} map-graphic PDFs excluded, see above) ===")
    log("Try it: python3 query_cli.py \"what does policy d3 say\"")


if __name__ == "__main__":
    main()
