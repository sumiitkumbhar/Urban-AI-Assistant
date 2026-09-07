// lib/userDocuments.ts
//
// Per-conversation user document uploads: a visitor attaches a PDF, DOCX,
// image, or spreadsheet (xlsx/xls/csv) to the chat and, from then on,
// questions in that SAME conversation are answered using BOTH that
// document's content AND the
// existing shared corpus (NPPF etc.) together - e.g. upload a site
// document, then ask "what can be done in this scenario as per NPPF".
//
// Deliberately kept separate from lib/chromaIngest.ts (the shared-corpus
// ingestion pipeline): this writes into the isolated
// user_documents / user_document_chunks tables (sql/user_documents_setup.sql),
// scoped strictly by conversation_id, so one visitor's upload can never
// surface in another visitor's answers and never grows the shared corpus.
//
// Reuses, unchanged, the exact same embedding pipeline as the corpus
// (generateEmbedding from lib/embeddings.ts) - query-time and upload-time
// vectors must live in the same space or cosine similarity search quietly
// degrades.

import { getSupabase } from "@/lib/supabase";
import { generateEmbedding } from "@/lib/embeddings";
import { GoogleGenAI } from "@google/genai";
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);

export type UserDocFileType = "pdf" | "docx" | "image" | "spreadsheet";

export interface UserDocChunkMatch {
  id: number;
  document_id: string;
  chunk_index: number;
  page_number: number | null;
  content: string;
  distance: number;
  // Joined in by searchUserDocumentChunks() after the RPC call, since the
  // RPC itself only returns chunk-level columns.
  doc_filename: string;
}

const CHUNK_TARGET_CHARS = 1100;
const CHUNK_OVERLAP_CHARS = 150;

// Same 20MB-ish sanity ceiling the /api/rag/ingest PDF path assumes
// implicitly via Next's default body size - stated explicitly here since
// this route accepts arbitrary user uploads, not just admin-curated PDFs.
export const MAX_USER_DOC_BYTES = 20 * 1024 * 1024;

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

// Lightweight, fast multimodal model just for reading text off an image -
// deliberately not the (heavier) chat model used for actual answer
// generation elsewhere in the app.
const GEMINI_VISION_MODEL =
  process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash";

export function detectUserDocFileType(
  filename: string,
  mimeType: string
): UserDocFileType | null {
  const name = (filename || "").toLowerCase();
  const type = (mimeType || "").toLowerCase();

  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    return "docx";
  }
  if (
    type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|heic)$/i.test(name)
  ) {
    return "image";
  }
  if (
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    type === "application/vnd.ms-excel" ||
    type === "text/csv" ||
    /\.(xlsx|xls|csv)$/i.test(name)
  ) {
    return "spreadsheet";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// Same pagerender approach as lib/chromaIngest.ts's extractPages() - kept
// as a private copy rather than exported/shared, since the two ingestion
// paths (admin corpus vs. per-conversation upload) are intentionally
// decoupled and free to diverge later.
async function extractPdfPages(buffer: Buffer): Promise<string[]> {
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

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || "");
}

// Turns each CSV row into its own "paragraph" (blank line between rows)
// so chunkText()'s paragraph-aware packer below groups whole rows up to
// ~CHUNK_TARGET_CHARS instead of hard-splitting a sheet mid-row.
function csvRowsAsParagraphs(csv: string): string {
  return csv
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0)
    .join("\n\n");
}

// xlsx (SheetJS) reads .xlsx, .xls, AND .csv - it sniffs the format from
// the buffer itself, so one code path covers all three. Each worksheet
// becomes its own "page" (page_number = sheet index) so a workbook with
// several tabs chunks and cites sheet-by-sheet rather than as one blob.
async function extractSpreadsheetPages(
  buffer: Buffer
): Promise<Array<{ page: number; text: string }>> {
  const XLSX = require("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer" });

  return workbook.SheetNames.map((sheetName: string, i: number) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return {
      page: i + 1,
      text: `Sheet: ${sheetName}\n\n${csvRowsAsParagraphs(csv)}`,
    };
  });
}

