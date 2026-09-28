"use client";

// components/chat/DocumentPanel.tsx
//
// A Claude-artifact-style side panel for previewing a generated document
// next to the chat, with a page-by-page PDF preview and a download
// action, instead of the file only existing as a path on disk. Added
// 2026-09-19 per explicit request: "I want this exact similar format of
// UI where the user can open the pdfs documents that are generated in
// the side and he/she will get option to download."
//
// Added 2026-09-23: live, in-place clause/paragraph editing via chat -
// first version gave this panel THREE views (PDF = the generated
// compliance report, "Report view" = an animated HTML rendering of that
// same report, "Document" = a plain-text, paragraph-numbered rendering
// of the uploaded document, the only one that was actually editable).
//
// Rewritten the same day, second pass, per explicit follow-up: "I want
// it to be updated in the PDF and I dont want 3 views so basically if
// the report is generated based on the documents that I upload then
// that is shown in the view and that can be edited." At the time this
// was read as "show the uploaded document as the one view" - WRONG, per
// repeated follow-up confusion ("you are still returning me the original
// document not the suggestion report"). Re-read literally: "that" refers
// to the REPORT, not the document - "if the report is generated... then
// THAT is shown in the view."
//
// Rewritten again 2026-09-23, FIFTH pass - this is the corrected one.
// `url`/`filename` is now the GENERATED COMPLIANCE REPORT
// (report_render.py's build_reports(), proxied through reportFiles in
// ChatInterface.tsx's runProposalReview) - the single main view, and
// explicitly confirmed with the user as READ-ONLY (not paragraph-
// editable - it's a generated analysis, not something you'd hand-edit).
// `documentUrl`/`documentFilename` is the uploaded document itself -
// demoted to a small secondary download button, still live-editable via
// chat (see ChatInterface.tsx's runDocumentEdit/looksLikeEditInstruction
// - those still operate on it through the panel's docId), it's just no
// longer what's rendered in the main PDF view. There's no highlight/
// flash-on-edit behavior any more (previous passes had one) since the
// thing being edited isn't the thing on screen.
//
// Added 2026-09-24, per explicit request: "I also want the option on the
// right hand side where I can get the option to hide and unhide the
// preview of the generated document." A collapse/expand toggle
// (isCollapsed/onToggleCollapse, owned by ChatInterface.tsx) - separate
// from `onClose` (which discards the panel/report entirely) and from
// `isExpanded` below (which is this same panel's OWN docked-vs-fullscreen
// width toggle, an unrelated, pre-existing feature - don't confuse the
// two). Collapsing shrinks this panel to a thin icon rail on the right
// edge, mirroring ConversationSidebar.tsx's existing collapsed-rail
// pattern for the LEFT sidebar (same PanelIcon glyph, same "keep both
// states mounted, toggle visibility with CSS" approach) rather than
// inventing a new interaction - and critically, collapsing does NOT
// unmount the <Document>/<Page> tree below, so pdfjs never has to
// re-fetch/re-render the PDF (and scroll position survives) when you
// bring it back.
//
// react-pdf + pdfjs-dist were already project dependencies (package.json).
//
// Added 2026-09-25, inline-block-editing milestone: a second, NEW tab -
// "Document" alongside the existing "Report" - that renders `documentUrl`
// (the uploaded/editable document, previously only a small secondary
// download button and a non-selectable thumbnail inside EditingBlockCard)
// as a real, continuously-scrollable, text-selectable PDF, same as the
// report already was. This is the "interactive document view" the product
// owner's brief asks for, explicitly NOT the report's own PDF canvas
// ("don't touch the PDF preview, just refresh it after a patch is
// applied" - the report view's own code below is untouched by this pass).
// Selecting text inside it resolves to a specific block (via the block
// bboxes GET /documents/{doc_id} already returns, now fetched by
// ChatInterface.tsx into `documentParagraphs`) and shows a small floating
// AI command box near the selection - see InteractiveDocumentView below
// for the whole flow. Kept entirely additive: the Report tab (default,
// unchanged) still works exactly as it did before this pass, and this
// new path uses its OWN state/handlers (blockEditState, onSubmitBlock-
// Instruction, etc.) rather than EditingBlockCard's existing chat-driven
// ones - "keep chat edits as a separate path," per the brief.

import { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { BorderBeam } from "border-beam";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { FloatingComposerShell } from "@/components/chat/FloatingComposerShell";
import { Z } from "@/components/chat/zIndex";

// Required by react-pdf/pdfjs so page rendering doesn't block the main
// thread. Deliberately NOT `new URL("pdfjs-dist/...", import.meta.url)` -
// that asks webpack to bundle the worker .mjs as an asset module, which
// is one contributor to a known pdfjs-dist/webpack ESM-interop crash
// ("TypeError: Object.defineProperty called on non-object" / "Properties
// can only be defined on Objects") - copying the worker to public/ (see
// package.json's copy-pdf-worker script, wired into predev/prebuild) and
// pointing workerSrc at a plain runtime string path avoids that.
//
// That alone wasn't the full story: the SAME crash also came from react-
// pdf's own internal `import * as pdfjs from "pdfjs-dist"`
// (node_modules/react-pdf/dist/index.js) pulling in pdfjs-dist 5.x's
// *main* build, independent of the worker. Three fix attempts against the
// pdfjs-dist 5.x line all failed even though each was confirmed to
// actually take effect: a next.config.js webpack.resolve.alias to
// pdfjs-dist's "legacy" build (the workaround documented in
// https://github.com/mozilla/pdf.js/issues/17228 - that issue itself
// notes the legacy build stopped protecting against this in some
// versions), and a package.json "overrides" pin to pdfjs-dist 5.4.394
// (the version reported safe in
// https://github.com/mozilla/pdf.js/issues/20478 - but that report was
// under Next.js 16's webpack, not this project's Next.js 14.2.35, so the
// "safe version" data point apparently didn't transfer).
//
// The fix that actually worked: downgrading react-pdf itself from 10.x to
// 9.2.1, which depends on pdfjs-dist 4.8.69 - an older, structurally
// different build (pre-dates the webpack/ESM top-level-await interop
// pattern that causes the crash in pdfjs-dist 5.x). package.json's
// "overrides" still pins pdfjs-dist to 4.8.69 as a safety net against
// dedupe drift, but it now matches what react-pdf 9.2.1 already declares,
// rather than fighting it. Don't bump react-pdf back to 10.x (or bump
// pdfjs-dist independently) without re-verifying against the issues
// above - 5.x's crash is real and still open upstream.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const XIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const DownloadIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

// The bar-chart glyph now marks the PRIMARY (report) download instead of
// the secondary one, since the report is now the main thing this panel
// shows - kept as a distinct glyph from FileIcon/DownloadIcon so the two
// buttons still read as "two different files" at a glance, same
// reasoning as when this was added 2026-09-23, fourth pass (just applied
// to the swapped roles now).
const ReportIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 17V11M12 17V7M16 17v-4" />
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </svg>
);

const ExpandIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m11-5v3a2 2 0 0 0-2 2h-3" />
  </svg>
);

const CollapseIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M9 3v4a2 2 0 0 1-2 2H3m18 0h-4a2 2 0 0 1-2-2V3M3 15h4a2 2 0 0 1 2 2v4m10-4v4a2 2 0 0 1-2 2h-4" />
  </svg>
);

const FileIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

// A little panel-with-a-divider glyph, the common "toggle panel" mark -
// same shape ConversationSidebar.tsx already uses for its own collapse
// toggle (kept as a plain local copy rather than a shared import, since
// neither file currently exports its icon set - matches this file's own
// existing pattern of defining every icon it needs locally). Rotates
// 180deg via the caller when collapsed, so one icon covers both
// directions instead of swapping between two.
const PanelIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M15 4v16" />
  </svg>
);

export interface DocumentBlock {
  id: number;
  page: number;
  bbox: [number, number, number, number];
  text: string;
}

export interface DocumentPanelProps {
  /**
   * Absolute URL of the generated compliance report's PDF
   * (report_render.py's build_reports(), see ChatInterface.tsx's
   * runProposalReview) - this is now the MAIN view. Read-only: the
   * report is a generated analysis, not something edited paragraph by
   * paragraph in place.
   */
  url: string;
  /** Display name for the report, e.g. "bassetlaw-2026-09-23.pdf". */
  filename: string;
  /**
   * The uploaded document's own (live-regenerated) PDF - a completely
   * different file from `url` above (that's the analysis built FROM
   * this; this is the actual proposal document). Secondary download
   * only - see the module docstring for why it's not the main view any
   * more. Still reflects chat-driven edits (a fresh, already-versioned
   * URL lands here after each one - see ChatInterface.tsx's
   * runDocumentEdit). Optional: only set when the document could be
   * persisted server-side. Also (2026-09-25) the file rendered by the
   * new "Document" tab's InteractiveDocumentView below.
   */
  documentUrl?: string;
  documentFilename?: string;
  onClose: () => void;
  /**
   * Hide/unhide toggle (added 2026-09-24) - distinct from onClose. State
   * lives in ChatInterface.tsx (isDocumentPanelCollapsed) so it survives
   * this component staying mounted either way. See the module docstring
   * above for why collapsing never unmounts the PDF preview.
   */
  isCollapsed: boolean;
  onToggleCollapse: () => void;

  /**
   * Docked-vs-fullscreen width toggle (isExpanded) and the active
   * Report/Document tab (viewMode) - lifted to ChatInterface.tsx
   * 2026-09-27 (fullscreen-composer-interactivity fix pass, item 4:
   * "preserve panel state... do not reset the panel just because another
   * component rerenders"). Previously local useState inside this
   * component, which meant any remount silently reset both back to
   * defaults. Distinct from isCollapsed/onToggleCollapse above, an
   * older, separate toggle - don't confuse the two (see the module
   * docstring's own note on this).
   */
  isExpanded: boolean;
  onToggleExpanded: () => void;
  viewMode: "report" | "document";
  onViewModeChange: (mode: "report" | "document") => void;

  /**
   * Alternatives-before-replace editing state (2026-09-25, architecture
   * plan section 53 Phase 2/3 - see ChatInterface.tsx's runProposeEdit()
   * block for the full flow). When set, renders a small "editing this
   * paragraph" card - see EditingBlockCard below - that shows just the
   * ONE page the target block is on (from `documentUrl`, not the report
   * `url`), a highlight over its exact bbox, a skeleton shimmer while
   * resolving, and the three alternatives once ready. Never replaces or
   * hides the report view below it; it's a distinct, small region of its
   * own so "the whole document stays visible." This is the ORIGINAL
   * CHAT-DRIVEN edit path - kept completely separate from the new
   * selection-driven `blockEditState` below, per the "keep chat edits as
   * a separate path" instruction.
   */
  editState?: {
    status: "resolving" | "choosing" | "applying" | "applied" | "error";
    docId: string;
    instruction: string;
    patchId?: string;
    paragraphId?: number;
    page?: number;
    bbox?: [number, number, number, number];
    originalText?: string;
    matchedIssueTopic?: string | null;
    matchedIssueText?: string | null;
    alternatives?: { index: number; label: string; text: string; rationale?: string }[];
    baseDocVersion?: number;
    previousRevisionId?: string | null;
    errorMessage?: string;
  } | null;
  onChooseAlternative?: (index: number) => void;
  onRejectEdit?: () => void;
  onUndoEdit?: () => void;
  onDismissEdit?: () => void;

  /**
   * The uploaded document's own blocks (GET /documents/{doc_id}'s
   * `paragraphs`, fetched once by ChatInterface.tsx when this panel
   * opens) - id/page/bbox/text for every paragraph, in reading order.
   * This is the index InteractiveDocumentView uses to resolve an
   * arbitrary text selection back to a specific block. Undefined until
   * that fetch resolves (or if it fails) - the Document tab simply can't
   * resolve selections yet in that case, see InteractiveDocumentView.
   */
  documentParagraphs?: DocumentBlock[];
  /**
   * Selection-driven editing state (2026-09-25 inline-block-editing
   * milestone) - the NEW path's own counterpart to `editState` above,
   * intentionally a separate prop/type rather than reusing it. Drives
   * the in-place border-beam/skeleton overlay AND the alternatives/
   * exact-replacement popover rendered directly over the target block
   * inside InteractiveDocumentView, instead of a side card.
   */
  blockEditState?: {
    status: "resolving" | "choosing" | "applying" | "applied" | "error";
    paragraphId: number;
    page: number;
    bbox: [number, number, number, number];
    instruction: string;
    selectedText: string;
    patchId?: string;
    originalText?: string;
    alternatives?: { index: number; label: string; text: string; rationale?: string }[];
    isExactReplacement?: boolean;
    baseDocVersion?: number;
    previousRevisionId?: string | null;
    errorMessage?: string;
  } | null;
  /** User selected text in a block and pressed Enter in the floating command box - never mutates text itself, just submits the instruction. */
  onSubmitBlockInstruction?: (target: { paragraphId: number; page: number; bbox: [number, number, number, number]; selectedText: string; parentText: string }, instruction: string) => void;
  onChooseBlockAlternative?: (index: number) => void;
  onRejectBlockEdit?: () => void;
  onUndoBlockEdit?: () => void;
  onDismissBlockEdit?: () => void;

  /**
   * Report-block editing (2026-09-25, CORRECTION to the inline-editing
   * milestone: the editable object is the AI-GENERATED report, not the
   * uploaded source - `documentUrl`/`blockEditState` above stay exactly
   * as they were, just no longer wired into the Document tab's UI, see
   * the module docstring's 2026-09-25 update below). `assessment` is the
   * same {summary, issues, checklist} shape the chat bubble's
   * ReviewSummaryChart already renders (ChatInterface.tsx), just shown
   * here in FULL (not truncated to top-N) and with each editable prose
   * unit selectable. `reportBlocks` is the role map GET/POST .../
   * proposal-review already returns (report_doc_id's local_ids) - what
   * StructuredReportView below uses to know which rendered node maps to
   * which local_id, exactly like `documentParagraphs` does for the old
   * PDF-bbox approach, just for real DOM instead.
   */
  assessment?: { summary?: string | null; issues?: any[]; checklist?: any[] } | null;
  reportGeography?: string | null;
  reportConstraintSummary?: string | null;
  reportBlocks?: { localId: number; kind: string; index: number | null }[];
  reportBlockEditState?: {
    status: "resolving" | "choosing" | "applying" | "applied" | "error";
    localId: number;
    kind: string;
    index: number | null;
    instruction: string;
    selectedText: string;
    patchId?: string;
    originalText?: string;
    alternatives?: { index: number; label: string; text: string; rationale?: string }[];
    isExactReplacement?: boolean;
    baseDocVersion?: number;
    previousRevisionId?: string | null;
    errorMessage?: string;
    // Added 2026-09-26, six-area Report-tab polish pass: the "Custom"
    // refinement box's own sub-state. customPreviewIndex points at an
    // alternative (already appended to `alternatives` above) that was
    // just generated by a refinement instruction and is awaiting its
    // own Apply/Back decision, kept separate from the plain 3-option
    // list per the brief ("show the refined result... before changing
    // the report").
    customLoading?: boolean;
    customError?: string | null;
    customPreviewIndex?: number | null;
  } | null;
  onSubmitReportInstruction?: (target: { localId: number; kind: string; index: number | null; selectedText: string; parentText: string }, instruction: string) => void;
  onChooseReportAlternative?: (index: number) => void;
  onRejectReportEdit?: () => void;
  onUndoReportEdit?: () => void;
  onDismissReportEdit?: () => void;
  // Added 2026-09-26: the "Custom" refinement box's own submit/back
  // actions, kept distinct from onSubmitReportInstruction (which starts
  // a brand new propose-edit cycle) - refinement operates over an
  // ALREADY-open patch's own alternatives, never a blank replacement.
  onRefineReportEdit?: (instruction: string) => void;
  onBackFromReportCustomPreview?: () => void;
  // Persistent, timeout-independent undo/redo (2026-09-26) - a real
  // pointer walked over actually-stored revision ids (never LLM
  // reconstruction), keyed by report block localId, independent of
  // reportBlockEditState's own lifecycle so Undo survives long after
  // the transient "Updated" badge/overlay has closed. See
  // ChatInterface.tsx's reportUndoStacks for how the stack is built.
  reportUndoStacks?: Record<number, { revisionIds: string[]; pointer: number }>;
  reportUndoErrors?: Record<number, string | null>;
  onUndoReportBlock?: (localId: number) => void;
  onRedoReportBlock?: (localId: number) => void;
}

