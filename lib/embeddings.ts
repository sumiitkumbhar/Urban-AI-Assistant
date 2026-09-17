// lib/embeddings.ts
//
// Shared Gemini embedding logic used by BOTH the query path
// (app/api/rag-chat/route.ts) and the ingestion path (lib/chromaIngest.ts).
//
// Keeping this in one place matters: the query-time embedding and the
// stored chunk embeddings must be produced with the exact same model,
// dimension, and normalization, or cosine similarity search silently
// degrades (queries and chunks end up in slightly different vector spaces).

import { GoogleGenAI } from "@google/genai";

export const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

// The Supabase `chunks.embedding` column is vector(768) (chosen to keep
// storage/compute cheap on the free tier), but gemini-embedding-001 defaults
// to 3072 dimensions. Requesting outputDimensionality here truncates to match
// the column - without it, every vector would be 3072-dim and Postgres would
// reject the query outright with a dimension mismatch.
export const EMBEDDING_DIMENSIONS = 768;

let _ai: GoogleGenAI | null = null;
function getAI() {
  if (!_ai) {
    const key = process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error("Missing GOOGLE_API_KEY");
    }
    _ai = new GoogleGenAI({ apiKey: key });
  }
  return _ai;
}

// Retry/backoff for Gemini's free-tier rate limit (429 RESOURCE_EXHAUSTED,
// metric "embed_content_free_tier_requests"). Hit for real 2026-09-15 during
// council-plan bulk ingestion: 3 of 5 councils in one batch failed on this
// with no retry at all, permanently marking otherwise-good rows "error" in
// the tracker. NOTE: the error's own "Please retry in Ns" hint (seen as low
// as 5s) suggests a short burst-rate window, but "free_tier_requests" could
// also be Google's account-level DAILY quota - this backoff fixes the
// former for free; if it's actually the latter, all retries below will
// still fail and the caller sees the same error after ~waiting - that's the
// signal to stop ingesting for the day rather than hammer the API further.
//
// Confirmed 2026-09-16: it IS (at least partly) a daily cap - retrying
// through this full backoff still fails once the day's ~1000 free-tier
// requests are used up. scripts/ingest-council-plans.ts uses
// isRateLimitError() (exported below) to detect that case specifically and
// stop the whole batch run rather than burning through every remaining
// council's full retry budget for a guaranteed-doomed attempt.
const EMBED_MAX_RETRIES = 3;
const EMBED_RETRY_BACKOFF_MS = [15_000, 30_000, 60_000];

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number; code?: number })?.status
    ?? (err as { status?: number; code?: number })?.code;
  return status === 429 || /RESOURCE_EXHAUSTED|"code":429/.test(msg);
}

async function embedContentWithRetry(cleanText: string) {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
    try {
      return await getAI().models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: cleanText,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === EMBED_MAX_RETRIES) throw err;
      const delayMs = EMBED_RETRY_BACKOFF_MS[attempt];
      console.warn(
        `  embedContent rate-limited (attempt ${attempt + 1}/${EMBED_MAX_RETRIES + 1}), ` +
        `retrying in ${delayMs / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const response = await embedContentWithRetry(cleanText);

  const values = response.embeddings?.[0]?.values;
  if (!values?.length) {
    throw new Error("Embedding API returned no values");
  }

  // Google's docs: gemini-embedding-001 does NOT auto-normalize truncated
  // (non-3072-dim) output the way newer models do, so it must be normalized
  // to unit length manually here - both at query time and at ingest time.
  const raw = Array.from(values);
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}
