#!/usr/bin/env python3
"""Downloads a small, fixed set of national building-regulation/fire-
safety/flood-risk documents into local-rag's corpus.

Added 2026-09-17, the day the product decision shifted: the council
Local Plan corpus (42 councils / 200 documents / 51,090 chunks at the
time) was judged sufficient, and further effort goes into covering
national regulatory topics that apply to every site everywhere -
building law, fire safety, flood risk - rather than more individual
council plans. See local-rag-status.md's decision note (same date) for
the full context, and the "flood-risk-zone" entry in gis/gis_common.py's
CONSTRAINT_DATASETS for this pivot's other half (a new site-specific
GIS lookup layer, separate from this text-corpus addition).

Deliberately NOT modeled on council_ingest.py's CSV-tracker/LPA-slug
machinery - there's no discovery problem to solve here. The document
list below is small, fixed, and hand-curated (found via web search
2026-09-17, not fetched/verified directly from this session - this
session's own outbound network is allowlist-restricted and could not
reach any of these hosts to test the URLs live, the same restriction
documented in local-rag-status.md's "Second batch" section). Reuses
council_ingest.py's download_pdf() unchanged, so the exact same safety
net applies here as to every council PDF: a stale/wrong URL fails
loudly with a clear error (wrong content-type, 403, etc) rather than
silently ingesting garbage - the %PDF- magic-byte check catches it.

Every document is tagged geography="national" (the same convention the
NPPF and other national documents in corpus_manifest.json already use)
and status="current" (these are the current, in-force editions as of
when the URL was found - not a legal opinion that no newer amendment
exists; if a document below turns out to be a superseded edition,
correcting doc_type/status here and re-running is the fix, no different
from any other manifest correction in this project). domain is
"building_regulations" - new, since none of the existing domains in
lib/domain-vocabulary.ts cover building control/fire safety
specifically.

Run it (after activating this folder's venv, same as council_ingest.py):
    source venv/bin/activate
    python3 national_docs_ingest.py
    python3 ingest.py
"""

import hashlib
import json
import sys
import time
from pathlib import Path

from common import DATA_DIR, NATIONAL_DOCS_MANIFEST_PATH
from council_ingest import download_pdf, log

NATIONAL_PDF_DIR = DATA_DIR / "national_pdfs"

# Hand-curated 2026-09-17. Each `source_url` was found via web search
# during this session, not fetched/verified directly (see module
# docstring) - treat a download failure here the same as a council PDF
# failure: check the URL by hand in a browser rather than assuming the
# script is broken.
NATIONAL_DOCUMENTS = [
    {
        "doc_id": "approved-document-b-vol1-fire-safety-dwellings",
        "display_name": "Approved Document B - Fire Safety, Volume 1: Dwellings (2019 edition, incorporating 2020 and 2022 amendments)",
        "source_url": "https://assets.publishing.service.gov.uk/media/67d02386f5aaff610c9f5f06/Approved_Document_B__fire_safety__volume_1_-_Dwellings__2019_edition_incorporating_2020_and_2022_amendments.pdf",
        "doc_type": "building_regulations_guidance",
        "notes": "Approved Document under the Building Regulations 2010 - statutory guidance on fire safety for dwellings.",
    },
    {
        "doc_id": "approved-document-b-vol2-fire-safety-non-dwellings",
        "display_name": "Approved Document B - Fire Safety, Volume 2: Buildings other than dwellings (2019 edition, incorporating 2020 and 2022 amendments)",
        "source_url": "https://assets.publishing.service.gov.uk/media/67d02361d5ec5ed9e09f5f07/Approved_Document_B__fire_safety__volume_2_-_Buildings_other_than_dwellings__2019_edition_incorporating_2020_and_2022_amendments.pdf",
        "doc_type": "building_regulations_guidance",
        "notes": "Approved Document under the Building Regulations 2010 - statutory guidance on fire safety for non-dwellings.",
    },
    {
        "doc_id": "merged-approved-documents-oct-2024",
        "display_name": "The Building Regulations - Merged Approved Documents (October 2024 edition, Parts A-S)",
        "source_url": "https://assets.publishing.service.gov.uk/media/6717d29438149ce9d09e3862/The_Merged_Approved_Documents_Oct24.pdf",
        "doc_type": "building_regulations_guidance",
        "notes": "Single combined PDF of every current Approved Document (structure, fire safety, moisture, ventilation, drainage, accessibility, security, etc) - broad 'building laws' coverage in one file. Large (govt asset, not independently size-checked from this session); a one-time extraction/embedding cost, cheap to re-index afterward thanks to the incremental caches.",
    },
    {
        "doc_id": "building-safety-act-2022",
        "display_name": "Building Safety Act 2022 (c. 30)",
        "source_url": "https://www.legislation.gov.uk/ukpga/2022/30/pdfs/ukpga_20220030_en.pdf",
        "doc_type": "primary_legislation",
        "notes": "Post-Grenfell primary legislation establishing the Building Safety Regulator and the higher-risk building regime.",
    },
    {
        "doc_id": "nppf-technical-guidance-flood-risk",
        "display_name": "Technical Guidance to the National Planning Policy Framework",
        "source_url": "https://assets.publishing.service.gov.uk/media/5a79a6a6e5274a684690b1b3/2115548.pdf",
        "doc_type": "planning_practice_guidance",
        "notes": "Companion technical guidance to the NPPF (already in corpus_manifest.json) - covers flood zone definitions and the Sequential Test / Exception Test methodology referenced by the new flood-risk-zone GIS layer.",
    },
]


