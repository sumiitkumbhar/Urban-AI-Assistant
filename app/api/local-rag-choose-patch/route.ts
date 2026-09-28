// app/api/local-rag-choose-patch/route.ts
//
// Proxies to local-rag/service.py's POST /documents/{doc_id}/patches/
// {patch_id}/choose - applies one of the three alternatives a prior
// /api/local-rag-propose-edit call generated. This is the ONLY point in
// the propose/choose/reject flow that actually changes the live document -
// see local-rag-propose-edit/route.ts's header comment for the rest of
// the workflow. Added 2026-09-25 (architecture plan section 53, Phase 2).
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

  const docId = (body?.docId ?? "").toString().trim();
  const patchId = (body?.patchId ?? "").toString().trim();
  const alternativeIndex = Number(body?.alternativeIndex);
  const expectedDocVersion = Number(body?.expectedDocVersion);

  if (!docId || !patchId) {
    return NextResponse.json(
      { success: false, error: "Missing 'docId' or 'patchId'" },
      { status: 400 }
    );
  }
  if (!Number.isInteger(alternativeIndex) || !Number.isInteger(expectedDocVersion)) {
    return NextResponse.json(
      { success: false, error: "Missing/invalid 'alternativeIndex' or 'expectedDocVersion'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}/patches/${encodeURIComponent(patchId)}/choose`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alternative_index: alternativeIndex,
          expected_doc_version: expectedDocVersion,
        }),
        // Fast path - no model call here, just the patch validator + a
        // PDF regenerate (PyMuPDF, local, sub-second to a few seconds
        // even for a dense page). A generous but much smaller budget
        // than propose-edit's own 180s.
        signal: AbortSignal.timeout(30_000),
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

  return NextResponse.json(
    {
      success: true,
      docId: data.doc_id,
      patchId: data.patch_id,
      paragraphId: data.paragraph_id,
      version: data.version,
      revisionId: data.revision_id,
      previousRevisionId: data.previous_revision_id,
      alreadyApplied: data.already_applied,
      pdfUrl: data.pdf_url ? `${LOCAL_RAG_URL}${data.pdf_url}` : undefined,
      pdfRegenerated: data.pdf_regenerated,
    },
    { status: 200 }
  );
}
