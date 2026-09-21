"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import SourcesSection from "@/components/citations/SourcesSection";
import InlineCitation from "@/components/citations/InlineCitation";
import ConversationSidebar from "@/components/chat/ConversationSidebar";
import { getVisitorId } from "@/lib/visitorId";
import { useVoiceChat, sanitizeForSpeech } from "@/lib/useVoiceChat";
import VoiceModeOverlay, {
  type VoiceOverlayState,
} from "@/components/chat/VoiceModeOverlay";
import VoiceAgentOverlay from "@/components/chat/VoiceAgentOverlay";
import DocumentPanel from "@/components/chat/DocumentPanel";
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
  | "localStreamingAnswers",
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
      issuesCount: number;
      level: "Low" | "Medium" | "High" | null;
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
      strokeWidth={2}
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
  const tier = pct >= 85 ? "high" : pct >= 60 ? "medium" : "low";
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
    issuesCount: number;
    level: "Low" | "Medium" | "High" | null;
  };
}) {
  const { checklist, issuesCount, level } = data;
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

  const levelColor =
    level === "High" ? "#d03b3b" : level === "Medium" ? "#fab219" : "#0ca30c";

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
              {pctPresent}%
            </span>
            <span className="text-[9px] text-neutral-500">present</span>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {level && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
                style={{ color: levelColor, backgroundColor: `${levelColor}1a` }}
              >
                {level} attention
              </span>
            )}
            <span className="text-neutral-500">
              {issuesCount} issue{issuesCount === 1 ? "" : "s"} · {total} item
              {total === 1 ? "" : "s"} checked
            </span>
          </div>

          <div className="space-y-1">
            {checklist.slice(0, 6).map((c, i) => (
              <motion.div
                key={`${c.item}-${i}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: 0.25 + i * 0.06 }}
                className="flex items-center gap-2 text-xs text-neutral-700"
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: REVIEW_STATUS_COLORS[c.status] || "#898781" }}
                >
                  {REVIEW_STATUS_ICON[c.status] || "?"}
                </span>
                <span className="truncate">{c.item}</span>
              </motion.div>
            ))}
            {checklist.length > 6 && (
              <p className="pl-6 text-[11px] text-neutral-500">
                +{checklist.length - 6} more in the full report
              </p>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* ---------------- main ---------------- */

export default function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);

  // Side panel previewing a generated document (PDF for now) next to the
  // chat - see components/chat/DocumentPanel.tsx. Added 2026-09-19,
  // originally verified against a hardcoded sample report via a
  // temporary test button; now opened for real by runProposalReview
  // below with a live report_files.pdf_url from local-rag's
  // /proposal-review.
  const [documentPanel, setDocumentPanel] = useState<{
    url: string;
    filename: string;
    // Live animated report view URL (report_files.html_url) - see
    // DocumentPanel's new "report" view, added alongside the PDF one
    // 2026-09-21 for "animated report visuals". Optional: only set when
    // the backend's live-HTML render succeeded (see build_reports'
    // live_html_error for why it might not have).
    htmlUrl?: string;
  } | null>(null);

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
  const [loadingConversationId, setLoadingConversationId] = useState<
    string | null
  >(null);

  useEffect(() => {
    setVisitorId(getVisitorId());
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

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
      if (!res.ok || !Array.isArray(data?.messages)) return;
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
      // Same transparent, disclosed heuristic as report_render.py's
      // _compute_risk() - kept in sync deliberately (see that function's
      // own comment) so the chat summary's risk word never disagrees
      // with the badge on the report the user is looking at.
      const level = review.assessment_failed
        ? null
        : missing >= 2 || issues.length >= 4
        ? "High"
        : missing >= 1 || unclear >= 2 || issues.length >= 1
        ? "Medium"
        : "Low";

      setActiveReview({ review, reportFiles, label: file.name });

      if (reportFiles?.pdf_url) {
        setDocumentPanel({
          url: reportFiles.pdf_url,
          filename: reportFiles.pdf_filename || file.name,
          htmlUrl: reportFiles.html_url,
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
      const summaryText = review.assessment_failed
        ? `${siteNote}I couldn't generate a full assessment for this one — ${
            review.parse_error || "the model didn't return a usable answer"
          }. Retrieval itself worked, so you can still ask me what evidence was found, or try the review again.`
        : `${siteNote}Review complete${
            level ? ` — overall attention needed: ${level}` : ""
          }. I found ${issues.length} issue${
            issues.length === 1 ? "" : "s"
          } and ${missing} required item${
            missing === 1 ? "" : "s"
          } missing from the checklist. I've opened the full report in the panel — ask me anything about it, or download it from there.`;
      const assistantMsg: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: summaryText,
        timestamp: new Date(),
        metadata:
          !review.assessment_failed && checklist.length > 0
            ? { reviewChart: { checklist, issuesCount: issues.length, level } }
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
    startListening,
    stopListening,
    speak,
    stopSpeaking,
  } = useVoiceChat({
    onInterimTranscript: (text) => setInputValue(text),
    onFinalTranscript: (text) => {
      setInputValue(text);
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

  const voiceOverlayCaption = isSpeaking
    ? sanitizeForSpeech(
        [...messages].reverse().find((m) => m.type === "assistant")?.content ||
          ""
      )
    : isListening
    ? inputValue
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
  // stream/route.ts's own comments for the full design. Inserts an
  // empty assistant message immediately (skipTypewriter: true - this is
  // real incremental text, not useTypedText's fake reveal) and appends
  // each "delta" event's text to it as it arrives; the "done" event
  // then sets the authoritative final answer text/metadata (citations,
  // confidence, groundedness) - see stream_answer()'s docstring in
  // local-rag/answer.py for why the final text can differ slightly from
  // the concatenation of every delta (the post-stream repair/
  // groundedness passes).
  const sendLocalStreaming = async (prompt: string, sessionToken: number) => {
    const assistantId = `${Date.now()}-assistant`;

    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        type: "assistant",
        content: "",
        timestamp: new Date(),
        skipTypewriter: true,
      },
    ]);

    const res = await fetch("/api/local-rag-chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: prompt }),
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
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: accumulated } : m
            )
          );
        } else if (eventName === "done") {
          if (chatSessionRef.current !== sessionToken) return;

          const finalAnswer = payload.answer || accumulated;
          const mappedCitations = mapBackendCitations(
            extractRawCitations({ citations: payload.citations })
          );

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: finalAnswer,
                    metadata: {
                      processingtime:
                        (payload.retrieval_ms || 0) + (payload.generation_ms || 0),
                      confidence: payload.confidence,
                      groundedness: payload.groundedness,
                      unsupportedClaims: payload.unsupportedClaims || [],
                      citations: mappedCitations,
                      mapCitations: Array.isArray(payload.mapCitations)
                        ? payload.mapCitations
                        : [],
                      sitePostcode: payload.postcode,
                    },
                  }
                : m
            )
          );

          if (voiceModeEnabled && ttsSupported) {
            const speechText = sanitizeForSpeech(finalAnswer);
            speak(speechText, () => {
              if (voiceModeEnabledRef.current) startListening();
            });
          }
        }
      }
    }
  };

  const handleSend = async (overridePrompt?: string) => {
    const prompt = (overridePrompt ?? inputValue).trim();
    if ((!prompt && !drawingFile) || isLoading || isUploadingDoc || isReviewing) return;

    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      type: "user",
      content: prompt,
      timestamp: new Date(),
    };

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
        // Local-rag has no feasibility/permitting/risk handling or
        // conversation persistence - plain Q&A only, so chatMode/
        // conversationId/voiceMode aren't sent.
        res = await fetch("/api/local-rag-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: prompt }),
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
          speak(speechText, () => {
            if (voiceModeEnabledRef.current) startListening();
          });
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

      <div className="flex h-full min-w-0 flex-1 flex-col">
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
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      {/* Same min-height whether the welcome screen or a conversation is
          showing, so the scroll container does not resize under the user
          the instant they send - which is what made the thinking
          indicator appear to snap to the top of an empty page. */}
      <div className="mx-auto flex min-h-[calc(100vh-16rem)] w-full max-w-3xl flex-col space-y-6 px-2 sm:px-4">
          {messages.length === 0 ? (
            <WelcomeScreen onSuggestionClick={(s) => handleSend(s)} />
          ) : (
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
                  onTypingProgress={() =>
                    endRef.current?.scrollIntoView({
                      behavior: "auto",
                      block: "end",
                    })
                  }
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
          )}

          {isLoading && <ThinkingIndicator />}

          {error && (
            <div className="max-w-md rounded-xl border border-neutral-950/25 bg-neutral-950/[0.06] px-3 py-2 text-xs text-neutral-950">
              Backend error: {error}
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-neutral-950/8 bg-[#f7f4ee]/80 p-4 shadow-[0_-1px_16px_rgba(0,0,0,0.04)] backdrop-blur-xl sm:p-6">
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
          <div className="relative">
            <textarea
              ref={composerRef}
              rows={1}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything"
              aria-label="Ask a question"
              className="uaa-composer block w-full resize-none border border-neutral-950/10 bg-[#fbf9f5] py-3.5 pl-11 pr-32 text-sm leading-6 shadow-paper-sm transition-[box-shadow,border-color,background-color,border-radius] duration-200 ease-settle focus:outline-none focus:border-neutral-950/25 focus:bg-white focus:shadow-paper-md"
              disabled={isLoading}
            />

            {/* Bottom-anchored: with a growing composer, a vertically
                centred control drifts down the box as you type. */}
            <div className="absolute bottom-2 left-2">
              <label
                className="press flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-neutral-950/10 bg-neutral-100/80 text-neutral-800 hover:bg-neutral-200/90 hover:border-neutral-950/20"
                title="Upload document"
                aria-label="Upload document"
              >
                <input
                  type="file"
                  onChange={handleFileSelected}
                  className="hidden"
                  disabled={isLoading || isUploadingDoc || isReviewing || !!pendingUploadFile}
                />
                <DocumentIcon className="h-4 w-4" />
              </label>
            </div>

            <div className="absolute bottom-2 right-2 flex items-center gap-2">
              {sttSupported && (
                <button
                  type="button"
                  onClick={handleMicClick}
                  disabled={isLoading || isUploadingDoc}
                  className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isListening
                      ? "animate-pulse border-red-300 bg-red-100 text-red-600"
                      : isSpeaking
                      ? "border-neutral-950/10 bg-neutral-200 text-neutral-800"
                      : "border-neutral-950/10 bg-neutral-100/80 text-neutral-700 hover:bg-neutral-200/90"
                  }`}
                  title={
                    isSpeaking
                      ? "Stop speaking"
                      : isListening
                      ? "Stop listening"
                      : "Voice input"
                  }
                  aria-label={
                    isSpeaking
                      ? "Stop speaking"
                      : isListening
                      ? "Stop listening"
                      : "Voice input"
                  }
                >
                  {isSpeaking ? (
                    <SpeakerIcon className="h-4 w-4" />
                  ) : (
                    <MicIcon className="h-4 w-4" />
                  )}
                </button>
              )}

              <button
                onClick={() => handleSend()}
                disabled={
                  (!inputValue.trim() && !drawingFile) ||
                  isLoading ||
                  isUploadingDoc ||
                  isReviewing
                }
                className="press flex h-8 w-8 items-center justify-center rounded-full bg-neutral-950 shadow-paper-sm hover:bg-neutral-800 hover:shadow-paper-md disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                aria-label="Send"
              >
                <PaperAirplaneIcon className="h-4 w-4 text-white" />
              </button>
            </div>
          </div>

          {uploadedDocs.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {uploadedDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs text-neutral-700">
                      <span className="text-neutral-800">{doc.name}</span>
                    </p>
                    <p className="text-[11px] text-neutral-500">
                      {doc.status === "uploading" &&
                        "Reading and indexing this document…"}
                      {doc.status === "ready" &&
                        "Ready — your questions in this chat will now use it."}
                      {doc.status === "error" &&
                        "Couldn't process this file — try again or ask without it."}
                    </p>
                  </div>

                  <button
                    onClick={() =>
                      setUploadedDocs((prev) => prev.filter((d) => d.id !== doc.id))
                    }
                    className="shrink-0 rounded-xl border border-neutral-950/20 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/15 hover:text-neutral-950"
                  >
                    Dismiss
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Choice card for a just-selected file - added 2026-09-19,
              replacing the old auto-upload-into-Q&A behaviour. Lets the
              user pick between the existing cloud Q&A ingestion
              (uploadForQA, no site needed) and a real local-rag
              compliance review (runProposalReview) - the review needs a
              site (postcode/project/lat-lon) to check GIS constraints
              against, but the postcode field is optional: leaving it
              blank asks local-rag's proposal_review._resolve_site() to
              auto-detect one from the uploaded document itself (a
              postcode written in the text, or failing that a name/
              address geocoded via site_lookup.detect_site() - added
              2026-09-19, per explicit request: "find the postcode based
              on the documents... or if postcode is not mentioned then...
              look up the postcode based on the name"). Detection can
              still fail (no postcode and no recognizable name/address in
              the document) - that surfaces as the normal backend error
              message asking the user to enter a postcode manually,
              same as before this change. */}
          <AnimatePresence>
          {pendingUploadFile && (
            <motion.div
              key="pending-upload-choice-card"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="mt-3 space-y-2 rounded-2xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-3"
            >
              <p className="truncate text-xs text-neutral-700">
                <span className="text-neutral-800">{pendingUploadFile.name}</span>
                {" — what would you like to do with it?"}
              </p>

              <input
                type="text"
                value={reviewPostcode}
                onChange={(e) => setReviewPostcode(e.target.value)}
                placeholder="Postcode, e.g. SW1V 3LX — optional, I'll try to detect it from the document if left blank"
                disabled={isReviewing}
                className="block w-full rounded-xl border border-neutral-950/10 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950/25"
              />

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isReviewing}
                  onClick={() => uploadForQA(pendingUploadFile)}
                  className="rounded-xl border border-neutral-950/20 bg-white px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Ask questions about it
                </button>
                <button
                  type="button"
                  disabled={isReviewing}
                  onClick={() => runProposalReview(pendingUploadFile, reviewPostcode)}
                  title={
                    !reviewPostcode.trim()
                      ? "No postcode entered - I'll try to detect the site from the document itself"
                      : undefined
                  }
                  className="rounded-xl border border-neutral-950/20 bg-neutral-950 px-3 py-1.5 text-xs text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isReviewing ? <ReviewingLabel /> : "Run compliance review"}
                </button>
                <button
                  type="button"
                  disabled={isReviewing}
                  onClick={() => {
                    setPendingUploadFile(null);
                    setReviewPostcode("");
                  }}
                  className="rounded-xl px-3 py-1.5 text-xs text-neutral-500 transition hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          )}
          </AnimatePresence>

          {/* Persistent indicator once a review exists for this
              conversation - handleSend routes every message through
              /proposal-review-chat while this is set (see that branch
              above). Exiting just stops that routing; it doesn't close
              the report panel or delete anything. */}
          <AnimatePresence>
          {activeReview && (
            <motion.div
              key="active-review-banner"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-2"
            >
              <p className="truncate text-xs text-neutral-700">
                Discussing the compliance review for{" "}
                <span className="text-neutral-800">{activeReview.label}</span>
              </p>
              <button
                type="button"
                onClick={() => setActiveReview(null)}
                className="shrink-0 rounded-xl border border-neutral-950/20 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/15 hover:text-neutral-950"
              >
                Exit review chat
              </button>
            </motion.div>
          )}
          </AnimatePresence>

          {FEATURES.drawingAnalysis && chatMode === "feasibility" && (
            <div className="mt-3 space-y-2">
              <label className="block text-xs text-neutral-600">
                Optional: Upload floor plan or site plan for automatic analysis
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setDrawingFile(file);
                  }}
                  className="mt-1 block w-full text-xs text-neutral-600 file:mr-4 file:rounded-xl file:border-0 file:bg-neutral-200 file:px-4 file:py-2 file:text-xs file:text-neutral-950 hover:file:bg-neutral-300"
                  disabled={isLoading}
                />
              </label>

              {drawingFile && (
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-neutral-700">
                      Drawing:{" "}
                      <span className="text-neutral-800">{drawingFile.name}</span>
                    </p>
                    <p className="text-[11px] text-neutral-500">
                      Will be analyzed for code compliance when you send
                    </p>
                  </div>

                  <button
                    onClick={() => setDrawingFile(null)}
                    className="rounded-xl border border-neutral-950/20 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/15 hover:text-neutral-950"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}

          {FEATURES.modeSelector && (
          <div className="relative mt-2 text-left text-[11px] text-neutral-600">
            <button
              type="button"
              onClick={() => setIsModeMenuOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-full hover:text-neutral-900"
            >
              <span>
                {chatMode === "auto" &&
                  "Mode: Auto – describe what you want; the assistant will choose Feasibility, Permitting, or Risk."}
                {chatMode === "feasibility" &&
                  "Mode: Feasibility – share the site location, jurisdiction, and what you want to build."}
                {chatMode === "permitting" &&
                  "Mode: Permitting – upload your submission pack and specify the authority/jurisdiction."}
                {chatMode === "risk" &&
                  "Mode: Risk – provide project context/documents to analyze what could get rejected or delayed."}
              </span>
              <span aria-hidden="true">▾</span>
            </button>

            {isModeMenuOpen && (
              <div className="absolute bottom-6 left-0 z-10 w-44 rounded-2xl border border-neutral-950/10 bg-neutral-100/95 py-1 text-xs text-neutral-900 shadow-lg">
                {[
                  { id: "auto", label: "Auto (default)" },
                  { id: "feasibility", label: "Feasibility" },
                  { id: "permitting", label: "Permitting" },
                  { id: "risk", label: "Risk review" },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => {
                      setChatMode(
                        mode.id as
                          | "auto"
                          | "feasibility"
                          | "permitting"
                          | "risk"
                      );
                      setIsModeMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-2 hover:bg-neutral-950/10 ${
                      chatMode === mode.id ? "text-neutral-950" : ""
                    }`}
                  >
                    <span>{mode.label}</span>
                    {chatMode === mode.id && <span>•</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {FEATURES.ragSourceToggle && (
            <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-neutral-600">
              <span>Answers from:</span>
              <div className="relative inline-flex overflow-hidden rounded-full border border-neutral-950/10">
                {(["cloud", "local"] as const).map((source) => (
                  <button
                    key={source}
                    type="button"
                    onClick={() => setRagSource(source)}
                    className={`relative z-10 px-2.5 py-1 transition-colors duration-150 ${
                      ragSource === source
                        ? "text-neutral-100"
                        : "hover:bg-neutral-950/5"
                    }`}
                  >
                    {ragSource === source && (
                      <motion.span
                        layoutId="ragSourcePill"
                        className="absolute inset-0 -z-10 rounded-full bg-neutral-950"
                        transition={{ type: "spring", stiffness: 500, damping: 35 }}
                      />
                    )}
                    {source === "cloud" ? "Cloud" : "Local (offline)"}
                  </button>
                ))}
              </div>
              {ragSource === "local" && localRagStatus === "checking" && (
                <span className="text-neutral-500">checking…</span>
              )}
              {ragSource === "local" && localRagStatus === "unreachable" && (
                <span className="text-red-600">
                  service not running - see local-rag/README.md
                </span>
              )}
            </div>
          )}


          {sttSupported && ttsSupported && (
            <div className="mt-2 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={handleStartVoiceConversation}
                className="press inline-flex items-center gap-1.5 rounded-full border border-neutral-950/10 bg-neutral-100/80 px-3 py-1.5 text-[11px] text-neutral-700 hover:bg-neutral-200/90 hover:border-neutral-950/20"
              >
                <MicIcon className="h-3.5 w-3.5" />
                Start voice conversation
              </button>
              {voiceAgentUrl && (
                <button
                  type="button"
                  onClick={() => setIsVoiceAgentOverlayOpen(true)}
                  title="Full-duplex voice - real barge-in, requires voice-agent/ running (see its README)"
                  className="press inline-flex items-center gap-1.5 rounded-full border border-neutral-950/10 bg-neutral-100/80 px-3 py-1.5 text-[11px] text-neutral-700 hover:bg-neutral-200/90 hover:border-neutral-950/20"
                >
                  <MicIcon className="h-3.5 w-3.5" />
                  Full-duplex voice (beta)
                </button>
              )}
            </div>
          )}

          <p className="mt-3 text-center text-xs text-neutral-500">
            Enter to send. Shift+Enter for new line. AI can be wrong.
          </p>
        </div>
      </div>
      </div>

      {/* Side panel previewing a generated document (see the documentPanel
          state above and components/chat/DocumentPanel.tsx) - a sibling of
          the main chat column, same outer flex row as ConversationSidebar,
          so it docks to the right the same way the sidebar docks to the
          left. */}
      {documentPanel && (
        <DocumentPanel
          url={documentPanel.url}
          filename={documentPanel.filename}
          htmlUrl={documentPanel.htmlUrl}
          onClose={() => setDocumentPanel(null)}
        />
      )}
    </div>
  );
}

function WelcomeScreen({
  onSuggestionClick,
}: {
  onSuggestionClick: (s: string) => void;
}) {
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
        <h1 className="rise mb-4 text-center text-[2.15rem] font-semibold leading-[1.08] tracking-tight text-neutral-950 sm:text-[2.9rem]"
            style={{ ["--i" as any]: 1, textWrap: "balance" as any }}>
          A clearer view.
          <br />
          <span className="text-neutral-500">A better decision.</span>
        </h1>

        <p className="rise mx-auto mb-10 max-w-[46ch] text-center text-[0.95rem] leading-relaxed text-neutral-600"
           style={{ ["--i" as any]: 2 }}>
          Grounded regulatory answers with citations, page references and
          clause-level support.
        </p>

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
            <button
              key={question}
              type="button"
              onClick={() => onSuggestionClick(question)}
              style={{ ["--i" as any]: 4 + i }}
              className="rise press group relative flex min-h-[6.5rem] w-full flex-col justify-start rounded-2xl border border-neutral-950/[0.08] bg-[#fbf9f5] p-5 pr-11 text-left shadow-paper-xs transition-[background-color,border-color,box-shadow] duration-200 ease-settle hover:border-neutral-950/20 hover:bg-white hover:shadow-paper-md"
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
            </button>
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

                  {Array.isArray(message.metadata?.citations) &&
                    message.metadata.citations.length > 0 && (
                      <div className="mt-5 w-full">
                        <SourcesSection
                          sources={message.metadata.citations}
                          queryText={queryText}
                        />
                      </div>
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
// route isn't streaming progress events yet.
const THINKING_STAGES = [
  "Searching indexed planning documents…",
  "Ranking sources by relevance…",
  "Reranking with AI for precision…",
  "Drafting a grounded answer…",
  "Cross-checking citations…",
];

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

// Mirrors the real proposal-review pipeline (_resolve_site's postcode/
// name-geocode detection -> GIS constraint lookup -> per-topic retrieval
// & AI rerank -> assessment synthesis - see review_proposal() in
// local-rag/proposal_review.py), same honesty rule as THINKING_STAGES:
// this cycles on a timer, not real progress events, since the review
// route isn't streaming stage updates yet.
const REVIEW_STAGES = [
  "Reading document & detecting the site…",
  "Checking GIS constraints…",
  "Retrieving & ranking planning policy…",
  "Drafting the compliance assessment…",
];

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
      <motion.span
        className="h-3 w-3 shrink-0 rounded-full border-2 border-white/30 border-t-white"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }}
        aria-hidden="true"
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
      {/* rotating 3D "crystal" - see .uaa-crystal* rules in globals.css */}
      <div className="uaa-crystal-wrap shrink-0" aria-hidden="true">
        <div className="uaa-crystal">
          <div className="uaa-pyramid uaa-pyramid-top">
            <div className="uaa-side uaa-s1" />
            <div className="uaa-side uaa-s2" />
            <div className="uaa-side uaa-s3" />
            <div className="uaa-side uaa-s4" />
          </div>
          <div className="uaa-pyramid uaa-pyramid-bottom">
            <div className="uaa-side uaa-s1" />
            <div className="uaa-side uaa-s2" />
            <div className="uaa-side uaa-s3" />
            <div className="uaa-side uaa-s4" />
          </div>
        </div>
      </div>

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