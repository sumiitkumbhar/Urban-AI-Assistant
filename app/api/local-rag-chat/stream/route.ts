// app/api/local-rag-chat/stream/route.ts
//
// Server-Sent Events proxy to local-rag's /query/stream endpoint
// (local-rag/service.py) - architecture-plan Phase 5's "streaming"
// item, local-mode-only for now. Sits alongside ../route.ts (the
// existing non-streaming proxy, still used as the fallback path/for any
// caller that wants one JSON response) rather than replacing it.
//
// Unlike a pure byte-for-byte pipe, this reshapes the upstream "done"
// event's JSON payload the same way ../route.ts's transformCitations()/
// CONFIDENCE_SCORE mapping already does for the non-streaming path - so
// ChatInterface.tsx's local-mode streaming consumer (see its handleSend()
// local-streaming branch) gets citations/confidence/groundedness in
// exactly the shape it already knows how to render. "delta"/"coverage"
// events are forwarded unchanged - there's nothing to reshape in a raw
// text fragment.
//
// A UK postcode in the query routes this to /site-answer instead of
// /query - see ../route.ts's own UK_POSTCODE_RE/extractPostcode comment
// for why. /site-answer has no streaming counterpart (it's a single
// GIS lookup + one generation call, not worth a second stream_answer()
// implementation), so that branch fetches it as one JSON response and
// re-packages it as a synthetic three-event stream (coverage, one delta
// carrying the whole answer, done) - same event shape the client already
// parses, just without real token-by-token reveal for this path.
//
// Requires local-rag/service.py running separately, same as ../route.ts:
//   cd local-rag && source venv/bin/activate && uvicorn service:app --port 8010

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

// Mirrors ../route.ts's own UK_POSTCODE_RE/extractPostcode exactly - see
// that file's comments for why. Duplicated rather than imported because
// Next.js route modules don't share state across files here and this is
// a handful of lines; if it ever needs to change, change both.
const UK_POSTCODE_RE = /\b[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}\b/i;

function extractPostcode(text: string): string | null {
  const match = text.match(UK_POSTCODE_RE);
  return match ? match[0].toUpperCase() : null;
}

// Mirrors ../route.ts's own CONFIDENCE_SCORE/transformCitations/
// transformMapCitations exactly - see that file's comments for why
// these particular mappings/shapes were chosen. Duplicated rather than
// imported because Next.js route modules don't share state across files
// here and this is a handful of lines; if it ever needs to change,
// change both.
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

interface LocalRagMapCitation {
  filename: string;
  doc_type?: string;
  domain?: string;
  geography?: string;
  bucket?: string;
  image_url?: string | null;
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

// See ../route.ts's transformMapCitations for why image_url has to be
// made absolute against LOCAL_RAG_URL here.
function transformMapCitations(mapCitations: LocalRagMapCitation[] | undefined) {
  return (mapCitations || []).map((m) => ({
    filename: m.filename,
    docType: m.doc_type,
    domain: m.domain,
    geography: m.geography,
    imageUrl: m.image_url ? `${LOCAL_RAG_URL}${m.image_url}` : null,
  }));
}

function transformDonePayload(payload: any, extra?: { postcode?: string }) {
  const confidenceLabel: string | undefined = payload?.coverage?.confidence;
  return {
    answer: payload.answer,
    citations: transformCitations(payload.citations),
    mapCitations: transformMapCitations(payload.map_citations),
    confidence:
      confidenceLabel != null ? CONFIDENCE_SCORE[confidenceLabel] ?? null : null,
    confidenceLabel,
    groundedness:
      typeof payload.groundedness === "number" ? payload.groundedness : null,
    unsupportedClaims: Array.isArray(payload.unsupported_claims)
      ? payload.unsupported_claims
      : [],
    verified: payload.verified,
    agents: payload?.coverage?.agents,
    retrieval_ms: payload.retrieval_ms,
    generation_ms: payload.generation_ms,
    postcode: extra?.postcode,
  };
}

function transformDoneEvent(rawEvent: string): string {
  const lines = rawEvent.split("\n");
  let dataLine = "";
  for (const line of lines) {
    if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  try {
    const payload = JSON.parse(dataLine);
    const transformed = transformDonePayload(payload);
    return `event: done\ndata: ${JSON.stringify(transformed)}`;
  } catch {
    // Malformed/unparseable "done" payload - forward it as-is rather
    // than swallowing the event; the client's JSON.parse will fail
    // visibly instead of the stream just going silent.
    return rawEvent;
  }
}

function transformEvent(rawEvent: string): string {
  if (rawEvent.startsWith("event: done")) {
    return transformDoneEvent(rawEvent);
  }
  return rawEvent;
}

function sseError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
}

// Builds the synthetic (non-token-streamed) SSE response for a
// postcode-triggered /site-answer request - see this file's header
// comment. Mirrors real /query/stream's event sequence (coverage, then
// delta(s), then done) closely enough that sendLocalStreaming() in
// ChatInterface.tsx needs no branch of its own to handle it.
async function siteAnswerAsStream(postcode: string, query: string) {
  let upstream: Response;
  try {
    upstream = await fetch(`${LOCAL_RAG_URL}/site-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcode, question: query }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return sseError(
      "Couldn't reach the local RAG service on " +
        LOCAL_RAG_URL +
        ". Is it running? Start it with: cd local-rag && source venv/bin/activate " +
        "&& uvicorn service:app --port 8010",
      503
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return sseError(
      `Local RAG service returned ${upstream.status}: ${text.slice(0, 500)}`,
      502
    );
  }

  const data = await upstream.json();

  if (data?.error) {
    data.answer = `I couldn't find site data for ${postcode}: ${data.error}`;
    data.citations = [];
    data.map_citations = [];
    data.coverage = data.coverage || { confidence: "low", agents: [] };
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const coverage = data.coverage || {};
      controller.enqueue(
        encoder.encode(`event: coverage\ndata: ${JSON.stringify(coverage)}\n\n`)
      );
      controller.enqueue(
        encoder.encode(
          `event: delta\ndata: ${JSON.stringify({ text: data.answer || "" })}\n\n`
        )
      );
      const done = transformDonePayload(data, { postcode });
      controller.enqueue(
        encoder.encode(`event: done\ndata: ${JSON.stringify(done)}\n\n`)
      );
      controller.close();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

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

  const query = (body?.query ?? "").toString().trim();
  if (!query) {
    return NextResponse.json(
      { success: false, error: "Missing 'query'" },
      { status: 400 }
    );
  }

  const postcode = extractPostcode(query);
  if (postcode) {
    return siteAnswerAsStream(postcode, query);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${LOCAL_RAG_URL}/query/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: query }),
      // A streamed query can legitimately run longer than the
      // non-streaming route's 60s budget before its first byte, but one
      // still running after 3 minutes is almost certainly stuck, not
      // just slow - abort rather than hang the connection forever.
      signal: AbortSignal.timeout(180_000),
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

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        success: false,
        error: `Local RAG service returned ${upstream.status}: ${text.slice(0, 500)}`,
      },
      { status: 502 }
    );
  }

  const upstreamReader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await upstreamReader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (rawEvent.trim()) {
              controller.enqueue(encoder.encode(transformEvent(rawEvent) + "\n\n"));
            }
          }
        }
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(transformEvent(buffer) + "\n\n"));
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
