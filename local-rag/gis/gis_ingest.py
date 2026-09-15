"""Ingests Planning Data (planning.data.gov.uk) into the local
urban_ai_gis Postgres/PostGIS database - the data half of architecture-
plan section 27's "Planning Data / official spatial sources -> PostGIS".

Two kinds of ingestion happen here:

1. `local_planning_authorities` - the whole national dataset (~300
   authorities, a few MB). Ingested everywhere, not scoped to one LPA,
   because "which LPA applies to this site" is a meaningful question for
   any UK site and the whole dataset is cheap to keep local.

2. The four constraint layers (conservation areas, listed building
   outlines, Article 4 direction areas, Green Belt) - ingested scoped to
   ONE local planning authority per run via --lpa-entity/--lpa-name
   (defaults to Westminster, architecture-plan section 29's starting
   geography). This deliberately does NOT mass-ingest every constraint
   nationally - section 47 explicitly warns against that ("mass-ingesting
   all UK local plans" is listed as a thing not to do; the same principle
   applies to spatial data). Run again with a different --lpa-entity to
   add coverage for another authority later; existing authorities' rows
   are left alone (each dataset+LPA pair is deleted and re-inserted only
   for the LPA being ingested this run, not the whole table).

Uses planning.data.gov.uk's entity.geojson API with geometry_entity=
<lpa entity>&geometry_relation=intersects - confirmed working via the
Planning Data docs (2026-09-14): no API key required, offset-based
pagination via the response's `links.next`. "intersects" (not "within")
deliberately includes constraint polygons that straddle the LPA boundary,
since a site near the edge should still see them.

Run it (after gis_schema_init.py has been run once):
    source ../venv/bin/activate   # local-rag/venv, same env as ingest.py
    python3 gis_ingest.py                        # Westminster (default)
    python3 gis_ingest.py --lpa-entity 626201 --lpa-name Westminster
"""

import argparse
import json
import sys
import time

import requests

from gis_common import (
    CONSTRAINT_DATASETS,
    DEFAULT_LPA_ENTITY,
    DEFAULT_LPA_NAME,
    PLANNING_DATA_BASE,
    get_conn,
)

# Diagnosed 2026-09-15 against a real ingestion run: this is NOT a
# server outage, rate-limit, or a TLS-stack bug (all three were tested
# and ruled out - the API is operational, and neither request headers
# nor streamed reads changed anything). It's simply that LPA boundary
# polygons are large (measured ~130-190KB/row) and effective download
# throughput to this host was measured at a consistent ~600-650 KB/s
# (limit=10 -> 1.9MB/3.2s, limit=20 -> 3.3MB/4.9s, limit=50 -> 6.3MB/10.4s,
# limit=100 -> 12.6MB/19.7s - all linear). At limit=200 that's a
# ~25-38MB page, 40-60+s to download - right at/over any reasonable
# timeout. limit=50 keeps each page to ~10s, a comfortable margin under
# REQUEST_TIMEOUT even with a slow connection.
PAGE_LIMIT = 50
REQUEST_TIMEOUT = 60
REQUEST_RETRIES = 4
REQUEST_RETRY_BACKOFF_S = 3  # 3s, 6s, 12s, 24s between attempts
# "Apply polite rate-limiting between requests" is the only guidance
# Planning Data's own docs give (no documented numeric limit) - this is a
# deliberately conservative gap between paginated requests.
REQUEST_DELAY_S = 0.3


def _get_with_retry(url, params):
    """GET with retries for transient network errors (timeouts, connection
    resets, 5xx) - a single slow/flaky response used to kill an entire
    ingestion run and force starting over from page 0. Only network-level
    and 5xx failures are retried; a 4xx (bad params/dataset slug) fails
    immediately since retrying won't fix it."""
    last_exc = None
    for attempt in range(REQUEST_RETRIES + 1):
        try:
            resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return resp
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code < 500:
                raise  # 4xx - not transient, don't retry
            last_exc = e
        except requests.exceptions.RequestException as e:
            last_exc = e
        if attempt < REQUEST_RETRIES:
            wait = REQUEST_RETRY_BACKOFF_S * (2 ** attempt)
            print(f"  ... request failed ({last_exc}), retrying in {wait}s "
                  f"(attempt {attempt + 1}/{REQUEST_RETRIES}) ...")
            time.sleep(wait)
    raise last_exc


def _fetch_pages(dataset, params):
    """Yields GeoJSON features across every page of a dataset query."""
    offset = 0
    while True:
        query = dict(params, dataset=dataset, limit=PAGE_LIMIT, offset=offset)
        resp = _get_with_retry(f"{PLANNING_DATA_BASE}/entity.geojson", query)
        data = resp.json()
        features = data.get("features", [])
        for f in features:
            yield f
        if len(features) < PAGE_LIMIT:
            return
        offset += PAGE_LIMIT
        time.sleep(REQUEST_DELAY_S)


def _multi_geojson(geometry):
    """planning.data.gov.uk returns Polygon or MultiPolygon depending on
    the feature - ST_Multi() in the INSERT normalizes either into
    MultiPolygon to match the column type, so this just needs to hand
    back valid GeoJSON text for ST_GeomFromGeoJSON()."""
    return json.dumps(geometry)


