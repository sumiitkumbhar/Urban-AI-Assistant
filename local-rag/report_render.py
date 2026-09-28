"""Renders review_proposal()'s result dict as a downloadable report - a
plain Markdown version and a designed PDF - so the tool hands back an
actual document rather than terminal/JSON output (added 2026-09-18, per
explicit request: "I don't want it to generate a report but... generates
the MD file... so the user can download the MD file", followed by "I want
best infographics, images and all placement... all aspects taken care
of").

Two independent renderers consume the same result dict rather than one
converting to the other (Markdown -> HTML would flatten the PDF's layout
to whatever the conversion could express):

    render_markdown(result, document_names)              -> str
    render_html(result, document_names, images)           -> str   (feeds the PDF)
    render_pdf_bytes(html)                                 -> bytes (WeasyPrint)
    extract_report_images(pdf_paths, max_images, min_dim)  -> list[dict]  (PyMuPDF)
    build_reports(result, document_names, pdf_paths)       -> dict  (does all of the above)

WeasyPrint was picked over alternatives (gofpdf - wrong language/archived;
lowlighter/metrics - wrong domain/Node) after comparing options - see
local-rag-status.md: pure Python, HTML/CSS -> PDF, no headless browser,
drops straight into this all-Python stack.

Colors and chart marks reuse this project's validated data-viz palette
(light-surface only - this is a print document, no dark mode) rather than
ad hoc colors: the fixed status palette (good/warning/serious/critical)
for the checklist and the risk badge, a single accent hue for the
issues-by-topic bar (one series - no legend needed), and the documented
ink/surface/gridline roles for everything else. warning/serious don't
clear 3:1 contrast on the light surface by the palette's own numbers, so
every status use pairs an icon with the label - color is never the only
signal, matching the palette's own documented mitigation.

Added 2026-09-18, per "make it descriptive and more detailed also more
visuals so that it is fun to read and also intext citations": a checklist
status donut (a second infographic beside the issues-by-topic bar), a
small hand-drawn icon per topic (_topic_icon_svg), a table of contents,
and clickable in-text [N] citations (_linkify) that jump to the matching
Evidence table row - the same citation numbers REVIEW_SYSTEM_PROMPT now
asks the model to weave into its prose rather than bolt on afterward.
"""

import base64
import datetime as _dt
import html as _html
import math
import re
from collections import Counter
from io import BytesIO
from pathlib import Path

# --- Validated palette (see local-rag-status.md / the dataviz skill's
# references/palette.md) - light-surface values only; a PDF has no dark
# mode to switch to.
COLOR_SURFACE = "#fcfcfb"
COLOR_PAGE_PLANE = "#f9f9f7"
COLOR_INK_PRIMARY = "#0b0b0b"
COLOR_INK_SECONDARY = "#52514e"
COLOR_INK_MUTED = "#898781"
COLOR_GRIDLINE = "#e1e0d9"
COLOR_BORDER = "rgba(11,11,11,0.10)"
COLOR_ACCENT = "#2a78d6"  # categorical slot 1 / sequential base hue - the one-series bar color
COLOR_ACCENT_TINT = "#eaf2fb"  # light wash of COLOR_ACCENT, same construction as the STATUS
# tints below - used on the "Issues flagged" stat tile, which isn't a status color but wants
# the same visual treatment so all four stat tiles read as one family.

# Status palette - fixed, never themed. (icon, hex, background tint)
STATUS = {
    "present": ("✓", "#0ca30c", "#eaf7ea"),   # good
    "missing": ("✗", "#d03b3b", "#fbecec"),   # critical
    "unclear": ("!", "#fab219", "#fef5e4"),        # warning
}
RISK_LEVELS = {
    "Low": ("✓", "#0ca30c", "#eaf7ea"),
    "Medium": ("!", "#fab219", "#fef5e4"),
    "High": ("✗", "#d03b3b", "#fbecec"),
    # Not a risk level - a distinct state (2026-09-28 reliability fix,
    # points 1/2/5): shown INSTEAD OF a Low/Medium/High verdict whenever
    # compliance_status == "incomplete" (see render_markdown/render_html's
    # own comments), so a partial assessment can never be mistaken for a
    # completed one just because it also has a colored badge. Uses the
    # neutral accent blue, not amber/red, since "incomplete" isn't itself
    # bad news the way "High risk" is - it's a statement about assessment
    # coverage, not about the proposal.
    "Incomplete": ("\u25d0", COLOR_ACCENT, COLOR_ACCENT_TINT),
}

FONT_STACK = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif'


def report_slug(result):
    """Filesystem-safe basename for the saved report files - derived from
    the site's geography (falls back to "site") plus today's date, so
    re-running against the same site on a later day doesn't silently
    overwrite yesterday's report."""
    import re

    base = result.get("geography") or "site"
    base = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-") or "site"
    return f"{base}-{_dt.date.today().isoformat()}"


def _compute_risk(assessment):
    """A transparent, disclosed heuristic - never a black-box score. Every
    number it's based on is already on the page (the scorecard, the
    checklist), so the badge is a summary of visible evidence, not a new
    claim - consistent with the disclaimer's own "verify, don't trust"
    framing."""
    checklist = assessment.get("checklist") or []
    issues = assessment.get("issues") or []
    counts = Counter(c.get("status") for c in checklist)
    missing, unclear = counts.get("missing", 0), counts.get("unclear", 0)
    n_issues = len(issues)
    if missing >= 2 or n_issues >= 4:
        level = "High"
    elif missing >= 1 or unclear >= 2 or n_issues >= 1:
        level = "Medium"
    else:
        level = "Low"
    basis = (
        f"{missing} required item(s) missing, {unclear} unclear, "
        f"{n_issues} issue(s) flagged"
    )
    return level, basis, counts


