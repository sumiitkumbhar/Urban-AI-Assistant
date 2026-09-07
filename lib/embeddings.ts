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

export async function generateEmbedding(text: string): Promise<number[]> {
  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const response = await getAI().models.embedContent({
    model: GEMINI_EMBEDDING_MODEL,
    contents: cleanText,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS },
  });

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
