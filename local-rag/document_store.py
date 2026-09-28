"""SQLite-backed document/block/patch/revision store - Phase 0-1 of the
interactive document block-editing architecture (project architecture
plan, section 53, 2026-09-24). Replaces the flat paragraphs.json/
meta.json pair document_edit.py used through 2026-09-23 with a small,
local, transactional store - Python's stdlib sqlite3, zero new
dependency, one shared file (documents.db) for every document.

Deliberately NOT wired into service.py's HTTP surface directly in this
phase - document_edit.py's existing public functions (load_paragraphs,
load_meta, save_document, edit_document_clause) keep their EXACT same
signatures and return shapes; internally, they now read/write through
this module instead of flat JSON files. This is Phase 1 of the phased
plan in section 53: ship a tested, versioned, validated backend with
ZERO frontend/API risk before adding the real alternatives-before-replace
UI in Phase 2.

Persistent block identity: a paragraph's original small integer id
(1, 2, 3... assigned once at extraction, exactly as before) is kept as
`local_id` and is still what every external caller (service.py,
ChatInterface.tsx, the "paragraph 4" chat instruction match) sees and
names - nothing about that changes. Internally each paragraph also gets
a globally-unique `block_id` (f"{doc_id}::{local_id}") since this file
is one shared database across every document, not one file per document
- a bare "1" would otherwise collide between two different documents'
first paragraph. This is what section 53 means by "persistent IDs, never
keyed on visible text": block_id is derived once from (doc_id, local_id)
and never changes even though the block's `text` does, on every edit.

Schema (see architecture plan section 53 for the full rationale of each
table):
  documents        - one row per document. current_version is the
                      optimistic-concurrency counter every patch checks
                      against (base_doc_version) before it's allowed to
                      apply - this is the literal "reject stale patches"
                      mechanism.
  blocks           - current, MUTABLE pointer: one row per block, always
                      reflecting the latest ACCEPTED revision's text.
  block_revisions  - IMMUTABLE, append-only: every revision of every
                      block, ever. Nothing here is ever UPDATEd or
                      DELETEd by any function in this module - undo
                      (not yet wired to an endpoint, Phase 5) is meant to
                      be a NEW revision, never a rewrite of an old one.
  patches          - one row per proposed edit OPERATION (the
                      client-generated patch_id is itself the
                      idempotency key), whether it ends up applied,
                      rejected, or left stale. Phase 1 only ever creates
                      these internally (one per edit_document_clause()
                      call, auto-applied) - Phase 2 exposes propose/
                      choose/reject as real endpoints a client drives.
  patch_alternatives - the alternative text(s) generated for a patch,
                      before any is chosen. Phase 1 always writes exactly
                      one (index 0, label "default") since
                      edit_document_clause() still rewrites-and-applies
                      in one step; Phase 2 writes three.

Every write that changes `blocks` + `block_revisions` +
`documents.current_version` together happens inside one sqlite3
transaction (`with conn:`) - a crash or exception mid-write can never
leave the document's version bumped without its revision recorded, or
vice versa. This is the literal "transactional" requirement from section
53, not just a description of intent.
"""

import json
import re
import sqlite3
import time
import uuid
from pathlib import Path

DOCUMENTS_DIR = Path(__file__).parent / "documents"
DB_PATH = DOCUMENTS_DIR / "documents.db"

# The flat paragraphs.json/meta.json shape every document created before
# this module existed used is implicitly schema version 1. Every document
# this module creates or migrates is version 2 (the SQLite-backed shape
# above). See migrate_document_if_needed() below for the 1 -> 2 upgrade.
SCHEMA_VERSION = 2


class PatchConflict(Exception):
    """Raised by apply_edit()/validate_patch_application() when a patch
    can't be applied as requested - stale base_doc_version, a citation
    marker with no matching frozen citation, an unknown block, etc. The
    caller (document_edit.edit_document_clause(), or a future Phase 2
    endpoint) turns this into the same {"error": ...} shape every other
    best-effort call in this codebase already returns, rather than
    letting a raw exception reach the HTTP layer."""


