r"""One-off cleanup for known_places rows seeded before the " LPA"-suffix
fix (2026-09-20/21): seed_from_lpas() used to build every name variant
from the source dataset's raw `name` field without stripping its
trailing " LPA" (a planning.data.gov.uk entity-naming artifact, not part
of how any real document refers to an authority), so every row it wrote
before the fix looks like "Bassetlaw LPA District Council" instead of
"Bassetlaw District Council" - useless for lookup_known_place()'s exact
match, but harmless clutter otherwise (they're simply never matched).

Re-running seed_from_lpas() after the fix (upsert, keyed on
name_normalized) already wrote the correct rows alongside the old bad
ones rather than replacing them, since the two have different
normalized keys - this script removes only the bad leftovers.

Safe to identify: every bad row's name_normalized contains "lpa" as a
whole word (word-boundary regexp \mlpa\M in Postgres), which only ever
appears here as that artifact suffix - no real UK council name contains
the standalone word "lpa". Only rows with source='lpa-centroid' are
touched, so a manually-added (--add) entry that happened to be named
with the word "lpa" in it for some legitimate reason is never at risk.

Dry-run by default - prints the count and a sample of what WOULD be
deleted. Pass --execute to actually delete.

Usage:
    python3 known_places_cleanup.py             # dry run
    python3 known_places_cleanup.py --execute    # actually delete
"""

import argparse

from gis_common import get_conn

_MATCH_SQL = (
    "SELECT id, name FROM known_places "
    "WHERE source = 'lpa-centroid' AND name_normalized ~ '\\mlpa\\M' "
    "ORDER BY name"
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute", action="store_true",
        help="Actually delete the matched rows. Without this flag, only reports what would be deleted.",
    )
    args = parser.parse_args()

    conn = get_conn()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(_MATCH_SQL)
                rows = cur.fetchall()

                print(f"Found {len(rows)} stale pre-fix row(s) (source='lpa-centroid', "
                      f"name contains the word 'lpa').")
                for row_id, name in rows[:10]:
                    print(f"  [{row_id}] {name!r}")
                if len(rows) > 10:
                    print(f"  ... and {len(rows) - 10} more")

                if not rows:
                    print("Nothing to clean up.")
                    return

                if not args.execute:
                    print("\nDry run only - no rows deleted. Re-run with --execute to delete these "
                          f"{len(rows)} row(s) for real.")
                    return

                ids = [row_id for row_id, _name in rows]
                cur.execute("DELETE FROM known_places WHERE id = ANY(%s)", (ids,))
                print(f"\nDeleted {cur.rowcount} row(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
