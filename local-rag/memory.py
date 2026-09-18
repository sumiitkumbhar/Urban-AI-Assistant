"""Episodic memory, semantic memory, and conflict detection -
architecture-plan section 23's remaining Phase 7 tiers, picked up
2026-09-18 after structured project state (section 23's "canonical
current state" tier) shipped 2026-09-15 in project_state.py. Reuses the
same `urban_ai_gis` Postgres database (gis/gis_common.py's
GIS_DATABASE_URL) and the same lazy-psycopg2-import pattern every
function in project_state.py already uses, for the same reason: this
module should be importable without psycopg2 installed, only calling a
function should require it.

Three distinct pieces, each its own table in gis/schema.sql:

- EPISODIC memory (`project_events`) - a timestamped log of what
  happened on ONE project: questions asked, decisions made, freeform
  notes. Three event_types: "query" (auto-logged by service.py's
  /query and /query/stream whenever project_id is set, so a project's
  history fills in just from normal use), "decision" (a firm choice a
  person records explicitly - "ruled out a rear extension"), and "note"
  (anything else worth remembering that isn't a decision).

- SEMANTIC memory (`lpa_knowledge`) - knowledge distilled ACROSS every
  project that shares a geography (an LPA slug, e.g. "westminster" -
  the same slug local-rag's corpus/geography_filter already use), not
  per-project - the whole point of this tier is patterns that
  generalize beyond the one project they were first observed on (e.g.
  "Westminster typically expects a heritage statement for any change
  to a conservation-area property"). Populated only by
  distill_lpa_knowledge(), an explicit/on-demand LLM call over that
  authority's accumulated decision/note events - deliberately NOT run
  automatically on every event, since a bad distillation would pollute
  every future project in that geography's context (build_context_summary()
  in project_state.py surfaces these facts to every project sharing the
  geography) - this is a curation step a person triggers, not a side
  effect of logging.

- CONFLICT detection (`memory_conflicts`) - when a new "decision" event
  is logged, detect_conflicts() runs an LLM-as-judge check (same
  best-effort pattern as answer.py's _check_groundedness(): any
  failure - missing API key, rate limit, malformed JSON - means "no
  conflicts found", never raises, since a conflict check that crashes
  the logging call it's attached to would be worse than one that
  silently finds nothing) against that project's own recent history and
  its authority's distilled knowledge, looking for genuine
  contradictions ("ruled out a rear extension" vs. a later decision
  proposing one). Only "decision" events trigger this - "query" events
  are logged automatically on every project-scoped chat turn, and
  running an LLM check on every single query would be noisy and costly
  for a signal that mostly matters for actual decisions; "note" events
  are freeform and not asserting anything firm enough to usefully check.
  Conflicts are never auto-resolved - a person reviews each one via
  resolve_conflict() and marks it acknowledged or dismissed.

CLI: memory_cli.py. HTTP: the /projects/{id}/events, /projects/{id}/conflicts,
/conflicts/{id}, and /lpa-knowledge/{geography}[/distill] endpoints in
service.py.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "gis"))

VALID_EVENT_TYPES = {"query", "decision", "note"}
VALID_CONFLICT_STATUSES = {"open", "acknowledged", "dismissed"}

CONFLICT_JUDGE_PROMPT = """You are checking a UK planning project's records for contradictions. You will be given a NEW EVENT (a decision just recorded) and a list of EXISTING RECORDS (past events on the same project, and general knowledge about the same planning authority). Identify any EXISTING RECORD that the NEW EVENT genuinely contradicts - not just a related topic, but an actual factual or decision conflict (e.g. "ruled out a rear extension due to the Article 4 direction" vs. a new decision proposing a rear extension; "site is not in a conservation area" vs. a later note that it is). Do not flag a record just because it touches the same subject - only flag real contradictions.

Respond with JSON only, no other text, no markdown fencing:
{"conflicts": [{"conflicting_with": "<quote or close paraphrase of the existing record>", "explanation": "<one sentence: what specifically conflicts>"}]}

