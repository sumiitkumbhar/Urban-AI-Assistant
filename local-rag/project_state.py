"""Structured project state - architecture-plan sections 22/23/28,
Phase 7's first slice. This is the "what is currently true" canonical
state layer section 23 calls for ("This must be canonical structured
state, not only embeddings") - a real Postgres row per project, not an
embedding. Deliberately scoped to ONLY that layer: section 23's semantic/
episodic/procedural memory tiers are explicitly out of scope here and
need their own future scoping, per the note already left in
gis/schema.sql above the ALTER TABLE block this module reads/writes.

Storage: the user chose "a new local Postgres table" - reusing the
existing `urban_ai_gis` database (gis/gis_common.py's GIS_DATABASE_URL)
rather than standing up a second database, and reusing the `sites` table
that already existed there as an unused placeholder (confirmed via grep
before this module was written - no other code touched it). The table is
still named `sites` in the database; every function here is framed
around "project" since that is the concept section 28 actually names
("Site digital twin / project world model") and what the CLI/API surface
below exposes.

Every function imports gis_common.get_conn() lazily inside its own body
(same lazy-psycopg2-import pattern gis_common.py itself uses) so that
importing this module never requires psycopg2 to be installed - only
actually calling one of these functions does.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "gis"))

# Fields a caller may change via update_project() - keys are the public
# API name, values are the sites column they write. Site identity
# (postcode/lat/lon/LPA/geography) is deliberately NOT here: those are
# set once at create_project() time from a real geocode + GIS lookup,
# and changing "where the project is" should be a new project, not a
# silent edit of an existing one's identity.
UPDATABLE_FIELDS = {
    "name": "label",
    "proposed_use": "proposed_use",
    "units": "units",
    "storeys": "storeys",
    "floorspace_sqm": "floorspace_sqm",
    "height_m": "height_m",
    "stage": "stage",
}

_PROJECT_COLUMNS = (
    "id, label, postcode, ST_Y(geom) AS lat, ST_X(geom) AS lon, "
    "lpa_reference, geography, proposed_use, units, storeys, "
    "floorspace_sqm, height_m, stage, constraints_json, "
    "constraints_checked_at, created_at, updated_at"
)


def _row_to_project(row):
    """Shared row->dict mapping so create_project()/get_project()/
    list_projects() can never drift out of sync on field names."""
    (
        id_, label, postcode, lat, lon, lpa_reference, geography,
        proposed_use, units, storeys, floorspace_sqm, height_m, stage,
        constraints_json, constraints_checked_at, created_at, updated_at,
    ) = row
    return {
        "id": id_,
        "name": label,
        "postcode": postcode,
        "lat": lat,
        "lon": lon,
        "lpa_reference": lpa_reference,
        "geography": geography,
        "proposed_use": proposed_use,
        "units": units,
        "storeys": storeys,
        "floorspace_sqm": float(floorspace_sqm) if floorspace_sqm is not None else None,
        "height_m": float(height_m) if height_m is not None else None,
        "stage": stage,
        "constraints": constraints_json,
        "constraints_checked_at": constraints_checked_at,
        "created_at": created_at,
        "updated_at": updated_at,
    }


def _fetch_open_questions(cur, project_id):
    cur.execute(
        "SELECT id, question, resolved, created_at, resolved_at "
        "FROM project_open_questions WHERE site_id = %s ORDER BY created_at",
        (project_id,),
    )
    return [
        {
            "id": qid,
            "question": question,
            "resolved": resolved,
            "created_at": created_at,
            "resolved_at": resolved_at,
        }
        for qid, question, resolved, created_at, resolved_at in cur.fetchall()
    ]


def create_project(name, postcode=None, lat=None, lon=None):
    """Geocodes (if given a postcode) or uses lat/lon directly, runs the
    same site_constraints() GIS lookup site_context.py uses for a
    one-off query, maps the matched LPA to local-rag's own geography
    slug via site_context.py's own helper (so a project's geography
    always agrees with however local-rag's text corpus is tagged), and
    inserts one row. Raises ValueError for a postcode that doesn't
    geocode or if neither postcode nor lat/lon is given - callers
    (CLI/API) turn that into a user-facing error."""
    from gis_common import get_conn
    from gis_lookup import geocode_postcode, site_constraints
    from site_context import _lpa_reference_to_geography

    if lat is None or lon is None:
        if not postcode:
            raise ValueError("Provide either postcode or lat/lon.")
        point = geocode_postcode(postcode)
        if not point:
            raise ValueError(f"Postcode {postcode!r} not found.")
        lat, lon = point

    site = site_constraints(lat, lon)
    lpa = site["local_planning_authority"]
    lpa_reference = lpa["reference"] if lpa else None
    geography = _lpa_reference_to_geography(lpa_reference)

    import json

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO sites (
                        label, postcode, geom, lpa_reference, geography,
                        constraints_json, constraints_checked_at, updated_at
                    ) VALUES (
                        %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s,
                        %s, now(), now()
                    ) RETURNING id
                    """,
                    (
                        name, postcode, lon, lat, lpa_reference, geography,
                        json.dumps(site),
                    ),
                )
                (project_id,) = cur.fetchone()
    finally:
        conn.close()

    return get_project(project_id)


