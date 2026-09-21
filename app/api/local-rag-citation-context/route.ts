// app/api/local-rag-citation-context/route.ts
//
// Proxies to local-rag's GET /citation-context/{chunk_id} - see
// local-rag/retrieve.py's get_citation_context() for what it does and
// why (stitches in the neighboring chunk(s) from the same document so a
// citation's RAW EXTRACT panel isn't stuck showing a chunk that starts
// or ends mid-sentence). Called on demand from
// components/citations/ExpandableCitation.tsx's "Show more context"
// control - not part of the main /query response, since most citations
// are never expanded and there's no reason to pay for this on every
// query.
//
// Mirrors ../local-rag-chat/route.ts's thin-proxy-plus-reshape pattern:
// this route's only job is forward the request and turn local-rag's
// snake_case JSON into the camelCase shape the frontend expects.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const LOCAL_RAG_URL = process.env.LOCAL_RAG_URL || "http://localhost:8010";

interface LocalRagCitationContext {
  chunk_id: string;
  doc_filename: string;
  page_start: number;
  page_end: number;
  expanded_before: boolean;
  expanded_after: boolean;
  text: string;
}

export async function GET(req: NextRequest) {
  const chunkId = req.nextUrl.searchParams.get("chunk_id");
  const windowParam = req.nextUrl.searchParams.get("window");

  if (!chunkId) {
    return NextResponse.json(
      { error: "Missing required chunk_id query parameter" },
      { status: 400 }
    );
  }

  const window = windowParam ? Math.max(1, Math.min(3, Number(windowParam) || 1)) : 1;

  try {
    const upstream = await fetch(
      `${LOCAL_RAG_URL}/citation-context/${encodeURIComponent(chunkId)}?window=${window}`,
      { method: "GET" }
    );

    if (upstream.status === 404) {
      return NextResponse.json(
        { error: `No chunk with id ${chunkId}` },
        { status: 404 }
      );
    }

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `local-rag returned ${upstream.status}` },
        { status: 502 }
      );
    }

    const data: LocalRagCitationContext = await upstream.json();

    return NextResponse.json({
      chunkId: data.chunk_id,
      docFilename: data.doc_filename,
      pageStart: data.page_start,
      pageEnd: data.page_end,
      expandedBefore: data.expanded_before,
      expandedAfter: data.expanded_after,
      text: data.text,
    });
  } catch (err) {
    // Same "service not running" case every other local-rag proxy route
    // hits - see ../local-rag-chat/route.ts's GET /health handler for
    // the same underlying condition.
    return NextResponse.json(
      { error: "Could not reach the local-rag service. Is it running on port 8010?" },
      { status: 503 }
    );
  }
}
