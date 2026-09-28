// app/api/local-rag-proposal-review/route.ts
//
// Proxies a proposal-review request (file upload(s) + optional site) to
// local-rag/service.py's /proposal-review - the same offline FastAPI
// service app/api/local-rag-chat/route.ts already proxies to, see that
// route's own header comment for the "why a separate thin route" answer
// (urban-ai-architecture-plan.md section 4.4). Added 2026-09-19 to wire
// the real "run a compliance review" action in ChatInterface.tsx's
// upload flow, replacing the temporary hardcoded sample-file test button.
//
// Multipart in, JSON out (mostly a passthrough of the upstream response -
// see service.py's /proposal-review docstring for the full shape:
// geography, constraint_summary, assessment{summary,issues,checklist},
// evidence_citations, report_files{pdf_url,markdown_url,...}). The one
// thing this route adds is making report_files' *_url paths absolute
// against LOCAL_RAG_URL, same reasoning as local-rag-chat's
// transformMapCitations() - the browser renders this page from Next.js's
// own origin, not local-rag's, so a relative "/reports/xxx.pdf" would
// 404 against the wrong origin. It also folds document_names back in
// (the upstream response doesn't carry them - see service.py) from the
// files this route already has in hand, so the client can reuse them
// as review-chat context without a second round trip.
//
// Requires local-rag/service.py running separately - see local-rag-chat/
// route.ts's header comment for the exact command.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

