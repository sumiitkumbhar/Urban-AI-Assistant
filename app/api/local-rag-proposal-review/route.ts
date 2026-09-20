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

  let upstream: Response;
  try {
    upstream = await fetch(`${LOCAL_RAG_URL}/proposal-review`, {
      method: "POST",
      body: upstreamBody,
      // Review runs full-document retrieval plus a model call per topic -
      // much slower than a single chat query, so this gets a longer
      // budget than local-rag-chat's 60s.
      signal: AbortSignal.timeout(180_000),
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
    return NextResponse.json(
      {
        success: false,
        error: data?.detail || `Local RAG service returned ${upstream.status}`,
      },
      { status: 502 }
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
      }
    : undefined;

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
      pagesNotAssessed: data.pages_not_assessed,
      totalMs: data.total_ms,
    },
    { status: 200 }
  );
}
