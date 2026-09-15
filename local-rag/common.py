# Shared paths, config and the chunk record shape used by every script in
# this folder. Centralized here so ingest.py / retrieve.py / answer.py /
# service.py / query_cli.py all agree on where things live without each
# hardcoding its own copy of the same five paths.
#
# Why this exists at all (read this before touching paths): the offline
# corpus was triaged from a session that reaches your Mac through a
# sandboxed bridge, NOT your real Terminal - that bridge's own filesystem
# is a separate, temporary Linux sandbox, so anything it pip-installs
# (compiled packages like torch) is a Linux binary that cannot run on your
# actual macOS Python. Every file in this folder is plain, portable Python
# source (safe to have been written that way) but the venv itself, and the
# one-time ingest run, have to happen in YOUR OWN Terminal on your actual
# Mac - see "Setup and Ingest Local RAG.command" on your Desktop.

import os
import re
from pathlib import Path

LOCAL_RAG_DIR = Path(__file__).resolve().parent
REPO_DIR = LOCAL_RAG_DIR.parent

# Corpus location. This has already moved once - it started at
# ~/Desktop/Corpus, then got reorganized (by hand, on the Mac) into
# ~/Desktop/Urban AI Corpus/Corpus - so rather than hardcoding one path,
# this picks whichever of the known locations actually exists on disk.
# Override with CORPUS_DIR in the environment any time it moves again.
def _resolve_corpus_dir():
    override = os.environ.get("CORPUS_DIR")
    if override:
        return Path(override)
    candidates = [
        Path.home() / "Desktop" / "Urban AI Corpus" / "Corpus",  # current
        Path.home() / "Desktop" / "Corpus",  # original location
    ]
    for c in candidates:
        if c.exists():
            return c
    # Nothing found - fall back to the current-layout guess. ingest.py
    # checks CORPUS_DIR.exists() itself and prints a clear error naming
    # this exact path plus the CORPUS_DIR env var override if it's wrong.
    return candidates[0]


CORPUS_DIR = _resolve_corpus_dir()

# The triage manifest built during Phase 1 (corpus_manifest.json, sitting
# beside this file) - filename -> bucket/domain/geography/doc_type/notes.
# ingest.py reads this to decide what to embed at all: only ACTIVE_CORE
# and ACTIVE_SUPPORTING participate in default retrieval, matching
# section 37 of the architecture README.
MANIFEST_PATH = LOCAL_RAG_DIR / "corpus_manifest.json"

DATA_DIR = LOCAL_RAG_DIR / "data"
CHUNKS_PATH = DATA_DIR / "chunks.jsonl"
QDRANT_PATH = DATA_DIR / "qdrant"
BM25_PATH = DATA_DIR / "bm25_index.pkl"
GRAPH_PATH = DATA_DIR / "reference_graph.pkl"
QDRANT_COLLECTION = "regulatory_knowledge"  # matches section 21 of the README
MAP_DOCUMENTS_PATH = DATA_DIR / "map_documents.json"

# UK council Local Plans (council_ingest.py) - a separate, additive
# manifest from MANIFEST_PATH above, folded in by ingest.py's
# load_council_manifest(). See council_ingest.py's module docstring for
# the full two-step download-then-index design.
COUNCIL_MANIFEST_PATH = DATA_DIR / "council_manifest.json"