def _site_detection_note(result):
    """One-line provenance note when the site was auto-detected rather
    than given (site_lookup.detect_site(), wired in via
    proposal_review._resolve_site() - added 2026-09-19, extended
    2026-09-20 with the known_places directory tier). None when the
    caller supplied a project/postcode/lat-lon directly, since then
    there's nothing to disclose. Three possible sources, only one of
    which gets the warning treatment:
      - "document text": a postcode was literally written in the
        proposal - as certain as a manually-entered postcode.
      - "known place directory": no postcode in the text, but a name in
        it (a council, a reviewed site) matched gis/known_places.py's
        curated, sourced directory - not a live third-party guess, so
        this is presented the same as "document text", no warning icon.
      - "place name lookup": neither of the above - a name was geocoded
        live via Nominatim. This is the one genuinely uncertain case
        (see site_lookup.py's own docstring on inference vs geocoding
        uncertainty), flagged with a warning icon rather than presented
        the same as the other two - matches this report's existing rule
        (see STATUS above) that a status/caveat is never color- or
        prose-only, always icon + label."""
    sd = result.get("site_detection")
    if not sd:
        return None
    if sd.get("source") == "place name lookup":
        return f"⚠ Site auto-detected (guessed from a name in the document, not a postcode on the page) - please verify: {sd.get('detail', '')}"
    if sd.get("source") == "known place directory":
        return f"Site auto-detected from a known-places directory match: {sd.get('detail', '')}"
    return f"Site auto-detected from the document: {sd.get('detail', '')}"


# --------------------------------------------------------------------------
# Markdown renderer
# --------------------------------------------------------------------------

def render_markdown(result, document_names):
    assessment = result.get("assessment") or {}
    failed = bool(result.get("assessment_failed"))
    # compliance_status (2026-09-28 reliability fix) is the real tri-state
    # this report needs - "failed" (nothing usable, handled by the `failed`
    # branch below, unchanged), "incomplete" (some excerpts couldn't be
    # assessed - real findings shown, but no definitive risk/compliance
    # verdict), "final" (full coverage). Older result dicts (saved reports
    # from before this field existed) fall back to the old two-state
    # reading so a stale saved report still renders instead of crashing.
    compliance_status = result.get("compliance_status") or ("failed" if failed else "final")

    L = []
    L.append("# Proposal Compliance Review")
    L.append("")
    L.append(f"**Documents:** {', '.join(document_names)}")
    L.append(f"**Site:** {result.get('geography') or '(unscoped)'}")
    if result.get("constraint_summary"):
        L.append(f"**Site constraints:** {result['constraint_summary']}")
    if _site_detection_note(result):
        L.append(f"**Site detection:** {_site_detection_note(result)}")
    L.append(f"**Generated:** {_dt.date.today().isoformat()}")
    L.append("")
    if result.get("disclaimer"):
        L.append("> " + result["disclaimer"])
        L.append("")

    if failed:
        # No risk badge, no issues, no checklist here - computing any of
        # those from an empty/failed assessment would look like a clean
        # "Low risk, nothing found" result, which is precisely wrong. See
        # proposal_review.py's own comment on why this is a distinct state
        # from "checked and found nothing."
        L.append("## Assessment generation failed")
        L.append("")
        L.append(
            "**This is not a clean result.** The model call that produces the issues "
            "and checklist did not return a usable answer, so neither is shown below. "
            "Retrieval succeeded - only the final write-up failed. Re-run the review; "
            "see the note below for why it failed."
        )
        L.append("")
        L.append(f"> {result.get('parse_error', '')}")
        L.append("")
        if result.get("topics_checked"):
            L.append(f"**Topics checked:** {', '.join(result['topics_checked'])}")
            L.append("")
        L.append("## Evidence retrieved")
        L.append("")
        L.append("| # | Document | Page | Domain | Geography |")
        L.append("|---|---|---|---|---|")
        for c in result.get("evidence_citations", []):
            L.append(f"| {c['id']} | {c['doc']} | {c['page']} | {c['domain']} | {c['geography']} |")
        return "\n".join(L) + "\n"

    issues = assessment.get("issues") or []
    checklist = assessment.get("checklist") or []
    coverage = result.get("assessment_coverage") or {}
    evidence_confidence = result.get("evidence_confidence")

    # Points 1/2 of the 2026-09-28 reliability fix: never present a
    # definitive compliance verdict computed from a partial assessment.
    # compliance_status == "incomplete" means some excerpts failed - the
    # issues/checklist below are real (from the excerpts that DID
    # succeed), but a "missing" item may simply live in a part of the
    # document that couldn't be checked this run, so no Low/Medium/High
    # verdict is shown here - only the three separate, honest numbers:
    # assessment coverage, evidence confidence, and (still) the real
    # counts of what was found, clearly framed as partial.
    if compliance_status == "incomplete":
        L.append("**Compliance result: Incomplete — this is not a final assessment.**")
        L.append(
            f"Only {coverage.get('assessed_units', 0)} of {coverage.get('total_units', 0)} "
            f"document excerpt(s) could be assessed. A checklist item marked \"missing\" below "
            "may simply be in a part of the document that wasn't assessed, not genuinely "
            "absent - re-run the review for a complete, final result."
        )
        L.append(f"**Assessment coverage:** {coverage.get('pct', 0)}%")
        if evidence_confidence:
            L.append(f"**Evidence confidence:** {evidence_confidence}")
        L.append(
            f"**Checklist status (partial):** {sum(1 for c in checklist if c.get('status') == 'present')} present, "
            f"{sum(1 for c in checklist if c.get('status') == 'missing')} missing, "
            f"{sum(1 for c in checklist if c.get('status') == 'unclear')} unclear."
        )
    else:
        level, basis, counts = _compute_risk(assessment)
        L.append(f"**Overall attention needed: {level}** — {basis}.")
        L.append(
            f"**Checklist status:** {counts.get('present', 0)} present, "
            f"{counts.get('missing', 0)} missing, {counts.get('unclear', 0)} unclear."
        )
        L.append(f"**Assessment coverage:** {coverage.get('pct', 100)}%")
        if evidence_confidence:
            L.append(f"**Evidence confidence:** {evidence_confidence}")
    L.append("")
    if assessment.get("summary"):
        L.append(f"**Summary:** {assessment['summary']}")
        L.append("")
    if result.get("topics_checked"):
        L.append(f"**Topics checked:** {', '.join(result['topics_checked'])}")
        L.append("")
    if result.get("topics_failed"):
        L.append(
            f"**Note:** these topics failed to retrieve and were skipped: "
            f"{', '.join(result['topics_failed'])}."
        )
        L.append("")
    if result.get("proposal_truncated"):
        L.append("**Note:** proposal text was truncated to fit the assessment call.")
        L.append("")

    L.append(f"## Issues ({len(issues)})")
    L.append("")
    if not issues:
        L.append("No specific issues flagged.")
    else:
        for i, issue in enumerate(issues, 1):
            cites = ", ".join(f"[{c}]" for c in issue.get("citations", []))
            L.append(f"{i}. **[{issue.get('topic', '')}]** {issue.get('issue', '')} {cites}")
            L.append(f"   - Suggested change: {issue.get('suggested_change', '')}")
            # "verified" is only present when the second-opinion pass
            # (proposal_review.py's _verify_issues(), added 2026-09-24)
            # actually checked this issue - absent means "not
            # independently checked" (past its cap, or that pass failed),
            # a different, weaker claim than a pass, so it prints nothing
            # rather than a misleading badge either way. See that
            # function's own docstring for why a missing key is never
            # read as true.
            if issue.get("verified") is True:
                L.append("   - ✓ Independently verified against the cited evidence.")
            elif issue.get("verified") is False:
                note = issue.get("verification_note", "")
                L.append(f"   - ⚠ Second-opinion check flagged this: {note}")
    L.append("")

    L.append(f"## Required content checklist ({len(checklist)})")
    L.append("")
    if checklist:
        L.append("| Status | Item | Note | Citations |")
        L.append("|---|---|---|---|")
        for item in checklist:
            cites = ", ".join(f"[{c}]" for c in item.get("citations", []))
            L.append(
                f"| {item.get('status', '')} | {item.get('item', '')} | "
                f"{item.get('note', '')} | {cites} |"
            )
    else:
        L.append("No checklist could be built.")
    L.append("")

    L.append("## Evidence cited")
    L.append("")
    L.append("| # | Document | Page | Domain | Geography |")
    L.append("|---|---|---|---|---|")
    for c in result.get("evidence_citations", []):
        L.append(f"| {c['id']} | {c['doc']} | {c['page']} | {c['domain']} | {c['geography']} |")

    if result.get("parse_error"):
        L.append("")
        L.append(f"> Note: {result['parse_error']}")

    return "\n".join(L) + "\n"