def load_status():
    if NATIONAL_DOCS_MANIFEST_PATH.exists():
        with open(NATIONAL_DOCS_MANIFEST_PATH) as f:
            rows = json.load(f)
        return {r["doc_id"]: r for r in rows}
    return {}


def save_manifest(status):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    NATIONAL_PDF_DIR.mkdir(parents=True, exist_ok=True)
    rows = list(status.values())
    with open(NATIONAL_DOCS_MANIFEST_PATH, "w") as f:
        json.dump(rows, f, indent=2, sort_keys=True)
    return rows


def main():
    log("=== National regulation document ingestion starting ===")
    status = load_status()

    for doc in NATIONAL_DOCUMENTS:
        doc_id = doc["doc_id"]
        existing = status.get(doc_id)
        if existing and existing.get("state") == "downloaded":
            log(f"{doc_id}: already downloaded, skipping")
            continue

        log(f"{doc_id}: downloading {doc['source_url']}")
        try:
            content = download_pdf(doc["source_url"])
        except Exception as e:
            log(f"  FAILED: {e}")
            status[doc_id] = {
                "doc_id": doc_id,
                "display_name": doc["display_name"],
                "source_url": doc["source_url"],
                "state": "error",
                "notes": str(e),
            }
            continue

        NATIONAL_PDF_DIR.mkdir(parents=True, exist_ok=True)
        path = NATIONAL_PDF_DIR / f"{doc_id}.pdf"
        with open(path, "wb") as f:
            f.write(content)
        sha256 = hashlib.sha256(content).hexdigest()

        status[doc_id] = {
            "doc_id": doc_id,
            "display_name": doc["display_name"],
            "filename": str(path),
            "sha256": sha256,
            "size_mb": round(len(content) / (1024 * 1024), 2),
            "bucket": "NATIONAL_REGULATION",
            "status": "current",
            "domain": "building_regulations",
            "geography": "national",
            "doc_type": doc["doc_type"],
            "duplicate_group": "",
            "canonical_copy": "",
            "source_url": doc["source_url"],
            "notes": doc["notes"],
            "state": "downloaded",
        }
        log(f"  OK: {len(content) / (1024 * 1024):.2f} MB, sha256={sha256[:12]}...")

    rows = save_manifest(status)
    downloaded = [r for r in rows if r.get("state") == "downloaded"]
    errors = [r for r in rows if r.get("state") == "error"]
    log(f"=== done: {len(downloaded)} downloaded, {len(errors)} failed "
        f"(of {len(NATIONAL_DOCUMENTS)} tracked) - manifest written to "
        f"{NATIONAL_DOCS_MANIFEST_PATH} ===")
    if errors:
        log("Failed documents (check the source_url by hand in a browser):")
        for r in errors:
            log(f"  - {r['doc_id']}: {r.get('notes')}")
    log("Next: python3 ingest.py")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
