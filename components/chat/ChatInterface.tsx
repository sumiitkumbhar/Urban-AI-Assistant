"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import SourcesSection from "@/components/citations/SourcesSection";
import InlineCitation from "@/components/citations/InlineCitation";
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

export interface ChatMessage {
  id: string;
  type: "user" | "assistant";
  content: string;
  timestamp: Date;
  metadata?: {
    processingtime?: number;
    confidence?: number;
    citations?: Citation[];
    diagram?: DiagramPayload;
    complianceResult?: any;
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

const suggestions = [
  "When is a firefighting shaft required in Approved Document B?",
  "What are the requirements for external fire spread under Approved Document B?",
  "What does Requirement B1 in Approved Document B require?",
];

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

/* ---------------- UI helpers ---------------- */

function ConfidenceBadge({ value }: { value: number }) {
  if (value == null || Number.isNaN(value)) return null;

  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const label = pct >= 85 ? "HIGH" : pct >= 60 ? "MEDIUM" : "LOW";
  const dotClass =
    pct >= 85 ? "bg-emerald-400" : pct >= 60 ? "bg-amber-400" : "bg-rose-500";

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-200">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      <span className="font-mono">{pct}%</span>
      <span className="text-[9px] uppercase tracking-wide text-slate-400">
        {label}
      </span>
    </span>
  );
}

function ComplianceResultDisplay({ result }: { result: any }) {
  if (!result || !result.success) {
    return (
      <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
        <p className="text-sm text-rose-300">
          ❌ Compliance check failed: {result?.error || "Unknown error"}
        </p>
      </div>
    );
  }

  const score = result.complianceScore ?? 0;

  const scoreBoxClasses =
    score >= 80
      ? "border-emerald-500/30 bg-emerald-500/10"
      : score >= 60
      ? "border-amber-500/30 bg-amber-500/10"
      : "border-rose-500/30 bg-rose-500/10";

  const scoreTextClasses =
    score >= 80
      ? "text-emerald-400"
      : score >= 60
      ? "text-amber-400"
      : "text-rose-400";

  const statusTextClasses =
    score >= 80
      ? "text-emerald-300"
      : score >= 60
      ? "text-amber-300"
      : "text-rose-300";

  return (
    <div className="mt-4 space-y-3">
      <div className={`rounded-xl border p-4 ${scoreBoxClasses}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">Compliance Score</p>
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
            <div className="text-right text-xs text-slate-400">
              <p>{result.metadata.documentName}</p>
              <p>
                {result.metadata.jurisdiction} · {result.metadata.projectType}
              </p>
            </div>
          )}
        </div>
      </div>

      {Array.isArray(result.violations) && result.violations.length > 0 && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
          <p className="mb-2 text-sm font-semibold text-rose-300">
            ❌ Critical Violations ({result.violations.length})
          </p>
          <div className="space-y-2">
            {result.violations.map((v: any, i: number) => (
              <div
                key={i}
                className="border-l-2 border-rose-500 pl-3 text-xs text-slate-300"
              >
                <p className="font-medium">{v.requirement}</p>
                <p className="mt-1 text-slate-400">{v.finding}</p>
                {v.remediation && (
                  <p className="mt-1 text-rose-300">→ {v.remediation}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(result.warnings) && result.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-300">
            ⚠️ Warnings ({result.warnings.length})
          </p>
          <div className="space-y-2">
            {result.warnings.map((w: any, i: number) => (
              <div
                key={i}
                className="border-l-2 border-amber-500 pl-3 text-xs text-slate-300"
              >
                <p className="font-medium">{w.requirement}</p>
                <p className="mt-1 text-slate-400">{w.finding}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(result.recommendations) &&
        result.recommendations.length > 0 && (
          <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
            <p className="mb-2 text-sm font-semibold text-blue-300">
              💡 Recommendations
            </p>
            <ul className="space-y-1 text-xs text-slate-300">
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

/* ---------------- main ---------------- */

export default function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [drawingFile, setDrawingFile] = useState<File | null>(null);

  const [chatMode, setChatMode] = useState<
    "auto" | "feasibility" | "permitting" | "risk"
  >("auto");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reduceMotion = useReducedMotion();
  const questions = messages.filter((message) => message.type === "user");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        document.getElementById("urban-menu-toggle")?.focus();
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [sidebarOpen]);

  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "end" });
  }, [messages, isLoading, reduceMotion]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    const name = (file.name || "").toLowerCase();
    const extOk =
      name.endsWith(".pdf") ||
      name.endsWith(".png") ||
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".docx");

    if (!validTypes.includes(file.type) && !extOk) {
      alert("Only PDF, PNG, JPG, and DOCX files are supported");
      e.currentTarget.value = "";
      return;
    }

    setUploadedFile(file);

    const autoPrompt = `Analyze this ${
      file.type === "application/pdf" ? "PDF" : "image"
    } document for compliance in India: ${file.name}`;

    setInputValue(autoPrompt);
  }

  const handleSend = async (overridePrompt?: string) => {
    const prompt = (overridePrompt ?? inputValue).trim();
    if ((!prompt && !uploadedFile && !drawingFile) || isLoading) return;

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

    try {
      let res: Response;

      if (chatMode === "feasibility" && drawingFile) {
        const formData = new FormData();
        formData.append("query", prompt);
        formData.append("mode", chatMode);
        formData.append("drawingFile", drawingFile);

        res = await fetch("/api/rag-chat", {
          method: "POST",
          body: formData,
        });
      } else if (uploadedFile) {
        const formData = new FormData();
        formData.append("document", uploadedFile);

        const lowerPrompt = prompt.toLowerCase();

        const jurisdiction = lowerPrompt.includes("mumbai")
          ? "mumbai"
          : lowerPrompt.includes("delhi")
          ? "delhi"
          : lowerPrompt.includes("bangalore") ||
            lowerPrompt.includes("bengaluru")
          ? "bangalore"
          : lowerPrompt.includes("uk") || lowerPrompt.includes("london")
          ? "uk"
          : lowerPrompt.includes("usa") || lowerPrompt.includes("new york")
          ? "usa"
          : "india";

        const projectType = lowerPrompt.includes("commercial") ||
          lowerPrompt.includes("office")
          ? "commercial"
          : lowerPrompt.includes("mixed")
          ? "mixed-use"
          : lowerPrompt.includes("industrial")
          ? "industrial"
          : lowerPrompt.includes("institutional")
          ? "institutional"
          : "residential";

        formData.append("jurisdiction", jurisdiction);
        formData.append("projectType", projectType);
        formData.append("mode", chatMode);

        res = await fetch("/api/compliance-check", {
          method: "POST",
          body: formData,
        });
      } else {
        res = await fetch("/api/rag-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: prompt, mode: chatMode }),
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
      const mappedCitations = mapBackendCitations(extractRawCitations(data));
      const diagram = extractDiagram(data);

      const aiMessage: ChatMessage = {
        id: `${Date.now()}-assistant`,
        type: "assistant",
        content: answerText,
        timestamp: new Date(),
        metadata: {
          processingtime: processingTime,
          confidence,
          citations: mappedCitations,
          diagram,
          complianceResult:
            data?.complianceResult ??
            data?.data?.complianceResult ??
            data?.metadata?.complianceResult,
        },
      };

      setMessages((prev) => [...prev, aiMessage]);
      setUploadedFile(null);
      setDrawingFile(null);
    } catch (err: any) {
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
      setIsLoading(false);
    }
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  const newChat = () => {
    if (isLoading) return;
    if (messages.length && !window.confirm("Start a new chat? This conversation is not saved after you clear it.")) return;
    setMessages([]);
    setInputValue("");
    setError(null);
    setUploadedFile(null);
    setDrawingFile(null);
    setSidebarOpen(false);
    inputRef.current?.focus();
  };

  const modeDescriptions = {
    auto: "Include a location for more relevant guidance.",
    feasibility: "Include the site location and what you want to build.",
    permitting: "Specify the authority and the permission you need.",
    risk: "Describe your project and the risks you want to explore.",
  };

  return (
    <MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 320, damping: 32 }}>
      <div className="urban-workspace">
        <a href="#urban-composer" className="urban-skip">Skip to message</a>
        {sidebarOpen && (
          <button className="urban-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
        )}
        <aside className={`urban-sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="Workspace navigation">
          <div className="urban-brand">
            <span className="urban-brand-icon"><SparklesIcon className="h-5 w-5" /></span>
            <span className="urban-wordmark">urban<span>ai</span></span>
            <button className="urban-icon-button urban-mobile-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>×</button>
          </div>
          <p className="urban-brand-caption">Planning & construction</p>
          <button className="urban-new-chat" onClick={newChat} disabled={isLoading}>
            <span aria-hidden="true">+</span> New conversation
          </button>
          <div className="urban-sidebar-section">
            <div className="urban-section-label">This conversation <span>{questions.length || ""}</span></div>
            <nav aria-label="Questions in this conversation">
              {questions.length ? questions.map((question) => (
                <button className="urban-question-link" key={question.id} onClick={() => {
                  document.getElementById(question.id)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
                  setSidebarOpen(false);
                }}>
                  <span className="urban-question-dot" aria-hidden="true" />
                  <span>{question.content || "Document analysis"}</span>
                </button>
              )) : <p className="urban-sidebar-empty">Your questions will appear here as you explore.</p>}
            </nav>
          </div>
          <div className="urban-sidebar-bottom">
            <div className="urban-sidebar-note">
              <DocumentIcon className="h-4 w-4" />
              <span>Go from answer<br />to original source.</span>
            </div>
            <div className="urban-session-note">Current session only</div>
          </div>
        </aside>

        <main className="urban-main" id="urban-main">
          <header className="urban-header">
            <div className="urban-header-path">
              <button id="urban-menu-toggle" className="urban-icon-button urban-menu-toggle" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}>
                <Svg className="h-5 w-5"><path d="M4 6h16M4 12h16M4 18h16" /></Svg>
              </button>
              <span className="urban-breadcrumb">Workspace</span>
              <span className="urban-breadcrumb" aria-hidden="true">/</span>
              <span>AI Assistant</span>
            </div>
            <button className="urban-header-new" onClick={newChat} disabled={isLoading}>
              <span aria-hidden="true">+</span> New chat
            </button>
          </header>

          <div className={`urban-conversation ${messages.length === 0 ? "is-empty" : ""}`}>
            <div className="urban-thread">
              {messages.length === 0 ? (
                <WelcomeScreen onSuggestionClick={(suggestion) => {
                  setInputValue(suggestion);
                  inputRef.current?.focus();
                }} />
              ) : (
                <AnimatePresence initial={false}>
                  {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} setMessages={setMessages} />
                  ))}
                </AnimatePresence>
              )}
              <div role="status" aria-live="polite" aria-atomic="true">
                {isLoading ? <LoadingIndicator /> : null}
              </div>
              {error && (
                <div className="urban-error" role="alert">
                  <strong>We couldn’t complete that request.</strong>
                  <span>{error}</span>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <footer className="urban-composer-area">
            <div className="urban-composer-container">
              <form className="urban-composer" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
                <label htmlFor="urban-composer" className="sr-only">Your message</label>
                <textarea
                  ref={inputRef}
                  id="urban-composer"
                  value={inputValue}
                  rows={2}
                  onChange={(event) => setInputValue(event.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="What would you like to understand?"
                  disabled={isLoading}
                  aria-describedby="urban-input-hint"
                />
                <div className="urban-composer-toolbar">
                  <div className="urban-composer-tools">
                    <button type="button" className="urban-icon-button" disabled aria-label="File upload unavailable in this version" title="File upload unavailable in this version">
                      <DocumentIcon className="h-5 w-5" />
                    </button>
                    <span className="urban-toolbar-divider" />
                    <label className="urban-mode">
                      <span className="sr-only">Response mode</span>
                      <select value={chatMode} disabled={isLoading} onChange={(event) => setChatMode(event.target.value as typeof chatMode)}>
                        <option value="auto">Auto</option>
                        <option value="feasibility">Feasibility</option>
                        <option value="permitting">Permitting</option>
                        <option value="risk">Risk review</option>
                      </select>
                    </label>
                  </div>
                  <div className="urban-send-group">
                    <span className="urban-key-hint"><kbd>↵</kbd> to send</span>
                    <motion.button
                      type="submit"
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.94 }}
                      className="urban-send"
                      disabled={(!inputValue.trim() && !uploadedFile && !drawingFile) || isLoading}
                      aria-label={isLoading ? "Waiting for response" : "Send message"}
                    >
                      <Svg className="h-5 w-5"><path d="M12 19V5m-6 6 6-6 6 6" /></Svg>
                    </motion.button>
                  </div>
                </div>
              </form>
              <AnimatePresence>
                {chatMode !== "auto" && (
                  <motion.p key={chatMode} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="urban-mode-hint">
                    {modeDescriptions[chatMode]}
                  </motion.p>
                )}
              </AnimatePresence>
              {chatMode === "feasibility" && (
                <p className="urban-mode-hint">Drawing upload is unavailable in this version. Describe your site in the message.</p>
              )}
              {(drawingFile || uploadedFile) && (
                <div className="urban-file-chip">
                  <DocumentIcon className="h-4 w-4" />
                  <span>{drawingFile?.name || uploadedFile?.name}</span>
                  <button type="button" disabled={isLoading} onClick={() => { setDrawingFile(null); setUploadedFile(null); }}>Remove</button>
                </div>
              )}
              <p id="urban-input-hint" className="urban-footer-note">
                <span>Check original sources before making decisions.</span>
                <span className="urban-newline-hint">Shift + Enter for a new line</span>
              </p>
            </div>
          </footer>
        </main>
      </div>
    </MotionConfig>
  );
}

