"""Wires site constraints (GIS/PostGIS, gis/gis_lookup.py) into the
text-RAG answer pipeline - architecture-plan section 27's final step:
"Planning Data / official spatial sources -> PostGIS -> site constraints
-> context/policy engine". GIS and local-rag's own text retrieval stay
two structurally separate systems, exactly as section 27 requires
(spatial data is never dumped into RAG) - this module is the "context/
policy engine" glue between them: given a site, ask GIS what applies,
turn the real matched constraints into one natural-language policy
question, and hand it to orchestrate() - the existing multi-agent
domain classifier (heritage/planning/etc, see orchestrate.py) then
routes it exactly the way any other cross-domain question already gets
routed. No new retrieval logic needed; this module only builds the
question and geography scope, and attaches a visual citation afterward.

Also attaches a visual citation: the real conservation-area/Policies Map
PDF (data/map_documents.json, built by ingest.py's map-graphic exclusion
fix - see common.py's MAP_GRAPHIC_FILENAMES) for the constraint(s)
actually matched. These are exactly the documents excluded from the text
index for carrying no real prose (scrambled OCR off a graphic) - the
picture is the citation here, not a text description of a boundary the
retrieval pipeline was deliberately never given. As of the map-images
feature below, each citation also carries a rendered `image_url` (a PNG
of the actual map page, via map_images.py/PyMuPDF) whenever rendering
succeeds - `image_url: None` means the filename-only citation still
works, it just has nothing to display (source PDF missing, or
PyMuPDF/Pillow not installed).
"""

import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "gis"))

from common import REPO_DIR, MAP_DOCUMENTS_PATH  # noqa: E402
from orchestrate import orchestrate  # noqa: E402

TRACKER_PATH = REPO_DIR / "data" / "uk-lpa-tracker.csv"


