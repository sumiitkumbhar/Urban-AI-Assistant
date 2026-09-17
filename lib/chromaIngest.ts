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
//   3. Insert one row into `documents` for the file (or reuse an existing
//      one - see the resume logic in ingestOnePdf() below).
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

type ChunkRow = {
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
};

// Splits every page into chunk rows, in stable, deterministic order (pure
// function of the PDF bytes: same buffer -> same pages -> same chunks in
// the same order every time). That determinism is what makes resuming a
// partially-embedded document safe below - rows[i] means the exact same
// thing on a retry as it did on the run that stopped partway through.
function buildChunkRows(
  pages: string[],
  documentId: number,
  region: string,
  docType: string
): ChunkRow[] {
  const rows: ChunkRow[] = [];
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
  return rows;
}

// Embeds and inserts `rows` (already sliced to just the chunks that still
// need embedding) in batches of BATCH_SIZE, so a request that fails partway
// through a large document still leaves the earlier batches committed -
// see the resume logic in ingestOnePdf() that picks this back up next run
// instead of redoing (and re-spending quota on) work already done.
//
// No extra retry wrapper here beyond generateEmbedding()'s own
// (lib/embeddings.ts's embedContentWithRetry, which already backs off
// specifically on 429/RESOURCE_EXHAUSTED) - an earlier version of this
// function added a second, outer 3-attempt retry loop on top of that inner
// one, which on a genuinely exhausted daily quota meant every chunk failure
// paid for BOTH retry budgets before finally throwing (several minutes per
// document instead of under two). One retry layer, in the one place that
// actually knows the specifics of the rate limit, is enough.
async function embedAndInsertBatches(
  supabase: any,
  fileName: string,
  rows: ChunkRow[]
): Promise<number> {
  const BATCH_SIZE = 20;
  let insertedCount = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const embedded = [];
    for (const row of batch) {
      const embedding = await generateEmbedding(row.content);
      embedded.push({ ...row, embedding });
      await new Promise((r) => setTimeout(r, 150));
    }

    const { error: insertError } = await supabase.from("chunks").insert(embedded);
    if (insertError) {
      throw new Error(
        `Failed inserting chunks ${i}-${i + batch.length} for ${fileName}: ${insertError.message}`
      );
    }
    insertedCount += embedded.length;
  }

  return insertedCount;
}

async function ingestOnePdf(
  file: IngestFile,
  options: IngestOptions
): Promise<{ file: string; document_id: number; chunks: number; newlyInserted: number }> {
  const title = file.title || titleFromFilename(file.name);
  const classification = classifyDoc(title);
  const jurisdictionKey = file.jurisdictionKey || classification.jurisdictionKey;
  const docType = file.docType || classification.docType;
  const region = normalizeRegion(options.region || jurisdictionKey || "usa");

  const supabase = getSupabase();

  // Idempotency + resume: same bytes => same hash => either already fully
  // ingested (skip), or a prior run got partway through and stopped (most
  // commonly a Gemini daily-quota 429 mid-document) and this run should
  // CONTINUE that same document rather than starting over from chunk 0 or
  // silently treating a partial document as done.
  //
  // This used to only check "does a documents row with this hash exist" and
  // treat any nonzero chunk count as "already ingested" - which was wrong
  // for a document that got, say, 300 of 568 chunks embedded before the
  // quota died: the next run would see count=300 (> 0), skip it as done,
  // and that council's corpus would silently stay incomplete forever
  // (content_sha256 has a unique index, so a fresh insert could never
  // happen for that content either). Comparing against the REAL expected
  // chunk count (computed below, before we know if we're resuming) fixes
  // that: only count >= expected is treated as done.
  let existingDocumentId: number | null = null;
  let existingChunkCount = 0;
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
      existingDocumentId = existing.id as number;
      existingChunkCount = count ?? 0;
    }
  }

  const pages = await extractPages(file.buffer);
  // document_id is a placeholder here (-1) since we don't know the real id
  // yet in the fresh-insert case - buildChunkRows() only uses it to stamp
  // onto each row, so it's cheap to re-stamp with the real id afterward
  // once we have it, rather than chunking the PDF a second time.
  const expectedRows = buildChunkRows(pages, -1, region, docType);

  if (existingDocumentId !== null && existingChunkCount >= expectedRows.length && expectedRows.length > 0) {
    console.log(
      `  skip (already fully ingested): ${title} -> document_id=${existingDocumentId}, ${existingChunkCount} chunks`
    );
    return {
      file: file.name,
      document_id: existingDocumentId,
      chunks: existingChunkCount,
      newlyInserted: 0,
    };
  }

  let documentId: number;
  if (existingDocumentId !== null) {
    // Resuming a partial document: reuse the SAME document_id rather than
    // deleting and re-inserting, so its identity (and anything already
    // pointing at it) doesn't change mid-ingestion.
    documentId = existingDocumentId;
    console.log(
      `  resuming partial ingestion: ${title} -> document_id=${documentId}, ` +
        `${existingChunkCount}/${expectedRows.length} chunks already embedded, continuing from chunk ${existingChunkCount}`
    );
  } else {
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

    documentId = docRow.id as number;
  }

  // Re-stamp the real document_id onto the rows computed above (see the
  // placeholder comment there) rather than re-chunking the PDF a second
  // time - chunking is a pure function of the PDF bytes, so this is the
  // exact same set of rows either way.
  const rows = expectedRows.map((r) => ({ ...r, document_id: documentId }));
  const remainingRows = rows.slice(existingChunkCount);
  const newlyInserted = await embedAndInsertBatches(supabase, file.name, remainingRows);
  const totalChunks = existingChunkCount + newlyInserted;

  return { file: file.name, document_id: documentId, chunks: totalChunks, newlyInserted };
}

export async function ingestMultiplePdfs(
  files: IngestFile[],
  options: IngestOptions = {}
): Promise<Array<{ file: string; document_id: number; chunks: number; newlyInserted: number }>> {
  const results = [];
  for (const file of files) {
    // Sequential, not parallel: keeps us under Gemini's free-tier rate
    // limit and makes a partial failure easy to reason about (you'll know
    // exactly which file it stopped on).
    results.push(await ingestOnePdf(file, options));
  }
  return results;
}
