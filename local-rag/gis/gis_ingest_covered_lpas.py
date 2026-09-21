"""Expands GIS constraint-layer coverage from Westminster-only to every
local planning authority local-rag's own text corpus already covers
(local-rag/data/council_manifest.json's council PDFs, as of 2026-09-21 -
42 councils at the time this was written, on top of the separately
curated Westminster corpus). Motivation: a /site-answer for a council
whose text corpus already has real policy documents but whose GIS layer
still says "not ingested for this area" is a strictly worse experience
than either being consistently covered or consistently not - this closes
that gap using the same per-LPA ingestion gis_ingest.py already does for
Westminster, just looped across every council the corpus knows about.

Looks up each council's Planning Data entity ID from the LOCAL
local_planning_authorities table (already ingested nationally by a
plain `gis_ingest.py` run - see that table's own schema.sql comment)
rather than a live search API call, since the reference -> entity
mapping already sits in this machine's own Postgres and a live lookup
per council would just be 42 extra, avoidable network round-trips.

Resumable by design, not by a separate state file: before ingesting a
(dataset, LPA) pair, checks gis_coverage for an existing row and skips
it unless --force is given - reusing the exact table gis_ingest.py
itself already writes to record what's been ingested. Re-running this
script after an interruption (network blip, Ctrl-C, closed laptop) just
picks up where it left off; --force re-ingests everything regardless
(useful after a schema/field change to one of the constraint datasets).

This is a genuinely long-running, network-bound job - 9 constraint
datasets x ~42 councils, each dataset paginated at gis_ingest.py's
PAGE_LIMIT with a polite delay between pages (see that module's own
rate-limiting comment) - expect this to take a while; it prints
progress per (LPA, dataset) pair so a long run stays visibly alive
rather than looking hung.

    python3 gis_ingest_covered_lpas.py             # every covered council
    python3 gis_ingest_covered_lpas.py --limit 5   # first 5 councils only, for a quick test
    python3 gis_ingest_covered_lpas.py --force     # re-ingest even already-covered (dataset, LPA) pairs
"""

import argparse
import json
from pathlib import Path

from gis_common import CONSTRAINT_DATASETS, get_conn
from gis_ingest import ingest_constraint_dataset

LOCAL_RAG_DIR = Path(__file__).resolve().parent.parent
MANIFEST_PATH = LOCAL_RAG_DIR / "data" / "council_manifest.json"


def _covered_councils():
    """Distinct (geography, reference) pairs from council_manifest.json,
    in filename order (stable, matches how councils were actually
    ingested into the text corpus). A manifest entry's `filename` stem
    is the Planning Data reference used when it was first downloaded
    (e.g. E60000001.pdf) - see council_ingest.py."""
    if not MANIFEST_PATH.exists():
        return []
    with open(MANIFEST_PATH) as f:
        data = json.load(f)
    seen = set()
    out = []
    for d in data:
        reference = Path(d["filename"]).stem
        geography = d.get("geography")
        if reference in seen:
            continue
        seen.add(reference)
        out.append((geography, reference))
    return out


def _lookup_entities(references):
    """reference -> (entity, name) for every given reference, via the
    local local_planning_authorities table - no live API call needed,
    this data was already ingested nationally. References with no local
    match are simply absent from the returned dict (reported by the
    caller, not raised - one bad/renamed reference shouldn't abort the
    whole run)."""
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT reference, entity, name FROM local_planning_authorities "
                    "WHERE reference = ANY(%s)",
                    (references,),
                )
                return {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    finally:
        conn.close()


def _already_covered(dataset, lpa_entity):
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM gis_coverage WHERE dataset = %s AND lpa_entity = %s",
                    (dataset, lpa_entity),
                )
                return cur.fetchone() is not None
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="Only ingest the first N covered councils (for a quick test)")
    parser.add_argument("--force", action="store_true", help="Re-ingest even (dataset, LPA) pairs already in gis_coverage")
    args = parser.parse_args()

    councils = _covered_councils()
    if args.limit:
        councils = councils[: args.limit]

    if not councils:
        print(f"No councils found in {MANIFEST_PATH} - nothing to do.")
        return

    references = [ref for _geo, ref in councils]
    entities = _lookup_entities(references)

    missing = [ref for ref in references if ref not in entities]
    if missing:
        print(
            f"WARNING: {len(missing)} reference(s) from council_manifest.json "
            f"have no match in the local local_planning_authorities table - "
            f"skipping these (run gis_ingest.py's national LPA-boundary "
            f"refresh if this list looks wrong): {', '.join(missing)}"
        )

    todo = [(geo, ref, *entities[ref]) for geo, ref in councils if ref in entities]
    print(f"\n{len(todo)} council(s) to process x {len(CONSTRAINT_DATASETS)} constraint datasets.\n")

    skipped = 0
    ingested = 0
    for i, (geography, reference, entity, name) in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {name} ({geography}, entity {entity})")
        for dataset, cfg in CONSTRAINT_DATASETS.items():
            if not args.force and _already_covered(dataset, entity):
                print(f"  {dataset}: already covered, skipping (use --force to re-ingest)")
                skipped += 1
                continue
            ingest_constraint_dataset(dataset, cfg, entity, name)
            ingested += 1

    print(f"\nDone. {ingested} (dataset, LPA) pair(s) ingested, {skipped} already covered and skipped.")
    print('Try: python3 gis_cli.py --postcode "<a postcode in one of these councils>"')


if __name__ == "__main__":
    main()
