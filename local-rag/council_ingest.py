#!/usr/bin/env python3
"""Downloads UK council Local Plan PDFs for local-rag's own corpus,
reusing the discovery work already done for the Supabase/cloud pipeline
(data/uk-lpa-tracker.csv at the repo root) rather than re-researching
URLs from scratch.

This is a SEPARATE, independent pipeline from scripts/ingest-council-
plans.ts (the Supabase ingestion script) - it does not read or write
that script's own `status` column on the tracker (that column reflects
Supabase-side ingestion state, not local-rag's), and it does not call
Gemini or any external embedding API at all: it only downloads PDFs over
plain HTTP. local-rag's own free, local, CPU-only embedding model
(BAAI/bge-small-en-v1.5, see common.py) does the actual embedding later,
in ingest.py - so this script's progress is completely unaffected by
Gemini's free-tier quota, whatever state that's in on the Supabase side.

Two-step design, mirroring how the GIS package split ingest from lookup,
and how ingest-council-plans.ts's own docs recommend small resumable
batches for a slow, error-prone bulk-download job:

  1. THIS SCRIPT downloads PDFs into data/council_pdfs/ and writes/
     updates data/council_manifest.json - a corpus_manifest.json-shaped
     list (same field names ingest.py already expects) so ingest.py
     needs only a tiny, additive change to pick these up alongside the
     existing curated corpus. Safe to re-run in small batches
     (--limit N, default 5): already-downloaded councils are skipped by
     checking data/council_download_status.json, one bad URL never
     kills the batch (matches ingest-council-plans.ts's own per-row
     try/except), and every row's outcome is saved after every attempt,
     not just at the end.
  2. Run `python3 ingest.py` afterward (same command as always) to
     actually fold this new manifest into the searchable index - ingest.py
     rebuilds the whole index from all currently-known files every time,
     so council PDFs join the existing 185-document Westminster/national
     corpus in one unified Qdrant + BM25 + reference-graph build, not a
     separate index.

Run it from your own Terminal, inside this folder's venv:

    source venv/bin/activate
    python3 council_ingest.py --limit 5

Geography scoping (retrieve.py's geography_filter, commit 91b8f97):
every downloaded council's chunks are tagged geography=<lpa_slug> (e.g.
"durham", "darlington") using the exact same toLpaSlug() logic as the
Supabase pipeline (lib/domain-vocabulary.ts), so `-g durham` in
query_cli.py or the `geography` field in service.py's /query resolves to
the same slug a question would derive on the cloud side too. A council's
chunks are excluded from a *different* council's scoped query, but
national material (doc_type carries no geography tag distinguishing
national from local here - see note in build_council_manifest()) is
handled the same way the rest of the corpus already is: chunks tagged
geography="national" stay in scope for every geography filter.
"""

import csv
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import requests

from common import REPO_DIR, DATA_DIR

TRACKER_PATH = REPO_DIR / "data" / "uk-lpa-tracker.csv"
COUNCIL_PDF_DIR = DATA_DIR / "council_pdfs"
COUNCIL_MANIFEST_PATH = DATA_DIR / "council_manifest.json"
COUNCIL_STATUS_PATH = DATA_DIR / "council_download_status.json"

# Mirrors scripts/ingest-council-plans.ts's own EXCLUDED_DOC_TYPES exactly
# (see that file, and common.py's MAP_GRAPHIC_FILENAMES for the same
# reasoning applied to the main corpus): Policies Map PDFs are
# cartographic, not prose - chunking them produces scrambled street-label
# noise, not useful text. Both pipelines independently arrived at
# excluding this same doc_type, which is a good sign it's the right call.
EXCLUDED_DOC_TYPES = {"local_plan_policies_map"}

