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

// A UK postcode found in the typed query routes this request to
// local-rag's /site-answer instead of /query - see service.py's
// SiteAnswerRequest/site_answer(). That endpoint runs the real
// GIS/PostGIS site-constraints lookup (gis_lookup.site_constraints())
// and, when a matched constraint has a corresponding map PDF (see
// site_context.py's _find_map_citations()), returns a rendered map
// image alongside the answer - which /query never does, since it has
// no site to look constraints up for. So "what can I build at SW1V
// 3LX" gets a real, site-scoped answer with a visual citation, while
// any other question still goes through the ordinary unscoped
// retrieval path. Deliberately a simple full-postcode-format heuristic
// (not outward-code-only, not free-text address lookup) - enough to
// drive this without a dedicated postcode-input UI.
const UK_POSTCODE_RE = /\b[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}\b/i;

function extractPostcode(text: string): string | null {
  const match = text.match(UK_POSTCODE_RE);
  return match ? match[0].toUpperCase() : null;
}

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
  // Raw retrieved chunk text, added server-side in local-rag/answer.py's
  // build_context() - see that file's comment on the citations.append()
  // call for why this was missing before.
  text?: string;
}

// Shape of an entry in the upstream response's `map_citations` array -
// see local-rag/site_context.py's _find_map_citations() docstring and
// data/map_documents.json's records for the fields' origin.
interface LocalRagMapCitation {
  filename: string;
  doc_type?: string;
  domain?: string;
  geography?: string;
  bucket?: string;
  image_url?: string | null;
}

// A short preview for the citation card before it's expanded. The full
// cleanup (stripping [TOPIC]/[SECTION] chunk markers, repairing smashed
// words, etc.) already happens client-side in ExpandableCitation.tsx for
// every citation regardless of source, so this only needs to produce a
// reasonable plain-text slice, not duplicate that whole pipeline here.
function buildLocalExcerpt(text: string | undefined, max = 220): string | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max).trim()}...` : cleaned;
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
    fullText: c.text || undefined,
    excerpt: buildLocalExcerpt(c.text),
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

// image_url comes back from the upstream service as a path relative to
// *that* service (e.g. "/map-images/xxxx_p1.png", served by its own
// StaticFiles mount) - the browser renders this page from Next.js's own
// origin, not local-rag's, so it has to be made absolute against
// LOCAL_RAG_URL here or an <img> tag would request it from the Next.js
// dev server instead and 404.
function transformMapCitations(mapCitations: LocalRagMapCitation[] | undefined) {
  return (mapCitations || []).map((m) => ({
    filename: m.filename,
    docType: m.doc_type,
    domain: m.domain,
    geography: m.geography,
    imageUrl: m.image_url ? `${LOCAL_RAG_URL}${m.image_url}` : null,
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

  const postcode = extractPostcode(query);
  const upstreamPath = postcode ? "/site-answer" : "/query";
  // Fully-local generation (added 2026-09-24, opt-in) - "ollama" routes
  // the answer-generation step itself (not just retrieval) through a
  // local Ollama instance instead of Groq's cloud API, see
  // local-rag/answer.py's `backend` parameter and common.py's
  // OLLAMA_BASE_URL/DEFAULT_OLLAMA_MODEL. Anything other than the
  // literal string "ollama" is treated as "groq" (the existing
  // default), so a missing/garbled field never silently changes
  // behavior.
  const backend = body?.backend === "ollama" ? "ollama" : "groq";
  const upstreamBody = postcode
    ? { postcode, question: query, backend }
    : { question: query, backend };

  let upstream: Response;
  try {
    upstream = await fetch(`${LOCAL_RAG_URL}${upstreamPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
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

  // /site-answer returns {"error": "..."} (no "answer") when the
  // postcode didn't resolve to a real site (e.g. outside GIS coverage) -
  // see site_context.py's build_site_context(). Surface that as a normal
  // chat answer rather than as a blank/broken message.
  if (postcode && data?.error) {
    return NextResponse.json(
      {
        success: true,
        answer: `I couldn't find site data for ${postcode}: ${data.error}`,
        data: {
          citations: [],
          query,
          region: null,
          resultsCount: 0,
          references: { documents: [], web: [] },
        },
        metadata: {
          processing_time: Date.now() - startedAt,
          confidence: null,
          confidenceLabel: undefined,
          webFallbackUsed: false,
          groundedness: null,
          unsupportedClaims: [],
          source: "local-rag",
          postcode,
        },
        mapCitations: [],
      },
      { status: 200 }
    );
  }

  const citations = transformCitations(data.citations);
  const mapCitations = transformMapCitations(data.map_citations);
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
      // Set only on the /site-answer path (postcode detected in the
      // query) - lets the UI label which site a map citation belongs to
      // without re-parsing the question text.
      postcode: postcode || undefined,
    },
    // Top-level (not nested under data/metadata) so ChatInterface.tsx's
    // handleSend() can read it with one straightforward
    // `data?.mapCitations` regardless of which branch built the
    // response - see local-rag/site_context.py's _find_map_citations()
    // for where these come from and map_images.py for how the image is
    // rendered.
    mapCitations,
  };

  return NextResponse.json(response, { status: 200 });
}

// Lets the UI show a "local RAG offline" indicator without waiting for a
// failed chat send first - see the ragSource toggle in ChatInterface.tsx.
// Also probes local-rag's /ollama/status (added 2026-09-24 alongside the
// fully-local backend toggle) and folds it in as `ollama` - so the same
// one status check that already runs on switching to local mode also
// tells the UI whether the Ollama backend option can actually be
// offered right now, without a second round trip. Best-effort: any
// failure on the Ollama probe just means "not available" (see
// service.py's own ollama_status(), which never 500s either), never a
// reason to fail this whole health check.
export async function GET() {
  let health: { reachable: boolean; [key: string]: any };
  try {
    const res = await fetch(`${LOCAL_RAG_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json().catch(() => ({}));
    health = { reachable: res.ok, ...data };
  } catch {
    health = { reachable: false, status: "unreachable" };
  }

  let ollama: any = { available: false, models: [], default_model_pulled: false };
  try {
    const res = await fetch(`${LOCAL_RAG_URL}/ollama/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    ollama = await res.json().catch(() => ollama);
  } catch {
    // Ollama simply not installed/running is a normal state, not an
    // error - `ollama` above already defaults to "not available".
  }

  return NextResponse.json({ ...health, ollama });
}