# --------------------------------------------------------------------------
# HTML / PDF renderer
# --------------------------------------------------------------------------

def _esc(s):
    return _html.escape(str(s if s is not None else ""))


# Matches a citation marker like "[5]" so it can be turned into a link -
# added 2026-09-18 per explicit request for "in-text citations": every
# [N] the model writes inline (see REVIEW_SYSTEM_PROMPT) becomes a real
# jump-to-evidence link rather than a plain bracketed number.
_CITE_RE = re.compile(r"\[(\d+)\]")


def _linkify(text):
    """Escapes text, then turns every [N] citation marker into a link to
    that evidence row's anchor (#ev-N, set on the Evidence table's <tr> -
    see render_html). Escaping first is safe here because a citation
    marker is plain digits/brackets, so escaping can't create or destroy
    a match."""
    escaped = _esc(text)
    return _CITE_RE.sub(
        lambda m: f'<a class="cite-link" href="#ev-{m.group(1)}">[{m.group(1)}]</a>', escaped
    )


def _verification_badge_html(issue):
    """Second-opinion badge for one issue card (proposal_review.py's
    _verify_issues(), added 2026-09-24) - "" when this issue was never
    independently checked (issue.get("verified") is None: past
    MAX_ISSUES_TO_VERIFY, or the whole verification call failed/timed
    out), since that's a distinct, weaker claim than a pass and must not
    print a misleading badge either way (see that function's own
    docstring). Reuses STATUS's existing present/unclear colors rather
    than inventing new ones, so this reads as part of the same status
    palette as the checklist chips instead of a one-off."""
    verified = issue.get("verified")
    if verified is True:
        _, color, tint = STATUS["present"]
        return (
            f'<div class="card-verify" style="color:{color};background:{tint};">'
            f"✓ Independently verified against the cited evidence.</div>"
        )
    if verified is False:
        _, color, tint = STATUS["unclear"]
        note = _esc(issue.get("verification_note", ""))
        return (
            f'<div class="card-verify" style="color:{color};background:{tint};">'
            f"⚠ Second-opinion check flagged this: {note}</div>"
        )
    return ""


# Small hand-drawn (not brand/emoji) icon per topic keyword, added
# 2026-09-18 per "more visuals so it is fun to read" - purely decorative
# next to topic tags and issue-card headers, never the only signal for
# anything (status still comes from the chips/badges, which pair color
# with an icon + label already). Keyword match against the topic's own
# query text (see STANDARD_TOPICS), falling back to a generic document
# glyph.
def _topic_icon_svg(topic_text, size=12, color=None):
    color = color or COLOR_INK_SECONDARY
    t = (topic_text or "").lower()
    attrs = (
        f'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="{size}" height="{size}" '
        f'fill="none" stroke="{color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'
    )
    if "flood" in t or "water" in t or "drainage" in t:
        body = '<path d="M8 1.5c2.5 3 4.5 5.8 4.5 8.3a4.5 4.5 0 1 1-9 0C3.5 7.3 5.5 4.5 8 1.5z"/>'
    elif "heritage" in t or "listed" in t or "conservation" in t:
        body = ('<path d="M2 6.5 8 2l6 4.5"/><rect x="3" y="6.5" width="10" height="7" rx="0.5"/>'
                '<path d="M5.5 13.5v-4M8 13.5v-4M10.5 13.5v-4"/>')
    elif "article 4" in t or "permitted development" in t or "green belt" in t:
        body = '<path d="M8 1.5 13.5 3.5v4c0 4-2.5 6.3-5.5 7-3-0.7-5.5-3-5.5-7v-4z"/>'
    elif "fire" in t or "building regulation" in t:
        body = ('<path d="M8 1.5c1 2 0.3 3-0.5 4-1 1.3-1.5 2.3-1.5 3.5a2 2 0 0 0 4 0c0-0.7-0.3-1.3-0.8-1.8 '
                '1 0.5 1.8 1.7 1.8 3.1A3.5 3.5 0 0 1 8 14a3.8 3.8 0 0 1-3.8-3.8C4.2 7 5.8 5 8 1.5z"/>')
    elif "parking" in t or "highway" in t or "access" in t or "transport" in t:
        body = ('<rect x="2" y="7.5" width="12" height="4" rx="1"/><path d="M3.5 7.5 5 4.5h6l1.5 3"/>'
                '<circle cx="5" cy="12.5" r="1"/><circle cx="11" cy="12.5" r="1"/>')
    elif "housing" in t or "land use" in t:
        body = '<path d="M2 7 8 2.5 14 7"/><rect x="4" y="7" width="8" height="6.5"/><rect x="7" y="9.5" width="2" height="4"/>'
    elif "required content" in t or "mandatory" in t or "design and access statement" in t:
        body = '<rect x="3" y="2" width="10" height="12" rx="0.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/>'
    else:  # design/scale/massing and anything unmatched
        body = '<rect x="2.5" y="4" width="11" height="8" rx="1"/><path d="M5 4V2.5M11 4V2.5"/>'
    return f'<svg {attrs}>{body}</svg>'


