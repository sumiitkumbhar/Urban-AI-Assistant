// app/api/local-rag-reject-patch/route.ts
//
// Proxies to local-rag/service.py's POST /documents/{doc_id}/patches/
// {patch_id}/reject - "keep the original wording". Writes nothing to the
// live document; see local-rag-propose-edit/route.ts's header comment for
// the rest of the propose/choose/reject workflow. Added 2026-09-25
// (architecture plan section 53, Phase 2).
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
  if (!docId || !patchId) {
    return NextResponse.json(
      { success: false, error: "Missing 'docId' or 'patchId'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}/patches/${encodeURIComponent(patchId)}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
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
    { success: true, docId: data.doc_id, patchId: data.patch_id, status: data.status },
    { status: 200 }
  );
}
