// app/api/local-rag-regenerate-report/route.ts
//
// Proxies to local-rag/service.py's POST /documents/{doc_id}/regenerate-
// report - the Report tab's own "refresh the PDF" step, called once right
// after a successful /api/local-rag-choose-patch against a reportDocId
// (never a source doc_id - choose-patch itself stays completely generic/
// unaware of report vs. source documents, see local-rag-choose-patch/
// route.ts's own header comment). Added 2026-09-25, Report-tab correction
// to the inline-editing milestone: "the report/PDF is refreshed... after
// the user accepts an alternative."
//
// Deliberately its own route, same "no shared mega-file" convention as
// every other proxy route here - see local-rag-chat/route.ts's header
// comment.
//
// Requires local-rag/service.py running separately.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const reportDocId = (body?.reportDocId ?? "").toString().trim();
  if (!reportDocId) {
    return NextResponse.json(
      { success: false, error: "Missing 'reportDocId'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(reportDocId)}/regenerate-report`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // WeasyPrint re-render of the full report (same cost as the
        // original /proposal-review's own PDF step, just without the
        // retrieval/model calls around it) - generous but well under
        // propose-edit's 180s.
        signal: AbortSignal.timeout(60_000),
      }
    );
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
        html_url: data.report_files.html_url
          ? `${LOCAL_RAG_URL}${data.report_files.html_url}`
          : undefined,
      }
    : undefined;

  return NextResponse.json(
    { success: true, reportFiles, version: data.version, assessment: data.assessment },
    { status: 200 }
  );
}
