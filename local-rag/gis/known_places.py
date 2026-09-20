"""Curated place-name -> point directory (added 2026-09-20, per explicit
request: "build a proper and precise Geocode directory for our AI to
track so that it never makes any mistake"). This is the audited
alternative to calling Nominatim's live free-text geocoder on every
proposal review that has no postcode written in its text (see
site_lookup.py's detect_site()): any name already in this table
resolves to a known, sourced point instead of a fresh third-party guess
every time, and every row records where it came from (source) and when
it was checked (verified_at) so the directory itself stays auditable
rather than becoming its own black box.

This does NOT make a name-derived site infallible - see
site_lookup.py's own module docstring and proposal_review.py's "please
verify" caveat. A name mentioned in a document (a council, a named
development) is still only a proxy for the actual site, never a
guarantee of it. What this directory removes is the *geocoding*
uncertainty (was that name resolved to the right point) - not the
*inference* uncertainty (is that name actually where the site is). A
known_places match is real progress over a live Nominatim guess (it's
sourced, reviewable, and doesn't re-ask a third party every time), but
proposal_review.py still surfaces it as an auto-detected site, not a
stated fact.

Seed sources, in the order entries are expected to accumulate:
  1. seed_from_lpas() - every already-ingested local_planning_authorities
     row's own polygon centroid (PostGIS ST_Centroid - government-
     sourced geometry, not a geocoder's guess at the name), registered
     under every common way a document might refer to that authority.
  2. Manually reviewed entries added via add_known_place() as real
     proposals surface names worth remembering (a specific development,
     a site name that recurs) - the directory gets more precise the more
     the tool is used, which is the whole point of building it.
"""

import re

# Common ways a UK document refers to its local authority - registered
# as separate directory entries (all resolving to the same point) since
# a document could use any of them and site_lookup.py's regex only
# extracts the literal wording actually written down.
_COUNCIL_SUFFIXES = ["Council", "Town Council", "Parish Council", "District Council",
                     "Borough Council", "City Council", "County Council"]


def _normalize(name):
    """Case/whitespace/punctuation-insensitive key so 'Bassetlaw
    District Council', 'bassetlaw district council', and 'Bassetlaw
    District  Council.' all hit the same row."""
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def lookup_known_place(name):
    """Exact normalized-name match against the directory. Returns
    {"name", "postcode", "lat", "lon", "source", "verified_at"} or None.
    Deliberately NOT fuzzy/substring matching - a directory that quietly
    matches "Bassetlaw" against "Bassetlaw District Council" AND
    "Bassetlaw Museum" is exactly the kind of silent-guess behaviour this
    directory exists to get away from; every entry earns its own exact
    key. Any DB problem degrades to None (never raises) since the caller
    always has Nominatim as a further fallback."""
    from gis_common import get_conn

    key = _normalize(name)
    if not key:
        return None
    try:
        conn = get_conn()
    except Exception:
        return None
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT name, postcode, lat, lon, source, verified_at "
                    "FROM known_places WHERE name_normalized = %s LIMIT 1",
                    (key,),
                )
                row = cur.fetchone()
    except Exception:
        return None
    finally:
        conn.close()
    if not row:
        return None
    return {
        "name": row[0], "postcode": row[1], "lat": row[2], "lon": row[3],
        "source": row[4], "verified_at": row[5],
    }


