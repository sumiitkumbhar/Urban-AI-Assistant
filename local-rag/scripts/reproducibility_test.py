#!/usr/bin/env python3
"""Hard reproducibility regression test for the compliance review engine
(2026-09-28 reliability fix, point 8, "Add a hard reproducibility test" -
explicit request: "Use this exact Bassetlaw proposal as the regression
fixture. Run it 10 times. All runs must return the same: rule IDs,
checklist size, PASS/FAIL/UNCLEAR statuses, final score, assessment
coverage, evidence references. Narrative wording may differ. If any of
the structured results differ, save a diff and fail the test.")

This is a real, live pipeline test, NOT a unit test with mocks - it runs
review_proposal() against the real backend (Groq by default, same as
production traffic) N times over the SAME fixed fixture document and
diffs the STRUCTURED output across runs. It deliberately makes real,
possibly-costly model calls (roughly 8-10 calls per run: one checklist-
catalog call, one call per proposal chunk, one verify call, one summary
call) - this is intentional (a mocked test would prove nothing about
the actual nondeterminism this test exists to catch), but it means this
script is meant to be run deliberately, not wired into a fast CI suite
that runs on every commit.

What counts as "the structured result" (compared across runs) vs.
"narrative wording" (never compared, allowed to vary):

  COMPARED (must be identical across all runs):
    - compliance_status ("final"/"incomplete"/"failed")
    - assessment_coverage (assessed_units/total_units/pct/complete)
    - checklist_frozen (whether the frozen-catalog path was used)
    - the set of checklist keys (when checklist_frozen) or item names
      (legacy mode) - this is the "rule IDs" the user's brief refers to,
      given this codebase doesn't yet have a cross-run-versioned rule
      catalog (see MEMORY/architecture notes - that's a separate,
      larger fix already flagged to the user as needing a real product
      decision on rule-catalog content)
    - each checklist item's status (present/missing/unclear)
    - the checklist status counts (present/missing/unclear totals) and
      the derived pct_present score (report_render.py's own formula,
      recomputed here rather than imported, so this test also catches a
      future accidental change to that formula's own determinism)
    - the set of (document, page) evidence citations actually cited

  NEVER COMPARED (allowed to vary run to run):
    - assessment.summary (narrative prose)
    - issue/checklist item "issue"/"note" prose text
    - citation numbering *within* a single run's evidence table (only
      the underlying (doc, page) pairs actually cited are compared)

Usage:
    python scripts/reproducibility_test.py [--runs 10] [--backend groq]
        [--fixture tests/fixtures/bassetlaw_proposal.pdf] [--postcode ...]
        [--out reports/reproducibility]

Exit code 0 = all runs agree (PASS). Exit code 1 = a divergence was found
(FAIL) - a structured diff is written to --out/<timestamp>/ either way
(full per-run summaries on PASS, plus the diff itself on FAIL) so a run
is always inspectable afterward, not just a pass/fail line in a
terminal that's already scrolled away.
"""
import argparse
import datetime as dt
import json
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from proposal_review import extract_proposal_text, review_proposal  # noqa: E402


def _pct_present(checklist):
    """Same formula as report_render.py's _status_donut_svg() /
    ChatInterface.tsx's ReviewSummaryChart - recomputed here (not
    imported) so this test independently re-derives the score instead of
    trusting the same code path it's meant to be checking."""
    counts = Counter(c.get("status") for c in checklist)
    total = sum(counts.get(k, 0) for k in ("present", "missing", "unclear"))
    if total == 0:
        return None, dict(counts)
    return round(100 * counts.get("present", 0) / total), dict(counts)


def _structured_summary(result):
    """Extracts exactly the fields this test compares across runs - see
    this module's own docstring for the full COMPARED/NEVER COMPARED
    split. Returns a plain, JSON-serializable dict."""
    assessment = result.get("assessment") or {}
    checklist = assessment.get("checklist") or []
    checklist_frozen = result.get("checklist_frozen")

    if checklist_frozen:
        keys = sorted(c.get("key") for c in checklist if c.get("key"))
        statuses_by_key = {c.get("key"): c.get("status") for c in checklist if c.get("key")}
    else:
        # Legacy (unfrozen) mode has no stable "key" - the item NAME is
        # the closest thing to an identity, same limitation the original
        # trace flagged (_norm_key() fuzzy matching). A run that falls
        # back to legacy mode is itself a reportable divergence (see
        # checklist_frozen in the compared-fields list above), so a test
        # run mixing frozen/legacy runs will already fail on that field
        # before this branch's weaker identity matters.
        keys = sorted((c.get("item") or "").strip().lower() for c in checklist)
        statuses_by_key = {(c.get("item") or "").strip().lower(): c.get("status") for c in checklist}

    pct_present, counts = _pct_present(checklist)
    citation_pairs = sorted(
        {(c.get("doc"), c.get("page")) for c in (result.get("evidence_citations") or [])}
    )

    return {
        "compliance_status": result.get("compliance_status"),
        "assessment_coverage": result.get("assessment_coverage"),
        "checklist_frozen": checklist_frozen,
        "checklist_keys": keys,
        "checklist_statuses_by_key": statuses_by_key,
        "checklist_status_counts": counts,
        "pct_present_score": pct_present,
        "issue_count": len(assessment.get("issues") or []),
        "evidence_citation_pairs": [list(p) for p in citation_pairs],
        "evidence_confidence": result.get("evidence_confidence"),
        "error": result.get("error"),
        # 2026-09-28 determinism pass: run-identity fields
        # (proposal_review.py's own instrumentation). These SHOULD be
        # identical across all N runs of one script invocation (same
        # backend/model/seed/schema version every time, by construction)
        # - a divergence here means the run identity itself moved
        # (e.g. an env var changed mid-test, DEFAULT_GROQ_MODEL was
        # edited between runs), which is worth surfacing on its own,
        # separately from whether the ASSESSMENT itself was reproducible.
        "model_used": result.get("model_used"),
        "backend_used": result.get("backend_used"),
        "checklist_version": result.get("checklist_version"),
        "run_fingerprint": result.get("run_fingerprint"),
    }


