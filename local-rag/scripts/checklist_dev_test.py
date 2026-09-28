#!/usr/bin/env python3
"""Standalone checklist-generation dev/test harness (2026-09-28,
token-budget truncation follow-up, item 10: "For the exact failing
Planning Enforcement Review.pdf: first test only checklist generation.
Do not repeatedly run the entire 50-second compliance pipeline while
debugging one stage.").

Runs retrieval (site resolution + per-topic orchestrate() +
build_context()) ONCE for a given fixture PDF and CACHES the resulting
evidence citations/constraint_summary/resolved_model to a local JSON
file keyed by a hash of (pdf path, postcode, backend). Every subsequent
invocation against the SAME fixture/postcode/backend skips retrieval
entirely and replays the cached evidence straight into the checklist
stage - so iterating on checklist-stage bugs (the prompt, the schema,
the budget ladder, the model) doesn't re-pay retrieval's own cost (or
its own nondeterminism) on every attempt.

Two modes:

  --mode budget-ladder (default): runs ONE single-evidence-citation
  batch (the exact failing shape from the live incident -
  evidence_ids=[1]) at each of --budgets (default 600,1200,1800,2400),
  through the SAME _run_checklist_batch() production code path (not a
  reimplementation), and prints model/batch/input estimate/output
  budget/finish_reason/parse success/elapsed time/rule count for each
  rung - item 3's "same evidence, same prompt, 600 -> 1200 -> 1800 ->
  2400" experiment, run in isolation from the rest of the pipeline
  rather than inferred after the fact from production logs.

  --mode consistency: runs the FULL _generate_checklist_catalog() (all
  batches, the real split/escalate recovery included) over ALL cached
  evidence --runs times (default 5) and reports whether the returned
  checklist's key set is identical across every run - the actual gate
  item 10 sets: "once the checklist test succeeds consistently 5/5
  times, reconnect it to the full compliance flow."

Requires the real project dependencies (qdrant_client,
sentence_transformers, torch, an OLLAMA_BASE_URL or GROQ_API_KEY) and a
reachable retrieval index/Ollama instance - this is a real dev-environment
script. It was written and syntax-checked from a sandboxed session that
has neither (see the project status doc's standing constraint on this) -
it has never actually been executed; run it in your own dev environment.

Usage:
    python scripts/checklist_dev_test.py --pdf "/path/to/Planning Enforcement Review.pdf" \\
        --backend ollama --model deepseek-r1:7b --mode budget-ladder

    python scripts/checklist_dev_test.py --pdf "/path/to/Planning Enforcement Review.pdf" \\
        --backend ollama --mode consistency --runs 5

    # Try a candidate COMPLIANCE_CHECKLIST_MODEL against the same
    # cached evidence, without touching your .env:
    python scripts/checklist_dev_test.py --pdf "..." --backend ollama \\
        --model llama3.1:8b-instruct --mode budget-ladder
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from answer import _setup_backend, build_context  # noqa: E402
from orchestrate import orchestrate  # noqa: E402
from proposal_review import (  # noqa: E402
    CHECKLIST_STAGE_OLLAMA_THINK,
    CHECKLIST_USE_OLLAMA_STRUCTURED_OUTPUT,
    CHECKLIST_BATCH_JSON_SCHEMA,
    MAX_EVIDENCE_CHUNKS,
    _describe_constraints,
    _generate_checklist_catalog,
    _resolve_site,
    _run_checklist_batch,
    _select_topics,
    extract_proposal_text,
)

CACHE_DIR = Path(__file__).resolve().parent / ".checklist_dev_cache"


def _cache_key(pdf_path, postcode, backend):
    raw = f"{Path(pdf_path).resolve()}|{postcode}|{backend}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _json_schema_for(backend):
    return CHECKLIST_BATCH_JSON_SCHEMA if (backend == "ollama" and CHECKLIST_USE_OLLAMA_STRUCTURED_OUTPUT) else None


def _load_or_build_evidence(pdf_path, postcode, project_id, backend, model, top_k, rerank_top_n):
    """Mirrors review_proposal()'s own extraction -> site resolution ->
    per-topic retrieval -> build_context() sequence exactly (same
    functions, same order), but only ever runs it ONCE per (pdf,
    postcode, backend) - see this module's own docstring for why."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_path = CACHE_DIR / f"{_cache_key(pdf_path, postcode, backend)}.json"
    if cache_path.exists():
        print(f"[cache] reusing retrieved evidence from {cache_path}")
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        return data["citations"], data["constraint_summary"]

    print(f"[retrieval] no cache found - running extraction + retrieval ONCE for {pdf_path}")
    text, _pages_with_text, _pages_without_text, extract_error = extract_proposal_text(pdf_path)
    if extract_error:
        print(f"FATAL: {extract_error}")
        sys.exit(1)
    document_texts = [(Path(pdf_path).name, text)]

    site, geography, error, _site_detection, note = _resolve_site(
        document_texts, project_id, postcode, None, None
    )
    if error:
        print(f"FATAL: site resolution failed: {error}")
        sys.exit(1)
    if note:
        print(f"[site] {note}")

    phrases, _area_names = _describe_constraints(site) if site else ([], [])
    constraint_summary = " and ".join(phrases) if phrases else None
    topics = _select_topics(site)
    print(f"[retrieval] {len(topics)} topic(s) to check")

    all_chunks = []
    seen = set()
    for topic in topics:
        query = topic + (f", for a site {constraint_summary}" if constraint_summary else "")
        try:
            chunks, _coverage = orchestrate(
                query, top_k=top_k, rerank_top_n=rerank_top_n, geography_filter=geography
            )
        except Exception as e:
            print(f"[retrieval] topic {topic!r} failed: {e}")
            continue
        for c in chunks:
            key = (c["doc_filename"], c["page"], c["text"][:80])
            if key not in seen:
                seen.add(key)
                all_chunks.append(c)

    if not all_chunks:
        print("FATAL: no evidence retrieved for any topic - nothing to test checklist "
              "generation against")
        sys.exit(1)

    all_chunks.sort(key=lambda c: c.get("rerank_score", 0.0), reverse=True)
    all_chunks = all_chunks[:MAX_EVIDENCE_CHUNKS]
    _context, citations = build_context(all_chunks)

    cache_path.write_text(json.dumps({
        "citations": citations,
        "constraint_summary": constraint_summary,
    }, indent=2), encoding="utf-8")
    print(f"[cache] wrote {len(citations)} citation(s) to {cache_path}")
    return citations, constraint_summary


