"use client";

// components/chat/DocumentPanel.tsx
//
// A Claude-artifact-style side panel for previewing a generated document
// (right now: the proposal-review PDF report_render.py builds - see
// local-rag/report_render.py and service.py's /proposal-review endpoint's
// report_files.pdf_url) next to the chat, with a page-by-page PDF preview
// and a download action, instead of the file only existing as a path on
// disk. Added 2026-09-19 per explicit request: "I want this exact similar
// format of UI where the user can open the pdfs documents that are
// generated in the side and he/she will get option to download."
//
// Deliberately generic (url/filename props, not proposal-review-specific)
// so it can preview any PDF the app generates later, not just compliance
// reports. Deliberately built and verified in isolation first (see the
// temporary "Preview sample report" trigger in ChatInterface.tsx) before
// wiring a real upload-for-review flow into the chat - that's the next
// step once this panel's look/feel is confirmed.
//
// react-pdf + pdfjs-dist were already project dependencies (package.json)
// but unused anywhere until this component - first real usage.

import { useEffect, useRef, useState, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

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
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const DownloadIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

const ExpandIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m11-5v3a2 2 0 0 0-2 2h-3" />
  </svg>
);

const CollapseIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M9 3v4a2 2 0 0 1-2 2H3m18 0h-4a2 2 0 0 1-2-2V3M3 15h4a2 2 0 0 1 2 2v4m10-4v4a2 2 0 0 1-2 2h-4" />
  </svg>
);

const FileIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

export interface DocumentPanelProps {
  /** Absolute URL the browser can fetch the file from directly. */
  url: string;
  /** Display name, e.g. "westminster-2026-09-19.pdf". */
  filename: string;
  onClose: () => void;
}

// "westminster-2026-09-19" -> "Westminster 2026 09 19" - a light title-case
// pass so the panel header doesn't just show a raw slug.
function humanizeTitle(filename: string): string {
  const base = filename.replace(/\.[^./]+$/, "");
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
    .join(" ");
}

export default function DocumentPanel({ url, filename, onClose }: DocumentPanelProps) {
  const [mounted, setMounted] = useState(false);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageWidth, setPageWidth] = useState(600);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // react-pdf/pdfjs touch canvas/DOMMatrix APIs that don't exist during
  // Next.js's server render - only render the actual PDF once mounted in
  // the browser.
  useEffect(() => setMounted(true), []);

  // Size pages to the available panel width rather than a fixed px value,
  // so the panel stays usable both docked (~narrower) and expanded
  // (~fullscreen).
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
  // click.
  useEffect(() => {
    if (!mounted || !numPages || !scrollRef.current) return;
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
  }, [mounted, numPages]);

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

  return (
    <div
      className={
        "flex h-full min-w-0 flex-col border-l border-neutral-950/10 bg-white/60 backdrop-blur-sm transition-[width] duration-200 " +
        (isExpanded ? "w-full" : "w-full max-w-3xl")
      }
    >
      {/* Header - title/type on the left, download + expand + close on the right,
          matching this app's existing rounded/neutral chrome (see DiagramDisplay). */}
      <div className="flex items-center justify-between gap-3 border-b border-neutral-950/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-950/5 text-neutral-600">
            <FileIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-neutral-900">
              {humanizeTitle(filename)}
            </p>
            <p className="text-[11px] text-neutral-500">
              {filename.split(".").pop()?.toUpperCase() || "FILE"}
              {numPages ? ` · ${numPages} page${numPages === 1 ? "" : "s"}` : ""}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={handleDownload}
            disabled={isDownloading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-1.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-950/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            {isDownloading ? "Preparing..." : "Download"}
          </button>
          <button
            type="button"
            onClick={() => setIsExpanded((v) => !v)}
            aria-label={isExpanded ? "Collapse panel" : "Expand panel"}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-neutral-600 transition hover:bg-neutral-950/10"
          >
            {isExpanded ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="flex h-8 w-8 items-center justify-center rounded-xl text-neutral-600 transition hover:bg-neutral-950/10"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div ref={measureRef} className="relative flex-1 overflow-hidden bg-neutral-100">
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

        {/* Page indicator + prev/next, floating bottom-right like the
            reference layout - only shown once we actually know the page count. */}
        {numPages ? (
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
  );
}
