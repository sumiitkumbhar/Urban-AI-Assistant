#!/usr/bin/env python3
"""Quick manual test, no server needed:

    source venv/bin/activate
    python3 query_cli.py "what does policy d3 say about design"

Optionally scope to a council/geography (mirrors the live app's
filter_lpa_slug - a "national" chunk like the NPPF is always in scope,
only local material outside the given geography is excluded):

    python3 query_cli.py -g westminster "what does policy d3 say about design"
    python3 query_cli.py --geography westminster "..."
"""

import sys
import time

from answer import generate_answer
from orchestrate import orchestrate


def main():
    args = sys.argv[1:]
    geography = None
    for flag in ("-g", "--geography"):
        if flag in args:
            i = args.index(flag)
            if i + 1 >= len(args):
                print(f"Usage: {flag} <geography> (e.g. westminster)")
                sys.exit(1)
            geography = args[i + 1]
            del args[i:i + 2]
            break

    if not args:
        print('Usage: python3 query_cli.py ["-g <geography>"] "your question here"')
        sys.exit(1)
    query = " ".join(args)

    t0 = time.time()
    chunks, coverage = orchestrate(query, geography_filter=geography)
    t1 = time.time()
    result = generate_answer(query, chunks, coverage=coverage)
    t2 = time.time()

    print(f"\n=== Answer (retrieval {t1-t0:.2f}s, generation {t2-t1:.2f}s) ===\n")
    print(result["answer"])

    broadened = coverage.get("broadened_from_top_k")
    note = " (broadened search after a weak first pass)" if broadened else ""
    print(f"\n=== Confidence: {coverage['confidence']}{note} ===")
    if coverage.get("top_rerank_score") is not None:
        print(f"  top rerank score: {coverage['top_rerank_score']}, "
              f"source documents: {coverage['source_count']}")
    for reason in coverage.get("reasons", []):
        print(f"  - {reason}")
    if result.get("verified"):
        print("  (answer passed an extra groundedness check before being shown)")
    related = coverage.get("related_references")
    if related:
        print(f"  related references (via cross-reference graph): {', '.join(related)}")

    agents = coverage.get("agents") or []
    if len(agents) > 1:
        print(f"\n=== Agents (Multi-Agent RAG: query spanned {len(agents)} domains) ===")
        for a in agents:
            if a.get("error"):
                print(f"  - {a['domain']}: FAILED ({a['error']})")
            else:
                print(f"  - {a['domain']}: confidence={a['confidence']}, "
                      f"{a['chunk_count']} chunks from {a['source_count']} source(s)")

    print("\n=== Citations ===")
    for c in result["citations"]:
        print(f"  [{c['id']}] {c['doc']} (p.{c['page']}) "
              f"domain={c['domain']} geography={c['geography']} "
              f"rerank={c['rerank_score']}")


if __name__ == "__main__":
    main()
