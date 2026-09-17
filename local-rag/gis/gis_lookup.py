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


def geocode_postcode(postcode):
    """UK postcode -> (lat, lon) via postcodes.io - free, no API key,
    the standard open UK postcode geocoder. Full free-text address
    geocoding (not just postcodes) isn't wired in yet - see README's
    Known limitations: the free options (Nominatim/OSM) come with usage-
    policy restrictions worth reading before relying on them for
    anything beyond occasional lookups; the paid options (OS Places,
    Google) break the zero-budget rule. Postcode-level accuracy is
    enough to identify which conservation area/LPA a site sits in for
    the vast majority of UK addresses."""
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
    return result["latitude"], result["longitude"]


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
                    cur, "flood_risk_zones", lat, lon
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
