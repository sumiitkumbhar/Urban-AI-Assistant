// Two-layer answer cache sitting in front of the RAG pipeline, for
// stateless questions only (see cacheEligible in app/api/rag-chat/
// route.ts - no visitorId/conversationId, no uploads, no feasibility/
// drawing mode, no diagram intent). A hit here skips the embedding
// call, both Supabase retrieval RPCs, and every Groq call the full
// pipeline would otherwise pay for one at a time.
//
// Layer 1 (below): an in-process Map. Exact-text match only, keyed on
// the already-normalized question - instant and free, but scoped to
// this one running server process and gone on restart.
//
// Layer 2 (sql/2026-09-10-answer-cache.sql's qa_cache table +
// match_qa_cache RPC): a Supabase-backed semantic cache, matched by
// cosine similarity over the question's embedding so paraphrases hit
// too, not just identical wording. Persists across restarts and is
// shared by every request against this Supabase project. A Layer-2 hit
// warms Layer 1 so the next identical request is instant too.
//
// Both layers are looked up/written with the SAME normalized question +
// council scope + region + voice-mode key - see normalizeForCache().

import { getSupabase } from "@/lib/supabase";

const MEMORY_CACHE_MAX_ENTRIES = 500;
// Matches match_qa_cache's max_age_seconds default in the SQL file -
// kept in sync manually since Layer 1 has no SQL default to read from.
const MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.93;

export interface CacheKey {
  normalizedQuestion: string;
  councilScope: string; // council slug, or "NATIONAL"
  region: string; // body.region, or "any"
  voiceMode: boolean;
}

interface MemoryCacheEntry {
  response: unknown;
  storedAt: number;
}

// Module-scope Map = one instance per running Node process, which is
// exactly the "in-process" lifetime this layer is meant to have (dev
// server, or a single long-running production server - not meaningful
// across serverless/edge invocations, which is fine: Layer 2 covers
// that case).
const memoryCache = new Map<string, MemoryCacheEntry>();

// Strips punctuation/case/whitespace differences that don't change the
// question's meaning, so "Loft conversion rules?" and "loft conversion
// rules" hit the same Layer-1 entry instead of missing on formatting
// alone. Deliberately NOT stemming or removing stopwords - that belongs
// to Layer 2's embedding similarity, not this cheap exact-match layer.
export function normalizeForCache(question: string): string {
  return question
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function memoryKey(key: CacheKey): string {
  return `${key.councilScope}::${key.region}::${key.voiceMode ? "voice" : "text"}::${key.normalizedQuestion}`;
}

export function getMemoryCachedAnswer(key: CacheKey): unknown | null {
  const entry = memoryCache.get(memoryKey(key));
  if (!entry) return null;
  if (Date.now() - entry.storedAt > MEMORY_CACHE_TTL_MS) {
    memoryCache.delete(memoryKey(key));
    return null;
  }
  return entry.response;
}

export function setMemoryCachedAnswer(key: CacheKey, response: unknown): void {
  const mk = memoryKey(key);
  // Evict oldest entry once at capacity rather than letting this grow
  // unbounded for the life of the process - a plain insertion-order Map
  // makes "oldest" just "first key" with no extra bookkeeping.
  if (!memoryCache.has(mk) && memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) memoryCache.delete(oldestKey);
  }
  memoryCache.set(mk, { response, storedAt: Date.now() });
}

// Layer 2 read. Returns null on any Supabase error rather than
// throwing - a cache-layer failure must never be the reason a real
// question fails to get answered.
export async function getSupabaseCachedAnswer(
  key: CacheKey,
  embedding: number[]
): Promise<{ response: unknown; similarity: number; rowId: number } | null> {
  try {
    const { data, error } = await getSupabase().rpc("match_qa_cache", {
      query_embedding: embedding,
      filter_council_scope: key.councilScope,
      filter_region: key.region,
      filter_voice_mode: key.voiceMode,
      similarity_threshold: SIMILARITY_THRESHOLD,
    });
    if (error) {
      console.error("qa_cache lookup failed (continuing without cache):", error);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;

    // Fire-and-forget - a lost hit-count increment is not worth adding
    // latency to the fast path that just found a cache hit.
    getSupabase()
      .rpc("bump_qa_cache_hit", { row_id: row.id })
      .then(() => {})
      .catch(() => {});

    return { response: row.response, similarity: row.similarity, rowId: row.id };
  } catch (err) {
    console.error("qa_cache lookup threw (continuing without cache):", err);
    return null;
  }
}

// Layer 2 write. Awaited by the caller (this app runs as a persistent
// Node server, not ephemeral edge functions, so there's no risk of the
// process being torn down mid-write) but always wrapped so a write
// failure never turns a perfectly good answer into a 500.
export async function storeCachedAnswer(
  key: CacheKey,
  embedding: number[],
  response: unknown
): Promise<void> {
  setMemoryCachedAnswer(key, response);
  try {
    const { error } = await getSupabase()
      .from("qa_cache")
      .upsert(
        {
          question_normalized: key.normalizedQuestion,
          question_embedding: embedding,
          council_scope: key.councilScope,
          region: key.region,
          voice_mode: key.voiceMode,
          response,
        },
        { onConflict: "question_normalized,council_scope,region,voice_mode" }
      );
    if (error) {
      console.error("qa_cache store failed (non-fatal):", error);
    }
  } catch (err) {
    console.error("qa_cache store threw (non-fatal):", err);
  }
}