If there are no genuine conflicts, respond {"conflicts": []}."""

DISTILL_PROMPT_TEMPLATE = """You are analysing a log of past planning-project events, all from projects within the same local planning authority ("{geography}"), to extract general, reusable patterns about how that authority tends to behave or what commonly matters there - the kind of institutional knowledge a planning consultant would want to remember across different projects with the same council. Only extract genuinely generalizable patterns (not a one-off fact specific to a single project) that are actually supported by two or more events, or one very clear/authoritative one (e.g. an explicit council requirement stated in a decision). Do not repeat a fact already in EXISTING KNOWLEDGE below.

Respond with JSON only, no other text, no markdown fencing:
{{"facts": [{{"fact": "<one generalizable sentence>", "source_indices": [<event index numbers from EVENTS that support it>]}}]}}

If nothing new and well-supported, respond {{"facts": []}}."""


def log_event(project_id, event_type, summary, detail=None, source="manual"):
    """Inserts one episodic-memory row for a project. Returns None if
    project_id doesn't exist (same "let the caller turn None into a
    404" convention as every project_state.py function). Raises
    ValueError for an unrecognized event_type - deliberately a closed
    set rather than free text, since only "decision" events trigger
    detect_conflicts() below and a typo'd type would silently skip it.

    For a "decision" event, runs detect_conflicts() against this
    project's own recent history and (if the project has a known
    geography) that authority's distilled lpa_knowledge, and returns
    any conflicts found under the "conflicts" key - so a caller (the
    CLI, or POST /projects/{id}/events) sees them immediately rather
    than only on a later, separate check. See the module docstring for
    why "query"/"note" events skip this."""
    from gis_common import get_conn

    if event_type not in VALID_EVENT_TYPES:
        raise ValueError(
            f"Unknown event_type {event_type!r} - must be one of {sorted(VALID_EVENT_TYPES)}"
        )

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM sites WHERE id = %s", (project_id,))
                if cur.fetchone() is None:
                    return None
                cur.execute(
                    "INSERT INTO project_events (site_id, event_type, summary, detail, source) "
                    "VALUES (%s, %s, %s, %s, %s) "
                    "RETURNING id, event_type, summary, detail, source, created_at",
                    (project_id, event_type, summary, detail, source),
                )
                row = cur.fetchone()
    finally:
        conn.close()

    event = {
        "id": row[0],
        "event_type": row[1],
        "summary": row[2],
        "detail": row[3],
        "source": row[4],
        "created_at": row[5],
    }

    conflicts = []
    if event_type == "decision":
        conflicts = detect_conflicts(project_id, event["id"])
    event["conflicts"] = conflicts
    return event


def list_events(project_id, limit=None, event_type=None):
    """Returns a project's events in chronological (oldest-first) order
    regardless of `limit` - when limit is given, the most recent `limit`
    events are fetched (DESC + LIMIT at the database) and then reversed,
    so "recent highlights" (build_context_summary()'s use) and "full
    history" (the CLI's use) both read the same natural way."""
    from gis_common import get_conn

    query = (
        "SELECT id, event_type, summary, detail, source, created_at "
        "FROM project_events WHERE site_id = %s"
    )
    params = [project_id]
    if event_type is not None:
        query += " AND event_type = %s"
        params.append(event_type)
    query += " ORDER BY created_at " + ("DESC" if limit else "ASC")
    if limit:
        query += " LIMIT %s"
        params.append(limit)

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                rows = cur.fetchall()
    finally:
        conn.close()

    events = [
        {
            "id": eid,
            "event_type": etype,
            "summary": summary,
            "detail": detail,
            "source": source,
            "created_at": created_at,
        }
        for eid, etype, summary, detail, source, created_at in rows
    ]
    if limit:
        events.reverse()
    return events


def detect_conflicts(project_id, event_id, model=None):
    """Best-effort LLM-as-judge conflict check - see the module
    docstring for the full design. Any failure (missing GROQ_API_KEY,
    rate limit, malformed JSON, no prior records to compare against)
    returns an empty list rather than raising, so a caller can always
    treat the return value as "the conflicts found, possibly none"
    without a try/except of its own."""
    from gis_common import get_conn
    from common import load_dotenv_from_repo, DEFAULT_GROQ_MODEL
    from answer import _extract_first_json_object

    if model is None:
        model = DEFAULT_GROQ_MODEL

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT site_id, event_type, summary, detail "
                    "FROM project_events WHERE id = %s",
                    (event_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return []
                site_id, event_type, summary, detail = row

                cur.execute(
                    "SELECT id, event_type, summary, detail FROM project_events "
                    "WHERE site_id = %s AND id != %s ORDER BY created_at DESC LIMIT 20",
                    (site_id, event_id),
                )
                prior_events = cur.fetchall()

                cur.execute("SELECT geography FROM sites WHERE id = %s", (site_id,))
                geography_row = cur.fetchone()
                geography = geography_row[0] if geography_row else None

                lpa_facts = []
                if geography:
                    cur.execute(
                        "SELECT fact FROM lpa_knowledge WHERE geography = %s",
                        (geography,),
                    )
                    lpa_facts = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()

    if not prior_events and not lpa_facts:
        return []

    records = [
        f"[project:{eid}] ({etype}) {esummary}" + (f" - {edetail}" if edetail else "")
        for eid, etype, esummary, edetail in prior_events
    ]
    records += [f"[knowledge:{i}] {fact}" for i, fact in enumerate(lpa_facts)]

    new_event_text = f"({event_type}) {summary}" + (f" - {detail}" if detail else "")

    load_dotenv_from_repo()
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return []

    from groq import Groq

    client = Groq(api_key=api_key)
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": CONFLICT_JUDGE_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"NEW EVENT:\n{new_event_text}\n\nEXISTING RECORDS:\n"
                        + "\n".join(records)
                    ),
                },
            ],
            temperature=0.0,
            max_tokens=500,
        )
        raw = (completion.choices[0].message.content or "").strip()
        json_text = _extract_first_json_object(raw)
        if not json_text:
            return []
        parsed = json.loads(json_text)
        found = parsed.get("conflicts")
        if not isinstance(found, list):
            return []
    except Exception:
        return []

    inserted = []
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                for item in found:
                    if not isinstance(item, dict):
                        continue
                    conflicting_with = item.get("conflicting_with")
                    explanation = item.get("explanation")
                    if not isinstance(conflicting_with, str) or not isinstance(explanation, str):
                        continue
                    conflicting_with = conflicting_with.strip()
                    explanation = explanation.strip()
                    if not conflicting_with or not explanation:
                        continue
                    cur.execute(
                        "INSERT INTO memory_conflicts "
                        "(site_id, new_event_id, conflicting_with, explanation) "
                        "VALUES (%s, %s, %s, %s) "
                        "RETURNING id, site_id, new_event_id, conflicting_with, explanation, "
                        "status, detected_at",
                        (site_id, event_id, conflicting_with, explanation),
                    )
                    r = cur.fetchone()
                    inserted.append(
                        {
                            "id": r[0],
                            "site_id": r[1],
                            "new_event_id": r[2],
                            "conflicting_with": r[3],
                            "explanation": r[4],
                            "status": r[5],
                            "detected_at": r[6],
                        }
                    )
    finally:
        conn.close()

    return inserted


