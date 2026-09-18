"""Shared config/helpers for the site-constraint (Planning Data/PostGIS)
piece of local-rag - architecture-plan section 27: "Planning Data /
official spatial sources -> PostGIS -> site constraints -> context/policy
engine", kept as its own module namespace (gis/) inside local-rag/ so it
shares that folder's venv and repo location without being confused for
the text-retrieval pipeline (retrieve.py/orchestrate.py) - this is a
separate local Postgres+PostGIS database, not Qdrant.

Why Postgres+PostGIS runs via Homebrew, not Docker: this project has no
existing Docker dependency anywhere, and Homebrew's postgresql+postgis
formulas are a smaller, more common footprint for a single local dev
database - see the Desktop launcher script (Setup and Ingest GIS
Data.command) for the actual install/start steps, which is where this
decision is implemented, not here.
"""

import os
from pathlib import Path

GIS_DIR = Path(__file__).resolve().parent
LOCAL_RAG_DIR = GIS_DIR.parent
SCHEMA_PATH = GIS_DIR / "schema.sql"

# Local-only Postgres+PostGIS database - default matches the Desktop
# launcher script's `createdb` call. Overridable via env var in case the
# user already has a differently-named/ported local Postgres.
GIS_DATABASE_URL = os.environ.get(
    "GIS_DATABASE_URL", "postgresql:///urban_ai_gis"
)

PLANNING_DATA_BASE = "https://www.planning.data.gov.uk"

# Confirmed via the Planning Data entity API (2026-09-14):
# https://www.planning.data.gov.uk/entity/626201 - "Westminster LPA",
# dataset=local-planning-authority, reference E60000201. Used as the
# default geometry_entity to scope ingestion to Westminster first, per
# architecture-plan section 29's "depth in Westminster over shallow
# national breadth" - not a claim that this is the only LPA ever
# supported; gis_ingest.py's --lpa-entity flag ingests any other LPA the
# same way once you have its entity ID (look it up at
# planning.data.gov.uk by searching the authority's name, or via
# entity.json?dataset=local-planning-authority&q=<name>).
DEFAULT_LPA_ENTITY = 626201
DEFAULT_LPA_NAME = "Westminster"

# The four constraint datasets this MVP covers, and the table each loads
# into (see schema.sql). architecture-plan section 27 names these same
# four questions explicitly: conservation area, listed, Article 4, Green
# Belt - "which LPA" is answered separately via
# local_planning_authorities, which is ingested nationally (see
# gis_ingest.py) rather than per-LPA like these four.
CONSTRAINT_DATASETS = {
    "conservation-area": {
        "table": "conservation_areas",
        "name_field": "name",
        "extra_fields": {},
    },
    "listed-building-outline": {
        "table": "listed_building_outlines",
        "name_field": "name",
        "extra_fields": {"listed_grade": "listed-building-grade"},
    },
    "article-4-direction-area": {
        "table": "article_4_direction_areas",
        "name_field": "name",
        "extra_fields": {"article_4_direction": "article-4-direction"},
    },
    "green-belt": {
        "table": "green_belt",
        "name_field": "name",
        "extra_fields": {},
    },
    # Added 2026-09-17 alongside the pivot to national regulatory
    # coverage (building law/fire safety/flood risk) - see
    # local-rag-status.md's decision note. Slots into the exact same
    # generic dict-driven pattern the four constraints above already
    # use, so gis_ingest.py needed zero changes to pick this up.
    #
    # extra_fields confirmed 2026-09-18 by inspecting a real Planning
    # Data entity (https://www.planning.data.gov.uk/entity/65000155.json,
    # reference "156/2") since this session's network couldn't reach a
    # live entity.geojson response at build time (see the comment this
    # replaces, and local-rag-status.md's "Pivot" section) - the raw
    # entity carries "flood-risk-level" (e.g. "2", "3" - the zone
    # category) and "flood-risk-type" (e.g. "Coastal Events" - which
    # kind of flooding), both separate from "reference".
    "flood-risk-zone": {
        "table": "flood_risk_zones",
        "name_field": "name",
        "extra_fields": {
            "flood_risk_level": "flood-risk-level",
            "flood_risk_type": "flood-risk-type",
        },
    },
}


def get_conn():
    """psycopg2 connection - imported lazily so modules that don't touch
    the database (e.g. a future caller that only wants CONSTRAINT_DATASETS)
    don't need psycopg2 installed to import this file."""
    import psycopg2

    return psycopg2.connect(GIS_DATABASE_URL)