def _lpa_reference_to_geography(reference):
    """Maps a Planning Data LPA `reference` (e.g. E60000201 - the same
    identifier gis_ingest.py's local_planning_authorities table and
    data/uk-lpa-tracker.csv both use for the same authority) to
    local-rag's own `geography` slug, by looking up the tracker row for
    that reference and reusing council_ingest.py's to_lpa_slug(). This
    keeps the slug always consistent with whatever local-rag's own
    chunks (the curated Westminster corpus, or an ingested council) were
    actually tagged with - rather than trying to parse GIS's own
    free-text LPA name ("Westminster LPA"), which to_lpa_slug() was
    never designed to handle and could easily drift from the real tag."""
    if not reference or not TRACKER_PATH.exists():
        return None
    from council_ingest import to_lpa_slug

    with open(TRACKER_PATH, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("reference") == reference:
                return to_lpa_slug(row["organisation_name"])
    return None


def _describe_constraints(site):
    """Turns site_constraints()'s structured result into the handful of
    plain-English constraint phrases a policy question can be built
    from, plus the real constraint names used for map-citation matching
    below. Only ever describes constraints that were actually matched -
    an unchecked/not-ingested dataset contributes nothing here, matching
    section 27's explicit warning against treating missing data as a
    negative result (a `checked: False` block is silently skipped, not
    read as "no constraint").

    Works equally on gis_lookup.site_constraints()'s live return value
    and on project_state.py's stored `constraints_json` (service.py's
    project-scoped /query reuses this) - both are the exact same shape,
    since the latter is just the former persisted to Postgres."""
    phrases = []
    area_names = []

    ca = site["conservation_areas"]
    if ca["matches"]:
        names = [m["name"] or m["reference"] for m in ca["matches"]]
        area_names.extend(names)
        phrases.append(f"in the {', '.join(names)} conservation area")

    lb = site["listed_buildings"]
    on_site = [m for m in lb["matches"] if m.get("on_site")]
    nearby = [m for m in lb["matches"] if not m.get("on_site")]
    if on_site:
        phrases.append("affecting a listed building on the site itself")
    elif nearby:
        phrases.append("near a listed building (potentially affecting its setting)")

    a4 = site["article_4_directions"]
    if a4["matches"]:
        directions = [m.get("article_4_direction") or m["name"] for m in a4["matches"]]
        directions = [d for d in directions if d]
        suffix = f" ({'; '.join(directions)})" if directions else ""
        phrases.append(
            f"subject to an Article 4 direction removing permitted development rights{suffix}"
        )

    gb = site["green_belt"]
    if gb["matches"]:
        phrases.append("within the Green Belt")

    return phrases, area_names


def _find_map_citations(area_names, geography):
    """Matches actual constraint names against data/map_documents.json's
    filenames (case-insensitive substring - e.g. area name 'Bayswater'
    against 'Bayswater conservation area map.pdf') so the response can
    point at the real map PDF instead of asking the text pipeline to
    describe a boundary it was deliberately never given (see
    common.py's MAP_GRAPHIC_FILENAMES docstring). Falls back to the
    borough-wide Policies Map for the site's geography when no specific
    area map matches (e.g. an Article 4/Green Belt-only site, or an area
    name that doesn't appear in any indexed map's filename).

    Each returned citation also carries a rendered `image_url` (see
    map_images.render_map_image()) pointing at service.py's /map-images
    static mount, so a caller can actually display the map instead of
    just naming the PDF - rendering happens here, synchronously, since
    there's normally at most one or two citations per request and the
    result is cached to disk after the first render."""
    if not MAP_DOCUMENTS_PATH.exists():
        return []
    with open(MAP_DOCUMENTS_PATH) as f:
        maps = json.load(f)

    citations = []
    for m in maps:
        if geography and m.get("geography") != geography:
            continue
        for area in area_names:
            if area and re.sub(r"\s+", " ", area).strip().lower() in m["filename"].lower():
                citations.append(m)
                break

    if not citations:
        for m in maps:
            if geography and m.get("geography") != geography:
                continue
            if "policies map" in m["filename"].lower():
                citations.append(m)
                break

    from map_images import render_map_image

    enriched = []
    for m in citations:
        entry = dict(m)
        image_path = render_map_image(m["filename"])
        entry["image_url"] = f"/map-images/{image_path.name}" if image_path else None
        enriched.append(entry)
    return enriched


def build_site_context(postcode=None, lat=None, lon=None, extra_question=None,
                        top_k=25, rerank_top_n=8):
    """Top-level entry point: GIS lookup -> constraint description ->
    orchestrated retrieval (chunks/coverage, not yet an answer - callers
    pass these straight into answer.py's generate_answer(), same as
    query_cli.py/service.py already do for a plain text query) -> map
    citation(s).

    extra_question, if given, is folded into the constraint-derived
    question ("Is an 8-storey extension feasible, given the site is in
    the Bayswater conservation area?") rather than replacing it - the
    constraint context is what makes this endpoint different from just
    calling orchestrate() directly."""
    from gis_lookup import geocode_postcode, site_constraints

    if lat is not None and lon is not None:
        point = (lat, lon)
    elif postcode:
        point = geocode_postcode(postcode)
        if not point:
            return {"error": f"Postcode {postcode!r} not found."}
    else:
        return {"error": "Provide either postcode or lat/lon."}

    site = site_constraints(*point)
    lpa = site["local_planning_authority"]
    geography = _lpa_reference_to_geography(lpa["reference"] if lpa else None)

    phrases, area_names = _describe_constraints(site)
    constraint_clause = " and ".join(phrases) if phrases else None

    if extra_question and constraint_clause:
        question = f"{extra_question.rstrip('?')}, given the site is {constraint_clause}?"
    elif extra_question:
        question = extra_question
    elif constraint_clause:
        question = f"What planning policy applies to a proposed development {constraint_clause}?"
    else:
        question = "What general planning policy considerations apply to this site?"

    chunks, coverage = orchestrate(
        question, top_k=top_k, rerank_top_n=rerank_top_n, geography_filter=geography
    )
    map_citations = _find_map_citations(area_names, geography)

    return {
        "site_constraints": site,
        "geography": geography,
        "policy_question": question,
        "chunks": chunks,
        "coverage": coverage,
        "map_citations": map_citations,
    }