def add_known_place(name, lat, lon, postcode=None, source="manual"):
    """Upsert by normalized name - adding the same name twice just
    refreshes verified_at/coordinates, so re-running seed_from_lpas() is
    always safe to repeat (e.g. after ingesting a new LPA)."""
    from gis_common import get_conn

    key = _normalize(name)
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO known_places
                        (name, name_normalized, postcode, lat, lon, source, verified_at)
                    VALUES (%s, %s, %s, %s, %s, %s, now())
                    ON CONFLICT (name_normalized) DO UPDATE SET
                        name = EXCLUDED.name,
                        postcode = EXCLUDED.postcode,
                        lat = EXCLUDED.lat,
                        lon = EXCLUDED.lon,
                        source = EXCLUDED.source,
                        verified_at = now()
                    """,
                    (name, key, postcode, lat, lon, source),
                )
    finally:
        conn.close()


def seed_from_lpas():
    """One government-sourced entry per already-ingested
    local_planning_authorities row: its own polygon centroid (PostGIS
    ST_Centroid - real geometry, not a geocoder's guess), reverse-
    geocoded to its nearest real postcode ONCE here (gis_lookup.
    nearest_postcode(), itself cache-first - see that module) so no
    later review call needs to make that trip again. Registered under
    every common way a document might name that authority (see
    _COUNCIL_SUFFIXES) since a proposal could use any of them - all
    resolving to the exact same point. Safe to re-run any time (upsert);
    run it again after ingesting a new LPA (gis_ingest.py --lpa-entity)
    to extend directory coverage.

    Prints a one-line summary per LPA rather than returning one, matching
    this project's other *_cli.py-adjacent batch functions (e.g.
    gis_ingest.py's ingest_local_planning_authorities)."""
    from gis_common import get_conn
    from gis_lookup import nearest_postcode

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT entity, name, ST_Y(ST_Centroid(geom)), ST_X(ST_Centroid(geom)) "
                    "FROM local_planning_authorities"
                )
                rows = cur.fetchall()
    finally:
        conn.close()

    print(f"Seeding known_places from {len(rows)} ingested LPA(s) ...")
    for entity, name, lat, lon in rows:
        if not name:
            continue
        postcode = nearest_postcode(lat, lon)
        # The source dataset's own `name` field carries a literal " LPA"
        # suffix (e.g. "Bassetlaw LPA", "County Durham LPA") - that's an
        # artifact of planning.data.gov.uk's entity naming, not part of
        # how any real document would ever refer to the authority, so it
        # must be stripped before building name variants or every seeded
        # entry silently fails to match real text (e.g. "Bassetlaw LPA
        # District Council" never matches a document's "Bassetlaw
        # District Council").
        base = re.sub(r"\s+LPA\s*$", "", name.strip(), flags=re.IGNORECASE).strip()
        # Some LPA names already end in a council-type suffix (e.g. "City
        # of Westminster"); registering the bare name plus every suffix
        # variant covers "Westminster Council" and "Westminster City
        # Council" alike without needing to parse which suffix (if any)
        # the source name already carries.
        variants = {base}
        for suffix in _COUNCIL_SUFFIXES:
            variants.add(f"{base} {suffix}")
        for variant in variants:
            add_known_place(variant, lat, lon, postcode=postcode, source="lpa-centroid")
        print(f"  {name} (entity {entity}) -> {postcode or '(no postcode match)'} "
              f"[{len(variants)} name variant(s) registered]")
    print("Done.")


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "Manage the known_places geocode directory. With no arguments, "
            "seeds/refreshes one entry per already-ingested LPA (see "
            "seed_from_lpas()). Use --add to register one more name by hand "
            "after a real review surfaces a site worth remembering."
        )
    )
    parser.add_argument("--add", metavar="NAME", help="Add/update one entry by name")
    parser.add_argument("--lat", type=float, help="Latitude for --add")
    parser.add_argument("--lon", type=float, help="Longitude for --add")
    parser.add_argument("--postcode", help="Postcode for --add (looked up from --lat/--lon if omitted)")
    args = parser.parse_args()

    if args.add:
        if args.lat is None or args.lon is None:
            parser.error("--add requires --lat and --lon")
        postcode = args.postcode
        if not postcode:
            from gis_lookup import nearest_postcode

            postcode = nearest_postcode(args.lat, args.lon)
        add_known_place(args.add, args.lat, args.lon, postcode=postcode, source="manual")
        print(f"Added {args.add!r} -> {postcode or '(no postcode found)'} ({args.lat}, {args.lon})")
        return

    seed_from_lpas()


if __name__ == "__main__":
    main()