function WelcomeScreen({ onSuggestionClick }: { onSuggestionClick: (s: string) => void }) {
  const topics = ["Firefighting access", "External fire spread", "Means of escape"];
  return (
    <motion.section
      className="urban-welcome"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="urban-welcome-title"
    >
      <div className="urban-welcome-heading">
        <p className="urban-eyebrow">A little clarity. A better decision.</p>
        <h1 id="urban-welcome-title">Your next question.<br /><span>A clearer perspective.</span></h1>
        <p className="urban-welcome-description">Explore planning and construction guidance.<br className="urban-desktop-break" /> Follow the citations. Understand the details.</p>
      </div>
      <div className="urban-suggestions-heading"><span>Start with a question</span><span>Approved Document B</span></div>
      <div className="urban-suggestions">
        {suggestions.map((suggestion, index) => (
          <motion.button
            key={suggestion}
            className="urban-suggestion"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + index * 0.07, duration: 0.5 }}
            whileHover={{ y: -4 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onSuggestionClick(suggestion)}
          >
            <span className={`urban-topic-mark topic-${index}`}><DocumentIcon className="h-5 w-5" /></span>
            <span className="urban-suggestion-title">{topics[index]}</span>
            <span className="urban-suggestion-copy">{suggestion}</span>
            <span className="urban-suggestion-action">Explore question <span aria-hidden="true">↗</span></span>
          </motion.button>
        ))}
      </div>
    </motion.section>
  );
}

