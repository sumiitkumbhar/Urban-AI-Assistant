"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
// MIT, npm install thinking-orbs - free, no paid tier needed for the base
// <ThinkingOrb> component (verified in node_modules/thinking-orbs/LICENSE
// and package.json before adding, per this project's zero-cost rule).
// Deliberately not using its `gravity` prop (a cursor-deform effect) - it
// needs a pixel-perfect raster of this app's actual OS pointer or the
// swap is visibly wrong, which is more than this pass needs to take on.
import { ThinkingOrb } from "thinking-orbs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import SourcesSection from "@/components/citations/SourcesSection";
import InlineCitation from "@/components/citations/InlineCitation";
import { getConfidenceTier } from "@/components/citations/ExpandableCitation";
import ConversationSidebar from "@/components/chat/ConversationSidebar";
import { getVisitorId } from "@/lib/visitorId";
import { useVoiceChat, sanitizeForSpeech } from "@/lib/useVoiceChat";
import VoiceModeOverlay, {
  type VoiceOverlayState,
} from "@/components/chat/VoiceModeOverlay";
import VoiceAgentOverlay from "@/components/chat/VoiceAgentOverlay";
import DocumentPanel, { type DocumentBlock } from "@/components/chat/DocumentPanel";
import { FloatingComposerShell } from "@/components/chat/FloatingComposerShell";
import { MainChatComposerBar, MainChatComposerContext } from "@/components/chat/MainChatComposer";
// ---------------------------------------------------------------------------
// FEATURE FLAGS - unfinished functionality
// ---------------------------------------------------------------------------
// Each flag below gates UI whose backing API route does not exist in this
// repo. With the flag off, the control is not rendered at all, so the app
// never advertises a capability that silently does nothing.
//
// Nothing is deleted: every code path behind these flags is intact and
// becomes reachable again the moment its route is implemented and the flag
// is flipped to true.
//
//   modeSelector     needs /api/feasibility AND /api/analyze-drawing.
//                    Note: of the four modes offered, only "feasibility" was
//                    ever wired to anything - "permitting" and "risk" have no
//                    code path anywhere in app/api/rag-chat/route.ts, so they
//                    behaved identically to "auto".
//   drawingAnalysis  needs /api/analyze-drawing
//   diagramSvgFetch  needs /api/diagram/svg  (inline diagrams that arrive with
//                    server-rendered svgContent still render - this only gates
//                    the client-side re-fetch, which always 404'd)
//   diagramPngExport needs /api/diagram/png
const FEATURES: Record<
  | "modeSelector"
  | "drawingAnalysis"
  | "diagramSvgFetch"
  | "diagramPngExport"
  | "ragSourceToggle"
  | "localStreamingAnswers"
  | "liquidGlassComposer",
  boolean
> = {
  modeSelector: false,
  drawingAnalysis: false,
  diagramSvgFetch: false,
  diagramPngExport: false,
  // Lets the user switch between the cloud RAG stack (Supabase + Google
  // embeddings + Groq, app/api/rag-chat) and the offline local-rag stack
  // (Qdrant + BM25 + local reranker + Groq synthesis, app/api/local-rag-chat
  // - see local-rag/README.md). Local mode requires the local-rag FastAPI
  // service running separately (uvicorn service:app --port 8010) and only
  // covers plain Q&A, not feasibility/drawing analysis.
  ragSourceToggle: true,
  // Streams local mode's answer token-by-token via
  // /api/local-rag-chat/stream (SSE, proxying local-rag/service.py's
  // /query/stream - see that route's comments) instead of waiting for the
  // full response and fake-revealing it with useTypedText's typewriter
  // effect (see MessageBubble below - skipTypewriter is set true for a
  // streamed message since the reveal is now real, not simulated). Off
  // falls back to the existing non-streaming /api/local-rag-chat path.
  // Cloud mode and feasibility/drawing-analysis mode are unaffected either
  // way - neither backend route streams yet.
  localStreamingAnswers: true,
  // 2026-09-28 Liquid Glass proof of concept (see
  // components/chat/LiquidGlassSurface.tsx) - scoped to the main chat
  // composer only via FloatingComposerShell's `glass` prop.
  //
  // 2026-09-29: DEFAULTS FALSE as of the geometry-then-material pass.
  // Honesty-clause finding (LiquidGlassSurface.tsx file header, point 7):
  // `?liquidGlassDebug=1` - every shader parameter exaggerated ~2x - was
  // still visually indistinguishable from the plain CSS frosted-glass
  // material (app/globals.css `.uaa-glass-pill`) in a live side-by-side
  // against real chat content, so the library (stale one-shot html2canvas
  // snapshot, no destroy/cleanup, WebGL1-only) was not earning its
  // complexity as the default. The CSS material is now the shipped look;
  // this flag - and the whole WebGL path behind it - is kept, not deleted,
  // and reachable per-load via `?liquidGlass=on` (FloatingComposerShell's
  // readForceGlassOnParam) for a future revisit without editing source.
  liquidGlassComposer: false,
};

export interface Citation {
  id: string | number;
  title: string;
  type: string;
  pageNumber?: number;
  clauseNumber?: string;
  section?: string;
  fullText: string;
  excerpt: string;
  confidence: number;
  lastUpdated: string;
  directLink?: string;
  _raw?: any;
}

export type DiagramKind = "annotated_object" | "buildable_envelope";

export interface DiagramPayload {
  kind: DiagramKind;
  spec: any;
  title?: string;
}

export interface DiagramData {
  kind: DiagramKind;
  spec: any;
  title?: string;
  svgContent?: string;
}

// A rendered map image local-rag matched to the site/constraints this
// answer is about (see local-rag/site_context.py's
// _find_map_citations() and map_images.py) - imageUrl already points at
// the local-rag service's own origin (see app/api/local-rag-chat/
// route.ts and .../stream/route.ts's transformMapCitations()), so it
// can be dropped straight into an <img src>. imageUrl is null when the
// PDF exists in data/map_documents.json but couldn't be rendered
// (missing PyMuPDF/Pillow, bad PDF, etc - see map_images.py's
// render_map_image() docstring) - callers fall back to just naming the
// document in that case.
export interface MapCitation {
  filename: string;
  docType?: string;
  domain?: string;
  geography?: string;
  imageUrl?: string | null;
}

export interface ChatMessage {
  id: string;
  type: "user" | "assistant";
  content: string;
  timestamp: Date;
  // True for messages loaded from a saved conversation (see
  // handleSelectConversation) - they already exist in full, so the
  // word-by-word reveal (meant for a genuinely new answer arriving) is
  // skipped and they render instantly instead of "re-typing" old text.
  skipTypewriter?: boolean;
  metadata?: {
    processingtime?: number;
    confidence?: number;
    groundedness?: number | null;
    unsupportedClaims?: string[];
    citations?: Citation[];
    // True from the moment a local-streaming assistant message is first
    // created until the SSE 'done' event actually resolves with real
    // citations (see sendLocalStreaming's upsertAssistantMessage). Lets
    // the citations area show a lightweight inline placeholder instead of
    // leaving the full-message ThinkingIndicator visible for that gap,
    // which read as a second, redundant loading state under an answer
    // that already looked complete.
    citationsPending?: boolean;
    diagram?: DiagramPayload;
    complianceResult?: any;
    // Domain terms the speech recognizer misheard and the backend
    // corrected before answering (see lib/domain-vocabulary.ts). Shown to
    // the user rather than applied silently - if it guessed wrong, the
    // answer is about the wrong thing and they need to be able to see that.
    corrections?: Array<{ from: string; to: string; confidence: number }>;
    // Set when the backend matched a real map PDF to this answer's site
    // (see route.ts's UK_POSTCODE_RE / /site-answer path) - rendered by
    // MapCitationsSection below. sitePostcode is the postcode that
    // triggered the site-scoped lookup, shown as a small label above
    // the map(s) so it's clear which site they're for.
    mapCitations?: MapCitation[];
    sitePostcode?: string;
    // Compliance-review checklist summary (see runProposalReview) - fed
    // to ReviewSummaryChart for the animated donut + checklist rows.
    // Deliberately a distinct field from complianceResult above: that
    // one is the older /api compliance-check flow's percentage-score
    // shape, this is proposal_review.py's item/status checklist shape -
    // different data, different renderer.
    reviewChart?: {
      checklist: Array<{ item: string; status: string; note?: string }>;
      // The full issues list (proposal_review.py's REVIEW_SYSTEM_PROMPT
      // "issues" shape: topic/issue/suggested_change) - added 2026-09-23
      // so the in-chat summary can show the actual "how to fix this"
      // guidance, not just a pass/fail checklist. The backend has always
      // generated suggested_change per issue and note per checklist item
      // (see the full PDF/markdown report), but the chat widget was
      // dropping both and only showing item names with a red/green dot -
      // explicit user feedback: "we are supposed to give suggestions...
      // where it fails how can it be avoided", i.e. the fix belongs
      // in the very first thing they see, not only in a PDF they have
      // to separately open.
      issues?: Array<{
        topic?: string;
        issue?: string;
        suggested_change?: string;
        // Second-opinion cross-check (local-rag/proposal_review.py's
        // _verify_issues(), added 2026-09-24, karpathy/llm-council's
        // "have another model check the first one's work" pattern) -
        // undefined means this issue was never independently checked
        // (past the backend's per-report cap, or that pass failed), a
        // weaker claim than a pass, so ReviewSummaryChart below must
        // only ever render a badge when this key is actually present -
        // never treat "undefined" as "verified".
        verified?: boolean;
        verification_note?: string;
      }>;
      issuesCount: number;
      // "Incomplete" (added 2026-09-28 reliability fix, points 1/2/5) is
      // a genuinely distinct state from Low/Medium/High, not a fourth
      // risk tier - it means some document excerpts couldn't be
      // assessed, so no definitive compliance verdict is shown; see
      // ReviewSummaryChart's own handling and proposal_review.py's
      // compliance_status field.
      level: "Low" | "Medium" | "High" | "Incomplete" | null;
      // assessment_coverage/evidence_confidence (same 2026-09-28 fix) -
      // kept as their own separate fields, never folded into `level` or
      // the checklist itself, so a partial assessment is always visibly
      // partial rather than silently looking like a complete one.
      coverage?: { assessedUnits: number; totalUnits: number; pct: number; complete: boolean } | null;
      evidenceConfidence?: string | null;
    };
  };
  diagramData?: DiagramData;
}

interface BackendCitation {
  id?: string;
  title?: string;
  type?: string;
  pageNumber?: number;
  clauseNumber?: string;
  section?: string;
  fullText?: string;
  excerpt?: string;
  confidence?: number;
  lastUpdated?: string;
  directLink?: string;
  _raw?: any;
}

type BackendDiagram =
  | {
      kind?: DiagramKind;
      spec?: any;
      title?: string;
      svgContent?: string;
    }
  | any;

// Drawn from the one document the corpus actually contains: the National
// Planning Policy Framework in documents-to-ingest/, 422 chunks, the only
// document in the database with any chunks at all. Each question was checked
// against the extracted text before being put here, and each names a policy
// that exists in it - this edition is the restructured Framework with lettered
// policy codes (S3, GB8, F5, HE6), not the older paragraph-numbered one, so
// questions phrased around "paragraph 11" would have retrieved nothing.
//
// The four are deliberately from four different chapters. The previous set had
// two Green Belt questions and two on sustainable development, which made the
// corpus look narrower than it is.
//
// When more documents are ingested, revisit this - a suggestion the system
// cannot answer is worse than no suggestion, because the user learns from the
// first failure not to trust the second.
const suggestions: Array<{ policy: string; topic: string; question: string }> = [
  {
    policy: "S3",
    topic: "Sustainable development",
    question:
      "How does the presumption in favour of sustainable development apply inside and outside settlements?",
  },
  {
    policy: "GB8",
    topic: "Green Belt",
    question:
      "What do the Golden Rules require when Green Belt land is released for housing?",
  },
  {
    policy: "F5",
    topic: "Flood risk",
    question:
      "When does the sequential test apply to a development proposal at risk of flooding?",
  },
  {
    policy: "HE6",
    topic: "Historic environment",
    question:
      "What weight should be given to a designated heritage asset affected by development?",
  },
];

function ArrowUpRightIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

/* ---------------- helpers ---------------- */

function stripChunkMetadata(text: string) {
  if (!text) return "";

  return text
    .replace(/\[TOPIC\]:?[^\n]*/gi, "")
    .replace(/\[SECTION\]:?[^\n]*/gi, "")
    .replace(/\[HEADING\]:?[^\n]*/gi, "")
    .replace(/\[KEYWORDS\]:?[^\n]*/gi, "")
    .replace(/\[NEXT_PAGE\]:?[^\n]*/gi, "")
    .replace(/\[PREV_PAGE\]:?[^\n]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function repairSmashedWords(text: string) {
  if (!text) return "";

  return text
    .replace(/ONLIN[E]?VERSION/gi, "ONLINE VERSION")
    .replace(/Approved\s*Docu\s*ment/gi, "Approved Document")
    .replace(/Document\s*B\s*Volume/gi, "Document B Volume")
    .replace(/B\s*Volume/gi, "Volume")
    .replace(/Building\s*dR?I?B?u/gi, "")
    .replace(/\b([A-Za-z])\s(?=[A-Za-z]\s){2,}/g, (m) => m.replace(/\s/g, ""))
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/shaftscontaining/gi, "shafts containing")
    .replace(/shaftsshould/gi, "shafts should")
    .replace(/buildingwith/gi, "building with")
    .replace(/storeymore/gi, "storey more")
    .replace(/basementthat/gi, "basement that")
    .replace(/needone/gi, "need one")
    .replace(/storeythat/gi, "storey that")
    .replace(/building'sheight/gi, "building's height")
    .replace(/heightand size/gi, "height and size")
    .replace(/shaftsalso/gi, "shafts also")
    .replace(/storeys,each/gi, "storeys, each")
    .replace(/offirefighting/gi, "of firefighting")
    .replace(/shaftsare/gi, "shafts are")
    .replace(/shaftsin/gi, "shafts in")
    .replace(/astorey/gi, "a storey")
    .replace(/Abuilding/gi, "A building")
    .replace(/abuilding/gi, "a building")
    .replace(/firefightingshaft/gi, "firefighting shaft")
    .replace(/firemain/gi, "fire main")
    .replace(/,The/g, ", the")
    .replace(/\.The/g, ". The")
    .replace(/\.There/g, ". There")
    .replace(/\.Fire/g, ". Fire")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSentenceSpacing(text: string) {
  if (!text) return "";

  return text
    .replace(/([.?!;:])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d+\.\d+)/g, "$1 $2")
    .replace(/(\d+\.\d+)([A-Z])/g, "$1 $2")
    .replace(/([a-z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z]{2,})/g, "$1 $2")
    .replace(/([a-z])\(/g, "$1 (")
    .replace(/\)\(/g, ") (")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeEvidenceText(text: string) {
  return normalizeSentenceSpacing(repairSmashedWords(stripChunkMetadata(text || "")));
}

function looksIncompleteEvidence(text: string) {
  if (!text) return false;

  const t = text.trim();
  if (!t) return false;

  const lastLine =
    t
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() || t;

  return (
    /\b(and|or|to|of|for|with|including|which|that|where|when|if|than|see|paragraph|paragraphs)$/i.test(
      lastLine
    ) ||
    /\($/.test(lastLine) ||
    /[:;,-]$/.test(lastLine) ||
    /^(\d+\.|[a-z]\.)$/i.test(lastLine)
  );
}

// Routes a chat message to live clause editing (runDocumentEdit, via
// /api/local-rag-edit-clause) instead of the normal chat/review-chat
// path - see that function and local-rag/document_edit.py's own module
// docstring for the full feature. Deliberately conservative: editing is
// a WRITE against a persisted document, so an ambiguous message falls
// through to the normal (read-only) Q&A path rather than risk rewriting
// the wrong paragraph. Two ways to match:
//   1. An explicit reference ("paragraph 4", "clause 6", "#3") - mirrors
//      document_edit.py's own _explicit_paragraph_reference() regex, so
//      the frontend's routing guess and the backend's actual target-
//      finding agree on what counts as "explicit".
//   2. An edit-ish verb together with a paragraph/clause/section word or
//      phrase ("reframe the parking paragraph", "the bit about parking
//      needs to mention EV charging").
// Being explicit ("paragraph 4: ...") always routes correctly; this is
// a heuristic for everything short of that, not a guarantee - the
// backend's own find_target_paragraph() still does the real, careful
// match once a message gets here.
const EDIT_EXPLICIT_REF_RE =
  /\b(?:paragraph|para|clause|point|section)\s*#?\s*\d+\b|#\d+\b/i;
const EDIT_VERB_RE =
  /\b(reframe|reword|rewrite|rephrase|revise|edit|change|update|replace|fix|tweak|shorten|expand|clarify|strengthen|soften|add|remove|mention|include)\b/i;
const EDIT_TARGET_RE =
  /\b(paragraph|para|clause|point|section|sentence|line|bit about|part about|wording)\b/i;

function looksLikeEditInstruction(text: string): boolean {
  if (!text.trim()) return false;
  if (EDIT_EXPLICIT_REF_RE.test(text)) return true;
  return EDIT_VERB_RE.test(text) && EDIT_TARGET_RE.test(text);
}

function buildExcerpt(text: string, max = 240) {
  if (!text) return "";

  const cleaned = sanitizeEvidenceText(text);
  if (!cleaned) return "";

  const sentenceMatch = cleaned.match(/.*?[.!?](\s|$)/);
  const firstSentence = sentenceMatch?.[0]?.trim();

  if (
    firstSentence &&
    firstSentence.length >= 50 &&
    firstSentence.length <= max
  ) {
    return firstSentence;
  }

  return cleaned.length > max ? `${cleaned.slice(0, max).trim()}…` : cleaned;
}

function extractRawCitations(data: any): BackendCitation[] {
  const candidates = [
    data?.data?.citations,
    data?.citations,
    data?.data?.sources,
    data?.sources,
    data?.metadata?.citations,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  return [];
}

function mapBackendCitations(
  raw: BackendCitation[] | undefined | null
): Citation[] {
  if (!raw || !Array.isArray(raw)) return [];

  return raw.map((c, idx) => {
    const rawFullText = c.fullText ?? c.excerpt ?? "";
    const rawExcerpt = c.excerpt ?? c.fullText ?? "";

    const cleanedFullText = sanitizeEvidenceText(rawFullText);
    const cleanedExcerpt = buildExcerpt(rawExcerpt || cleanedFullText, 220);

    const fallbackType =
      typeof c.type === "string" && c.type.trim()
        ? c.type
        : "government_doc";

    const normalizedId = c.id ?? String(idx + 1);

    return {
      id: normalizedId,
      title: c.title ?? `Source ${idx + 1}`,
      type: fallbackType,
      pageNumber: c.pageNumber,
      clauseNumber: c.clauseNumber,
      section: c.section,
      fullText: cleanedFullText,
      excerpt: cleanedExcerpt,
      confidence: Number(c.confidence ?? 0),
      lastUpdated: c.lastUpdated ?? new Date().toISOString(),
      directLink: c.directLink,
      _raw: {
        ...c._raw,
        originalFullText: rawFullText,
        originalExcerpt: rawExcerpt,
        frontendSanitized: true,
        stillLooksIncomplete: looksIncompleteEvidence(cleanedFullText),
      },
    };
  });
}

function extractDiagram(data: any): DiagramPayload | undefined {
  const d: BackendDiagram =
    data?.diagram ||
    data?.data?.diagram ||
    data?.metadata?.diagram ||
    undefined;

  if (!d?.kind || !d?.spec) return undefined;

  return {
    kind: d.kind,
    spec: d.spec,
    title: d.title,
  };
}

function extractDiagramSpecFromAnswer(content: string): DiagramData | null {
  const match = content.match(/```json\s*([\s\S]*?)```/i);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]);
    const d = parsed?.diagram ?? parsed;

    if (!d?.kind || !d?.spec) return null;

    return {
      kind: d.kind,
      spec: d.spec,
      title: d?.title || d?.spec?.meta?.title,
    };
  } catch {
    return null;
  }
}

async function fetchDiagramSVG(diagramData: DiagramData): Promise<string> {
  const res = await fetch("/api/diagram/svg", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: diagramData.kind,
      spec: diagramData.spec,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `SVG render failed (${res.status})`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const json = await res.json();
    return String(json?.svg || "");
  }

  return await res.text();
}

function splitByTrigger(content: string) {
  const triggerBold = "**[GENERATE_DIAGRAM]**";
  const triggerPlain = "[GENERATE_DIAGRAM]";

  if (content.includes(triggerBold)) {
    const parts = content.split(triggerBold);
    return { before: parts[0] ?? "", after: parts[1] ?? "" };
  }

  if (content.includes(triggerPlain)) {
    const parts = content.split(triggerPlain);
    return { before: parts[0] ?? "", after: parts[1] ?? "" };
  }

  return { before: content, after: "" };
}

/* ---------------- icons ---------------- */

type IconProps = React.SVGProps<SVGSVGElement>;

const Svg = ({ children, ...props }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {children}
  </svg>
);

const UserIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="8" r="4" />
    <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
  </Svg>
);

const SparklesIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3l1.5 3.5L17 8l-3.5 1.5L12 13l-1.5-3.5L7 8l3.5-1.5L12 3z" />
    <path d="M6 14l.9 2.1L9 17l-2.1.9L6 20l-.9-2.1L3 17l2.1-.9L6 14z" />
  </Svg>
);

const PaperAirplaneIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </Svg>
);

const DownloadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3v10" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
);

const DocumentIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M7 3h7l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M14 3v5h5" />
    <path d="M9 12h6" />
    <path d="M9 16h6" />
  </Svg>
);

const MicIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M12 19v3" />
    <path d="M8 22h8" />
  </Svg>
);

const SpeakerIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 9v6h4l5 5V4L8 9H4z" />
    <path d="M17 8a5 5 0 0 1 0 8" />
  </Svg>
);

const WaveformIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 10v4" />
    <path d="M8 6v12" />
    <path d="M12 3v18" />
    <path d="M16 6v12" />
    <path d="M20 10v4" />
  </Svg>
);

const CopyIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Svg>
);

const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 6L9 17l-5-5" />
  </Svg>
);

const RefreshIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 3v6h-6" />
  </Svg>
);

const MenuIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Svg>
);

/* ---------------- UI helpers ---------------- */

function ConfidenceRing({
  pct,
  ringClass,
  trackClass,
}: {
  pct: number;
  ringClass: string;
  trackClass: string;
}) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.max(2, pct) / 100) * circumference;

  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 36 36"
      className="-rotate-90"
      aria-hidden="true"
    >
      <circle
        cx="18"
        cy="18"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        className={trackClass}
      />
      <circle
        cx="18"
        cy="18"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className={`${ringClass} transition-[stroke-dashoffset] duration-500 ease-out`}
      />
    </svg>
  );
}

// Monochrome meter: brightness scales with the tier, like a signal or
// battery indicator - HIGH is a solid fill, LOW is barely there. Hue
// never carried meaning here anyway; the HIGH/MEDIUM/LOW text label is
// the actual source of truth and stays regardless of shading.
const CONFIDENCE_THEME = {
  high: {
    ring: "text-neutral-950",
    track: "text-neutral-950/15",
    chip: "border-neutral-950/35 bg-neutral-950/15 text-neutral-950",
    card: "border-neutral-950/15 bg-neutral-950/[0.05]",
    label: "HIGH",
  },
  medium: {
    ring: "text-neutral-700",
    track: "text-neutral-700/15",
    chip: "border-neutral-950/20 bg-neutral-950/8 text-neutral-800",
    card: "border-neutral-950/10 bg-neutral-950/[0.035]",
    label: "MEDIUM",
  },
  low: {
    ring: "text-neutral-500",
    track: "text-neutral-500/15",
    chip: "border-neutral-950/10 bg-neutral-950/4 text-neutral-600",
    card: "border-neutral-950/8 bg-neutral-950/[0.02]",
    label: "LOW",
  },
} as const;

function ConfidenceBadge({
  value,
  title,
}: {
  value: number;
  title?: string;
}) {
  if (value == null || Number.isNaN(value)) return null;

  const pct = Math.max(0, Math.min(100, Math.round(value)));
  // Was a separately-calibrated 85/60 cutoff that disagreed with
  // ExpandableCitation.tsx's 75/55 per-citation tiers - see that
  // file's getConfidenceTier() comment for why 75/55 is the right
  // calibration for scores in this 65-90% band. Reusing the same
  // function here instead of a second hardcoded copy is what keeps
  // the top-level answer badge and per-citation badges from ever
  // showing a different verdict for the same number again.
  const tier = getConfidenceTier(pct);
  const theme = CONFIDENCE_THEME[tier];

  return (
    <div
      className={`inline-flex items-center gap-2.5 rounded-2xl border px-2.5 py-1.5 ${theme.card}`}
    >
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
        <ConfidenceRing pct={pct} ringClass={theme.ring} trackClass={theme.track} />
        <span className="absolute font-mono text-[10px] font-semibold text-neutral-900">
          {pct}
        </span>
      </div>
      <div className="flex flex-col items-start gap-0.5 leading-none">
        {title ? (
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            {title}
          </span>
        ) : null}
        <span
          className={`inline-flex items-center rounded-full border px-1.5 py-[3px] text-[9px] font-semibold uppercase tracking-wide ${theme.chip}`}
        >
          {theme.label}
        </span>
      </div>
    </div>
  );
}

