"use client";

import React, { useEffect, useMemo, useState } from "react";
import ExpandableCitation, {
  getConfidenceTier,
} from "@/components/citations/ExpandableCitation";

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

interface SourcesSectionProps {
  sources?: Citation[];
  // The user's question these sources are evidence for - passed through
  // to ExpandableCitation purely so it can highlight matching terms in
  // the excerpt text.
  queryText?: string;
}

function normalizeSource(citation: Citation): Citation {
  return {
    ...citation,
    title: citation.title || "Untitled source",
    type: citation.type || "Source",
    fullText: citation.fullText || "",
    excerpt: citation.excerpt || "",
    confidence: Number.isFinite(Number(citation.confidence))
      ? Number(citation.confidence)
      : 0,
    lastUpdated: citation.lastUpdated || "",
  };
}

export default function SourcesSection({
  sources = [],
  queryText,
}: SourcesSectionProps) {
  const safeSources = useMemo(() => {
    if (!Array.isArray(sources)) return [];
    return sources
      .filter(Boolean)
      .map((source) => normalizeSource(source))
      .filter((source) => source.id !== undefined && source.id !== null);
  }, [sources]);

  const sortedSources = useMemo(() => {
    return [...safeSources].sort(
      (a, b) => Number(b.confidence || 0) - Number(a.confidence || 0)
    );
  }, [safeSources]);

  const tierCounts = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0 };
    for (const source of sortedSources) {
      counts[getConfidenceTier(Number(source.confidence || 0))] += 1;
    }
    return counts;
  }, [sortedSources]);

  const [expandedId, setExpandedId] = useState<string | number | null>(
    sortedSources[0]?.id ?? null
  );
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!sortedSources.length) {
      setExpandedId(null);
      return;
    }

    const currentStillExists = sortedSources.some(
      (source) => source.id === expandedId
    );

    if (!currentStillExists) {
      setExpandedId(sortedSources[0].id);
    }
  }, [sortedSources, expandedId]);

  if (!sortedSources.length) return null;

  const visibleSources = showAll ? sortedSources : sortedSources.slice(0, 5);

  return (
    <div className="mt-4 rounded-3xl border border-neutral-950/10 bg-neutral-950/[0.04] p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-neutral-950">
            Sources ({sortedSources.length})
          </p>
          <p className="text-xs text-neutral-600">
            Ranked by confidence. Click a source to inspect the evidence.
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-600">
            {tierCounts.high ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-neutral-950" />
                {tierCounts.high} high
              </span>
            ) : null}
            {tierCounts.medium ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
                {tierCounts.medium} medium
              </span>
            ) : null}
            {tierCounts.low ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
                {tierCounts.low} low
              </span>
            ) : null}
          </div>
        </div>

        {sortedSources.length > 5 ? (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="shrink-0 rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-1.5 text-[11px] text-neutral-800 transition hover:border-neutral-950/20 hover:bg-neutral-950/10"
          >
            {showAll ? "Show top 5" : `Show all (${sortedSources.length})`}
          </button>
        ) : null}
      </div>

      <div className="space-y-2.5">
        {visibleSources.map((citation, index) => (
          <div id={`citation-card-${citation.id}`} key={String(citation.id)}>
            <ExpandableCitation
              citation={citation}
              index={index}
              expanded={expandedId === citation.id}
              queryText={queryText}
              onToggle={() =>
                setExpandedId((prev) => (prev === citation.id ? null : citation.id))
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}