def _connect():
    DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS documents (
          doc_id            TEXT PRIMARY KEY,
          schema_version    INTEGER NOT NULL DEFAULT 2,
          filename          TEXT NOT NULL,
          geography         TEXT,
          project_id        INTEGER,
          postcode          TEXT,
          current_version   INTEGER NOT NULL DEFAULT 1,
          created_at        TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blocks (
          block_id             TEXT PRIMARY KEY,
          doc_id                TEXT NOT NULL REFERENCES documents(doc_id),
          local_id               INTEGER NOT NULL,
          seq                     INTEGER NOT NULL,
          page                    INTEGER NOT NULL,
          bbox                    TEXT NOT NULL,
          font_size               REAL,
          current_revision_id     TEXT NOT NULL,
          status                  TEXT NOT NULL DEFAULT 'clean',
          flagged_content         INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_doc ON blocks(doc_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_doc_local
          ON blocks(doc_id, local_id);

        CREATE TABLE IF NOT EXISTS block_revisions (
          revision_id        TEXT PRIMARY KEY,
          block_id             TEXT NOT NULL REFERENCES blocks(block_id),
          doc_version           INTEGER NOT NULL,
          text                  TEXT NOT NULL,
          rationale             TEXT,
          citations             TEXT,
          claims                TEXT,
          created_by            TEXT NOT NULL,
          created_at            TEXT NOT NULL,
          parent_revision_id    TEXT,
          patch_id               TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_revisions_block
          ON block_revisions(block_id, created_at);

        CREATE TABLE IF NOT EXISTS patches (
          patch_id             TEXT PRIMARY KEY,
          doc_id                 TEXT NOT NULL,
          block_id                TEXT NOT NULL,
          batch_id                 TEXT,
          base_doc_version          INTEGER NOT NULL,
          instruction                TEXT NOT NULL,
          mode                        TEXT NOT NULL DEFAULT 'edit',
          status                      TEXT NOT NULL DEFAULT 'proposed',
          chosen_alternative          INTEGER,
          error                       TEXT,
          created_at                  TEXT NOT NULL,
          applied_at                  TEXT
        );

        CREATE TABLE IF NOT EXISTS patch_alternatives (
          patch_id     TEXT NOT NULL REFERENCES patches(patch_id),
          alt_index    INTEGER NOT NULL,
          label        TEXT NOT NULL,
          text         TEXT NOT NULL,
          citations    TEXT NOT NULL,
          claims       TEXT,
          PRIMARY KEY (patch_id, alt_index)
        );
        """
    )
    conn.commit()


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _new_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _block_id(doc_id, local_id):
    return f"{doc_id}::{local_id}"


# --- Document / block creation -------------------------------------------


def document_exists(doc_id):
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT 1 FROM documents WHERE doc_id = ?", (doc_id,)
        ).fetchone()
        return row is not None
    finally:
        conn.close()


def create_document(doc_id, filename, paragraphs, geography=None, project_id=None,
                     postcode=None):
    """Creates a brand-new document (documents row + one blocks row and
    one initial block_revisions row per paragraph) - the SQLite
    equivalent of the old save_document()'s two file writes. Idempotent:
    a doc_id that already exists is left untouched, so calling this
    twice for the same id is safe (matters once Phase 2 clients can
    retry a request)."""
    conn = _connect()
    try:
        with conn:
            if conn.execute(
                "SELECT 1 FROM documents WHERE doc_id = ?", (doc_id,)
            ).fetchone():
                return
            now = _now()
            conn.execute(
                "INSERT INTO documents "
                "(doc_id, schema_version, filename, geography, project_id, "
                " postcode, current_version, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (doc_id, SCHEMA_VERSION, filename, geography, project_id,
                 postcode, 1, now),
            )
            for seq, p in enumerate(paragraphs, start=1):
                block_id = _block_id(doc_id, p["id"])
                revision_id = _new_id("rev")
                # blocks must be inserted BEFORE block_revisions here:
                # block_revisions.block_id has a REFERENCES blocks(block_id)
                # foreign key, so the block row has to exist first even
                # though it points at a revision_id that doesn't exist as
                # a row yet (blocks.current_revision_id has no FK
                # constraint - see the schema comment above - precisely
                # so this insert order is legal).
                conn.execute(
                    "INSERT INTO blocks "
                    "(block_id, doc_id, local_id, seq, page, bbox, font_size, "
                    " current_revision_id, status, flagged_content) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (block_id, doc_id, p["id"], seq, p["page"],
                     json.dumps(p["bbox"]), p.get("font_size"),
                     revision_id, "clean", int(bool(p.get("flagged_content")))),
                )
                conn.execute(
                    "INSERT INTO block_revisions "
                    "(revision_id, block_id, doc_version, text, rationale, "
                    " citations, claims, created_by, created_at, "
                    " parent_revision_id, patch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (revision_id, block_id, 1, p["text"], None, "[]", "[]",
                     "user", now, None, None),
                )
    finally:
        conn.close()


def migrate_document_if_needed(doc_id, load_legacy_fn):
    """Lazy migration (architecture plan section 53's "Schema
    versioning/migrations" - run on first access, not a startup scan of
    every stored document). If `doc_id` has no row in `documents` yet but
    `load_legacy_fn()` returns a (paragraphs, meta) pair from the old
    flat-file shape, this upgrades it into the SQLite tables above -
    exactly the same shape create_document() produces for a brand-new
    document, so both paths converge. load_legacy_fn is injected by the
    caller (document_edit.py) rather than this module reading
    paragraphs.json/meta.json itself, so this store has no dependency on
    the legacy file format beyond this one narrow upgrade path."""
    if document_exists(doc_id):
        return False
    legacy = load_legacy_fn(doc_id)
    if legacy is None:
        return False
    paragraphs, meta = legacy
    create_document(
        doc_id, meta.get("filename", doc_id), paragraphs,
        geography=meta.get("geography"), project_id=meta.get("project_id"),
        postcode=meta.get("postcode"),
    )
    # A pre-existing document may already have been edited under the old
    # flat-file scheme (paragraphs marked edited=True, meta.json's version
    # > 1) - the freshly-migrated row set above always starts at
    # current_version=1 with every block's first-ever revision, which
    # would silently DROP that edit history. Not attempted: this
    # migration is written for (and only tested against) documents that
    # haven't been edited yet under the old scheme - every real document
    # under local-rag/documents/ at the time this shipped fits that
    # description. If a genuinely-edited v1 document is ever migrated,
    # its latest text is preserved (create_document() takes the
    # paragraphs' CURRENT text, edited or not) but its prior revision
    # history is not reconstructed - flagged here rather than silently
    # assumed fine.
    return True


# --- Reads -----------------------------------------------------------------


def get_document(doc_id):
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM documents WHERE doc_id = ?", (doc_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_blocks(doc_id):
    """Every block, in reading order, joined to its current revision's
    text - the read model document_edit.py's load_paragraphs() uses to
    reconstruct the old paragraphs.json list shape."""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT b.local_id, b.seq, b.page, b.bbox, b.font_size, b.status,
                   b.flagged_content, r.text, r.citations, r.claims,
                   (r.parent_revision_id IS NOT NULL) AS edited
            FROM blocks b
            JOIN block_revisions r ON r.revision_id = b.current_revision_id
            WHERE b.doc_id = ?
            ORDER BY b.seq
            """,
            (doc_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_block_history(doc_id, local_id):
    """Every revision of one block, oldest first - the immutable audit
    trail (architecture plan section 53's "Undo / immutable version
    history"). Not yet wired to an HTTP endpoint (that's Phase 5's
    `GET .../blocks/{block_id}/history`); exposed here so it can already
    be exercised directly and by tests."""
    conn = _connect()
    try:
        block_id = _block_id(doc_id, local_id)
        rows = conn.execute(
            "SELECT * FROM block_revisions WHERE block_id = ? ORDER BY created_at",
            (block_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# --- Patch validator ("the LLM never gets free rein") -----------------------

_CITATION_MARKER_RE = re.compile(r"\[(\d+)\]")


def _citation_ids_referenced(text):
    return {int(n) for n in _CITATION_MARKER_RE.findall(text)}


# --- Content-drift guard (the model can report success while silently ------
# substituting unrelated content - see the 2026-09-25 incident report in the
# project doc, where a paragraph about "Colliery" was replaced end-to-end
# with unrelated "West Harworth" text while still reporting a plausible
# paragraph_id/original_text/citations). This is a cheap, deterministic,
# zero-cost (no embeddings, no extra model call - consistent with this
# project's standing "zero budget, local-first" constraint) word-overlap
# heuristic, not a semantic check - it exists to catch a WRONG-SUBJECT
# substitution, not to judge edit quality. A real edit ("add a line about
# X") should retain most of the original paragraph's distinctive vocabulary
# while adding new material; a substitution swaps it out almost entirely.

_STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "will", "shall",
    "have", "has", "had", "are", "was", "were", "been", "being", "into",
    "also", "such", "than", "then", "they", "their", "there", "where",
    "which", "while", "would", "could", "should", "about", "within",
    "these", "those", "each", "both", "some", "more", "most", "other",
    "over", "under", "between", "through", "during", "including", "not",
}


def _significant_words(text):
    """Lowercased alphabetic words of length >= 4, minus a small stopword
    list - a cheap stand-in for "the distinctive vocabulary of this
    paragraph", used only to detect a wholesale subject swap, not to grade
    edit quality."""
    words = re.findall(r"[a-zA-Z]{4,}", text or "")
    return {w.lower() for w in words} - _STOPWORDS


def _content_drift_ratio(original_text, revised_text):
    """Fraction of the original paragraph's distinctive vocabulary that
    survives into the revised text. Returns None when the original is too
    short/generic for the check to be meaningful (e.g. a title-page date
    fragment like "August 2014") - callers should skip the drift check
    entirely in that case rather than treat None as a failure."""
    original_words = _significant_words(original_text)
    if len(original_words) < 5:
        return None
    revised_words = _significant_words(revised_text)
    return len(original_words & revised_words) / len(original_words)


# A real edit that only adds a sentence or clause typically keeps the large
# majority of the original's distinctive words; a subject swap keeps almost
# none. 0.3 is deliberately generous - low enough that legitimate edits
# (including fairly heavy rewrites of a paragraph's phrasing) pass, but a
# paragraph replaced by unrelated content from elsewhere in the document
# lands far below it. Revisit this threshold if real edits start tripping
# it (see the project doc's "Not yet done" note for this feature).
_CONTENT_DRIFT_MIN_RATIO = 0.3


def validate_patch_application(conn, doc_id, local_id, base_doc_version, text, citations):
    """Runs INSIDE the caller's transaction, before anything is written -
    architecture plan section 53's patch validator. Raises PatchConflict
    (never returns a bool) so a caller can't accidentally ignore a
    validation failure by forgetting to check a return value - the same
    "fail loud, not silent" instinct this codebase already applies to
    citation invention elsewhere.

    1. STALENESS: base_doc_version must equal documents.current_version
       right now, inside this same transaction - the literal "reject
       stale patches" requirement. A caller that read the version a
       moment ago and someone else's edit landed in between gets a clear
       conflict, not a silently-overwritten change.
    2. UNKNOWN BLOCK: the (doc_id, local_id) pair must resolve to a real
       block - never silently create one via an edit call.
    3. CITATION INTEGRITY: every inline [N] marker in `text` must exist
       in `citations`' own id list - no dangling/invented reference is
       ever allowed to reach stored state, regardless of what the model
       claimed.
    4. CONTENT DRIFT: the revised text must share enough of the current
       revision's distinctive vocabulary to plausibly be an edit of the
       same paragraph, not a wrong-subject substitution copied in from
       elsewhere in the document (see the 2026-09-25 incident report in
       the project doc). Skipped when the original is too short for the
       check to be meaningful. A cheap word-overlap heuristic, not a
       semantic judgement - see _content_drift_ratio.

    SCOPE (only the named block may change) is not checked here as a
    runtime assertion - it's enforced by construction: every write this
    validator gates touches exactly one row in `blocks`, named by this
    function's own `doc_id`/`local_id` arguments, in the same statement
    the caller executes right after this passes. There is no code path
    in this module that writes to more than one block per call - the
    same "by construction, not just by prompting" guarantee
    document_edit.py's own module docstring already established for the
    pre-SQLite version of this feature.

    Returns the current block_id/current_revision_id on success (so the
    caller doesn't have to re-query them)."""
    doc_row = conn.execute(
        "SELECT current_version FROM documents WHERE doc_id = ?", (doc_id,)
    ).fetchone()
    if doc_row is None:
        raise PatchConflict(f"No document with id {doc_id!r}.")
    if doc_row["current_version"] != base_doc_version:
        raise PatchConflict(
            f"Stale patch: this edit was proposed against document version "
            f"{base_doc_version}, but the document is now at version "
            f"{doc_row['current_version']}. Re-propose the edit against the "
            f"current version."
        )

    block_id = _block_id(doc_id, local_id)
    block_row = conn.execute(
        "SELECT current_revision_id FROM blocks WHERE block_id = ?", (block_id,)
    ).fetchone()
    if block_row is None:
        raise PatchConflict(f"No block {local_id!r} in document {doc_id!r}.")

    if not (text or "").strip():
        raise PatchConflict("Refusing to apply an empty revision.")

    current_revision_row = conn.execute(
        "SELECT text FROM block_revisions WHERE revision_id = ?",
        (block_row["current_revision_id"],),
    ).fetchone()
    if current_revision_row is not None:
        drift_ratio = _content_drift_ratio(current_revision_row["text"], text)
        if drift_ratio is not None and drift_ratio < _CONTENT_DRIFT_MIN_RATIO:
            raise PatchConflict(
                f"Refusing to apply: the revised text shares only "
                f"{drift_ratio:.0%} of the original paragraph's distinctive "
                f"vocabulary, which looks like a wrong-subject substitution "
                f"rather than an edit of it (see the 2026-09-25 incident "
                f"report). Original started: "
                f"{current_revision_row['text'][:80]!r}... Proposed started: "
                f"{text[:80]!r}..."
            )

    cited_in_text = _citation_ids_referenced(text)
    known_ids = {c.get("id") for c in (citations or [])}
    dangling = cited_in_text - known_ids
    if dangling:
        raise PatchConflict(
            f"Revision cites {sorted(dangling)} but the frozen evidence list for "
            f"this revision only contains {sorted(known_ids)} - refusing to store "
            f"a dangling/invented citation."
        )

    return block_id, block_row["current_revision_id"]


# --- Applying an edit (Phase 1: propose-then-auto-choose-0, one call) ------


def apply_edit(doc_id, local_id, text, rationale, citations, base_doc_version,
                created_by, instruction, mode="edit"):
    """Phase 1's combined propose+choose: creates one `patches` row and
    one `patch_alternatives` row (index 0, label "default") for an audit
    trail identical in shape to what Phase 2's real propose/choose split
    will produce, then immediately validates and applies it inside one
    transaction. document_edit.edit_document_clause() calls this instead
    of directly mutating paragraphs.json - this is the ONLY write path
    into `blocks`/`block_revisions`/`documents.current_version` in this
    module, so every edit, from any caller, goes through the same
    validator.

    Raises PatchConflict on any validation failure (stale version,
    unknown block, dangling citation, wrong-subject content drift) - the
    transaction is rolled back
    automatically (sqlite3's `with conn:` context manager does this),
    so a failed validation never leaves partial state.

    Returns {"block_id", "local_id", "revision_id", "doc_version",
    "patch_id"} on success.

    Note on transaction shape: the `patches`/`patch_alternatives` rows
    for this attempt are committed FIRST, in their own transaction,
    before validation runs - deliberately, not an oversight. A patch
    that fails validation must still be visible in the audit trail
    (explicit error states, idempotency) rather than vanishing as if it
    never happened; if the patch insert and the apply-or-reject outcome
    shared one `with conn:` block, an exception from a failed validation
    would roll back that same block's own patch-row insert along with
    it, silently erasing the very record this function exists to keep.
    The apply-or-reject outcome itself (blocks/block_revisions/
    documents.current_version + the patch's final status) is still one
    atomic transaction, same as before."""
    conn = _connect()
    try:
        patch_id = _new_id("patch")
        now = _now()
        with conn:
            conn.execute(
                "INSERT INTO patches "
                "(patch_id, doc_id, block_id, batch_id, base_doc_version, "
                " instruction, mode, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (patch_id, doc_id, _block_id(doc_id, local_id), None,
                 base_doc_version, instruction, mode, "proposed", now),
            )
            conn.execute(
                "INSERT INTO patch_alternatives "
                "(patch_id, alt_index, label, text, citations, claims) "
                "VALUES (?,?,?,?,?,?)",
                (patch_id, 0, "default", text, json.dumps(citations or []),
                 json.dumps([])),
            )

        try:
            with conn:
                block_id, parent_revision_id = validate_patch_application(
                    conn, doc_id, local_id, base_doc_version, text, citations
                )
        except PatchConflict as e:
            with conn:
                conn.execute(
                    "UPDATE patches SET status = 'rejected', error = ? WHERE patch_id = ?",
                    (str(e), patch_id),
                )
            raise

        with conn:
            if mode == "suggest":
                # See architecture plan section 53's "Permission scopes" -
                # a suggest-mode patch is recorded and validated (so its
                # citations are still checked) but never written to
                # `blocks`. Not exercised by document_edit.py in Phase 1
                # (which always calls this with mode="edit"); included
                # here so Phase 2/5 can reuse this same function unchanged.
                conn.execute(
                    "UPDATE patches SET status = 'applied', chosen_alternative = 0, "
                    "applied_at = ? WHERE patch_id = ?",
                    (now, patch_id),
                )
                return {
                    "block_id": block_id, "local_id": local_id,
                    "revision_id": None, "doc_version": base_doc_version,
                    "patch_id": patch_id,
                }

            new_version = base_doc_version + 1
            revision_id = _new_id("rev")
            conn.execute(
                "INSERT INTO block_revisions "
                "(revision_id, block_id, doc_version, text, rationale, "
                " citations, claims, created_by, created_at, "
                " parent_revision_id, patch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (revision_id, block_id, new_version, text, rationale,
                 json.dumps(citations or []), json.dumps([]), created_by, now,
                 parent_revision_id, patch_id),
            )
            conn.execute(
                "UPDATE blocks SET current_revision_id = ?, status = 'clean' "
                "WHERE block_id = ?",
                (revision_id, block_id),
            )
            conn.execute(
                "UPDATE documents SET current_version = ? WHERE doc_id = ?",
                (new_version, doc_id),
            )
            conn.execute(
                "UPDATE patches SET status = 'applied', chosen_alternative = 0, "
                "applied_at = ? WHERE patch_id = ?",
                (now, patch_id),
            )
            return {
                "block_id": block_id, "local_id": local_id,
                "revision_id": revision_id, "doc_version": new_version,
                "patch_id": patch_id,
            }
    finally:
        conn.close()


# --- Phase 2: real propose / choose / reject (2026-09-25) -------------------
#
# Added per the product owner's detailed voice brief asking for the
# "never silently replace anything" workflow architecture plan section 53
# always specified for Phase 2: generate three alternatives up front,
# write nothing to `blocks` until the user explicitly picks one. Phase 1's
# apply_edit() above still exists unchanged (document_edit.edit_document_
# clause()'s one-shot propose+auto-choose(0) path, kept as the backward-
# compatible /documents/{doc_id}/edit-clause endpoint) - these functions
# are the real split version: propose_patch() only ever writes `patches`/
# `patch_alternatives`; choose_patch() is the only one of the three that
# can touch `blocks`/`block_revisions`/`documents.current_version`, and it
# runs the SAME validate_patch_application() apply_edit() uses, at the
# moment of choosing (not at propose time) - a proposal can sit unchosen
# long enough for the document to move on underneath it, so staleness/
# citation-integrity/content-drift are only meaningful checked right
# before the write actually happens.


def propose_patch(doc_id, local_id, instruction, base_doc_version, alternatives,
                   mode="edit"):
    """Writes one `patches` row (status="proposed") plus one
    `patch_alternatives` row per entry in `alternatives`, in one
    transaction - and nothing else. Never touches `blocks`/
    `block_revisions`/`documents.current_version`: this is the
    "propose" half of propose/choose/reject, so the live document is
    provably untouched until a later choose_patch() call, not just by
    convention.

    alternatives: list of {"label", "text", "citations", "claims"}
    dicts, in display order (index 0, 1, 2...). Deliberately NOT
    validated here (staleness/citation-integrity/content-drift) - see
    the module note above for why that's choose_patch()'s job, not
    this one's.

    Raises PatchConflict if the document or block doesn't exist (same
    exception type every other write-path failure here uses, so
    document_edit.py's callers can handle every case the same way).

    Returns {"patch_id", "block_id"}."""
    conn = _connect()
    try:
        doc_row = conn.execute(
            "SELECT doc_id FROM documents WHERE doc_id = ?", (doc_id,)
        ).fetchone()
        if doc_row is None:
            raise PatchConflict(f"No document with id {doc_id!r}.")
        block_id = _block_id(doc_id, local_id)
        block_row = conn.execute(
            "SELECT block_id FROM blocks WHERE block_id = ?", (block_id,)
        ).fetchone()
        if block_row is None:
            raise PatchConflict(f"No block {local_id!r} in document {doc_id!r}.")
        if not alternatives:
            raise PatchConflict("Refusing to propose a patch with zero alternatives.")

        patch_id = _new_id("patch")
        now = _now()
        with conn:
            conn.execute(
                "INSERT INTO patches "
                "(patch_id, doc_id, block_id, batch_id, base_doc_version, "
                " instruction, mode, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (patch_id, doc_id, block_id, None, base_doc_version,
                 instruction, mode, "proposed", now),
            )
            for i, alt in enumerate(alternatives):
                conn.execute(
                    "INSERT INTO patch_alternatives "
                    "(patch_id, alt_index, label, text, citations, claims) "
                    "VALUES (?,?,?,?,?,?)",
                    (patch_id, i, alt.get("label") or f"option {i + 1}",
                     alt["text"], json.dumps(alt.get("citations") or []),
                     json.dumps(alt.get("claims") or [])),
                )
        return {"patch_id": patch_id, "block_id": block_id}
    finally:
        conn.close()


def get_patch(patch_id):
    """Returns {"patch": {...}, "alternatives": [...]} or None - a
    proposal plus its (unapplied, or already-resolved) alternatives.
    Used by choose_patch()/reject_patch() to look the proposal up, and
    available for a future GET so an in-flight proposal survives a page
    refresh (architecture plan section 53's own note for that - not
    wired to an endpoint yet, exposed here so it can be)."""
    conn = _connect()
    try:
        patch_row = conn.execute(
            "SELECT * FROM patches WHERE patch_id = ?", (patch_id,)
        ).fetchone()
        if patch_row is None:
            return None
        alt_rows = conn.execute(
            "SELECT * FROM patch_alternatives WHERE patch_id = ? ORDER BY alt_index",
            (patch_id,),
        ).fetchall()
        return {"patch": dict(patch_row), "alternatives": [dict(r) for r in alt_rows]}
    finally:
        conn.close()


def get_local_id(doc_id, block_id):
    """The inverse of _block_id() - given a block_id (doc-namespaced,
    f"{doc_id}::{local_id}"), returns that block's local_id, or None if
    it doesn't belong to doc_id or doesn't exist. Added 2026-09-26 for
    the "Custom" refinement box: document_edit.refine_alternatives()
    only has a patch's block_id (from patches.block_id) and needs the
    plain local_id to re-load the original paragraph text via the
    existing load_paragraphs(), without document_edit.py reaching into
    this module's private _block_id() convention itself."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT local_id FROM blocks WHERE block_id = ? AND doc_id = ?",
            (block_id, doc_id),
        ).fetchone()
        return row["local_id"] if row else None
    finally:
        conn.close()


def add_patch_alternative(patch_id, label, text, citations=None, claims=None):
    """Appends ONE more alternative to an already-proposed (not yet
    applied/rejected/stale) patch - the store-level primitive behind the
    "Custom" refinement box (2026-09-26 six-area polish pass): the
    refinement flow generates ONE new alternative from the patch's
    existing alternatives plus a user instruction ("use option 2 but
    shorter", "combine options 1 and 3"...), and this just gives it a
    slot in the same patch_alternatives table so it can be chosen/
    applied through the EXACT same choose_patch() path as option 1/2/3 -
    no new apply path, no new validation path, nothing written to
    blocks/block_revisions here (same "propose never writes live state"
    discipline propose_patch() above follows). Refuses to add to a
    patch that isn't still 'proposed', same guard every other write in
    this module applies. Returns the new alt_index."""
    conn = _connect()
    try:
        patch_row = conn.execute(
            "SELECT status FROM patches WHERE patch_id = ?", (patch_id,)
        ).fetchone()
        if patch_row is None:
            raise PatchConflict(f"No patch with id {patch_id!r}.")
        if patch_row["status"] != "proposed":
            raise PatchConflict(
                f"Can't refine a patch with status={patch_row['status']!r} - only an "
                f"open proposal can be refined."
            )
        row = conn.execute(
            "SELECT COALESCE(MAX(alt_index), -1) + 1 AS next_index "
            "FROM patch_alternatives WHERE patch_id = ?",
            (patch_id,),
        ).fetchone()
        next_index = row["next_index"]
        with conn:
            conn.execute(
                "INSERT INTO patch_alternatives "
                "(patch_id, alt_index, label, text, citations, claims) "
                "VALUES (?,?,?,?,?,?)",
                (patch_id, next_index, label or f"option {next_index + 1}",
                 text, json.dumps(citations or []), json.dumps(claims or [])),
            )
        return next_index
    finally:
        conn.close()


def choose_patch(patch_id, alternative_index, expected_doc_version, created_by="user"):
    """The real "apply" step of the propose/choose split - the
    counterpart to apply_edit() above, but for a patch whose 3
    alternatives were already generated and stored by a prior
    propose_patch() call, rather than creating both in one step.

    Idempotent (architecture plan section 53's own requirement):
    choosing an already-applied patch again is a no-op that returns the
    existing outcome (with already_applied=True) rather than writing a
    second revision - the first choice already won and can't be
    silently changed by calling choose twice, whatever alternative_index
    the second call asks for. Choosing an already-rejected or otherwise
    non-"proposed" patch raises PatchConflict.

    Runs validate_patch_application() - the SAME validator apply_edit()
    uses - right here, not inside propose_patch(), since a proposal can
    sit unchosen long enough for the document to have moved on
    underneath it (staleness) or for the content-drift/citation checks
    to matter for real, not just at generation time.

    Returns {"block_id", "local_id", "revision_id", "doc_version",
    "patch_id", "previous_revision_id"} on success. previous_revision_id
    is the block's revision immediately before this write - exactly the
    "undo" target a later revert_block() call needs, handed back here so
    the caller never has to make a separate history query just to offer
    an Undo action."""
    conn = _connect()
    try:
        patch_row = conn.execute(
            "SELECT * FROM patches WHERE patch_id = ?", (patch_id,)
        ).fetchone()
        if patch_row is None:
            raise PatchConflict(f"No patch with id {patch_id!r}.")

        if patch_row["status"] == "applied":
            block_row = conn.execute(
                "SELECT local_id, current_revision_id FROM blocks WHERE block_id = ?",
                (patch_row["block_id"],),
            ).fetchone()
            doc_row = conn.execute(
                "SELECT current_version FROM documents WHERE doc_id = ?",
                (patch_row["doc_id"],),
            ).fetchone()
            prev_row = None
            if block_row is not None:
                prev_row = conn.execute(
                    "SELECT parent_revision_id FROM block_revisions WHERE revision_id = ?",
                    (block_row["current_revision_id"],),
                ).fetchone()
            return {
                "block_id": patch_row["block_id"],
                "local_id": block_row["local_id"] if block_row else None,
                "revision_id": block_row["current_revision_id"] if block_row else None,
                "doc_version": doc_row["current_version"] if doc_row else None,
                "patch_id": patch_id,
                "previous_revision_id": prev_row["parent_revision_id"] if prev_row else None,
                "already_applied": True,
            }

        if patch_row["status"] != "proposed":
            raise PatchConflict(
                f"This proposal is no longer open (status={patch_row['status']!r}) - "
                f"propose the edit again."
            )

        alt_row = conn.execute(
            "SELECT * FROM patch_alternatives WHERE patch_id = ? AND alt_index = ?",
            (patch_id, alternative_index),
        ).fetchone()
        if alt_row is None:
            raise PatchConflict(f"No alternative {alternative_index!r} on this proposal.")

        doc_id = patch_row["doc_id"]
        block_id = patch_row["block_id"]
        block_lookup = conn.execute(
            "SELECT local_id FROM blocks WHERE block_id = ?", (block_id,)
        ).fetchone()
        if block_lookup is None:
            raise PatchConflict(f"Block {block_id!r} no longer exists.")
        local_id = block_lookup["local_id"]

        text = alt_row["text"]
        citations = json.loads(alt_row["citations"] or "[]")
        claims = json.loads(alt_row["claims"] or "[]")

        try:
            with conn:
                resolved_block_id, parent_revision_id = validate_patch_application(
                    conn, doc_id, local_id, expected_doc_version, text, citations
                )
        except PatchConflict as e:
            with conn:
                conn.execute(
                    "UPDATE patches SET status = 'rejected', error = ? WHERE patch_id = ?",
                    (str(e), patch_id),
                )
            raise

        now = _now()
        with conn:
            new_version = expected_doc_version + 1
            revision_id = _new_id("rev")
            conn.execute(
                "INSERT INTO block_revisions "
                "(revision_id, block_id, doc_version, text, rationale, "
                " citations, claims, created_by, created_at, "
                " parent_revision_id, patch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (revision_id, resolved_block_id, new_version, text,
                 patch_row["instruction"], json.dumps(citations), json.dumps(claims),
                 created_by, now, parent_revision_id, patch_id),
            )
            conn.execute(
                "UPDATE blocks SET current_revision_id = ?, status = 'clean' "
                "WHERE block_id = ?",
                (revision_id, resolved_block_id),
            )
            conn.execute(
                "UPDATE documents SET current_version = ? WHERE doc_id = ?",
                (new_version, doc_id),
            )
            conn.execute(
                "UPDATE patches SET status = 'applied', chosen_alternative = ?, "
                "applied_at = ? WHERE patch_id = ?",
                (alternative_index, now, patch_id),
            )
            return {
                "block_id": resolved_block_id, "local_id": local_id,
                "revision_id": revision_id, "doc_version": new_version,
                "patch_id": patch_id, "previous_revision_id": parent_revision_id,
                "already_applied": False,
            }
    finally:
        conn.close()


def reject_patch(patch_id):
    """Marks a proposal 'rejected' - no write to `blocks`/
    `block_revisions`/`documents.current_version` ever happens for a
    rejected patch. Idempotent: rejecting an already-rejected patch is a
    no-op; rejecting an already-applied one raises PatchConflict (an
    applied edit is undone via revert_block(), never by retroactively
    marking its patch rejected - the patch row is the audit trail of
    what was proposed and chosen, not a live toggle)."""
    conn = _connect()
    try:
        patch_row = conn.execute(
            "SELECT status FROM patches WHERE patch_id = ?", (patch_id,)
        ).fetchone()
        if patch_row is None:
            raise PatchConflict(f"No patch with id {patch_id!r}.")
        if patch_row["status"] == "rejected":
            return {"patch_id": patch_id, "status": "rejected"}
        if patch_row["status"] != "proposed":
            raise PatchConflict(
                f"Can't reject a patch with status={patch_row['status']!r} - only an "
                f"open proposal can be rejected. Use revert_block() to undo an "
                f"already-applied edit."
            )
        with conn:
            conn.execute(
                "UPDATE patches SET status = 'rejected' WHERE patch_id = ?", (patch_id,)
            )
        return {"patch_id": patch_id, "status": "rejected"}
    finally:
        conn.close()


def revert_block(doc_id, local_id, to_revision_id, expected_doc_version, created_by="user:undo"):
    """Undo, the way architecture plan section 53 specifies it: writes a
    **new** revision whose text/citations/claims equal an older
    revision's, rather than deleting or rewriting anything - `block_
    revisions` stays append-only and immutable no matter how many times
    a block is undone. Deliberately does NOT run the content-drift check
    inside validate_patch_application(): that guard exists to catch a
    MODEL silently substituting unrelated content into a proposed edit
    (see the 2026-09-25 incident report), not to second-guess an
    explicit, already-confirmed user action to go back to a specific
    revision that was itself already validated and stored once before -
    applying that guard here could block a legitimate undo purely
    because the chain of edits since `to_revision_id` drifted the live
    text far enough from it, which is exactly the situation undo exists
    to fix. Staleness and existence are still checked - an undo against
    a document version that's moved on since the undo button was shown
    is exactly the "reject stale patches" case every other write here
    already guards.

    Returns the same shape choose_patch() does, so the frontend can
    treat "applied a chosen alternative" and "reverted to a previous
    one" identically once the write itself succeeds."""
    conn = _connect()
    try:
        doc_row = conn.execute(
            "SELECT current_version FROM documents WHERE doc_id = ?", (doc_id,)
        ).fetchone()
        if doc_row is None:
            raise PatchConflict(f"No document with id {doc_id!r}.")
        if doc_row["current_version"] != expected_doc_version:
            raise PatchConflict(
                f"Stale undo: this document is now at version "
                f"{doc_row['current_version']}, not {expected_doc_version} - reload "
                f"before undoing."
            )

        block_id = _block_id(doc_id, local_id)
        block_row = conn.execute(
            "SELECT current_revision_id FROM blocks WHERE block_id = ?", (block_id,)
        ).fetchone()
        if block_row is None:
            raise PatchConflict(f"No block {local_id!r} in document {doc_id!r}.")

        target_row = conn.execute(
            "SELECT * FROM block_revisions WHERE revision_id = ? AND block_id = ?",
            (to_revision_id, block_id),
        ).fetchone()
        if target_row is None:
            raise PatchConflict(
                f"Revision {to_revision_id!r} isn't part of this block's history - "
                f"can't undo to it."
            )

        now = _now()
        with conn:
            new_version = expected_doc_version + 1
            revision_id = _new_id("rev")
            conn.execute(
                "INSERT INTO block_revisions "
                "(revision_id, block_id, doc_version, text, rationale, "
                " citations, claims, created_by, created_at, "
                " parent_revision_id, patch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (revision_id, block_id, new_version, target_row["text"],
                 "Reverted to a previous version", target_row["citations"],
                 target_row["claims"], created_by, now,
                 block_row["current_revision_id"], None),
            )
            conn.execute(
                "UPDATE blocks SET current_revision_id = ?, status = 'clean' "
                "WHERE block_id = ?",
                (revision_id, block_id),
            )
            conn.execute(
                "UPDATE documents SET current_version = ? WHERE doc_id = ?",
                (new_version, doc_id),
            )
            return {
                "block_id": block_id, "local_id": local_id,
                "revision_id": revision_id, "doc_version": new_version,
                "patch_id": None, "previous_revision_id": block_row["current_revision_id"],
                "already_applied": False,
            }
    finally:
        conn.close()