// Image "OCR" via Gemini's multimodal vision, reusing the already-configured
// GOOGLE_API_KEY - avoids adding a dedicated OCR dependency (tesseract.js
// etc.) just for this. Asks for a plain, faithful transcription rather than
// a description, since the extracted text is what gets embedded and
// retrieved, not a caption of the image.
const IMAGE_READ_PROMPT =
  "You are reading this image for a planning/architecture assistant that " +
  "must answer precise follow-up questions about it later, so accuracy " +
  "and completeness matter far more than brevity.\n\n" +
  "First, transcribe ALL text visible in the image exactly as written - " +
  "labels, headings, tables, handwriting, stamps, and revision blocks, " +
  "including small print. Do not paraphrase or skip anything.\n\n" +
  "Then, if this is a plan, elevation, section, site drawing, or other " +
  "technical/architectural drawing, work through it systematically and " +
  "describe it in plain sentences (one topic per paragraph, no markdown " +
  "or bullet symbols), covering each of the following that is present:\n" +
  "- the drawing type, title, drawing number, scale, and north " +
  "orientation if shown\n" +
  "- the site or building boundary lines, and any setback/clearance " +
  "distances\n" +
  "- every room or space shown, with its label and any stated " +
  "dimensions or area\n" +
  "- every dimension callout on the drawing, stated individually as " +
  "'<what it measures>: <value>' rather than summarized or grouped\n" +
  "- key structural or site elements: walls, doors, windows, " +
  "driveways, parking, landscaping, levels, floor-to-floor heights\n" +
  "- any legend, symbols, notes, or annotations and what they refer " +
  "to\n" +
  "- revision numbers, dates, and any approval/planning stamps\n\n" +
  "Be exhaustive - it is far better to over-describe a detail than to " +
  "omit or approximate it. If a dimension or label is hard to read, " +
  "say so explicitly rather than guessing at a value. If the image is " +
  "not a drawing (e.g. a plain document page or photo), skip the " +
  "structured description and just provide the transcription. Output " +
  "plain text only, no markdown.";

async function extractImageText(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const response = await getAI().models.generateContent({
    model: GEMINI_VISION_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { text: IMAGE_READ_PROMPT },
          {
            inlineData: {
              data: buffer.toString("base64"),
              mimeType: mimeType || "image/png",
            },
          },
        ],
      },
    ],
    // temperature 0 for careful, literal reading rather than creative
    // paraphrasing; a higher output cap so a dense, multi-element
    // drawing isn't cut off mid-description.
    config: {
      temperature: 0,
      maxOutputTokens: 8192,
    },
  });

  return String(response.text || "").trim();
}

// Returns page-numbered text: [{ page: 1, text: "..." }, ...]. DOCX/image
// uploads have no real page concept, so they come back as a single
// pseudo-page (page: null).
// Below this many non-whitespace characters, a PDF page is treated as
// having no real text layer - typical of a CAD-exported or scanned
// drawing sheet, where the page is essentially one big vector/raster
// image with a handful of stray text fragments (or none at all). Such
// pages get rasterized and read through the same vision path used for
// uploaded images, instead of being left almost empty.
const PDF_PAGE_TEXT_MIN_CHARS = 40;

