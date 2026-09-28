// app/api/local-rag-propose-edit/route.ts
//
// Proxies to local-rag/service.py's POST /documents/{doc_id}/propose-edit -
// the real "propose" half of the alternatives-before-replace workflow
// (architecture plan section 53, Phase 2; local-rag-edit-clause/route.ts's
// own header comment covers the older one-shot /edit-clause path this is
// additive to, not a replacement for). Added 2026-09-25 per the product
// owner's detailed voice brief: "before any block changes, the system must
// generate three distinct rephrased alternatives... and let the user pick
// one, never silently replacing anything."
//
// Deliberately its own route, same "no shared mega-file" convention as
// every other proxy route here - see local-rag-chat/route.ts's header
// comment.
//
// Requires local-rag/service.py running separately.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

// Same transformCitations() shape as local-rag-edit-clause/route.ts's own
// copy - kept independent rather than shared, matching this app's
// established per-route convention.
interface LocalRagCitation {
  id: number;
  doc: string;
  page: number;
  domain: string;
  geography?: string;
  rerank_score: number;
}

function transformCitations(citations: LocalRagCitation[] | undefined) {
  return (citations || []).map((c) => ({
    id: `D${c.id}`,
    title: c.doc,
    type: "document",
    sourceType: "document",
    pageNumber: c.page,
    clauseNumber: undefined,
    section: c.domain,
    fullText: undefined,
    excerpt: undefined,
    confidence: Math.round(Math.max(0, Math.min(1, c.rerank_score ?? 0)) * 100),
    lastUpdated: undefined,
    directLink: undefined,
    sourceLabel: `${c.doc}${c.page ? `, p.${c.page}` : ""}`,
    _raw: c,
  }));
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const docId = (body?.docId ?? body?.doc_id ?? "").toString().trim();
  const instruction = (body?.instruction ?? "").toString().trim();
  if (!docId) {
    return NextResponse.json(
      { success: false, error: "Missing 'docId'" },
      { status: 400 }
    );
  }
  if (!instruction) {
    return NextResponse.json(
      { success: false, error: "Missing 'instruction'" },
      { status: 400 }
    );
  }

  const backend = body?.backend === "ollama" ? "ollama" : "groq";
  // issues: the active review's own merged issue list (frontend's
  // activeReview.review.issues, unchanged shape) - lets the backend match
  // "rewrite the fire safety clause" against the actual compliance issue
  // it's about, for better paragraph targeting. Optional - omit/empty is
  // fine, same as edit-clause today.
  const issues = Array.isArray(body?.issues) ? body.issues : undefined;
  // targetLocalId/selectedText (2026-09-25, inline-block-editing
  // milestone): set only by the NEW selection-driven path (the
  // interactive document view already knows exactly which block was
  // selected, so it says so instead of letting the backend re-guess it
  // from the instruction text - see document_edit.propose_edit()'s own
  // docstring for the full split). Both undefined on the original
  // chat-driven path - completely unchanged behavior there.
  const targetLocalId =
    typeof body?.targetLocalId === "number" ? body.targetLocalId : undefined;
  const selectedText =
    typeof body?.selectedText === "string" ? body.selectedText : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}/propose-edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          geography: body.geography ?? undefined,
          backend,
          issues,
          mode: "edit",
          target_local_id: targetLocalId,
          selected_text: selectedText,
        }),
        // Generates THREE alternatives in one model call instead of one -
        // same order-of-magnitude budget as local-rag-edit-clause's own
        // 150s (see that route's comment for the measured Ollama-latency
        // reasoning this mirrors), with headroom for the larger response.
        signal: AbortSignal.timeout(180_000),
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
      page: data.page,
      bbox: data.bbox,
      originalText: data.original_text,
      matchedIssue: data.matched_issue
        ? { topic: data.matched_issue.topic, issue: data.matched_issue.issue }
        : null,
      alternatives: (data.alternatives || []).map((a: any) => ({
        index: a.index,
        label: a.label,
        text: a.text,
        rationale: a.rationale,
      })),
      // is_exact_replacement (2026-09-25): true only when propose_edit()
      // recognized a narrow, unambiguous `replace "X" with "Y"`
      // instruction and built a single literal-substitution alternative
      // instead of the usual three AI rewrites - the frontend uses this
      // to show a plain apply/cancel preview instead of a 3-way choice.
      isExactReplacement: Boolean(data.is_exact_replacement),
      citations: transformCitations(data.citations),
      citedIds: data.cited_ids,
      confidenceLabel: data?.coverage?.confidence,
      baseDocVersion: data.base_doc_version,
      processingTime: Date.now() - startedAt,
    },
    { status: 200 }
  );
}
