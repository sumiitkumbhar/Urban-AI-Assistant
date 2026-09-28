// app/api/local-rag-document/route.ts
//
// Proxies GET local-rag/service.py's /documents/{doc_id} - the current
// paragraphs (after any edits already applied) of a proposal document
// persisted by /proposal-review (see local-rag/document_edit.py's own
// module docstring for the whole feature: live, in-place clause editing
// via chat). Added 2026-09-23. Used by ChatInterface.tsx to load a
// document's editable text once DocumentPanel opens (the /proposal-review
// response itself only carries a paragraph_count, not the full text - see
// that route's own comment for why), and to reload it if needed.
//
// Query param instead of a dynamic route segment ([docId]) to match every
// other proxy route in this app - none of them use dynamic segments (see
// local-rag-chat/route.ts's own header comment on why each backend call
// gets its own small, flat route file).
//
// Requires local-rag/service.py running separately - see local-rag-chat/
// route.ts's header comment for the exact command.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const docId = (searchParams.get("doc_id") || "").trim();
  if (!docId) {
    return NextResponse.json(
      { success: false, error: "Missing 'doc_id'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}`,
      { signal: AbortSignal.timeout(30_000) }
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
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  return NextResponse.json(
    {
      success: true,
      docId: data.doc_id,
      paragraphs: data.paragraphs || [],
      meta: data.meta || {},
      // The one real PDF DocumentPanel now shows (added 2026-09-23,
      // second pass - see document_edit.py's module docstring: the
      // panel used to have 3 views, now it's always this one PDF,
      // regenerated from paragraphs.json on every edit). version is the
      // cache-buster query param baked into pdfUrl already, surfaced
      // separately too in case the caller wants to compare it later.
      pdfUrl: data.pdf_url ? `${LOCAL_RAG_URL}${data.pdf_url}` : undefined,
      version: data.version,
    },
    { status: 200 }
  );
}
