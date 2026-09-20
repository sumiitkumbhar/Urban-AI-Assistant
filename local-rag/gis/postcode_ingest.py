"""Bulk-loads the ONS Postcode Directory (ONSPD) into the local
`postcodes` table (added 2026-09-20, per explicit request: "build a
proper and precise Geocode directory... so that it never makes any
mistake"). This is the "get full national coverage up front" option;
gis_lookup.geocode_postcode() also self-fills this same table one
postcode at a time as it's used, so running this is optional, not a
prerequisite for anything else in local-rag to work - see schema.sql's
comment on the postcodes table.

Why ONSPD, not postcodes.io's own database dump: postcodes.io (the free
API this project already calls - see api.postcodes.io) publishes its
service as a pre-built PostgreSQL/PostGIS `pg_dump`, built from the ONS
Postcode Directory + OS Open Names + Scottish Postcode Directory - but
self-hosting it means running their Docker images (postcodes.io's own
README: `docker-compose up`), and this project has deliberately stayed
Docker-free everywhere else (see gis_common.py's own comment on
Homebrew-vs-Docker for the GIS Postgres). Loading ONSPD directly - the
same underlying source their pipeline uses - gets equivalent coverage
without that new dependency.

Where to get the data (no API key, free, government data):
    https://geoportal.statistics.gov.uk/search?collection=Dataset&sort=-created&tags=onspd
Search "ONS Postcode Directory", download the latest edition (a .zip),
and unzip it - the CSV you want is under Data/ and is named something
like "ONSPD_<Month>_<Year>_UK.csv" (tens of millions of... no - ~2.7M
rows, ~600MB+ unzipped. This module does NOT download it automatically:
the portal is a UI-driven catalogue, not a stable direct-download URL,
and guessing a filename convention that then goes stale in a comment
felt worse than making this one manual step explicit).

Column names have drifted slightly across ONSPD editions over the
years, so this reads the CSV's own header row rather than assuming
fixed column positions or exact names, and matches candidate names
case-insensitively (see _find_column()). Recent editions carry WGS84
`lat`/`long` columns directly (used here); older editions only have OSGB36
national-grid `oseast1m`/`osnrth1m` and would need a coordinate
transform this module doesn't do - if _find_column() can't find lat/long,
it says so rather than silently loading wrong/missing coordinates.

Run it (after gis_schema_init.py has been run once):
    source ../venv/bin/activate
    python3 postcode_ingest.py --file /path/to/ONSPD_XXX_UK.csv
    python3 postcode_ingest.py --file /path/to/ONSPD_XXX_UK.csv --terminated-ok
"""

import argparse
import csv
import sys

from gis_common import get_conn
from gis_lookup import _normalize_postcode

BATCH_SIZE = 5000


def _strict_normalize_postcode(raw):
    """Like gis_lookup._normalize_postcode, but returns None (instead of
    a best-effort upper/strip) for anything that isn't 5-7 characters
    once whitespace is stripped, so a garbage/blank CSV cell never gets
    inserted as a fake postcode row."""
    compact = (raw or "").strip().upper().replace(" ", "")
    if len(compact) < 5 or len(compact) > 7:
        return None
    return _normalize_postcode(compact)

# A postcode's "doterm" (date of termination) column is set once that
# postcode stops being used - skipped by default (--terminated-ok
# overrides) since a terminated postcode geocoding "successfully" is
# more likely to confuse a review than help it: it's not where anyone
# would currently expect that postcode to be.
TERMINATED_COLUMN_CANDIDATES = ["doterm"]
POSTCODE_COLUMN_CANDIDATES = ["pcds", "pcd", "postcode"]
LAT_COLUMN_CANDIDATES = ["lat", "latitude"]
LON_COLUMN_CANDIDATES = ["long", "lon", "longitude"]


def _find_column(fieldnames, candidates):
    lower_map = {f.lower(): f for f in fieldnames}
    for candidate in candidates:
        if candidate in lower_map:
            return lower_map[candidate]
    return None


def ingest(csv_path, terminated_ok=False):
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        pcd_col = _find_column(fieldnames, POSTCODE_COLUMN_CANDIDATES)
        lat_col = _find_column(fieldnames, LAT_COLUMN_CANDIDATES)
        lon_col = _find_column(fieldnames, LON_COLUMN_CANDIDATES)
        term_col = _find_column(fieldnames, TERMINATED_COLUMN_CANDIDATES)

        if not pcd_col or not lat_col or not lon_col:
            print(
                f"Couldn't find postcode/lat/long columns in {csv_path} "
                f"(found headers: {fieldnames[:20]}{'...' if len(fieldnames) > 20 else ''}). "
                "This ONSPD edition may only carry OSGB36 easting/northing "
                "(oseast1m/osnrth1m), which this module doesn't convert - "
                "see this file's module docstring."
            )
            sys.exit(1)

        print(f"Columns: postcode={pcd_col!r} lat={lat_col!r} lon={lon_col!r} "
              f"terminated={term_col!r}")

        conn = get_conn()
        batch = []
        total = 0
        skipped_terminated = 0
        skipped_no_coords = 0
        try:
            with conn:
                with conn.cursor() as cur:
                    for row in reader:
                        if term_col and not terminated_ok and (row.get(term_col) or "").strip():
                            skipped_terminated += 1
                            continue
                        postcode = _strict_normalize_postcode(row.get(pcd_col, ""))
                        lat_raw, lon_raw = row.get(lat_col), row.get(lon_col)
                        if not postcode or not lat_raw or not lon_raw:
                            skipped_no_coords += 1
                            continue
                        try:
                            lat, lon = float(lat_raw), float(lon_raw)
                        except ValueError:
                            skipped_no_coords += 1
                            continue
                        batch.append((postcode, lat, lon))
                        if len(batch) >= BATCH_SIZE:
                            _flush(cur, batch)
                            total += len(batch)
                            print(f"  ... {total} rows loaded", end="\r")
                            batch = []
                    if batch:
                        _flush(cur, batch)
                        total += len(batch)
        finally:
            conn.close()

    print(f"\nLoaded {total} postcodes into the local postcodes table "
          f"({skipped_terminated} terminated skipped, "
          f"{skipped_no_coords} missing coordinates skipped).")


def _flush(cur, batch):
    from psycopg2.extras import execute_values

    execute_values(
        cur,
        """
        INSERT INTO postcodes (postcode, lat, lon, source, synced_at)
        VALUES %s
        ON CONFLICT (postcode) DO UPDATE SET
            lat = EXCLUDED.lat, lon = EXCLUDED.lon,
            source = EXCLUDED.source, synced_at = now()
        """,
        [(pc, lat, lon, "onspd") for pc, lat, lon in batch],
        template="(%s, %s, %s, %s, now())",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, help="Path to the unzipped ONSPD CSV")
    parser.add_argument(
        "--terminated-ok", action="store_true",
        help="Also load postcodes ONSPD marks as terminated (skipped by default)",
    )
    args = parser.parse_args()
    ingest(args.file, terminated_ok=args.terminated_ok)


if __name__ == "__main__":
    main()