// Fixed status palette for the Report tab's checklist rows - same values
// as local-rag/report_render.py's own STATUS dict (kept in sync by eye,
// not imported - this is a small, stable, print-report-matching palette,
// not something that changes independently on either side).
const REPORT_STATUS_COLORS: Record<string, string> = {
  present: "#0ca30c",
  missing: "#d03b3b",
  unclear: "#fab219",
};
const REPORT_STATUS_ICON: Record<string, string> = {
  present: "✓",
  missing: "✗",
  unclear: "!",
};

// Fixed small width for the single-page preview inside EditingBlockCard -
// deliberately much narrower than the main report's pageWidth (this is a
// "which paragraph, roughly where" reference, not a reading view; the
// alternatives' actual text is what the user reads and compares).
const EDIT_PREVIEW_WIDTH = 220;

// Cycling widths for the skeleton placeholder's text bars, so a longer
// paragraph (more lines) doesn't read as a rigid, identical-width stack -
// same "roughly like real justified text" idea as the border-beam demo's
// own skeleton. See SKELETON_LINE_HEIGHT_PX below for how line COUNT is
// derived from the block's own measured height.
const SKELETON_WIDTHS = ["92%", "97%", "78%", "88%", "94%", "82%"];
// Rough px-per-line (bar height + the gap-2/py-1 spacing around it) used
// only to turn a measured pixel height back into "about this many lines" -
// doesn't need to be exact, just proportionate.
const SKELETON_LINE_HEIGHT_PX = 20;

// Added 2026-09-25 alongside the BorderBeam integration below, per explicit
// request: "respect @media (prefers-reduced-motion: reduce)... disable the
// animated beam and show a static border instead." border-beam's pulse
// types auto-disable under reduced motion, but its rotate family (which
// `size="line"` belongs to) only does so "when implemented by the
// consumer" per its own README - so this is that implementation, read
// once on mount and kept live via the media query's own change event
// (covers a user toggling the OS setting without reloading the tab).
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const listener = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);
  return reduced;
}

/**
 * The "editing this paragraph" card - DocumentPanel's Phase 3 UI per the
 * product owner's explicit brief: "keep the whole document visible and
 * highlight just that clause... skeleton text shimmer and a small status
 * like generating alternatives... keep the block height stable... on
 * apply, show a brief applying revision state... then a soft updated
 * badge... if it fails, revert instantly... make it feel like the AI is
 * working on that exact paragraph, not the whole app."
 *
 * One honest adaptation from that brief, noted rather than silently
 * dropped: propose-edit resolves the target paragraph AND generates the
 * three alternatives in a single backend call (one retrieval + one model
 * call, cheaper - see document_edit.propose_edit()) rather than two
 * separate steps, so there's no moment where the real block is already
 * highlighted but alternatives are still generating - during "resolving"
 * this card shows a generic shimmer placeholder (no bbox is known yet),
 * and the real highlighted page + ready alternatives appear together the
 * instant the response arrives.
 *
 * Added 2026-09-25, same day: a `border-beam` (npm) BorderBeam wrapping
 * the preview box - active only while `isBusy` (resolving/applying),
 * mono/line/light per explicit request ("restrained and neutral"
 * interface), off outright under `prefers-reduced-motion` in favor of a
 * plain static border (border-beam's rotate family, which `size="line"`
 * belongs to, doesn't auto-disable under reduced motion the way its
 * pulse family does - see usePrefersReducedMotion above). Also: the
 * skeleton placeholder's height/line-count now tracks the LAST real page
 * height this card measured (`lastBlockHeight`) instead of a fixed 140px/
 * 3-lines guess, so a second edit in the same session doesn't visibly
 * collapse the block before the new page loads. This is presentation
 * only - it never reads or writes patch/edit state, only `editState`.
 *
 * This is the CHAT-DRIVEN path's own card - unchanged by the 2026-09-25
 * inline-block-editing milestone below. See InteractiveDocumentView for
 * that milestone's separate, in-place equivalent.
 */
function EditingBlockCard({
  editState,
  documentUrl,
  onChooseAlternative,
  onRejectEdit,
  onUndoEdit,
  onDismissEdit,
}: {
  editState: NonNullable<DocumentPanelProps["editState"]>;
  documentUrl?: string;
  onChooseAlternative?: (index: number) => void;
  onRejectEdit?: () => void;
  onUndoEdit?: () => void;
  onDismissEdit?: () => void;
}) {
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  // Reset the captured native page size whenever we move to a different
  // page/paragraph, so a stale scale factor from a previous edit can
  // never mis-position this edit's highlight for one render.
  useEffect(() => {
    setPageSize(null);
  }, [editState.page, editState.paragraphId]);

  const prefersReducedMotion = usePrefersReducedMotion();

  // Last known rendered height of the preview box, in px - seeded at the
  // original 140px guess, then kept up to date every time a real page
  // finishes loading (derived from its own aspect ratio at our fixed
  // EDIT_PREVIEW_WIDTH, not a DOM measurement, so it can't get fed back
  // the skeleton's own placeholder height while busy). "Keep the block
  // height stable" / "preserve block height during generation."
  const [lastBlockHeight, setLastBlockHeight] = useState(140);
  useEffect(() => {
    if (!pageSize) return;
    const h = Math.round((EDIT_PREVIEW_WIDTH * pageSize.height) / pageSize.width);
    if (h > 0) setLastBlockHeight(h);
  }, [pageSize]);

  const hasBlock = editState.page != null && Array.isArray(editState.bbox);
  const scale = pageSize ? EDIT_PREVIEW_WIDTH / pageSize.width : null;
  const highlightStyle =
    scale && editState.bbox
      ? {
          left: editState.bbox[0] * scale,
          top: editState.bbox[1] * scale,
          width: Math.max(4, (editState.bbox[2] - editState.bbox[0]) * scale),
          height: Math.max(4, (editState.bbox[3] - editState.bbox[1]) * scale),
        }
      : null;

  const isBusy = editState.status === "resolving" || editState.status === "applying";
  const showStaticBorder = isBusy && prefersReducedMotion;
  const skeletonLineCount = Math.min(8, Math.max(2, Math.round(lastBlockHeight / SKELETON_LINE_HEIGHT_PX)));

  return (
    <div className="rise border-b border-[var(--rule)] bg-[var(--paper-sunken)] px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--ink-muted)]">
          {editState.status === "resolving" && "Finding the right paragraph…"}
          {editState.status === "choosing" && `Editing paragraph ${editState.paragraphId}`}
          {editState.status === "applying" && "Applying revision…"}
          {editState.status === "applied" && "Updated"}
          {editState.status === "error" && "Editing paragraph"}
        </p>
        {editState.status === "applied" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            ✓ Updated
          </span>
        ) : (
          onDismissEdit && (
            <button
              type="button"
              onClick={onDismissEdit}
              className="text-[11px] text-[var(--ink-faint)] transition hover:text-[var(--ink-secondary)]"
            >
              Dismiss
            </button>
          )
        )}
      </div>

      <div className="flex gap-3">
        {/* The single target page, small, with a highlight over the exact
            block bbox - "highlight just that clause," "keep the block
            height stable" (min-height tracks lastBlockHeight, the last
            real page height this card measured, so nothing collapses
            when the shimmer swaps back in for a second edit).
            2026-09-27 (skills-informed polish pass): this used to wrap
            in a rotating mono BorderBeam - the same "moving beam around a
            block of text reads as a random effect" treatment the Report
            tab's own BlockGeneratingBeam deliberately dropped in favor of
            a settled border + the shared `.skeleton-line` shimmer (see
            that component's docstring above). This card is the chat-
            driven path's equivalent surface, so it gets the same calmer
            treatment rather than keeping a second, older loading style
            alive side by side with it. */}
        <div
          className={
            "relative shrink-0 overflow-hidden rounded-xl border bg-[var(--paper)] transition-colors duration-200 ease-settle " +
            (showStaticBorder ? "border-[var(--rule-strong)]" : "border-[var(--rule)]")
          }
          style={{ width: EDIT_PREVIEW_WIDTH, minHeight: lastBlockHeight }}
        >
          {hasBlock && documentUrl ? (
            <Document file={documentUrl} loading={null} error={null}>
              <Page
                pageNumber={editState.page}
                width={EDIT_PREVIEW_WIDTH}
                renderAnnotationLayer={false}
                renderTextLayer={false}
                onLoadSuccess={(page: any) =>
                  setPageSize({ width: page.originalWidth, height: page.originalHeight })
                }
              />
            </Document>
          ) : (
            <div
              className="flex flex-col justify-center gap-2 p-3"
              style={{ minHeight: lastBlockHeight }}
            >
              {Array.from({ length: skeletonLineCount }, (_, i) => (
                <div
                  key={i}
                  className="skeleton-line h-2.5"
                  style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] }}
                />
              ))}
            </div>
          )}
          {/* Highlight box, drawn once we know the page's native size -
              a steady tinted outline over the block's own rectangle,
              pulsing gently while resolving/applying so it still reads
              as "the AI is working on that exact paragraph." */}
          {highlightStyle && (
            <div
              className={
                "pointer-events-none absolute rounded-sm border-2 border-amber-400/80 bg-amber-300/20 " +
                (isBusy && !prefersReducedMotion ? "animate-pulse" : "")
              }
              style={highlightStyle}
            />
          )}
          {/* Status label while resolving/applying, overlaid on top of
              the real page once one is mounted (or shown over the
              skeleton placeholder before that). */}
          {isBusy && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[var(--paper-raised)]/90 to-transparent px-2 pb-1.5 pt-4">
              <p className="text-[10px] font-medium text-[var(--ink-secondary)]">
                {editState.status === "resolving" ? "Generating alternatives…" : "Applying revision…"}
              </p>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* Compliance issue vs. actual source paragraph - kept as two
              visibly separate blocks, per explicit request: never
              conflate the review's own wording with the applicant's
              real text. */}
          {editState.matchedIssueTopic && (
            <div className="mb-1.5 rounded-xl border border-amber-200 bg-amber-50 px-2.5 py-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                Compliance issue — {editState.matchedIssueTopic}
              </p>
              {editState.matchedIssueText && (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-amber-800/90">
                  {editState.matchedIssueText}
                </p>
              )}
            </div>
          )}
          {editState.originalText && (
            <div className="mb-1.5 rounded-xl border border-[var(--rule)] bg-[var(--paper)] px-2.5 py-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                Original paragraph
              </p>
              <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ink-secondary)]">{editState.originalText}</p>
            </div>
          )}

          {editState.status === "error" && (
            <p className="mb-1.5 text-[11px] text-red-600">
              {editState.errorMessage || "Something went wrong applying that revision."}
            </p>
          )}

          {editState.status === "applied" ? (
            onUndoEdit && (
              <button
                type="button"
                onClick={onUndoEdit}
                className="press rounded-full border border-[var(--rule)] bg-[var(--paper)] px-2.5 py-1 text-[11px] font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--paper-sunken)]"
              >
                Undo
              </button>
            )
          ) : (
            <div className="space-y-1.5">
              {(editState.alternatives || []).map((alt) => (
                <button
                  key={alt.index}
                  type="button"
                  disabled={isBusy}
                  onClick={() => onChooseAlternative?.(alt.index)}
                  className="block w-full rounded-xl border border-[var(--rule)] bg-[var(--paper)] px-3 py-2 text-left transition-[border-color,background-color] duration-200 ease-settle hover:border-[var(--rule-strong)] hover:bg-[var(--paper-sunken)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                    {alt.label}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--ink-secondary)]">{alt.text}</p>
                </button>
              ))}
              {editState.status === "choosing" && onRejectEdit && (
                <button
                  type="button"
                  onClick={onRejectEdit}
                  className="text-[11px] text-[var(--ink-faint)] transition hover:text-[var(--ink-secondary)]"
                >
                  Keep original wording
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// "bassetlaw-2026-09-23" -> "Bassetlaw 2026 09 23" - a light title-case
// pass so the panel header doesn't just show a raw slug.
function humanizeTitle(filename: string): string {
  const base = filename.replace(/\.[^./]+$/, "");
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
}

// Finds which of `paragraphs` (all on `page`) the point (x, y) - in that
// page's OWN native PDF coordinate units, top-down, matching the bbox
// convention every other block-position calculation in this file already
// uses - falls inside. Falls back to the vertically-closest paragraph on
// that page if the point doesn't land inside any bbox exactly (selection
// rects from the browser's real text layer are occasionally a few px off
// a block's own recorded bbox, e.g. at a paragraph's very first/last
// line) - never returns null for a page that has at least one paragraph.
function resolveBlockAtPoint(paragraphs: DocumentBlock[], page: number, x: number, y: number): DocumentBlock | null {
  const onPage = paragraphs.filter((p) => p.page === page);
  if (onPage.length === 0) return null;
  const containing = onPage.find(
    (p) => x >= p.bbox[0] && x <= p.bbox[2] && y >= p.bbox[1] && y <= p.bbox[3]
  );
  if (containing) return containing;
  let best = onPage[0];
  let bestDist = Infinity;
  for (const p of onPage) {
    const midY = (p.bbox[1] + p.bbox[3]) / 2;
    const d = Math.abs(midY - y);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

// The floating "AI command box" that appears near a text selection -
// shared shape for both the pre-submit instruction input (anchored to
// the raw browser selection rect) and, once blockEditState exists, is
// replaced by BlockEditOverlay's own popover instead. Enter submits;
// it NEVER mutates the selected text itself - "Enter just submits the
// instruction," per the brief. Escape or an outside click dismisses
// without submitting.
// Fixed height estimate used only to decide "is there room below" /
// where to anchor an "above" placement - deliberately not a live
// measurement (the box hasn't rendered yet when this decision is made
// in StructuredReportView.handleSelection). Generous enough for the
// two-row textarea + helper line below it at this component's real
// size; a few px of slack either way is harmless since this only
// governs a soft below/above preference, never a hard clip.
const COMMAND_BOX_HEIGHT_ESTIMATE_PX = 108;
const COMMAND_BOX_MAX_WIDTH_PX = 420;
const COMMAND_BOX_GAP_PX = 8;

/**
 * The floating "tell the AI what to change" input. Redesigned 2026-09-26
 * (six-area Report-tab polish pass, item 2 + 5): anchored to the
 * SELECTED BLOCK's own bounding rectangle (passed in as `blockRect`,
 * already converted to container-relative + scroll-offset coordinates
 * by the caller - same convention BlockEditOverlay's `rect` prop uses),
 * never the mouse/selection point - so the full paragraph stays visible
 * above it rather than the box appearing mid-text. `placement` is
 * decided once, by the caller, from real viewport geometry at selection
 * time ("is there room below the block"); this component just honors
 * it, anchoring below by default and above only when there genuinely
 * isn't room - it never covers the selected text either way, since it
 * sits outside the block's own box entirely, not inside it.
 *
 * Restyled the same pass (item 5): charcoal/near-black background
 * (`bg-neutral-950`, the same token this app's other primary dark
 * controls already use - see DESIGN.md/ChatInterface.tsx's "Run
 * compliance review" button - not a new color invented for this),
 * wrapped in a colourful `pulse-inner` BorderBeam so it reads as the
 * active AI control against the otherwise-restrained report body,
 * deliberately the OPPOSITE color choice from the generating BLOCK's
 * own mono pulse-inner beam below (see BlockEditOverlay) - "the report
 * itself remains restrained... the command box should feel like the
 * active AI control," per the brief.
 */
function SelectionCommandBox({
  blockRect,
  containerWidth,
  placement,
  onSubmit,
  onDismiss,
}: {
  blockRect: { left: number; top: number; bottom: number; width: number };
  containerWidth: number;
  placement: "below" | "above";
  onSubmit: (instruction: string) => void;
  onDismiss: () => void;
}) {
  const [value, setValue] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [onDismiss]);

  // Matches the block's own width up to a sensible cap, left-aligned to
  // the block's own left edge, then clamped so it never spills past
  // either edge of the report pane - "keep it horizontally inside the
  // Report pane."
  const width = Math.min(blockRect.width, COMMAND_BOX_MAX_WIDTH_PX);
  const left = Math.min(Math.max(8, blockRect.left), Math.max(8, containerWidth - width - 8));
  const top =
    placement === "below"
      ? blockRect.bottom + COMMAND_BOX_GAP_PX
      : blockRect.top - COMMAND_BOX_GAP_PX - COMMAND_BOX_HEIGHT_ESTIMATE_PX;

  return (
    <BorderBeam
      colorVariant="colorful"
      size="pulse-inner"
      theme="dark"
      strength={0.6}
      borderRadius={16}
      active={!prefersReducedMotion}
      className="absolute z-20"
      style={{ left, top, width }}
    >
      <div
        ref={boxRef}
        className="rounded-2xl bg-neutral-950 p-2.5 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-1.5">
          <span className="mt-1.5 text-white/70">✦</span>
          <textarea
            ref={inputRef}
            rows={2}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const trimmed = value.trim();
                if (trimmed) onSubmit(trimmed);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onDismiss();
              }
            }}
            placeholder="Tell the AI what to change…"
            className="w-full resize-none bg-transparent text-[13px] text-white outline-none placeholder:text-white/40"
          />
        </div>
        <p className="mt-1.5 pl-5 text-[10px] text-white/40">
          Enter to submit · Shift+Enter newline · Esc to cancel
        </p>
      </div>
    </BorderBeam>
  );
}

/**
 * SUPERSEDED 2026-09-27 by the fullscreen Edit Workspace redesign - kept
 * in the file, unused, rather than deleted (same standing rule this file
 * already follows for SelectionCommandBox/InteractiveDocumentView below:
 * dead code that's still type-correct is left alone unless there's a
 * concrete reason to remove it). This was the per-paragraph, inline
 * "tell the AI what to change" box that rendered directly inside a
 * selected block's own content div. It's been replaced by
 * FullscreenEditBar, a single persistent bottom composer for the whole
 * Report tab (see StructuredReportView) - "there is only one editor at
 * the bottom... not injecting a command box into the document body." No
 * call sites reference this component any more.
 */
function InlineEditCommand({
  onSubmit,
  onDismiss,
  onRevealed,
}: {
  onSubmit: (instruction: string) => void;
  onDismiss: () => void;
  onRevealed?: (el: HTMLDivElement) => void;
}) {
  const [value, setValue] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasText = value.trim().length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [onDismiss]);

  // Fires once, right after this box first mounts - "reveal by scrolling
  // only if genuinely needed," decided here rather than pre-emptively,
  // since only the real rendered box (not an estimate) can say for sure
  // whether it's clipped.
  useLayoutEffect(() => {
    if (boxRef.current && onRevealed) onRevealed(boxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-grow: starts as a single line (the 52-64px compact pill) and only
  // gets taller once the user actually types a second line, capped at
  // max-h-32 below so it never becomes another tall panel.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [value]);

  const trySubmit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    // 2026-09-27 (visual integration pass - positioning and editing logic
    // are unchanged): a light contextual editor instead of a dark
    // floating pill, so it reads as part of the same paper surface as
    // the report rather than a separate application control. w-full
    // (was max-w-sm) so it spans the paragraph's own width instead of a
    // narrower, detached chip. rounded-2xl matches both the report
    // block's own hover/active radius (see editableProps below) and
    // DESIGN.md's standard container-radius token, so the block and its
    // editor read as one squircle language, not two. No BorderBeam here
    // at all: per the preferred direction, idle/typing stays fully
    // neutral and the animated pulse is reserved for the generating
    // state, which is already its own separate component
    // (BlockEditOverlay, mono pulse-inner) rendered once the instruction
    // is submitted - so "neutral while editing, pulse while generating"
    // falls out of the existing component split rather than needing new
    // state here.
    <div className="mt-2.5 mb-2 w-full" onMouseDown={(e) => e.stopPropagation()}>
      <div
        ref={boxRef}
        className="ai-command-card flex items-center gap-2 rounded-2xl border border-neutral-950/10 bg-white py-2.5 pl-3 pr-2 shadow-sm transition-colors focus-within:border-neutral-950/20"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[12px] text-neutral-400">
          ✦
        </span>
        {/* ai-command-input: a scoped class (see globals.css) that opts
            this textarea out of the app-wide bare
            `textarea, textarea:focus` rules, which paint every textarea
            with an `!important` border + blue focus box-shadow. Here the
            input should read as plain report text with a cursor sitting
            in it, not as a separate bordered form field. */}
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              trySubmit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onDismiss();
            }
          }}
          placeholder="Tell the AI what to change…"
          className="ai-command-input max-h-32 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-0 text-sm leading-5 text-neutral-800 outline-none placeholder:text-neutral-400"
        />
        {/* Send affordance only appears once there's something to send -
            same "quiet until needed" language as the main chat composer's
            own send button, restyled here in the same light-neutral
            palette as the rest of this control. */}
        {hasText && (
          <button
            type="button"
            onClick={trySubmit}
            aria-label="Submit"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-950/5 text-[12px] text-neutral-500 transition hover:bg-neutral-950/10 hover:text-neutral-800"
          >
            ↑
          </button>
        )}
      </div>
      <p className="mt-1.5 pl-1 text-[10px] text-neutral-400">
        Enter · Shift+Enter · Esc
      </p>
    </div>
  );
}

