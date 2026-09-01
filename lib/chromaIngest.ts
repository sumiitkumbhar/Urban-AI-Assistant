// lib/chromaIngest.ts
//
// STATUS: stub.
//
// app/api/rag/ingest/route.ts imports `ingestMultiplePdfs` from this file,
// but no implementation of it existed anywhere in the repo — the module
// itself was missing, which broke the TypeScript build for the whole
// project (`npm run build` / `npm run type-check` failed with
// "Cannot find module '@/lib/chromaIngest'").
//
// This stub restores a clean build and makes /api/rag/ingest fail with a
// clear, honest error instead of crashing the build. It does NOT
// implement real ingestion. The retrieval side (app/api/rag-chat) expects
// rows in a Supabase table with columns like doc_title, doc_path,
// doc_kind, page_from/page_to, clause_label, citation_type/value,
// section_heading, keywords, content, and a vector `embedding` column
// produced by the same Gemini embedding model used at query time
// (see GEMINI_EMBEDDING_MODEL / generateEmbedding in app/api/rag-chat/route.ts).
//
// To make ingestion real:
//   1. Parse each PDF into page/clause-level chunks (pdf-parse / pdfjs-dist
//      are already installed for this).
//   2. Classify each doc with classifyDoc() from app/api/rag/corpus.ts.
//   3. Embed each chunk with the same embedding model/config as the query
//      path (ai.models.embedContent with GEMINI_EMBEDDING_MODEL).
//   4. Upsert the chunks + embeddings into your Supabase table via
//      SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

import type { Region } from "@/app/api/rag/corpus";

export interface IngestFile {
  name: string;
  buffer: Buffer;
}

export interface IngestOptions {
  region?: Region;
}

export async function ingestMultiplePdfs(
  files: IngestFile[],
  _options: IngestOptions = {}
): Promise<never> {
  throw new Error(
    `Document ingestion is not implemented yet (lib/chromaIngest.ts is a stub). ` +
      `Received ${files.length} file(s): ${files
        .map((f) => f.name)
        .join(", ")}. ` +
      `Populate the Supabase corpus table directly, or implement ingestMultiplePdfs().`
  );
}
