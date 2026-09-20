"""Given a site (postcode or lat/lon), answers architecture-plan section
27's structured spatial questions - is it in a conservation area, is it
listed, is Article 4 relevant, is it in Green Belt, which LPA applies -
via PostGIS spatial queries against the tables gis_ingest.py populated.
This is deliberately NOT routed through RAG/the text pipeline - section
27 is explicit that Planning Data should stay a structured/spatial
source, with RAG only answering "what does policy say because this
constraint applies" as a separate step downstream.
"""

from gis_common import get_conn

# A point exactly on a listed building's footprint is "on site"; one
# nearby (but not ingested as overlapping) still matters for setting/
# curtilage questions, so nearby buildings are reported too, distance-
# ranked, out to this radius. 50m is a starting heuristic, not a legal
# definition of "affects the setting of" - see the caveat this module
# always returns alongside listed_buildings.
LISTED_BUILDING_NEARBY_RADIUS_M = 50


def _normalize_postcode(postcode):
    """'sw1v3lx' / 'SW1V  3LX' -> 'SW1V 3LX' - the one canonical spacing
    every caller/table uses as the postcodes table's key, so a lookup
    never misses purely over whitespace/case."""
    compact = postcode.upper().replace(" ", "")
    if len(compact) < 5 or len(compact) > 7:
        return postcode.strip().upper()
    return f"{compact[:-3]} {compact[-3:]}"


def _cached_postcode(postcode):
    """Local postcodes table lookup (added 2026-09-20, per explicit
    request for a "proper and precise Geocode directory" so this
    doesn't have to trust a live third-party API on every call) - see
    schema.sql's own comment. Returns (lat, lon) or None; any DB problem
    (table not migrated yet, Postgres not running) degrades to None
    rather than raising, since geocode_postcode() always has the live
    API as a fallback and a missing cache is never a hard failure."""
    try:
        conn = get_conn()
    except Exception:
        return None
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT lat, lon FROM postcodes WHERE postcode = %s",
                    (_normalize_postcode(postcode),),
                )
                row = cur.fetchone()
    except Exception:
        return None
    finally:
        conn.close()
    return (row[0], row[1]) if row else None


