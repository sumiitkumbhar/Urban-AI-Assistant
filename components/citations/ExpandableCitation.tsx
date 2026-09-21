"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

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
  sourceLabel?: string;
  _raw?: any;
}

interface ExpandableCitationProps {
  citation: Citation;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  // The question this citation is evidence for (the preceding user
  // message). Used only to highlight the terms the user actually asked
  // about inside the excerpt text below - purely a reading aid.
  queryText?: string;
}

const HIGHLIGHT_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to",
  "for", "is", "are", "was", "were", "be", "been", "being", "what",
  "does", "do", "did", "how", "when", "where", "which", "who", "why",
  "with", "about", "say", "says", "this", "that", "these", "those",
  "can", "could", "should", "would", "will", "shall", "must", "may",
  "it", "its", "as", "by", "from", "into", "than", "then", "there",
]);

function extractQueryTerms(queryText?: string): string[] {
  if (!queryText) return [];

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of queryText.match(/[A-Za-z0-9][A-Za-z0-9''-]*/g) || []) {
    const term = raw.toLowerCase();
    if (term.length < 3) continue;
    if (HIGHLIGHT_STOPWORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(raw);
    if (terms.length >= 10) break;
  }

  return terms;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wraps occurrences of any highlight term in <mark>, case-insensitively,
// on whole-ish word boundaries so "site" doesn't also light up inside
// "opposite". Falls back to the plain string when there's nothing to
// highlight or the text is empty.
function highlightText(text: string, terms: string[]): React.ReactNode {
  if (!text || terms.length === 0) return text;

  const pattern = terms.map(escapeRegExp).join("|");
  const re = new RegExp(`\\b(${pattern})\\b`, "gi");
  const segments = text.split(re);

  if (segments.length === 1) return text;

  return segments.map((segment, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        className="rounded-md bg-neutral-950/20 px-0.5 text-neutral-950"
      >
        {segment}
      </mark>
    ) : (
      <React.Fragment key={i}>{segment}</React.Fragment>
    )
  );
}

type EvidenceBucket = {
  heading: string;
  lines: string[];
  tone: "primary" | "condition" | "exception" | "support";
};

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
    // A single stray space splitting an otherwise-ordinary word right
    // before a common suffix - "develop ment", "require ment" - a PDF
    // glyph-spacing artifact from these government-PDF extractions, the
    // same underlying class of bug as the letter-by-letter case just
    // above, just one space instead of many. Suffix list is deliberately
    // closed to fragments that are never real standalone English words,
    // to avoid wrongly joining two genuine adjacent words.
    .replace(
      /\b([a-z]{3,})\s(ment|tion|sion|ance|ence|ness|ology|ical|ible|able|ised|ized)\b/g,
      "$1$2"
    )
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
    .replace(/shaftsalso/gi, "shafts also")
    .replace(/storeys,each/gi, "storeys, each")
    .replace(/offirefighting/gi, "of firefighting")
    .replace(/shaftsare/gi, "shafts are")
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

function cleanCitationText(text: string) {
  return repairSmashedWords(stripChunkMetadata(text));
}

function looksLikeClause(line: string) {
  return /^\d+(\.\d+)+/.test(line);
}

function looksLikeBullet(line: string) {
  return /^[•\-]/.test(line) || /^[a-z]\./i.test(line);
}

function looksLikeNumericPoint(line: string) {
  return /^\d+\.$/.test(line) || /^\d+$/.test(line);
}

function looksLikeHeading(line: string) {
  return /^(diagram|figure|table|notes?)\b/i.test(line);
}

function looksLikeUpperHeading(line: string) {
  return /^[A-Z][A-Z\s/&-]{3,}$/.test(line);
}

function normalizeSentenceSpacing(line: string) {
  let t = line;
  t = t.replace(/([.?!;:])([A-Z])/g, "$1 $2");
  t = t.replace(/([a-z])(\d+\.\d+)/g, "$1 $2");
  t = t.replace(/(\d+\.\d+)([A-Z])/g, "$1 $2");
  t = t.replace(/([a-z])([A-Z][a-z])/g, "$1 $2");
  t = t.replace(/([a-z])([A-Z]{2,})/g, "$1 $2");
  t = t.replace(/([a-z])\(/g, "$1 (");
  t = t.replace(/\)\(/g, ") (");
  t = t.replace(/\s{2,}/g, " ");
  return t.trim();
}

function isStructuralStart(line: string) {
  return (
    looksLikeClause(line) ||
    looksLikeBullet(line) ||
    looksLikeNumericPoint(line) ||
    looksLikeHeading(line) ||
    looksLikeUpperHeading(line)
  );
}

function isLikelyContinuation(prev: string, current: string) {
  const prevTrimmed = prev.trim();
  const currentTrimmed = current.trim();

  if (!prevTrimmed || !currentTrimmed) return false;
  if (isStructuralStart(currentTrimmed)) return false;

  if (
    !/[.!?;:]$/.test(prevTrimmed) ||
    /\b(and|or|to|of|for|with|including|which|that|where|when|if|than|into|onto|under|over|both|more|less|minimum|maximum|paragraph|paragraphs|see)$/i.test(
      prevTrimmed
    ) ||
    /\($/.test(prevTrimmed)
  ) {
    return true;
  }

  if (
    /^[a-z(]/.test(currentTrimmed) ||
    /^(to|and|or|of|for|with|including|which|that|where|when|if|than|into|onto|under|over|both|more|less|minimum|maximum|see)\b/i.test(
      currentTrimmed
    )
  ) {
    return true;
  }

  return false;
}

function splitReadableParagraphs(text: string) {
  const rawLines = text
    .split("\n")
    .map((line) => normalizeSentenceSpacing(line.trim()))
    .filter(Boolean);

  const merged: string[] = [];

  for (const line of rawLines) {
    if (!merged.length) {
      merged.push(line);
      continue;
    }

    const prev = merged[merged.length - 1];

    if (isLikelyContinuation(prev, line)) {
      merged[merged.length - 1] = `${prev} ${line}`
        .replace(/\s{2,}/g, " ")
        .trim();
    } else {
      merged.push(line);
    }
  }

  return merged.map((line) => normalizeSentenceSpacing(line)).filter(Boolean);
}

function normalizeForBuckets(lines: string[]) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^ONLINE VERSION$/i.test(line) &&
        !/^Approved Document$/i.test(line) &&
        !/^Volume \d+$/i.test(line) &&
        !/^Building Regulations \d+$/i.test(line) &&
        !/^of the following\.?$/i.test(line) &&
        !/^[0-9]+\.?$/.test(line)
    );
}

function buildSemanticBlocks(lines: string[]) {
  const cleaned = normalizeForBuckets(lines);
  const blocks: string[] = [];

  for (const line of cleaned) {
    if (!blocks.length) {
      blocks.push(line);
      continue;
    }

    const prev = blocks[blocks.length - 1];
    const startsFresh =
      isStructuralStart(line) && !isLikelyContinuation(prev, line);

    if (startsFresh) {
      blocks.push(line);
    } else {
      blocks[blocks.length - 1] = `${prev} ${line}`
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  }

  return blocks.map((block) => normalizeSentenceSpacing(block)).filter(Boolean);
}

function classifyBlockTone(block: string): EvidenceBucket["tone"] {
  const l = block.toLowerCase();

  if (
    /not required|does not need|need not|excluding|except|excludes|not applicable|is not required|are not required/i.test(
      block
    )
  ) {
    return "exception";
  }

  if (
    /if|where|when|provided to|minimum|maximum|more than|less than|at least|purpose group|storey|basement|area of|floor level|height|access level/i.test(
      l
    )
  ) {
    return "condition";
  }

  if (
    looksLikeClause(block) ||
    looksLikeBullet(block) ||
    looksLikeNumericPoint(block)
  ) {
    return "support";
  }

  return "primary";
}

function extractComplianceBuckets(lines: string[]): EvidenceBucket[] {
  const blocks = buildSemanticBlocks(lines);

  const primary: string[] = [];
  const conditions: string[] = [];
  const exceptions: string[] = [];
  const support: string[] = [];

  for (const block of blocks) {
    const tone = classifyBlockTone(block);
    if (tone === "exception") exceptions.push(block);
    else if (tone === "condition") conditions.push(block);
    else if (tone === "support") support.push(block);
    else primary.push(block);
  }

  const buckets: EvidenceBucket[] = [];

  if (primary.length) {
    buckets.push({
      heading: "Requirement",
      lines: primary.slice(0, 8),
      tone: "primary",
    });
  }

  if (conditions.length) {
    buckets.push({
      heading: "Conditions / Triggers",
      lines: conditions.slice(0, 20),
      tone: "condition",
    });
  }

  if (exceptions.length) {
    buckets.push({
      heading: "Exceptions / Limits",
      lines: exceptions.slice(0, 12),
      tone: "exception",
    });
  }

  if (support.length) {
    buckets.push({
      heading: "Evidence Extract",
      lines: support.slice(0, 20),
      tone: "support",
    });
  }

  return buckets;
}

// Thresholds are calibrated to how our retrieval actually scores real
// matches: cosine-similarity confidence for genuinely relevant chunks
// typically lands in the 65-90% band, so an 85/60 cutoff left almost
// every solid citation labeled "medium." 75/55 reflects that a citation
// in the 75%+ range is a strong match here, not a borderline one.
export function getConfidenceTier(
  confidence: number
): "high" | "medium" | "low" {
  if (confidence >= 75) return "high";
  if (confidence >= 55) return "medium";
  return "low";
}

// Same meter convention used everywhere else in this app: brightness
// scales with the tier (High is a solid fill, Low is barely visible),
// since the High/Medium/Low text label is the real signal, not hue.
export function getConfidenceTone(confidence: number) {
  const tier = getConfidenceTier(confidence);

  if (tier === "high") {
    return {
      tier,
      label: "High",
      chip: "border-neutral-950/30 bg-neutral-950/12 text-neutral-950",
      dot: "bg-neutral-950",
    };
  }

  if (tier === "medium") {
    return {
      tier,
      label: "Medium",
      chip: "border-neutral-950/18 bg-neutral-950/6 text-neutral-700",
      dot: "bg-neutral-600",
    };
  }

  return {
    tier,
    label: "Low",
    chip: "border-neutral-950/10 bg-neutral-950/4 text-neutral-500",
    dot: "bg-neutral-400",
  };
}

function getTypeLabel(type: string) {
  if (type === "government_doc") return "Government doc";
  if (type === "legal_case") return "Legal";
  if (type === "technical_standard") return "Standard";
  if (type === "rate_schedule") return "Schedule";
  if (type === "web") return "Web";
  if (type === "user_upload") return "Your upload";
  return type || "Source";
}

// These four are categories, not a scale (the main rule vs. its
// conditions vs. its exceptions vs. general supporting text) - so
// they're differentiated by weight and border style instead of a
// brightness gradient, which is reserved for actual meters above.
function bucketToneClasses(tone: EvidenceBucket["tone"]) {
  if (tone === "primary") {
    return {
      wrap: "border-neutral-950/20 bg-neutral-950/[0.05]",
      title: "text-neutral-950",
      dot: "bg-neutral-950",
    };
  }

  if (tone === "condition") {
    return {
      wrap: "border-neutral-950/12 bg-neutral-950/[0.03]",
      title: "text-neutral-700",
      dot: "bg-neutral-600",
    };
  }

  if (tone === "exception") {
    return {
      wrap: "border-dashed border-neutral-950/15 bg-neutral-950/[0.03]",
      title: "text-neutral-800",
      dot: "bg-neutral-700",
    };
  }

  return {
    wrap: "border-neutral-950/10 bg-neutral-950/[0.02]",
    title: "text-neutral-700",
    dot: "bg-neutral-600",
  };
}

function renderEvidenceLine(line: string, key: string, terms: string[] = []) {
  const trimmed = line.trim();

  if (looksLikeClause(trimmed)) {
    const firstSpace = trimmed.indexOf(" ");
    const clause = firstSpace > -1 ? trimmed.slice(0, firstSpace) : trimmed;
    const rest = firstSpace > -1 ? trimmed.slice(firstSpace + 1) : "";

    return (
      <p
        key={key}
        className="break-words [overflow-wrap:anywhere] border-l-2 border-neutral-950/40 pl-3 text-neutral-800"
      >
        <span className="font-semibold text-neutral-950">{clause}</span>{" "}
        <span className="text-neutral-800">{highlightText(rest, terms)}</span>
      </p>
    );
  }

  if (/^[a-z]\./i.test(trimmed)) {
    return (
      <div
        key={key}
        className="relative break-words [overflow-wrap:anywhere] pl-5 text-neutral-800"
      >
        <span className="absolute left-0 top-[10px] h-1.5 w-1.5 rounded-full bg-neutral-600" />
        {highlightText(trimmed.slice(2).trim(), terms)}
      </div>
    );
  }

  if (/^[•\-]/.test(trimmed)) {
    return (
      <div
        key={key}
        className="relative break-words [overflow-wrap:anywhere] pl-5 text-neutral-800"
      >
        <span className="absolute left-0 top-[10px] h-1.5 w-1.5 rounded-full bg-neutral-600" />
        {highlightText(trimmed.replace(/^[•\-]\s*/, ""), terms)}
      </div>
    );
  }

  if (looksLikeNumericPoint(trimmed)) {
    return (
      <div key={key} className="text-sm font-semibold text-neutral-600">
        {trimmed.replace(/\.$/, "")}.
      </div>
    );
  }

  if (/^(diagram|figure|table)/i.test(trimmed)) {
    return (
      <p
        key={key}
        className="break-words [overflow-wrap:anywhere] font-semibold uppercase tracking-wide text-neutral-700"
      >
        {trimmed}
      </p>
    );
  }

  if (/^(B\d|NOTES?)$/i.test(trimmed)) {
    return (
      <p
        key={key}
        className="break-words [overflow-wrap:anywhere] font-semibold tracking-wide text-neutral-700"
      >
        {trimmed}
      </p>
    );
  }

  return (
    <p key={key} className="break-words [overflow-wrap:anywhere] text-neutral-800">
      {highlightText(trimmed, terms)}
    </p>
  );
}

function looksTruncated(text: string) {
  if (!text) return false;

  const t = text.trim();
  if (!t) return false;

  const lastLine =
    t
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() || t;

  if (
    /\b(and|or|to|of|for|with|including|which|that|where|when|if|than|see|paragraph|paragraphs)$/i.test(
      lastLine
    )
  ) {
    return true;
  }

  if (/\($/.test(lastLine)) return true;
  if (/[:;,-]$/.test(lastLine)) return true;
  if (/^(\d+\.|[a-z]\.)$/i.test(lastLine)) return true;

  return false;
}

function looksLikeMidSentenceStart(text: string) {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  // A real sentence start is capitalized (or a digit/bullet, handled
  // elsewhere) - a lowercase first letter means this chunk's text window
  // begins partway through a sentence carried over from the previous
  // chunk, same underlying cause as looksTruncated() at the tail end.
  return /^[a-z]/.test(t);
}

function looksDirtyForStructuredView(text: string) {
  if (!text) return false;

  return (
    /\[(TOPIC|SECTION|HEADING|KEYWORDS|NEXT_PAGE|PREV_PAGE)\]/i.test(text) ||
    looksTruncated(text)
  );
}

function getScrollClass() {
  return "overflow-visible";
}

export default function ExpandableCitation({
  citation,
  index,
  expanded,
  onToggle,
  queryText,
}: ExpandableCitationProps) {
  const highlightTerms = useMemo(() => extractQueryTerms(queryText), [queryText]);
  const [pagePreviewOpen, setPagePreviewOpen] = useState(false);
  const [pagePreviewLoading, setPagePreviewLoading] = useState(false);
  const [pagePreviewUrl, setPagePreviewUrl] = useState<string | null>(null);
  const [pagePreviewError, setPagePreviewError] = useState<string | null>(null);

  // Local-rag-only: a citation carries its corpus-wide chunk_id (see
  // local-rag/answer.py's build_context()) so its raw extract - one
  // fixed-size retrieval window - can be expanded with the neighboring
  // chunk(s) from the same document on demand. Cloud-path citations
  // never have this field, so the control below simply doesn't render
  // for them.
  const chunkId: string | undefined = citation._raw?.chunk_id;
  const [contextStatus, setContextStatus] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [expandedContext, setExpandedContext] = useState<{
    text: string;
    docFilename: string;
    pageStart: number;
    pageEnd: number;
    expandedBefore: boolean;
    expandedAfter: boolean;
  } | null>(null);
  const [contextErrorMsg, setContextErrorMsg] = useState<string | null>(null);
  const [showExpandedContext, setShowExpandedContext] = useState(false);

  const rawSourceText = useMemo(
    () => citation.fullText || citation.excerpt || "",
    [citation.fullText, citation.excerpt]
  );

  const rawDisplayText = useMemo(
    () => stripChunkMetadata(rawSourceText),
    [rawSourceText]
  );

  const cleanedFullText = useMemo(
    () => cleanCitationText(rawDisplayText),
    [rawDisplayText]
  );

  const rawParagraphs = useMemo(
    () => splitReadableParagraphs(cleanedFullText),
    [cleanedFullText]
  );

  const cleanedParagraphs = useMemo(
    () => splitReadableParagraphs(cleanedFullText),
    [cleanedFullText]
  );

  const complianceBuckets = useMemo(
    () => extractComplianceBuckets(cleanedParagraphs),
    [cleanedParagraphs]
  );

  const rawLikelyTruncated = useMemo(
    () => looksTruncated(rawDisplayText),
    [rawDisplayText]
  );

  // Whichever text is actually on screen right now - the original
  // single-chunk extract, or the neighbor-stitched version once the
  // user has asked for more context (see loadCitationContext() below
  // and GET /citation-context/{chunk_id} on the local-rag service).
  const activeCleanedText = useMemo(() => {
    if (showExpandedContext && expandedContext) {
      return cleanCitationText(stripChunkMetadata(expandedContext.text));
    }
    return cleanedFullText;
  }, [showExpandedContext, expandedContext, cleanedFullText]);

  const activeRawParagraphs = useMemo(
    () => splitReadableParagraphs(activeCleanedText),
    [activeCleanedText]
  );

  const activeRawLikelyTruncated = useMemo(
    () => looksTruncated(activeCleanedText),
    [activeCleanedText]
  );

  // Chunks are fixed-size retrieval windows, not paragraph-aligned, so
  // the first/last line of a chunk's text routinely lands mid-sentence -
  // that's expected (see "Source text appears truncated upstream" above),
  // but a bare lowercase-starting fragment with no visual cue reads as
  // broken rather than as "this is a fragment of a larger passage". An
  // ellipsis marks the cut honestly without inventing any missing text.
  // Re-checked against whichever text is active, so the markers clear on
  // whichever side actually got real neighboring text stitched in.
  const rawParagraphsForDisplay = useMemo(() => {
    if (activeRawParagraphs.length === 0) return activeRawParagraphs;
    const out = [...activeRawParagraphs];
    if (looksLikeMidSentenceStart(out[0])) {
      out[0] = `… ${out[0]}`;
    }
    const lastIdx = out.length - 1;
    if (activeRawLikelyTruncated && !/[….!?]\s*$/.test(out[lastIdx])) {
      out[lastIdx] = `${out[lastIdx]} …`;
    }
    return out;
  }, [activeRawParagraphs, activeRawLikelyTruncated]);

  const loadCitationContext = async () => {
    if (!chunkId) return;

    if (expandedContext) {
      // Already fetched once this session - just toggle visibility
      // rather than hitting the service again.
      setShowExpandedContext((prev) => !prev);
      return;
    }

    try {
      setContextStatus("loading");
      setContextErrorMsg(null);

      const res = await fetch(
        `/api/local-rag-citation-context?chunk_id=${encodeURIComponent(chunkId)}&window=1`
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.text) {
        throw new Error(data?.error || `Failed (${res.status})`);
      }

      setExpandedContext({
        text: data.text,
        docFilename: data.docFilename,
        pageStart: data.pageStart,
        pageEnd: data.pageEnd,
        expandedBefore: data.expandedBefore,
        expandedAfter: data.expandedAfter,
      });
      setShowExpandedContext(true);
      setContextStatus("loaded");
    } catch (err) {
      setContextStatus("error");
      setContextErrorMsg(
        err instanceof Error ? err.message : "Could not load more context"
      );
    }
  };

  const shouldUseRawFallback = useMemo(
    () =>
      looksDirtyForStructuredView(rawSourceText) ||
      rawLikelyTruncated ||
      complianceBuckets.length === 0,
    [rawSourceText, rawLikelyTruncated, complianceBuckets.length]
  );

  const previewText = useMemo(() => {
    if (!rawDisplayText) return "";

    const mergedLines = splitReadableParagraphs(cleanCitationText(rawDisplayText));
    const firstReadable = mergedLines[0] || rawDisplayText;
    const sentenceMatch = firstReadable.match(/.*?[.!?](\s|$)/);
    const firstSentence = sentenceMatch?.[0]?.trim();

    if (
      firstSentence &&
      firstSentence.length >= 50 &&
      firstSentence.length <= 170
    ) {
      return firstSentence;
    }

    return firstReadable.length > 170
      ? `${firstReadable.slice(0, 170).trim()}…`
      : firstReadable;
  }, [rawDisplayText]);

  const tone = getConfidenceTone(Number(citation.confidence || 0));

  const loadPagePreview = async () => {
    const pdfUrl =
      citation.directLink ||
      citation._raw?.doc_path ||
      citation._raw?.directLink;
  
    const pageNumber = citation.pageNumber;
  
    if (!pdfUrl || !pageNumber) {
      setPagePreviewError("Missing PDF link or page number");
      return;
    }
  
    try {
      setPagePreviewLoading(true);
      setPagePreviewError(null);
      setPagePreviewOpen(false);
  
      const res = await fetch("/api/source-page", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pdfUrl,
          pageNumber,
        }),
      });
  
      const data = await res.json().catch(() => ({}));
  
      if (!res.ok || !data?.success || !data?.previewUrl) {
        throw new Error(data?.error || `Failed (${res.status})`);
      }
  
      setPagePreviewUrl(String(data.previewUrl));
      setPagePreviewOpen(true);
    } catch (e: any) {
      setPagePreviewError(e?.message || "Failed to load page preview");
    } finally {
      setPagePreviewLoading(false);
    }
  };


  const accentBar =
    tone.tier === "high"
      ? "bg-neutral-950/80"
      : tone.tier === "medium"
      ? "bg-neutral-600/70"
      : "bg-neutral-400/70";

  return (
    <div className="relative overflow-hidden rounded-3xl border border-neutral-950/10 bg-neutral-950/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.03)] transition-all duration-200 hover:border-neutral-950/15 hover:bg-neutral-950/[0.06] hover:shadow-[0_2px_8px_rgba(0,0,0,0.05),0_1px_2px_rgba(0,0,0,0.03)]">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[3px] ${accentBar}`}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} source: ${
          citation.title || "Untitled source"
        }`}
        className="group w-full py-3 pl-5 pr-4 text-left"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-neutral-950/10 bg-neutral-950/10 px-2 text-[11px] font-semibold text-neutral-800">
                {index + 1}
              </span>

              <h4 className="truncate text-sm font-semibold text-neutral-950 transition group-hover:text-neutral-700">
                {citation.title || "Untitled source"}
              </h4>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-600">
              {citation.pageNumber ? <span>Page {citation.pageNumber}</span> : null}
              {citation.clauseNumber ? <span>Clause {citation.clauseNumber}</span> : null}
              {citation.section ? (
                <span className="max-w-[280px] truncate text-neutral-500">
                  {citation.section}
                </span>
              ) : null}
            </div>

            {previewText ? (
              <p className="mt-2 line-clamp-2 text-xs leading-5 text-neutral-700/90">
                {highlightText(previewText, highlightTerms)}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tone.chip}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              <span className="font-mono">{Math.round(citation.confidence || 0)}%</span>
              <span className="text-[9px] font-semibold uppercase tracking-wide opacity-80">
                {tone.label}
              </span>
            </span>

            <span className="rounded-full border border-neutral-950/10 bg-neutral-950/5 px-2.5 py-1 text-[11px] text-neutral-700">
              {getTypeLabel(citation.type)}
            </span>
          </div>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-visible"
          >
            <div className="border-t border-neutral-950/10 bg-neutral-950/[0.02] px-4 py-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {citation.directLink ? (
                  <a
                    href={citation.directLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-xl border border-neutral-950/15 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/12"
                  >
                    Open source
                  </a>
                ) : null}

{citation.pageNumber &&
typeof citation.directLink === "string" &&
citation.directLink.startsWith("http") ? (
                  <button
                    type="button"
                    onClick={loadPagePreview}
                    className="inline-flex items-center rounded-xl border border-neutral-950/15 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/12"
                  >
                    {pagePreviewLoading
                      ? "Loading page..."
                      : `View page ${citation.pageNumber}`}
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard.writeText(rawDisplayText || cleanedFullText)
                  }
                  className="inline-flex items-center rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-1.5 text-xs text-neutral-800 transition hover:bg-neutral-950/10"
                >
                  Copy text
                </button>

                {chunkId &&
                (looksLikeMidSentenceStart(rawParagraphs[0] || "") ||
                  rawLikelyTruncated) ? (
                  <button
                    type="button"
                    onClick={loadCitationContext}
                    disabled={contextStatus === "loading"}
                    className="inline-flex items-center rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-1.5 text-xs text-neutral-800 transition hover:bg-neutral-950/10 disabled:opacity-60"
                  >
                    {contextStatus === "loading"
                      ? "Loading more context..."
                      : showExpandedContext
                      ? "Hide extra context"
                      : "Show more context"}
                  </button>
                ) : null}

                {rawLikelyTruncated ? (
                  <span className="inline-flex items-center rounded-xl border border-dashed border-neutral-950/20 bg-neutral-950/[0.05] px-3 py-1.5 text-xs text-neutral-800">
                    Source text appears truncated upstream
                  </span>
                ) : null}
              </div>

              {showExpandedContext && expandedContext ? (
                <p className="mb-3 text-[11px] text-neutral-600">
                  Showing{" "}
                  {expandedContext.pageStart === expandedContext.pageEnd
                    ? `page ${expandedContext.pageStart}`
                    : `pages ${expandedContext.pageStart}\u2013${expandedContext.pageEnd}`}{" "}
                  of {expandedContext.docFilename}
                  {!expandedContext.expandedBefore && !expandedContext.expandedAfter
                    ? " - no further neighboring text was available in this document"
                    : !expandedContext.expandedBefore
                    ? " - already at the start of this document"
                    : !expandedContext.expandedAfter
                    ? " - already at the end of this document"
                    : ""}
                  .
                </p>
              ) : null}

              {contextErrorMsg ? (
                <div className="mb-3 rounded-2xl border border-neutral-950/25 bg-neutral-950/10 px-3 py-2 text-xs text-neutral-950">
                  {contextErrorMsg}
                </div>
              ) : null}

              {pagePreviewError ? (
                <div className="mb-3 rounded-2xl border border-neutral-950/25 bg-neutral-950/10 px-3 py-2 text-xs text-neutral-950">
                  {pagePreviewError}
                </div>
              ) : null}

{pagePreviewOpen && pagePreviewUrl ? (
  <div className="mb-4 rounded-3xl border border-neutral-950/10 bg-neutral-950/[0.03] p-3">
    <div className="mb-3 flex items-center justify-between gap-3">
      <p className="text-xs text-neutral-600">
        Source page preview — Page {citation.pageNumber}
      </p>

      <a
        href={pagePreviewUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center rounded-xl border border-neutral-950/15 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/12"
      >
        Open full page
      </a>
    </div>

    <iframe
      src={pagePreviewUrl}
      title={`Preview of page ${citation.pageNumber}`}
      className="h-[720px] w-full rounded-xl border border-neutral-950/10 bg-white"
    />
  </div>
) : null}

              {shouldUseRawFallback ? (
                <div className="rounded-3xl border border-dashed border-neutral-950/20 bg-neutral-950/[0.05] p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-neutral-600" />
                    <h5 className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-700">
                      Raw extract
                    </h5>
                  </div>

                  <div className="space-y-2 text-[12px] leading-7">
                    {rawParagraphsForDisplay.slice(0, 40).map((line, i) =>
                      renderEvidenceLine(line, `${citation.id}-raw-${i}`, highlightTerms)
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {complianceBuckets.map((bucket, bucketIndex) => {
                    const bucketTone = bucketToneClasses(bucket.tone);

                    return (
                      <div
                        key={`${citation.id}-bucket-${bucketIndex}`}
                        className={`rounded-3xl border p-4 ${bucketTone.wrap}`}
                      >
                        <div className="mb-3 flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${bucketTone.dot}`} />
                          <h5
                            className={`text-xs font-semibold uppercase tracking-[0.14em] ${bucketTone.title}`}
                          >
                            {bucket.heading}
                          </h5>
                        </div>

                        <div
                          className={`${getScrollClass()} space-y-2 pb-1 text-[12px] leading-7`}
                        >
                          {bucket.lines.map((line, lineIndex) =>
                            renderEvidenceLine(
                              line,
                              `${citation.id}-${bucketIndex}-${lineIndex}`,
                              highlightTerms
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}