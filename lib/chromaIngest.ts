// lib/chromaIngest.ts
//
// Real implementation of the PDF ingestion pipeline. Called by
// app/api/rag/ingest/route.ts, which hands us parsed multipart PDF files
// plus an optional region hint.
//
// Pipeline per file:
//   1. Extract text per page with pdf-parse (custom pagerender hook so we
//      keep page boundaries, not just one big blob of text).
//   2. Classify the document with classifyDoc() (app/api/rag/corpus.ts) to
//      get docType / jurisdictionKey / topics from the title.
//   3. Insert one row into `documents` for the file.
//   4. Split each page into ~1000-character chunks (paragraph-aware, small
//      overlap), embed each chunk with the SAME model/dimension/normalization
//      used at query time (lib/embeddings.ts - this consistency matters a
//      lot for retrieval quality), and insert into `chunks`.
//
// This intentionally does NOT try to detect clause/section numbers with
// fancy regexes across arbitrary regulatory documents - that's a rabbit
// hole. It stores page-level chunks with real page numbers, which is what
// the query path (app/api/rag-chat/route.ts) actually uses for citations
// (page_from / page_to). Section/clause fields are left null unless a
// simple heading pattern is obviously present.

import { createClient } from "@supabase/supabase-js";
import { chunkPageText } from "./chunkText";
import { generateEmbedding } from "@/lib/embeddings";
import { classifyDoc, normalizeRegion, type Region } from "@/app/api/rag/corpus";

export interface IngestFile {
  name: string;
  buffer: Buffer;
  // Optional per-file overrides. When omitted, behavior is unchanged
  // from before this field existed: title comes from the filename and
  // jurisdiction/docType come from classifyDoc()'s title-substring
  // guessing. Batch/bulk ingestion (many councils' Local Plans in one
  // run) should always set these explicitly - classifyDoc() has no way
  // to know WHICH council a generically-named "Local Plan.pdf" belongs
  // to, and its one "local_plan" branch hardcodes a single jurisdiction.
  title?: string;
  jurisdictionKey?: string;
  docType?: string;
  sourceUrl?: string;

  // ---- council-aware fields (sql/2026-09-07-council-aware-retrieval.sql) ----
  // All optional. Omit them all and this behaves exactly as it did before the
  // fields existed, so the NPPF and any ad-hoc upload keep working unchanged.
  /** 'national' for policy that applies everywhere (the NPPF), else 'local'. */
  scope?: "national" | "local";
  /** Canonical LPA slugs this document is authoritative for, e.g. ['reading']. */
  lpaSlugs?: string[];
  /** Human-readable authority names, parallel to lpaSlugs. */
  lpaNames?: string[];
  /**
   * Adoption status. Only ever set this from a source that actually states it.
   * 'unknown' is a first-class value and is the correct answer when the
   * tracker does not say - a fabricated 'adopted' is worse than no value,
   * because an emerging policy presented as adopted is legally wrong.
   */
  planStatus?: "adopted" | "emerging" | "superseded" | "unknown";
  /** SHA-256 of the source bytes. Enables skip-if-already-ingested. */
  contentSha256?: string;
}

export interface IngestOptions {
  region?: Region;
}


let _supabase: any = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

function titleFromFilename(name: string): string {
  const base = name.replace(/\.pdf$/i, "");
  // Handle names like "National_Planning_Policy_Framework" -> "National Planning Policy Framework"
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPages(buffer: Buffer): Promise<string[]> {
  // pdf-parse's default behavior concatenates all page text into one
  // string. Passing a custom pagerender lets us also capture each page's
  // text individually as it's rendered, while still returning the text so
  // pdf-parse's own bookkeeping (ret.text, numrender) keeps working.
  const pdfParse = require("pdf-parse");
  const pages: string[] = [];

  const render_options = {
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  };

  await pdfParse(buffer, {
    pagerender: (pageData: any) =>
      pageData.getTextContent(render_options).then((textContent: any) => {
        let lastY: number | undefined;
        let text = "";
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || lastY === undefined) {
            text += item.str;
          } else {
            text += "\n" + item.str;
          }
          lastY = item.transform[5];
        }
        pages.push(text);
        return text;
      }),
  });

  return pages;
}

