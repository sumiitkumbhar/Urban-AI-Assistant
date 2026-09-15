#!/usr/bin/env python3
"""Quick manual test, no server needed:

    source venv/bin/activate
    python3 query_cli.py "what does policy d3 say about design"

Optionally scope to a council/geography (mirrors the live app's
filter_lpa_slug - a "national" chunk like the NPPF is always in scope,
only local material outside the given geography is excluded):

    python3 query_cli.py -g westminster "what does policy d3 say about design"
    python3 query_cli.py --geography westminster "..."

Optionally stream the answer token-by-token instead of waiting for the
full response (architecture-plan Phase 5's "streaming" item -
answer.py's stream_answer(), the same generator service.py's
/query/stream SSE endpoint uses - this just calls it in-process, no
server needed, so it's the fastest way to confirm the Groq streaming
call itself works before testing the HTTP/frontend path):

    python3 query_cli.py --stream "what does policy d3 say about design"
"""

import sys
import time

from answer import generate_answer, stream_answer
from orchestrate import orchestrate


def _print_result_details(result, coverage):
    """Everything after the answer text itself - confidence, the
    Self-RAG repair note, related references, groundedness, agents (for
    a multi-domain query), and citations. Shared by both the plain and
    --stream paths so they report identically once the answer is done."""
    broadened = coverage.get("broadened_from_top_k")
    note = " (broadened search after a weak first pass)" if broadened else ""
    print(f"\n=== Confidence: {coverage['confidence']}{note} ===")
    if coverage.get("top_rerank_score") is not None:
        print(f"  top rerank score: {coverage['top_rerank_score']}, "
              f"source documents: {coverage['source_count']}")
    for reason in coverage.get("reasons", []):
        print(f"  - {reason}")
    if result.get("verified"):
        print("  (answer passed an extra Self-RAG repair/verification pass before being shown)")
    related = coverage.get("related_references")
    if related:
        print(f"  related references (via cross-reference graph): {', '.join(related)}")

    groundedness = result.get("groundedness")
    if groundedness is not None:
        print(f"\n=== Groundedness: {groundedness}/100 ===")
        unsupported = result.get("unsupported_claims") or []
        if unsupported:
            print("  Claims NOT backed by the retrieved evidence:")
            for claim in unsupported:
                print(f"  - {claim}")
        else:
            print("  Every claim checked out against the retrieved evidence.")

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

    stream = "--stream" in args
    if stream:
        args.remove("--stream")

    if not args:
        print('Usage: python3 query_cli.py ["-g <geography>"] ["--stream"] "your question here"')
        sys.exit(1)
    query = " ".join(args)

    t0 = time.time()
    chunks, coverage = orchestrate(query, geography_filter=geography)
    t1 = time.time()

    if stream:
        print(f"\n=== Answer (retrieval {t1-t0:.2f}s, streaming...) ===\n")
        result = None
        for kind, payload in stream_answer(query, chunks, coverage=coverage):
            if kind == "delta":
                print(payload, end="", flush=True)
            else:  # "done"
                result = payload
        t2 = time.time()
        print(f"\n\n(generation {t2-t1:.2f}s total, including the post-stream "
              f"repair/groundedness passes)")
    else:
        result = generate_answer(query, chunks, coverage=coverage)
        t2 = time.time()
        print(f"\n=== Answer (retrieval {t1-t0:.2f}s, generation {t2-t1:.2f}s) ===\n")
        print(result["answer"])

    _print_result_details(result, coverage)


if __name__ == "__main__":
    main()
