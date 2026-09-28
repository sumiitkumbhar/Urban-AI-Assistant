// app/api/local-rag-revert-block/route.ts
//
// Proxies to local-rag/service.py's POST /documents/{doc_id}/blocks/
// {local_id}/revert - undo an already-applied edit by writing a NEW
// revision equal to an older one's text (never deletes/rewrites history).
// Added 2026-09-25 (architecture plan section 53, Phase 2/5) per the
// product owner's explicit "patch just that block, allow undo" brief.
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
  const localId = Number(body?.localId);
  const toRevisionId = (body?.toRevisionId ?? "").toString().trim();
  const expectedDocVersion = Number(body?.expectedDocVersion);

  if (!docId || !Number.isInteger(localId)) {
    return NextResponse.json(
      { success: false, error: "Missing 'docId' or 'localId'" },
      { status: 400 }
    );
  }
  if (!toRevisionId || !Number.isInteger(expectedDocVersion)) {
    return NextResponse.json(
      { success: false, error: "Missing 'toRevisionId' or 'expectedDocVersion'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}/blocks/${localId}/revert`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_revision_id: toRevisionId,
          expected_doc_version: expectedDocVersion,
        }),
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
      paragraphId: data.paragraph_id,
      version: data.version,
      revisionId: data.revision_id,
      previousRevisionId: data.previous_revision_id,
      pdfUrl: data.pdf_url ? `${LOCAL_RAG_URL}${data.pdf_url}` : undefined,
      pdfRegenerated: data.pdf_regenerated,
    },
    { status: 200 }
  );
}