def list_conflicts(project_id=None, status=None):
    from gis_common import get_conn

    query = (
        "SELECT id, site_id, new_event_id, conflicting_with, explanation, status, detected_at "
        "FROM memory_conflicts"
    )
    clauses = []
    params = []
    if project_id is not None:
        clauses.append("site_id = %s")
        params.append(project_id)
    if status is not None:
        clauses.append("status = %s")
        params.append(status)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY detected_at DESC"

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                rows = cur.fetchall()
    finally:
        conn.close()

    return [
        {
            "id": cid,
            "site_id": site_id,
            "new_event_id": new_event_id,
            "conflicting_with": conflicting_with,
            "explanation": explanation,
            "status": status_,
            "detected_at": detected_at,
        }
        for cid, site_id, new_event_id, conflicting_with, explanation, status_, detected_at in rows
    ]


def resolve_conflict(conflict_id, status):
    """Returns the updated conflict dict, or None if conflict_id
    doesn't exist. Raises ValueError for an unrecognized status."""
    from gis_common import get_conn

    if status not in VALID_CONFLICT_STATUSES:
        raise ValueError(
            f"Unknown status {status!r} - must be one of {sorted(VALID_CONFLICT_STATUSES)}"
        )

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE memory_conflicts SET status = %s WHERE id = %s "
                    "RETURNING id, site_id, new_event_id, conflicting_with, explanation, "
                    "status, detected_at",
                    (status, conflict_id),
                )
                row = cur.fetchone()
                if row is None:
                    return None
    finally:
        conn.close()

    cid, site_id, new_event_id, conflicting_with, explanation, status_, detected_at = row
    return {
        "id": cid,
        "site_id": site_id,
        "new_event_id": new_event_id,
        "conflicting_with": conflicting_with,
        "explanation": explanation,
        "status": status_,
        "detected_at": detected_at,
    }


