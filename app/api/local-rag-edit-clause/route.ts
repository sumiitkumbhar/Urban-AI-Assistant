// app/api/local-rag-edit-clause/route.ts
//
// Proxies a live clause-edit instruction to local-rag/service.py's
// POST /documents/{doc_id}/edit-clause - see local-rag/document_edit.py's
// module docstring for the full feature: type "paragraph 4 needs to
// mention cycle parking" (or describe the clause without a number) into
// the chat while a document is open in DocumentPanel, and get back a
// rewrite of ONLY that one paragraph, grounded against the policy corpus
// the same way every other answer in this app is. Added 2026-09-23.
//
// Deliberately its own route rather than a branch inside
// local-rag-proposal-review-chat/route.ts - that route answers QUESTIONS
// about a review (read-only); this one performs a WRITE against a
// specific persisted document, a different enough operation to keep
// separate (same "no shared mega-file" reasoning as every other proxy
// route here - see local-rag-chat/route.ts's own header comment).
//
// Requires local-rag/service.py running separately - see local-rag-chat/
// route.ts's header comment for the exact command.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

// Same shape/transform as local-rag-proposal-review-chat/route.ts's own
// transformCitations() - kept as its own small copy rather than a shared
// import, matching this app's "no shared mega-file, each proxy route
// stays independently readable" convention (see that route's header
// comment) - so ChatInterface.tsx's existing citation renderer
// (mapBackendCitations, expecting {id, title, pageNumber, ...}) can show
// what grounded this edit exactly the same way it shows citations for a
// normal answer.
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

  // Same "groq" default / "ollama" opt-in choice already wired into
  // local-rag-chat/route.ts and local-rag-chat/stream/route.ts (2026-09-24,
  // see local-rag-status.md) - added here too (step 3 of the interactive-
  // document-editing plan) so a document edit can run fully local as well,
  // not just the main chat answer.
  const backend = body?.backend === "ollama" ? "ollama" : "groq";

  let upstream: Response;
  try {
    upstream = await fetch(
      `${LOCAL_RAG_URL}/documents/${encodeURIComponent(docId)}/edit-clause`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          geography: body.geography ?? undefined,
          backend,
        }),
        // 2026-09-25: was 60s (local-rag-chat's budget, "one retrieval
        // + one Groq call, same rough shape as a normal chat query") -
        // true for Groq, but live-tested wrong for the Ollama backend:
        // a single-paragraph rewrite through deepseek-r1:7b (a reasoning
        // model - see answer.py's num_ctx comment) measured up to ~69s
        // on this hardware even for a short instruction, and a real user
        // request against a longer/denser paragraph blew past 60s here,
        // got aborted client-side, and returned a confusing 503 while
        // local-rag was very possibly still working on it server-side
        // (nothing to cancel an in-flight requests.post to Ollama once
        // this fetch gives up). Bumped to the same order of magnitude as
        // /api/local-rag-proposal-review's own 180s Ollama-aware budget -
        // slightly less since this is one paragraph, not a multi-topic
        // review.
        signal: AbortSignal.timeout(150_000),
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
      page: data.page,
      originalText: data.original_text,
      revisedText: data.revised_text,
      rationale: data.rationale,
      citations: transformCitations(data.citations),
      citedIds: data.cited_ids,
      confidenceLabel: data?.coverage?.confidence,
      // The regenerated document PDF (2026-09-23, second pass) - the one
      // view DocumentPanel now shows always points here, so this edit
      // needs to hand back a fresh URL for the panel to reload. version
      // is already baked into pdfUrl as a cache-buster query param.
      pdfUrl: data.pdf_url ? `${LOCAL_RAG_URL}${data.pdf_url}` : undefined,
      version: data.version,
      pdfRegenerated: data.pdf_regenerated,
      processingTime: Date.now() - startedAt,
    },
    { status: 200 }
  );
}