def get_project(project_id):
    """Returns the project dict, or None if project_id doesn't exist -
    callers (service.py) turn None into a 404 rather than this module
    knowing anything about HTTP."""
    from gis_common import get_conn

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {_PROJECT_COLUMNS} FROM sites WHERE id = %s",
                    (project_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                project = _row_to_project(row)
                project["open_questions"] = _fetch_open_questions(cur, project_id)
                return project
    finally:
        conn.close()


def list_projects():
    """N+1 (one query for ids, then get_project() per row) - accepted
    for CLI/small-dashboard scale; worth collapsing into one query with
    a json_agg subselect if this ever needs to list hundreds of
    projects at once."""
    from gis_common import get_conn

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM sites ORDER BY created_at DESC")
                ids = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()

    return [get_project(i) for i in ids]


def update_project(project_id, **fields):
    """Updates only the UPDATABLE_FIELDS keys actually passed (site
    identity is not editable - see UPDATABLE_FIELDS's comment). Returns
    the refreshed project dict, or None if project_id doesn't exist.
    Raises ValueError for an unknown field name."""
    from gis_common import get_conn

    unknown = set(fields) - set(UPDATABLE_FIELDS)
    if unknown:
        raise ValueError(f"Unknown field(s): {', '.join(sorted(unknown))}")
    if not fields:
        return get_project(project_id)

    set_clauses = [f"{UPDATABLE_FIELDS[k]} = %s" for k in fields]
    values = list(fields.values())
    set_clauses.append("updated_at = now()")

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE sites SET {', '.join(set_clauses)} WHERE id = %s",
                    (*values, project_id),
                )
                if cur.rowcount == 0:
                    return None
    finally:
        conn.close()

    return get_project(project_id)


