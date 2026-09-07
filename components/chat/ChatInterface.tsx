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

  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!isModeMenuOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsModeMenuOpen(false);
        document.getElementById("urban-mode-toggle")?.focus();
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [isModeMenuOpen]);

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
      handleSend();
    }
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="urban-polish flex h-full flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="urban-header border-b border-white/5">
        <div className="urban-brand">
          <SparklesIcon className="h-5 w-5" />
          <span>Urban AI Assistant</span>
        </div>
        <motion.button
          whileTap={{ scale: 0.96 }}
          className="urban-new-chat rounded-xl border border-white/10 bg-white/5 text-slate-200 hover:border-white/20 hover:bg-white/10"
          disabled={isLoading || messages.length === 0}
          onClick={() => {
            if (!window.confirm("Start a new chat? This conversation is not saved after you clear it.")) return;
            setMessages([]);
            setError(null);
            setInputValue("");
            setUploadedFile(null);
            setDrawingFile(null);
            setIsModeMenuOpen(false);
            inputRef.current?.focus();
          }}
        >
          <span aria-hidden="true">+</span> New chat
        </motion.button>
      </header>
      <div className={`urban-scroll flex-1 overflow-y-auto px-4 py-6 sm:px-6 ${messages.length === 0 ? "urban-empty" : ""}`}>
      <div className="urban-thread mx-auto w-full max-w-7xl space-y-6 px-6 sm:px-8 lg:px-12">
          {messages.length === 0 ? (
            <WelcomeScreen onSuggestionClick={(s) => { setInputValue(s); inputRef.current?.focus(); }} />
          ) : (
            <AnimatePresence>
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  setMessages={setMessages}
                />
              ))}
            </AnimatePresence>
          )}

          <div role="status" aria-live="polite" aria-atomic="true">{isLoading && <LoadingIndicator />}</div>

          {error && (
            <div role="alert" className="max-w-md rounded-lg border border-rose-700/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-400">
              Backend error: {error}
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <div className="urban-composer-area border-t border-white/5 bg-black/20 p-4 backdrop-blur-xl sm:p-6">
      <div className="urban-composer-width mx-auto w-full max-w-7xl px-6 sm:px-8 lg:px-12">
          <div className="urban-composer relative">
            <label htmlFor="urban-message-input" className="sr-only">Your question</label>
            <textarea
              id="urban-message-input"
              ref={inputRef}
              rows={3}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask a question about planning or construction…"
              className="w-full rounded-2xl border border-white/10 bg-white/5 py-4 pl-10 pr-32 text-sm transition-all placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
              disabled={isLoading}
            />

            <div className="urban-composer-left absolute left-2 bottom-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsModeMenuOpen((v) => !v)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-slate-900/80 text-base leading-none text-slate-200 hover:bg-slate-800"
                  id="urban-mode-toggle"
                  aria-label="Select mode"
                  aria-expanded={isModeMenuOpen}
                  aria-controls="urban-mode-options"
                >
                  +
                </button>

                {isModeMenuOpen && (
                  <div id="urban-mode-options" className="absolute bottom-10 left-0 w-44 rounded-xl border border-white/10 bg-slate-900/95 py-1 text-xs text-slate-100 shadow-lg">
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
                        className={`flex w-full items-center justify-between px-3 py-2 hover:bg-white/10 ${
                          chatMode === mode.id ? "text-purple-300" : ""
                        }`}
                      >
                        <span>{mode.label}</span>
                        {chatMode === mode.id && <span>•</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="urban-composer-right absolute right-2 bottom-2 flex items-center gap-2">
              <label
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-slate-900/80 text-xs text-slate-300 hover:bg-slate-800/90"
                title="Attach file"
              >
                <input
                  type="file"
                  onChange={handleFileUpload}
                  className="sr-only"
                  aria-label="Attach file"
                  accept=".pdf,.png,.jpg,.jpeg,.docx"
                  disabled={isLoading}
                />
                <DocumentIcon className="h-4 w-4 text-slate-200" />
              </label>

              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-slate-900/80 text-xs text-slate-300 hover:bg-slate-800/90"
                aria-label="Voice input unavailable in this version"
                title="Voice input unavailable in this version"
                disabled
              >
                <Svg className="h-4 w-4"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6" /></Svg>
              </button>

              <button
                onClick={() => handleSend()}
                disabled={
                  (!inputValue.trim() && !uploadedFile && !drawingFile) ||
                  isLoading
                }
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 transition-all hover:from-purple-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Send"
              >
                <PaperAirplaneIcon className="h-4 w-4 text-white" />
              </button>
            </div>
          </div>

          {uploadedFile && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs text-slate-300">
                  Uploaded:{" "}
                  <span className="text-slate-200">{uploadedFile.name}</span>
                </p>
                <p className="text-[11px] text-slate-500">
                  Next send will run compliance check with this file.
                </p>
              </div>

              <button
                onClick={() => setUploadedFile(null)}
                className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/20 hover:text-rose-200"
              >
                Remove
              </button>
            </div>
          )}

          {chatMode === "feasibility" && (
            <div className="mt-3 space-y-2">
              <label className="block text-xs text-slate-400">
                Optional: Upload floor plan or site plan for automatic analysis
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setDrawingFile(file);
                  }}
                  className="mt-1 block w-full text-xs text-slate-400 file:mr-4 file:rounded-lg file:border-0 file:bg-purple-600 file:px-4 file:py-2 file:text-xs file:text-white hover:file:bg-purple-500"
                  disabled={isLoading}
                />
              </label>

              {drawingFile && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-slate-300">
                      Drawing:{" "}
                      <span className="text-slate-200">{drawingFile.name}</span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Will be analyzed for code compliance when you send
                    </p>
                  </div>

                  <button
                    onClick={() => setDrawingFile(null)}
                    className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/20 hover:text-rose-200"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="mt-2 text-left text-[11px] text-slate-400">
            {chatMode === "auto" &&
              "Mode: Auto – describe what you want; the assistant will choose Feasibility, Permitting, or Risk."}
            {chatMode === "feasibility" &&
              "Mode: Feasibility – share the site location, jurisdiction, and what you want to build."}
            {chatMode === "permitting" &&
              "Mode: Permitting – upload your submission pack and specify the authority/jurisdiction."}
            {chatMode === "risk" &&
              "Mode: Risk – provide project context/documents to analyze what could get rejected or delayed."}
          </div>

          <p className="mt-3 text-center text-xs text-slate-500">
            Enter to send. Shift+Enter for new line. AI can be wrong.
          </p>
        </div>
      </div>
    </div>
    </MotionConfig>
  );
}

function WelcomeScreen({
  onSuggestionClick,
}: {
  onSuggestionClick: (s: string) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
      className="urban-welcome py-12 text-center"
    >
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-[0_0_48px_rgba(168,85,247,.4)]">
        <SparklesIcon className="h-10 w-10 text-white" />
      </div>

      <h1 className="urban-heading mb-4 text-4xl font-bold">
        A clearer view.<br />
        <span className="bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
          A better decision.
        </span>
      </h1>

      <p className="urban-welcome-description mb-12 text-lg text-slate-300">
        Grounded regulatory answers with citations, page references, and
        clause-level support
      </p>

      <p className="mb-4 text-sm text-slate-400">Try asking:</p>

      <div className="urban-suggestions mx-auto grid max-w-3xl grid-cols-1 gap-3">
        {suggestions.map((suggestion, i) => (
          <motion.button
            key={i}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 + i * 0.07, duration: 0.4 }}
            whileHover={{ y: -4 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onSuggestionClick(suggestion)}
            className="urban-suggestion w-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-left text-sm text-slate-200 transition-all hover:border-white/20 hover:bg-white/10"
          >
            <span className="urban-suggestion-label">{["Firefighting access", "External fire spread", "Means of escape"][i]}</span>
            <span>{suggestion}</span>
            <span className="urban-suggestion-arrow" aria-hidden="true">↗</span>
          </motion.button>
        ))}
      </div>
    </motion.div>
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
      className={`urban-message w-full ${isUser ? "urban-user-message" : "urban-assistant-message"}`}
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
<div className="text-[15px] leading-7 text-slate-200">
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
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-500">
        <SparklesIcon className="h-5 w-5 text-white" />
      </div>

      <div className="flex-1">
        <div className="max-w-xs rounded-2xl border border-white/10 bg-white/5 px-6 py-4">
          <span className="sr-only">Preparing your answer</span>
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
