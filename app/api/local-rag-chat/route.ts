// app/api/local-rag-chat/route.ts
//
// Proxies chat queries to the offline local-rag service (FastAPI, see
// local-rag/service.py - Qdrant + BM25 + local reranker + Groq synthesis,
// with Agentic/Multi-Agent orchestration for cross-domain queries) instead
// of the cloud Supabase + Google-embeddings + Groq stack in
// app/api/rag-chat/route.ts.
//
// Kept as its own thin route rather than another branch inside that
// already-4000+-line file - see urban-ai-architecture-plan.md section 4.4:
// "do not continue adding more logic into a giant request route". This
// route's only job is: proxy to the local FastAPI service, and adapt its
// response into the same shape ChatInterface.tsx already knows how to
// render (RagResponse in app/api/rag-chat/route.ts) - see
// transformCitations()/the confidence-label mapping below for the exact
// field-by-field mapping. If that shape changes, update both.
//
// Requires local-rag/service.py running separately (it is NOT started by
// `npm run dev`):
//   cd local-rag && source venv/bin/activate && uvicorn service:app --port 8010
//
// LOCAL_RAG_URL overrides the default http://localhost:8010 (e.g. if you
// ever run the service on another machine/port).

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

// local-rag's Corrective-RAG confidence is a label (low/medium/high), not
// a score - ChatInterface.tsx's ConfidenceBadge expects a 0-100 number
// (see metadata.confidence's usage at components/chat/ChatInterface.tsx).
// These are display buckets, not a claim of statistical equivalence to
// the cloud path's own confidence number.
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
    // rerank_score isn't a 0-1 probability, but it's the only per-citation
    // strength signal local-rag returns - scaled into the same 0-100
    // display range the cloud path's per-citation confidence uses.
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

  const query = (body?.query ?? "").toString().trim();
  if (!query) {
    return NextResponse.json(
      { success: false, error: "Missing 'query'" },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${LOCAL_RAG_URL}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: query }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e: any) {
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

  const response = {
    success: true,
    answer: data.answer,
    data: {
      citations,
      query,
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
      // local-rag now runs its own claim-level groundedness judge
      // (local-rag/answer.py's _check_groundedness(), added alongside
      // this route - deliberately mirroring the cloud path's own
      // checkGroundedness() in app/api/rag-chat/route.ts field-for-
      // field) instead of always reporting null, so the groundedness
      // badge in ChatInterface.tsx now renders for local mode too, not
      // just Cloud.
      groundedness:
        typeof data?.groundedness === "number" ? data.groundedness : null,
      unsupportedClaims: Array.isArray(data?.unsupported_claims)
        ? data.unsupported_claims
        : [],
      agents: data?.coverage?.agents,
      verified: data?.verified,
      source: "local-rag",
    },
  };

  return NextResponse.json(response, { status: 200 });
}

// Lets the UI show a "local RAG offline" indicator without waiting for a
// failed chat send first - see the ragSource toggle in ChatInterface.tsx.
export async function GET() {
  try {
    const res = await fetch(`${LOCAL_RAG_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json({ reachable: res.ok, ...data });
  } catch {
    return NextResponse.json({ reachable: false, status: "unreachable" });
  }
}