def get_lpa_knowledge(geography):
    from gis_common import get_conn

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, fact, source_event_ids, created_at FROM lpa_knowledge "
                    "WHERE geography = %s ORDER BY created_at DESC",
                    (geography,),
                )
                rows = cur.fetchall()
    finally:
        conn.close()

    return [
        {
            "id": fid,
            "geography": geography,
            "fact": fact,
            "source_event_ids": source_ids,
            "created_at": created_at,
        }
        for fid, fact, source_ids, created_at in rows
    ]


def distill_lpa_knowledge(geography, model=None):
    """Distills decision/note events across every project tagged with
    this geography into general, reusable facts about how that
    authority tends to behave - the semantic-memory tier (see the
    module docstring for why this is explicit/on-demand rather than
    automatic). Returns the list of newly-inserted facts - empty if
    there are no decision/note events for this geography yet, nothing
    new and well-supported was found, or the call failed for any reason
    (best-effort, same pattern as detect_conflicts())."""
    from gis_common import get_conn
    from common import load_dotenv_from_repo, DEFAULT_GROQ_MODEL
    from answer import _extract_first_json_object

    if model is None:
        model = DEFAULT_GROQ_MODEL

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT pe.id, pe.event_type, pe.summary, pe.detail
                    FROM project_events pe
                    JOIN sites s ON s.id = pe.site_id
                    WHERE s.geography = %s AND pe.event_type IN ('decision', 'note')
                    ORDER BY pe.created_at DESC
                    LIMIT 200
                    """,
                    (geography,),
                )
                events = cur.fetchall()

                cur.execute(
                    "SELECT fact FROM lpa_knowledge WHERE geography = %s",
                    (geography,),
                )
                existing_facts = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()

    if not events:
        return []

    numbered = "\n".join(
        f"[{i}] ({etype}) {summary}" + (f" - {detail}" if detail else "")
        for i, (eid, etype, summary, detail) in enumerate(events)
    )
    existing_block = "\n".join(f"- {f}" for f in existing_facts) or "(none yet)"

    load_dotenv_from_repo()
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return []

    from groq import Groq

    client = Groq(api_key=api_key)
    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": DISTILL_PROMPT_TEMPLATE.format(geography=geography),
                },
                {
                    "role": "user",
                    "content": f"EXISTING KNOWLEDGE:\n{existing_block}\n\nEVENTS:\n{numbered}",
                },
            ],
            temperature=0.0,
            max_tokens=800,
        )
        raw = (completion.choices[0].message.content or "").strip()
        json_text = _extract_first_json_object(raw)
        if not json_text:
            return []
        parsed = json.loads(json_text)
        proposed = parsed.get("facts")
        if not isinstance(proposed, list):
            return []
    except Exception:
        return []

    inserted = []
    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                for item in proposed:
                    if not isinstance(item, dict):
                        continue
                    fact = item.get("fact")
                    if not isinstance(fact, str) or not fact.strip():
                        continue
                    fact = fact.strip()
                    indices = item.get("source_indices")
                    source_ids = []
                    if isinstance(indices, list):
                        for idx in indices:
                            if isinstance(idx, int) and 0 <= idx < len(events):
                                source_ids.append(events[idx][0])
                    cur.execute(
                        "INSERT INTO lpa_knowledge (geography, fact, source_event_ids) "
                        "VALUES (%s, %s, %s) "
                        "RETURNING id, fact, source_event_ids, created_at",
                        (geography, fact, source_ids),
                    )
                    row = cur.fetchone()
                    inserted.append(
                        {
                            "id": row[0],
                            "geography": geography,
                            "fact": row[1],
                            "source_event_ids": row[2],
                            "created_at": row[3],
                        }
                    )
    finally:
        conn.close()

    return inserted