def _status_donut_svg(counts, size=110, stroke=16, animate=False):
    """Checklist status as a ring chart (missing/unclear/present) - a
    second infographic alongside the issues-by-topic bar, added 2026-09-18
    per "more visuals". Status colors are the fixed palette; the legend
    printed beside it (see render_html) is the real identity channel -
    color is never the only signal, same rule as the chips. Returns ""
    when the checklist is empty (a donut with nothing in it isn't a
    chart)."""
    total = sum(counts.get(k, 0) for k in ("present", "missing", "unclear"))
    if total == 0:
        return ""
    r = (size - stroke) / 2
    cx = cy = size / 2
    circumference = 2 * math.pi * r
    segments = []
    offset = 0.0
    gap = 2  # the palette's own 2px surface-gap spec, between segments
    for key in ("missing", "unclear", "present"):  # most-attention-first
        n = counts.get(key, 0)
        if n <= 0:
            continue
        _, color, _ = STATUS[key]
        length = (n / total) * circumference
        dash = max(0, length - gap)
        gap_len = circumference - dash
        dasharray = f"{dash} {gap_len}"
        if animate:
            i = len(segments)
            segments.append(
                f'<circle class="donut-seg" cx="{cx}" cy="{cy}" r="{r}" fill="none" '
                f'stroke="{color}" stroke-width="{stroke}" '
                f'stroke-dasharray="0 {circumference}" '
                f'stroke-dashoffset="{-offset}" transform="rotate(-90 {cx} {cy})" '
                f'data-dash="{dash}" data-gap="{gap_len}" '
                f'style="transition: stroke-dasharray 0.8s ease-out {0.15 * i}s;"/>'
            )
        else:
            segments.append(
                f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{color}" '
                f'stroke-width="{stroke}" stroke-dasharray="{dasharray}" '
                f'stroke-dashoffset="{-offset}" transform="rotate(-90 {cx} {cy})"/>'
            )
        offset += length
    pct_present = round(counts.get("present", 0) / total * 100)
    return (
        f'<svg viewBox="0 0 {size} {size}" width="{size}" height="{size}" '
        f'xmlns="http://www.w3.org/2000/svg">'
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{COLOR_GRIDLINE}" stroke-width="{stroke}"/>'
        + "".join(segments) +
        f'<text x="{cx}" y="{cy - 2}" text-anchor="middle" font-size="18" font-weight="600" '
        f'fill="{COLOR_INK_PRIMARY}">{pct_present}%</text>'
        f'<text x="{cx}" y="{cy + 14}" text-anchor="middle" font-size="7.5" '
        f'fill="{COLOR_INK_MUTED}">present</text></svg>'
    )


def _status_chip(status, label_prefix=""):
    icon, color, tint = STATUS.get(status, ("?", COLOR_INK_MUTED, COLOR_PAGE_PLANE))
    return (
        f'<span class="chip" style="background:{tint};border-left:3px solid {color};">'
        f'<span class="chip-icon" style="color:{color};">{icon}</span>'
        f'<span class="chip-label">{_esc(label_prefix)}{_esc(status)}</span></span>'
    )


def _bar_chart_svg(topic_counts, width=460, animate=False):
    """A single-series horizontal bar chart (issue count by topic) - one
    accent hue, no legend needed (one series - the section title already
    says what's plotted, per the palette's own labeling rule). Skipped
    entirely by the caller when there are no issues: a chart with zero
    bars isn't a chart, it's an empty box."""
    if not topic_counts:
        return ""
    items = topic_counts.most_common(8)
    max_count = max(c for _, c in items) or 1
    bar_h, gap, label_w = 18, 10, 190
    row_h = bar_h + gap
    chart_w = width - label_w - 30
    svg_h = row_h * len(items)
    rows = []
    for i, (topic, count) in enumerate(items):
        y = i * row_h
        w = max(6, round((count / max_count) * chart_w))
        label = topic if len(topic) <= 30 else topic[:28] + "…"
        if animate:
            rect = (
                f'<rect class="bar-fill" x="{label_w}" y="{y}" width="0" height="{bar_h}" '
                f'rx="4" ry="4" fill="{COLOR_ACCENT}" data-final-width="{w}" '
                f'style="transition: width 0.7s ease-out {0.08 * i}s;"/>'
            )
        else:
            rect = (
                f'<rect x="{label_w}" y="{y}" width="{w}" height="{bar_h}" rx="4" ry="4" '
                f'fill="{COLOR_ACCENT}"/>'
            )
        rows.append(
            f'<text x="0" y="{y + bar_h - 5}" font-size="9" fill="{COLOR_INK_SECONDARY}">'
            f'{_esc(label)}</text>'
            f'{rect}'
            f'<text x="{label_w + w + 6}" y="{y + bar_h - 5}" font-size="9" '
            f'fill="{COLOR_INK_SECONDARY}">{count}</text>'
        )
    return (
        f'<svg viewBox="0 0 {width} {svg_h}" width="{width}" height="{svg_h}" '
        f'xmlns="http://www.w3.org/2000/svg">{"".join(rows)}</svg>'
    )