# Map-graphic PDFs are pure scanned/vector maps (conservation-area
# boundary maps, borough Policies Maps) that carry no real prose - their
# "extracted text" is scrambled street-label fragments off a graphic,
# e.g. "Pl ON W AT E RO SO AD RD N'S PL Ms EB E YL AR..." (confirmed by
# hand against Bayswater conservation area map.pdf and the 31MB
# city-plan-2019-2040-adoption-policies-map.pdf). Chunking and embedding
# that noise doesn't help retrieval - it dilutes the index with junk
# vectors that can outrank real policy text for no reason. Excluded from
# ingest.py's text-chunking pipeline as of 2026-09-15; ingest.py instead
# records them to MAP_DOCUMENTS_PATH as a lightweight index for a planned
# visual-citation feature (attach the real map alongside a GIS
# conservation-area/policy-area lookup result, instead of text-searching
# it) - see local-rag-status.md's "Map documents" section.
#
# This is an explicit filename list, not a substring/doc_type rule,
# because doc_type alone doesn't distinguish map graphics from real text
# documents that happen to be *about* a map - e.g. "CORE_004 Schedule of
# changes to Policies Map.pdf" and "CORE_006 Addendum to Schedule of
# Changes to Policies Map (I) (November 2024).pdf" share the "City Plan
# Review examination material" doc_type with the actual map PDFs, but are
# genuine prose/tabular schedules (checked by hand: CORE_004 page 1 reads
# "Regulation 19 Consultation / March 2024", not map-graphic noise) and
# stay in the normal text pipeline.
MAP_GRAPHIC_FILENAMES = frozenset({
    "Aldridge and Leamington Road villas conservation area map.pdf",
    "Bayswater conservation area map.pdf",
    "Belgravia conservation area map.pdf",
    "CORE_003 Reg19 Policies Map.pdf",
    "CORE_005 Submission Policies Map.pdf",
    "Charlotte Street West conservation area map.pdf",
    "Chinatown conservation area map.pdf",
    "Covent Garden conservation area map.pdf",
    "Dolphin Square conservation area map.pdf",
    "Dorset Square conservation area map.pdf",
    "East Marylebone conservation area map.pdf",
    "Fisherton Street Estate conservation area map.pdf",
    "Grosvenor Gardens conservation area map.pdf",
    "Hallfield Estate conservation area map.pdf",
    "Hanway Street conservation area map.pdf",
    "Haymarket conservation area map.pdf",
    "Knightbridge Green conservation area map.pdf",
    "Knightsbridge conservation area map.pdf",
    "churchillgardensmap.pdf",
    "city-plan-2019-2040-adoption-policies-map-january-2026.pdf",
})


# Exact-reference regex patterns - originally lived only in retrieve.py's
# exact-reference boost, centralized here now that graph_build.py also
# needs the same definition of "what counts as a reference" (two places
# deriving that independently is how they drift). Matches section 41's
# example list - deliberately simple/conservative: a false match here
# only adds a small score boost, it never filters anything out, so a
# slightly-too-eager pattern is low-risk.
EXACT_REFERENCE_PATTERNS = [
    re.compile(r"\bpolicy\s+[a-z]{0,2}\d+[a-z]?\b", re.I),
    re.compile(r"\bparagraph\s+\d+\b", re.I),
    re.compile(r"\bapproved\s+document\s+[a-z]\b", re.I),
    re.compile(r"\bsection\s+\d+\b", re.I),
    re.compile(r"\bregulation\s+\d+\b", re.I),
]

# Graph RAG (architecture plan section 52, confirmed scope, built after
# the Corrective-RAG/Self-RAG increment) - graph_build.py builds a
# cross-reference graph from which references co-occur in the same
# chunk; retrieve.py uses it to give a smaller secondary boost to
# references related to what the query named, on top of - never instead
# of - the existing dense (semantic/Qdrant) + sparse (BM25) hybrid
# search. See graph_build.py's module docstring for the full reasoning.
GRAPH_CO_OCCURRENCE_MIN = 2   # ignore one-off co-occurrences as noise
GRAPH_MAX_RELATED = 5
GRAPH_EXPANSION_BOOST = 0.02  # smaller than the direct exact-reference boost (0.05)

# Embedding model: a small, CPU-friendly BGE model. BGE's own docs call
# for prefixing the QUERY (never the passage) with this instruction string
# for asymmetric retrieval - get it wrong and recall quietly gets worse
# without throwing any error, so it's centralized here rather than
# duplicated (and risking drift) between ingest.py and retrieve.py.
EMBEDDING_MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBEDDING_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
EMBEDDING_DIM = 384

RERANKER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"

CHUNK_TARGET_CHARS = 1000
CHUNK_OVERLAP_CHARS = 150

# Corrective-RAG-style confidence thresholds and document-status boost
# (architecture plan section 52, "next-increment" items 1-2: turn the
# retrieval-quality confidence check on, and start using each chunk's
# `status` field instead of treating current/historic/superseded
# material as equally preferred). Centralized here for the same reason
# EMBEDDING_QUERY_PREFIX is: retrieve.py and answer.py both need to
# agree on what "low confidence" means without duplicating the numbers.
#
# STATUS_BOOST is a small nudge added to a chunk's fused score, same
# mechanism as retrieve.py's exact-reference boost - it never filters
# anything out, it just breaks ties in favour of current material when
# a current and a historic/superseded version of the same policy both
# come back for the same query (the known trade-off documented in
# ingest.py's docstring and README.md).
STATUS_BOOST = {
    "current": 0.03,
    "future": 0.0,
    "consultation": -0.02,
    "draft": -0.02,
    "supporting_evidence": 0.0,
    "historic": -0.04,
    "superseded": -0.05,
}

