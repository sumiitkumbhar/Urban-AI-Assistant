#!/usr/bin/env python3
"""One-off verification run (not the full reproducibility suite) - checks
that the 2026-09-28 topic/key regression fix actually works against a
real live call, using the same Bassetlaw fixture the user's screenshots
showed the bug on."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from proposal_review import extract_proposal_text, review_proposal  # noqa: E402

fixture = Path(__file__).resolve().parent / "tests/fixtures/bassetlaw_proposal.pdf"
text, _a, _b, extract_error = extract_proposal_text(fixture)
if extract_error:
    print(f"EXTRACT ERROR: {extract_error}")
    sys.exit(2)

result = review_proposal([(fixture.name, text)], backend="groq")

print("=== top-level ===")
for k in ("compliance_status", "assessment_coverage", "evidence_confidence", "checklist_frozen", "assessment_failed", "parse_error"):
    print(f"{k}: {result.get(k)!r}")

assessment = result.get("assessment") or {}
issues = assessment.get("issues") or []
checklist = assessment.get("checklist") or []

print(f"\n=== issues ({len(issues)}) - topic field check ===")
catalog_key_like = 0
for i, iss in enumerate(issues):
    topic = iss.get("topic") or ""
    looks_like_slug = bool(topic) and "-" in topic and " " not in topic and topic.islower()
    if looks_like_slug:
        catalog_key_like += 1
    print(f"[{i}] topic={topic!r} slug_like={looks_like_slug}")

print(f"\n=== checklist ({len(checklist)}) ===")
for c in checklist:
    print(f"  key={c.get('key')!r} item={c.get('item')!r} status={c.get('status')!r}")

print(f"\n=== VERDICT: {catalog_key_like} of {len(issues)} issue topics still look like raw slugs ===")
Path(__file__).resolve().parent.joinpath("verify_topic_fix_result.json").write_text(
    json.dumps(result, indent=2, default=str)
)