// Renders one page of a PDF to a PNG using the `pdftoppm` binary
// (poppler-utils - already present in the runtime image; nothing new
// to install). This rasterizes the page exactly as it would print,
// including pages that are pure vector art with no text layer at all,
// which pdf-parse cannot read. Returns null (never throws) if the
// binary is missing or rendering fails, so callers just fall back to
// whatever text pdf-parse already found for that page.
async function renderPdfPageToPng(
  pdfBuffer: Buffer,
  pageNumber: number
): Promise<Buffer | null> {
  let tmpDir: string | null = null;
  try {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "userdoc-pdf-"));
    const pdfPath = path.join(tmpDir, "input.pdf");
    const outPrefix = path.join(tmpDir, "page");
    await fsp.writeFile(pdfPath, pdfBuffer);

    // -r 200: 200 DPI - high enough to keep small dimension text
    // legible without producing an unreasonably large image.
    await execFileAsync("pdftoppm", [
      "-png",
      "-r",
      "200",
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      pdfPath,
      outPrefix,
    ]);

    const files = await fsp.readdir(tmpDir);
    const pngName = files.find(
      (f) => f.startsWith("page") && f.endsWith(".png")
    );
    if (!pngName) return null;
    return await fsp.readFile(path.join(tmpDir, pngName));
  } catch (err) {
    console.warn(
      `renderPdfPageToPng: rendering page ${pageNumber} failed, ` +
        `falling back to text-only extraction for this page`,
      err
    );
    return null;
  } finally {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// For each PDF page, use pdf-parse's text-layer extraction when it
// found enough text; otherwise rasterize that one page and read it
// through Gemini vision (the same careful, structured prompt used for
// uploaded drawing images) so CAD-exported/scanned drawing pages still
// yield real content instead of near-nothing.
async function extractPdfPagesWithVisionFallback(
  buffer: Buffer
): Promise<Array<{ page: number; text: string }>> {
  const pages = await extractPdfPages(buffer);
  const results: Array<{ page: number; text: string }> = [];

  for (let i = 0; i < pages.length; i++) {
    const pageNumber = i + 1;
    const extracted = pages[i] || "";
    const meaningfulChars = extracted.replace(/\s+/g, "").length;

    if (meaningfulChars >= PDF_PAGE_TEXT_MIN_CHARS) {
      results.push({ page: pageNumber, text: extracted });
      continue;
    }

    const png = await renderPdfPageToPng(buffer, pageNumber);
    if (!png) {
      results.push({ page: pageNumber, text: extracted });
      continue;
    }

    try {
      const visionText = await extractImageText(png, "image/png");
      const combined = [extracted.trim(), visionText.trim()]
        .filter(Boolean)
        .join("\n\n");
      results.push({ page: pageNumber, text: combined || extracted });
    } catch (err) {
      console.warn(
        `extractPdfPagesWithVisionFallback: vision read failed for ` +
          `page ${pageNumber}, keeping text-only extraction`,
        err
      );
      results.push({ page: pageNumber, text: extracted });
    }
  }

  return results;
}

async function extractPagedText(
  buffer: Buffer,
  fileType: UserDocFileType,
  mimeType: string
): Promise<Array<{ page: number | null; text: string }>> {
  if (fileType === "pdf") {
    return extractPdfPagesWithVisionFallback(buffer);
  }
  if (fileType === "docx") {
    const text = await extractDocxText(buffer);
    return [{ page: null, text }];
  }
  if (fileType === "spreadsheet") {
    return extractSpreadsheetPages(buffer);
  }
  // image
  const text = await extractImageText(buffer, mimeType);
  return [{ page: null, text }];
}

// ---------------------------------------------------------------------------
// Chunking (same paragraph-aware, overlap-carrying approach as
// lib/chromaIngest.ts's chunkPageText())
// ---------------------------------------------------------------------------

function chunkText(pageText: string): string[] {
  const cleaned = pageText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return [];

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && current.length + para.length + 1 > CHUNK_TARGET_CHARS) {
      chunks.push(current.trim());
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP_CHARS);
      current = current.slice(overlapStart);
    }
    current = current ? `${current}\n${para}` : para;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.flatMap((c) => {
    if (c.length <= CHUNK_TARGET_CHARS * 1.5) return [c];
    const pieces: string[] = [];
    for (let i = 0; i < c.length; i += CHUNK_TARGET_CHARS) {
      pieces.push(c.slice(i, i + CHUNK_TARGET_CHARS));
    }
    return pieces;
  });
}

async function embedWithRetry(text: string, attempts = 3): Promise<number[]> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await generateEmbedding(text);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Ingestion entry point - called by app/api/documents/upload/route.ts
// ---------------------------------------------------------------------------

export interface IngestUserDocResult {
  documentId: string;
  filename: string;
  fileType: UserDocFileType;
  chunkCount: number;
  status: "ready" | "failed";
  error?: string;
}