function ComplianceResultDisplay({ result }: { result: any }) {
  if (!result || !result.success) {
    return (
      <div className="mt-4 rounded-2xl border border-neutral-950/30 bg-neutral-950/10 p-4">
        <p className="text-sm text-neutral-950">
          ❌ Compliance check failed: {result?.error || "Unknown error"}
        </p>
      </div>
    );
  }

  const score = result.complianceScore ?? 0;

  // Same meter convention as CONFIDENCE_THEME: brightness scales with
  // the score, and the ✅/⚠️/❌ + COMPLIANT/PARTIAL/NON-COMPLIANT text
  // already carry the verdict, so shading here is a reinforcing cue,
  // not the only signal.
  const scoreBoxClasses =
    score >= 80
      ? "border-neutral-950/30 bg-neutral-950/10"
      : score >= 60
      ? "border-neutral-950/18 bg-neutral-950/6"
      : "border-neutral-950/10 bg-neutral-950/[0.03]";

  const scoreTextClasses =
    score >= 80
      ? "text-neutral-950"
      : score >= 60
      ? "text-neutral-700"
      : "text-neutral-500";

  const statusTextClasses =
    score >= 80
      ? "text-neutral-800"
      : score >= 60
      ? "text-neutral-700"
      : "text-neutral-600";

  return (
    <div className="mt-4 space-y-3">
      <div className={`rounded-2xl border p-4 ${scoreBoxClasses}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-neutral-600">Compliance Score</p>
            <p className={`text-3xl font-bold ${scoreTextClasses}`}>{score}%</p>
            <p className={`mt-1 text-xs ${statusTextClasses}`}>
              {score >= 80
                ? "✅ COMPLIANT"
                : score >= 60
                ? "⚠️ PARTIAL"
                : "❌ NON-COMPLIANT"}
            </p>
          </div>

          {result.metadata && (
            <div className="text-right text-xs text-neutral-600">
              <p>{result.metadata.documentName}</p>
              <p>
                {result.metadata.jurisdiction} · {result.metadata.projectType}
              </p>
            </div>
          )}
        </div>
      </div>

      {Array.isArray(result.violations) && result.violations.length > 0 && (
        <div className="rounded-2xl border-2 border-neutral-950/30 bg-neutral-950/10 p-4">
          <p className="mb-2 text-sm font-semibold text-neutral-950">
            ❌ Critical Violations ({result.violations.length})
          </p>
          <div className="space-y-2">
            {result.violations.map((v: any, i: number) => (
              <div
                key={i}
                className="border-l-2 border-neutral-950/60 pl-3 text-xs text-neutral-700"
              >
                <p className="font-medium">{v.requirement}</p>
                <p className="mt-1 text-neutral-600">{v.finding}</p>
                {v.remediation && (
                  <p className="mt-1 text-neutral-800">→ {v.remediation}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <div className="rounded-2xl border border-neutral-950/20 bg-neutral-950/[0.06] p-4">
          <p className="mb-2 text-sm font-semibold text-neutral-900">
            ⚠️ Warnings ({result.warnings.length})
          </p>
          <div className="space-y-2">
            {result.warnings.map((w: any, i: number) => (
              <div
                key={i}
                className="border-l-2 border-neutral-950/35 pl-3 text-xs text-neutral-700"
              >
                <p className="font-medium">{w.requirement}</p>
                <p className="mt-1 text-neutral-600">{w.finding}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(result.recommendations) &&
        result.recommendations.length > 0 && (
          <div className="rounded-2xl border border-dashed border-neutral-950/20 bg-neutral-950/[0.04] p-4">
            <p className="mb-2 text-sm font-semibold text-neutral-800">
              💡 Recommendations
            </p>
            <ul className="space-y-1 text-xs text-neutral-700">
              {result.recommendations.map((r: string, i: number) => (
                <li key={i} className="pl-4">
                  • {r}
                </li>
              ))}
            </ul>
          </div>
        )}
    </div>
  );
}

// Status palette mirrors report_render.py's STATUS constant exactly (same
// hex values) so the chat summary and the downloadable report never read
// as two different visual languages for the same three states.
const REVIEW_STATUS_COLORS: Record<string, string> = {
  present: "#0ca30c",
  missing: "#d03b3b",
  unclear: "#fab219",
};
const REVIEW_STATUS_ICON: Record<string, string> = {
  present: "✓",
  missing: "✗",
  unclear: "!",
};

// Animated counterpart to report_render.py's _status_donut_svg() + the
// required-content checklist section - same segment order
// (missing/unclear/present, most-attention-first) and the same fixed
// status palette, rendered live in chat instead of only in the
// downloadable PDF. Added 2026-09-21 per "animated report visuals" -
// framer-motion's pathLength/pathOffset (normalized 0-1 progress along an
// SVG path) does the per-segment ring math instead of hand-rolled
// stroke-dasharray strings, since those two motion values already encode
// exactly "how much of this arc is drawn" and "where along the circle it
// starts."
function ReviewSummaryChart({
  data,
}: {
  data: {
    checklist: Array<{ item: string; status: string; note?: string }>;
    issues?: Array<{
      topic?: string;
      issue?: string;
      suggested_change?: string;
      // See ChatMessage.metadata.reviewChart's matching field comment -
      // undefined means "not independently checked", never a false pass.
      verified?: boolean;
      verification_note?: string;
    }>;
    issuesCount: number;
    level: "Low" | "Medium" | "High" | "Incomplete" | null;
    coverage?: { assessedUnits: number; totalUnits: number; pct: number; complete: boolean } | null;
    evidenceConfidence?: string | null;
  };
}) {
  const { checklist, issues, issuesCount, level, coverage, evidenceConfidence } = data;
  // "Incomplete" (2026-09-28 reliability fix) is never treated as a
  // fourth risk tier - it replaces the ring's own "X% present" reading
  // with the honest "X% assessed" coverage number instead, since a
  // present/missing split computed from a partial assessment isn't a
  // real answer to "is this compliant" (see report_render.py's matching
  // compliance_status handling for the full report).
  const isIncomplete = level === "Incomplete";
  const size = 92;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const total = checklist.length;

  const counts = { missing: 0, unclear: 0, present: 0 } as Record<string, number>;
  for (const c of checklist) {
    if (counts[c.status] !== undefined) counts[c.status] += 1;
  }
  const pctPresent = total > 0 ? Math.round((counts.present / total) * 100) : 0;
  const displayPct = isIncomplete ? coverage?.pct ?? 0 : pctPresent;
  const displayLabel = isIncomplete ? "assessed" : "present";

  // Same gap convention as the backend (a small visual break between
  // segments) - expressed here as a fraction of the circle rather than a
  // fixed px length, since pathLength/pathOffset are both normalized 0-1.
  const gapFraction = total > 0 ? 1.2 / (2 * Math.PI * r) : 0;

  let offsetFraction = 0;
  const segments: Array<{ status: string; offset: number; length: number }> = [];
  for (const status of ["missing", "unclear", "present"]) {
    const n = counts[status] || 0;
    if (n <= 0) continue;
    const lengthFraction = Math.max(0, n / total - gapFraction);
    segments.push({ status, offset: offsetFraction, length: lengthFraction });
    offsetFraction += n / total;
  }

  const levelColor = isIncomplete
    ? "#2a78d6"
    : level === "High"
    ? "#d03b3b"
    : level === "Medium"
    ? "#fab219"
    : "#0ca30c";

  if (total === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mt-4 rounded-2xl border border-neutral-950/10 bg-neutral-950/[0.03] p-4"
    >
      <div className="flex items-start gap-4">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg
            viewBox={`0 0 ${size} ${size}`}
            width={size}
            height={size}
            className="-rotate-90"
          >
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="#e1e0d9"
              strokeWidth={stroke}
            />
            {segments.map((seg, i) => (
              <motion.circle
                key={seg.status}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={REVIEW_STATUS_COLORS[seg.status]}
                strokeWidth={stroke}
                style={{ pathOffset: seg.offset }}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: seg.length }}
                transition={{ duration: 0.7, delay: 0.15 + i * 0.15, ease: "easeOut" }}
              />
            ))}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-base font-semibold text-neutral-900">
              {displayPct}%
            </span>
            <span className="text-[9px] text-neutral-500">{displayLabel}</span>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {level && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
                style={{ color: levelColor, backgroundColor: `${levelColor}1a` }}
              >
                {isIncomplete ? "Incomplete — not final" : `${level} attention`}
              </span>
            )}
            <span className="text-neutral-500">
              {issuesCount} issue{issuesCount === 1 ? "" : "s"} · {total} item
              {total === 1 ? "" : "s"} checked
            </span>
          </div>
          {isIncomplete && (
            <p className="mb-2 text-[11px] leading-snug text-neutral-500">
              Only {coverage?.assessedUnits ?? 0} of {coverage?.totalUnits ?? 0} document
              excerpt{coverage?.totalUnits === 1 ? "" : "s"} could be assessed — a "missing"
              item below may simply be in the part that wasn't checked, not genuinely absent.
              {evidenceConfidence ? ` Evidence confidence: ${evidenceConfidence}.` : ""}
            </p>
          )}

          {/* Missing/unclear items first (most-attention-first, same order
              as the donut segments and the PDF's own checklist table) -
              "present" items don't need an explanation, so they're not
              worth the vertical space here. Each row now shows the
              backend's own `note` text (proposal_review.py's REVIEW_
              SYSTEM_PROMPT: "if missing or unclear, what to add") right
              under the item name, not just a pass/fail dot - added
              2026-09-23 per explicit feedback that the checklist alone
              ("just a list of X marks") wasn't actually telling the user
              how to fix anything, even though that guidance already
              existed in the full PDF report the whole time. */}
          <div className="space-y-2">
            {[...checklist]
              .sort((a, b) => {
                const rank: Record<string, number> = { missing: 0, unclear: 1, present: 2 };
                return (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
              })
              .slice(0, 4)
              .map((c, i) => (
                <motion.div
                  key={`${c.item}-${i}`}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.25 + i * 0.06 }}
                  className="flex items-start gap-2 text-xs"
                >
                  <span
                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: REVIEW_STATUS_COLORS[c.status] || "#898781" }}
                  >
                    {REVIEW_STATUS_ICON[c.status] || "?"}
                  </span>
                  <div className="min-w-0">
                    <span className="font-medium text-neutral-800">{c.item}</span>
                    {c.note && c.status !== "present" && (
                      <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">
                        {c.note}
                      </p>
                    )}
                  </div>
                </motion.div>
              ))}
            {checklist.length > 4 && (
              <p className="pl-6 text-[11px] text-neutral-500">
                +{checklist.length - 4} more in the full report
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Suggested fixes - the same "suggested_change" prose the full PDF
          report shows per issue (report_render.py's Issues section),
          surfaced here too so a fix is visible without downloading
          anything. Optional: only present on messages created after this
          field was added, so a saved/reloaded older conversation just
          shows the checklist above without this section - see
          ChatMessage.metadata.reviewChart's own comment. */}
      {issues && issues.some((i) => i.suggested_change) && (
        <div className="mt-3 border-t border-neutral-950/10 pt-3">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Suggested fixes
          </p>
          <div className="space-y-2">
            {issues.slice(0, 3).map((iss, i) => (
              <div key={`${iss.topic}-${i}`} className="text-xs text-neutral-700">
                {iss.topic && (
                  <span className="font-medium text-neutral-800">{iss.topic}: </span>
                )}
                <span className="text-neutral-600">
                  {iss.suggested_change || iss.issue}
                </span>
                {/* Second-opinion badge (local-rag/proposal_review.py's
                    _verify_issues(), added 2026-09-24) - `verified` is
                    only ever present when the backend actually ran that
                    check on this issue; undefined (the common case for an
                    issue past its per-report cap) renders nothing, never
                    a false pass - see the reviewChart type's own comment. */}
                {iss.verified === true && (
                  <span className="ml-1.5 text-emerald-600">✓ verified</span>
                )}
                {iss.verified === false && (
                  <span
                    className="ml-1.5 text-amber-600"
                    title={iss.verification_note || "Second-opinion check flagged this claim"}
                  >
                    ⚠ needs a second look
                  </span>
                )}
              </div>
            ))}
            {issues.length > 3 && (
              <p className="text-[11px] text-neutral-500">
                +{issues.length - 3} more in the full report
              </p>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}

/* ---------------- main ---------------- */

export default function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Only used for the two motion enhancements below (the welcome/first-
  // message crossfade) - DESIGN.md requires full prefers-reduced-motion
  // support, and unlike CSS .rise/.press (already collapsed by the global
  // reduced-motion media query) Framer Motion animates in JS, so it needs
  // its own explicit check.
  const shouldReduceMotion = useReducedMotion();
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-conversation document uploads (app/api/documents/upload/route.ts +
  // lib/userDocuments.ts): a visitor can attach a PDF/DOCX/image and have
  // it ingested in the background - from then on, every question in this
  // SAME conversation is answered using that document's content together
  // with the shared regulatory corpus (see app/api/rag-chat/route.ts's
  // searchUserDocumentChunks merge). Tracked as a list (not a single file)
  // since a conversation can accumulate more than one upload over time.
  const [uploadedDocs, setUploadedDocs] = useState<
    Array<{ id: string; name: string; status: "uploading" | "ready" | "error" }>
  >([]);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [drawingFile, setDrawingFile] = useState<File | null>(null);

  const [chatMode, setChatMode] = useState<
    "auto" | "feasibility" | "permitting" | "risk"
  >("auto");

  // Which retrieval/answer backend to hit - see FEATURES.ragSourceToggle
  // above. "local" only applies to plain text Q&A: handleSend always uses
  // the cloud endpoint when a drawing file is attached, since local-rag
  // has no drawing-analysis/feasibility path.
  const [ragSource, setRagSource] = useState<"cloud" | "local">("cloud");
  const [localRagStatus, setLocalRagStatus] = useState<
    "unknown" | "checking" | "reachable" | "unreachable"
  >("unknown");
  // Fully-local generation (added 2026-09-24; made automatic 2026-09-25 -
  // see local-rag/answer.py's `backend` parameter). Only meaningful when
  // ragSource is "local": "groq" (default) answers via Groq's cloud API
  // same as before this existed; "ollama" answers via a local Ollama
  // instance too, so nothing about the query leaves this machine.
  // Originally an opt-in checkbox the user had to notice and tick after
  // switching to "Local (offline)" - user feedback: switching to Local
  // should just mean fully local, automatically, with no extra control
  // to discover. The health-check effect below now sets this directly
  // from ollamaStatus (available + default model pulled -> "ollama",
  // otherwise "groq") whenever ragSource becomes "local" - there is no
  // longer any UI for the user to set this by hand.
  const [ragBackend, setRagBackend] = useState<"groq" | "ollama">("groq");
  const [ollamaStatus, setOllamaStatus] = useState<{
    available: boolean;
    models: string[];
    default_model: string;
    default_model_pulled: boolean;
  }>({ available: false, models: [], default_model: "", default_model_pulled: false });

  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);

  // Side panel next to the chat - see components/chat/DocumentPanel.tsx.
  // Added 2026-09-19, originally verified against a hardcoded sample
  // report via a temporary test button; now opened for real by
  // runProposalReview below.
  //
  // Rewritten 2026-09-23, FIFTH pass - this is the one that actually
  // matches the original request. Re-reading it after repeated "you're
  // still returning me the original document, not the report" feedback:
  // "if the report is generated based on the documents that I upload
  // then THAT is shown in the view and can be edited" - "that" is the
  // REPORT, not the document. The second pass (previous version of this
  // comment) read it backwards and made the uploaded document the main
  // view with the report demoted to a small button - which is exactly
  // what kept looking wrong no matter how many times the button wiring
  // was checked, because the WRONG FILE was the main view by design, not
  // by bug.
  //
  // So: `url`/`filename` is now the GENERATED COMPLIANCE REPORT
  // (report_files.pdf_url) - the primary, read-only view (confirmed
  // explicitly: the report itself isn't paragraph-editable, only
  // downloadable/readable). `documentUrl`/`documentFilename` is the
  // uploaded document - demoted to the small secondary button, still
  // editable via chat (looksLikeEditInstruction/runDocumentEdit below
  // still targets it through `docId`), just no longer what's rendered in
  // the main PDF view. There's no more in-panel page-flash on an edit
  // (see the highlightPage removal below) since the document being
  // edited isn't the thing on screen anymore - runDocumentEdit's chat
  // reply is now where that confirmation lives instead.
  const [documentPanel, setDocumentPanel] = useState<{
    url: string;
    filename: string;
    // The uploaded document's own (live-regenerated) PDF - secondary
    // download only now, see the block comment above. Undefined in the
    // rare case persistence failed (see runProposalReview) - editing is
    // simply unavailable then, same framing as before this rewrite.
    documentUrl?: string;
    documentFilename?: string;
    // The persisted document's id (local-rag/document_edit.py's
    // save_document()) - still needed even though the document isn't
    // the main view, since chat-driven edits (runDocumentEdit) target it
    // by this id. Only the FIRST uploaded document gets one (matches
    // this panel's existing one-document-at-a-time design).
    docId?: string;
    // The REPORT's own editable identity (2026-09-25, Report-tab
    // correction) - completely separate from docId above, which is the
    // uploaded SOURCE. Undefined when local-rag couldn't persist the
    // report's blocks that time (best-effort, see service.py) - the
    // Report tab then just falls back to the plain PDF preview (see
    // DocumentPanel.tsx's own `assessment ? ... : ...` fallback).
    reportDocId?: string;
  } | null>(null);
  const [isEditingClause, setIsEditingClause] = useState(false);

  // The report's own block role map ({localId, kind, index}[] - GET
  // /proposal-review's report_blocks, see service.py's save_report_blocks())
  // - what StructuredReportView (DocumentPanel.tsx) uses to know which
  // rendered DOM node maps to which local_id, the DOM equivalent of
  // documentParagraphs' bbox index just below for the source PDF.
  const [reportBlocks, setReportBlocks] = useState<{ localId: number; kind: string; index: number | null }[]>([]);

  // The uploaded document's own blocks (id/page/bbox/text), fetched once
  // via the existing GET /api/local-rag-document proxy (see that route's
  // own header comment - it already existed, just wasn't called from
  // here yet) whenever a new docId shows up. This is the index the new
  // "Document" tab's InteractiveDocumentView (DocumentPanel.tsx,
  // 2026-09-25 inline-block-editing milestone) uses to resolve an
  // arbitrary text selection back to a specific block - see that
  // component's own docstring. Re-fetched after every applied/undone
  // block edit too (below), so a second selection on the same session
  // resolves against current text/bboxes, not a stale snapshot.
  const [documentParagraphs, setDocumentParagraphs] = useState<DocumentBlock[]>([]);
  const fetchDocumentParagraphs = useCallback(async (docId: string) => {
    try {
      const res = await fetch(`/api/local-rag-document?doc_id=${encodeURIComponent(docId)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success && Array.isArray(data.paragraphs)) {
        setDocumentParagraphs(
          data.paragraphs.map((p: any) => ({ id: p.id, page: p.page, bbox: p.bbox, text: p.text }))
        );
      }
    } catch {
      // Best-effort - the Document tab just can't resolve selections to
      // a block yet if this fails; the Report tab and every other
      // existing flow are completely unaffected.
    }
  }, []);
  useEffect(() => {
    if (documentPanel?.docId) fetchDocumentParagraphs(documentPanel.docId);
  }, [documentPanel?.docId, fetchDocumentParagraphs]);

  // Proposal compliance review (local-rag/service.py's /proposal-review +
  // /proposal-review-chat, proxied via app/api/local-rag-proposal-review*)
  // - added 2026-09-19 to replace the "Preview sample report (dev)" test
  // button with the real flow. pendingUploadFile holds a just-selected
  // file while the user picks what to do with it (see handleFileSelected
  // below, which replaced the old auto-upload handleFileUpload);
  // activeReview holds the last completed review's context once one
  // exists, and while it's set, handleSend routes every message through
  // /proposal-review-chat (grounded follow-up Q&A) instead of the normal
  // chat path - see proposal_review.build_review_context_text()'s
  // docstring in local-rag for why that's still a full corpus search,
  // not a narrower one.
  const [pendingUploadFile, setPendingUploadFile] = useState<File | null>(null);
  const [reviewPostcode, setReviewPostcode] = useState("");
  const [isReviewing, setIsReviewing] = useState(false);
  const [activeReview, setActiveReview] = useState<{
    review: any;
    reportFiles?: {
      pdf_url?: string;
      pdf_filename?: string;
      markdown_url?: string;
    };
    label: string;
  } | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // How much bottom padding the scrollable message list reserves so the
  // floating composer never covers the last message - measured live by
  // FloatingComposerShell's ResizeObserver (composer height changes as
  // uploaded-doc cards, the pending-upload card, or the active-review
  // chip appear/disappear below it). Same technique DocumentPanel's own
    // composerReserve already used before this shell existed.
  const [composerReserve, setComposerReserve] = useState(96);

  // How tall the composer is allowed to get before it scrolls instead of
  // growing. Six lines: past that the box starts eating the conversation it is
  // supposed to sit beneath.
  const COMPOSER_MAX_PX = 168;

  // Height is measured, not counted. Counting "\n" gets soft-wrapped lines
  // wrong, and a pasted paragraph is exactly the case where getting it wrong
  // is most visible. useLayoutEffect so the resize lands in the same frame as
  // the keystroke - in useEffect the box visibly lags a fast typist by a
  // frame, which reads as jitter.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_PX);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_PX ? "auto" : "hidden";
    // A one-line box keeps the pill; a grown one cannot, because a 9999px
    // radius on a tall box bows the sides into an oval.
    el.dataset.grown = next > 56 ? "true" : "false";
  }, [inputValue]);

  // Bumped every time the open chat changes (new chat, switching to a
  // saved conversation, or sending a fresh message). An in-flight
  // request captures the token at send time; when it resolves, its
  // result is only applied to the UI if the token still matches - i.e.
  // the user hasn't navigated away to a different chat in the meantime.
  // Without this, an answer that was still generating when "New chat"
  // was clicked would land in the new, unrelated conversation.
  const chatSessionRef = useRef(0);

  // Per-browser conversation memory (see lib/visitorId.ts and
  // sql/chat_history_setup.sql) - no login, so a browser only ever sees
  // its own saved chats. visitorId is generated once and kept in
  // localStorage; conversationId identifies the currently open chat
  // (null until the first message of a new chat gets a reply).
  const [visitorId, setVisitorId] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Root-cause fix for the "refresh loses the conversation" bug: without
  // this, conversationId only ever lived in React state, so a refresh -
  // or reopening the tab, or coming back after switching Cloud/Local -
  // had no way to know which saved conversation had just been open. The
  // turn itself was already safely written to Supabase by
  // persistConversationTurn() (see lib/conversationMemory.ts); the UI
  // just never asked for it back, and always rendered the empty
  // WelcomeScreen instead. Scoped to this one browser exactly like
  // visitorId itself (lib/visitorId.ts).
  const ACTIVE_CONVERSATION_STORAGE_KEY = "uaa-active-conversation-id";
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // Desktop-only collapse (icon rail vs full list). Persisted per-browser so
  // the choice sticks across reloads; mobile always uses the full-width
  // off-canvas drawer regardless of this flag.
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("uaa-sidebar-collapsed");
      if (stored === "1") setIsSidebarCollapsed(true);
    } catch {
      // ignore - localStorage unavailable, sidebar just stays expanded
    }
  }, []);
  const toggleSidebarCollapsed = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("uaa-sidebar-collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  // Hide/unhide toggle for the right-hand DocumentPanel (see its own prop
  // comment) - added 2026-09-24 per explicit request: "I also want the
  // option on the right hand side where I can get the option to hide and
  // unhide the preview of the generated document." Mirrors
  // isSidebarCollapsed's own persist-to-localStorage pattern immediately
  // above, for the same reason (the choice sticks across reloads). This
  // is deliberately separate from documentPanel itself: nulling
  // documentPanel (onClose, handleNewChat) discards the report entirely,
  // while this only hides/shows it - reset to false whenever a NEW report
  // is opened (see runProposalReview) so a fresh review always opens
  // visible regardless of whether a previous one was left collapsed.
  const [isDocumentPanelCollapsed, setIsDocumentPanelCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("uaa-document-panel-collapsed");
      if (stored === "1") setIsDocumentPanelCollapsed(true);
    } catch {
      // ignore - localStorage unavailable, panel just stays expanded
    }
  }, []);
  const toggleDocumentPanelCollapsed = useCallback(() => {
    setIsDocumentPanelCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("uaa-document-panel-collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  // Fullscreen (isExpanded) and Report/Document tab (viewMode) state for
  // DocumentPanel - lifted here 2026-09-27 (fullscreen-composer-
  // interactivity fix pass, item 4: "preserve panel state... at least
  // during the current session, ideally at the workspace/layout level
  // rather than inside the panel component itself... do not reset the
  // panel just because another component rerenders"). Previously local
  // useState inside DocumentPanel itself, so any remount of that
  // component (including via the onClose bug fixed the same pass)
  // silently reset both back to their defaults. Mirrors
  // isDocumentPanelCollapsed immediately above, minus the localStorage
  // persistence - only same-session persistence was asked for here.
  const [isDocumentPanelExpanded, setIsDocumentPanelExpanded] = useState(false);
  const toggleDocumentPanelExpanded = useCallback(() => {
    setIsDocumentPanelExpanded((prev) => !prev);
  }, []);
  const [documentPanelViewMode, setDocumentPanelViewMode] = useState<"report" | "document">("report");
  const [loadingConversationId, setLoadingConversationId] = useState<
    string | null
  >(null);

  useEffect(() => {
    setVisitorId(getVisitorId());
  }, []);

  // Guards both effects below. Declared before the localStorage-sync
  // effect specifically because of the ordering bug this comment is
  // replacing: on true initial mount, conversationId is null - if the
  // sync effect were allowed to run its removeItem branch before the
  // restore effect (further down) had a chance to read the stored id
  // back, it would wipe out the very value the restore effect needs,
  // every single time, before it could ever be used. Gating the
  // removeItem branch on this ref (only flips true once a restore has
  // actually been attempted) closes that race.
  const hasAttemptedConversationRestoreRef = useRef(false);

  useEffect(() => {
    try {
      if (conversationId) {
        window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
      } else if (hasAttemptedConversationRestoreRef.current) {
        window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
      }
    } catch {
      // localStorage unavailable (private mode, blocked storage, etc.) -
      // the chat still works for this tab's lifetime, it just won't
      // survive a refresh for this visitor.
    }
  }, [conversationId]);

  // Runs once, as soon as visitorId is ready: reopens whichever
  // conversation was last active in this browser (page refresh, browser
  // restart, switching Cloud/Local and back, reopening the tab), the
  // same way clicking it in the sidebar would. Guarded so it only ever
  // fires on initial mount, never again later - clicking "New chat" or
  // another conversation afterwards must not be undone by this effect
  // re-firing.
  useEffect(() => {
    if (!visitorId) return;
    if (hasAttemptedConversationRestoreRef.current) return;
    hasAttemptedConversationRestoreRef.current = true;

    let storedConversationId: string | null = null;
    try {
      storedConversationId = window.localStorage.getItem(
        ACTIVE_CONVERSATION_STORAGE_KEY
      );
    } catch {
      // localStorage unavailable - nothing to restore, falls through to
      // the ordinary empty-state welcome screen.
    }
    if (storedConversationId) {
      handleSelectConversation(storedConversationId);
    }
    // handleSelectConversation is a stable `function` declaration in this
    // component (not a useCallback), so it's intentionally left out of
    // the dependency array - including it would make this effect track
    // every dependency IT has, defeating the "run once" guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitorId]);

  // Tracks the message count as of the previous run of the effect below,
  // across renders - a plain variable would reset every render, a ref
  // survives. Needed to reliably detect the *transition* from empty to
  // non-empty (see the effect's own comment), not just the current length.
  const prevMessagesLengthRef = useRef(0);

  // Scroll-anchoring fix (2026-09-25, diagnosed live via the real running
  // app, not guessed): a ref on the chat's own scrollable container
  // (attached to the overflow-y-auto div below) plus a ref tracking
  // whether the user is currently scrolled near its bottom. Kept live by
  // a plain scroll listener rather than read at effect-run time, because
  // by the time the effect a few lines down runs, the new message has
  // ALREADY been appended to the DOM - scrollTop doesn't move on its own
  // just because content was added below it, so this ref still correctly
  // reflects where the user was BEFORE this update, which is exactly the
  // question that matters: were they already following the bottom, or
  // had they moved away? Starts true - an empty/fresh view is trivially
  // "at the bottom."
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const NEAR_BOTTOM_PX = 120;
    const handleScroll = () => {
      isNearBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    handleScroll();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Scrolls ONLY chatScrollRef - never endRef.scrollIntoView(), which per
  // spec is free to also adjust the scrollTop of any scrollable ancestor
  // it passes through (including an `overflow: hidden` one) on its way to
  // the target. That ancestor-walk is the real mechanism behind the
  // "whole page jumps up when a starter card is clicked" bug: this app's
  // shell (page.tsx's outer div, and html/body in globals.css) is only
  // ever made scroll-INVISIBLE, not scroll-inert, so scrollIntoView()
  // calling it mid-layout (during the WelcomeScreen -> messages crossfade,
  // or on the first token of the very first answer) can nudge one of
  // those ancestors instead of, or as well as, chatScrollRef itself.
  // Element.scrollTo() on chatScrollRef directly can only ever move that
  // one element, by construction - there is no ancestor-walk to guard
  // against.
  const scrollChatToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const wasEmpty = prevMessagesLengthRef.current === 0;
    prevMessagesLengthRef.current = messages.length;

    // First guard, from a real bug: setMessages([]) in handleNewChat() is a
    // *new* array reference even when messages was already empty (clicking
    // "New chat" while already on the welcome screen), so this effect fired
    // on every click. endRef sits at the bottom of a container that's
    // min-h-[calc(100vh-16rem)] tall - scrolling it into view dragged the
    // whole pane down past WelcomeScreen's centered content, which is what
    // produced the "composer near the top, blank space below, sidebar
    // scrolled oddly" glitch reported after New Chat. Nothing to scroll to
    // when there's no message list.
    if (messages.length === 0) return;

    // Second guard, from the same symptom reported again - this time from
    // clicking a suggestion card (empty -> one message), not New Chat. The
    // welcome/messages crossfade a few hundred lines down uses
    // AnimatePresence mode="wait": the outgoing WelcomeScreen branch stays
    // mounted, mid-exit-animation, for ~140ms before the messages branch
    // mounts. This effect fires the instant `messages` changes, which is
    // well before that animation finishes - so scrollIntoView was running
    // against a DOM that still had WelcomeScreen's full-height layout in
    // it, landing the scroll position wherever that half-finished layout
    // put it, with nothing to correct it once the real layout settled in.
    // Skipping the empty->non-empty transition specifically sidesteps the
    // race outright rather than trying to time around it: the crossfade
    // already brings the message area into view on its own, and there's
    // nothing below the fold yet on message #1 anyway. Every later message
    // (2nd, 3rd, regenerate, ...) still auto-scrolls exactly as before.
    if (wasEmpty) return;

    // Root cause of the reported "screen shifts up... then shifts down"
    // during a document edit: runProposeEdit() echoes the typed
    // instruction into `messages` the instant it's submitted, and
    // chooseEditAlternative() appends a second confirmation message once
    // a choice is applied - each push re-runs this effect, which was
    // UNCONDITIONALLY smooth-scrolling the whole chat pane to its bottom
    // sentinel regardless of where the user was actually reading. That's
    // invisible for an ordinary quick Q&A turn (the user is normally
    // still sitting at the bottom waiting), but a document edit has a
    // real human gap in the middle - resolving three alternatives,
    // reading them over in DocumentPanel, picking one - during which the
    // user has very likely scrolled the chat away from the bottom (or
    // never left DocumentPanel's own area at all), so the SECOND, later
    // scroll yanked them back down with no warning. Fix: only follow new
    // content when the user was already near the bottom - never steal
    // their scroll position from wherever they've moved to.
    if (!isNearBottomRef.current) return;

    scrollChatToBottom("smooth");
    // 2026-09-25: added `error` to this effect's own dependency array.
    // Found live: a runDocumentEdit() failure (e.g. the edit-clause
    // route's own timeout) calls setError(...) without touching
    // `messages` or `isLoading` at all, so this effect never re-ran and
    // the "Backend error: ..." banner (rendered right above endRef, a
    // few hundred lines down) landed in the DOM below the fold with
    // nothing to scroll it into view - looked exactly like the message
    // vanished into nothing, when it had actually just failed silently
    // off-screen. Same fix applies to any other setError() caller that
    // doesn't otherwise touch messages/isLoading (runProposalReview,
    // handleFileUpload's own catch blocks) - all share this one effect.
  }, [messages, isLoading, error]);

  function handleNewChat() {
    chatSessionRef.current += 1;
    setMessages([]);
    setConversationId(null);
    setError(null);
    setInputValue("");
    setUploadedDocs([]);
    setDrawingFile(null);
    setIsLoading(false);
    setPendingUploadFile(null);
    setReviewPostcode("");
    setIsReviewing(false);
    setActiveReview(null);
    setDocumentPanel(null);
    setIsDocumentPanelCollapsed(false);
    setIsDocumentPanelExpanded(false);
    setDocumentPanelViewMode("report");
    stopListening();
    stopSpeaking();
    setIsVoiceOverlayOpen(false);
  }

  async function handleSelectConversation(id: string) {
    if (id === conversationId) return;
    chatSessionRef.current += 1;
    const sessionToken = chatSessionRef.current;
    setIsLoading(false);
    setLoadingConversationId(id);
    try {
      const res = await fetch(
        `/api/conversations/${id}?visitorId=${encodeURIComponent(visitorId)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data?.messages)) {
        if (!res.ok) {
          try {
            window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
          } catch {
            // localStorage unavailable - nothing to clean up.
          }
        }
        return;
      }
      if (chatSessionRef.current !== sessionToken) return;

      const loaded: ChatMessage[] = data.messages.map((m: any) => {
        const stored = m.metadata || {};
        const metadata =
          m.role === "assistant"
            ? {
                processingtime: stored.processingtime,
                confidence: stored.confidence,
                groundedness: stored.groundedness,
                unsupportedClaims: Array.isArray(stored.unsupportedClaims)
                  ? stored.unsupportedClaims
                  : [],
                // Stored as the same raw shape a live response carries, so
                // this reuses the exact normalization a fresh answer gets.
                citations: mapBackendCitations(stored.citations),
                diagram:
                  stored.diagram?.kind && stored.diagram?.spec
                    ? stored.diagram
                    : undefined,
              }
            : undefined;

        return {
          id: m.id,
          type: m.role === "user" ? "user" : "assistant",
          content: m.content,
          timestamp: new Date(m.created_at),
          metadata,
          skipTypewriter: true,
        };
      });

      setMessages(loaded);
      setConversationId(id);
      setError(null);
      setUploadedDocs([]);
      setDrawingFile(null);
    } catch {
      // best-effort - leave the current chat open if loading fails
    } finally {
      setLoadingConversationId((current) => (current === id ? null : current));
    }
  }

  // File-type/extension gate shared by both upload paths below - split
  // out of the old single handleFileUpload so it can run once, before
  // the user is asked what to do with the file (see handleFileSelected).
  function validateUploadFile(file: File): string | null {
    const validTypes = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ];
    const name = (file.name || "").toLowerCase();
    const extOk =
      name.endsWith(".pdf") ||
      name.endsWith(".png") ||
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".docx") ||
      name.endsWith(".xlsx") ||
      name.endsWith(".xls") ||
      name.endsWith(".csv");
    if (!validTypes.includes(file.type) && !extOk) {
      return "Only PDF, Word, image, and spreadsheet (xlsx/xls/csv) files are supported";
    }
    return null;
  }

  // Replaces the old auto-upload handleFileUpload - added 2026-09-19 so a
  // selected file pauses on a choice (see the pendingUploadFile card
  // rendered near the composer below) instead of immediately going into
  // the cloud Q&A ingestion pipeline. "Ask questions about it" still
  // calls that same pipeline (uploadForQA, below - unchanged logic, just
  // extracted); "Run compliance review" calls runProposalReview instead,
  // which never touches app/api/documents/upload at all - it's a
  // completely separate backend (local-rag's /proposal-review).
  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so re-selecting the same filename later still fires
    // a change event.
    e.currentTarget.value = "";

    const validationError = validateUploadFile(file);
    if (validationError) {
      alert(validationError);
      return;
    }

    setReviewPostcode("");
    setPendingUploadFile(file);
  }

  // The original handleFileUpload body, unchanged, just taking `file`
  // as a parameter instead of reading it off the change event - see
  // handleFileSelected above for why it's no longer called directly
  // on file selection.
  async function uploadForQA(file: File) {
    // Ingested immediately (not on next send) so the document is fully
    // indexed and searchable by the time the user asks their question -
    // see app/api/documents/upload/route.ts + lib/userDocuments.ts.
    const docKey = `${Date.now()}-${file.name}`;
    setUploadedDocs((prev) => [
      ...prev,
      { id: docKey, name: file.name, status: "uploading" },
    ]);
    setIsUploadingDoc(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (visitorId) formData.append("visitorId", visitorId);
      if (conversationId) formData.append("conversationId", conversationId);

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Upload failed (${res.status})`);
      }

      setUploadedDocs((prev) =>
        prev.map((d) => (d.id === docKey ? { ...d, status: "ready" } : d))
      );

      // A brand-new chat gets its conversationId the moment the FIRST
      // upload finishes processing, so later messages in this same chat
      // (and any further uploads) are all scoped to it.
      if (data.conversationId && data.conversationId !== conversationId) {
        setConversationId(data.conversationId);
        setSidebarRefresh((n) => n + 1);
      }

      setInputValue((prev) =>
        prev.trim()
          ? prev
          : `Based on the document I just uploaded (${file.name}), what can be done in this scenario as per NPPF?`
      );
    } catch (err: any) {
      setUploadedDocs((prev) =>
        prev.map((d) => (d.id === docKey ? { ...d, status: "error" } : d))
      );
      setError(err?.message || "Failed to upload document");
    } finally {
      setIsUploadingDoc(false);
      setPendingUploadFile(null);
    }
  }

  // Runs a real compliance review via local-rag's /proposal-review
  // (proxied by app/api/local-rag-proposal-review) - replaces the
  // temporary "Preview sample report (dev)" test button. On success,
  // opens the generated PDF in DocumentPanel and sets activeReview so
  // handleSend starts routing this conversation's messages through
  // /proposal-review-chat (see that block in handleSend below).
  async function runProposalReview(file: File, postcode: string) {
    setIsReviewing(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("files", file);
      if (postcode.trim()) formData.append("postcode", postcode.trim());
      // 2026-09-25: same ragBackend chat answers and document edits
      // already send - a compliance review now runs fully local (zero
      // Groq calls) whenever Ollama is reachable/pulled, automatically,
      // instead of always hitting Groq regardless of local mode.
      formData.append("backend", ragBackend);

      const res = await fetch("/api/local-rag-proposal-review", {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Review failed (${res.status})`);
      }

      const review = data.review || {};
      const reportFiles = data.reportFiles;
      const assessment = review.assessment || {};
      const issues = assessment.issues || [];
      const checklist = assessment.checklist || [];
      const missing = checklist.filter((c: any) => c.status === "missing").length;
      const unclear = checklist.filter((c: any) => c.status === "unclear").length;
      // compliance_status/assessment_coverage/evidence_confidence
      // (2026-09-28 reliability fix, points 1/2/5): a review whose
      // excerpts partly failed to assess must never show a confident
      // Low/Medium/High word here, the same rule report_render.py's own
      // compliance_status handling enforces on the downloadable report -
      // this chat summary is the FIRST thing the user sees, so it's the
      // most important place to get this right, not an afterthought.
      const complianceStatus: string = review.compliance_status || (review.assessment_failed ? "failed" : "final");
      const coverage = review.assessment_coverage
        ? {
            assessedUnits: review.assessment_coverage.assessed_units ?? 0,
            totalUnits: review.assessment_coverage.total_units ?? 0,
            pct: review.assessment_coverage.pct ?? 0,
            complete: !!review.assessment_coverage.complete,
          }
        : null;
      const evidenceConfidence: string | null = review.evidence_confidence || null;
      // Same transparent, disclosed heuristic as report_render.py's
      // _compute_risk() - kept in sync deliberately (see that function's
      // own comment) so the chat summary's risk word never disagrees
      // with the badge on the report the user is looking at. Only
      // computed for a "final" (full-coverage) result - "incomplete"
      // gets its own distinct label below, never a Low/Medium/High word.
      const level =
        complianceStatus !== "final"
          ? complianceStatus === "incomplete"
            ? "Incomplete"
            : null
          : missing >= 2 || issues.length >= 4
          ? "High"
          : missing >= 1 || unclear >= 2 || issues.length >= 1
          ? "Medium"
          : "Low";

      setActiveReview({ review, reportFiles, label: file.name });

      // The first persisted uploaded document (local-rag/document_edit.py
      // save_document(), see app/api/local-rag-proposal-review/route.ts's
      // `documents` field) - only the first, matching this panel's
      // existing one-document-at-a-time design. Undefined when
      // persistence wasn't possible for some reason.
      const firstDocument = Array.isArray(data.documents)
        ? data.documents[0]
        : undefined;
      // The REPORT's own editable identity (2026-09-25, Report-tab
      // correction) - see the documentPanel/reportBlocks state comments
      // above. Independent of firstDocument/docId - a review whose
      // source document failed to persist can still have an editable
      // report, and vice versa.
      const reportDocId: string | undefined =
        typeof data.reportDocId === "string" ? data.reportDocId : undefined;
      setReportBlocks(Array.isArray(data.reportBlocks) ? data.reportBlocks : []);

      // A fresh review always opens visible, even if a previous report was
      // left collapsed (see isDocumentPanelCollapsed's own comment above) -
      // the user just asked for a new report, so hiding it by default
      // would be surprising.
      setIsDocumentPanelCollapsed(false);
      // Same reasoning for fullscreen/tab state (item 4, 2026-09-27 pass):
      // a brand new report shouldn't silently inherit fullscreen or the
      // Document tab from whatever the previous report was left in.
      setIsDocumentPanelExpanded(false);
      setDocumentPanelViewMode("report");

      if (reportFiles?.pdf_url) {
        // The normal case, per the documentPanel state comment above:
        // the generated REPORT is the main view - it's the whole point
        // of running a review, and it's what "that is shown in the view"
        // referred to. The uploaded document rides along as the small
        // secondary download, still editable via chat through docId.
        setDocumentPanel({
          url: reportFiles.pdf_url,
          filename: reportFiles.pdf_filename || `${file.name.replace(/\.[^./]+$/, "")}-report.pdf`,
          documentUrl: firstDocument?.url,
          documentFilename: firstDocument?.filename || file.name,
          docId: firstDocument?.docId,
          reportDocId,
        });
      } else if (firstDocument?.url) {
        // Fallback: report generation failed for some reason (see
        // report_render.py's build_reports() - a WeasyPrint failure
        // never blocks the rest of the review, it just means no PDF).
        // Show the uploaded document itself instead of leaving the panel
        // empty - there's no report to also offer as a secondary button
        // since it doesn't exist this run.
        setDocumentPanel({
          url: firstDocument.url,
          filename: firstDocument.filename || file.name,
          docId: firstDocument.docId,
          reportDocId,
        });
      }

      chatSessionRef.current += 1;
      // Site-detection provenance (site_lookup.detect_site(), only ever
      // set when no postcode/project/lat-lon was supplied - added
      // 2026-09-19, extended 2026-09-20 with the known_places directory
      // tier) - surfaced here rather than silently used, since only
      // "document text" is a fact read off the page; "known place
      // directory" and "place name lookup" are both inferred from a
      // NAME in the document, not a stated postcode, so the user should
      // be able to tell all three apart and correct it by re-running
      // with an explicit postcode if it's wrong. Only "place name
      // lookup" (a live Nominatim guess, no directory match) gets the
      // "double-check this" caveat - a known_places match is a curated,
      // sourced entry, not a fresh guess - see report_render.py's
      // _site_detection_note() for the same three-way split.
      const siteDetection = review.site_detection as
        | { postcode: string; source: string; detail: string }
        | null
        | undefined;
      const siteNote = !postcode.trim() && siteDetection
        ? siteDetection.source === "place name lookup"
          ? `I couldn't find a postcode written in the document, so I looked up the nearest postcode to a name mentioned in it: ${siteDetection.postcode}. Worth double-checking that's the right site — re-run with an explicit postcode if not. `
          : siteDetection.source === "known place directory"
          ? `No postcode was written in the document, but a name in it matched our known-places directory: ${siteDetection.postcode}. `
          : `I found postcode ${siteDetection.postcode} written in the document and used that as the site. `
        : "";

      const userMsg: ChatMessage = {
        id: `${Date.now()}-user`,
        type: "user",
        content: `Review ${file.name}${
          postcode.trim()
            ? ` against ${postcode.trim()}`
            : " (auto-detecting the site from the document)"
        } for compliance.`,
        timestamp: new Date(),
      };
      // complianceStatus === "incomplete" (2026-09-28 reliability fix,
      // points 1/2/5) gets its OWN summary, distinct from both "failed"
      // and a normal complete review - it must never read like a
      // confident result ("Review complete — attention needed: ...")
      // when some of the document genuinely wasn't checked.
      const summaryText =
        complianceStatus === "failed"
          ? `${siteNote}I couldn't generate a full assessment for this one — ${
              review.parse_error || "the model didn't return a usable answer"
            }. Retrieval itself worked, so you can still ask me what evidence was found, or try the review again.`
          : complianceStatus === "incomplete"
          ? `${siteNote}I could only assess part of this document — ${
              coverage ? `${coverage.assessedUnits} of ${coverage.totalUnits} excerpt(s)` : "some excerpts"
            } (${coverage?.pct ?? 0}% coverage)${
              review.parse_error ? `: ${review.parse_error}` : ""
            }. This is not a final compliance result — a "missing" item below may just be in the part that couldn't be checked. I've opened what was found in the panel; you can try the review again for a complete result, or ask me what evidence was retrieved.`
          : `${siteNote}Review complete${
              level ? ` — overall attention needed: ${level}` : ""
            }. I found ${issues.length} issue${
              issues.length === 1 ? "" : "s"
            } and ${missing} required item${
              missing === 1 ? "" : "s"
            } missing from the checklist. I've opened the compliance report in the panel — ask me anything about it, ask me to edit a paragraph in the document you uploaded (I'll rewrite it and ground the change in the same evidence), or download either file from the panel.`;
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: summaryText,
        timestamp: new Date(),
        metadata:
          complianceStatus !== "failed" && checklist.length > 0
            ? { reviewChart: { checklist, issues, issuesCount: issues.length, level, coverage, evidenceConfidence } }
            : undefined,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      // Only clear the choice card on success - added 2026-09-20, real
      // bug found the hard way: this used to run in `finally`, so a
      // FAILED review (e.g. "couldn't auto-detect a postcode") silently
      // dropped the selected file and typed postcode too, leaving just
      // the error toast with no visible way to retry short of
      // re-picking the file from scratch. Now a failed attempt keeps
      // the card up so the user can just type a postcode and retry.
      setPendingUploadFile(null);
      setReviewPostcode("");
    } catch (err: any) {
      setError(err?.message || "Failed to run compliance review");
    } finally {
      setIsReviewing(false);
    }
  }

  // Live, in-place clause editing - alternatives-before-replace workflow
  // (2026-09-25, architecture plan section 53 Phase 2, per the product
  // owner's own detailed voice brief: "detect edit intent, resolve the
  // real source block, highlight it, generate three grounded
  // alternatives, do not change the text yet, show the options, let the
  // user pick one, validate, patch just that block, allow undo, then
  // refresh the PDF"). Replaces the old single-shot runDocumentEdit()
  // (still available server-side as the unchanged /edit-clause endpoint,
  // just no longer called from here) with four small steps against the
  // real propose/choose/reject/revert endpoints:
  //
  //   runProposeEdit()        - resolve target + generate 3 alternatives,
  //                              WRITES NOTHING to the live document yet.
  //   chooseEditAlternative() - apply the alternative the user picked.
  //   rejectEditProposal()    - "keep the original wording".
  //   undoLastEdit()          - revert an already-applied edit back to
  //                              its previous revision.
  //
  // editState drives the small in-panel "editing this paragraph" card
  // (see DocumentPanel.tsx's EditingBlockCard) - its own status field
  // ("resolving" -> "choosing" -> "applying" -> "applied"/"error") is
  // what that card's skeleton-shimmer/highlight/updated-badge states key
  // off of, kept separate from the chat message list so the highlighted-
  // block UI and the permanent chat record can each do their own job.
  type EditAlternative = { index: number; label: string; text: string; rationale?: string };
  type EditState = {
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
    alternatives?: EditAlternative[];
    baseDocVersion?: number;
    previousRevisionId?: string | null;
    errorMessage?: string;
  };
  const [editState, setEditState] = useState<EditState | null>(null);

  async function runProposeEdit(instruction: string) {
    if (!documentPanel?.docId) return;
    const docId = documentPanel.docId;

    const userMsg: ChatMessage = {
      id: `${Date.now()}-user`,
      type: "user",
      content: instruction,
      timestamp: new Date(),
    };
    // Same "the user just explicitly sent this" override as
    // handleSend above - always follow their own submitted instruction
    // down. The LATER confirmation message this function (or
    // chooseEditAlternative) appends after the model responds is NOT
    // covered by this - that one correctly only follows if they're
    // still near the bottom, since by then they've likely moved to
    // DocumentPanel to read the alternatives.
    isNearBottomRef.current = true;
    setMessages((prev) => [...prev, userMsg]);
    setIsEditingClause(true);
    setError(null);
    // "resolving" state - DocumentPanel's editing card shows the
    // skeleton shimmer + "Finding the right paragraph..." from here,
    // before we even know which block it'll be.
    setEditState({ status: "resolving", docId, instruction });

    try {
      // The active review's own merged issue list, so the backend can
      // match "rewrite the fire safety clause" against the ACTUAL
      // compliance issue it's probably about (proposal_review.py's
      // assessment.issues, unchanged shape) rather than only the bare
      // instruction text - see document_edit.match_compliance_issue().
      const issues = activeReview?.review?.assessment?.issues ?? [];

      const res = await fetch("/api/local-rag-propose-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          instruction,
          geography: activeReview?.review?.geography,
          backend: ragBackend,
          issues,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't find that paragraph (${res.status})`);
      }

      setEditState({
        status: "choosing",
        docId,
        instruction,
        patchId: data.patchId,
        paragraphId: data.paragraphId,
        page: data.page,
        bbox: data.bbox,
        originalText: data.originalText,
        matchedIssueTopic: data.matchedIssue?.topic ?? null,
        matchedIssueText: data.matchedIssue?.issue ?? null,
        alternatives: data.alternatives,
        baseDocVersion: data.baseDocVersion,
      });
    } catch (err: any) {
      // Nothing was ever written (propose-edit never touches `blocks`),
      // so there's nothing to roll back - just clear the card and
      // report back in chat, same "always leave a visible message"
      // discipline as every other failure path in handleSend.
      const message = err?.message || "Couldn't find a paragraph matching that instruction.";
      setEditState(null);
      setError(message);
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: message,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } finally {
      setIsEditingClause(false);
    }
  }

  async function chooseEditAlternative(alternativeIndex: number) {
    if (!editState || editState.status !== "choosing") return;
    const { docId, patchId, baseDocVersion, alternatives, paragraphId } = editState;
    if (!patchId || baseDocVersion === undefined) return;

    setIsEditingClause(true);
    setEditState((prev) => (prev ? { ...prev, status: "applying" } : prev));

    try {
      const res = await fetch("/api/local-rag-choose-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          patchId,
          alternativeIndex,
          expectedDocVersion: baseDocVersion,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't apply that revision (${res.status})`);
      }

      if (data.pdfUrl) {
        setDocumentPanel((prev) => (prev ? { ...prev, documentUrl: data.pdfUrl } : prev));
      }

      setEditState((prev) =>
        prev ? { ...prev, status: "applied", previousRevisionId: data.previousRevisionId ?? null } : prev
      );

      const chosen = alternatives?.[alternativeIndex];
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: `Updated paragraph ${paragraphId}${chosen?.label ? ` (${chosen.label} version)` : ""}${
          chosen?.rationale ? ` — ${chosen.rationale}` : ""
        }${
          data.pdfRegenerated === false
            ? ". The change was saved, but I couldn't refresh the document preview just now — try downloading it again in a moment."
            : ". Download the updated document from the panel to see it; the compliance report itself isn't re-run automatically. You can undo this from the editing card for a few seconds, or ask me to change it again."
        }`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Soft "Updated" badge, then auto-clear the card - only if nothing
      // else (e.g. a new edit) has replaced it in the meantime. 1800ms per
      // explicit request (2026-09-25 border-beam follow-up): "a subtle
      // 'Updated' indicator for ~1-2 seconds" - was 3000ms.
      setTimeout(() => {
        setEditState((prev) =>
          prev && prev.patchId === patchId && prev.status === "applied" ? null : prev
        );
      }, 1800);
    } catch (err: any) {
      const message = err?.message || "Couldn't apply that revision.";
      setError(message);
      // Instantly revert to showing the original (nothing optimistic was
      // ever rendered onto the live document - "applying" never touched
      // documentPanel.documentUrl) - just surface the inline error and
      // drop back to the choosing state so the user can try another
      // alternative or reject.
      setEditState((prev) => (prev ? { ...prev, status: "error", errorMessage: message } : prev));
    } finally {
      setIsEditingClause(false);
    }
  }

  async function rejectEditProposal() {
    if (!editState || editState.status !== "choosing") return;
    const { docId, patchId } = editState;
    setEditState(null);
    if (patchId) {
      try {
        await fetch("/api/local-rag-reject-patch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId, patchId }),
        });
      } catch {
        // Best-effort - the proposal simply sits unchosen either way,
        // and never had any effect on the live document regardless.
      }
    }
    const assistantMsg: ChatMessage = {
      id: `${Date.now()}-assistant`,
      type: "assistant",
      content: "Kept the original wording.",
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, assistantMsg]);
  }

  async function undoLastEdit() {
    if (!editState || editState.status !== "applied" || !editState.previousRevisionId) return;
    const { docId, paragraphId, previousRevisionId, baseDocVersion } = editState;
    // choose_patch left the document at baseDocVersion + 1 - that's the
    // version revert_block needs to see as "current" for its own
    // staleness check.
    const expectedDocVersion = (baseDocVersion ?? 0) + 1;

    setIsEditingClause(true);
    setEditState((prev) => (prev ? { ...prev, status: "applying" } : prev));

    try {
      const res = await fetch("/api/local-rag-revert-block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          localId: paragraphId,
          toRevisionId: previousRevisionId,
          expectedDocVersion,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't undo that edit (${res.status})`);
      }
      if (data.pdfUrl) {
        setDocumentPanel((prev) => (prev ? { ...prev, documentUrl: data.pdfUrl } : prev));
      }
      setEditState(null);
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: `Undid that change to paragraph ${paragraphId} — back to the previous wording.`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const message = err?.message || "Couldn't undo that edit.";
      setError(message);
      setEditState((prev) => (prev ? { ...prev, status: "error", errorMessage: message } : prev));
    } finally {
      setIsEditingClause(false);
    }
  }

  function dismissEditState() {
    setEditState(null);
  }

  // --- Inline block editing (2026-09-25, selection-driven, interactive-
  // document-view milestone) - a SECOND, SEPARATE propose/choose/reject/
  // undo state machine, deliberately not sharing editState/runProposeEdit
  // above at all: "keep chat edits as a separate path," per the brief.
  // The two paths hit the exact same backend endpoints (propose-edit,
  // choose-patch, reject-patch, revert-block - same validation/staleness/
  // immutable-revisions/undo guarantees either way), they just get there
  // from different UI: chat's free-text instruction (which still has the
  // backend GUESS the target paragraph) vs. a selection in the new
  // "Document" tab (where the target block is already known, so it's
  // sent explicitly as targetLocalId and never re-guessed - see
  // document_edit.propose_edit()'s own docstring on the backend for the
  // full split). blockEditState drives DocumentPanel's new in-place
  // BlockEditOverlay (border-beam/skeleton directly over the selected
  // block, then the alternatives/exact-replacement popover) instead of
  // EditingBlockCard's side-card - see DocumentPanel.tsx.
  type BlockEditAlternative = { index: number; label: string; text: string; rationale?: string };
  type BlockEditState = {
    status: "resolving" | "choosing" | "applying" | "applied" | "error";
    paragraphId: number;
    page: number;
    bbox: [number, number, number, number];
    instruction: string;
    selectedText: string;
    patchId?: string;
    originalText?: string;
    alternatives?: BlockEditAlternative[];
    isExactReplacement?: boolean;
    baseDocVersion?: number;
    previousRevisionId?: string | null;
    errorMessage?: string;
  };
  const [blockEditState, setBlockEditState] = useState<BlockEditState | null>(null);

  // Selection submitted the instruction (Enter in SelectionCommandBox) -
  // "submitting text there should create a proposed edit request for
  // that specific block ID... Enter just submits the instruction[,] it
  // does not change any text." Nothing is mutated here or anywhere until
  // the user later picks an alternative / applies the exact-replacement
  // preview.
  async function runInlineBlockEdit(
    target: { paragraphId: number; page: number; bbox: [number, number, number, number]; selectedText: string; parentText: string },
    instruction: string
  ) {
    if (!documentPanel?.docId) return;
    const docId = documentPanel.docId;

    setBlockEditState({
      status: "resolving",
      paragraphId: target.paragraphId,
      page: target.page,
      bbox: target.bbox,
      instruction,
      selectedText: target.selectedText,
      originalText: target.parentText,
    });

    try {
      const res = await fetch("/api/local-rag-propose-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          instruction,
          backend: ragBackend,
          targetLocalId: target.paragraphId,
          selectedText: target.selectedText,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't propose that edit (${res.status})`);
      }

      setBlockEditState({
        status: "choosing",
        paragraphId: data.paragraphId ?? target.paragraphId,
        page: data.page ?? target.page,
        bbox: data.bbox ?? target.bbox,
        instruction,
        selectedText: target.selectedText,
        patchId: data.patchId,
        originalText: data.originalText ?? target.parentText,
        alternatives: data.alternatives,
        isExactReplacement: Boolean(data.isExactReplacement),
        baseDocVersion: data.baseDocVersion,
      });
    } catch (err: any) {
      const message = err?.message || "Couldn't propose that edit.";
      setBlockEditState((prev) => (prev ? { ...prev, status: "error", errorMessage: message } : prev));
    }
  }

  // alternativeIndex is always 0 for an exact-replacement preview's
  // single "Apply" button, or the chosen card's index for a normal
  // 3-alternatives choice - same shape as chooseEditAlternative above,
  // just against blockEditState/local-rag-choose-patch's own patchId.
  async function chooseInlineBlockAlternative(alternativeIndex: number) {
    if (!blockEditState || blockEditState.status !== "choosing") return;
    const { patchId, baseDocVersion, alternatives, paragraphId } = blockEditState;
    if (!patchId || baseDocVersion === undefined || !documentPanel?.docId) return;
    const docId = documentPanel.docId;

    setBlockEditState((prev) => (prev ? { ...prev, status: "applying" } : prev));

    try {
      const res = await fetch("/api/local-rag-choose-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, patchId, alternativeIndex, expectedDocVersion: baseDocVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't apply that revision (${res.status})`);
      }

      // "Update only that block in place. Preserve the scroll position,
      // then refresh or regenerate the PDF." - documentUrl swap here is
      // exactly that refresh; InteractiveDocumentView owns preserving
      // scroll position across it (see that component's own comment).
      // The PDF preview (report `url`) is untouched, per the brief.
      if (data.pdfUrl) {
        setDocumentPanel((prev) => (prev ? { ...prev, documentUrl: data.pdfUrl } : prev));
      }
      if (documentPanel?.docId) fetchDocumentParagraphs(documentPanel.docId);

      setBlockEditState((prev) =>
        prev ? { ...prev, status: "applied", previousRevisionId: data.previousRevisionId ?? null } : prev
      );

      const chosen = alternatives?.[alternativeIndex];
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: `Updated paragraph ${paragraphId} from the document view${
          chosen?.rationale ? ` — ${chosen.rationale}` : ""
        }. You can undo this from the editing overlay for a few seconds, or select it again to change it further.`,
        timestamp: new Date(),
      };
      // Same "only follow if already near the bottom" scroll-anchoring
      // discipline as every other later/async chat message - the user is
      // very likely still in the Document tab, not the chat, right now.
      setMessages((prev) => [...prev, assistantMsg]);

      setTimeout(() => {
        setBlockEditState((prev) =>
          prev && prev.patchId === patchId && prev.status === "applied" ? null : prev
        );
      }, 1800);
    } catch (err: any) {
      const message = err?.message || "Couldn't apply that revision.";
      setBlockEditState((prev) => (prev ? { ...prev, status: "error", errorMessage: message } : prev));
    }
  }

  async function rejectInlineBlockEdit() {
    if (!blockEditState || (blockEditState.status !== "choosing" && blockEditState.status !== "error")) return;
    const { patchId } = blockEditState;
    setBlockEditState(null);
    if (patchId && documentPanel?.docId) {
      try {
        await fetch("/api/local-rag-reject-patch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId: documentPanel.docId, patchId }),
        });
      } catch {
        // Best-effort, same as rejectEditProposal above - the proposal
        // simply sits unchosen either way.
      }
    }
  }

  async function undoInlineBlockEdit() {
    if (!blockEditState || blockEditState.status !== "applied" || !blockEditState.previousRevisionId) return;
    if (!documentPanel?.docId) return;
    const docId = documentPanel.docId;
    const { paragraphId, previousRevisionId, baseDocVersion } = blockEditState;
    const expectedDocVersion = (baseDocVersion ?? 0) + 1;

    setBlockEditState((prev) => (prev ? { ...prev, status: "applying" } : prev));

    try {
      const res = await fetch("/api/local-rag-revert-block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, localId: paragraphId, toRevisionId: previousRevisionId, expectedDocVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't undo that edit (${res.status})`);
      }
      if (data.pdfUrl) {
        setDocumentPanel((prev) => (prev ? { ...prev, documentUrl: data.pdfUrl } : prev));
      }
      fetchDocumentParagraphs(docId);
      setBlockEditState(null);
    } catch (err: any) {
      const message = err?.message || "Couldn't undo that edit.";
      setBlockEditState((prev) => (prev ? { ...prev, status: "error", errorMessage: message } : prev));
    }
  }

  function dismissBlockEditState() {
    setBlockEditState(null);
  }

  // --------------------------------------------------------------------
  // Report-block editing (2026-09-25, CORRECTION to the inline-editing
  // milestone above): "the inline editing experience must be implemented
  // in the Report tab, not the Document tab... Document = original
  // uploaded source document, Report = AI-generated compliance report."
  // A THIRD, completely separate propose/choose/reject/undo state
  // machine - deliberately not sharing blockEditState (source PDF
  // blocks) or editState (the original chat-driven path) at all, same
  // "keep chat edits as a separate path" discipline that split those two
  // apart in the first place. Hits the exact same backend endpoints as
  // blockEditState above (propose-edit/choose-patch/reject-patch/
  // revert-block are fully generic over doc_id - see document_edit.py's
  // own "Report-block editing" section), just always against
  // documentPanel.reportDocId instead of documentPanel.docId, and with
  // localId/kind/index identifying the target instead of
  // paragraphId/page/bbox (a report block was never on a PDF page).
  //
  // The one genuinely different step: after a successful choose/undo,
  // the REPORT itself (not a PDF redaction) has to be rebuilt from the
  // block's new text - see local-rag-regenerate-report/route.ts. That
  // response's `assessment` is applied straight into activeReview.review
  // so StructuredReportView (DocumentPanel.tsx) shows the edited text
  // immediately, without a second fetch.
  type ReportBlockEditAlternative = { index: number; label: string; text: string; rationale?: string };
  type ReportBlockEditState = {
    status: "resolving" | "choosing" | "applying" | "applied" | "error";
    localId: number;
    kind: string;
    index: number | null;
    instruction: string;
    selectedText: string;
    patchId?: string;
    originalText?: string;
    alternatives?: ReportBlockEditAlternative[];
    isExactReplacement?: boolean;
    baseDocVersion?: number;
    previousRevisionId?: string | null;
    errorMessage?: string;
    // Added 2026-09-26, six-area Report-tab polish pass: the "Custom"
    // refinement box's own sub-state (area 1 - "a refinement/composition
    // mode operating over the already generated alternatives", NOT a
    // fourth independent blank replacement). customPreviewIndex points at
    // an alternative already appended to `alternatives` below by a
    // refine call, awaiting its own Apply/Back decision before it can
    // touch the report - see refineReportBlockEdit below.
    customLoading?: boolean;
    customError?: string | null;
    customPreviewIndex?: number | null;
  };
  const [reportBlockEditState, setReportBlockEditState] = useState<ReportBlockEditState | null>(null);

  // Persistent, timeout-independent Undo/Redo (2026-09-26, area 3 of the
  // six-area polish pass). Keyed by report block localId. Each stack is a
  // list of REAL, immutable, already-stored block_revisions ids (oldest
  // first - never LLM-reconstructed text) with `pointer` marking which one
  // is currently applied. Undo/Redo just walk pointer left/right and call
  // revert_block with the exact id at the new position - see
  // revertReportBlockToStackIndex below. Deliberately kept independent of
  // reportBlockEditState's own lifecycle (that state still clears itself
  // ~1.8s after a successful apply, same as before) so Undo keeps working
  // long after the transient "✓ Updated" badge/overlay is gone - "leave
  // room for a future redo stack" is satisfied by literally building redo
  // in from the start, not bolting it on later.
  const [reportUndoStacks, setReportUndoStacks] = useState<
    Record<number, { revisionIds: string[]; pointer: number }>
  >({});
  const [reportUndoErrors, setReportUndoErrors] = useState<Record<number, string | null>>({});
  // The report pseudo-document's live optimistic-concurrency version.
  // ALL report blocks share one document-wide `current_version` counter
  // (document_store.py) - so this has to be a single tracked value, not
  // per-block, and every choose/revert call must use the CURRENT value,
  // not whatever was captured when an unrelated block's edit overlay last
  // opened. Refreshed from the live backend response after every
  // propose-edit (data.baseDocVersion, always freshly read server-side)
  // and every choose/revert (data.version) - never incremented by
  // assumption on the client.
  const [reportDocVersion, setReportDocVersion] = useState<number | null>(null);

  // Records one more entry onto a block's undo stack after a successful
  // choose/refine-apply, using the exact revision ids the backend just
  // returned (never derived/guessed). First edit ever seen for a block
  // seeds the stack with [previousRevisionId, newRevisionId] so Undo has
  // somewhere real to land; previousRevisionId is only ever absent if the
  // block truly has no prior revision yet, in which case there's nothing
  // to undo to. A later edit starting from a state reached via Undo
  // truncates the discarded redo branch first, exactly like a normal text
  // editor.
  function pushReportBlockRevision(
    localId: number,
    previousRevisionId: string | null | undefined,
    newRevisionId: string | null | undefined
  ) {
    if (!newRevisionId) return;
    setReportUndoStacks((prev) => {
      const existing = prev[localId];
      let revisionIds: string[];
      if (!existing) {
        revisionIds = previousRevisionId ? [previousRevisionId, newRevisionId] : [newRevisionId];
      } else {
        revisionIds = [...existing.revisionIds.slice(0, existing.pointer + 1), newRevisionId];
      }
      return { ...prev, [localId]: { revisionIds, pointer: revisionIds.length - 1 } };
    });
    setReportUndoErrors((prev) => (prev[localId] ? { ...prev, [localId]: null } : prev));
  }

  // Shared by both Undo and Redo - reverts the block to the exact stored
  // revision id at `newPointer` in its stack (store.revert_block(), never
  // an LLM call), then moves the pointer there and best-effort refreshes
  // the report/PDF, mirroring chooseReportBlockAlternative's own refresh
  // step.
  async function revertReportBlockToStackIndex(localId: number, newPointer: number) {
    if (!documentPanel?.reportDocId) return;
    const reportDocId = documentPanel.reportDocId;
    const stack = reportUndoStacks[localId];
    if (!stack || newPointer < 0 || newPointer >= stack.revisionIds.length) return;
    if (reportDocVersion == null) return;
    const toRevisionId = stack.revisionIds[newPointer];

    setReportUndoErrors((prev) => ({ ...prev, [localId]: null }));

    try {
      const res = await fetch("/api/local-rag-revert-block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: reportDocId, localId, toRevisionId, expectedDocVersion: reportDocVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't undo that edit (${res.status})`);
      }
      if (typeof data.version === "number") setReportDocVersion(data.version);
      setReportUndoStacks((prev) => ({ ...prev, [localId]: { ...stack, pointer: newPointer } }));

      try {
        const regenRes = await fetch("/api/local-rag-regenerate-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportDocId }),
        });
        const regenData = await regenRes.json().catch(() => ({}));
        if (regenRes.ok && regenData?.success) {
          setActiveReview((prev) =>
            prev
              ? {
                  ...prev,
                  reportFiles: { ...prev.reportFiles, ...regenData.reportFiles },
                  review: regenData.assessment
                    ? { ...prev.review, assessment: regenData.assessment }
                    : prev.review,
                }
              : prev
          );
        }
      } catch {
        // Best-effort, same reasoning as chooseReportBlockAlternative above.
      }
    } catch (err: any) {
      const message = err?.message || "Couldn't undo that edit.";
      setReportUndoErrors((prev) => ({ ...prev, [localId]: message }));
    }
  }

  function undoReportBlock(localId: number) {
    const stack = reportUndoStacks[localId];
    if (!stack || stack.pointer <= 0) return;
    void revertReportBlockToStackIndex(localId, stack.pointer - 1);
  }

  function redoReportBlock(localId: number) {
    const stack = reportUndoStacks[localId];
    if (!stack || stack.pointer >= stack.revisionIds.length - 1) return;
    void revertReportBlockToStackIndex(localId, stack.pointer + 1);
  }

  async function runInlineReportEdit(
    target: { localId: number; kind: string; index: number | null; selectedText: string; parentText: string },
    instruction: string
  ) {
    if (!documentPanel?.reportDocId) return;
    const reportDocId = documentPanel.reportDocId;

    setReportBlockEditState({
      status: "resolving",
      localId: target.localId,
      kind: target.kind,
      index: target.index,
      instruction,
      selectedText: target.selectedText,
      originalText: target.parentText,
    });

    try {
      const res = await fetch("/api/local-rag-propose-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId: reportDocId,
          instruction,
          backend: ragBackend,
          targetLocalId: target.localId,
          selectedText: target.selectedText,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't propose that edit (${res.status})`);
      }

      // Always freshly read server-side at propose time - authoritative,
      // never stale, so this doubles as the one place reportDocVersion
      // resyncs itself even if it was never set before (e.g. this is the
      // very first edit attempted this session).
      if (typeof data.baseDocVersion === "number") setReportDocVersion(data.baseDocVersion);

      setReportBlockEditState({
        status: "choosing",
        localId: data.paragraphId ?? target.localId,
        kind: target.kind,
        index: target.index,
        instruction,
        selectedText: target.selectedText,
        patchId: data.patchId,
        originalText: data.originalText ?? target.parentText,
        alternatives: data.alternatives,
        isExactReplacement: Boolean(data.isExactReplacement),
        baseDocVersion: data.baseDocVersion,
      });
    } catch (err: any) {
      const message = err?.message || "Couldn't propose that edit.";
      setReportBlockEditState((prev) => (prev ? { ...prev, status: "error", errorMessage: message } : prev));
    }
  }

  async function chooseReportBlockAlternative(alternativeIndex: number) {
    if (!reportBlockEditState || reportBlockEditState.status !== "choosing") return;
    const { patchId, baseDocVersion, alternatives } = reportBlockEditState;
    if (!patchId || baseDocVersion === undefined || !documentPanel?.reportDocId) return;
    const reportDocId = documentPanel.reportDocId;

    setReportBlockEditState((prev) => (prev ? { ...prev, status: "applying" } : prev));

    try {
      const res = await fetch("/api/local-rag-choose-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: reportDocId, patchId, alternativeIndex, expectedDocVersion: baseDocVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't apply that revision (${res.status})`);
      }

      // "The report/PDF is refreshed... after the user accepts an
      // alternative" - regenerate-report is the report's own analog of
      // the source document's PDF redaction/restamp: it rebuilds the
      // report from the store's now-current block text and returns both
      // the fresh report_files (swapped into activeReview.reportFiles,
      // so the Download button and any PDF fallback view pick it up)
      // and the fresh assessment (swapped into activeReview.review, so
      // StructuredReportView shows the new wording immediately).
      try {
        const regenRes = await fetch("/api/local-rag-regenerate-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportDocId }),
        });
        const regenData = await regenRes.json().catch(() => ({}));
        if (regenRes.ok && regenData?.success) {
          setActiveReview((prev) =>
            prev
              ? {
                  ...prev,
                  reportFiles: { ...prev.reportFiles, ...regenData.reportFiles },
                  review: regenData.assessment
                    ? { ...prev.review, assessment: regenData.assessment }
                    : prev.review,
                }
              : prev
          );
        }
      } catch {
        // Best-effort - the patch itself already applied and is
        // reflected in reportBlockEditState's own "applied" status
        // below; a failed refresh here just means the Download button/
        // PDF fallback stay one revision behind until the next edit or
        // a page reload re-fetches the review.
      }

      // Persistent undo (area 3): record the real stored revision ids the
      // backend just returned onto this block's stack, independent of
      // reportBlockEditState's own transient lifecycle below. Also
      // resync reportDocVersion from this response - it's now the live
      // value for every OTHER block's next edit/undo too, since the
      // whole document shares one version counter.
      if (typeof data.version === "number") setReportDocVersion(data.version);
      pushReportBlockRevision(reportBlockEditState.localId, data.previousRevisionId, data.revisionId);

      setReportBlockEditState((prev) =>
        prev ? { ...prev, status: "applied", previousRevisionId: data.previousRevisionId ?? null } : prev
      );

      const chosen = alternatives?.[alternativeIndex];
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: `Updated the report${chosen?.rationale ? ` — ${chosen.rationale}` : ""}. You can undo this anytime from the block's Undo control, or select it again to change it further.`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      setTimeout(() => {
        setReportBlockEditState((prev) =>
          prev && prev.patchId === patchId && prev.status === "applied" ? null : prev
        );
      }, 1800);
    } catch (err: any) {
      const message = err?.message || "Couldn't apply that revision.";
      setReportBlockEditState((prev) => (prev ? { ...prev, status: "error", errorMessage: message } : prev));
    }
  }

  async function rejectReportBlockEdit() {
    if (
      !reportBlockEditState ||
      (reportBlockEditState.status !== "choosing" && reportBlockEditState.status !== "error")
    )
      return;
    const { patchId } = reportBlockEditState;
    setReportBlockEditState(null);
    if (patchId && documentPanel?.reportDocId) {
      try {
        await fetch("/api/local-rag-reject-patch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId: documentPanel.reportDocId, patchId }),
        });
      } catch {
        // Best-effort, same as rejectInlineBlockEdit above.
      }
    }
  }

  // Superseded 2026-09-26 by the persistent, stack-based undoReportBlock/
  // redoReportBlock above (area 3 of the six-area polish pass) - this
  // timeout-bound version depended on reportBlockEditState.status
  // ("applied") and a guessed "(baseDocVersion ?? 0) + 1" expected
  // version, both of which broke the instant the transient badge cleared
  // or a second edit landed on any block. Undo is no longer tied to this
  // function or to reportBlockEditState's lifecycle at all.

  // "Custom" refinement (area 1) - NOT a fourth independent blank
  // replacement. Operates over the SAME already-open patch's existing
  // alternatives plus the original block text (local-rag/document_edit.py's
  // refine_alternatives()), and appends one more alternative to that same
  // patch rather than starting a new propose-edit cycle. Requires no new
  // apply/validation path: the previewed result is applied by calling
  // chooseReportBlockAlternative with its index, exactly like picking
  // option 1/2/3 (see DocumentPanel.tsx's customPreviewAlt Apply button).
  async function refineReportBlockEdit(instruction: string) {
    if (!reportBlockEditState || reportBlockEditState.status !== "choosing") return;
    const { patchId } = reportBlockEditState;
    const trimmed = instruction.trim();
    if (!patchId || !trimmed || !documentPanel?.reportDocId) return;
    const reportDocId = documentPanel.reportDocId;

    setReportBlockEditState((prev) => (prev ? { ...prev, customLoading: true, customError: null } : prev));

    try {
      const res = await fetch("/api/local-rag-refine-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: reportDocId, patchId, instruction: trimmed, backend: ragBackend }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Couldn't refine that (${res.status})`);
      }

      setReportBlockEditState((prev) => {
        if (!prev || prev.patchId !== patchId) return prev;
        const newAlt: ReportBlockEditAlternative = {
          index: data.index,
          label: data.label || "Custom",
          text: data.text,
          rationale: data.rationale,
        };
        return {
          ...prev,
          alternatives: [...(prev.alternatives || []), newAlt],
          customLoading: false,
          customError: null,
          // "Generate a refined proposal WITHOUT immediately applying
          // it - show the refined result and require Apply/Back" - the
          // preview step, not an auto-apply.
          customPreviewIndex: data.index,
        };
      });
    } catch (err: any) {
      const message = err?.message || "Couldn't refine that.";
      setReportBlockEditState((prev) =>
        prev && prev.patchId === patchId ? { ...prev, customLoading: false, customError: message } : prev
      );
    }
  }

  function backFromReportCustomPreview() {
    setReportBlockEditState((prev) => (prev ? { ...prev, customPreviewIndex: null } : prev));
  }

  function dismissReportBlockEditState() {
    setReportBlockEditState(null);
  }
  // --------------------------------------------------------------------

  // Voice I/O - see lib/useVoiceChat.ts. Built entirely on the browser's
  // native Web Speech API (SpeechRecognition + SpeechSynthesis), so this
  // costs nothing: no API key, no per-request billing, no server round
  // trip either direction.
  //
  // Two features share this one hook:
  //  - Voice dictation: tap the mic, speak, the transcript fills the input
  //    box for you to review/edit before sending (voiceModeEnabled off).
  //  - Voice conversation: flip "Voice conversation" on and the loop runs
  //    hands-free - your speech is sent automatically, the reply is read
  //    aloud, and the mic re-opens for your next turn as soon as the
  //    reply finishes speaking.
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  // Last thing useVoiceChat's onFinalTranscript heard, kept around purely
  // so the full voice overlay's caption doesn't go blank the instant
  // recognition stops - see voiceOverlayCaption below.
  const lastVoiceUtteranceRef = useRef("");
  // The exact text passed to speak() for the reply currently playing (or
  // about to play) - the source text the Speaking-state progressive
  // reveal below slices words out of. A ref because it's written at
  // call-speak time, read every render; never itself triggers a render.
  const speakingTextRef = useRef("");
  // 0..1, driven by useVoiceChat's onProgress (audio.currentTime /
  // audio.duration - the only playback-position signal the self-hosted
  // TTS gives us, since it returns one complete blob with no word/
  // phoneme timing). Reset to 0 at the start of every speak() call so a
  // new reply doesn't start already-revealed.
  const [speechProgress, setSpeechProgress] = useState(0);
  // speak()'s onDone callback (below, in handleSend) fires whenever the
  // self-hosted voice actually finishes - which on CPU-only hardware can
  // be a real ~10+ seconds after the tap that triggered it. A plain
  // closure over voiceModeEnabled captures whatever it was AT THAT TAP,
  // not whatever it is by the time onDone actually runs - so closing
  // voice mode mid-reply didn't stop the mic from reopening once that
  // stale "yes, still in voice mode" check ran. Read via this ref inside
  // onDone instead, so it always sees the current value.
  const voiceModeEnabledRef = useRef(voiceModeEnabled);
  useEffect(() => {
    voiceModeEnabledRef.current = voiceModeEnabled;
  }, [voiceModeEnabled]);
  // Full-screen "voice mode" UI (see components/chat/VoiceModeOverlay.tsx) -
  // separate from voiceModeEnabled itself so the hands-free auto-send/
  // speak/re-listen loop (driven by voiceModeEnabled) keeps working
  // exactly the same whether or not this presentational overlay happens
  // to be open.
  const [isVoiceOverlayOpen, setIsVoiceOverlayOpen] = useState(false);
  // Full-duplex voice (see components/chat/VoiceAgentOverlay.tsx and
  // voice-agent/README.md) - a separate, additive path from the
  // push-to-talk overlay above. Only offered when NEXT_PUBLIC_VOICE_AGENT_URL
  // is configured, since it depends on the voice-agent/ process actually
  // running; the original overlay keeps working unchanged either way.
  const [isVoiceAgentOverlayOpen, setIsVoiceAgentOverlayOpen] = useState(false);
  const voiceAgentUrl = process.env.NEXT_PUBLIC_VOICE_AGENT_URL;
  const {
    sttSupported,
    ttsSupported,
    isListening,
    isSpeaking,
    isPreparingSpeech,
    sttError,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
  } = useVoiceChat({
    onInterimTranscript: (text) => setInputValue(text),
    onFinalTranscript: (text) => {
      setInputValue(text);
      // Kept so the full voice overlay can still show what the user said
      // once recognition itself stops (isListening -> false) and the
      // turn moves into "thinking" - see voiceOverlayCaption below. Without
      // this the transcript the user just watched build up word-by-word
      // vanished the instant they stopped talking, well before the reply
      // even started - reported explicitly as a missing acceptance test.
      lastVoiceUtteranceRef.current = text;
      if (voiceModeEnabled && text.trim()) {
        handleSend(text);
      }
    },
  });

  const handleMicClick = () => {
    if (isSpeaking) {
      stopSpeaking();
      return;
    }
    if (isListening) {
      stopListening();
    } else {
      setInputValue("");
      startListening();
    }
  };

  const voiceOverlayState: VoiceOverlayState = isSpeaking
    ? "speaking"
    : isLoading || isPreparingSpeech
    ? "thinking"
    : isListening
    ? "listening"
    : "idle";

  // Word-sliced proportional reveal: we don't know which word CosyVoice2
  // is speaking at any given instant (no timing data comes back with the
  // audio), but we do know the full text and how far through playback we
  // are, so "reveal the same fraction of words as we're through the
  // audio" reads as a natural follow-along without pretending to a
  // precision we don't have.
  const voiceSpeakingReveal = (() => {
    const full = speakingTextRef.current;
    if (!full) return "";
    const words = full.split(/\s+/).filter(Boolean);
    if (words.length === 0) return "";
    const count = Math.max(1, Math.ceil(speechProgress * words.length));
    return words.slice(0, count).join(" ");
  })();

  const voiceOverlayCaption = isSpeaking
    ? voiceSpeakingReveal
    : isListening
    ? inputValue
    : voiceOverlayState === "thinking"
    ? lastVoiceUtteranceRef.current
    : "";

  const handleVoiceOverlayOrbClick = () => {
    if (isSpeaking) {
      stopSpeaking();
      startListening();
      return;
    }
    if (isListening) {
      stopListening();
      return;
    }
    // Also block while a reply is still being generated as speech - CPU
    // TTS generation can take several real seconds, and without this a
    // tap here during that gap starts listening for a new question while
    // the previous answer's audio hasn't even started yet (see
    // lib/useVoiceChat.ts's isPreparingSpeech for why isLoading alone
    // isn't enough: it's already false again by this point).
    if (isLoading || isPreparingSpeech) return;
    startListening();
  };

  const handleCloseVoiceOverlay = () => {
    stopListening();
    stopSpeaking();
    setVoiceModeEnabled(false);
    setIsVoiceOverlayOpen(false);
  };

  const handleStartVoiceConversation = () => {
    setInputValue("");
    setVoiceModeEnabled(true);
    setIsVoiceOverlayOpen(true);
    startListening();
  };

  // Probes the local-rag service's /health via our own proxy (avoids a
  // cross-origin request straight to localhost:8010 from the browser)
  // whenever the user switches to local mode, so an offline service shows
  // a clear status instead of a confusing failure on first send.
  useEffect(() => {
    if (ragSource !== "local") return;
    let cancelled = false;
    setLocalRagStatus("checking");
    fetch("/api/local-rag-chat")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setLocalRagStatus(data?.reachable ? "reachable" : "unreachable");
          const ollama = data?.ollama;
          setOllamaStatus({
            available: !!ollama?.available,
            models: Array.isArray(ollama?.models) ? ollama.models : [],
            default_model: ollama?.default_model || "",
            default_model_pulled: !!ollama?.default_model_pulled,
          });
          // Automatic, not opt-in (2026-09-25) - "Local (offline)" now
          // means fully local whenever it genuinely can: answer
          // generation routes through Ollama the moment it's reachable
          // and has the default model pulled, with no separate control
          // for the user to notice or tick. Falls back to "groq"
          // (cloud generation, local retrieval only) silently when
          // Ollama isn't ready yet - the existing "service not
          // running"/"checking…" status text above already covers the
          // local-rag-unreachable case, so no new status text is added
          // here for the Ollama-specific fallback.
          setRagBackend(
            ollama?.available && ollama?.default_model_pulled ? "ollama" : "groq"
          );
        }
      })
      .catch(() => {
        if (!cancelled) setLocalRagStatus("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [ragSource]);

  // Streams local mode's answer via /api/local-rag-chat/stream (SSE) -
  // see FEATURES.localStreamingAnswers and app/api/local-rag-chat/
  // stream/route.ts's own comments for the full design. Mirrors cloud
  // mode's own timing: no assistant bubble appears at all until there's
  // real text to show it (ThinkingIndicator is the only thing visible
  // until then) - the message is inserted lazily on the first non-empty
  // "delta", not eagerly when the request starts. (The previous version
  // inserted an empty bubble immediately, so local mode showed a blank
  // message card sitting above the "Reranking..." status the whole time
  // it was thinking - cloud mode never does that, since it isn't
  // streaming and only ever renders the finished answer in one shot.)
  // Later "delta" events just append to that same bubble once it
  // exists; "done" sets the authoritative final answer text/metadata
  // (citations, confidence, groundedness) - see stream_answer()'s
  // docstring in local-rag/answer.py for why the final text can differ
  // slightly from the concatenation of every delta (the post-stream
  // repair/groundedness passes) - and also creates the bubble itself if
  // somehow no delta ever arrived, so a real answer is never lost.
  const sendLocalStreaming = async (prompt: string, sessionToken: number) => {
    const assistantId = `${Date.now()}-assistant`;
    const startTimestamp = new Date();

    const upsertAssistantMessage = (
      content: string,
      extra: Partial<ChatMessage> = {}
    ) => {
      setMessages((prev) =>
        prev.some((m) => m.id === assistantId)
          ? prev.map((m) =>
              m.id === assistantId ? { ...m, content, ...extra } : m
            )
          : [
              ...prev,
              {
                id: assistantId,
                type: "assistant",
                content,
                timestamp: startTimestamp,
                skipTypewriter: true,
                // Overridden by the 'done' handler's own metadata object
                // (extra) once real citations are ready.
                metadata: { citationsPending: true },
                ...extra,
              },
            ]
      );
    };

    const res = await fetch("/api/local-rag-chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: prompt,
        backend: ragBackend,
        visitorId: visitorId || undefined,
        conversationId: conversationId || undefined,
      }),
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `API returned ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!rawEvent.trim()) continue;

        let eventName = "message";
        let dataLine = "";
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;

        let payload: any;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }

        if (eventName === "delta") {
          accumulated += payload.text || "";
          if (chatSessionRef.current !== sessionToken) continue;
          // Nothing to show yet - stay on the thinking indicator alone
          // rather than popping an empty card in above it.
          if (!accumulated) continue;
          upsertAssistantMessage(accumulated);
        } else if (eventName === "done") {
          if (chatSessionRef.current !== sessionToken) return;

          const finalAnswer = payload.answer || accumulated;
          const mappedCitations = mapBackendCitations(
            extractRawCitations({ citations: payload.citations })
          );

          upsertAssistantMessage(finalAnswer, {
            metadata: {
              processingtime:
                (payload.retrieval_ms || 0) + (payload.generation_ms || 0),
              confidence: payload.confidence,
              groundedness: payload.groundedness,
              unsupportedClaims: payload.unsupportedClaims || [],
              citations: mappedCitations,
              citationsPending: false,
              mapCitations: Array.isArray(payload.mapCitations)
                ? payload.mapCitations
                : [],
              sitePostcode: payload.postcode,
            },
          });

          // Adopt the conversationId the server resolved this turn
          // against (see app/api/local-rag-chat/stream/route.ts) - same
          // handling as the Cloud path's returnedConversationId below in
          // handleSend, duplicated here because this streaming branch
          // returns before reaching that shared code.
          if (payload.conversationId) {
            setSidebarRefresh((n) => n + 1);
            if (payload.conversationId !== conversationId) {
              setConversationId(payload.conversationId);
            }
          }

          if (voiceModeEnabled && ttsSupported) {
            const speechText = sanitizeForSpeech(finalAnswer);
            speakingTextRef.current = speechText;
            setSpeechProgress(0);
            speak(
              speechText,
              () => {
                if (voiceModeEnabledRef.current) startListening();
              },
              (fraction) => setSpeechProgress(fraction)
            );
          }
        }
      }
    }
  };

  const handleSend = async (overridePrompt?: string) => {
    const prompt = (overridePrompt ?? inputValue).trim();
    if (
      (!prompt && !drawingFile) ||
      isLoading ||
      isUploadingDoc ||
      isReviewing ||
      isEditingClause
    )
      return;

    // Live, in-place clause editing via the alternatives-before-replace
    // workflow (2026-09-25, architecture plan section 53 Phase 2 - see
    // runProposeEdit()/chooseEditAlternative() above, and local-rag/
    // document_edit.py's own "Phase 2" module docstring section). Only
    // intercepts while a persisted, editable document is actually open
    // (documentPanel.docId loaded) AND the message reads like an edit
    // instruction - anything else (no document open, or an ambiguous/
    // plain question) falls through to the normal flow below unchanged,
    // including the existing /proposal-review-chat Q&A path.
    if (documentPanel?.docId && looksLikeEditInstruction(prompt)) {
      setInputValue("");
      await runProposeEdit(prompt);
      return;
    }

    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      type: "user",
      content: prompt,
      timestamp: new Date(),
    };

    // The user just explicitly sent this - always follow it down,
    // regardless of where they'd scrolled to before (part of the
    // 2026-09-25 scroll-anchoring fix, see isNearBottomRef's own
    // comment above: this is the one case that SHOULD override
    // wherever they'd scrolled to, since it's their own fresh action,
    // not an async arrival they may not still be watching for).
    isNearBottomRef.current = true;
    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");
    setIsLoading(true);
    setError(null);

    chatSessionRef.current += 1;
    const sessionToken = chatSessionRef.current;

    try {
      const useLocalStreaming =
        FEATURES.localStreamingAnswers &&
        ragSource === "local" &&
        !activeReview &&
        !(chatMode === "feasibility" && drawingFile);

      if (useLocalStreaming) {
        await sendLocalStreaming(prompt, sessionToken);
        setDrawingFile(null);
        return;
      }

      let res: Response;

      if (activeReview) {
        // Every message in this conversation is answered as a follow-up
        // to the active review until the user clears it (see the
        // "Exit review" control near the composer) - grounded in the
        // review's own findings but still a full corpus search, not a
        // narrower one. See app/api/local-rag-proposal-review-chat/
        // route.ts and proposal_review.build_review_context_text()'s
        // docstring in local-rag for the reasoning.
        res = await fetch("/api/local-rag-proposal-review-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: prompt,
            review: activeReview.review,
          }),
        });
      } else if (chatMode === "feasibility" && drawingFile) {
        const formData = new FormData();
        formData.append("query", prompt);
        formData.append("mode", chatMode);
        formData.append("drawingFile", drawingFile);
        if (visitorId) formData.append("visitorId", visitorId);
        if (conversationId) formData.append("conversationId", conversationId);
        formData.append("voiceMode", voiceModeEnabled ? "true" : "false");

        res = await fetch("/api/rag-chat", {
          method: "POST",
          body: formData,
        });
      } else if (ragSource === "local") {
        // Local-rag has no feasibility/permitting/risk handling, so
        // chatMode/voiceMode aren't sent - but it does now save/resume
        // conversations through the same conversations/chat_messages
        // tables Cloud mode uses (see app/api/local-rag-chat/route.ts
        // and lib/conversationMemory.ts), so visitorId/conversationId
        // are sent just like the Cloud branch below.
        res = await fetch("/api/local-rag-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: prompt,
            backend: ragBackend,
            visitorId: visitorId || undefined,
            conversationId: conversationId || undefined,
          }),
        });
      } else {
        res = await fetch("/api/rag-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: prompt,
            mode: chatMode,
            visitorId: visitorId || undefined,
            conversationId: conversationId || undefined,
            voiceMode: voiceModeEnabled,
          }),
        });
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `API returned ${res.status}`);
      }

      const answerText =
        data?.answer || data?.message || "No answer generated.";

      const processingTime =
        data?.metadata?.processing_time ||
        data?.metadata?.processingtime ||
        0;

      const confidence = data?.metadata?.confidence;
      const groundedness = data?.metadata?.groundedness;
      const unsupportedClaims: string[] = Array.isArray(
        data?.metadata?.unsupportedClaims
      )
        ? data.metadata.unsupportedClaims
        : [];
      const mappedCitations = mapBackendCitations(extractRawCitations(data));
      const diagram = extractDiagram(data);
      const termCorrections = Array.isArray(data?.data?.corrections)
        ? data.data.corrections
        : undefined;
      // Only present on local-rag's postcode-triggered /site-answer path
      // (see app/api/local-rag-chat/route.ts) - undefined/empty for
      // every other query, which MapCitationsSection treats as "nothing
      // to show" the same as it does for the streaming path.
      const mapCitations = Array.isArray(data?.mapCitations)
        ? data.mapCitations
        : [];

      const aiMessage: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: answerText,
        timestamp: new Date(),
        metadata: {
          processingtime: processingTime,
          confidence,
          groundedness,
          unsupportedClaims,
          citations: mappedCitations,
          diagram,
          corrections: termCorrections,
          complianceResult:
            data?.complianceResult ??
            data?.data?.complianceResult ??
            data?.metadata?.complianceResult,
          mapCitations,
          sitePostcode: data?.metadata?.postcode,
        },
      };

      const isStale = chatSessionRef.current !== sessionToken;

      // The chat this reply belongs to is no longer open (the user
      // clicked New chat or switched conversations while it was still
      // generating). It was already saved server-side, so nothing is
      // lost - it'll show up under its own conversation in the sidebar.
      // We just don't drop it into whatever chat happens to be open now.
      if (!isStale) {
        setMessages((prev) => [...prev, aiMessage]);
        setDrawingFile(null);

        if (voiceModeEnabled && ttsSupported) {
          // Prefer the backend's natural, spoken-style rewrite
          // (humanizeForSpeech in app/api/rag-chat/route.ts) - it says the
          // same thing a person would say out loud, rather than reading
          // the cited, document-formatted on-screen answer verbatim.
          const speechText: string =
            data?.data?.speechText || sanitizeForSpeech(answerText);
          speakingTextRef.current = speechText;
          setSpeechProgress(0);
          speak(
            speechText,
            () => {
              if (voiceModeEnabledRef.current) startListening();
            },
            (fraction) => setSpeechProgress(fraction)
          );
        }
      }

      const returnedConversationId = data?.metadata?.conversationId;
      if (returnedConversationId) {
        setSidebarRefresh((n) => n + 1);
        if (!isStale && returnedConversationId !== conversationId) {
          setConversationId(returnedConversationId);
        }
      }
    } catch (err: any) {
      if (chatSessionRef.current !== sessionToken) return;

      const message = err?.message || "Unknown error";
      setError(message);

      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-assistant-error`,
          type: "assistant",
          content: `Error: ${message}`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      if (chatSessionRef.current === sessionToken) {
        setIsLoading(false);
      }
    }
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // isComposing guards IME input: mid-composition Enter commits the
    // candidate word, and treating it as "send" fires a half-typed message in
    // Japanese, Chinese and Korean.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full bg-gradient-to-br from-[#f7f4ee] via-[#f2efe7] to-[#f7f4ee] text-neutral-900">
      {isVoiceOverlayOpen && (
        <VoiceModeOverlay
          state={voiceOverlayState}
          liveCaption={voiceOverlayCaption}
          onOrbClick={handleVoiceOverlayOrbClick}
          onClose={handleCloseVoiceOverlay}
        />
      )}
      {isVoiceAgentOverlayOpen && (
        <VoiceAgentOverlay onClose={() => setIsVoiceAgentOverlayOpen(false)} />
      )}
      <ConversationSidebar
        visitorId={visitorId}
        activeConversationId={conversationId}
        loadingConversationId={loadingConversationId}
        refreshSignal={sidebarRefresh}
        onSelectConversation={handleSelectConversation}
        onNewChat={handleNewChat}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
      />

      {/* overflow-hidden (2026-09-28, live-diagnostic overlap-bug
          fix): at a narrow viewport with the report panel open, this
          column can be flex-shrunk to a sliver - a bare <textarea>'s
          browser-default intrinsic min-width doesn't shrink with it
          (confirmed live: the column measured 0px wide while its own
          textarea still rendered ~107px, bleeding into the report
          panel). This column's own content, including its floating
          composer, must never paint outside its own box regardless of
          what any descendant's intrinsic size wants - the same
          containment DocumentPanel's own body wrapper already uses. */}
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-neutral-950/5 px-4 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setIsSidebarOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-xl border border-neutral-950/10 bg-neutral-950/5 text-neutral-700 hover:bg-neutral-950/10"
          aria-label="Open chat history"
        >
          <MenuIcon className="h-4 w-4" />
        </button>
        <span className="text-xs font-medium text-neutral-600">
          Urban AI Assistant
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
      <div
        ref={chatScrollRef}
        className="h-full overflow-y-auto px-4 py-6 sm:px-6"
        style={{ paddingBottom: composerReserve }}
      >
      {/* Same min-height whether the welcome screen or a conversation is
          showing, so the scroll container does not resize under the user
          the instant they send - which is what made the thinking
          indicator appear to snap to the top of an empty page. */}
      <div className="mx-auto flex min-h-[calc(100vh-16rem)] w-full max-w-3xl flex-col space-y-6 px-2 sm:px-4">
          {/* mode="wait" - not a plain unmount/mount swap any more, but
              deliberately NOT a true overlapping crossfade either. Tried
              overlapping first (both branches mounted briefly, old fading
              out while new fades in); it produced a real layout bug: this
              container's children stretch to min-h-[calc(100vh-16rem)]
              (see the comment above), so for ~150ms two of them were in the
              DOM at once, roughly doubling the scroll container's height
              and visibly jumping the page/sidebar - exactly what showed up
              switching between a conversation and "New chat". mode="wait"
              fully unmounts the outgoing branch before the incoming one
              mounts, so only one ever contributes height. Costs ~140ms of
              delay before the reply area appears after the first message -
              acceptable; the layout jump was not. initial={false} on the
              outer AnimatePresence means a restored conversation (messages
              already populated on first render) never plays this as an
              entrance animation - only a live transition from an actually-
              empty state does. */}
          <AnimatePresence mode="wait" initial={false}>
            {messages.length === 0 ? (
              <motion.div
                key="welcome"
                exit={{ opacity: 0, y: -12 }}
                transition={{
                  duration: shouldReduceMotion ? 0.01 : 0.14,
                  ease: EASE_SETTLE,
                }}
              >
                <WelcomeScreen onSuggestionClick={(s) => handleSend(s)} />
              </motion.div>
            ) : (
              <motion.div
                key="messages"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: shouldReduceMotion ? 0.01 : 0.18,
                  ease: EASE_SETTLE,
                }}
              >
                <AnimatePresence>
                  {messages.map((message, index) => (
                    <div
                      key={message.id}
                      className="rise"
                      // Cap the stagger: on a restored 40-message conversation an
                      // uncapped cascade would take two seconds to finish drawing.
                      style={{ ["--i" as any]: Math.min(index, 6) }}
                    >
                    <MessageBubble
                      key={message.id}
                      message={message}
                      setMessages={setMessages}
                      onTypingProgress={() => {
                        // Same scroll-anchoring discipline as the
                        // message-list effect above (2026-09-25 fix):
                        // this fires on every chunk of a message's
                        // typewriter reveal, completely separately from
                        // that effect - it was ALSO unconditionally
                        // dragging the view to the bottom while any
                        // message typed itself out, which turned out to
                        // be the bigger contributor to the reported
                        // "shifts down" (the edit flow's own confirmation
                        // message types itself out through this same
                        // MessageBubble path). Gated the same way: only
                        // follow the typing if the user was already
                        // reading from the bottom.
                        if (!isNearBottomRef.current) return;
                        scrollChatToBottom("auto");
                      }}
                      queryText={
                        message.type === "assistant"
                          ? [...messages]
                              .slice(0, index)
                              .reverse()
                              .find((m) => m.type === "user")?.content
                          : undefined
                      }
                      onRegenerate={
                        message.type === "assistant"
                          ? () => {
                              const priorUser = [...messages]
                                .slice(0, index)
                                .reverse()
                                .find((m) => m.type === "user");
                              if (priorUser) handleSend(priorUser.content);
                            }
                          : undefined
                      }
                    />
                    </div>
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {(() => {
            const lastMessage = messages[messages.length - 1];
            const showThinkingIndicator =
              isLoading &&
              !(
                lastMessage?.type === "assistant" &&
                lastMessage.content.trim().length > 0
              );
            return showThinkingIndicator && <ThinkingIndicator />;
          })()}

          {error && (
            <div className="max-w-md rounded-xl border border-neutral-950/25 bg-neutral-950/[0.06] px-3 py-2 text-xs text-neutral-950">
              Backend error: {error}
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <FloatingComposerShell
        fadeBackground="#f7f4ee"
        onMeasure={setComposerReserve}
        glass={FEATURES.liquidGlassComposer}
        belowChildren={
          <MainChatComposerContext
            isReviewing={isReviewing}
            pendingUploadFile={pendingUploadFile}
            reviewPostcode={reviewPostcode}
            onReviewPostcodeChange={setReviewPostcode}
            onAskQuestionsAboutFile={(file) => uploadForQA(file)}
            onRunComplianceReview={(file, postcode) => runProposalReview(file, postcode)}
            onCancelPendingUpload={() => {
              setPendingUploadFile(null);
              setReviewPostcode("");
            }}
            reviewingLabel={<ReviewingLabel />}
            uploadedDocs={uploadedDocs}
            onDismissUploadedDoc={(id) =>
              setUploadedDocs((prev) => prev.filter((d) => d.id !== id))
            }
            activeReview={activeReview}
            onExitReviewChat={() => setActiveReview(null)}
            drawingAnalysisEnabled={FEATURES.drawingAnalysis}
            chatMode={chatMode}
            drawingFile={drawingFile}
            onDrawingFileChange={setDrawingFile}
            isLoading={isLoading}
            modeSelectorEnabled={FEATURES.modeSelector}
            isModeMenuOpen={isModeMenuOpen}
            onToggleModeMenu={() => setIsModeMenuOpen((v) => !v)}
            onSelectChatMode={setChatMode}
            ragSourceToggleEnabled={FEATURES.ragSourceToggle}
            ragSource={ragSource}
            onRagSourceChange={setRagSource}
            localRagStatus={localRagStatus}
            voiceAgentUrl={voiceAgentUrl}
            onOpenVoiceAgentOverlay={() => setIsVoiceAgentOverlayOpen(true)}
            composerRef={composerRef}
            inputValue={inputValue}
            onInputChange={setInputValue}
            onKeyDown={onKeyDown}
            onSend={() => handleSend()}
            onFileSelected={handleFileSelected}
            isUploadingDoc={isUploadingDoc}
            sttSupported={sttSupported}
            ttsSupported={ttsSupported}
            isListening={isListening}
            isSpeaking={isSpeaking}
            sttError={sttError}
            onMicClick={handleMicClick}
            onStartVoiceConversation={handleStartVoiceConversation}
            isEditingClause={isEditingClause}
          />
        }
      >
        <MainChatComposerBar
          composerRef={composerRef}
          inputValue={inputValue}
          onInputChange={setInputValue}
          onKeyDown={onKeyDown}
          isLoading={isLoading}
          onSend={() => handleSend()}
          onFileSelected={handleFileSelected}
          isUploadingDoc={isUploadingDoc}
          isReviewing={isReviewing}
          pendingUploadFile={pendingUploadFile}
          sttSupported={sttSupported}
          ttsSupported={ttsSupported}
          isListening={isListening}
          isSpeaking={isSpeaking}
          sttError={sttError}
          onMicClick={handleMicClick}
          onStartVoiceConversation={handleStartVoiceConversation}
          drawingFile={drawingFile}
          isEditingClause={isEditingClause}
        />
      </FloatingComposerShell>
      </div>
      </div>

      {/* Side panel showing the generated compliance report (see the
          documentPanel state above and components/chat/DocumentPanel.tsx)
          - a sibling of the main chat column, same outer flex row as
          ConversationSidebar, so it docks to the right the same way the
          sidebar docks to the left. */}
      {documentPanel && (
        <DocumentPanel
          url={documentPanel.url}
          filename={documentPanel.filename}
          documentUrl={documentPanel.documentUrl}
          documentFilename={documentPanel.documentFilename}
          onClose={() => setDocumentPanel(null)}
          isCollapsed={isDocumentPanelCollapsed}
          onToggleCollapse={toggleDocumentPanelCollapsed}
          isExpanded={isDocumentPanelExpanded}
          onToggleExpanded={toggleDocumentPanelExpanded}
          viewMode={documentPanelViewMode}
          onViewModeChange={setDocumentPanelViewMode}
          editState={editState}
          onChooseAlternative={chooseEditAlternative}
          onRejectEdit={rejectEditProposal}
          onUndoEdit={undoLastEdit}
          onDismissEdit={dismissEditState}
          documentParagraphs={documentParagraphs}
          blockEditState={blockEditState}
          onSubmitBlockInstruction={runInlineBlockEdit}
          onChooseBlockAlternative={chooseInlineBlockAlternative}
          onRejectBlockEdit={rejectInlineBlockEdit}
          onUndoBlockEdit={undoInlineBlockEdit}
          onDismissBlockEdit={dismissBlockEditState}
          assessment={activeReview?.review?.assessment}
          reportGeography={activeReview?.review?.geography}
          reportConstraintSummary={activeReview?.review?.constraint_summary}
          reportBlocks={reportBlocks}
          reportBlockEditState={reportBlockEditState}
          onSubmitReportInstruction={runInlineReportEdit}
          onChooseReportAlternative={chooseReportBlockAlternative}
          onRejectReportEdit={rejectReportBlockEdit}
          onDismissReportEdit={dismissReportBlockEditState}
          onRefineReportEdit={refineReportBlockEdit}
          onBackFromReportCustomPreview={backFromReportCustomPreview}
          reportUndoStacks={reportUndoStacks}
          reportUndoErrors={reportUndoErrors}
          onUndoReportBlock={undoReportBlock}
          onRedoReportBlock={redoReportBlock}
        />
      )}
    </div>
  );
}

// Same curve as --ease-settle in globals.css (DESIGN.md: "one easing
// curve"). Framer Motion animates via JS, not CSS, so it can't read the
// custom property directly - this keeps the two in numeric sync by hand.
const EASE_SETTLE: [number, number, number, number] = [0.16, 1, 0.3, 1];

function WelcomeScreen({
  onSuggestionClick,
}: {
  onSuggestionClick: (s: string) => void;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    // min-h fills the space the composer leaves, so the block sits optically
    // centred instead of stranded at the top above 600px of nothing.
    <div className="flex min-h-[calc(100vh-16rem)] flex-col items-center justify-center py-10">
      <div className="w-full max-w-4xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt=""
          aria-hidden="true"
          className="rise mx-auto mb-7 h-16 w-16 object-contain opacity-90"
        />

        {/* Solid ink, not gradient-clipped text. tracking-tight because
            Manrope at display size opens up more than Inter did. */}
        {/* Two lines, the second dropped to muted ink. In the dark draft this
            was a blue-to-pink gradient; on this ground the accent IS ink
            (DESIGN.md), so the second clause steps back in weight instead of
            changing hue. The product name lives in the sidebar and the tab
            title - repeating it here as the headline spent the largest type
            on the page saying nothing. */}
        <h1
          className="mb-4 text-center text-[2.15rem] font-semibold leading-[1.08] tracking-tight text-neutral-950 sm:text-[2.9rem]"
          style={{ textWrap: "balance" as any }}
        >
          {/* Each line reveals on its own beat rather than the whole
              headline fading in as one block - same opacity/y move .rise
              does, just choreographed in two steps instead of one. */}
          <motion.span
            className="block"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: shouldReduceMotion ? 0.01 : 0.42, ease: EASE_SETTLE }}
          >
            A clearer view.
          </motion.span>
          <motion.span
            className="block text-neutral-500"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: shouldReduceMotion ? 0.01 : 0.42,
              ease: EASE_SETTLE,
              delay: shouldReduceMotion ? 0 : 0.07,
            }}
          >
            A better decision.
          </motion.span>
        </h1>

        <motion.p
          className="mx-auto mb-10 max-w-[46ch] text-center text-[0.95rem] leading-relaxed text-neutral-600"
          initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: shouldReduceMotion ? 0.01 : 0.42,
            ease: EASE_SETTLE,
            delay: shouldReduceMotion ? 0 : 0.14,
          }}
        >
          Grounded regulatory answers with citations, page references and
          clause-level support.
        </motion.p>

        {/* Hairline label rather than a floating "Try asking:" line - the rule
            does the separating, the words just name the group. */}
        <div className="rise mb-4 flex items-center gap-4" style={{ ["--i" as any]: 3 }}>
          <span className="h-px flex-1 bg-neutral-950/10" />
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500">
            Start with
          </span>
          <span className="h-px flex-1 bg-neutral-950/10" />
        </div>

        {/* Exactly as many cells as there are suggestions. Entrance is CSS, so
            the cards are visible even if JS animation never runs. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {suggestions.map(({ policy, topic, question }, i) => (
            <motion.button
              key={question}
              type="button"
              onClick={() => onSuggestionClick(question)}
              style={{ ["--i" as any]: 4 + i }}
              className="rise group relative flex min-h-[6.5rem] w-full flex-col justify-start rounded-2xl border border-neutral-950/[0.08] bg-[#fbf9f5] p-5 pr-11 text-left shadow-paper-xs transition-[background-color,border-color,box-shadow] duration-200 ease-settle hover:border-neutral-950/20 hover:bg-white hover:shadow-paper-md"
              // Replaces the .press CSS class for these cards specifically -
              // Framer now owns their transform (lift on hover, settle on
              // tap) so it can share one easing curve with the rest of this
              // screen's motion instead of mixing a CSS :active transform in
              // too. No hover scale-up (DESIGN.md) - only a translateY lift.
              whileHover={shouldReduceMotion ? undefined : { y: -3 }}
              whileTap={shouldReduceMotion ? undefined : { y: 0, scale: 0.985 }}
              transition={{ duration: 0.14, ease: EASE_SETTLE }}
            >
              {/* Arrow parked top-right rather than on a row of its own at the
                  bottom. On the draft that row added ~50px of empty height to
                  every card and pushed the set below the fold. */}
              <ArrowUpRightIcon
                aria-hidden="true"
                className="absolute right-4 top-4 h-3.5 w-3.5 text-neutral-300 transition-[transform,color] duration-200 ease-settle group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-neutral-700"
              />
              <span className="mb-2.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
                <span className="tabular-nums text-neutral-500">{policy}</span>
                <span aria-hidden="true">·</span>
                <span>{topic}</span>
              </span>
              <span className="text-[0.9rem] leading-snug text-neutral-800">
                {question}
              </span>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Reveals assistant text word-by-word rather than popping in all at once,
// similar to Claude/ChatGPT's streaming feel. This is a client-side reveal
// of the already-complete response (the backend isn't streaming tokens),
// bounded to a short target duration so long answers don't drag and short
// ones don't feel instant/jarring. onProgress lets the parent keep the
// view scrolled to the growing bubble.
function useTypedText(
  fullText: string,
  enabled: boolean,
  onProgress?: () => void
) {
  const words = useMemo(() => fullText.split(/(\s+)/), [fullText]);
  const [displayed, setDisplayed] = useState(enabled ? "" : fullText);
  const doneRef = useRef(!enabled);
  const [isTyping, setIsTyping] = useState(enabled);

  useEffect(() => {
    if (!enabled || doneRef.current) {
      setDisplayed(fullText);
      setIsTyping(false);
      return;
    }

    const TICK_MS = 22;
    const TARGET_TICKS = 60;
    const wordsPerTick = Math.max(1, Math.ceil(words.length / TARGET_TICKS));

    let cancelled = false;
    let i = 0;
    let tickCount = 0;

    const id = setInterval(() => {
      if (cancelled) return;
      i = Math.min(words.length, i + wordsPerTick);
      setDisplayed(words.slice(0, i).join(""));
      tickCount += 1;

      if (tickCount % 2 === 0) onProgress?.();

      if (i >= words.length) {
        clearInterval(id);
        doneRef.current = true;
        setIsTyping(false);
        onProgress?.();
      }
    }, TICK_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullText, enabled]);

  return { displayed, isTyping };
}

function MessageActions({
  content,
  onRegenerate,
}: {
  content: string;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard API unavailable - fail silently, nothing to recover
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy answer"
        className="inline-flex items-center gap-1.5 rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-2.5 py-1.5 text-[11px] text-neutral-700 transition hover:border-neutral-950/20 hover:bg-neutral-950/10 hover:text-neutral-950"
      >
        {copied ? (
          <>
            <CheckIcon className="h-3.5 w-3.5 text-neutral-950" />
            <span className="text-neutral-950">Copied</span>
          </>
        ) : (
          <>
            <CopyIcon className="h-3.5 w-3.5" />
            <span>Copy</span>
          </>
        )}
      </button>

      {onRegenerate ? (
        <button
          type="button"
          onClick={onRegenerate}
          title="Regenerate answer"
          className="inline-flex items-center gap-1.5 rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-2.5 py-1.5 text-[11px] text-neutral-700 transition hover:border-neutral-950/20 hover:bg-neutral-950/10 hover:text-neutral-950"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
          <span>Regenerate</span>
        </button>
      ) : null}
    </div>
  );
}

// Renders the map image(s) local-rag matched to a site-scoped answer
// (see ChatMessage.metadata.mapCitations's own comment for where these
// come from). Deliberately separate from SourcesSection just above it
// in MessageBubble - these are images, not text citations, and mixing
// them into ExpandableCitation's text-excerpt UI would be a worse fit
// than a small captioned image grid. A citation whose image failed to
// render server-side (imageUrl null - see map_images.py's
// render_map_image()) still shows its filename, so the answer stays
// honest about which document backs it even without a picture.
function MapCitationsSection({
  maps,
  postcode,
}: {
  maps: MapCitation[];
  postcode?: string;
}) {
  if (!maps.length) return null;
  return (
    <div className="rounded-2xl border border-neutral-950/10 bg-neutral-950/[0.03] p-4">
      <p className="mb-3 text-xs font-medium tracking-wide text-neutral-600">
        {postcode ? `Map${maps.length > 1 ? "s" : ""} for ${postcode}` : "Referenced map"}
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {maps.map((m, i) => (
          <div
            key={`${m.filename}-${i}`}
            className="overflow-hidden rounded-xl border border-neutral-950/10 bg-white"
          >
            {m.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.imageUrl}
                alt={m.filename}
                className="block w-full object-contain"
                loading="lazy"
              />
            ) : (
              <div className="flex h-32 items-center justify-center bg-neutral-950/5 text-xs text-neutral-500">
                Map image unavailable
              </div>
            )}
            <p className="truncate px-3 py-2 text-[11px] text-neutral-600" title={m.filename}>
              {m.filename}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  setMessages,
  queryText,
  onRegenerate,
  onTypingProgress,
}: {
  message: ChatMessage;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  queryText?: string;
  onRegenerate?: () => void;
  onTypingProgress?: () => void;
}) {
  const isUser = message.type === "user";

  const { displayed: revealedContent, isTyping } = useTypedText(
    message.content,
    !isUser && !message.skipTypewriter,
    onTypingProgress
  );

  const parts = useMemo(() => splitByTrigger(revealedContent), [revealedContent]);

  useEffect(() => {
    if (isUser) return;

    const hasTrigger =
      message.content.includes("[GENERATE_DIAGRAM]") ||
      message.content.includes("**[GENERATE_DIAGRAM]**");

    if (!hasTrigger) return;
    if (message.diagramData?.svgContent) return;
    // /api/diagram/svg does not exist - without this guard every answer
    // containing a diagram trigger fired a request that always failed and
    // logged an error to the console.
    if (!FEATURES.diagramSvgFetch) return;

    const parsed = extractDiagramSpecFromAnswer(message.content);
    if (!parsed) return;

    let cancelled = false;

    (async () => {
      try {
        const svgRaw = await fetchDiagramSVG(parsed);
        const cleaned = svgRaw.replace(/^\s*<\?xml[^>]*\?>\s*/i, "");

        if (cancelled) return;

        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? { ...m, diagramData: { ...parsed, svgContent: cleaned } }
              : m
          )
        );
      } catch (e: any) {
        console.error("diagram svg error:", e?.message || e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isUser,
    message.id,
    message.content,
    message.diagramData?.svgContent,
    setMessages,
  ]);

  const diagramData: DiagramData | null = useMemo(() => {
    if (message.diagramData) return message.diagramData;
    if (message.metadata?.diagram) {
      return {
        kind: message.metadata.diagram.kind,
        spec: message.metadata.diagram.spec,
        title: message.metadata.diagram.title,
      };
    }
    return null;
  }, [message.diagramData, message.metadata?.diagram]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="w-full"
    >
      <div className="mx-auto w-full max-w-5xl">
      <div className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}>
  {!isUser && (
    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="Urban AI Assistant" className="h-9 w-9 object-contain" />
    </div>
  )}

  <div className={`w-full ${isUser ? "max-w-2xl" : "max-w-5xl"}`}>
    <div
      className={`px-6 py-5 rounded-3xl shadow-[0_1px_3px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.03)] ${
        isUser
          ? "ml-auto max-w-[720px] border border-neutral-950/15 bg-neutral-950/[0.08]"
          : "w-full max-w-[980px] border border-neutral-950/10 bg-neutral-950/5"
      }`}
    >
<div className="text-[15px] leading-7 text-neutral-800">
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
      h2: ({ children }) => (
        <h2 className="text-lg font-semibold mt-6 mb-3 text-neutral-950">{children}</h2>
      ),
      h3: ({ children }) => (
        <h3 className="text-md font-semibold mt-5 mb-2 text-neutral-950">{children}</h3>
      ),
      li: ({ children }) => <li className="mb-1">{children}</li>,
      strong: ({ children }) => (
        <strong className="font-semibold text-neutral-950">{children}</strong>
      ),
      text: ({ children }) => {
        const value = String(children);
        const parts = value.split(/(\[(?:D|W)\d+\])/g);
    
        return (
          <>
            {parts.map((part, i) => {
              if (/^\[(?:D|W)\d+\]$/.test(part)) {
                return (
                  <InlineCitation
                    key={`${part}-${i}`}
                    token={part}
                    citations={message.metadata?.citations || []}
                  />
                );
              }
              return <React.Fragment key={i}>{part}</React.Fragment>;
            })}
          </>
        );
      },
    }}
  >
    {parts.before}
  </ReactMarkdown>
</div>

              {diagramData && (
                <div className="mt-4">
                  <DiagramDisplay diagram={diagramData} />
                </div>
              )}

              {parts.after?.trim() && (
                <div className="mt-4 max-w-none text-[15px] leading-7 text-neutral-800">
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
      li: ({ children }) => <li className="mb-1">{children}</li>,
      strong: ({ children }) => (
        <strong className="font-semibold text-neutral-950">{children}</strong>
      ),
      text: ({ children }) => {
        const value = String(children);
        const splitParts = value.split(/(\[(?:D|W)\d+\])/g);

        return (
          <>
            {splitParts.map((part, i) => {
              if (/^\[(?:D|W)\d+\]$/.test(part)) {
                return (
                  <InlineCitation
                    key={`${part}-${i}`}
                    token={part}
                    citations={message.metadata?.citations || []}
                  />
                );
              }
              return <React.Fragment key={i}>{part}</React.Fragment>;
            })}
          </>
        );
      },
    }}
  >
    {parts.after}
  </ReactMarkdown>
</div>
              )}

              {!isUser && !isTyping && (
                <>
                  {message.metadata?.corrections?.length ? (
                    <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-50/60 px-3 py-2 text-xs text-neutral-700">
                      <span className="font-medium text-neutral-900">
                        Heard{" "}
                        {message.metadata.corrections
                          .map((c) => `"${c.from}" as "${c.to}"`)
                          .join(", ")}
                      </span>{" "}
                      - answered on that basis. Retype it if that&apos;s not what
                      you meant.
                    </div>
                  ) : null}

                  {message.metadata?.complianceResult && (
                    <ComplianceResultDisplay
                      result={message.metadata.complianceResult}
                    />
                  )}

                  {message.metadata?.reviewChart && (
                    <ReviewSummaryChart data={message.metadata.reviewChart} />
                  )}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-950/10 pt-3 text-xs text-neutral-600">
                    <div className="flex flex-wrap items-center gap-4">
                      {message.metadata?.processingtime ? (
                        <span>
                          {(Number(message.metadata.processingtime) / 1000).toFixed(2)}
                          s
                        </span>
                      ) : null}

                      {message.metadata?.confidence != null ? (
                        <ConfidenceBadge
                          value={Number(message.metadata.confidence)}
                          title="retrieval"
                        />
                      ) : null}

                      {message.metadata?.groundedness != null ? (
                        <ConfidenceBadge
                          value={Number(message.metadata.groundedness)}
                          title="groundedness"
                        />
                      ) : null}
                    </div>

                    <MessageActions
                      content={message.content}
                      onRegenerate={onRegenerate}
                    />
                  </div>

                  {Array.isArray(message.metadata?.unsupportedClaims) &&
                    message.metadata.unsupportedClaims.length > 0 && (
                      <div className="mt-2 rounded-xl border border-neutral-950/25 bg-neutral-950/[0.06] px-3 py-2 text-xs text-neutral-900">
                        <span className="font-medium">
                          ⚠️ Not clearly backed by the sources:
                        </span>{" "}
                        {message.metadata.unsupportedClaims.join("; ")}
                      </div>
                    )}

                  {Array.isArray(message.metadata?.mapCitations) &&
                    message.metadata.mapCitations.length > 0 && (
                      <div className="mt-5 w-full">
                        <MapCitationsSection
                          maps={message.metadata.mapCitations}
                          postcode={message.metadata.sitePostcode}
                        />
                      </div>
                    )}

                  {message.metadata?.citationsPending ? (
                    <div className="mt-5 w-full">
                      <CitationsLoadingPlaceholder />
                    </div>
                  ) : (
                    Array.isArray(message.metadata?.citations) &&
                    message.metadata.citations.length > 0 && (
                      <div className="mt-5 w-full">
                        <SourcesSection
                          sources={message.metadata.citations}
                          queryText={queryText}
                        />
                      </div>
                    )
                  )}
                </>
              )}
            </div>

            <p
              className={`mt-2 px-2 text-[11px] font-medium tracking-wide text-neutral-600 ${
                isUser ? "text-right" : "text-left"
              }`}
            >
              {message.timestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </div>

          {isUser && (
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border border-neutral-950/15 bg-neutral-200">
              <UserIcon className="h-5 w-5 text-neutral-950" />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// Mirrors the real backend pipeline (hybrid search -> LLM rerank ->
// generation -> groundedness check) so the copy is honest about what's
// actually happening, not just decorative. Cycles on a timer since the
// route isn't streaming progress events yet. Each stage is paired with a
// thinking-orbs state chosen for what it depicts, not just decoration -
// searching is a literal scan; ranking sources is wiring them into a
// constellation ("connecting"); a rerank pass is the result set drawing
// itself more precisely ("shaping"); drafting text is "composing"; and
// checking each citation resolves like solved bands clicking into place
// ("solving"). Declared as one paired array, not two indexed in parallel,
// so the text and the orb state can never drift out of sync with each
// other.
const THINKING_STAGE_DEFS: { text: string; orb: React.ComponentProps<typeof ThinkingOrb>["state"] }[] = [
  { text: "Searching indexed planning documents…", orb: "searching" },
  { text: "Ranking sources by relevance…", orb: "connecting" },
  { text: "Reranking with AI for precision…", orb: "shaping" },
  { text: "Drafting a grounded answer…", orb: "composing" },
  { text: "Cross-checking citations…", orb: "solving" },
];
const THINKING_STAGES = THINKING_STAGE_DEFS.map((s) => s.text);

// Shimmering text: a bright band sweeps across otherwise-muted text via an
// animated background-position on a background-clipped gradient. This is
// the same technique Claude/ChatGPT-style "thinking" indicators use instead
// of bouncing dots or progress bars - it reads as "working" without
// implying a measurable, and often wrong, percentage of completion.
function ShimmerText({
  children,
  tone = "dark",
}: {
  children: React.ReactNode;
  // "dark" is the original variant, for muted-dark text on a light
  // background (thinking indicator). "light" inverts it for white text on
  // a dark background (the compliance-review button, see ReviewingLabel).
  tone?: "dark" | "light";
}) {
  const backgroundImage =
    tone === "light"
      ? "linear-gradient(90deg, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.45) 38%, rgba(255,255,255,1) 50%, rgba(255,255,255,0.45) 62%, rgba(255,255,255,0.45) 100%)"
      : "linear-gradient(90deg, rgba(10,10,10,0.32) 0%, rgba(10,10,10,0.32) 38%, rgba(10,10,10,0.92) 50%, rgba(10,10,10,0.32) 62%, rgba(10,10,10,0.32) 100%)";
  return (
    <span
      className="animate-shimmer bg-clip-text text-transparent [background-size:200%_100%]"
      style={{ backgroundImage }}
    >
      {children}
    </span>
  );
}

// Lightweight inline placeholder shown in place of SourcesSection while
// citations are still being assembled after streaming text has finished
// (see ChatMessage.metadata.citationsPending in sendLocalStreaming) -
// replaces the old behaviour of leaving the full-message ThinkingIndicator
// visible for that whole gap, which read as a second, redundant loading
// state stacked below an answer that already looked complete. Mirrors
// SourcesSection's own outer card chrome so nothing shifts noticeably
// when the real citations swap in, and never calls scrollIntoView or
// otherwise moves the page - it just replaces itself in place.
function CitationsLoadingPlaceholder() {
  return (
    <div className="rounded-3xl border border-neutral-950/10 bg-neutral-950/[0.04] p-4">
      <p className="text-sm font-semibold text-neutral-950">
        <ShimmerText>Loading evidence…</ShimmerText>
      </p>
      <div className="mt-3 space-y-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-2xl border border-neutral-950/10 bg-neutral-950/[0.05]"
          />
        ))}
      </div>
    </div>
  );
}

// Mirrors the real proposal-review pipeline (_resolve_site's postcode/
// name-geocode detection -> GIS constraint lookup -> per-topic retrieval
// & AI rerank -> assessment synthesis - see review_proposal() in
// local-rag/proposal_review.py), same honesty rule as THINKING_STAGES:
// this cycles on a timer, not real progress events, since the review
// route isn't streaming stage updates yet.
// Same pairing approach as THINKING_STAGE_DEFS just above - reading/
// detecting the site is a literal scan ("searching"); a GIS constraint
// check resolves pass/fail like solved bands clicking into place
// ("solving"); retrieving & ranking policy wires evidence together
// ("connecting"); drafting the assessment is "composing".
const REVIEW_STAGE_DEFS: { text: string; orb: React.ComponentProps<typeof ThinkingOrb>["state"] }[] = [
  { text: "Reading document & detecting the site…", orb: "searching" },
  { text: "Checking GIS constraints…", orb: "solving" },
  { text: "Retrieving & ranking planning policy…", orb: "connecting" },
  { text: "Drafting the compliance assessment…", orb: "composing" },
];
const REVIEW_STAGES = REVIEW_STAGE_DEFS.map((s) => s.text);

// Compact counterpart to ThinkingIndicator, sized to sit inside a button
// rather than a full message row - a small rotating ring plus the same
// cycling-shimmer-text technique, using ShimmerText's "light" tone since
// this renders on the dark "Run compliance review" button background.
function ReviewingLabel() {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, REVIEW_STAGES.length - 1));
    }, 1800);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="inline-flex items-center gap-1.5">
      {/* theme="dark" here means "light dots for a dark background" (the
          library's naming, opposite of this file's own ShimmerText
          tone="dark"/"light", which names the TEXT colour) - this renders
          on the dark "Run compliance review" button, same as ShimmerText's
          tone="light" call just below. */}
      <ThinkingOrb
        state={REVIEW_STAGE_DEFS[stageIndex].orb}
        size={20}
        theme="dark"
        aria-label={REVIEW_STAGES[stageIndex]}
        className="shrink-0"
      />
      <AnimatePresence mode="wait">
        <motion.span
          key={stageIndex}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.25 }}
          className="inline-block"
        >
          <ShimmerText tone="light">{REVIEW_STAGES[stageIndex]}</ShimmerText>
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function ThinkingIndicator() {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    // Advances through the stages once and then holds on the last one -
    // deliberately not wrapping back to stage 0, since a status message
    // that cycles back to "Searching..." after already reaching "Drafting
    // an answer..." reads as stuck/looping rather than as real progress.
    const id = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, THINKING_STAGES.length - 1));
    }, 1500);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-4">
      {/* Replaced the old rotating CSS "crystal" pyramid with a
          thinking-orbs state that actually matches the current pipeline
          stage - see THINKING_STAGE_DEFS above for the pairing. theme=
          "light" is pinned rather than "auto" because DESIGN.md rules
          out dark mode for this app entirely; there's no light/dark
          switch for the library to correctly auto-detect. */}
      <ThinkingOrb
        state={THINKING_STAGE_DEFS[stageIndex].orb}
        size={64}
        theme="light"
        aria-label={THINKING_STAGES[stageIndex]}
        className="shrink-0"
      />

      <div className="flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={stageIndex}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.3 }}
            className="text-[15px] font-medium"
          >
            <ShimmerText>{THINKING_STAGES[stageIndex]}</ShimmerText>
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function DiagramDisplay({ diagram }: { diagram: DiagramData }) {
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadPNG = async () => {
    setIsDownloading(true);

    try {
      const res = await fetch("/api/diagram/png", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: diagram.kind, spec: diagram.spec }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `PNG render failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const safeName = String(
        diagram.title || diagram.spec?.meta?.title || diagram.kind || "diagram"
      );

      const filename = safeName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename || "diagram"}.png`;
      a.click();

      URL.revokeObjectURL(url);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-neutral-950/10 bg-neutral-950/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-neutral-600">Diagram</p>
          <p className="text-sm font-medium text-neutral-800">
            {diagram.title || diagram.spec?.meta?.title || diagram.kind}
          </p>
          <p className="mt-1 text-[11px] text-neutral-500">{diagram.kind}</p>
        </div>

        {FEATURES.diagramPngExport && (
        <button
          onClick={downloadPNG}
          disabled={isDownloading}
          className="inline-flex items-center gap-2 rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-2 text-xs text-neutral-800 transition hover:bg-neutral-950/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon className="h-4 w-4" />
          {isDownloading ? "Preparing..." : "Download PNG"}
        </button>
        )}
      </div>

      <div className="mt-4 overflow-auto rounded-xl border border-neutral-950/10">
        {!diagram.svgContent ? (
          <div className="p-3 text-xs text-neutral-600">Rendering diagram…</div>
        ) : (
          <div className="bg-white">
            <div
              className="p-2"
              dangerouslySetInnerHTML={{ __html: diagram.svgContent }}
            />
          </div>
        )}
      </div>
    </div>
  );
}