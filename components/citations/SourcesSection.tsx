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

  // Independent per-citation expand/collapse: each card owns its own
  // open/closed state via Set membership, instead of a single nullable id
  // that forced accordion behaviour (opening one closed another). Starts
  // empty - nothing is auto-expanded when citations arrive.
  const [expandedIds, setExpandedIds] = useState<Set<string | number>>(
    () => new Set()
  );
  const [showAll, setShowAll] = useState(false);

  // Prune ids that no longer correspond to a source (e.g. citations were
  // replaced on a re-answer). Never force anything open - whatever the
  // user had expanded stays expanded, whatever was collapsed stays
  // collapsed.
  useEffect(() => {
    setExpandedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(sortedSources.map((source) => source.id));
      let changed = false;
      const next = new Set<string | number>();
      prev.forEach((id) => {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [sortedSources]);

  if (!sortedSources.length) return null;

  const visibleSources = showAll ? sortedSources : sortedSources.slice(0, 5);

  // 2026-09-29: glass token pass. glass-soft (this app's lightest glass
  // tier, for nested/supporting surfaces). 2026-09-29 unification pass:
  // no separate tint class any more - `.glass` itself carries the one
  // app-wide tint, so this container automatically matches the surrounding
  // sits flat inside it, not floating) - replaces the old flat
  // border-neutral-950/10 bg-neutral-950/[0.04] combo. See
  // app/globals.css's "GLASS SYSTEM" block for the shared recipe.
  // Expand/collapse state and logic below are untouched - surface-only
  // change.
  return (
    <div className="glass glass-soft mt-4 rounded-3xl p-4">
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
              expanded={expandedIds.has(citation.id)}
              queryText={queryText}
              onToggle={() =>
                setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(citation.id)) {
                    next.delete(citation.id);
                  } else {
                    next.add(citation.id);
                  }
                  return next;
                })
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}