REQUEST_TIMEOUT = 60
MAX_RETRIES = 3
RETRY_BACKOFF = [3, 8, 20]  # seconds - only for transient/5xx failures


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def to_lpa_slug(name: str) -> str:
    """Python port of lib/domain-vocabulary.ts's toLpaSlug() - kept
    byte-for-byte equivalent on purpose, so a council's local-rag
    geography tag and its Supabase lpa_slugs entry are always the same
    string. Deriving these independently in two languages is exactly how
    "reading" and "reading-borough" would end up meaning two different
    things in two different systems - see that function's own comment
    for the "Lake District National Park Authority" trailing-suffix-only
    edge case this mirrors."""
    s = name.lower().strip()
    s = re.sub(r"^(london|royal) borough of\s+", "", s)
    s = re.sub(r"^city of\s+", "", s)
    s = re.sub(r"\b(county|borough|district|metropolitan|unitary|city)?\s*council\b", "", s)
    s = re.sub(r"\s+(district|borough)\s*$", "", s)
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+|-+$", "", s)
    return s


def load_tracker_rows():
    if not TRACKER_PATH.exists():
        log(f"ERROR: tracker not found at {TRACKER_PATH}")
        sys.exit(1)
    with open(TRACKER_PATH, newline="") as f:
        return list(csv.DictReader(f))


def load_status():
    if COUNCIL_STATUS_PATH.exists():
        with open(COUNCIL_STATUS_PATH) as f:
            return json.load(f)
    return {}


def save_status(status):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(COUNCIL_STATUS_PATH, "w") as f:
        json.dump(status, f, indent=2, sort_keys=True)


def download_pdf(url):
    """Plain HTTP GET with a small retry for transient/5xx failures only -
    a 404 or a non-PDF response is a permanent failure for that URL and
    retrying it wastes time, matching ingest-council-plans.ts's own
    downloadPdf() behaviour. This has nothing to do with Gemini's
    embedding-API rate limit (a completely different failure class this
    script never touches) - it's the same kind of plain-HTTP-timeout risk
    the GIS ingestion hit against planning.data.gov.uk."""
    last_err = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.get(url, timeout=REQUEST_TIMEOUT, headers={
                "User-Agent": "Mozilla/5.0 (compatible; UrbanAIAssistant-LocalRAG/1.0)"
            })
        except requests.RequestException as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF[attempt])
                continue
            raise
        if resp.status_code >= 500 and attempt < MAX_RETRIES:
            last_err = RuntimeError(f"HTTP {resp.status_code}")
            time.sleep(RETRY_BACKOFF[attempt])
            continue
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} fetching {url}")
        if not resp.content.startswith(b"%PDF-"):
            content_type = resp.headers.get("content-type", "unknown")
            raise RuntimeError(
                f"URL did not return a PDF (content-type: {content_type}) - "
                f"likely a dead link or a page that needs JS/redirects"
            )
        return resp.content
    raise last_err


def parse_args(argv):
    limit = 5
    i = 0
    while i < len(argv):
        if argv[i] == "--limit" and i + 1 < len(argv):
            limit = int(argv[i + 1])
            i += 2
        else:
            i += 1
    return limit


def build_council_manifest(status):
    """Regenerates council_manifest.json from EVERY successfully
    downloaded council in the status file (not just this run's batch) -
    so a manifest built after run 3 still includes what runs 1 and 2
    already downloaded, the same "safe to re-run, rebuild from what's on
    disk" property ingest.py itself has.

    status="unknown" on every record, deliberately - the tracker records
    INGEST status, not adoption status (no column says whether a plan is
    adopted, emerging or superseded), so "unknown" is the only honest
    value here too. Matches the exact same reasoning already applied on
    the Supabase side (see scripts/ingest-council-plans.ts's planStatus
    comment) - copied on purpose, not reinvented."""
    records = []
    for ref, entry in status.items():
        if entry.get("state") != "downloaded":
            continue
        doc_type_label = (entry["doc_type"] or "local_plan").replace("_", " ").title()
        records.append({
            "filename": entry["path"],  # absolute path - used to open the file, see ingest.py's build_chunks()
            # Readable name for citations (ingest.py's build_chunks() uses
            # this for doc_filename instead of the absolute path above,
            # which would otherwise show up verbatim in every citation -
            # "/Users/.../council_pdfs/E60000001.pdf" is useless to read).
            "display_name": f"{entry['organisation_name']} - {doc_type_label}.pdf",
            "size_mb": round(entry["bytes"] / 1024 / 1024, 2),
            "sha256": entry["sha256"],
            "bucket": "COUNCIL_PLAN",
            "status": "unknown",
            "domain": "planning",
            "geography": entry["lpa_slug"],
            "doc_type": entry["doc_type"] or "local_plan",
            "duplicate_group": "",
            "canonical_copy": "",
            "notes": f"UK council Local Plan - {entry['organisation_name']} ({ref})",
        })
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(COUNCIL_MANIFEST_PATH, "w") as f:
        json.dump(records, f, indent=2)
    log(f"wrote {len(records)} council document(s) to {COUNCIL_MANIFEST_PATH}")
    return records