async function embedWithRetry(text: string, attempts = 3): Promise<number[]> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await generateEmbedding(text);
    } catch (err) {
      lastErr = err;
      // Gentle backoff for free-tier rate limits (429s).
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

async function ingestOnePdf(
  file: IngestFile,
  options: IngestOptions
): Promise<{ file: string; document_id: number; chunks: number }> {
  const title = file.title || titleFromFilename(file.name);
  const classification = classifyDoc(title);
  const jurisdictionKey = file.jurisdictionKey || classification.jurisdictionKey;
  const docType = file.docType || classification.docType;
  const region = normalizeRegion(options.region || jurisdictionKey || "usa");

  const supabase = getSupabase();

  // Idempotency: same bytes => same hash => already ingested. Re-running a
  // batch after a mid-run crash must not append a second full set of chunks
  // for the councils that already succeeded - duplicated chunks do not just
  // waste storage, they let one document win several slots in the top-K and
  // crowd out every other source.
  if (file.contentSha256) {
    const { data: existing } = await supabase
      .from("documents")
      .select("id")
      .eq("content_sha256", file.contentSha256)
      .maybeSingle();

    if (existing?.id) {
      const { count } = await supabase
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .eq("document_id", existing.id);

      if ((count ?? 0) > 0) {
        console.log(
          `  skip (already ingested): ${title} -> document_id=${existing.id}, ${count} chunks`
        );
        return { file: file.name, document_id: existing.id as number, chunks: count as number };
      }

      // A documents row exists for this exact content but has zero chunks -
      // a leftover shell from a prior run that inserted the document row
      // then crashed (e.g. a Gemini 429) before any chunk embedding
      // finished. Treating that as "already ingested" (the old behaviour)
      // silently and permanently stranded this council with no real
      // content: content_sha256 has a unique index, so every future retry
      // would hit this same empty row and skip again forever. Delete the
      // empty shell and fall through to a normal fresh insert below.
      console.log(
        `  found empty leftover document (id=${existing.id}, 0 chunks) for ${title} - ` +
          `deleting it and re-ingesting from scratch`
      );
      const { error: deleteError } = await supabase
        .from("documents")
        .delete()
        .eq("id", existing.id);
      if (deleteError) {
        throw new Error(
          `Failed to delete empty leftover document ${existing.id} for ${file.name}: ${deleteError.message}`
        );
      }
    }
  }

  const documentRow: Record<string, unknown> = {
    title,
    region,
    jurisdiction_level: jurisdictionKey || null,
    doc_type: docType,
    source_path: file.name,
    source_url: file.sourceUrl || null,
    year: null,
    citation_ref: title,
    updated_at: new Date().toISOString().slice(0, 10),
  };

  // Only send council columns when the caller supplied them, so this same
  // function still works against a database where the migration has not run.
  if (file.scope) documentRow.scope = file.scope;
  if (file.lpaSlugs?.length) documentRow.lpa_slugs = file.lpaSlugs;
  if (file.lpaNames?.length) documentRow.lpa_names = file.lpaNames;
  if (file.planStatus) documentRow.plan_status = file.planStatus;
  if (file.contentSha256) documentRow.content_sha256 = file.contentSha256;

  const { data: docRow, error: docError } = await supabase
    .from("documents")
    .insert(documentRow)
    .select("id")
    .single();

  if (docError || !docRow) {
    throw new Error(
      `Failed to insert documents row for ${file.name}: ${docError?.message || "unknown error"}`
    );
  }

  const documentId = docRow.id as number;
  const pages = await extractPages(file.buffer);

  const rows: Array<{
    document_id: number;
    chunk_index: number;
    content: string;
    page: string;
    page_label: string;
    clause: null;
    clause_label: null;
    section: null;
    region: string;
    doc_type: string;
  }> = [];

  pages.forEach((pageText, pageIdx) => {
    const pageNumber = pageIdx + 1;
    const pageChunks = chunkPageText(pageText);
    pageChunks.forEach((content) => {
      rows.push({
        document_id: documentId,
        chunk_index: rows.length,
        content,
        page: String(pageNumber),
        page_label: `Page ${pageNumber}`,
        clause: null,
        clause_label: null,
        section: null,
        region,
        doc_type: docType,
      });
    });
  });

  // Embed sequentially with a small delay between calls to stay well
  // within the Gemini free-tier rate limit, and insert in batches so a
  // single failed request doesn't lose already-embedded work.
  const BATCH_SIZE = 20;
  let insertedCount = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const embedded = [];
    for (const row of batch) {
      const embedding = await embedWithRetry(row.content);
      embedded.push({ ...row, embedding });
      await new Promise((r) => setTimeout(r, 150));
    }

    const { error: insertError } = await supabase.from("chunks").insert(embedded);
    if (insertError) {
      throw new Error(
        `Failed inserting chunks ${i}-${i + batch.length} for ${file.name}: ${insertError.message}`
      );
    }
    insertedCount += embedded.length;
  }

  return { file: file.name, document_id: documentId, chunks: insertedCount };
}

export async function ingestMultiplePdfs(
  files: IngestFile[],
  options: IngestOptions = {}
): Promise<Array<{ file: string; document_id: number; chunks: number }>> {
  const results = [];
  for (const file of files) {
    // Sequential, not parallel: keeps us under Gemini's free-tier rate
    // limit and makes a partial failure easy to reason about (you'll know
    // exactly which file it stopped on).
    results.push(await ingestOnePdf(file, options));
  }
  return results;
}
