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
  4. Embeds every chunk with a local sentence-transformers model and
     writes them into a local (no server, no Docker) Qdrant collection on
     disk under data/qdrant/.
  5. Builds a BM25 lexical index over the same chunks and pickles it to
     data/bm25_index.pkl - this is the "sparse/lexical search" half of
     the hybrid retrieval in section 9, needed because dense embeddings
     alone are unreliable for exact references like "Policy D3".

Safe to re-run: it wipes and rebuilds data/ from scratch each time rather
than trying to diff/update in place - simpler, and even at the full ~190
files/~1GB scope a rebuild is minutes, not hours, on a modern Mac CPU.
"""

import json
import pickle
import re
import shutil
import sys
import time

from pypdf import PdfReader
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer

from common import (
    CORPUS_DIR, MANIFEST_PATH, DATA_DIR, CHUNKS_PATH, QDRANT_PATH, BM25_PATH,
    QDRANT_COLLECTION, EMBEDDING_MODEL_NAME, EMBEDDING_DIM,
    CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS,
)

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


def build_chunks(active_files):
    chunks = []
    for i, row in enumerate(active_files, start=1):
        path = CORPUS_DIR / row["filename"]
        if not path.exists():
            log(f"  WARN: {row['filename']} listed in manifest but not found in {CORPUS_DIR}")
            continue
        log(f"[{i}/{len(active_files)}] extracting {row['filename']}")
        doc_chunk_count = 0
        try:
            for page_num, page_text in extract_pages(path):
                for piece in chunk_page_text(page_text):
                    chunk_id = f"{len(chunks):08d}"
                    chunks.append({
                        "chunk_id": chunk_id,
                        "text": piece,
                        "doc_filename": row["filename"],
                        "page": page_num,
                        "bucket": row["bucket"],
                        "status": row["status"],
                        "domain": row["domain"],
                        "geography": row["geography"],
                        "doc_type": row["doc_type"],
                        "sha256": row["sha256"],
                    })
                    doc_chunk_count += 1
        except Exception as e:
            # One bad file should never sink a 76-file run - log it and
            # move on rather than losing everything already extracted.
            log(f"  WARN: {row['filename']} failed unexpectedly, skipping: {e}")
        log(f"    -> {doc_chunk_count} chunks")
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

    log(f"loading embedding model {EMBEDDING_MODEL_NAME} (first run downloads it, ~130MB)")
    model = SentenceTransformer(EMBEDDING_MODEL_NAME)

    client = QdrantClient(path=str(QDRANT_PATH))
    # QDRANT_PATH was just wiped and recreated above, so there's never an
    # existing collection to replace here - create_collection() is the
    # current, non-deprecated call (recreate_collection() warns it'll be
    # removed, the same way client.search() already was - see retrieve.py).
    client.create_collection(
        collection_name=QDRANT_COLLECTION,
        vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
    )

    batch_size = 64
    for start in range(0, len(chunks), batch_size):
        batch = chunks[start:start + batch_size]
        texts = [c["text"] for c in batch]
        # Passages are embedded WITHOUT the query instruction prefix -
        # BGE's asymmetric setup only prefixes the query side (see
        # EMBEDDING_QUERY_PREFIX in common.py / retrieve.py).
        vectors = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
        points = [
            PointStruct(id=int(c["chunk_id"]), vector=vec.tolist(), payload=c)
            for c, vec in zip(batch, vectors)
        ]
        client.upsert(collection_name=QDRANT_COLLECTION, points=points)
        if (start // batch_size) % 10 == 0:
            log(f"  embedded {min(start + batch_size, len(chunks))}/{len(chunks)} chunks")

    log(f"Qdrant collection '{QDRANT_COLLECTION}' built at {QDRANT_PATH} "
        f"({len(chunks)} points)")


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
    chunks = build_chunks(active_files)
    if not chunks:
        log("ERROR: no chunks produced - nothing to index. Check the warnings above.")
        sys.exit(1)
    write_chunks_jsonl(chunks)
    build_qdrant_index(chunks)
    build_bm25_index(chunks)
    log(f"=== done: {len(chunks)} chunks from {len(active_files)} documents indexed ===")
    log("Try it: python3 query_cli.py \"what does policy d3 say\"")


if __name__ == "__main__":
    main()