export async function ingestUserDocument(params: {
  conversationId: string;
  visitorId: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<IngestUserDocResult> {
  const { conversationId, visitorId, filename, mimeType, buffer } = params;
  const supabase = getSupabase();

  const fileType = detectUserDocFileType(filename, mimeType);
  if (!fileType) {
    throw new Error(
      `Unsupported file type for "${filename}" - only PDF, Word, images, and spreadsheets (xlsx/xls/csv) are supported`
    );
  }

  const { data: docRow, error: docError } = await supabase
    .from("user_documents")
    .insert({
      conversation_id: conversationId,
      visitor_id: visitorId,
      filename,
      file_type: fileType,
      status: "processing",
    })
    .select("id")
    .single();

  if (docError || !docRow) {
    throw new Error(
      `Failed to create user_documents row: ${docError?.message || "unknown error"}`
    );
  }

  const documentId = docRow.id as string;

  try {
    const pages = await extractPagedText(buffer, fileType, mimeType);
    const hasText = pages.some((p) => p.text && p.text.trim().length > 0);
    if (!hasText) {
      throw new Error(
        "No readable text was found in this file (it may be a blank or purely graphical page)"
      );
    }

    const rows: Array<{
      document_id: string;
      conversation_id: string;
      chunk_index: number;
      page_number: number | null;
      content: string;
      embedding: number[];
    }> = [];

    for (const { page, text } of pages) {
      const pageChunks = chunkText(text);
      for (const content of pageChunks) {
        // Sequential + small delay between calls, same as
        // lib/chromaIngest.ts, to stay under the Gemini free-tier rate
        // limit - a single upload here is a handful of chunks at most, so
        // this stays fast in practice.
        const embedding = await embedWithRetry(content);
        rows.push({
          document_id: documentId,
          conversation_id: conversationId,
          chunk_index: rows.length,
          page_number: page,
          content,
          embedding,
        });
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (!rows.length) {
      throw new Error(
        "The extracted text was too short to index (nothing usable to search against)"
      );
    }

    const { error: insertError } = await supabase
      .from("user_document_chunks")
      .insert(rows);
    if (insertError) {
      throw new Error(`Failed inserting chunks: ${insertError.message}`);
    }

    await supabase
      .from("user_documents")
      .update({ status: "ready", chunk_count: rows.length })
      .eq("id", documentId);

    return {
      documentId,
      filename,
      fileType,
      chunkCount: rows.length,
      status: "ready",
    };
  } catch (err: any) {
    const message = err?.message || "Failed to process document";
    await supabase
      .from("user_documents")
      .update({ status: "failed", error: message })
      .eq("id", documentId);

    return {
      documentId,
      filename,
      fileType,
      chunkCount: 0,
      status: "failed",
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Retrieval - called from app/api/rag-chat/route.ts
// ---------------------------------------------------------------------------

// A "summarize this document" request has no retrievable content of
// its own - embedding-similarity search against the literal word
// "summarize" returns a near-arbitrary top-12 slice of the document,
// not comprehensive coverage of it. This instead returns every chunk
// of every ready document in the conversation, in reading order (by
// document, then chunk_index), so a summary can be built from the
// whole document. Capped so a very large upload still leaves headroom
// in the model's context alongside corpus chunks and conversation
// history.
const MAX_SUMMARY_CHUNKS = 60;

export async function getAllUserDocumentChunks(
  conversationId: string,
  maxChunks = MAX_SUMMARY_CHUNKS
): Promise<UserDocChunkMatch[]> {
  if (!conversationId) return [];

  const supabase = getSupabase();

  const { data: docs, error: docsError } = await supabase
    .from("user_documents")
    .select("id, filename, status")
    .eq("conversation_id", conversationId)
    .eq("status", "ready");

  if (docsError || !docs || !docs.length) return [];

  const filenameByDocId = new Map<string, string>(
    docs.map((d: any) => [String(d.id), String(d.filename || "your upload")])
  );

  const { data, error } = await supabase
    .from("user_document_chunks")
    .select("id, document_id, chunk_index, page_number, content")
    .eq("conversation_id", conversationId)
    .in(
      "document_id",
      docs.map((d: any) => d.id)
    )
    .order("document_id", { ascending: true })
    .order("chunk_index", { ascending: true })
    .limit(maxChunks);

  if (error || !data) {
    console.error("getAllUserDocumentChunks query error:", error);
    return [];
  }

  return data.map((row: any) => ({
    id: Number(row.id),
    document_id: String(row.document_id),
    chunk_index: Number(row.chunk_index),
    page_number:
      row.page_number === null || row.page_number === undefined
        ? null
        : Number(row.page_number),
    content: String(row.content || ""),
    // Not similarity-ranked - every chunk here was selected because it
    // IS the document, not because it scored well against a query.
    distance: 0,
    doc_filename: filenameByDocId.get(String(row.document_id)) || "your upload",
  }));
}

export async function searchUserDocumentChunks(
  conversationId: string,
  query: string,
  matchCount = 12
): Promise<UserDocChunkMatch[]> {
  if (!conversationId) return [];

  const supabase = getSupabase();

  // A conversation with no uploads (the overwhelmingly common case) should
  // cost nothing beyond this one cheap existence check - skip the
  // embedding call and RPC entirely rather than doing real work for
  // nothing.
  const { data: docs, error: docsError } = await supabase
    .from("user_documents")
    .select("id, filename, status")
    .eq("conversation_id", conversationId)
    .eq("status", "ready");

  if (docsError || !docs || !docs.length) return [];

  const filenameByDocId = new Map<string, string>(
    docs.map((d: any) => [String(d.id), String(d.filename || "your upload")])
  );

  try {
    const embedding = await generateEmbedding(query);
    const { data, error } = await supabase.rpc("match_user_document_chunks", {
      query_embedding: embedding,
      match_conversation_id: conversationId,
      match_count: matchCount,
    });

    if (error) {
      console.error("searchUserDocumentChunks RPC error:", error);
      return [];
    }

    const rows = Array.isArray(data) ? data : [];
    return rows.map((row: any) => ({
      id: Number(row.id),
      document_id: String(row.document_id),
      chunk_index: Number(row.chunk_index),
      page_number:
        row.page_number === null || row.page_number === undefined
          ? null
          : Number(row.page_number),
      content: String(row.content || ""),
      distance: typeof row.distance === "number" ? row.distance : Number(row.distance ?? 1),
      doc_filename: filenameByDocId.get(String(row.document_id)) || "your upload",
    }));
  } catch (err) {
    console.error("searchUserDocumentChunks failed (continuing without it):", err);
    return [];
  }
}