def _diff_against_baseline(baseline, run_n, summary):
    """Returns a list of human-readable divergence strings, empty if
    `summary` matches `baseline` on every compared field."""
    diffs = []
    for field in (
        "compliance_status", "checklist_frozen", "checklist_keys",
        "checklist_statuses_by_key", "checklist_status_counts",
        "pct_present_score", "evidence_citation_pairs",
        # Run-identity fields (see _structured_summary()'s own
        # comment) - compared too, since a difference here invalidates
        # the whole comparison (the runs weren't actually run under
        # identical conditions) rather than representing a genuine
        # assessment-pipeline nondeterminism.
        "model_used", "backend_used", "checklist_version", "run_fingerprint",
    ):
        if summary.get(field) != baseline.get(field):
            diffs.append(
                f"run {run_n} field '{field}' differs from run 1: "
                f"{baseline.get(field)!r} -> {summary.get(field)!r}"
            )
    # assessment_coverage compared field-by-field so a diff names exactly
    # which sub-field moved (assessed_units vs. pct vs. complete, etc.)
    # rather than one opaque "dict differs" line.
    base_cov = baseline.get("assessment_coverage") or {}
    run_cov = summary.get("assessment_coverage") or {}
    for k in set(base_cov) | set(run_cov):
        if base_cov.get(k) != run_cov.get(k):
            diffs.append(
                f"run {run_n} assessment_coverage.{k} differs from run 1: "
                f"{base_cov.get(k)!r} -> {run_cov.get(k)!r}"
            )
    return diffs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--backend", default="groq", choices=["groq", "ollama"])
    ap.add_argument("--model", default=None)
    ap.add_argument(
        "--fixture", default=str(Path(__file__).resolve().parent.parent / "tests/fixtures/bassetlaw_proposal.pdf"),
    )
    ap.add_argument("--postcode", default=None, help="Omit to use the fixture's own auto-detected site, same as production.")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "reports/reproducibility"))
    ap.add_argument("--sleep-between-runs", type=float, default=5.0, help="Pacing between full runs, on top of the pipeline's own inter-call pacing - avoids stacking rate-limit pressure across whole runs.")
    args = ap.parse_args()

    fixture_path = Path(args.fixture)
    if not fixture_path.exists():
        print(f"Fixture not found: {fixture_path}", file=sys.stderr)
        return 2

    print(f"Extracting proposal text once from {fixture_path.name} (shared across all {args.runs} runs, "
          "so this test isolates the ASSESSMENT pipeline's determinism, not PDF text extraction)...")
    text, _pages_with_text, _pages_without_text, extract_error = extract_proposal_text(fixture_path)
    if extract_error:
        print(f"Fixture text extraction failed: {extract_error}", file=sys.stderr)
        return 2
    document_texts = [(fixture_path.name, text)]

    out_dir = Path(args.out) / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)

    summaries = []
    full_results = []
    for i in range(args.runs):
        if i > 0 and args.sleep_between_runs > 0:
            time.sleep(args.sleep_between_runs)
        print(f"--- run {i + 1}/{args.runs} (backend={args.backend}) ---")
        t0 = time.time()
        result = review_proposal(
            document_texts, postcode=args.postcode, backend=args.backend, model=args.model,
        )
        elapsed = time.time() - t0
        summary = _structured_summary(result)
        summaries.append(summary)
        full_results.append(result)
        print(
            f"  compliance_status={summary['compliance_status']!r} "
            f"coverage={summary['assessment_coverage']} "
            f"pct_present={summary['pct_present_score']} "
            f"checklist_keys={len(summary['checklist_keys'])} "
            f"issues={summary['issue_count']} "
            f"({elapsed:.1f}s)"
        )
        (out_dir / f"run_{i + 1}_full.json").write_text(json.dumps(result, indent=2, default=str))

    (out_dir / "structured_summaries.json").write_text(json.dumps(summaries, indent=2, default=str))

    baseline = summaries[0]
    all_diffs = []
    for i, summary in enumerate(summaries[1:], start=2):
        all_diffs.extend(_diff_against_baseline(baseline, i, summary))

    if all_diffs:
        diff_path = out_dir / "DIFF_FAIL.json"
        diff_path.write_text(json.dumps({
            "verdict": "FAIL",
            "runs": args.runs,
            "backend": args.backend,
            "fixture": str(fixture_path),
            "baseline_run": 1,
            "divergences": all_diffs,
        }, indent=2))
        print(f"\nFAIL: {len(all_diffs)} divergence(s) found across {args.runs} runs. "
              f"Structured diff saved to {diff_path}")
        for d in all_diffs:
            print(f"  - {d}")
        return 1

    verdict_path = out_dir / "PASS.json"
    verdict_path.write_text(json.dumps({
        "verdict": "PASS",
        "runs": args.runs,
        "backend": args.backend,
        "fixture": str(fixture_path),
        "baseline_summary": baseline,
    }, indent=2))
    print(f"\nPASS: all {args.runs} runs produced identical structured results "
          f"(narrative wording not compared). Summary saved to {verdict_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