def _cache_postcode(postcode, lat, lon, source="postcodes.io"):
    """Best-effort write-through cache after a live postcodes.io lookup,
    so the SAME postcode never has to leave this machine twice. Never
    raises - caching is a nice-to-have, not something a review should
    fail over."""
    try:
        conn = get_conn()
    except Exception:
        return
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO postcodes (postcode, lat, lon, source, synced_at)
                    VALUES (%s, %s, %s, %s, now())
                    ON CONFLICT (postcode) DO UPDATE SET
                        lat = EXCLUDED.lat, lon = EXCLUDED.lon,
                        source = EXCLUDED.source, synced_at = now()
                    """,
                    (_normalize_postcode(postcode), lat, lon, source),
                )
    except Exception:
        pass
    finally:
        conn.close()


def geocode_postcode(postcode):
    """UK postcode -> (lat, lon). Checks the local postcodes table first
    (self-filling cache, or bulk-loaded via postcode_ingest.py - see
    schema.sql's comment) and only calls out to postcodes.io - free, no
    API key, the standard open UK postcode geocoder - on a local miss,
    caching whatever it returns for next time. Full free-text address
    geocoding (not just postcodes) is a separate, less precise fallback -
    see site_lookup.py/known_places.py, added 2026-09-19/20 - since a
    postcode is exact and a free-text address/name match isn't."""
    cached = _cached_postcode(postcode)
    if cached:
        return cached

    import requests
    from urllib.parse import quote

    resp = requests.get(
        f"https://api.postcodes.io/postcodes/{quote(postcode)}",
        timeout=10,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    result = resp.json().get("result")
    if not result:
        return None
    point = (result["latitude"], result["longitude"])
    _cache_postcode(postcode, *point)
    return point


# Real bug found 2026-09-20, from a live seed_from_lpas() run: with the
# local postcodes table sparse (as it is until postcode_ingest.py is
# run, or simply early on while the self-filling cache is still small),
# "nearest cached row, no matter how far" confidently returned the SAME
# postcode for 300+ different LPAs the length of the country - the one
# row that happened to be in the table at the time, because it was
# technically the "nearest" of a cache containing exactly one entry.
# That's worse than not having a cache at all: silently wrong, not
# absent. A local hit is only trustworthy within a plausible postcode's
# own radius - beyond that, "nearest cached row" isn't a meaningful
# answer and this must fall through to a live lookup instead. 0.05
# degrees is a deliberately generous ~5-6km margin at UK latitudes
# (comfortably covers even a large rural postcode's extent), not a
# precision claim.
_NEAREST_POSTCODE_MAX_DEGREES = 0.05


def nearest_postcode(lat, lon):
    """(lat, lon) -> nearest real UK postcode. Tries the local postcodes
    table first (a simple nearest-neighbour scan, only trusted within
    _NEAREST_POSTCODE_MAX_DEGREES - see that constant's comment on why -
    fine at the table sizes this project deals with; add a KNN index if
    postcode_ingest.py is ever run for full national coverage and this
    gets slow), then postcodes.io's own reverse-geocoding endpoint on a
    local miss. Used by known_places.seed_from_lpas() (to label an LPA
    centroid with a real postcode) and by site_lookup.py's name-based
    fallback (to snap a geocoded name to a postcode the rest of the app
    can display). Returns None on no match or any request failure - a
    network hiccup here should never crash a review."""
    try:
        conn = get_conn()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT postcode, (lat - %s) ^ 2 + (lon - %s) ^ 2 AS d2
                        FROM postcodes
                        ORDER BY d2 ASC
                        LIMIT 1
                        """,
                        (lat, lon),
                    )
                    row = cur.fetchone()
                    if row and row[1] <= _NEAREST_POSTCODE_MAX_DEGREES ** 2:
                        return row[0]
        finally:
            conn.close()
    except Exception:
        pass

    import requests

    try:
        resp = requests.get(
            "https://api.postcodes.io/postcodes",
            # radius=2000 (postcodes.io's own documented maximum) -
            # found the hard way seeding known_places from real LPA
            # centroids: the endpoint's default radius is only 100m, so
            # a large/rural authority (a National Park especially - its
            # centroid often lands in open moorland, nowhere near 100m
            # from any postcode) came back with no match at all, even
            # though a real nearest postcode exists a few hundred metres
            # to a couple of kilometres away. Widening this doesn't
            # change what gets ACCEPTED locally (_NEAREST_POSTCODE_MAX_DEGREES
            # still gates the local-cache path); it only stops this live
            # call giving up too early on a legitimately sparse area.
            params={"lon": lon, "lat": lat, "limit": 1, "radius": 2000},
            timeout=10,
        )
        resp.raise_for_status()
        result = resp.json().get("result")
    except Exception:
        return None
    if not result:
        return None
    postcode = result[0]["postcode"]
    _cache_postcode(postcode, lat, lon, source="postcodes.io-reverse")
    return postcode


def _lookup_lpa(cur, lat, lon):
    cur.execute(
        """
        SELECT entity, name, reference
        FROM local_planning_authorities
        WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
        LIMIT 1
        """,
        (lon, lat),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {"entity": row[0], "name": row[1], "reference": row[2]}


def _lookup_containing(cur, table, lat, lon, extra_cols=()):
    cols = ", ".join(["entity", "name", "reference", "source_url", *extra_cols])
    cur.execute(
        f"""
        SELECT {cols}
        FROM {table}
        WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
        """,
        (lon, lat),
    )
    keys = ["entity", "name", "reference", "source_url", *extra_cols]
    return [dict(zip(keys, row)) for row in cur.fetchall()]


def _lookup_nearby_listed_buildings(cur, lat, lon, radius_m):
    cur.execute(
        """
        SELECT entity, name, reference, listed_grade, source_url,
               ST_Distance(
                   geom::geography,
                   ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
               ) AS distance_m,
               ST_Contains(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)) AS on_site
        FROM listed_building_outlines
        WHERE ST_DWithin(
            geom::geography,
            ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
            %s
        )
        ORDER BY distance_m ASC
        """,
        (lon, lat, lon, lat, lon, lat, radius_m),
    )
    keys = [
        "entity", "name", "reference", "listed_grade", "source_url",
        "distance_m", "on_site",
    ]
    return [dict(zip(keys, row)) for row in cur.fetchall()]


def _coverage_for(cur, lpa_entity):
    if lpa_entity is None:
        return {}
    cur.execute(
        """
        SELECT dataset, feature_count, synced_at
        FROM gis_coverage
        WHERE lpa_entity = %s
        """,
        (lpa_entity,),
    )
    return {
        row[0]: {"feature_count": row[1], "synced_at": row[2].isoformat()}
        for row in cur.fetchall()
    }


def site_constraints(lat, lon):
    """Returns the structured answer to section 27's questions for one
    point. Every constraint-layer key is paired with a `coverage` block
    (see _coverage_for) so an empty list means "checked, none found" only
    when that dataset has actually been ingested for this site's LPA -
    otherwise it's flagged `checked: False`, per section 27's explicit
    warning against treating an incomplete dataset as proof of absence.
    """
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                lpa = _lookup_lpa(cur, lat, lon)
                coverage = _coverage_for(cur, lpa["entity"] if lpa else None)

                conservation_areas = _lookup_containing(
                    cur, "conservation_areas", lat, lon
                )
                article_4 = _lookup_containing(
                    cur,
                    "article_4_direction_areas",
                    lat,
                    lon,
                    extra_cols=("article_4_direction",),
                )
                green_belt = _lookup_containing(cur, "green_belt", lat, lon)
                flood_risk_zones = _lookup_containing(
                    cur,
                    "flood_risk_zones",
                    lat,
                    lon,
                    extra_cols=("flood_risk_level", "flood_risk_type"),
                )
                listed_buildings = _lookup_nearby_listed_buildings(
                    cur, lat, lon, LISTED_BUILDING_NEARBY_RADIUS_M
                )
    finally:
        conn.close()

    def _checked(dataset):
        return dataset in coverage

    return {
        "point": {"lat": lat, "lon": lon},
        "local_planning_authority": lpa,
        "conservation_areas": {
            "checked": _checked("conservation-area"),
            "matches": conservation_areas,
        },
        "listed_buildings": {
            "checked": _checked("listed-building-outline"),
            "search_radius_m": LISTED_BUILDING_NEARBY_RADIUS_M,
            "matches": listed_buildings,
        },
        "article_4_directions": {
            "checked": _checked("article-4-direction-area"),
            "matches": article_4,
        },
        "green_belt": {
            "checked": _checked("green-belt"),
            "matches": green_belt,
        },
        "flood_risk_zones": {
            "checked": _checked("flood-risk-zone"),
            "matches": flood_risk_zones,
        },
        "coverage": coverage,
    }
