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
    chunks = retrieve(query)
    t1 = time.time()
    result = generate_answer(query, chunks)
    t2 = time.time()

    print(f"\n=== Answer (retrieval {t1-t0:.2f}s, generation {t2-t1:.2f}s) ===\n")
    print(result["answer"])
    print("\n=== Citations ===")
    for c in result["citations"]:
        print(f"  [{c['id']}] {c['doc']} (p.{c['page']}) "
              f"domain={c['domain']} geography={c['geography']} "
              f"rerank={c['rerank_score']}")


if __name__ == "__main__":
    main()