export async function POST(req: Request) {
  let incoming: FormData;
  try {
    incoming = await req.formData();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid form data" },
      { status: 400 }
    );
  }

  const files = incoming
    .getAll("files")
    .filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { success: false, error: "No file(s) attached" },
      { status: 400 }
    );
  }

  const upstreamBody = new FormData();
  for (const file of files) upstreamBody.append("files", file, file.name);
  const postcode = incoming.get("postcode");
  if (typeof postcode === "string" && postcode.trim()) {
    upstreamBody.append("postcode", postcode.trim());
  }
  const projectId = incoming.get("project_id");
  if (typeof projectId === "string" && projectId.trim()) {
    upstreamBody.append("project_id", projectId.trim());
  }
  // 2026-09-25: "ollama" opt-in (default "groq", unchanged) - matches
  // local-rag-chat/route.ts and local-rag-edit-clause/route.ts's existing
  // body.backend pattern, now covering compliance reviews too.
  const backend = incoming.get("backend");
  upstreamBody.append(
    "backend",
    typeof backend === "string" && backend === "ollama" ? "ollama" : "groq"
  );

  let upstream: Response;
  try {
    upstream = await fetch(`${LOCAL_RAG_URL}/proposal-review`, {
      method: "POST",
      body: upstreamBody,
      // Review runs full-document retrieval plus a model call per topic -
      // much slower than a single chat query, so this gets a longer
      // budget than local-rag-chat's 60s.
      //
      // 2026-09-25: 180s was NOT enough under the "Fully local" (Ollama)
      // path and this is what the user hit live - the review looked like
      // it "started then stopped" (twice). Root cause, confirmed from
      // both sides of the same request: local-rag's own service.py log
      // shows the review actually SUCCEEDED - "backend=ollama issues=5
      // total_ms=227661" and, on the retry, "issues=12 total_ms=185657"
      // (227.7s and 185.7s) - while the Next.js dev server log for the
      // exact same two requests shows "POST /api/local-rag-proposal-
      // review 503 in 180193ms" and "503 in 180049ms" - this proxy's own
      // AbortSignal firing at ~180s and returning a 503 to the browser
      // BEFORE the backend's real response ever arrived. So the backend
      // was never actually failing; this timeout was simply shorter than
      // real Ollama-backed review latency on this hardware. Each of the
      // up to ~10 STANDARD_TOPICS below that matches the document gets
      // its own sequential Ollama call (chunk review) plus a merge/
      // verify/summary pass and inter-call pacing sleeps, so a document
      // that matches more topics than the 5 measured above would take
      // even longer. Raised to 600s - comfortable headroom over the
      // 227.7s worst case actually observed, not just barely above it
      // (the mistake with the old 180s value).
      signal: AbortSignal.timeout(600_000),
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error:
          "Couldn't reach the local RAG service on " +
          LOCAL_RAG_URL +
          ". Is it running? Start it with: cd local-rag && source venv/bin/activate " +
          "&& uvicorn service:app --port 8010",
      },
      { status: 503 }
    );
  }

  const data = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    // 2026-09-28: log the REAL backend status + body server-side (shows up
    // in this dev server's own terminal, not just the browser's Network
    // tab) - added after a live report of "502 in the terminal, repeatedly"
    // with no visibility into what local-rag actually said. Previously this
    // block also collapsed EVERY upstream status (400, 422, 500, ...) into a
    // flat 502 - technically not wrong (this route genuinely failed to get a
    // good response from its upstream), but it threw away a real signal: a
    // 400 means the backend rejected the request/input, a 500 means it broke
    // internally - now passed through as-is so the browser, and anyone
    // reading a screenshot of the Network tab, sees the real status.
    console.error(
      `[local-rag-proposal-review] upstream ${upstream.status} from ${LOCAL_RAG_URL}/proposal-review - ` +
        `files=${files.map((f) => f.name).join(", ")} postcode=${postcode || "(none)"} ` +
        `project_id=${projectId || "(none)"} backend=${upstreamBody.get("backend")} - ` +
        `body: ${JSON.stringify(data)}`
    );
    return NextResponse.json(
      {
        success: false,
        error: data?.detail || `Local RAG service returned ${upstream.status}`,
      },
      { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 }
    );
  }

  const reportFiles = data?.report_files
    ? {
        ...data.report_files,
        pdf_url: data.report_files.pdf_url
          ? `${LOCAL_RAG_URL}${data.report_files.pdf_url}`
          : undefined,
        markdown_url: data.report_files.markdown_url
          ? `${LOCAL_RAG_URL}${data.report_files.markdown_url}`
          : undefined,
        // Live animated report view (report_render.py's render_html(...,
        // animate=True), see build_reports()) - same origin-absolutizing
        // as pdf_url/markdown_url above, same reason.
        html_url: data.report_files.html_url
          ? `${LOCAL_RAG_URL}${data.report_files.html_url}`
          : undefined,
      }
    : undefined;

  // Persisted originals (original PDF + paragraph-split text) - see
  // local-rag/document_edit.py's own module docstring. Added
  // 2026-09-23 for live in-place clause editing: absolutized the same
  // way reportFiles' *_url fields are, just below, since these are
  // served from local-rag's own /documents mount, not this app's
  // origin.
  const documents = Array.isArray(data?.documents)
    ? data.documents.map((d: any) => ({
        docId: d.doc_id,
        filename: d.filename,
        // Points at the regenerated current.pdf (see document_edit.py's
        // save_document(), 2026-09-23 update) - this is now the one and
        // only document view DocumentPanel opens with, already
        // versioned (?v=1) so a later edit's own version bump reliably
        // busts the cache.
        url: d.url ? `${LOCAL_RAG_URL}${d.url}` : undefined,
        paragraphCount: d.paragraph_count,
        version: d.version,
      }))
    : [];

  // reportDocId/reportBlocks (2026-09-25, Report-tab correction to the
  // inline-editing milestone): the AI-GENERATED report's own editable
  // identity - completely separate from `documents` above, which is the
  // uploaded SOURCE proposal (stays read-only reference). null/[] when
  // local-rag couldn't persist the report's blocks that time (best-effort
  // on the backend - see service.py's own comment) - the frontend just
  // can't offer Report-tab editing for that review, same degrade-not-break
  // contract as `documents`.
  const reportDocId = typeof data?.report_doc_id === "string" ? data.report_doc_id : null;
  const reportBlocks = Array.isArray(data?.report_blocks)
    ? data.report_blocks.map((b: any) => ({
        localId: b.localId,
        kind: b.kind,
        index: b.index,
      }))
    : [];

  return NextResponse.json(
    {
      success: true,
      review: {
        geography: data.geography,
        constraint_summary: data.constraint_summary,
        topics_checked: data.topics_checked,
        topics_failed: data.topics_failed,
        evidence_citations: data.evidence_citations,
        assessment: data.assessment,
        assessment_failed: data.assessment_failed,
        parse_error: data.parse_error,
        disclaimer: data.disclaimer,
        document_names: files.map((f) => f.name),
      },
      reportFiles,
      reportDocId,
      reportBlocks,
      pagesNotAssessed: data.pages_not_assessed,
      documents,
      totalMs: data.total_ms,
    },
    { status: 200 }
  );
}
