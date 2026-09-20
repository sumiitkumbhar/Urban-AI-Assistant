"""Best-effort site detection for proposal-review uploads that come in
with no project_id/postcode/lat-lon at all (added 2026-09-19, per
explicit request: "find the postcode based on the documents, be it
name or specifically mentioned in the documents. Or if postcode is not
mentioned then it should search or look up for the postcode based on
the name"). Three stages, cheapest and most reliable first:

  1. Look for an actual UK postcode written in the proposal text. Every
     regex-shaped match is validated against gis_lookup.geocode_postcode()
     (local `postcodes` table first, postcodes.io on a miss - see that
     module) so stray letter+digit noise - a reference number, a phone
     extension - never gets mistaken for a real site; only a candidate
     that's actually a real postcode is used.
  2. Failing that, look for the kind of free text a proposal almost
     always contains even without a postcode written down - a "Site
     Address:"/"Location:" line, or the name of the town/parish/
     district/borough/county council it's addressed to or from - and
     check each candidate against gis/known_places.py's curated
     directory (added 2026-09-20, per explicit request: "build a proper
     and precise Geocode directory... so that it never makes any
     mistake") - a known, audited name -> point mapping, seeded from
     local_planning_authorities' own government-sourced geometry rather
     than a live geocoder guess.
  3. Only if NEITHER of those matches, geocode the same candidate names
     via Nominatim (OpenStreetMap's free-text search; postcodes.io only
     resolves postcodes, not names/addresses - see gis/README's "Known
     limitations", which flagged full free-text geocoding as not wired
     in yet - this is that wiring, scoped to this one caller since it's
     the least certain of the three stages). The resulting point is
     snapped to its nearest real postcode via gis_lookup.nearest_postcode(),
     so a name-derived site still reads as an ordinary postcode to every
     downstream caller (site_constraints(), the report, the chat
     summary).

Every result carries a `source` ("document text" / "known place
directory" / "place name lookup") precisely so the caller can be honest
about which one happened - a live Nominatim guess is materially less
certain than either a postcode read straight off the page or a curated
directory match, and proposal_review.py/report_render.py surface that
distinction rather than hiding it behind a plain "Site: ..." line.
"""

import re
from collections import Counter

# Deliberately loose (matches "SW1V3LX" and "sw1v 3lx" alike) - recall
# over precision, since every candidate is validated against postcodes.io
# before use anyway (see detect_site()), so a shape-only false positive
# just gets rejected rather than accepted.
_POSTCODE_RE = re.compile(r"\b[A-Za-z]{1,2}[0-9][A-Za-z0-9]?\s*[0-9][A-Za-z]{2}\b")

_ADDRESS_LINE_RE = re.compile(
    r"(?:site\s+address|site\s+location|proposal\s+address|property\s+address|address|location)"
    r"\s*[:\-]\s*([^\n]{6,120})",
    re.IGNORECASE,
)

_COUNCIL_NAME_RE = re.compile(
    r"\b([A-Z][A-Za-z'\-]*(?:\s+(?:and|&)\s+[A-Z][A-Za-z'\-]*)?(?:\s+[A-Z][A-Za-z'\-]*){0,3})"
    r"\s+(Town|Parish|District|Borough|City|County)\s+Council\b"
)

# Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
# asks for a descriptive User-Agent identifying the application, not a
# browser string, plus no more than ~1 request/second - both easily met
# here since this runs at most once or twice per proposal review.
_NOMINATIM_USER_AGENT = "urban-ai-assistant-local-rag/1.0 (proposal-review site lookup)"


def _candidate_postcodes(text):
    """Every regex-shaped postcode in `text`, normalized to 'OUTWARD
    INWARD' upper case and deduplicated, most-frequent first. Frequency
    is only a tie-break heuristic - a real site address is more likely
    to be repeated across a multi-page proposal than a one-off stray
    match - never a validity signal; every candidate still has to pass
    postcodes.io before detect_site() will use it."""
    normalized = Counter()
    for m in _POSTCODE_RE.finditer(text):
        compact = m.group(0).upper().replace(" ", "")
        if len(compact) < 5 or len(compact) > 7:
            continue
        spaced = f"{compact[:-3]} {compact[-3:]}"
        normalized[spaced] += 1
    return [pc for pc, _n in normalized.most_common(20)]


def _candidate_place_names(document_texts):
    """Address-line matches first (most specific - an actual address is
    a better geocoding query than a council name), then council names,
    in the order first seen across the documents; deduplicated, order
    preserved."""
    seen = []
    for _name, text in document_texts:
        for m in _ADDRESS_LINE_RE.finditer(text):
            candidate = m.group(1).strip().rstrip(".,;:")
            if candidate and candidate not in seen:
                seen.append(candidate)
    for _name, text in document_texts:
        for m in _COUNCIL_NAME_RE.finditer(text):
            candidate = f"{m.group(1).strip()} {m.group(2)} Council"
            if candidate not in seen:
                seen.append(candidate)
    return seen


def geocode_place_name(name):
    """Free-text UK place/address -> (lat, lon) via Nominatim - see
    module docstring. Returns None on no match or any request failure;
    a network hiccup here should degrade to "couldn't auto-detect",
    never crash the review."""
    import requests

    try:
        resp = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": name, "countrycodes": "gb", "format": "json", "limit": 1},
            headers={"User-Agent": _NOMINATIM_USER_AGENT},
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json()
    except Exception:
        return None
    if not results:
        return None
    try:
        return float(results[0]["lat"]), float(results[0]["lon"])
    except (KeyError, ValueError, TypeError):
        return None


def detect_site(document_texts):
    """document_texts: list of (filename, extracted_text) pairs, as
    proposal_review.review_proposal() already receives them. Returns
    {"postcode", "lat", "lon", "source", "detail"} or None if nothing
    could be resolved at all - callers should fall back to their
    existing "provide a postcode" error in that case, not treat None as
    a crash. See the module docstring for the three-stage order this
    tries candidates in."""
    from gis_lookup import geocode_postcode, nearest_postcode
    from known_places import lookup_known_place

    full_text = "\n".join(text or "" for _name, text in document_texts)

    for candidate in _candidate_postcodes(full_text):
        point = geocode_postcode(candidate)
        if point:
            return {
                "postcode": candidate,
                "lat": point[0],
                "lon": point[1],
                "source": "document text",
                "detail": f"Postcode {candidate} was found written in the uploaded document(s).",
            }

    for name in _candidate_place_names(document_texts):
        known = lookup_known_place(name)
        if not known:
            continue
        return {
            "postcode": known["postcode"],
            "lat": known["lat"],
            "lon": known["lon"],
            "source": "known place directory",
            "detail": (
                f"No postcode was written in the document; {name!r} (found in the "
                f"document) matched the known-places directory "
                f"({known['postcode']}, source: {known['source']})."
            ),
        }

    for name in _candidate_place_names(document_texts):
        point = geocode_place_name(name)
        if not point:
            continue
        postcode = nearest_postcode(*point)
        if not postcode:
            continue
        return {
            "postcode": postcode,
            "lat": point[0],
            "lon": point[1],
            "source": "place name lookup",
            "detail": (
                f"No postcode was written in the document; {postcode} is the nearest "
                f"postcode to {name!r}, which was found in the document."
            ),
        }

    return None