function MessageBubble({
  message,
  setMessages,
}: {
  message: ChatMessage;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}) {
  const isUser = message.type === "user";
  const parts = useMemo(() => splitByTrigger(message.content), [message.content]);

  useEffect(() => {
    if (isUser) return;

    const hasTrigger =
      message.content.includes("[GENERATE_DIAGRAM]") ||
      message.content.includes("**[GENERATE_DIAGRAM]**");

    if (!hasTrigger) return;
    if (message.diagramData?.svgContent) return;

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
      id={message.id}
      className={`urban-message ${isUser ? "is-user" : "is-assistant"}`}
    >
      <div className="mx-auto w-full max-w-5xl">
      <div className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}>
  {!isUser && (
    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-500">
      <SparklesIcon className="h-5 w-5 text-white" />
    </div>
  )}

  <div className={`w-full ${isUser ? "max-w-2xl" : "max-w-5xl"}`}>
    <div
      className={`urban-message-surface px-6 py-5 rounded-2xl ${
        isUser
          ? "ml-auto max-w-[720px] border border-blue-500/20 bg-gradient-to-br from-blue-600/20 to-purple-600/20"
          : "w-full max-w-[980px] border border-white/10 bg-white/5"
      }`}
    >
<div className="urban-answer-text text-slate-200">
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
      h2: ({ children }) => (
        <h2 className="text-lg font-semibold mt-6 mb-3 text-white">{children}</h2>
      ),
      h3: ({ children }) => (
        <h3 className="text-md font-semibold mt-5 mb-2 text-white">{children}</h3>
      ),
      li: ({ children }) => <li className="mb-1">{children}</li>,
      strong: ({ children }) => (
        <strong className="font-semibold text-white">{children}</strong>
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
                <div className="mt-4 max-w-none text-[15px] leading-7 text-slate-200">
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
      li: ({ children }) => <li className="mb-1">{children}</li>,
      strong: ({ children }) => (
        <strong className="font-semibold text-white">{children}</strong>
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

              {message.metadata?.complianceResult && (
                <ComplianceResultDisplay
                  result={message.metadata.complianceResult}
                />
              )}

              {(message.metadata?.processingtime ||
                message.metadata?.confidence != null) && (
                <div className="mt-3 flex items-center gap-4 border-t border-white/10 pt-3 text-xs text-slate-400">
                  {message.metadata?.processingtime ? (
                    <span>
                      {(Number(message.metadata.processingtime) / 1000).toFixed(2)}
                      s
                    </span>
                  ) : null}

                  {message.metadata?.confidence != null ? (
                    <ConfidenceBadge
                      value={Number(message.metadata.confidence)}
                    />
                  ) : null}
                </div>
              )}
{Array.isArray(message.metadata?.citations) &&
  message.metadata.citations.length > 0 && (
    <div className="mt-5 w-full">
      <SourcesSection sources={message.metadata.citations} />
    </div>
  )}
            </div>

            <p
              className={`mt-2 px-2 text-xs text-slate-500 ${
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
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500">
              <UserIcon className="h-5 w-5 text-white" />
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function LoadingIndicator() {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="urban-loading flex gap-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-500">
        <SparklesIcon className="h-5 w-5 text-white" />
      </div>

      <div className="flex-1">
        <div className="max-w-xs rounded-2xl border border-white/10 bg-white/5 px-6 py-4">
          <p className="urban-loading-label">Preparing your answer</p>
          <div className="flex gap-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="h-2 w-2 rounded-full bg-purple-400"
                animate={reduceMotion ? { scale: 1, opacity: 0.7 } : { scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
                transition={reduceMotion ? { duration: 0 } : { duration: 1, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </div>
        </div>
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
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-400">Diagram</p>
          <p className="text-sm font-medium text-slate-200">
            {diagram.title || diagram.spec?.meta?.title || diagram.kind}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">{diagram.kind}</p>
        </div>

        <button
          onClick={downloadPNG}
          disabled={isDownloading}
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <DownloadIcon className="h-4 w-4" />
          {isDownloading ? "Preparing..." : "Download PNG"}
        </button>
      </div>

      <div className="mt-4 overflow-auto rounded-lg border border-white/10">
        {!diagram.svgContent ? (
          <div className="p-3 text-xs text-slate-400">Rendering diagram…</div>
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
