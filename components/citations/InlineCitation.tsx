"use client";

import React, { useMemo, useState } from "react";

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

interface InlineCitationProps {
  token: string;
  citations: Citation[];
}

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

function cleanPreview(text: string) {
  if (!text) return "";

  return normalizeSentenceSpacing(repairSmashedWords(stripChunkMetadata(text)));
}

function findCitation(token: string, citations: Citation[]) {
  const normalized = token.replace(/[\[\]]/g, "").trim().toUpperCase();
  return citations.find((c) => String(c.id).toUpperCase() === normalized);
}

export default function InlineCitation({
  token,
  citations,
}: InlineCitationProps) {
  const [open, setOpen] = useState(false);

  const citation = useMemo(() => findCitation(token, citations), [token, citations]);

  const preview = useMemo(() => {
    if (!citation) return "";
    const raw = cleanPreview(citation.excerpt || citation.fullText || "");
    return raw.length > 220 ? `${raw.slice(0, 220).trim()}…` : raw;
  }, [citation]);

  const handleJump = () => {
    if (!citation) return;
    const el = document.getElementById(`citation-card-${citation.id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-neutral-950/50");
      window.setTimeout(() => {
        el.classList.remove("ring-2", "ring-neutral-950/50");
      }, 1400);
    }
    setOpen(false);
  };

  if (!citation) {
    return (
      <span className="inline-flex align-middle rounded-lg border border-neutral-950/10 bg-neutral-950/5 px-1.5 py-0.5 text-[11px] text-neutral-700">
        {token}
      </span>
    );
  }

  return (
    <span className="relative mx-0.5 inline-flex align-middle">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={handleJump}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Citation ${token}: ${citation.title}. Show source details.`}
        className="inline-flex rounded-lg border border-neutral-950/20 bg-neutral-950/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-neutral-900 transition hover:bg-neutral-950/15"
      >
        {token}
      </button>

      {open && (
        <div
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          // A fixed 320px popover anchored to the left edge of an inline
          // citation token overflows the viewport on phones, since the
          // token can sit anywhere in a paragraph. Below the sm breakpoint
          // it's centered under the token instead and capped at 85% of
          // the viewport width, so it can never force horizontal scroll.
          className="absolute left-1/2 top-7 z-50 w-[85vw] max-w-[20rem] -translate-x-1/2 rounded-2xl border border-neutral-950/10 bg-neutral-50/95 p-3 shadow-2xl backdrop-blur-xl sm:left-0 sm:w-80 sm:max-w-none sm:translate-x-0"
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-neutral-950">
                {citation.title}
              </p>
              <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-neutral-600">
                {citation.pageNumber ? <span>Page {citation.pageNumber}</span> : null}
                {citation.clauseNumber ? <span>Clause {citation.clauseNumber}</span> : null}
                {citation.section ? (
                  <span className="max-w-[180px] truncate">{citation.section}</span>
                ) : null}
              </div>
            </div>

            <span className="shrink-0 rounded-full border border-neutral-950/20 bg-neutral-950/[0.08] px-2 py-0.5 text-[11px] text-neutral-900">
              {Math.round(citation.confidence || 0)}%
            </span>
          </div>

          {preview ? (
            <p className="mb-3 text-xs leading-5 text-neutral-700">{preview}</p>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleJump}
              className="rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-2.5 py-1.5 text-[11px] text-neutral-800 transition hover:bg-neutral-950/10"
            >
              Jump to source
            </button>

            {citation.directLink ? (
              <a
                href={citation.directLink}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl border border-neutral-950/15 bg-neutral-950/[0.06] px-2.5 py-1.5 text-[11px] text-neutral-900 transition hover:bg-neutral-950/12"
              >
                Open link
              </a>
            ) : null}
          </div>
        </div>
      )}
    </span>
  );
}