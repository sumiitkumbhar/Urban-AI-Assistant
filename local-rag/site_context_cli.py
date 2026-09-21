"""Quick terminal test for the GIS -> RAG context/policy engine bridge
(architecture-plan section 27's final step). Mirrors query_cli.py's and
gis/gis_cli.py's own shape.

    python3 site_context_cli.py --postcode "SW1V 3LX"
    python3 site_context_cli.py --postcode "SW1V 3LX" --question "Would an 8-storey extension be feasible here?"
"""

import argparse

from answer import generate_answer
from site_context import build_site_context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postcode")
    parser.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    parser.add_argument("--address", help="Free-text address/place name, tried when --postcode/--lat/--lon are all omitted")
    parser.add_argument("--question", help="Extra question to fold in alongside the constraint-derived one")
    args = parser.parse_args()

    ctx = build_site_context(
        postcode=args.postcode, lat=args.lat, lon=args.lon, address=args.address,
        extra_question=args.question,
    )
    if "error" in ctx:
        print(ctx["error"])
        return

    if ctx.get("geocode_detail"):
        gd = ctx["geocode_detail"]
        print(f"Resolved via {gd['source']}: {gd['detail']}")

    site = ctx["site_constraints"]
    lpa = site["local_planning_authority"]
    print(f"LPA: {lpa['name'] if lpa else 'not found'}  (geography={ctx['geography']!r})")

    for label, block in [
        ("Conservation areas", site["conservation_areas"]),
        ("Listed buildings nearby", site["listed_buildings"]),
        ("Article 4 directions", site["article_4_directions"]),
        ("Green Belt", site["green_belt"]),
        ("Flood risk zones", site["flood_risk_zones"]),
        ("Sites of Special Scientific Interest", site["sssi"]),
        ("Areas of Outstanding Natural Beauty", site["aonb"]),
        ("Ancient woodland", site["ancient_woodland"]),
        ("Tree Preservation Order zones", site["tree_preservation_zones"]),
    ]:
        status = "checked" if block["checked"] else "NOT INGESTED for this area"
        names = [m.get("name") or m.get("reference") for m in block["matches"]] or ["none"]
        print(f"  {label} ({status}): {', '.join(names)}")

    print(f"\nPolicy question asked: {ctx['policy_question']}")

    result = generate_answer(ctx["policy_question"], ctx["chunks"], coverage=ctx["coverage"])
    print(f"\n{result['answer']}\n")
    print(f"Confidence: {ctx['coverage']['confidence']}  "
          f"(domains queried: {ctx['coverage'].get('domains_queried')})")

    print("\nCitations:")
    for c in result.get("citations", []):
        print(f"  [{c['id']}] {c['doc']} (p.{c['page']}) domain={c['domain']} geography={c['geography']}")

    if ctx["map_citations"]:
        print("\nVisual map citation(s):")
        for m in ctx["map_citations"]:
            print(f"  {m['filename']}  ({m['doc_type']})")
    else:
        print("\nNo visual map citation matched for this site.")


if __name__ == "__main__":
    main()