def _animation_trigger_script():
    """Flips every animate=True donut segment / bar fill from its zero
    state to its real, already-correct final dasharray/width - see the
    "animate" branches in _status_donut_svg/_bar_chart_svg above for the
    values this reads. Vanilla JS, no framework: this HTML is served
    standalone (embedded via an <iframe>, see DocumentPanel.tsx's
    "report" view), it isn't part of the Next.js React tree."""
    return """<script>
(function () {
  function draw() {
    document.querySelectorAll(".donut-seg").forEach(function (el) {
      el.setAttribute("stroke-dasharray", el.dataset.dash + " " + el.dataset.gap);
    });
    document.querySelectorAll(".bar-fill").forEach(function (el) {
      el.setAttribute("width", el.dataset.finalWidth);
    });
  }
  requestAnimationFrame(function () { requestAnimationFrame(draw); });
})();
</script>"""


def _wrap_html(body_html, risk_icon, risk_color, risk_tint, animate=False):
    """The shared page shell (CSS + @page rules) for both the normal
    report and the assessment-failed report - factored out so the two
    bodies (render_html's two branches) don't have to duplicate the whole
    stylesheet."""
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Proposal Compliance Review</title>
<style>
  @page {{
    size: A4;
    margin: 2.6cm 1.8cm 2.2cm 1.8cm;
    @top-left {{ content: "Urban AI Assistant"; font-size: 8pt; color: {COLOR_INK_MUTED}; }}
    @top-right {{ content: "Proposal Compliance Review"; font-size: 8pt; color: {COLOR_INK_MUTED}; }}
    @bottom-left {{ content: "Automated first-pass review — not professional advice"; font-size: 7pt; color: {COLOR_INK_MUTED}; }}
    @bottom-right {{ content: "Page " counter(page) " of " counter(pages); font-size: 8pt; color: {COLOR_INK_MUTED}; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{
    font-family: {FONT_STACK};
    color: {COLOR_INK_PRIMARY};
    background: {COLOR_SURFACE};
    font-size: 10.5pt;
    line-height: 1.45;
  }}
  h1 {{ font-size: 20pt; margin: 0 0 4px 0; }}
  h2 {{ font-size: 13pt; margin: 26px 0 10px 0; border-bottom: 1px solid {COLOR_GRIDLINE}; padding-bottom: 4px; }}
  h2:first-of-type {{ margin-top: 4px; }}
  .subhead {{
    font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    color: {COLOR_INK_MUTED}; margin: 0 0 8px 0;
  }}
  .muted {{ color: {COLOR_INK_MUTED}; font-size: 9pt; }}
  .letterhead {{ border-bottom: 2px solid {COLOR_INK_PRIMARY}; padding-bottom: 12px; margin-bottom: 18px; }}
  .letterhead .meta {{ color: {COLOR_INK_SECONDARY}; font-size: 9.5pt; margin-top: 6px; }}
  .letterhead .meta-line {{ margin-top: 3px; }}
  .toc {{
    font-size: 8.5pt; color: {COLOR_INK_SECONDARY}; margin-bottom: 18px;
    padding: 7px 12px; background: {COLOR_PAGE_PLANE}; border: 1px solid {COLOR_BORDER}; border-radius: 4px;
  }}
  .toc strong {{ text-transform: uppercase; letter-spacing: 0.04em; font-size: 7.5pt; color: {COLOR_INK_MUTED}; margin-right: 8px; }}
  .toc a {{ color: {COLOR_ACCENT}; text-decoration: none; margin: 0 5px; font-weight: 600; }}
  .cite-link {{ color: {COLOR_ACCENT}; text-decoration: none; font-weight: 600; }}
  .donut-row {{
    display: flex; align-items: center; gap: 20px; margin-bottom: 18px;
    padding: 12px 16px; background: {COLOR_PAGE_PLANE}; border: 1px solid {COLOR_BORDER}; border-radius: 4px;
  }}
  .legend-item {{ display: block; font-size: 8.5pt; color: {COLOR_INK_SECONDARY}; margin-bottom: 6px; }}
  .legend-item:last-child {{ margin-bottom: 0; }}
  .legend-item b {{ font-weight: 700; }}
  .icon {{ vertical-align: -2px; margin-right: 3px; }}
  .disclaimer {{
    border: 1px solid {COLOR_BORDER}; background: {COLOR_PAGE_PLANE};
    border-left: 4px solid {COLOR_INK_SECONDARY}; padding: 11px 15px; font-size: 9pt;
    color: {COLOR_INK_SECONDARY}; margin-bottom: 18px; border-radius: 4px;
  }}
  .risk-badge {{
    display: block; background: {risk_tint}; border-left: 4px solid {risk_color};
    padding: 10px 16px; border-radius: 4px; margin-bottom: 16px;
  }}
  .risk-badge .risk-title {{ font-weight: 600; color: {COLOR_INK_PRIMARY}; }}
  .risk-badge .risk-icon {{ color: {risk_color}; font-weight: 700; margin-right: 6px; }}
  .risk-badge .risk-basis {{ font-size: 8.5pt; color: {COLOR_INK_MUTED}; }}
  .stat-row {{ display: flex; gap: 12px; margin-bottom: 18px; }}
  .stat-tile {{
    flex: 1; border: 1px solid {COLOR_BORDER}; border-left: 3px solid {COLOR_ACCENT}; border-radius: 4px;
    padding: 10px 12px; background: {COLOR_PAGE_PLANE};
  }}
  .stat-value {{ font-size: 17pt; font-weight: 600; line-height: 1.2; }}
  .stat-label {{ font-size: 8pt; color: {COLOR_INK_MUTED}; margin-top: 2px; }}
  .tag-row {{ margin-bottom: 18px; }}
  .tag {{
    display: inline-block; font-size: 8pt; color: {COLOR_INK_SECONDARY};
    border: 1px solid {COLOR_GRIDLINE}; border-radius: 10px; padding: 3px 10px;
    margin: 0 6px 6px 0; background: {COLOR_SURFACE};
  }}
  .tag svg {{ vertical-align: -1px; margin-right: 2px; }}
  .chart {{ margin: 8px 0 18px 0; }}
  .card {{
    border: 1px solid {COLOR_BORDER}; border-left: 3px solid {COLOR_ACCENT};
    border-radius: 4px; padding: 11px 14px; margin-bottom: 10px; background: {COLOR_PAGE_PLANE};
    break-inside: avoid; page-break-inside: avoid;
  }}
  .card-topic {{ font-weight: 600; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.03em; color: {COLOR_INK_SECONDARY}; margin-bottom: 5px; }}
  .card-body {{ margin: 5px 0 7px 0; }}
  .card-suggestion {{ font-size: 9.5pt; color: {COLOR_INK_SECONDARY}; padding-top: 7px; border-top: 1px solid {COLOR_GRIDLINE}; }}
  .card-verify {{ font-size: 8.5pt; margin-top: 7px; padding: 5px 8px; border-radius: 5px; }}
  .cite {{ color: {COLOR_INK_MUTED}; font-size: 8.5pt; }}
  .chip {{
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
    border-radius: 3px; font-size: 8.5pt; white-space: nowrap;
  }}
  .chip-icon {{ font-weight: 700; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 9pt; margin-bottom: 10px; }}
  thead {{ display: table-header-group; }}
  tr {{ break-inside: avoid; page-break-inside: avoid; }}
  th {{ text-align: left; font-size: 8pt; color: {COLOR_INK_MUTED}; border-bottom: 1px solid {COLOR_GRIDLINE}; padding: 6px 8px; }}
  td {{ border-bottom: 1px solid {COLOR_GRIDLINE}; padding: 7px 8px; vertical-align: top; }}
  .gallery {{ display: flex; flex-wrap: wrap; gap: 10px; }}
  .gallery-tile {{ width: 140px; margin: 0; overflow: hidden; }}
  .gallery-tile img {{ width: 140px; height: 100px; object-fit: cover; border: 1px solid {COLOR_BORDER}; border-radius: 3px; }}
  .gallery-tile figcaption {{
    font-size: 7.5pt; color: {COLOR_INK_MUTED}; margin-top: 4px;
    overflow-wrap: break-word; word-break: break-word;
  }}
</style>
</head>
<body>
{body_html}
{_animation_trigger_script() if animate else ""}
</body>
</html>"""


def render_html(result, document_names, images=None, animate=False):
    assessment = result.get("assessment") or {}
    failed = bool(result.get("assessment_failed"))
    citations = result.get("evidence_citations", [])
    images = images or []

    disclaimer_html = (
        f'<div class="disclaimer">{_esc(result["disclaimer"])}</div>'
        if result.get("disclaimer") else ""
    )
    citation_rows = "".join(
        f'<tr id="ev-{c["id"]}"><td>[{c["id"]}]</td><td>{_esc(c["doc"])}</td><td>{c["page"]}</td>'
        f'<td>{_esc(c["domain"])}</td><td>{_esc(c["geography"])}</td></tr>'
        for c in citations
    )

    if failed:
        # Neutral placeholders - the CSS below references risk_color/tint
        # unconditionally, but the failure body never renders .risk-badge,
        # so these values are never actually seen.
        risk_icon, risk_color, risk_tint = "", COLOR_INK_MUTED, COLOR_PAGE_PLANE
        topic_tags = "".join(
            f'<span class="tag">{_esc(t)}</span>' for t in (result.get("topics_checked") or [])
        )
        body_html = f"""
  <div class="letterhead">
    <h1>Proposal Compliance Review</h1>
    <div class="meta">
      <div class="meta-line">{_esc(', '.join(document_names))}</div>
      <div class="meta-line">Site: {_esc(result.get('geography') or '(unscoped)')}</div>
      {f'<div class="meta-line">{_esc(_site_detection_note(result))}</div>' if _site_detection_note(result) else ''}
      <div class="meta-line">Generated {_dt.date.today().isoformat()}</div>
    </div>
  </div>

  {disclaimer_html}

  <div class="disclaimer" style="border-left-color:{RISK_LEVELS['High'][1]};">
    <strong>Assessment generation failed - this is not a clean result.</strong><br>
    The model call that produces the issues and checklist did not return a usable
    answer, so neither is shown below. Retrieval succeeded; only the final write-up
    failed. Re-run the review.<br><br>
    {_esc(result.get('parse_error', ''))}
  </div>

  <div>{topic_tags}</div>

  <h2>Evidence retrieved</h2>
  <table>
    <thead><tr><th>#</th><th>Document</th><th>Page</th><th>Domain</th><th>Geography</th></tr></thead>
    <tbody>{citation_rows}</tbody>
  </table>
"""
        return _wrap_html(body_html, risk_icon, risk_color, risk_tint, animate=animate)

    issues = assessment.get("issues") or []
    checklist = assessment.get("checklist") or []
    level, basis, counts = _compute_risk(assessment)
    coverage = result.get("assessment_coverage") or {}
    evidence_confidence = result.get("evidence_confidence")
    compliance_status = result.get("compliance_status") or "final"
    # Points 1/2/5 of the 2026-09-28 reliability fix: a partial assessment
    # never gets to wear a Low/Medium/High badge - level/basis are
    # overridden to a distinct "Incomplete" state (see RISK_LEVELS' own
    # comment) whenever some excerpts couldn't be assessed, so the badge
    # itself can never be misread as a completed, definitive verdict.
    # counts (still real, from whatever WAS assessed) keeps flowing to the
    # stat tiles/donut below unchanged - only the top-level verdict label
    # changes, the underlying findings are not hidden.
    coverage_banner_html = ""
    if compliance_status == "incomplete":
        level = "Incomplete"
        basis = (
            f"only {coverage.get('assessed_units', 0)} of {coverage.get('total_units', 0)} "
            "document excerpt(s) could be assessed - this is not a final result"
        )
        coverage_banner_html = f"""
  <div class="disclaimer" style="border-left-color:{RISK_LEVELS['Incomplete'][1]};">
    <strong>Compliance result: Incomplete &mdash; this is not a final assessment.</strong><br>
    Only {coverage.get('assessed_units', 0)} of {coverage.get('total_units', 0)} document
    excerpt(s) could be assessed ({coverage.get('pct', 0)}% coverage). A checklist item marked
    "missing" below may simply be in a part of the document that wasn't assessed, not
    genuinely absent. Re-run the review for a complete, final result.
  </div>
"""
    risk_icon, risk_color, risk_tint = RISK_LEVELS[level]
    topic_counts = Counter(i.get("topic") or "Other" for i in issues)
    chart_svg = _bar_chart_svg(topic_counts, animate=animate)

    # Each tile borrows its color from the same fixed STATUS palette already used
    # by the donut and the checklist chips, so the overview panel reads as one
    # system - the label text still carries the meaning on its own (sentence
    # case, names exactly what's counted), so color is reinforcement, never the
    # only signal, same rule the chips already follow.
    stat_tile_specs = [
        ("Issues flagged", len(issues), COLOR_ACCENT, COLOR_ACCENT_TINT),
        ("Required items present", counts.get("present", 0), STATUS["present"][1], STATUS["present"][2]),
        ("Required items missing", counts.get("missing", 0), STATUS["missing"][1], STATUS["missing"][2]),
        ("Required items unclear", counts.get("unclear", 0), STATUS["unclear"][1], STATUS["unclear"][2]),
        # Assessment coverage (2026-09-28) - a genuinely separate metric
        # from the compliance counts above (see the module-level comment
        # on compliance_status), always shown, not only when incomplete -
        # a 100% tile is reassuring confirmation, not just a caveat.
        ("Assessment coverage", f"{coverage.get('pct', 100)}%", COLOR_ACCENT, COLOR_ACCENT_TINT),
    ]
    stat_tiles = "".join(
        f'<div class="stat-tile" style="border-left-color:{color};background:{tint};">'
        f'<div class="stat-value">{v}</div>'
        f'<div class="stat-label">{_esc(l)}</div></div>'
        for l, v, color, tint in stat_tile_specs
    )

    topic_tags = "".join(
        f'<span class="tag">{_topic_icon_svg(t)} {_esc(t)}</span>'
        for t in (result.get("topics_checked") or [])
    )
    topics_section = (
        f'<div class="tag-row"><div class="subhead">Topics checked</div>{topic_tags}</div>'
        if topic_tags else ""
    )

    issue_cards = "".join(
        f'<div class="card">'
        f'<div class="card-topic">{_topic_icon_svg(issue.get("topic", ""), color=COLOR_ACCENT)} '
        f'{_esc(issue.get("topic", ""))}</div>'
        f'<div class="card-body">{_linkify(issue.get("issue", ""))}</div>'
        f'<div class="card-suggestion"><strong>Suggested change:</strong> '
        f'{_esc(issue.get("suggested_change", ""))}</div>'
        f'{_verification_badge_html(issue)}'
        f'</div>'
        for issue in issues
    ) or '<p class="muted">No specific issues flagged.</p>'

    checklist_rows = "".join(
        f'<tr><td>{_status_chip(item.get("status", "unclear"))}</td>'
        f'<td>{_esc(item.get("item", ""))}</td>'
        f'<td>{_linkify(item.get("note", ""))}</td>'
        f'<td class="cite">{" ".join(f"[{c}]" for c in item.get("citations", []))}</td></tr>'
        for item in checklist
    )

    donut_svg = _status_donut_svg(counts, animate=animate)
    donut_section = ""
    if donut_svg:
        legend = "".join(
            f'<span class="legend-item"><b style="color:{STATUS[k][1]};">{STATUS[k][0]}</b> '
            f'{_esc(k)} &mdash; {counts.get(k, 0)}</span>'
            for k in ("missing", "unclear", "present") if counts.get(k, 0) > 0
        )
        donut_section = (
            f'<div class="donut-row"><div>{donut_svg}</div>'
            f'<div><div class="stat-label" style="margin-bottom:4px;">Checklist status</div>'
            f'{legend}</div></div>'
        )

    gallery = ""
    if images:
        # Real uploaded filenames can be long and ugly (a browser-derived
        # download name, a full URL with slashes swapped for colons, etc.)
        # - repeating one verbatim under every single thumbnail (the
        # common case: one proposal PDF, several extracted photos) both
        # crowds each 140px tile (see the CSS's overflow-wrap fix for
        # when it still happens) and is pure restated noise once the
        # reader already knows which document this is. Caption with just
        # the page number when every image comes from the same document
        # (naming it once, in the section intro, instead) and fall back
        # to a short per-tile document name only when the images actually
        # come from more than one document, where the distinction is
        # information rather than repetition.
        distinct_docs = sorted({img["doc"] for img in images})
        single_doc = distinct_docs[0] if len(distinct_docs) == 1 else None

        def _caption(img):
            if single_doc:
                return f"Page {img['page']}"
            name = img["doc"]
            short = name if len(name) <= 40 else name[:38] + "…"
            return f"{_esc(short)} — page {img['page']}"

        tiles = "".join(
            f'<figure class="gallery-tile">'
            f'<img src="data:image/{img["ext"]};base64,{img["b64"]}"/>'
            f'<figcaption>{_caption(img)}</figcaption>'
            f'</figure>'
            for img in images
        )
        intro = "Shown for reference only - not analyzed by this tool."
        if single_doc:
            intro += f" From {_esc(single_doc)}."
        gallery = (
            '<h2 id="gallery">Images from the proposal</h2>'
            f'<p class="muted">{intro}</p>'
            f'<div class="gallery">{tiles}</div>'
        )

    notes = []
    if evidence_confidence:
        notes.append(f"Evidence/grounding confidence for this review: {evidence_confidence}.")
    if result.get("topics_failed"):
        notes.append(
            "Topics that failed to retrieve and were skipped: "
            + ", ".join(result["topics_failed"])
        )
    if result.get("proposal_truncated"):
        notes.append("Proposal text was truncated to fit the assessment call.")
    if result.get("parse_error"):
        notes.append(result["parse_error"])
    notes_html = "".join(f'<p class="muted">Note: {_esc(n)}</p>' for n in notes)

    chart_section = (
        f'<div class="subhead">Issues by topic</div><div class="chart">{chart_svg}</div>' if chart_svg else ""
    )

    body_html = f"""
  <div class="letterhead">
    <h1>Proposal Compliance Review</h1>
    <div class="meta">
      <div class="meta-line">{_esc(', '.join(document_names))}</div>
      <div class="meta-line">Site: {_esc(result.get('geography') or '(unscoped)')}{f' &middot; {_esc(result["constraint_summary"])}' if result.get('constraint_summary') else ''}</div>
      {f'<div class="meta-line">{_esc(_site_detection_note(result))}</div>' if _site_detection_note(result) else ''}
      <div class="meta-line">Generated {_dt.date.today().isoformat()}</div>
    </div>
  </div>

  {disclaimer_html}
  {coverage_banner_html}

  <div class="toc">
    <strong>Contents</strong>
    <a href="#overview">Overview</a> &middot;
    <a href="#summary">Summary</a> &middot;
    <a href="#issues">Issues</a> &middot;
    <a href="#checklist">Checklist</a> &middot;
    {'<a href="#gallery">Images</a> &middot; ' if gallery else ''}
    <a href="#evidence">Evidence</a>
  </div>

  <h2 id="overview">Overview</h2>

  <div class="risk-badge">
    <span class="risk-icon">{risk_icon}</span>
    <span class="risk-title">Overall attention needed: {level}</span><br>
    <span class="risk-basis">{_esc(basis)}</span>
  </div>

  <div class="stat-row">{stat_tiles}</div>

  {donut_section}

  {topics_section}

  {notes_html}

  <h2 id="summary">Summary</h2>
  <p>{_linkify(assessment.get('summary', ''))}</p>

  <h2 id="issues">Issues ({len(issues)})</h2>
  {chart_section}
  {issue_cards}

  <h2 id="checklist">Required content checklist ({len(checklist)})</h2>
  <table>
    <thead><tr><th>Status</th><th>Item</th><th>Note</th><th>Citations</th></tr></thead>
    <tbody>{checklist_rows or '<tr><td colspan="4" class="muted">No checklist could be built.</td></tr>'}</tbody>
  </table>

  {gallery}

  <h2 id="evidence">Evidence cited</h2>
  <table>
    <thead><tr><th>#</th><th>Document</th><th>Page</th><th>Domain</th><th>Geography</th></tr></thead>
    <tbody>{citation_rows}</tbody>
  </table>
"""
    return _wrap_html(body_html, risk_icon, risk_color, risk_tint, animate=animate)


def render_pdf_bytes(html_str):
    from weasyprint import HTML
    return HTML(string=html_str).write_pdf()


# --------------------------------------------------------------------------
# Image extraction (PyMuPDF - already a dependency, see map_images.py)
# --------------------------------------------------------------------------

def extract_report_images(pdf_paths, max_images=6, min_dim=180):
    """Pulls embedded images (site photos, elevations) out of the proposal
    PDF(s) for the report's image gallery - shown for reference only, never
    analyzed. Filters out anything smaller than min_dim on either side so
    logos/icons/page furniture don't crowd out real photos. Best-effort: a
    PDF that fails to open, or an individual image that fails to decode, is
    just skipped rather than failing the whole report."""
    import fitz

    images = []
    for path in pdf_paths:
        if len(images) >= max_images:
            break
        try:
            doc = fitz.open(str(path))
        except Exception:
            continue
        try:
            for page_index in range(len(doc)):
                if len(images) >= max_images:
                    break
                page = doc[page_index]
                for img in page.get_images(full=True):
                    if len(images) >= max_images:
                        break
                    xref = img[0]
                    try:
                        base = doc.extract_image(xref)
                    except Exception:
                        continue
                    w, h = base.get("width", 0), base.get("height", 0)
                    if w < min_dim or h < min_dim:
                        continue
                    img_bytes, ext = base["image"], base.get("ext", "png")
                    try:
                        from PIL import Image
                        pil_img = Image.open(BytesIO(img_bytes)).convert("RGB")
                        buf = BytesIO()
                        pil_img.save(buf, format="PNG")
                        img_bytes, ext = buf.getvalue(), "png"
                    except Exception:
                        pass
                    images.append({
                        "b64": base64.b64encode(img_bytes).decode("ascii"),
                        "ext": ext,
                        "page": page_index + 1,
                        "doc": Path(path).name,
                    })
        finally:
            doc.close()
    return images


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------

def build_reports(result, document_names, pdf_paths=None):
    """Runs all renderers for a successful review_proposal() result.
    Returns {"markdown": str, "pdf_bytes": bytes, "pdf_error": str|None,
    "live_html": str|None, "live_html_error": str|None}.
    A PDF failure (e.g. WeasyPrint not installed) never blocks the
    Markdown report - the caller still gets that back with pdf_error set.
    Same independence for live_html (added 2026-09-21, "animated report
    visuals"): it's rendered from its own render_html(animate=True) call,
    wrapped in its own try/except, so neither can take the other down -
    a WeasyPrint failure doesn't lose the live view and vice versa."""
    markdown = render_markdown(result, document_names)
    images = extract_report_images(pdf_paths) if pdf_paths else []

    pdf_bytes, pdf_error = None, None
    try:
        pdf_html_str = render_html(result, document_names, images, animate=False)
        pdf_bytes = render_pdf_bytes(pdf_html_str)
    except Exception as e:
        pdf_error = f"PDF rendering failed ({e}); the Markdown report is still available."

    live_html, live_html_error = None, None
    try:
        live_html = render_html(result, document_names, images, animate=True)
    except Exception as e:
        live_html_error = f"Live report view rendering failed ({e})."

    return {
        "markdown": markdown,
        "pdf_bytes": pdf_bytes,
        "pdf_error": pdf_error,
        "live_html": live_html,
        "live_html_error": live_html_error,
    }
