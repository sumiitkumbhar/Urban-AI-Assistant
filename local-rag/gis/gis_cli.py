"""Quick terminal test for the site-constraints lookup, mirroring
local-rag/query_cli.py's role for the text pipeline.

    python3 gis_cli.py --postcode "SW1V 3LX"
    python3 gis_cli.py --lat 51.4857 --lon -0.1427
"""

import argparse
import sys

from gis_lookup import geocode_postcode, site_constraints


def _print_matches(label, block):
    checked = block["checked"]
    matches = block["matches"]
    status = "checked" if checked else "NOT INGESTED for this area - unknown, not confirmed absent"
    print(f"\n{label} ({status}):")
    if not matches:
        print("  none" if checked else "  (no data)")
        return
    for m in matches:
        extra = ""
        if "listed_grade" in m and m["listed_grade"]:
            extra = f" [Grade {m['listed_grade']}]"
        if "article_4_direction" in m and m["article_4_direction"]:
            extra = f" [{m['article_4_direction']}]"
        if "flood_risk_level" in m and m["flood_risk_level"]:
            type_suffix = f", {m['flood_risk_type']}" if m.get("flood_risk_type") else ""
            extra = f" [Flood Zone {m['flood_risk_level']}{type_suffix}]"
        if "distance_m" in m:
            tag = "ON SITE" if m.get("on_site") else f"{m['distance_m']:.0f}m away"
            extra += f" ({tag})"
        print(f"  - {m.get('name') or m.get('reference')}{extra}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postcode")
    parser.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    args = parser.parse_args()

    if args.lat is not None and args.lon is not None:
        lat, lon = args.lat, args.lon
    elif args.postcode:
        geocoded = geocode_postcode(args.postcode)
        if not geocoded:
            print(f"Postcode {args.postcode!r} not found.")
            sys.exit(1)
        lat, lon = geocoded
    else:
        print("Provide either --postcode or --lat/--lon.")
        sys.exit(1)

    print(f"Point: {lat}, {lon}")
    result = site_constraints(lat, lon)

    lpa = result["local_planning_authority"]
    print(f"\nLocal planning authority: {lpa['name'] if lpa else 'not found'}")

    _print_matches("Conservation areas", result["conservation_areas"])
    _print_matches("Listed buildings nearby", result["listed_buildings"])
    _print_matches("Article 4 directions", result["article_4_directions"])
    _print_matches("Green Belt", result["green_belt"])
    _print_matches("Flood risk zones", result["flood_risk_zones"])


if __name__ == "__main__":
    main()
