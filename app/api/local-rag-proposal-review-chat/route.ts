// app/api/local-rag-proposal-review-chat/route.ts
//
// Proxies a follow-up chat question (after a proposal review) to
// local-rag/service.py's /proposal-review-chat - a normal /query-style
// call with the review's own findings folded into the prompt as extra
// context (see proposal_review.build_review_context_text()'s docstring
// for why this isn't a separate retrieval path). Response is normalized
// into the exact same shape local-rag-chat/route.ts already produces for
// a plain local query, so ChatInterface.tsx's existing local-rag
// response handling in handleSend renders it identically - see that
// route's own header comment for the full field-by-field reasoning; this
// route duplicates the small transformCitations() piece rather than
// importing it, to keep each proxy route independently readable
// (urban-ai-architecture-plan.md section 4.4: no shared mega-file).
//
// Requires local-rag/service.py running separately - see local-rag-chat/
// route.ts's header comment for the exact command.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

const CONFIDENCE_SCORE: Record<string, number> = {
  high: 90,
  medium: 60,
  low: 30,
};

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

  const question = (body?.question ?? "").toString().trim();
  if (!question) {
    return NextResponse.json(
      { success: false, error: "Missing 'question'" },
      { status: 400 }
    );
  }
  if (!body?.review || typeof body.review !== "object") {
    return NextResponse.json(
      { success: false, error: "Missing 'review' context" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${LOCAL_RAG_URL}/proposal-review-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        review: body.review,
        project_id: body.project_id ?? undefined,
      }),
      signal: AbortSignal.timeout(60_000),
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

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        success: false,
        error: `Local RAG service returned ${upstream.status}: ${text.slice(0, 500)}`,
      },
      { status: 502 }
    );
  }

  const data = await upstream.json();
  const citations = transformCitations(data.citations);
  const confidenceLabel: string | undefined = data?.coverage?.confidence;

  return NextResponse.json(
    {
      success: true,
      answer: data.answer,
      data: {
        citations,
        query: question,
        region: null,
        resultsCount: citations.length,
        references: { documents: citations, web: [] },
      },
      metadata: {
        processing_time: Date.now() - startedAt,
        confidence:
          confidenceLabel != null ? CONFIDENCE_SCORE[confidenceLabel] ?? null : null,
        confidenceLabel,
        webFallbackUsed: false,
        groundedness:
          typeof data?.groundedness === "number" ? data.groundedness : null,
        unsupportedClaims: Array.isArray(data?.unsupported_claims)
          ? data.unsupported_claims
          : [],
        agents: data?.coverage?.agents,
        verified: data?.verified,
        source: "local-rag-proposal-review-chat",
      },
      mapCitations: [],
    },
    { status: 200 }
  );
}
