#!/usr/bin/env python3
"""Quick manual test, no server needed:

    source venv/bin/activate
    python3 query_cli.py "what does policy d3 say about design"
"""

import sys
import time

from answer import generate_answer
from retrieve import retrieve


def main():
    if len(sys.argv) < 2:
        print('Usage: python3 query_cli.py "your question here"')
        sys.exit(1)
    query = " ".join(sys.argv[1:])

    t0 = time.time()
    chunks, coverage = retrieve(query)
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

    print("\n=== Citations ===")
    for c in result["citations"]:
        print(f"  [{c['id']}] {c['doc']} (p.{c['page']}) "
              f"domain={c['domain']} geography={c['geography']} "
              f"rerank={c['rerank_score']}")


if __name__ == "__main__":
    main()
