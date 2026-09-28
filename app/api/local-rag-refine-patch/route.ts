// app/api/local-rag-refine-patch/route.ts
//
// Proxies to local-rag/service.py's POST /documents/{doc_id}/patches/
// {patch_id}/refine - the "Custom" refinement box added under the three
// alternatives (2026-09-26 six-area polish pass). NOT a fourth
// independent blank replacement: takes the patch's own already-
// generated alternatives plus a refinement instruction ("go with option
// 2", "use option 2 but shorter", "combine options 1 and 3"...) and
// returns ONE more alternative appended to the same still-open patch.
// Writes nothing to blocks/block_revisions - applying the result still
// goes through local-rag-choose-patch/route.ts unchanged, same as
// choosing option 1/2/3, so validation/undo/PDF-refresh all stay
// identical for a refined result.
//
// Same per-route pattern as every other proxy route here (own file, own
// error handling, own timeout) - see local-rag-propose-edit/route.ts's
// header comment.
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
  const instruction = (body?.instruction ?? "").toString().trim();
  const backend = (body?.backend ?? "groq").toString().trim() || "groq";

  if (!docId || !patchId) {
    return NextResponse.json(
      { success: false, error: "Missing 'docId' or 'patchId'" },
      { status: 400 }
    );
  }
  if (!instruction) {
    return NextResponse.json(
      { success: false, error: "Missing 'instruction'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}/patches/${encodeURIComponent(patchId)}/refine`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, backend }),
        // One model call generating one alternative - same budget class
        // as choose-patch (well under propose-edit's 180s, since this is
        // a single rewrite, not three).
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

  return NextResponse.json(
    {
      success: true,
      docId: data.doc_id,
      patchId: data.patch_id,
      index: data.index,
      label: data.label,
      text: data.text,
      rationale: data.rationale,
      citations: data.citations || [],
    },
    { status: 200 }
  );
}
