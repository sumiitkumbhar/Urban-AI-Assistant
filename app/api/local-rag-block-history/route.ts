// app/api/local-rag-block-history/route.ts
//
// Proxies GET local-rag/service.py's /documents/{doc_id}/blocks/
// {local_id}/history - the full, immutable, oldest-first revision list
// for one block. Built in Phase 2 (see document_store.get_block_history()
// and service.py's block_history_route()) but never wired to the
// frontend until now. Added 2026-09-26, six-area Report-tab polish pass:
// this is what makes Undo persistent and real (a pointer walked over
// actually-stored revisions) instead of timeout-bound - see
// ChatInterface.tsx's reportUndoStacks/reportUndoPointer state, which
// calls this after every apply/undo for the edited block, then targets
// local-rag-revert-block/route.ts with the exact revision_id at the new
// pointer position. Never reconstructs text - only reads what's already
// stored.
//
// Generic over doc_id (works for a report pseudo-document OR a real
// source document, same as every other block-level route in this app) -
// query params instead of a dynamic route segment, matching every other
// proxy route here (see local-rag-document/route.ts's own comment).
//
// Requires local-rag/service.py running separately.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const docId = (searchParams.get("doc_id") || "").trim();
  const localId = Number(searchParams.get("local_id"));

  if (!docId || !Number.isInteger(localId)) {
    return NextResponse.json(
      { success: false, error: "Missing 'doc_id' or 'local_id'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}/blocks/${localId}/history`,
      { signal: AbortSignal.timeout(15_000) }
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
      localId: data.local_id,
      // Oldest -> newest, exactly as document_store.get_block_history()
      // returns it (ORDER BY created_at). Each entry carries at least
      // revision_id/text/created_at/created_by - the frontend only reads
      // revision_id, so it's passed through unshaped rather than
      // re-declaring every column name here.
      history: data.history || [],
    },
    { status: 200 }
  );
}
