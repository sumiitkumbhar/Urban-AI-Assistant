-- Site/spatial-intelligence schema (architecture-plan section 27/28) -
-- the PostGIS half of "Planning Data / official spatial sources -> PostGIS
-- -> site constraints -> context/policy engine". Kept in its own local
-- Postgres database (default name urban_ai_gis), separate from Qdrant
-- (local-rag's text retrieval index) and from the live app's Supabase
-- Postgres - this is deliberately local-only per the zero-budget/
-- local-first rule (architecture-plan section 51), and separate from
-- Supabase so it never depends on that project's schema or quota.
--
-- Run once via gis_schema_init.py (idempotent - every statement below is
-- CREATE IF NOT EXISTS), not by hand.

CREATE EXTENSION IF NOT EXISTS postgis;

-- National dataset (small - ~300 authorities) - ingested everywhere, not
-- just Westminster, because "which LPA applies" is meaningful for any UK
-- site, and the whole dataset costs nothing to keep local.
CREATE TABLE IF NOT EXISTS local_planning_authorities (
    entity BIGINT PRIMARY KEY,
    reference TEXT,
    name TEXT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
    source_url TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lpa_geom
    ON local_planning_authorities USING GIST (geom);

-- The four constraint layers below are ingested scoped to one or more
-- local planning authorities at a time (see gis_ingest.py's
-- --lpa-entity flag) - architecture-plan section 47 explicitly warns
-- against mass-ingesting every dataset for the whole country. Each row
-- also records which LPA(s) have been ingested in gis_coverage, so a
-- lookup for a site outside that coverage can say "not checked" instead
-- of silently implying "no constraint found" (section 27's warning:
-- "no result from an incomplete dataset must not be presented as proof
-- that a constraint does not exist").

CREATE TABLE IF NOT EXISTS conservation_areas (
    entity BIGINT PRIMARY KEY,
    reference TEXT,
    name TEXT,
    organisation_entity BIGINT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
    source_url TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conservation_areas_geom
    ON conservation_areas USING GIST (geom);

CREATE TABLE IF NOT EXISTS listed_building_outlines (
    entity BIGINT PRIMARY KEY,
    reference TEXT,
    name TEXT,
    listed_grade TEXT,
    organisation_entity BIGINT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
    source_url TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listed_building_outlines_geom
    ON listed_building_outlines USING GIST (geom);

CREATE TABLE IF NOT EXISTS article_4_direction_areas (
    entity BIGINT PRIMARY KEY,
    reference TEXT,
    name TEXT,
    article_4_direction TEXT,
    organisation_entity BIGINT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
    source_url TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_article_4_direction_areas_geom
    ON article_4_direction_areas USING GIST (geom);

CREATE TABLE IF NOT EXISTS green_belt (
    entity BIGINT PRIMARY KEY,
    reference TEXT,
    name TEXT,
    organisation_entity BIGINT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
    source_url TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_green_belt_geom
    ON green_belt USING GIST (geom);

-- Tracks which LPA each constraint layer has actually been ingested for,
-- so gis_lookup.py can tell "genuinely no constraint here" apart from
-- "haven't ingested this area yet" per-dataset, per-authority.
CREATE TABLE IF NOT EXISTS gis_coverage (
    dataset TEXT NOT NULL,
    lpa_entity BIGINT NOT NULL,
    lpa_name TEXT,
    feature_count INTEGER NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset, lpa_entity)
);

-- Minimal site digital-twin table (architecture-plan section 28) - just
-- identity + geometry for now. Proposal/constraints/risks/decisions from
-- the fuller section 28 model are deliberately deferred until something
-- actually needs to persist a project's state across queries; today a
-- site is just "the thing this lookup was run for", not stored history.
CREATE TABLE IF NOT EXISTS sites (
    id SERIAL PRIMARY KEY,
    label TEXT,
    postcode TEXT,
    geom GEOMETRY(Point, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sites_geom ON sites USING GIST (geom);

-- Structured project state (architecture-plan section 22/23/28's
-- "structured project state" layer - Phase 7's first slice, chosen and
-- scoped with the product owner 2026-09-15, in preference to a fourth
-- local database or a new Supabase table: this reuses the existing
-- local urban_ai_gis Postgres database GIS already runs, evolving the
-- `sites` table above from its original bare placeholder ("deliberately
-- deferred until something actually needs to persist a project's state
-- across queries" - see its own comment) into the fuller section-28
-- project record. See local-rag/project_state.py for the Python layer;
-- the underlying table stays named `sites` (it's the same row - a
-- project's core identity IS its site) but every function there is
-- named/framed around "project", matching how a user actually thinks
-- about this. Deliberately NOT the rest of section 23's memory
-- architecture (semantic memory, episodic memory, conflict handling,
-- consolidation, reusable skills/workflows) - this is only the "what is
-- currently true" structured-state layer; the rest of Phase 7 needs its
-- own separate scoping before it's built.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS lpa_reference TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS geography TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS proposed_use TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS units INTEGER;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS storeys INTEGER;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS floorspace_sqm NUMERIC;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS height_m NUMERIC;
-- Free text, not an enum - "what stages exist" is a product decision
-- nobody has made yet (enquiry/pre-app/application/appeal/... vary by
-- authority and project type); a CHECK constraint here would just be a
-- guess. Revisit once real project data shows what values actually get
-- used.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS stage TEXT;
-- Cached copy of gis_lookup.py's site_constraints() result (the same
-- JSON shape /site-answer already returns) so a project's constraints
-- don't need re-querying PostGIS on every turn - refreshed explicitly
-- via project_state.refresh_constraints(), not on a timer, since GIS
-- coverage itself only changes when someone re-runs gis_ingest.py.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS constraints_json JSONB;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS constraints_checked_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- A project's outstanding/open questions (section 28's "Outstanding
-- questions" list) - a separate table since a project can have any
-- number of them, unlike the single-row fields above.
CREATE TABLE IF NOT EXISTS project_open_questions (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_project_open_questions_site
    ON project_open_questions (site_id);

-- Flood risk zone (2026-09-17) - added when the product decision shifted
-- from growing council coverage further to covering national regulatory
-- topics that apply everywhere: building law, fire safety, flood risk
-- (see local-rag-status.md's decision note, same date). Mirrors
-- conservation_areas/green_belt's shape exactly - this is the same
-- generic CONSTRAINT_DATASETS-driven pattern gis_ingest.py already uses,
-- so no changes to gis_ingest.py itself were needed, only this table
-- plus the new dict entry in gis_common.py.
--
-- Source: planning.data.gov.uk's flood-risk-zone dataset (Environment
-- Agency guidance, England - "flood zone 1 areas least likely to flood,
-- flood zone 3 areas more likely to flood").
CREATE TABLE IF NOT EXISTS flood_risk_zones (
    entity BIGINT PRIMARY KEY,
    reference TEXT,
    name TEXT,
    organisation_entity BIGINT,
    geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
    source_url TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flood_risk_zones_geom
    ON flood_risk_zones USING GIST (geom);

-- Added 2026-09-18: the zone 1/2/3 category field was confirmed by
-- inspecting a real Planning Data entity outside this session's own
-- restricted network (see gis_common.py's CONSTRAINT_DATASETS comment
-- for the exact source) - it's "flood-risk-level" ("1"/"2"/"3"), plus a
-- separate "flood-risk-type" ("Coastal Events" etc: which kind of
-- flooding, not how severe). ADD COLUMN IF NOT EXISTS is safe to run
-- any time, including against the 2 rows already ingested for
-- Westminster on 2026-09-17 - re-running gis_ingest.py after this
-- schema change will backfill both columns for them.
ALTER TABLE flood_risk_zones ADD COLUMN IF NOT EXISTS flood_risk_level TEXT;
ALTER TABLE flood_risk_zones ADD COLUMN IF NOT EXISTS flood_risk_type TEXT;

-- Episodic + semantic memory + conflict detection (2026-09-18) -
-- architecture-plan section 23's remaining Phase 7 tiers, picked up
-- after structured project state (the "canonical current state" tier,
-- the ALTER TABLE sites / project_open_questions block above) shipped
-- 2026-09-15. See memory.py's module docstring for the full design;
-- these three tables are just the storage.

-- Episodic memory: a timestamped log of what happened on ONE project -
-- questions asked (auto-logged by service.py whenever a /query carries
-- a project_id), decisions made, freeform notes. Mirrors
-- project_open_questions's site_id/ON DELETE CASCADE shape.
CREATE TABLE IF NOT EXISTS project_events (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,  -- 'query' | 'decision' | 'note'
    summary TEXT NOT NULL,
    detail TEXT,
    source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'auto'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_events_site
    ON project_events (site_id, created_at DESC);

-- Semantic memory: knowledge distilled ACROSS projects, scoped by
-- geography (an LPA slug, e.g. "westminster" - the same slug local-rag's
-- own corpus/geography_filter already use) rather than per-project,
-- since the point of this tier is patterns that generalize beyond one
-- site. Populated only by memory.distill_lpa_knowledge() - an explicit,
-- on-demand LLM distillation, never written to directly.
CREATE TABLE IF NOT EXISTS lpa_knowledge (
    id SERIAL PRIMARY KEY,
    geography TEXT NOT NULL,
    fact TEXT NOT NULL,
    source_event_ids INTEGER[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lpa_knowledge_geography
    ON lpa_knowledge (geography);

-- Conflicts: flagged when a new "decision" project_events entry appears
-- to genuinely contradict an earlier event on the same project, or
-- existing lpa_knowledge for its authority - see memory.detect_conflicts().
-- Never auto-resolved; a person reviews each one and sets status.
CREATE TABLE IF NOT EXISTS memory_conflicts (
    id SERIAL PRIMARY KEY,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    new_event_id INTEGER REFERENCES project_events(id) ON DELETE CASCADE,
    conflicting_with TEXT NOT NULL,
    explanation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'acknowledged' | 'dismissed'
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_conflicts_site
    ON memory_conflicts (site_id);
-- Geocode directory (added 2026-09-20, per explicit request: "build a
-- proper and precise Geocode directory for our AI to track so that it
-- never makes any mistake"). Two tables, two different jobs -
-- site_lookup.py's auto-detection (proposal_review.py, when a proposal
-- has no project_id/postcode/lat-lon at all) uses both, in order:
--
--   1. known_places - a curated NAME -> point directory. Checked before
--      ever calling Nominatim's live free-text geocoder, so a name
--      already in here (a council, a named development) resolves to a
--      known, audited point instead of a fresh third-party guess every
--      time. Seeded from local_planning_authorities' own geometry
--      (known_places.seed_from_lpas() - a government-sourced polygon
--      centroid, not a geocoder's guess at the name) and grows from
--      verified entries added as real reviews surface names worth
--      remembering. This does NOT make a name-derived site infallible -
--      see known_places.py's own docstring - it only removes the
--      *geocoding* uncertainty, not the *inference* uncertainty of
--      whether that name is really where the site is.
--
--   2. postcodes - a local POSTCODE -> point cache/directory, checked
--      before calling the live postcodes.io API to validate a postcode
--      actually found written in a proposal's text. Self-fills one row
--      at a time as gis_lookup.geocode_postcode() is used (so it's
--      useful from day one with zero setup), and can also be bulk-
--      loaded in one go from the ONS Postcode Directory (free, no API
--      key, the same underlying source postcodes.io's own service is
--      built from - see postcode_ingest.py's docstring) via
--      postcode_ingest.py for full national coverage up front.

CREATE TABLE IF NOT EXISTS known_places (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    name_normalized TEXT NOT NULL UNIQUE,
    postcode TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    source TEXT NOT NULL,  -- e.g. 'lpa-centroid' | 'manual' | 'proposal-review'
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_known_places_name_normalized
    ON known_places (name_normalized);

CREATE TABLE IF NOT EXISTS postcodes (
    postcode TEXT PRIMARY KEY,  -- normalized 'OUTWARD INWARD', e.g. 'SW1V 3LX'
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    source TEXT NOT NULL DEFAULT 'postcodes.io',  -- 'postcodes.io' | 'postcodes.io-reverse' | 'onspd'
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
