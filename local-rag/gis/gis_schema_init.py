"""Applies schema.sql (CREATE EXTENSION postgis + all tables/indexes,
all idempotent) to GIS_DATABASE_URL. Run once after createdb, and safe to
re-run any time - see the Desktop launcher script.
"""

import sys

from gis_common import GIS_DATABASE_URL, SCHEMA_PATH, get_conn


def main():
    sql = SCHEMA_PATH.read_text()
    print(f"Applying {SCHEMA_PATH.name} to {GIS_DATABASE_URL} ...")
    try:
        conn = get_conn()
    except Exception as e:
        print(f"Couldn't connect to {GIS_DATABASE_URL}: {e}")
        print(
            "Is Postgres running, and does the database exist? "
            "(createdb urban_ai_gis)"
        )
        sys.exit(1)

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(sql)
        print("Schema applied.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
