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