def run_budget_ladder(citations, constraint_summary, backend, model, budgets):
    """Item 3/10: the exact failing single-evidence-citation shape
    (evidence_ids=[1]), replayed through the SAME _run_checklist_batch()
    production code path at each budget in `budgets`, in isolation from
    the rest of the pipeline."""
    client, error_types, resolved_model, early_error = _setup_backend(backend, model)
    if early_error:
        print(f"FATAL: {early_error}")
        sys.exit(1)
    single = citations[:1]
    think = CHECKLIST_STAGE_OLLAMA_THINK if backend == "ollama" else None
    json_schema = _json_schema_for(backend)
    print(f"\n=== budget ladder: evidence_ids={[c['id'] for c in single]} "
          f"model={resolved_model} backend={backend} think={think} "
          f"json_schema={'yes' if json_schema else 'no'} ===")
    print(f"{'budget':>8}  {'finish_reason':<16}  {'parsed':<7}  {'items':>6}  {'elapsed_s':>10}")
    for budget in budgets:
        t0 = time.monotonic()
        items, kind, detail = _run_checklist_batch(
            client, resolved_model, single, constraint_summary, backend, error_types,
            think, budget, json_schema=json_schema,
        )
        elapsed = time.monotonic() - t0
        parsed_ok = items is not None
        n_items = len(items) if items else 0
        print(f"{budget:>8}  {(kind or 'ok'):<16}  {str(parsed_ok):<7}  {n_items:>6}  {elapsed:>10.1f}")
        if not parsed_ok:
            print(f"          detail: {detail}")
        else:
            print(f"          items: {json.dumps(items, indent=None)[:200]}")


def run_consistency(citations, constraint_summary, backend, model, runs):
    """Item 10's actual gate: N identical runs of the FULL
    _generate_checklist_catalog() (all batches, the real split/escalate
    recovery included) over the SAME cached evidence, before
    reconnecting to the full compliance pipeline."""
    client, error_types, resolved_model, early_error = _setup_backend(backend, model)
    if early_error:
        print(f"FATAL: {early_error}")
        sys.exit(1)
    think = CHECKLIST_STAGE_OLLAMA_THINK if backend == "ollama" else None
    json_schema = _json_schema_for(backend)
    key_sets = []
    for i in range(runs):
        t0 = time.monotonic()
        catalog, error = _generate_checklist_catalog(
            client, resolved_model, citations, constraint_summary, backend=backend,
            error_types=error_types, think=think, json_schema=json_schema,
        )
        elapsed = time.monotonic() - t0
        if catalog is None:
            print(f"run {i + 1}/{runs}: FAILED ({error}) after {elapsed:.1f}s")
            key_sets.append(None)
            continue
        keys = sorted(c["key"] for c in catalog)
        print(f"run {i + 1}/{runs}: {len(keys)} item(s), {elapsed:.1f}s -> {keys}")
        key_sets.append(keys)

    baseline = key_sets[0]
    all_match = baseline is not None and all(ks == baseline for ks in key_sets)
    print(f"\n{'PASS' if all_match else 'FAIL'}: {runs} run(s), "
          f"{'identical' if all_match else 'DIVERGED'} checklist key sets")
    sys.exit(0 if all_match else 1)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--pdf", required=True, help="path to the fixture PDF")
    parser.add_argument("--postcode", default=None)
    parser.add_argument("--project-id", type=int, default=None)
    parser.add_argument("--backend", default="ollama", choices=["ollama", "groq"])
    parser.add_argument(
        "--model", default=None,
        help="overrides the backend's default model for THIS test run only - e.g. "
             "deepseek-r1:7b, or a candidate COMPLIANCE_CHECKLIST_MODEL like "
             "llama3.1:8b-instruct",
    )
    parser.add_argument("--mode", default="budget-ladder", choices=["budget-ladder", "consistency"])
    parser.add_argument("--budgets", default="600,1200,1800,2400")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--top-k", type=int, default=15)
    parser.add_argument("--rerank-top-n", type=int, default=6)
    args = parser.parse_args()

    citations, constraint_summary = _load_or_build_evidence(
        args.pdf, args.postcode, args.project_id, args.backend, args.model,
        args.top_k, args.rerank_top_n,
    )

    if args.mode == "budget-ladder":
        budgets = [int(b.strip()) for b in args.budgets.split(",") if b.strip()]
        run_budget_ladder(citations, constraint_summary, args.backend, args.model, budgets)
    else:
        run_consistency(citations, constraint_summary, args.backend, args.model, args.runs)


if __name__ == "__main__":
    main()
