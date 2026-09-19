#!/usr/bin/env python3
"""Manual test, no server needed:

    source venv/bin/activate
    python3 proposal_review_cli.py --postcode "SW1V 3LX" --file "/path/to/Design and Access Statement.pdf"
    python3 proposal_review_cli.py --project-id 1 --file doc1.pdf --file doc2.pdf

Assesses the uploaded proposal document(s) against the local-rag corpus
and the site's real GIS constraints - see proposal_review.py's module
docstring for the full pipeline. Prints a readable compliance report by
default; pass --json to print the raw structured result instead.
"""

import argparse
import json
import sys
from pathlib import Path

from proposal_review import extract_proposal_text, review_proposal
from report_render import build_reports, report_slug


def parse_args(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--file", action="append", required=True, dest="files",
                    help="Path to a proposal PDF (repeatable for multiple documents).")
    p.add_argument("--project-id", type=int)
    p.add_argument("--postcode")
    p.add_argument("--lat", type=float)
    p.add_argument("--lon", type=float)
    p.add_argument("--json", action="store_true", help="Print the raw structured result.")
    p.add_argument("--no-report", action="store_true",
                    help="Skip writing the .md/.pdf report files (print only).")
    return p.parse_args(argv)


def main():
    args = parse_args(sys.argv[1:])

    document_texts = []
    for path in args.files:
        text, pages_with_text, pages_without_text, error = extract_proposal_text(path)
        if error:
            print(f"ERROR reading {path}: {error}")
            sys.exit(1)
        document_texts.append((path.split("/")[-1], text))
        if pages_without_text:
            print(f"NOTE: {path.split('/')[-1]} - page(s) {pages_without_text} had no "
                  f"extractable text (likely a drawing/scanned page) and were not assessed.")

    result = review_proposal(
        document_texts, project_id=args.project_id, postcode=args.postcode,
        lat=args.lat, lon=args.lon,
    )

    if args.json:
        print(json.dumps(result, indent=2))
        return

    if result.get("error"):
        print(f"\nERROR: {result['error']}")
        if result.get("topics_failed"):
            print(f"Topics that failed to retrieve: {', '.join(result['topics_failed'])}")
        return

    if result.get("disclaimer"):
        print(f"\n{'=' * 70}\n{result['disclaimer']}\n{'=' * 70}")

    print(f"\nGeography: {result.get('geography') or '(unscoped)'}")
    if result.get("constraint_summary"):
        print(f"Site constraints: {result['constraint_summary']}")
    print(f"Topics checked: {', '.join(result['topics_checked'])}")
    if result.get("topics_failed"):
        print(f"NOTE: these topics failed to retrieve and were skipped: "
              f"{', '.join(result['topics_failed'])} - the assessment below is based on "
              f"the remaining topics only.")
    if result.get("proposal_truncated"):
        print("NOTE: proposal text was truncated to fit the assessment call.")

    assessment = result["assessment"]

    if result.get("assessment_failed"):
        # NOT "no issues flagged" - the model call itself didn't produce a
        # usable answer. Printed loudly, on purpose, so this is never
        # mistaken for a clean result (see proposal_review.py's own
        # comment on why issues/checklist are None here, not []).
        bar = "!" * 70
        print(f"\n{bar}\nASSESSMENT GENERATION FAILED - this is NOT a clean/passing result.")
        print(result.get("parse_error", ""))
        print(bar)
    else:
        print(f"\n=== Summary ===\n{assessment.get('summary', '')}")

        issues = assessment.get("issues") or []
        if not issues:
            print("\nNo specific issues flagged.")
        else:
            print(f"\n=== {len(issues)} issue(s) flagged ===")
            for i, issue in enumerate(issues, 1):
                cites = ", ".join(f"[{c}]" for c in issue.get("citations", []))
                print(f"\n{i}. [{issue.get('topic', '')}] {issue.get('issue', '')} {cites}")
                print(f"   Suggested change: {issue.get('suggested_change', '')}")

        checklist = assessment.get("checklist") or []
        if checklist:
            print(f"\n=== Required content checklist ({len(checklist)} item(s)) ===")
            for item in checklist:
                cites = ", ".join(f"[{c}]" for c in item.get("citations", []))
                status = item.get("status", "unclear")
                print(f"[{status}] {item.get('item', '')} {cites}")
                note = item.get("note")
                if note:
                    print(f"   {note}")

    print("\n=== Evidence cited ===")
    for c in result["evidence_citations"]:
        print(f"[{c['id']}] {c['doc']} (page {c['page']}) domain={c['domain']} "
              f"geography={c['geography']}")

    if not args.no_report:
        document_names = [name for name, _ in document_texts]
        reports = build_reports(result, document_names, pdf_paths=args.files)
        out_dir = Path(args.files[0]).resolve().parent
        slug = report_slug(result)
        md_path = out_dir / f"{slug}.md"
        md_path.write_text(reports["markdown"], encoding="utf-8")
        print(f"\nSaved report: {md_path}")
        if reports["pdf_bytes"] is not None:
            pdf_path = out_dir / f"{slug}.pdf"
            pdf_path.write_bytes(reports["pdf_bytes"])
            print(f"Saved report: {pdf_path}")
        else:
            print(f"NOTE: {reports['pdf_error']}")


if __name__ == "__main__":
    main()