def refresh_constraints(project_id):
    """Re-runs site_constraints() for the project's stored lat/lon and
    overwrites constraints_json/constraints_checked_at - explicit, not
    on a timer, since GIS coverage itself only changes when someone
    re-runs gis_ingest.py (see the ALTER TABLE comment in
    gis/schema.sql). Returns None if project_id doesn't exist."""
    from gis_common import get_conn
    from gis_lookup import site_constraints

    import json

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT ST_Y(geom), ST_X(geom) FROM sites WHERE id = %s",
                    (project_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                lat, lon = row

                site = site_constraints(lat, lon)
                cur.execute(
                    "UPDATE sites SET constraints_json = %s, "
                    "constraints_checked_at = now(), updated_at = now() "
                    "WHERE id = %s",
                    (json.dumps(site), project_id),
                )
    finally:
        conn.close()

    return get_project(project_id)


def add_open_question(project_id, question):
    """Returns the new question dict, or None if project_id doesn't
    exist (the ON DELETE CASCADE FK means a bad project_id would
    otherwise just raise an IntegrityError - checked explicitly instead
    so the CLI/API can give a clean error)."""
    from gis_common import get_conn

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM sites WHERE id = %s", (project_id,))
                if cur.fetchone() is None:
                    return None
                cur.execute(
                    "INSERT INTO project_open_questions (site_id, question) "
                    "VALUES (%s, %s) "
                    "RETURNING id, question, resolved, created_at, resolved_at",
                    (project_id, question),
                )
                qid, question, resolved, created_at, resolved_at = cur.fetchone()
    finally:
        conn.close()

    return {
        "id": qid,
        "question": question,
        "resolved": resolved,
        "created_at": created_at,
        "resolved_at": resolved_at,
    }


def resolve_open_question(question_id):
    """Returns the updated question dict, or None if question_id
    doesn't exist."""
    from gis_common import get_conn

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE project_open_questions SET resolved = true, "
                    "resolved_at = now() WHERE id = %s "
                    "RETURNING id, question, resolved, created_at, resolved_at",
                    (question_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                qid, question, resolved, created_at, resolved_at = row
    finally:
        conn.close()

    return {
        "id": qid,
        "question": question,
        "resolved": resolved,
        "created_at": created_at,
        "resolved_at": resolved_at,
    }


def build_context_summary(project_id):
    """Renders the "CURRENT PROJECT STATE" text block architecture-plan
    section 26 sketches as part of the context package assembled before
    final reasoning. Returns None if project_id doesn't exist.

    Meant to be passed to answer.py's generate_answer()/stream_answer()
    as their new project_context parameter, injected as EXTRA context
    alongside the retrieved evidence - deliberately NOT folded into the
    retrieval query itself, which would pollute the embedding search
    with proposal details (unit counts, stage, etc.) that have nothing
    to do with what text chunks are semantically relevant."""
    project = get_project(project_id)
    if project is None:
        return None

    lines = ["CURRENT PROJECT STATE:"]
    lines.append(f"- Project: {project['name']}")
    if project["postcode"]:
        lines.append(f"- Site: {project['postcode']}")
    if project["geography"]:
        lines.append(f"- Authority: {project['geography']}")
    if project["proposed_use"]:
        lines.append(f"- Proposed use: {project['proposed_use']}")

    proposal_bits = []
    if project["units"] is not None:
        proposal_bits.append(f"{project['units']} units")
    if project["storeys"] is not None:
        proposal_bits.append(f"{project['storeys']} storeys")
    if project["floorspace_sqm"] is not None:
        proposal_bits.append(f"{project['floorspace_sqm']:g} sqm floorspace")
    if project["height_m"] is not None:
        proposal_bits.append(f"{project['height_m']:g} m height")
    if proposal_bits:
        lines.append(f"- Proposal: {', '.join(proposal_bits)}")

    if project["stage"]:
        lines.append(f"- Stage: {project['stage']}")

    if project["constraints"]:
        from site_context import _describe_constraints

        phrases, _ = _describe_constraints(project["constraints"])
        if phrases:
            lines.append(f"- Known constraints: {' and '.join(phrases)}")

    unresolved = [q["question"] for q in project["open_questions"] if not q["resolved"]]
    if unresolved:
        lines.append("- Open questions:")
        for q in unresolved:
            lines.append(f"  - {q}")

    # Episodic + semantic memory (memory.py, added 2026-09-18) - both
    # wrapped in their own try/except rather than one shared try around
    # both calls, and deliberately best-effort/silent on failure (append
    # nothing rather than raise) for the same reason every cache-miss and
    # LLM-judge failure elsewhere in this project degrades quietly: a
    # project that predates memory.py's tables (schema not yet
    # re-applied) must keep working exactly as it did before this
    # feature existed, not start raising on every context build.
    try:
        from memory import list_events

        recent = list_events(project_id, limit=5)
    except Exception:
        recent = []
    if recent:
        lines.append("- Recent history:")
        for e in recent:
            lines.append(f"  - [{e['event_type']}] {e['summary']}")

    if project["geography"]:
        try:
            from memory import get_lpa_knowledge

            facts = get_lpa_knowledge(project["geography"])
        except Exception:
            facts = []
        if facts:
            lines.append(f"- Known patterns for {project['geography']}:")
            for f in facts[:5]:
                lines.append(f"  - {f['fact']}")

    return "\n".join(lines)