# Cross-encoder rerank scores below this are "low confidence" (Corrective
# RAG's confidence check); at/above this are "high confidence". Anything
# in between is "medium". These are the raw ms-marco-MiniLM-L-6-v2 scores
# from retrieve.py's reranker - not calibrated probabilities - so treat
# them as directional, not absolute; revisit once real queries have been
# run against the full 185-file corpus.
CONFIDENCE_TOP_SCORE_HIGH = 0.55
CONFIDENCE_TOP_SCORE_LOW = 0.15
MIN_SOURCE_DIVERSITY_FOR_HIGH = 2

# Agentic/Multi-Agent RAG (architecture plan section 52 - the last item
# on the confirmed-in-scope list, section 13's "controlled orchestrator +
# specialist subagents" sketch). DOMAIN_KEYWORDS is the (free, local,
# zero-LLM-call) query classifier orchestrate.py uses to decide which
# domain-scoped retrieval "agents" a query actually needs - see that
# file's module docstring for the full reasoning on why this is regex
# keyword-matching rather than an LLM call doing decomposition (section
# 52/47: every extra agent is another call against a rate-limited free
# tier, so classification itself has to be free). Keys must match the
# `domain` values corpus_manifest.json actually uses (checked directly
# against the real manifest: planning=87 files, heritage=84,
# building_regulations=10, site_environment=7, legislation=1 - legislation
# is too small a bucket to justify its own specialist agent, so queries
# about acts/regulations are expected to be caught by the building_regs
# or planning keyword sets instead, whichever the query is actually about).
# Deliberately specific, multi-word phrases where possible rather than
# single generic words like "policy" - a keyword so broad it fires on
# almost every query would turn every query into a multi-agent query,
# defeating section 13's "only use subagents when isolation/parallel
# investigation genuinely helps."
DOMAIN_KEYWORDS = {
    "planning": [
        r"\bplanning permission\b", r"\bplanning application\b",
        r"\bdevelopment\b", r"\baffordable housing\b", r"\bviability\b",
        r"\bCIL\b", r"\bcommunity infrastructure levy\b", r"\bdensity\b",
        r"\bland use\b", r"\bpolicy [a-z]{0,2}\d+[a-z]?\b", r"\bmasterplan\b",
        r"\bfloorspace\b", r"\bplot ratio\b",
    ],
    "heritage": [
        r"\bconservation area\b", r"\blisted building\b",
        r"\bheritage asset\b", r"\bhistoric character\b", r"\btownscape\b",
        r"\bsetting of\b", r"\bhistoric england\b", r"\barchaeolog",
        r"\bdemolition of\b", r"\bconservation area audit\b",
    ],
    "building_regulations": [
        r"\bapproved document\b", r"\bbuilding regulations?\b",
        r"\bfire safety\b", r"\bmeans of escape\b", r"\bparty wall\b",
        r"\bstructural\b", r"\bventilation\b", r"\bpart m\b",
        r"\bfire resistance\b", r"\bsound insulation\b", r"\bpart e\b",
        r"\bdrainage\b", r"\bpart h\b",
    ],
    "site_environment": [
        r"\bbiodiversity\b", r"\bcontaminated land\b", r"\bretrofit\b",
        r"\bflood risk\b", r"\becology\b", r"\bair quality\b",
        r"\bsustainability\b", r"\benergy efficiency\b", r"\btree survey\b",
        r"\barboricultural\b",
    ],
}
# Cap on how many domain agents a single query can fan out to, even if
# more than this many domains' keywords match - a soft ceiling against
# the "huge multi-agent swarm" section 47 explicitly warns against. There
# are only 4 domains defined above anyway, so this mostly guards against
# a future larger DOMAIN_KEYWORDS dict rather than doing much today.
MAX_AGENTS = 3

DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"
# Groq retired llama-3.3-70b-versatile on 2026-08-16 (answer.py started
# 404ing with "model does not exist or you do not have access to it" -
# not a code bug, the model ID itself stopped existing). Groq's own
# deprecation notice names openai/gpt-oss-120b and qwen/qwen3.6-27b as
# the replacements; gpt-oss-120b is the one still on Groq's free tier
# (no credit card, rate-limited - 30 req/min, 8k tokens/min, 1000
# req/day as of this note) and is the "production" pick over the
# qwen model, which Groq still marks preview. If this 404s again later,
# check https://console.groq.com/docs/deprecations for whatever
# replaced this one too - Groq retires model IDs on a rolling basis,
# this isn't a one-time fix.


def load_dotenv_from_repo():
    """.env.local lives at the repo root (Next.js convention) - reuse the
    same GROQ_API_KEY the live app already has configured rather than
    asking you to set it up a second time in a different place."""
    from dotenv import load_dotenv
    env_path = REPO_DIR / ".env.local"
    if env_path.exists():
        load_dotenv(env_path)