/**
 * Renders the border-beam + skeleton overlay AND (once alternatives or
 * an exact-replacement preview are ready) the choice popover, positioned
 * directly over the target block's own bbox on the real rendered page -
 * "highlight only that block with the border beam and skeleton," "the
 * beam is just a visual state around the existing block, not a
 * replacement component," per the brief. `rect` is the block's bbox
 * already converted to CSS px within the page's own wrapper (which must
 * be position:relative - see InteractiveDocumentView below).
 *
 * One honest adaptation, same spirit as EditingBlockCard's own note
 * above: the page underneath is a real rendered PDF (canvas + a real
 * text layer), not a DOM node per paragraph, so "the original text
 * transitions into skeleton placeholders" is done here as an OPAQUE
 * skeleton-colored panel drawn exactly over the block's own bbox
 * (sized to its real, already-known height - never a guess, unlike
 * EditingBlockCard's lastBlockHeight, since the real page is already on
 * screen) rather than the text itself changing - visually the same
 * effect ("AI is working on this exact paragraph"), without needing to
 * re-render the canvas mid-edit.
 */
// state's own shape only needs to be structurally compatible - this same
// component is reused unchanged by StructuredReportView below (2026-09-25,
// report-block editing) with reportBlockEditState, which isn't the same
// type as blockEditState (no page/bbox/paragraphId - a report block was
// never on a PDF page) but shares every field this component actually
// reads. `headerLabel` (added the same day, alongside that reuse) replaces
// this component's own former "paragraph N" text so BOTH callers can pass
// whatever heading actually makes sense for their own block.
type BlockEditPopoverState = {
  status: "resolving" | "choosing" | "applying" | "applied" | "error";
  isExactReplacement?: boolean;
  originalText?: string;
  alternatives?: { index: number; label: string; text: string; rationale?: string }[];
  errorMessage?: string;
  // "Custom" refinement sub-state (2026-09-26) - see DocumentPanelProps'
  // own reportBlockEditState comment for what these mean. Optional/
  // undefined for a caller that doesn't offer refinement (kept optional
  // rather than required so this type stays structurally compatible
  // with any future non-report caller too).
  customLoading?: boolean;
  customError?: string | null;
  customPreviewIndex?: number | null;
};

/**
 * Renders the border-beam + skeleton overlay AND (once alternatives or
 * an exact-replacement preview are ready) the choice popover - see the
 * file-level comment above this component's original 2026-09-25
 * version for the full history of that split.
 *
 * Redesigned 2026-09-26 (six-area Report-tab polish pass):
 *
 * - Item 4: the generating-block beam is now `size="pulse-inner"`
 *   (a contained breathing glow) instead of `size="line"` (a bottom-
 *   traveling one) - the actual reason the intended effect "wasn't
 *   visibly working" is that the wrong preset was configured, not a
 *   rendering bug; verified against border-beam's own shipped source
 *   that `pulse-inner` self-contains its glow inside ITS OWN wrapper
 *   (position:relative + overflow:hidden, generated by the library
 *   itself), so the skeleton's inner `overflow-hidden` div never clips
 *   it - no z-index/overflow fix needed beyond the preset swap. Radius
 *   bumped from a flat 4px/`rounded-sm` to DESIGN.md's own container
 *   token (`rounded-2xl`, 16px) so the generating block reads as the
 *   same squircle shape as the rest of the product, not a plain
 *   rectangle.
 * - Item 1: each alternative is now its own expand/collapse card
 *   (`expandedIndex` - only one open at a time, the simpler option per
 *   the brief's own "unless the architecture makes multiple simpler" -
 *   it doesn't here) instead of a `line-clamp-2` button, plus a fourth
 *   "Custom" refinement box beneath them.
 */