def main():
    limit = parse_args(sys.argv[1:])
    rows = load_tracker_rows()
    status = load_status()

    eligible = [
        r for r in rows
        if r["status"] in ("pending_ingest", "ingested")
        and r["source_url"].strip()
        and r["doc_type"] not in EXCLUDED_DOC_TYPES
        and status.get(r["reference"], {}).get("state") != "downloaded"
    ]
    already_done = sum(1 for e in status.values() if e.get("state") == "downloaded")
    log(f"{len(eligible)} council(s) not yet downloaded for local-rag "
        f"({already_done} already downloaded in prior runs, "
        f"{sum(1 for r in rows if r['status'] == 'error')} skipped as known-bad URLs, "
        f"{sum(1 for r in rows if r['doc_type'] in EXCLUDED_DOC_TYPES)} skipped as Policies Maps)")

    if not eligible:
        log("Nothing left to download. Run ingest.py to (re)build the index if you haven't already.")
        build_council_manifest(status)
        return

    batch = eligible[:limit]
    log(f"Downloading {len(batch)} of {len(eligible)} remaining council(s)...")
    COUNCIL_PDF_DIR.mkdir(parents=True, exist_ok=True)

    for row in batch:
        ref = row["reference"]
        name = (row["lpa_name"] or row["organisation_name"]).strip()
        log(f"=== {row['organisation_name']} ({ref}) ===")
        try:
            content = download_pdf(row["source_url"])
            lpa_slug = to_lpa_slug(name)
            if not lpa_slug or len(lpa_slug) < 3:
                raise RuntimeError(
                    f"Could not derive an LPA slug from \"{name}\" - fix lpa_name "
                    f"in the tracker rather than ingesting a document no geography "
                    f"filter can reach."
                )
            path = COUNCIL_PDF_DIR / f"{ref}.pdf"
            path.write_bytes(content)
            sha256 = hashlib.sha256(content).hexdigest()
            status[ref] = {
                "state": "downloaded",
                "path": str(path.resolve()),
                "bytes": len(content),
                "sha256": sha256,
                "lpa_slug": lpa_slug,
                "doc_type": row["doc_type"],
                "organisation_name": row["organisation_name"],
                "source_url": row["source_url"],
            }
            log(f"  OK: {len(content) / 1024 / 1024:.1f} MB -> {path.name}, "
                f"geography={lpa_slug}")
        except Exception as e:
            status[ref] = {
                "state": "error",
                "notes": str(e)[:500],
                "organisation_name": row["organisation_name"],
                "source_url": row["source_url"],
            }
            log(f"  FAILED: {e}")
        save_status(status)  # after every row, not just at the end

    build_council_manifest(status)

    remaining = len(eligible) - len(batch)
    downloaded_total = sum(1 for e in status.values() if e.get("state") == "downloaded")
    error_total = sum(1 for e in status.values() if e.get("state") == "error")
    log(f"=== Done: {downloaded_total} council(s) downloaded total, {error_total} error(s), "
        f"{remaining} still remaining ===")
    log("Next: run `python3 ingest.py` to fold these into the searchable index "
        "(rebuilds the whole index, existing corpus + councils together).")


if __name__ == "__main__":
    main()