def ingest_local_planning_authorities():
    """National dataset - not scoped to any one LPA."""
    print("Ingesting local_planning_authorities (national, ~300 rows) ...")
    rows = []
    for feature in _fetch_pages("local-planning-authority", {}):
        props = feature.get("properties", {})
        geometry = feature.get("geometry")
        if not geometry:
            continue
        rows.append(
            (
                props.get("entity"),
                props.get("reference"),
                props.get("name"),
                _multi_geojson(geometry),
                f"{PLANNING_DATA_BASE}/entity/{props.get('entity')}",
            )
        )

    if not rows:
        print(
            "  WARNING: got 0 rows for local-planning-authority - check "
            "network access and the dataset slug before trusting any "
            "'which LPA' answers."
        )
        return

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM local_planning_authorities")
                cur.executemany(
                    """
                    INSERT INTO local_planning_authorities
                        (entity, reference, name, geom, source_url)
                    VALUES (%s, %s, %s,
                        ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)),
                        %s)
                    ON CONFLICT (entity) DO UPDATE SET
                        reference = EXCLUDED.reference,
                        name = EXCLUDED.name,
                        geom = EXCLUDED.geom,
                        source_url = EXCLUDED.source_url,
                        synced_at = now()
                    """,
                    rows,
                )
        print(f"  {len(rows)} local planning authorities loaded.")
    finally:
        conn.close()


def ingest_constraint_dataset(dataset, table_cfg, lpa_entity, lpa_name):
    table = table_cfg["table"]
    extra_fields = table_cfg["extra_fields"]
    print(f"Ingesting {dataset} for LPA entity {lpa_entity} ({lpa_name}) ...")

    rows = []
    for feature in _fetch_pages(
        dataset,
        {"geometry_entity": lpa_entity, "geometry_relation": "intersects"},
    ):
        props = feature.get("properties", {})
        geometry = feature.get("geometry")
        if not geometry:
            continue
        extra_values = [props.get(src) for src in extra_fields.values()]
        rows.append(
            (
                props.get("entity"),
                props.get("reference"),
                props.get(table_cfg["name_field"]),
                props.get("organisation-entity"),
                *extra_values,
                _multi_geojson(geometry),
                f"{PLANNING_DATA_BASE}/entity/{props.get('entity')}",
            )
        )

    extra_cols = list(extra_fields.keys())
    extra_col_sql = "".join(f", {c}" for c in extra_cols)
    extra_placeholder_sql = "".join(", %s" for _ in extra_cols)
    extra_update_sql = "".join(f", {c} = EXCLUDED.{c}" for c in extra_cols)

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                # Only this LPA's existing rows for this dataset are
                # cleared - re-running for Westminster doesn't touch rows
                # ingested for a different authority in an earlier run.
                # organisation_entity isn't always the ingesting LPA (the
                # designating body can differ), so coverage is tracked
                # separately in gis_coverage rather than inferred from
                # this column - delete-then-reinsert here relies on the
                # entity IDs returned for this geometry_entity query,
                # which is safe because those are exactly this LPA's
                # intersecting features every time.
                current_entities = [r[0] for r in rows] or [None]
                cur.execute(
                    f"DELETE FROM {table} WHERE entity = ANY(%s)",
                    (current_entities,),
                )
                if rows:
                    cur.executemany(
                        f"""
                        INSERT INTO {table}
                            (entity, reference, name, organisation_entity
                             {extra_col_sql}, geom, source_url)
                        VALUES (%s, %s, %s, %s
                             {extra_placeholder_sql},
                             ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)),
                             %s)
                        ON CONFLICT (entity) DO UPDATE SET
                            reference = EXCLUDED.reference,
                            name = EXCLUDED.name,
                            organisation_entity = EXCLUDED.organisation_entity
                            {extra_update_sql},
                            geom = EXCLUDED.geom,
                            source_url = EXCLUDED.source_url,
                            synced_at = now()
                        """,
                        rows,
                    )
                cur.execute(
                    """
                    INSERT INTO gis_coverage
                        (dataset, lpa_entity, lpa_name, feature_count)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (dataset, lpa_entity) DO UPDATE SET
                        lpa_name = EXCLUDED.lpa_name,
                        feature_count = EXCLUDED.feature_count,
                        synced_at = now()
                    """,
                    (dataset, lpa_entity, lpa_name, len(rows)),
                )
        print(f"  {len(rows)} {dataset} features loaded.")
        if not rows:
            print(
                f"  (0 is plausible for some dataset/LPA pairs - e.g. "
                f"inner-London authorities genuinely have no Green Belt. "
                f"gis_coverage still records that this was checked.)"
            )
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--lpa-entity",
        type=int,
        default=DEFAULT_LPA_ENTITY,
        help=f"Planning Data entity ID for the LPA to scope constraint "
        f"layers to (default: {DEFAULT_LPA_ENTITY}, {DEFAULT_LPA_NAME}).",
    )
    parser.add_argument(
        "--lpa-name",
        default=DEFAULT_LPA_NAME,
        help="Human-readable label for --lpa-entity, stored in "
        "gis_coverage for readability only.",
    )
    parser.add_argument(
        "--skip-lpa-boundaries",
        action="store_true",
        help="Skip the national local_planning_authorities refresh "
        "(useful when re-running just to add another authority's "
        "constraint layers).",
    )
    args = parser.parse_args()

    if not args.skip_lpa_boundaries:
        ingest_local_planning_authorities()

    for dataset, cfg in CONSTRAINT_DATASETS.items():
        ingest_constraint_dataset(dataset, cfg, args.lpa_entity, args.lpa_name)

    print("\nDone. Try: python3 gis_cli.py --postcode \"SW1V 3LX\"")


if __name__ == "__main__":
    try:
        main()
    except requests.exceptions.RequestException as e:
        print(f"Network error talking to planning.data.gov.uk: {e}")
        sys.exit(1)