function BlockEditOverlay({
  rect,
  state,
  headerLabel,
  onChooseAlternative,
  onRejectEdit,
  onUndoEdit,
  onDismissEdit,
  onRefine,
  onBackFromCustomPreview,
}: {
  rect: { left: number; top: number; width: number; height: number };
  state: BlockEditPopoverState;
  headerLabel: string;
  onChooseAlternative?: (index: number) => void;
  onRejectEdit?: () => void;
  onUndoEdit?: () => void;
  onDismissEdit?: () => void;
  onRefine?: (instruction: string) => void;
  onBackFromCustomPreview?: () => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const isBusy = state.status === "resolving" || state.status === "applying";
  const beamActive = isBusy && !prefersReducedMotion;
  const showStaticBorder = isBusy && prefersReducedMotion;
  const skeletonLineCount = Math.min(10, Math.max(2, Math.round(rect.height / SKELETON_LINE_HEIGHT_PX)));
  const showPopover = state.status === "choosing" || state.status === "error";

  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [customInstruction, setCustomInstruction] = useState("");
  useEffect(() => {
    // A fresh propose-edit cycle starting (a new selection, a new
    // instruction) always begins at "resolving" - reset the card/custom-
    // box's own local UI state so a stale expansion or half-typed
    // refinement from a PREVIOUS block's edit never bleeds into this one.
    if (state.status === "resolving") {
      setExpandedIndex(null);
      setCustomInstruction("");
    }
  }, [state.status]);

  const customPreviewAlt =
    state.customPreviewIndex != null
      ? (state.alternatives || []).find((a) => a.index === state.customPreviewIndex) || null
      : null;

  return (
    <>
      <BorderBeam
        colorVariant="mono"
        size="pulse-inner"
        theme="light"
        strength={0.6}
        borderRadius={16}
        active={beamActive}
        className="pointer-events-none absolute z-10"
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      >
        <div
          className={
            "h-full w-full overflow-hidden rounded-2xl border bg-white transition-colors " +
            (showStaticBorder ? "border-neutral-950/50" : isBusy ? "border-neutral-950/20" : "border-transparent")
          }
        >
          {isBusy && (
            <div className="flex h-full flex-col justify-center gap-1.5 p-1.5">
              {Array.from({ length: skeletonLineCount }, (_, i) => (
                <div
                  key={i}
                  className={"h-2 rounded bg-neutral-950/10 " + (prefersReducedMotion ? "" : "animate-pulse")}
                  style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] }}
                />
              ))}
            </div>
          )}
          {state.status === "applied" && (
            <div className="pointer-events-none absolute right-1 top-1 z-20 inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 shadow">
              ✓ Updated
              {onUndoEdit && (
                <button
                  type="button"
                  onClick={onUndoEdit}
                  className="pointer-events-auto text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                >
                  Undo
                </button>
              )}
            </div>
          )}
        </div>
      </BorderBeam>

      {showPopover && (
        <div
          className="absolute z-20 w-[340px] rounded-2xl border border-neutral-950/10 bg-white p-2.5 shadow-lg"
          style={{ left: rect.left, top: rect.top + rect.height + 8 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              {headerLabel}
            </p>
            {onDismissEdit && (
              <button type="button" onClick={onDismissEdit} className="text-[11px] text-neutral-400 hover:text-neutral-600">
                Dismiss
              </button>
            )}
          </div>

          {state.status === "error" && (
            <p className="mb-1.5 text-[11px] text-red-600">
              {state.errorMessage || "Something went wrong."}
            </p>
          )}

          {state.isExactReplacement ? (
            // Exact-replacement path: "show a preview with apply or
            // cancel, but no AI alternatives" - the single alternative
            // IS the literal substitution, shown as old -> new, not as a
            // labeled "option".
            <div className="space-y-1.5">
              {state.originalText && (
                <p className="line-clamp-3 rounded-md bg-neutral-50 px-2 py-1.5 text-[11px] text-neutral-500 line-through">
                  {state.originalText}
                </p>
              )}
              {state.alternatives?.[0] && (
                <p className="line-clamp-3 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">
                  {state.alternatives[0].text}
                </p>
              )}
              <div className="flex gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => onChooseAlternative?.(0)}
                  className="rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-neutral-800"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={onRejectEdit}
                  className="rounded-lg border border-neutral-950/10 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-950/5"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : customPreviewAlt ? (
            // "Show the refined result and require Apply/Back before
            // changing the report" - a dedicated preview step, kept
            // visually distinct from the plain option list below rather
            // than just quietly appended to it.
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Custom — preview
              </p>
              <p className="whitespace-pre-wrap rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[12px] leading-relaxed text-emerald-900">
                {customPreviewAlt.text}
              </p>
              {customPreviewAlt.rationale && (
                <p className="text-[11px] text-neutral-600">{customPreviewAlt.rationale}</p>
              )}
              <div className="flex gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => onChooseAlternative?.(customPreviewAlt.index)}
                  className="rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-neutral-800"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={onBackFromCustomPreview}
                  className="rounded-lg border border-neutral-950/10 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-950/5"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {(state.alternatives || []).map((alt) => {
                const isExpanded = expandedIndex === alt.index;
                return (
                  <div
                    key={alt.index}
                    className={
                      "rounded-xl border transition " +
                      (isExpanded ? "border-neutral-950/20 bg-neutral-50/60 p-2.5" : "border-neutral-950/10 bg-white p-2")
                    }
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedIndex(isExpanded ? null : alt.index)}
                      className="flex w-full items-start justify-between gap-2 text-left"
                    >
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                          Option {alt.index + 1} · {alt.label}
                        </p>
                        {!isExpanded && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-neutral-700">{alt.text}</p>
                        )}
                      </div>
                      <span className="mt-0.5 shrink-0 text-[10px] font-medium text-neutral-400">
                        {isExpanded ? "Collapse" : "Expand"}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="mt-2 space-y-2">
                        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-800">{alt.text}</p>
                        {alt.rationale && (
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                              Why this version
                            </p>
                            <p className="mt-0.5 text-[11px] text-neutral-600">{alt.rationale}</p>
                          </div>
                        )}
                        <div className="flex gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() => onChooseAlternative?.(alt.index)}
                            className="rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-neutral-800"
                          >
                            Use this version
                          </button>
                          <button
                            type="button"
                            onClick={() => setExpandedIndex(null)}
                            className="rounded-lg border border-neutral-950/10 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-950/5"
                          >
                            Collapse
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {onRefine && (
                <div className="rounded-xl border border-dashed border-neutral-950/15 bg-white p-2">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Custom</p>
                  <textarea
                    rows={2}
                    value={customInstruction}
                    onChange={(e) => setCustomInstruction(e.target.value)}
                    disabled={state.customLoading}
                    placeholder="Tell the AI how to refine these — e.g. “use option 2 but shorter”"
                    className="w-full resize-none rounded-lg border border-neutral-950/10 bg-neutral-50/60 px-2 py-1.5 text-[11px] text-neutral-800 outline-none focus:border-neutral-950/25 disabled:opacity-60"
                  />
                  {state.customError && <p className="mt-1 text-[11px] text-red-600">{state.customError}</p>}
                  <div className="mt-1.5 flex justify-end">
                    <button
                      type="button"
                      disabled={!customInstruction.trim() || state.customLoading}
                      onClick={() => onRefine(customInstruction.trim())}
                      className="rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {state.customLoading ? "Refining…" : "Refine"}
                    </button>
                  </div>
                </div>
              )}

              {onRejectEdit && (
                <button type="button" onClick={onRejectEdit} className="text-[11px] text-neutral-400 transition hover:text-neutral-600">
                  Keep original wording
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * 2026-09-27 (fullscreen Edit Workspace redesign; restyled again later
 * the same day per the "premium redesign" brief - item 5: "the loading
 * state should feel like AI is working on this block, not a random
 * glowing error box... no gaudy rainbow glow... prioritize calm
 * sophistication"). A deliberate FORK of BlockEditOverlay's own
 * beam/skeleton half, not a refactor of it - BlockEditOverlay itself is
 * left completely untouched because InteractiveDocumentView (the still-
 * compiled but never-rendered old Document-tab component, see its own
 * docstring below) still calls it with the full old prop set including
 * the popover. Touching that shared component to reshape the Report
 * tab's new workspace risked breaking type-compatibility for code this
 * session has repeatedly been told to leave alone. So: this is the
 * inline "the selected block is generating" indicator ONLY (skeleton +
 * the transient "Updated" badge), used by StructuredReportView in place
 * of BlockEditOverlay. The alternatives/custom-refine popover that used
 * to render directly below this same rect has moved out to
 * ReportAlternativesPopup below, which StructuredReportView now renders
 * once, near the fullscreen bottom edit bar, instead of once per block.
 *
 * Dropped the mono BorderBeam this used to wrap in (the rotating-line
 * effect that shipped 2026-09-25/26) for a calm, settled treatment
 * instead: a slightly stronger border plus DESIGN.md's own
 * `.skeleton-line` shimmer - the same warm, content-shaped shimmer
 * every other loading state in this app already uses, rather than a
 * bespoke one invented for just this component. A moving beam around a
 * block of text reads as "a random effect"; a settled border and a
 * familiar skeleton reads as "the AI is working here" without adding
 * any new visual vocabulary, and it no longer needs its own
 * reduced-motion branch - `.skeleton-line`/`.rise` already collapse
 * under `prefers-reduced-motion` globally (globals.css).
 */
function BlockGeneratingBeam({
  rect,
  state,
  onUndoEdit,
}: {
  rect: { left: number; top: number; width: number; height: number };
  state: BlockEditPopoverState;
  onUndoEdit?: () => void;
}) {
  const isBusy = state.status === "resolving" || state.status === "applying";
  const skeletonLineCount = Math.min(10, Math.max(2, Math.round(rect.height / SKELETON_LINE_HEIGHT_PX)));

  return (
    <div
      className="pointer-events-none absolute z-10 overflow-hidden rounded-2xl"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <div
        className={
          "h-full w-full overflow-hidden rounded-2xl border transition-[border-color,background-color] duration-200 ease-settle " +
          (isBusy ? "border-[var(--rule-strong)] bg-[var(--paper-sunken)]" : "border-transparent bg-transparent")
        }
      >
        {isBusy && (
          <div className="flex h-full flex-col justify-center gap-2 p-3">
            {Array.from({ length: skeletonLineCount }, (_, i) => (
              <div
                key={i}
                className="skeleton-line h-2.5"
                style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] }}
              />
            ))}
          </div>
        )}
        {state.status === "applied" && (
          <div className="rise pointer-events-none absolute right-1.5 top-1.5 z-20 inline-flex items-center gap-1.5 rounded-full bg-[var(--paper-raised)] px-2.5 py-1 text-[10px] font-medium text-emerald-700 shadow-paper-sm">
            <span aria-hidden className="text-emerald-600">✓</span> Updated
            {onUndoEdit && (
              <button
                type="button"
                onClick={onUndoEdit}
                className="pointer-events-auto text-[var(--ink-muted)] underline decoration-[var(--rule-strong)] underline-offset-2 transition hover:text-[var(--ink)]"
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 2026-09-27 (fullscreen Edit Workspace redesign; restyled again later
 * the same day per the "premium redesign" brief - items 7/8/13: option
 * cards need real breathing room and a clear hierarchy, the custom
 * refinement field should read as a genuine fourth option rather than a
 * dashed-border afterthought, and the parse-failure state should never
 * show raw backend copy). The alternatives chooser, forked out of
 * BlockEditOverlay's own popover half (same reasoning as
 * BlockGeneratingBeam above - BlockEditOverlay itself is left untouched
 * for InteractiveDocumentView's sake). The brief was explicit: "Do not
 * inject the 3 options inline into the report. Show them in a compact
 * overlay/popup... appear near the selected block or centrally above
 * the bottom bar." StructuredReportView renders exactly ONE of these, in
 * its fullscreen footer, directly above FullscreenEditBar - not per
 * block, and with no rect/coordinate math at all, since normal flow
 * (this card stacks above the input pill in the same centered footer
 * column) already puts it exactly there.
 *
 * The parse-failure branch below never renders `state.errorMessage`
 * verbatim any more - whatever raw string the backend returned (past,
 * present, or a future wording change) is replaced with one calm,
 * constant sentence pair, because chasing every possible backend string
 * is a losing game and the UI's job is to stay composed regardless of
 * what failed underneath it.
 */
function ReportAlternativesPopup({
  state,
  headerLabel,
  onChooseAlternative,
  onRejectEdit,
  onDismissEdit,
  onRefine,
  onBackFromCustomPreview,
}: {
  state: BlockEditPopoverState;
  headerLabel: string;
  onChooseAlternative?: (index: number) => void;
  onRejectEdit?: () => void;
  onDismissEdit?: () => void;
  onRefine?: (instruction: string) => void;
  onBackFromCustomPreview?: () => void;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [customInstruction, setCustomInstruction] = useState("");
  useEffect(() => {
    // Same reset-on-a-fresh-cycle rule as before: a new selection/
    // instruction always starts at "resolving," so any stale expansion
    // or half-typed refinement from a PREVIOUS block's edit never bleeds
    // into this one.
    if (state.status === "resolving") {
      setExpandedIndex(null);
      setCustomInstruction("");
    }
  }, [state.status]);

  const customPreviewAlt =
    state.customPreviewIndex != null
      ? (state.alternatives || []).find((a) => a.index === state.customPreviewIndex) || null
      : null;

  return (
    <div
      className="rise mb-3 w-full rounded-2xl border border-[var(--rule)] bg-[var(--paper-raised)] p-5 shadow-paper-lg"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-[var(--ink)]">
          {headerLabel}
        </p>
        {onDismissEdit && (
          <button
            type="button"
            onClick={onDismissEdit}
            className="shrink-0 text-[12px] text-[var(--ink-faint)] transition hover:text-[var(--ink-secondary)]"
          >
            Dismiss
          </button>
        )}
      </div>

      {state.status === "error" && (
        <div className="mb-3 rounded-xl bg-[var(--paper-sunken)] p-4">
          <p className="text-[13px] leading-relaxed text-[var(--ink-secondary)]">
            Couldn't prepare structured revision options for this block.
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-secondary)]">
            You can still guide the AI manually below.
          </p>
        </div>
      )}

      {state.isExactReplacement ? (
        // Exact-replacement path: "show a preview with apply or cancel,
        // but no AI alternatives" - the single alternative IS the
        // literal substitution, shown as old -> new, not as a labeled
        // "option".
        <div className="space-y-3">
          {state.originalText && (
            <div className="rounded-xl bg-[var(--paper-sunken)] p-3.5">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ink-muted)]">Current wording</p>
              <p className="line-clamp-3 text-[13px] leading-relaxed text-[var(--ink-faint)] line-through">{state.originalText}</p>
            </div>
          )}
          {state.alternatives?.[0] && (
            <div className="rounded-xl border border-[var(--rule)] bg-[var(--paper)] p-3.5">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ink-muted)]">New wording</p>
              <p className="line-clamp-3 text-[13px] leading-relaxed text-[var(--ink)]">{state.alternatives[0].text}</p>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => onChooseAlternative?.(0)}
              className="press rounded-full bg-[var(--ink)] px-4 py-1.5 text-[12px] font-medium text-[var(--accent-contrast)] transition hover:opacity-90"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={onRejectEdit}
              className="press rounded-full border border-[var(--rule)] bg-[var(--paper)] px-4 py-1.5 text-[12px] font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--paper-sunken)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : customPreviewAlt ? (
        // "Show the refined result and require Apply/Back before
        // changing the report" - a dedicated preview step, kept visually
        // distinct from the plain option list below rather than just
        // quietly appended to it.
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
            Custom — preview
          </p>
          <div className="rounded-xl border border-[var(--rule)] bg-[var(--paper)] p-3.5">
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)]">{customPreviewAlt.text}</p>
          </div>
          {customPreviewAlt.rationale && (
            <p className="text-[12px] leading-relaxed text-[var(--ink-muted)]">{customPreviewAlt.rationale}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => onChooseAlternative?.(customPreviewAlt.index)}
              className="press rounded-full bg-[var(--ink)] px-4 py-1.5 text-[12px] font-medium text-[var(--accent-contrast)] transition hover:opacity-90"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={onBackFromCustomPreview}
              className="press rounded-full border border-[var(--rule)] bg-[var(--paper)] px-4 py-1.5 text-[12px] font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--paper-sunken)]"
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          {(state.alternatives || []).map((alt) => {
            const isOptExpanded = expandedIndex === alt.index;
            return (
              <div
                key={alt.index}
                className={
                  "rounded-xl border transition-[border-color,background-color] duration-200 ease-settle " +
                  (isOptExpanded
                    ? "border-[var(--rule-strong)] bg-[var(--paper)] p-4"
                    : "border-[var(--rule)] bg-[var(--paper)] p-3.5 hover:border-[var(--rule-strong)]")
                }
              >
                <button
                  type="button"
                  onClick={() => setExpandedIndex(isOptExpanded ? null : alt.index)}
                  className="flex w-full items-start justify-between gap-3 text-left"
                >
                  <div className="min-w-0">
                    <span className="inline-flex items-center rounded-full bg-[var(--paper-sunken)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--ink-muted)]">
                      Option {alt.index + 1} · {alt.label}
                    </span>
                    {!isOptExpanded && (
                      <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-[var(--ink-secondary)]">{alt.text}</p>
                    )}
                  </div>
                  <span className="mt-0.5 shrink-0 text-[11px] font-medium text-[var(--ink-faint)]">
                    {isOptExpanded ? "Collapse" : "Expand"}
                  </span>
                </button>

                {isOptExpanded && (
                  <div className="mt-2.5 space-y-2.5">
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)]">{alt.text}</p>
                    {alt.rationale && (
                      <div className="rounded-lg bg-[var(--paper-sunken)] p-2.5">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--ink-muted)]">
                          Why this version
                        </p>
                        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ink-secondary)]">{alt.rationale}</p>
                      </div>
                    )}
                    <div className="flex gap-2 pt-0.5">
                      <button
                        type="button"
                        onClick={() => onChooseAlternative?.(alt.index)}
                        className="press rounded-full bg-[var(--ink)] px-4 py-1.5 text-[12px] font-medium text-[var(--accent-contrast)] transition hover:opacity-90"
                      >
                        Use this version
                      </button>
                      <button
                        type="button"
                        onClick={() => setExpandedIndex(null)}
                        className="press rounded-full border border-[var(--rule)] bg-[var(--paper)] px-4 py-1.5 text-[12px] font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--paper-sunken)]"
                      >
                        Collapse
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {onRefine && (
            <div className="rounded-xl border border-[var(--rule)] bg-[var(--paper)] p-3.5">
              <span className="inline-flex items-center rounded-full bg-[var(--paper-sunken)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--ink-muted)]">
                Custom refinement
              </span>
              <textarea
                rows={2}
                value={customInstruction}
                onChange={(e) => setCustomInstruction(e.target.value)}
                disabled={state.customLoading}
                placeholder="Tell the AI how to refine these — e.g. “use option 2 but shorter”"
                className="mt-2 w-full resize-none rounded-lg border border-[var(--rule)] bg-[var(--paper-sunken)] px-2.5 py-2 text-[13px] leading-relaxed text-[var(--ink)] outline-none transition-colors duration-200 ease-settle placeholder:text-[var(--ink-faint)] focus:border-[var(--rule-strong)] disabled:opacity-60"
              />
              {state.customError && <p className="mt-1.5 text-[12px] text-red-600">{state.customError}</p>}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={!customInstruction.trim() || state.customLoading}
                  onClick={() => onRefine(customInstruction.trim())}
                  className="press rounded-full bg-[var(--ink)] px-4 py-1.5 text-[12px] font-medium text-[var(--accent-contrast)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {state.customLoading ? "Refining…" : "Refine"}
                </button>
              </div>
            </div>
          )}

          {onRejectEdit && (
            <button
              type="button"
              onClick={onRejectEdit}
              className="mt-1 block w-full border-t border-[var(--rule)] pt-3 text-center text-[12px] text-[var(--ink-faint)] transition hover:text-[var(--ink-secondary)]"
            >
              Keep original wording
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 2026-09-27 (fullscreen Edit Workspace redesign; restyled again later
 * the same day per the "premium redesign" brief - item 6: "one of the
 * weakest UI pieces... must feel like a real AI editing composer:
 * centered, larger, wider, premium"). The one persistent bottom composer
 * for the Report tab's fullscreen mode - "there is only one editor at
 * the bottom," never injected per-paragraph. Purely a presentation/
 * state-machine layer: it owns its own typed `value` and nothing else -
 * which block is active, and what status the current edit is in, are
 * computed by StructuredReportView from state it already has
 * (activeBlock, reportBlockEditState) and passed in as plain props, so
 * this component never touches editing logic itself.
 *
 * Widened from the original 560px cap to the brief's target 680-860px
 * range (720px), and the raw `errorMessage` line that used to render
 * directly under the composer on a failed generation was removed -
 * ReportAlternativesPopup (rendered as `popup` above this bar) now
 * carries a single calm, constant explanation for that state instead,
 * so the same technical string never has two different renderings to
 * keep in sync.
 *
 * 2026-09-28 (floating composer redesign): this component no longer
 * owns its own centering/positioning wrapper - it used to render
 * `<div className="flex justify-center px-4 py-5">` around everything
 * below, making it its own full-width row in StructuredReportView's
 * flex column (a "docked footer," per the brief, even though it painted
 * no visible background of its own). StructuredReportView now does that
 * positioning itself, absolutely over the scrollable document instead
 * of in normal flow, so this component just returns the actual
 * max-w-[720px] column of content - see StructuredReportView's own
 * return statement for the three-layer floating structure
 * (document / fade / composer).
 */
function FullscreenEditBar({
  activeBlock,
  barStatus,
  errorMessage,
  popup,
  onSubmit,
  onDeselect,
  isExpanded,
}: {
  activeBlock: { localId: number; kind: string; index: number | null; selectedText: string; parentText: string } | null;
  barStatus: "no-selection" | "ready" | "generating" | "choosing" | "applying" | "updated" | "error";
  // No longer rendered directly (see docstring above) - kept in the prop
  // signature so the caller doesn't need to change, and so a future
  // inline treatment has somewhere to read from without re-threading it.
  errorMessage?: string | null;
  // The alternatives chooser (ReportAlternativesPopup), when one should
  // show - handed in as a node rather than built here, since it needs
  // several editing callbacks this composer otherwise has no reason to
  // know about. Rendered above the context line/input, in plain
  // document flow, so "centrally above the bottom bar" falls out of
  // ordinary stacking rather than any absolute positioning.
  popup?: React.ReactNode;
  onSubmit: (instruction: string) => void;
  onDeselect: () => void;
  // Whether this (always-mounted) bar is currently visible. Only used to
  // re-run the textarea auto-resize effect when visibility changes - see
  // that effect below for why.
  isExpanded: boolean;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A newly-selected block always starts with an empty composer - never
  // carries over text typed for whatever was active before.
  useEffect(() => {
    setValue("");
  }, [activeBlock?.localId]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
    // isExpanded is also a dependency, not just value: FullscreenEditBar
    // is always mounted (even before fullscreen is ever entered, inside a
    // wrapper toggled hidden/visible via isExpanded - see
    // StructuredReportView) so state survives an exit/re-enter-fullscreen
    // round trip. That means this effect's very first run happens while
    // the wrapper is display:none, where scrollHeight reads 0 - pinning
    // an inline height:0px on the textarea that a value-only dependency
    // array never revisits once fullscreen makes the bar visible again,
    // leaving it permanently zero-height (visible card, but no
    // clickable/typeable textarea inside it). Re-running on isExpanded
    // fixes that.
  }, [value, isExpanded]);

  const isBusy = barStatus === "generating" || barStatus === "applying";
  const showingPopup = barStatus === "choosing" || barStatus === "error";
  const disabled = barStatus === "no-selection" || isBusy || showingPopup;
  const hasText = value.trim().length > 0;

  const placeholder =
    barStatus === "no-selection"
      ? "Select a paragraph to edit"
      : barStatus === "generating"
      ? "Generating revisions…"
      : barStatus === "applying"
      ? "Applying revision…"
      : showingPopup
      ? "Choose a revision above…"
      : "Tell the AI what to change…";

  const trySubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  const contextPreview = (activeBlock?.selectedText || activeBlock?.parentText || "")
    .replace(/\s+/g, " ")
    .trim();

  return (
    // pointer-events-auto: the parent wrapper (StructuredReportView) is
    // pointer-events-none across its full width (it spans the whole
    // floating band so it never blocks clicks on the document beside
    // the composer) - this max-w-[720px] column is the one element in
    // that band that should actually receive clicks/typing.
    <div className="pointer-events-auto w-full max-w-[720px]">
      {popup}
      {activeBlock && (
        <div className="mb-2 flex items-center justify-between gap-3 px-1.5">
          <p className="min-w-0 truncate text-[12px] text-[var(--ink-muted)]">
            <span className="font-medium text-[var(--ink-secondary)]">Editing: </span>
            {contextPreview.length > 84 ? contextPreview.slice(0, 84) + "…" : contextPreview || "Untitled block"}
          </p>
          {!isBusy && !showingPopup && (
            <button
              type="button"
              onClick={onDeselect}
              className="shrink-0 text-[12px] text-[var(--ink-faint)] transition hover:text-[var(--ink-secondary)]"
            >
              Deselect
            </button>
          )}
        </div>
      )}
      <div className="ai-command-card flex items-end gap-2 rounded-[26px] border border-[var(--rule)] bg-[var(--paper-raised)] py-3 pl-5 pr-2.5 shadow-paper-md transition-[box-shadow,border-color] duration-200 ease-settle focus-within:border-[var(--rule-strong)] focus-within:shadow-paper-lg">
        <textarea
          ref={inputRef}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              trySubmit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (!isBusy) onDeselect();
            }
          }}
          placeholder={placeholder}
          className="ai-command-input max-h-32 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-sm leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={trySubmit}
          disabled={!hasText || disabled}
          aria-label="Submit"
          className={
            "press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] transition-[background-color,color,opacity] duration-200 ease-settle " +
            (hasText && !disabled
              ? "bg-[var(--ink)] text-[var(--accent-contrast)] hover:opacity-90"
              : "cursor-not-allowed bg-[var(--paper-sunken)] text-[var(--ink-faint)]")
          }
        >
          ↑
        </button>
      </div>
      <p className="mt-2.5 text-center text-[11px] text-[var(--ink-faint)]">
        Enter to submit · Shift+Enter newline · Esc cancel
      </p>
    </div>
  );
}

/**
 * The new "Document" tab's interactive, selection-driven view -
 * 2026-09-25 inline-block-editing milestone. Renders `documentUrl` as a
 * real, continuously-scrollable, text-selectable PDF (same rendering
 * approach the Report tab already uses below, just pointed at a
 * different file and with the text layer's native browser selection
 * actually used instead of just present for accessibility).
 *
 * Flow: user selects text inside a page -> resolveBlockAtPoint() maps
 * the selection's own bounding rect (converted into that page's native
 * PDF coordinate units) to the nearest block from `paragraphs` ->
 * SelectionCommandBox appears near the selection -> Enter calls
 * onSubmitInstruction with the FULL parent block text plus the exact
 * selected substring (per the brief: "send the entire parent block plus
 * the exact selected text to the edit system") -> once `blockEditState`
 * is set by the caller, BlockEditOverlay takes over showing the beam/
 * skeleton/alternatives directly over that same block's bbox, on
 * whichever page it's on (independent of scroll - the overlay is only
 * rendered into whichever page wrapper currently matches
 * blockEditState.page, so it correctly reappears if the user scrolls
 * away and back).
 *
 * Also owns preserving scroll position across a documentUrl change
 * (choosing an alternative regenerates the PDF and swaps this prop) -
 * "preserve the scroll position, then refresh or regenerate the PDF."
 * Captures the target block's page + the scroll offset from that page's
 * own top immediately before a swap is expected (i.e. the instant
 * blockEditState moves to "applying"), then restores that same offset
 * once the new document's pages have (re)mounted.
 */
function InteractiveDocumentView({
  documentUrl,
  paragraphs,
  pageWidth,
  blockEditState,
  onSubmitInstruction,
  onChooseAlternative,
  onRejectEdit,
  onUndoEdit,
  onDismissEdit,
}: {
  documentUrl: string;
  paragraphs: DocumentBlock[];
  pageWidth: number;
  blockEditState?: DocumentPanelProps["blockEditState"];
  onSubmitInstruction: (
    target: { paragraphId: number; page: number; bbox: [number, number, number, number]; selectedText: string; parentText: string },
    instruction: string
  ) => void;
  onChooseAlternative?: (index: number) => void;
  onRejectEdit?: () => void;
  onUndoEdit?: () => void;
  onDismissEdit?: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageWrapRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Native (unscaled) size of each page, captured on load - needed to
  // convert a block's bbox (native PDF units) into on-screen px at the
  // page's CURRENT rendered width, same scale math EditingBlockCard's
  // own highlightStyle already uses, just per-page here instead of once.
  const [pageNativeSizes, setPageNativeSizes] = useState<Map<number, { width: number; height: number }>>(new Map());

  const [pendingSelection, setPendingSelection] = useState<{
    paragraphId: number;
    page: number;
    bbox: [number, number, number, number];
    selectedText: string;
    parentText: string;
  } | null>(null);

  useEffect(() => setMounted(true), []);

  // Preserve-scroll bookkeeping across a documentUrl swap (a chosen
  // alternative regenerates the PDF - react-pdf remounts every page).
  // Captured the moment we notice the URL is about to change (status
  // flips to "applying"), restored once the new document's target page
  // wrapper re-registers itself below.
  const prevUrlRef = useRef(documentUrl);
  const pendingRestoreRef = useRef<{ page: number; offsetFromPageTop: number } | null>(null);
  useEffect(() => {
    if (
      blockEditState?.status === "applying" &&
      scrollRef.current &&
      pendingRestoreRef.current === null
    ) {
      const pageEl = pageWrapRefs.current.get(blockEditState.page);
      if (pageEl) {
        pendingRestoreRef.current = {
          page: blockEditState.page,
          offsetFromPageTop: scrollRef.current.scrollTop - pageEl.offsetTop,
        };
      }
    }
  }, [blockEditState?.status, blockEditState?.page]);

  useEffect(() => {
    if (documentUrl === prevUrlRef.current) return;
    prevUrlRef.current = documentUrl;
    setNumPages(null);
    setPageNativeSizes(new Map());
    // Restoration itself happens in the page-registration effect below,
    // once the freshly-mounted target page's wrapper is available again
    // (pendingRestoreRef stays set until then).
  }, [documentUrl]);

  const restoreScrollIfPending = useCallback((page: number) => {
    const pending = pendingRestoreRef.current;
    if (!pending || pending.page !== page || !scrollRef.current) return;
    const pageEl = pageWrapRefs.current.get(page);
    if (!pageEl) return;
    scrollRef.current.scrollTop = pageEl.offsetTop + pending.offsetFromPageTop;
    pendingRestoreRef.current = null;
  }, []);

  const handleSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = selection.toString().trim();
    if (!text) return;

    const range = selection.getRangeAt(0);
    let node: Node | null = range.commonAncestorContainer;
    let pageEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.dataset.pageNumber) {
        pageEl = node;
        break;
      }
      node = node.parentNode;
    }
    if (!pageEl || !scrollRef.current) return;
    const page = Number(pageEl.dataset.pageNumber);
    const native = pageNativeSizes.get(page);
    if (!page || !native) return;

    const pageRect = pageEl.getBoundingClientRect();
    const selRect = range.getBoundingClientRect();
    const scale = pageRect.width / native.width;
    if (!scale) return;

    // Selection bbox in the page's own native PDF coordinate units - same
    // top-down convention every bbox in this file already uses.
    const selBbox: [number, number, number, number] = [
      (selRect.left - pageRect.left) / scale,
      (selRect.top - pageRect.top) / scale,
      (selRect.right - pageRect.left) / scale,
      (selRect.bottom - pageRect.top) / scale,
    ];
    const centerX = (selBbox[0] + selBbox[2]) / 2;
    const centerY = (selBbox[1] + selBbox[3]) / 2;
    const block = resolveBlockAtPoint(paragraphs, page, centerX, centerY);
    if (!block) return;

    setPendingSelection({
      paragraphId: block.id,
      page: block.page,
      bbox: block.bbox,
      selectedText: text,
      parentText: block.text,
    });
  }, [paragraphs, pageNativeSizes]);

  // This component (the pre-correction, selection-on-the-PDF-canvas
  // Document-tab editor) is kept but no longer rendered anywhere - see
  // its own file-level note on the 2026-09-25 architecture correction.
  // blockRect/placement below exist only so its SelectionCommandBox call
  // still type-checks against that component's current (2026-09-26)
  // props; not meaningfully exercised or polished further, since the
  // Document tab is explicitly out of scope for this pass and must stay
  // exactly as it already is.
  const pendingSelectionBlockRect = useMemo(() => {
    if (!pendingSelection) return null;
    const native = pageNativeSizes.get(pendingSelection.page);
    if (!native) return null;
    const scale = pageWidth / native.width;
    return {
      left: pendingSelection.bbox[0] * scale,
      top: pendingSelection.bbox[1] * scale,
      bottom: pendingSelection.bbox[3] * scale,
      width: Math.max(4, (pendingSelection.bbox[2] - pendingSelection.bbox[0]) * scale),
    };
  }, [pendingSelection, pageNativeSizes, pageWidth]);

  // Block-edit overlay's own rect, in the same "relative to the target
  // page's own wrapper" terms BlockEditOverlay expects (that wrapper is
  // position:relative, see the page-loop render below) - recomputed from
  // pageNativeSizes so it tracks the page's CURRENT rendered width if
  // the panel is resized/expanded mid-edit.
  const overlayRect = useMemo(() => {
    if (!blockEditState) return null;
    const native = pageNativeSizes.get(blockEditState.page);
    if (!native) return null;
    const scale = pageWidth / native.width;
    return {
      left: blockEditState.bbox[0] * scale,
      top: blockEditState.bbox[1] * scale,
      width: Math.max(4, (blockEditState.bbox[2] - blockEditState.bbox[0]) * scale),
      height: Math.max(4, (blockEditState.bbox[3] - blockEditState.bbox[1]) * scale),
    };
  }, [blockEditState, pageNativeSizes, pageWidth]);

  return (
    <div
      ref={scrollRef}
      className="relative h-full overflow-y-auto px-6 py-6"
      onMouseUp={handleSelection}
    >
      {!mounted ? (
        <div className="flex h-40 items-center justify-center text-xs text-neutral-500">Loading preview…</div>
      ) : loadError ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-xs text-neutral-500">
          <p>Couldn't preview this file.</p>
          <p className="text-neutral-400">{loadError}</p>
        </div>
      ) : (
        <Document
          file={documentUrl}
          onLoadSuccess={({ numPages: n }) => setNumPages(n)}
          onLoadError={(err) => setLoadError(err.message)}
          loading={<div className="flex h-40 items-center justify-center text-xs text-neutral-500">Rendering document…</div>}
          className="flex flex-col items-center gap-4"
        >
          {numPages &&
            Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
              <div
                key={page}
                data-page-number={page}
                ref={(el) => {
                  if (el) {
                    pageWrapRefs.current.set(page, el);
                    restoreScrollIfPending(page);
                  } else {
                    pageWrapRefs.current.delete(page);
                  }
                }}
                className="relative overflow-hidden rounded-lg border border-neutral-950/10 bg-white shadow-sm"
              >
                <Page
                  pageNumber={page}
                  width={pageWidth}
                  renderAnnotationLayer
                  renderTextLayer
                  onLoadSuccess={(p: any) => {
                    setPageNativeSizes((prev) => {
                      const next = new Map(prev);
                      next.set(page, { width: p.originalWidth, height: p.originalHeight });
                      return next;
                    });
                    restoreScrollIfPending(page);
                  }}
                />
                {/* Selection command box - only on the page the pending
                    selection is actually on. */}
                {pendingSelection && pendingSelection.page === page && !blockEditState && pendingSelectionBlockRect && (
                  <SelectionCommandBox
                    blockRect={pendingSelectionBlockRect}
                    containerWidth={pageWidth}
                    placement="below"
                    onSubmit={(instruction) => {
                      const target = pendingSelection;
                      setPendingSelection(null);
                      window.getSelection()?.removeAllRanges();
                      onSubmitInstruction(
                        {
                          paragraphId: target.paragraphId,
                          page: target.page,
                          bbox: target.bbox,
                          selectedText: target.selectedText,
                          parentText: target.parentText,
                        },
                        instruction
                      );
                    }}
                    onDismiss={() => {
                      setPendingSelection(null);
                      window.getSelection()?.removeAllRanges();
                    }}
                  />
                )}

                {/* In-place beam/skeleton + alternatives popover for the
                    NEW selection-driven edit - only on the page the
                    target block is actually on, so it correctly follows
                    if the user scrolls between pages mid-edit. */}
                {blockEditState && blockEditState.page === page && overlayRect && (
                  <BlockEditOverlay
                    rect={overlayRect}
                    state={blockEditState}
                    headerLabel={
                      blockEditState.isExactReplacement
                        ? "Preview replacement"
                        : `Choose a revision — paragraph ${blockEditState.paragraphId}`
                    }
                    onChooseAlternative={onChooseAlternative}
                    onRejectEdit={onRejectEdit}
                    onUndoEdit={onUndoEdit}
                    onDismissEdit={onDismissEdit}
                  />
                )}
              </div>
            ))}
        </Document>
      )}
    </div>
  );
}

/**
 * The Report tab's own interactive view (2026-09-25 - REPLACES the report
 * PDF-canvas preview that used to render here, per the corrected brief:
 * "Do not rely only on visual PDF text... first expose the existing
 * structured report model" - `assessment` already exists as real JSON
 * (ChatInterface.tsx's ReviewSummaryChart already renders a truncated
 * version of it in the chat bubble), this just renders ALL of it, as
 * real DOM instead of a truncated preview, with each editable prose unit
 * selectable.
 *
 * Deliberately NOT built on InteractiveDocumentView's PDF-bbox approach
 * above - there is no PDF page/bbox to convert here in the first place
 * (a report block's local_id was always dummy page=0/bbox=[0,0,0,0], see
 * document_edit.py's build_report_blocks()), and real DOM makes this
 * simpler, not harder: each editable block is wrapped in its own
 * position:relative container carrying data-report-local-id, so
 * BlockEditOverlay is rendered as that SAME block's own child (rect is
 * just {0,0,width,height} - the block's own measured size) instead of
 * needing scroll-position-relative math the way a flat PDF canvas does.
 * Selection resolves to a block by walking up from the selection's
 * commonAncestorContainer to the nearest data-report-local-id, the DOM
 * equivalent of resolveBlockAtPoint()'s bbox-containment check above.
 *
 * Per the brief, only prose gets wrapped as editable at all - charts,
 * status counters, citations, page numbers, headings, generated ids and
 * the evidence table are all plain text/JSX with no data-report-local-id,
 * so they can never be selected into an edit; localIdFor() returning null
 * for anything build_report_blocks() didn't allocate an id for (an issue
 * with no suggested_change, a checklist item with no note) is what makes
 * that enforcement automatic rather than a separate flag to keep in sync.
 */
function StructuredReportView({
  assessment,
  reportBlocks,
  reportBlockEditState,
  onSubmitInstruction,
  onChooseAlternative,
  onRejectEdit,
  onDismissEdit,
  onRefine,
  onBackFromCustomPreview,
  reportUndoStacks,
  reportUndoErrors,
  onUndoReportBlock,
  onRedoReportBlock,
  geography,
  constraintSummary,
  isExpanded,
}: {
  assessment: { summary?: string | null; issues?: any[]; checklist?: any[] };
  reportBlocks: { localId: number; kind: string; index: number | null }[];
  reportBlockEditState?: DocumentPanelProps["reportBlockEditState"];
  onSubmitInstruction?: DocumentPanelProps["onSubmitReportInstruction"];
  onChooseAlternative?: (index: number) => void;
  onRejectEdit?: () => void;
  onDismissEdit?: () => void;
  onRefine?: DocumentPanelProps["onRefineReportEdit"];
  onBackFromCustomPreview?: DocumentPanelProps["onBackFromReportCustomPreview"];
  reportUndoStacks?: DocumentPanelProps["reportUndoStacks"];
  reportUndoErrors?: DocumentPanelProps["reportUndoErrors"];
  onUndoReportBlock?: DocumentPanelProps["onUndoReportBlock"];
  onRedoReportBlock?: DocumentPanelProps["onRedoReportBlock"];
  geography?: string | null;
  constraintSummary?: string | null;
  // 2026-09-27 (fullscreen Edit Workspace redesign): "editing is
  // available only in fullscreen mode... deliberate product behaviour,
  // not just a CSS difference." Threaded down from DocumentPanel's own
  // isExpanded (the panel's existing docked/fullscreen toggle - no new
  // fullscreen concept was introduced, this reuses it). When false, the
  // block click handler and the mouseup text-selection handler are both
  // never wired at all (not merely hidden), and the fullscreen footer
  // (composer + alternatives popup) is not part of the flow, so nothing
  // beneath it can be clicked through either.
  isExpanded: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Map<number, HTMLElement>>(new Map());
  // Renamed from pendingSelection (2026-09-27): it no longer means
  // "waiting to be submitted" - a click/selection now activates a block
  // for the WHOLE lifecycle (typing -> generating -> choosing ->
  // applying -> updated), matching the new bottom-composer model where
  // "the bottom bar becomes associated with that block" rather than a
  // per-paragraph command box that disappears the moment it's submitted.
  // It's only replaced by clicking a different block, or explicitly
  // deselected - see deselectActiveBlock below.
  const [activeBlock, setActiveBlock] = useState<{
    localId: number;
    kind: string;
    index: number | null;
    selectedText: string;
    parentText: string;
  } | null>(null);
  // "Select any paragraph to edit it with AI" - a small, temporary
  // discoverability cue, per the brief ("not a large tutorial modal...
  // disappear after the first successful selection/edit").
  const [hintDismissed, setHintDismissed] = useState(false);

  const roleByLocalId = useMemo(() => {
    const m = new Map<number, { kind: string; index: number | null }>();
    for (const b of reportBlocks) m.set(b.localId, { kind: b.kind, index: b.index });
    return m;
  }, [reportBlocks]);
  const localIdFor = useCallback(
    (kind: string, index: number | null) => {
      for (const b of reportBlocks) {
        if (b.kind === kind && b.index === index) return b.localId;
      }
      return null;
    },
    [reportBlocks]
  );

  // Drag-select a specific phrase within a block - still supported
  // as the more PRECISE way to target an edit, alongside the plain
  // click-to-select-the-whole-block path below (handleBlockClick).
  // Guarded by isExpanded (read-only outside fullscreen) and by
  // reportBlockEditState (don't let a new selection swap the active
  // block out from under an edit that's already in flight).
  const handleSelection = useCallback(() => {
    if (!isExpanded || reportBlockEditState) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = selection.toString().trim();
    if (!text) return;

    const range = selection.getRangeAt(0);
    let node: Node | null = range.commonAncestorContainer;
    let blockEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.dataset.reportLocalId) {
        blockEl = node;
        break;
      }
      node = node.parentNode;
    }
    if (!blockEl) return;
    const localId = Number(blockEl.dataset.reportLocalId);
    const role = roleByLocalId.get(localId);
    if (!role) return;

    setActiveBlock({
      localId,
      kind: role.kind,
      index: role.index,
      selectedText: text,
      parentText: blockEl.textContent || "",
    });
    setHintDismissed(true);
  }, [isExpanded, reportBlockEditState, roleByLocalId]);

  // Plain click - "click/select a report block -> block becomes active."
  // Only takes the whole-block text when the click didn't just complete
  // a drag-selection (handleSelection's mouseup already ran by the time
  // a click handler fires, and would have set a more precise
  // activeBlock for that case - this must not stomp it).
  const handleBlockClick = useCallback(
    (kind: string, index: number | null) => () => {
      if (!isExpanded || reportBlockEditState) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const localId = localIdFor(kind, index);
      if (localId == null) return;
      const role = roleByLocalId.get(localId);
      if (!role) return;
      const el = blockRefs.current.get(localId);
      const text = el?.textContent || "";
      setActiveBlock({ localId, kind: role.kind, index: role.index, selectedText: text, parentText: text });
      setHintDismissed(true);
    },
    [isExpanded, reportBlockEditState, localIdFor, roleByLocalId]
  );

  // The block currently being edited's own on-screen size - {0,0,w,h},
  // never a scroll-relative offset (contrast InteractiveDocumentView's
  // own overlayRect above): BlockGeneratingBeam is rendered as this SAME
  // block's own child below, so it only ever needs to fill its parent.
  const [overlaySize, setOverlaySize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!reportBlockEditState) {
      setOverlaySize(null);
      return;
    }
    const el = blockRefs.current.get(reportBlockEditState.localId);
    if (!el) {
      setOverlaySize(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setOverlaySize({ width: r.width, height: r.height });
  }, [reportBlockEditState?.localId, reportBlockEditState?.status]);

  const registerBlockRef = useCallback(
    (localId: number) => (el: HTMLElement | null) => {
      if (el) blockRefs.current.set(localId, el);
      else blockRefs.current.delete(localId);
    },
    []
  );

  const editableProps = (kind: string, index: number | null, extraClassName: string) => {
    const localId = localIdFor(kind, index);
    if (localId == null) return { className: extraClassName };
    const isActiveTarget = activeBlock?.localId === localId;
    if (!isExpanded) {
      // Read-only outside the fullscreen Edit Workspace (2026-09-27) -
      // deliberate product behaviour, not just a style difference: no
      // onClick is wired at all in this branch, so there is nothing for
      // a click to do here regardless of className. The ref/data
      // attribute stay so re-entering fullscreen can still measure/
      // target this same block without a remount.
      return {
        "data-report-local-id": localId,
        ref: registerBlockRef(localId),
        className: "relative rounded-2xl px-2 py-1 -mx-2 -my-1 " + extraClassName,
      } as any;
    }
    // Subtle "this is the block the bottom bar is editing" active state -
    // a background tint + a box-shadow ring, both of which paint without
    // affecting layout, so toggling this never changes the block's
    // height or remounts it (same `ref`/`data-report-local-id`/DOM node
    // throughout). Persists for the block's whole edit lifecycle now
    // (see activeBlock above), not just until an instruction is
    // submitted.
    return {
      "data-report-local-id": localId,
      ref: registerBlockRef(localId),
      onClick: handleBlockClick(kind, index),
      // rounded-2xl (DESIGN.md's own container radius token, 16px).
      // Padding + matching negative margin so the active/hover tint
      // reads as a slightly elevated surface around the text (item 4:
      // "slightly elevated surface... must still blend naturally with
      // the document") without shifting layout or affecting the text's
      // own position. Warm ink-tinted overlays (rgb(61 52 38/…), the
      // same formula as --rule) rather than Tailwind's cool neutral-950
      // - DESIGN.md: "never put a pure-black shadow on this ground."
      className:
        "relative cursor-text rounded-2xl px-2 py-1 -mx-2 -my-1 outline-none transition-[background-color,box-shadow] duration-200 ease-settle hover:bg-[rgb(61_52_38/0.035)] " +
        (isActiveTarget ? "bg-[rgb(61_52_38/0.05)] shadow-[inset_0_0_0_1px_var(--rule-strong)] " : "") +
        extraClassName,
    } as any;
  };

  const editingLocalId = reportBlockEditState?.localId ?? null;
  const renderGeneratingOverlay = () => {
    if (!reportBlockEditState || !overlaySize) return null;
    return (
      <BlockGeneratingBeam
        rect={{ left: 0, top: 0, width: overlaySize.width, height: overlaySize.height }}
        state={reportBlockEditState}
        onUndoEdit={() => onUndoReportBlock?.(reportBlockEditState.localId)}
      />
    );
  };

  // Persistent, timeout-independent Undo/Redo (2026-09-26) - rendered
  // for ANY block that has real stored history to walk, completely
  // independent of whether that block's own edit overlay is currently
  // open (it usually isn't - reportBlockEditState clears itself a
  // couple seconds after a successful apply, same as before, but that
  // no longer takes this capability away with it). Hidden while a
  // block's own overlay IS open, so its transient "✓ Updated  Undo"
  // badge is the only undo control visible for that one block at a
  // time - never two.
  const renderUndoRedoPill = (localId: number | null) => {
    // "Do not show block-edit command bars, editing prompts, or inline
    // edit controls in the normal split view" (2026-09-27) - Undo/Redo
    // is an editing control, so it's gated the same as everything else.
    if (!isExpanded || localId == null || localId === editingLocalId) return null;
    const stack = reportUndoStacks?.[localId];
    if (!stack) return null;
    const canUndo = stack.pointer > 0;
    const canRedo = stack.pointer < stack.revisionIds.length - 1;
    const error = reportUndoErrors?.[localId];
    if (!canUndo && !canRedo && !error) return null;
    return (
      <div className="mt-1.5 flex items-center gap-3 text-[11px]">
        {canUndo && (
          <button type="button" onClick={() => onUndoReportBlock?.(localId)} className="text-[var(--ink-muted)] transition hover:text-[var(--ink)]">
            Undo
          </button>
        )}
        {canRedo && (
          <button type="button" onClick={() => onRedoReportBlock?.(localId)} className="text-[var(--ink-muted)] transition hover:text-[var(--ink)]">
            Redo
          </button>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
    );
  };

  // 2026-09-27 (fullscreen Edit Workspace redesign): submitting no longer
  // clears activeBlock - the block stays associated with the bottom bar
  // through the whole generating/choosing/applying/updated lifecycle
  // ("the bottom bar becomes associated with that block"), only replaced
  // by selecting a different block or by an explicit deselect.
  const submitActiveInstruction = useCallback(
    (instruction: string) => {
      const target = activeBlock;
      if (!target) return;
      window.getSelection()?.removeAllRanges();
      onSubmitInstruction?.(
        {
          localId: target.localId,
          kind: target.kind,
          index: target.index,
          selectedText: target.selectedText,
          parentText: target.parentText,
        },
        instruction
      );
    },
    [activeBlock, onSubmitInstruction]
  );

  const deselectActiveBlock = useCallback(() => {
    setActiveBlock(null);
    window.getSelection()?.removeAllRanges();
    // Only actually dismiss an in-flight edit if one is open for this
    // block - never fire onDismissEdit speculatively when there's
    // nothing to dismiss.
    if (reportBlockEditState) onDismissEdit?.();
  }, [reportBlockEditState, onDismissEdit]);

  // Drives both FullscreenEditBar's placeholder/disabled state and
  // whether ReportAlternativesPopup should be showing - a single source
  // of truth for "what state is the one bottom composer in," per the
  // brief's own state table (item 8).
  type EditBarStatus = "no-selection" | "ready" | "generating" | "choosing" | "applying" | "updated" | "error";
  const activeEditState =
    reportBlockEditState && activeBlock && reportBlockEditState.localId === activeBlock.localId
      ? reportBlockEditState
      : null;
  const barStatus: EditBarStatus = !activeBlock
    ? "no-selection"
    : !activeEditState
    ? "ready"
    : activeEditState.status === "resolving"
    ? "generating"
    : activeEditState.status === "choosing"
    ? "choosing"
    : activeEditState.status === "applying"
    ? "applying"
    : activeEditState.status === "applied"
    ? "updated"
    : activeEditState.status === "error"
    ? "error"
    : "ready";

  const issues = assessment.issues || [];
  const checklist = assessment.checklist || [];
  const summaryLocalId = localIdFor("summary", null);

  // The alternatives/custom-refine popup - one instance, rendered above
  // the composer, not per block (item 6: "Do not inject the 3 options
  // inline into the report").
  const activeBlockHeaderLabel = (() => {
    if (!activeBlock) return "Choose a revision";
    if (activeBlock.kind === "summary") return "Choose a revision — summary";
    if (activeBlock.kind === "issue_explanation") {
      const iss = issues[activeBlock.index ?? -1];
      return `Choose a revision — ${iss?.topic || "issue"}`;
    }
    if (activeBlock.kind === "issue_suggested_change") return "Choose a revision — suggested change";
    if (activeBlock.kind === "checklist_note") {
      const c = checklist[activeBlock.index ?? -1];
      return `Choose a revision — ${c?.item || "checklist item"}`;
    }
    return "Choose a revision";
  })();
  const alternativesPopup =
    activeEditState && (barStatus === "choosing" || barStatus === "error") ? (
      <ReportAlternativesPopup
        state={activeEditState}
        headerLabel={activeEditState.isExactReplacement ? "Preview replacement" : activeBlockHeaderLabel}
        onChooseAlternative={onChooseAlternative}
        onRejectEdit={onRejectEdit}
        onDismissEdit={onDismissEdit}
        onRefine={onRefine}
        onBackFromCustomPreview={onBackFromCustomPreview}
      />
    ) : null;

  // Reserves exactly enough space at the bottom of the scrollable
  // document (and sizes the fade layer to match, below) for the
  // floating composer's REAL rendered height - not a guessed constant -
  // so the last block is always fully reachable whether the composer is
  // a single line, a grown multiline instruction, or has the
  // alternatives popup open above it (which can be considerably
  // taller). 160px is just the pre-measurement default for first paint.
  // Measured by FloatingComposerShell itself now (onMeasure below) - see
  // that component's own docstring for why this replaced a hand-rolled
  // ResizeObserver effect that used to live here.
  const [composerReserve, setComposerReserve] = useState(160);

  return (
    // Three-layer floating composer (2026-09-28 redesign, replacing the
    // previous docked-footer-row layout - "behave like a true floating
    // ChatGPT/Claude-style input... the document to keep scrolling
    // behind the composer... no full-width solid footer background"):
    //   1. this scroll container - the document, full height, with
    //      dynamic bottom padding (composerReserve, measured above) so
    //      the last block always clears the floating composer + fade;
    //   2. a non-interactive fade/blur layer, absolutely positioned at
    //      the bottom of this same relative wrapper (a sibling of the
    //      scroll div, not inside it, so it stays put while layer 1
    //      scrolls behind it) - see the fade div below;
    //   3. the composer itself, also absolutely positioned at the
    //      bottom, centered, floating above both - see the wrapper
    //      around FullscreenEditBar further down.
    // FullscreenEditBar/its alternatives popup are still always mounted
    // (only hidden via CSS outside fullscreen, never unmounted) so
    // typed-but-unsubmitted text and an open popup survive an exit/
    // re-enter-fullscreen round trip, same guarantee as before.
    //
    // 2026-09-27, "premium redesign" pass (items 1-3, 9, 13): reading
    // width widened from 1000px to the brief's 960-1120px target
    // (1080px); card surface moved from plain Tailwind white/neutral-950
    // to the actual warm-paper tokens (--paper-raised, --rule,
    // shadow-paper-*) DESIGN.md already specifies but this view wasn't
    // using; section spacing opened up (space-y-6 -> space-y-10, plus a
    // hairline before each section instead of relying on space alone);
    // typography given a real scale (report title / section eyebrow /
    // issue title / body all now visually distinct, not everything at
    // text-sm).
    <div className="relative flex h-full flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-10"
        style={isExpanded ? { paddingBottom: composerReserve } : undefined}
        onMouseUp={handleSelection}
      >
        <div
          className="mx-auto"
          style={isExpanded ? { width: "min(94vw, 1080px)" } : undefined}
        >
          <div
            className={
              isExpanded
                ? "mx-auto max-w-[1080px] space-y-10 rounded-2xl border border-[var(--rule)] bg-[var(--paper-raised)] p-10 shadow-paper-md"
                : "mx-auto max-w-2xl space-y-6 rounded-xl border border-[var(--rule)] bg-[var(--paper-raised)] p-6 shadow-paper-sm"
            }
          >
            {!hintDismissed && isExpanded && (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--paper-sunken)] px-4 py-2.5 text-[12px] text-[var(--ink-secondary)]">
                <span>Select any paragraph below to edit it with AI.</span>
                <button
                  type="button"
                  onClick={() => setHintDismissed(true)}
                  className="shrink-0 text-[var(--ink-faint)] transition hover:text-[var(--ink-secondary)]"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">Proposal Compliance Review</h2>
              {(geography || constraintSummary) && (
                <p className="mt-1.5 text-[13px] text-[var(--ink-muted)]">
                  {[geography, constraintSummary].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>

            {assessment.summary && (
              <section>
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Summary</h3>
                <div {...editableProps("summary", null, isExpanded ? "text-base leading-relaxed text-[var(--ink-secondary)]" : "text-sm leading-relaxed text-[var(--ink-secondary)]")}>
                  {assessment.summary}
                  {editingLocalId === summaryLocalId && renderGeneratingOverlay()}
                </div>
                {renderUndoRedoPill(summaryLocalId)}
              </section>
            )}

            {issues.length > 0 && (
              <section className={isExpanded ? "border-t border-[var(--rule)] pt-10" : ""}>
                <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">
                  Issues ({issues.length})
                </h3>
                <div className="space-y-5">
                  {issues.map((iss, i) => {
                    const explLocalId = localIdFor("issue_explanation", i);
                    const changeLocalId = localIdFor("issue_suggested_change", i);
                    return (
                      <div
                        key={i}
                        className={
                          isExpanded
                            ? "rounded-xl border border-[var(--rule)] p-5"
                            : "border-b border-[var(--rule)] pb-4 last:border-0 last:pb-0"
                        }
                      >
                        {iss.topic && <p className="mb-2 text-[15px] font-semibold text-[var(--ink)]">{iss.topic}</p>}
                        <div {...editableProps("issue_explanation", i, isExpanded ? "text-base leading-relaxed text-[var(--ink-secondary)]" : "text-sm leading-relaxed text-[var(--ink-secondary)]")}>
                          {iss.issue}
                          {editingLocalId === explLocalId && renderGeneratingOverlay()}
                        </div>
                        {renderUndoRedoPill(explLocalId)}
                        {iss.verified === true && (
                          <span className="mt-1.5 inline-block text-[11px] text-emerald-600">✓ verified</span>
                        )}
                        {iss.verified === false && (
                          <span
                            className="mt-1.5 inline-block text-[11px] text-amber-600"
                            title={iss.verification_note || undefined}
                          >
                            ⚠ needs a second look
                          </span>
                        )}
                        {iss.suggested_change && (
                          <div className="mt-3 rounded-xl bg-[var(--paper-sunken)] p-4">
                            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                              Suggested change
                            </p>
                            <div {...editableProps("issue_suggested_change", i, isExpanded ? "text-base leading-relaxed text-[var(--ink-secondary)]" : "text-sm leading-relaxed text-[var(--ink-secondary)]")}>
                              {iss.suggested_change}
                              {editingLocalId === changeLocalId && renderGeneratingOverlay()}
                            </div>
                            {renderUndoRedoPill(changeLocalId)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {checklist.length > 0 && (
              <section className={isExpanded ? "border-t border-[var(--rule)] pt-10" : ""}>
                <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]">Checklist</h3>
                <div className="divide-y divide-[var(--rule)]">
                  {checklist.map((c, i) => {
                    const noteLocalId = localIdFor("checklist_note", i);
                    return (
                      <div key={i} className="flex items-start gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
                        <span
                          className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                          style={{ backgroundColor: REPORT_STATUS_COLORS[c.status] || "#898781" }}
                        >
                          {REPORT_STATUS_ICON[c.status] || "?"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-[var(--ink)]">{c.item}</span>
                          {c.note && (
                            <div {...editableProps("checklist_note", i, isExpanded ? "mt-0.5 text-sm leading-relaxed text-[var(--ink-muted)]" : "mt-0.5 text-xs leading-relaxed text-[var(--ink-muted)]")}>
                              {c.note}
                              {editingLocalId === noteLocalId && renderGeneratingOverlay()}
                            </div>
                          )}
                          {renderUndoRedoPill(noteLocalId)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      {/* Layer 2 - fade/blend zone: makes the document's text disappear
          behind the floating composer instead of hitting a hard edge.
          Height tracks composerReserve (the composer's own real
          measured height, computed above) so it always covers exactly
          the zone the composer occupies, including when the
          alternatives popup grows it taller. Purely decorative -
          pointer-events-none, and a sibling of the scroll div (not
          nested inside it) so it stays fixed in place while the
          document scrolls behind it. Endpoint color matches this
          workspace's own background (bg-neutral-100, set on the
          measureRef wrapper in DocumentPanel below) rather than the
          warm-paper token, since that's what's actually visible behind
          the report card out here. */}
      {/* Layers 2+3 (fade + floating composer) - now FloatingComposerShell,
          the same shell components/chat/MainChatComposer.tsx uses for the
          main chat composer (2026-09-28 unify-composers pass: "the report
          editor retains its specialized editing controls" - FullscreenEditBar
          itself, its --paper-raised/--rule card styling and its own
          alternatives popup - while the shell now owns positioning, fade
          and z-index for both composers). `bare` because FullscreenEditBar
          already supplies its own fully-styled card; the shell here only
          contributes structure. `visible={isExpanded}` (not a conditional
          unmount) so FullscreenEditBar's own in-progress state survives an
          exit/re-enter-fullscreen round trip exactly as it did before this
          refactor. */}
      <FloatingComposerShell
        visible={isExpanded}
        onMeasure={(h) => setComposerReserve(Math.ceil(h))}
        fadeBackground="rgb(245 245 245)"
        maxWidthPx={720}
        bare
        bottomOffsetPx={24}
      >
        <FullscreenEditBar
          activeBlock={activeBlock}
          barStatus={barStatus}
          errorMessage={activeEditState?.status === "error" ? activeEditState.errorMessage : null}
          popup={alternativesPopup}
          onSubmit={submitActiveInstruction}
          onDeselect={deselectActiveBlock}
          isExpanded={isExpanded}
        />
      </FloatingComposerShell>
    </div>
  );
}

export default function DocumentPanel({
  url,
  filename,
  documentUrl,
  documentFilename,
  onClose,
  isCollapsed,
  onToggleCollapse,
  editState,
  onChooseAlternative,
  onRejectEdit,
  onUndoEdit,
  onDismissEdit,
  documentParagraphs,
  blockEditState,
  onSubmitBlockInstruction,
  onChooseBlockAlternative,
  onRejectBlockEdit,
  onUndoBlockEdit,
  onDismissBlockEdit,
  assessment,
  reportGeography,
  reportConstraintSummary,
  reportBlocks,
  reportBlockEditState,
  onSubmitReportInstruction,
  onChooseReportAlternative,
  onRejectReportEdit,
  onUndoReportEdit,
  onDismissReportEdit,
  onRefineReportEdit,
  onBackFromReportCustomPreview,
  reportUndoStacks,
  reportUndoErrors,
  onUndoReportBlock,
  onRedoReportBlock,
  isExpanded,
  onToggleExpanded,
  viewMode,
  onViewModeChange,
}: DocumentPanelProps) {
  const [mounted, setMounted] = useState(false);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageWidth, setPageWidth] = useState(600);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloadingDocument, setIsDownloadingDocument] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // "Report" (the AI-GENERATED compliance report - editable, see
  // StructuredReportView above) vs "Document" (the uploaded SOURCE,
  // read-only reference). 2026-09-25 CORRECTION: earlier the same day
  // this was built the other way around (Document tab editable via
  // InteractiveDocumentView) - the product owner corrected that
  // explicitly: "the current tab meanings are: Document = original
  // uploaded source document, Report = AI-generated compliance report...
  // the inline editing experience must be implemented in the Report tab,
  // not the Document tab." InteractiveDocumentView/blockEditState above
  // are kept in the file, unused by this render, rather than deleted -
  // "unless there is a separate explicit future feature for that"
  // editing the source. Defaults to "report" - unchanged default, just a
  // different thing renders there now.

  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // documentUrl's plain PDF preview (Document tab) and url's own plain PDF
  // fallback (Report tab, only when assessment is missing - an older/
  // legacy review) now SHARE numPages/loadError, since only one of the two
  // ever renders at a time - reset both on a tab switch so a stale error
  // or page count from the other file never bleeds across.
  useEffect(() => {
    setLoadError(null);
    setNumPages(null);
  }, [viewMode]);

  // react-pdf/pdfjs touch canvas/DOMMatrix APIs that don't exist during
  // Next.js's server render - only render the actual PDF once mounted in
  // the browser.
  useEffect(() => setMounted(true), []);

  // Size pages to the available panel width rather than a fixed px value,
  // so the panel stays usable both docked (~narrower) and expanded
  // (~fullscreen). Shared by both tabs - same measured container.
  useEffect(() => {
    if (!measureRef.current) return;
    const el = measureRef.current;
    const update = () => setPageWidth(Math.max(320, el.clientWidth - 48));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isExpanded]);

  // Tracks which page is most visible in the scroll area so the "Page N /
  // M" pill reflects real scroll position (continuous-scroll viewer, not
  // a paginated one) rather than only updating on an explicit next/prev
  // click. Whichever tab currently renders a real paginated PDF (Document
  // tab always; Report tab only in the no-`assessment` fallback, see the
  // body render below) - StructuredReportView isn't a paginated PDF at
  // all, so this pill has nothing to track there.
  useEffect(() => {
    const showsPaginatedPdf = viewMode === "document" || (viewMode === "report" && !assessment);
    if (!mounted || !numPages || !scrollRef.current || !showsPaginatedPdf) return;
    const root = scrollRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { page: number; ratio: number } | null = null;
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (!page) continue;
          if (entry.isIntersecting && (!best || entry.intersectionRatio > best.ratio)) {
            best = { page, ratio: entry.intersectionRatio };
          }
        }
        if (best) setCurrentPage(best.page);
      },
      { root, threshold: [0.15, 0.3, 0.5, 0.75, 1] }
    );
    pageRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [mounted, numPages, viewMode, assessment]);

  const goToPage = useCallback((page: number) => {
    const el = pageRefs.current.get(page);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Fall back to a plain navigation if the fetch/blob path fails
      // (e.g. a CORS quirk) - still gets the user the file.
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setIsDownloading(false);
    }
  }, [url, filename]);

  // Same fetch-blob-download pattern as handleDownload above, pointed at
  // the uploaded document instead of the report - see documentUrl's own
  // prop comment for why this is a second button, not a second view.
  const handleDownloadDocument = useCallback(async () => {
    if (!documentUrl) return;
    setIsDownloadingDocument(true);
    try {
      const res = await fetch(documentUrl);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = documentFilename || "document.pdf";
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(documentUrl, "_blank", "noopener,noreferrer");
    } finally {
      setIsDownloadingDocument(false);
    }
  }, [documentUrl, documentFilename]);

  // Fullscreen (isExpanded) used to be `width: 100%` as an ordinary flex
  // item in the SAME row as ConversationSidebar/the chat column - which
  // meant "fullscreen" never actually left that row: the sidebar and
  // chat column just got squeezed to a near-zero-width sliver instead of
  // disappearing, and the chat column's own absolutely-positioned
  // floating composer (still measured/placed relative to that squeezed
  // sliver) rendered as a visible strip bleeding out at the edge,
  // painting over the report's own header/tabs/edit composer. Confirmed
  // live via a throwaway diagnostic build (2026-09-28) before this fix -
  // see zIndex.ts's FULLSCREEN_OVERLAY comment for the full writeup.
  //
  // Fixed structurally, not with a z-index bump: fullscreen now renders
  // via `fixed inset-0`, a true viewport-covering overlay OUTSIDE the
  // flex row entirely, so the sidebar/chat column (and anything
  // positioned relative to them) are fully covered regardless of the
  // row's own width math - not a magic pixel offset, `inset: 0` IS the
  // correct relationship for "cover the whole workspace," the same way
  // `min-w-0`/`flex-1` describe relationships instead of fixed widths
  // elsewhere in this split view. isCollapsed still wins over isExpanded
  // (unchanged precedence) - collapsing takes you out of fullscreen
  // rather than showing a fullscreen rail, which would make no sense.
  const isFullscreenOverlay = isExpanded && !isCollapsed;

  return (
    <div
      className={
        isFullscreenOverlay
          ? "fixed inset-0 flex h-full min-w-0 flex-col bg-[var(--paper)]"
          : "flex h-full min-w-0 flex-col border-l border-[var(--rule)] bg-[var(--paper)] transition-[width] duration-200 ease-settle " +
            (isCollapsed ? "w-14" : "w-full max-w-3xl")
      }
      style={isFullscreenOverlay ? { zIndex: Z.FULLSCREEN_OVERLAY } : undefined}
    >
      {/* Collapsed rail (see isCollapsed's own prop comment above) - a thin
          icon strip standing in for the full panel, mirroring
          ConversationSidebar.tsx's own collapsed-rail treatment on the
          opposite edge. Only its visibility class toggles; the full panel
          below stays mounted the whole time (see the "hidden"/"flex"
          swap below it), so the PDF is never re-fetched/re-rendered just
          because you hid and reopened it. */}
      <div
        className={
          "h-full flex-col items-center gap-2 border-l border-[var(--rule)] bg-[var(--paper-raised)] py-3 " +
          (isCollapsed ? "flex" : "hidden")
        }
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label="Show report preview"
          title="Show report preview"
          className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ink-secondary)] shadow-paper-xs transition-[background-color,box-shadow,color] duration-200 ease-settle hover:bg-[var(--paper-sunken)] hover:text-[var(--ink)] hover:shadow-paper-sm"
        >
          <PanelIcon className="h-4 w-4 rotate-180" />
        </button>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--paper-sunken)] text-[var(--ink-muted)]">
          <ReportIcon className="h-4 w-4" />
        </div>
      </div>

      {/* Full panel - hidden (but still mounted, see above) while collapsed. */}
      <div className={"h-full min-w-0 flex-1 flex-col " + (isCollapsed ? "hidden" : "flex")}>
      {/* Header - title/type on the left, collapse + download + expand + close
          on the right, matching this app's existing rounded/neutral chrome
          (see DiagramDisplay). */}
      <div
        className="relative flex items-center justify-between gap-3 border-b border-[var(--rule)] bg-[var(--paper)] px-4 py-3"
        style={{ zIndex: Z.PANEL_HEADER }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--paper-sunken)] text-[var(--ink-secondary)]">
            <ReportIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--ink)]">
              {humanizeTitle(filename)}
            </p>
            <p className="text-[11px] text-[var(--ink-muted)]">
              {filename.split(".").pop()?.toUpperCase() || "FILE"}
              {numPages && (viewMode === "document" || (viewMode === "report" && !assessment)) ? ` · ${numPages} page${numPages === 1 ? "" : "s"}` : ""}
              {" · Compliance report"}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Hide report preview"
            title="Hide report preview (you can bring it back from the rail on the right)"
            className="press flex h-8 w-8 items-center justify-center rounded-xl text-[var(--ink-secondary)] transition-colors duration-200 ease-settle hover:bg-[var(--paper-sunken)]"
          >
            <PanelIcon className="h-4 w-4" />
          </button>
          {documentUrl && (
            <button
              type="button"
              onClick={handleDownloadDocument}
              disabled={isDownloadingDocument}
              title="Download the document you uploaded - with any edits applied (a different file from the report shown below)"
              className="press inline-flex items-center gap-1.5 rounded-full border border-[var(--rule)] bg-[var(--paper)] px-3 py-1.5 text-xs font-medium text-[var(--ink-secondary)] transition-colors duration-200 ease-settle hover:bg-[var(--paper-sunken)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileIcon className="h-3.5 w-3.5" />
              {isDownloadingDocument ? "Preparing..." : "Document"}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={isDownloading}
            title="Download this compliance report - the one shown below"
            className="press inline-flex items-center gap-1.5 rounded-full bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--accent-contrast)] transition-opacity duration-200 ease-settle hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            {isDownloading ? "Preparing..." : "Download"}
          </button>
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-label={isExpanded ? "Collapse panel" : "Expand panel"}
            className="press flex h-8 w-8 items-center justify-center rounded-xl text-[var(--ink-secondary)] transition-colors duration-200 ease-settle hover:bg-[var(--paper-sunken)]"
          >
            {isExpanded ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
          </button>
          {/* No destructive "close panel" control here any more - see
              item 3 of the 2026-09-27 fullscreen-composer fix pass:
              "I accidentally closed the document/report pane and then
              had no obvious way to bring it back." This button used to
              call onClose (setDocumentPanel(null) in ChatInterface.tsx),
              which fully unmounts this component - including the
              collapsed rail's own reopen button above, so it was the
              one truly unrecoverable dead end in an otherwise-safe UI.
              onClose is left wired in ChatInterface.tsx/DocumentPanelProps
              (still used for the legitimate "start a new chat/review"
              reset paths) but nothing in this header calls it any more -
              onToggleCollapse (the button just above) is now the only
              user-facing way to dismiss the panel, and it's always
              recoverable from the rail. */}
        </div>
      </div>

      {/* Report/Document tab toggle - 2026-09-25, only shown when there's
          an editable document to show a second tab for at all. Report
          stays the default/first tab, unchanged. */}
      {documentUrl && (
        <div
          className="relative flex items-center justify-between gap-2 border-b border-[var(--rule)] bg-[var(--paper)] px-4 pt-2"
          style={{ zIndex: Z.PANEL_HEADER }}
        >
          <div className="flex gap-1">
            {(["report", "document"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onViewModeChange(mode)}
                className={
                  "rounded-t-lg px-3 py-1.5 text-xs font-medium transition-colors duration-200 ease-settle " +
                  (viewMode === mode
                    ? "border-b-2 border-[var(--ink)] text-[var(--ink)]"
                    : "border-b-2 border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]")
                }
              >
                {mode === "report" ? "Report" : "Document"}
              </button>
            ))}
          </div>
          {/* 2026-09-27 (fullscreen Edit Workspace redesign, item 9): "keep
              the fullscreen toolbar simple... optionally show 'Edit mode'
              as an active-state indicator, but not as another big
              button." A small non-interactive pill, not a control -
              fullscreen already implies editing, this just confirms it. */}
          {isExpanded && viewMode === "report" && (
            <span className="mb-1.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
              Edit mode
            </span>
          )}
        </div>
      )}

      {/* "Editing this paragraph" card (2026-09-25, architecture plan
          section 53 Phase 2/3) - a distinct region of its own between the
          header and the report body, never replacing or hiding either,
          so the report stays visible the whole time an edit is in
          flight. See EditingBlockCard's own docstring above. This is the
          CHAT-DRIVEN path's own card - shown regardless of which tab is
          active, since a chat-driven edit can be submitted from either. */}
      {editState && (
        <EditingBlockCard
          editState={editState}
          documentUrl={documentUrl}
          onChooseAlternative={onChooseAlternative}
          onRejectEdit={onRejectEdit}
          onUndoEdit={onUndoEdit}
          onDismissEdit={onDismissEdit}
        />
      )}

      {/* Body - 2026-09-25 CORRECTION: the Document tab is now the plain,
          read-only PDF preview of the uploaded SOURCE (documentUrl) - no
          selection/editing UI, see the viewMode comment above for why.
          The Report tab (default) now renders StructuredReportView - the
          editable AI-generated report - instead of the report's own PDF
          canvas; that PDF-of-`url` rendering is kept, unmodified, as a
          fallback for a review with no `assessment` (an older review, or
          one whose report-block persistence failed server-side - see
          service.py's own best-effort comment). */}
      <div
        ref={measureRef}
        className="relative flex-1 overflow-hidden bg-neutral-100"
        style={{ zIndex: Z.PANEL_CONTENT }}
      >
        {viewMode === "document" && documentUrl ? (
        <div ref={scrollRef} className="h-full overflow-y-auto px-6 py-6">
          {!mounted ? (
            <div className="flex h-40 items-center justify-center text-xs text-neutral-500">
              Loading preview…
            </div>
          ) : loadError ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-xs text-neutral-500">
              <p>Couldn't preview this file.</p>
              <p className="text-neutral-400">{loadError}</p>
              <button
                type="button"
                onClick={handleDownloadDocument}
                className="mt-1 rounded-xl border border-neutral-950/10 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-950/5"
              >
                Download instead
              </button>
            </div>
          ) : (
            <Document
              file={documentUrl}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              onLoadError={(err) => setLoadError(err.message)}
              loading={
                <div className="flex h-40 items-center justify-center text-xs text-neutral-500">
                  Rendering document…
                </div>
              }
              className="flex flex-col items-center gap-4"
            >
              {numPages &&
                Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
                  <div
                    key={page}
                    data-page-number={page}
                    ref={(el) => {
                      if (el) pageRefs.current.set(page, el);
                      else pageRefs.current.delete(page);
                    }}
                    className="overflow-hidden rounded-lg border border-neutral-950/10 bg-white shadow-sm"
                  >
                    <Page
                      pageNumber={page}
                      width={pageWidth}
                      renderAnnotationLayer
                      renderTextLayer
                    />
                  </div>
                ))}
            </Document>
          )}
        </div>
        ) : assessment ? (
          <StructuredReportView
            assessment={assessment}
            reportBlocks={reportBlocks || []}
            reportBlockEditState={reportBlockEditState}
            onSubmitInstruction={onSubmitReportInstruction}
            onChooseAlternative={onChooseReportAlternative}
            onRejectEdit={onRejectReportEdit}
            onDismissEdit={onDismissReportEdit}
            onRefine={onRefineReportEdit}
            onBackFromCustomPreview={onBackFromReportCustomPreview}
            reportUndoStacks={reportUndoStacks}
            reportUndoErrors={reportUndoErrors}
            onUndoReportBlock={onUndoReportBlock}
            onRedoReportBlock={onRedoReportBlock}
            geography={reportGeography}
            constraintSummary={reportConstraintSummary}
            isExpanded={isExpanded}
          />
        ) : (
        <div ref={scrollRef} className="h-full overflow-y-auto px-6 py-6">
          {!mounted ? (
            <div className="flex h-40 items-center justify-center text-xs text-neutral-500">
              Loading preview…
            </div>
          ) : loadError ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-xs text-neutral-500">
              <p>Couldn't preview this file.</p>
              <p className="text-neutral-400">{loadError}</p>
              <button
                type="button"
                onClick={handleDownload}
                className="mt-1 rounded-xl border border-neutral-950/10 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-950/5"
              >
                Download instead
              </button>
            </div>
          ) : (
            <Document
              file={url}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              onLoadError={(err) => setLoadError(err.message)}
              loading={
                <div className="flex h-40 items-center justify-center text-xs text-neutral-500">
                  Rendering PDF…
                </div>
              }
              className="flex flex-col items-center gap-4"
            >
              {numPages &&
                Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
                  <div
                    key={page}
                    data-page-number={page}
                    ref={(el) => {
                      if (el) pageRefs.current.set(page, el);
                      else pageRefs.current.delete(page);
                    }}
                    className="overflow-hidden rounded-lg border border-neutral-950/10 bg-white shadow-sm"
                  >
                    <Page
                      pageNumber={page}
                      width={pageWidth}
                      renderAnnotationLayer
                      renderTextLayer
                    />
                  </div>
                ))}
            </Document>
          )}
        </div>
        )}

        {/* Page indicator + prev/next, floating bottom-right like the
            reference layout - shown for whichever tab is currently
            rendering a real paginated PDF (Document tab always; Report
            tab only in the no-`assessment` fallback above), once we
            actually know the page count. */}
        {(viewMode === "document" || (viewMode === "report" && !assessment)) && numPages ? (
          <div className="pointer-events-none absolute bottom-4 right-4 flex items-center gap-1 rounded-full border border-neutral-950/10 bg-white/95 px-1 py-1 text-xs text-neutral-700 shadow-md backdrop-blur">
            <button
              type="button"
              onClick={() => goToPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full transition hover:bg-neutral-950/10 disabled:opacity-30"
              aria-label="Previous page"
            >
              ‹
            </button>
            <span className="px-1.5 tabular-nums">
              Page {currentPage} / {numPages}
            </span>
            <button
              type="button"
              onClick={() => goToPage(Math.min(numPages, currentPage + 1))}
              disabled={currentPage >= numPages}
              className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full transition hover:bg-neutral-950/10 disabled:opacity-30"
              aria-label="Next page"
            >
              ›
            </button>
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}
