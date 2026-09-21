// lib/citationCompletion.ts
//
// Cloud mode's counterpart to local-rag/retrieve.py's
// get_complete_citation_text() - same problem, same algorithm, ported
// from Python because this pipeline (app/api/rag-chat/route.ts) is a
// completely separate backend (Supabase + Google embeddings + Groq, no
// Python in the loop at all). See that Python docstring for the full
// motivation; the short version: a chunk is a fixed-size retrieval
// window, not paragraph-aligned, so its raw text routinely starts or
// ends mid-sentence - and a policy clause read incomplete can read as
// saying the opposite of what it actually says. Most citations are
// never manually expanded, so this has to run by default on every one,
// not be an opt-in "show more" click.
//
// stitchAdjacentChunks() in route.ts was an earlier attempt at this,
// but it only ever looks forward (never backward, so a cut-off START is
// never fixed), and it can only stitch chunks that happened to already
// be in the similarity-search result set - not the document's true
// next/previous chunk, which usually isn't a close semantic match to
// the query and so was never retrieved at all. This version fetches the
// real neighbors directly from the `chunks` table by (document_id,
// chunk_index) - the same ordering column local-rag's ingest.py assigns
// (chunkIndex is a stable 0-based running count per document, set once
// at ingestion by lib/chromaIngest.ts's buildChunkRows()) - so "the next
// chunk" here means the actual next chunk of the actual document, not a
// coincidence of what else scored well for this query.

export const MAX_EXPANSION_CHUNKS = 6;
export const MAX_EXPANSION_CHARS = 6000;

// A capital letter, a digit (numbered clause, e.g. "12.3(a)"), an
// opening quote/bracket, or a bullet/dash marker - what a genuine
// sentence or clause is expected to start with. Mirrors local-rag/
// retrieve.py's _SENTENCE_START_RE exactly.
const SENTENCE_START_RE = /^[A-Z0-9"‘’“(\[•–—-]/;

// A boundary between one sentence and the next: terminal punctuation, an
// optional closing quote/bracket, then whitespace (or end of text).
// Mirrors _SENTENCE_BOUNDARY_RE.
const SENTENCE_BOUNDARY_RE = /[.!?]['")’”\]]*(?:\s+|$)/g;

// Mirrors ExpandableCitation.tsx's looksTruncated() tail heuristic (and
// local-rag/retrieve.py's _DANGLING_TAIL_RE/_LIST_STUB_RE) so all three
// layers - this backend, local-rag's backend, and the frontend fallback
// - agree on what "ends cleanly" means. Kept in sync deliberately rather
// than factored into one shared module, since this one lives in a
// Next.js route and the frontend one is a separate bundle.
const DANGLING_TAIL_RE =
  /\b(and|or|to|of|for|with|including|which|that|where|when|if|than|see|paragraph|paragraphs)$/i;
const LIST_STUB_RE = /^(\d+\.|[a-z]\.)$/i;

function startsCleanly(text: string): boolean {
  const t = text.replace(/^\s+/, "");
  return !t || SENTENCE_START_RE.test(t);
}

function endsCleanly(text: string): boolean {
  const t = text.replace(/\s+$/, "");
  if (!t) return true;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : t;
  if (DANGLING_TAIL_RE.test(lastLine)) return false;
  if (/[:;,(-]$/.test(lastLine)) return false;
  if (LIST_STUB_RE.test(lastLine)) return false;
  return /[.!?"’”)\]]$/.test(lastLine);
}

// Returns [trimmedText, foundBoundary] - foundBoundary is false if there
// was nothing to trim to, meaning the caller should not claim
// completeness. Mirrors _trim_to_sentence_start/_trim_to_sentence_end.
function trimToSentenceStart(text: string): [string, boolean] {
  if (startsCleanly(text)) return [text, true];
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  const match = SENTENCE_BOUNDARY_RE.exec(text);
  if (!match) return [text, false];
  return [text.slice(match.index + match[0].length), true];
}

function trimToSentenceEnd(text: string): [string, boolean] {
  if (endsCleanly(text)) return [text, true];
  const matches = [...text.matchAll(SENTENCE_BOUNDARY_RE)];
  if (matches.length === 0) return [text, false];
  const last = matches[matches.length - 1];
  const end = last.index + last[0].length;
  return [text.slice(0, end).replace(/\s+$/, ""), true];
}

// Joins two adjacent chunks' text, removing the duplicated overlap
// lib/chunkText.ts's chunkPageText() deliberately carries into the next
// chunk for embedding continuity. Mirrors local-rag/retrieve.py's
// _merge_overlap() exactly - finds the longest suffix of `a` that's
// also a prefix of `b`, within maxOverlap, and drops it from `b` before
// joining. Falls back to a plain join if no overlap is found (the two
// chunks aren't actually textually adjacent, just index-adjacent -
// harmless, just means no text is trimmed).
export function mergeOverlap(a: string, b: string, maxOverlap: number): string {
  const cap = Math.min(maxOverlap, a.length, b.length);
  for (let overlapLen = cap; overlapLen > 0; overlapLen--) {
    if (a.slice(-overlapLen) === b.slice(0, overlapLen)) {
      return a + b.slice(overlapLen);
    }
  }
  return `${a}\n\n${b}`;
}

export interface ChunkRow {
  chunk_index: number;
  content: string;
  page: string | null;
}

export interface CompleteCitationResult {
  text: string;
  completeBefore: boolean;
  completeAfter: boolean;
  expandedBefore: boolean;
  expandedAfter: boolean;
  pageStart: string | null;
  pageEnd: string | null;
}

// Given every row Postgres returned within a queried index range (which
// may contain gaps - a chunk row could be missing from a partial
// re-ingest), extracts the maximal run of chunks that are genuinely
// CONSECUTIVE starting from the chunk immediately next to `anchorIndex`
// - stopping at the first gap, exactly like local-rag/retrieve.py's
// walk() does with its own "neighbor.sha256 != target.sha256 -> break".
// A non-consecutive later chunk (index 5 when 4 is missing) isn't
// actually adjacent text, so pulling it in would stitch together two
// passages that were never next to each other in the source document.
function contiguousRun(
  rows: ChunkRow[],
  anchorIndex: number,
  direction: "before" | "after"
): ChunkRow[] {
  const byIndex = new Map(rows.map((r) => [r.chunk_index, r]));
  const result: ChunkRow[] = [];
  if (direction === "before") {
    let idx = anchorIndex - 1;
    while (byIndex.has(idx)) {
      result.unshift(byIndex.get(idx)!);
      idx--;
    }
  } else {
    let idx = anchorIndex + 1;
    while (byIndex.has(idx)) {
      result.push(byIndex.get(idx)!);
      idx++;
    }
  }
  return result;
}

// fetchRange(documentId, fromIndex, toIndex) should return every row
// Postgres has for that document in that chunk_index range (order
// doesn't matter - contiguousRun sorts it out), or [] on any failure.
// Never throws: a lookup failure just means this citation keeps its
// original, unexpanded text - same fail-open behavior as local-rag's
// wtpsplit-missing fallback, not a request-failing error.
export async function getCompleteCitationText(
  documentId: number,
  chunkIndex: number,
  content: string,
  page: string | null,
  fetchRange: (
    documentId: number,
    fromIndex: number,
    toIndex: number
  ) => Promise<ChunkRow[]>,
  maxExpansionChunks: number = MAX_EXPANSION_CHUNKS,
  maxExpansionChars: number = MAX_EXPANSION_CHARS
): Promise<CompleteCitationResult> {
  let text = content;
  let completeBefore = startsCleanly(text);
  let completeAfter = endsCleanly(text);
  let expandedBefore = false;
  let expandedAfter = false;
  let pageStart = page;
  let pageEnd = page;

  if (!completeBefore) {
    try {
      const rows = await fetchRange(
        documentId,
        chunkIndex - maxExpansionChunks,
        chunkIndex - 1
      );
      const before = contiguousRun(rows, chunkIndex, "before");
      if (before.length > 0) {
        expandedBefore = true;
        pageStart = before[0].page ?? pageStart;
        let stitchedBefore = before[0].content;
        for (let i = 1; i < before.length; i++) {
          stitchedBefore = mergeOverlap(stitchedBefore, before[i].content, 150);
        }
        const combined = mergeOverlap(stitchedBefore, text, 150);
        let [trimmed, found] = trimToSentenceStart(combined);
        if (trimmed.length - text.length > maxExpansionChars) {
          trimmed = trimmed.slice(-(maxExpansionChars + text.length));
          found = false;
        }
        text = trimmed;
        completeBefore = found;
      }
    } catch {
      // Fail open - keep the original text, unexpanded on this side.
    }
  }

  if (!completeAfter) {
    try {
      const rows = await fetchRange(
        documentId,
        chunkIndex + 1,
        chunkIndex + maxExpansionChunks
      );
      const after = contiguousRun(rows, chunkIndex, "after");
      if (after.length > 0) {
        expandedAfter = true;
        pageEnd = after[after.length - 1].page ?? pageEnd;
        let stitchedAfter = after[0].content;
        for (let i = 1; i < after.length; i++) {
          stitchedAfter = mergeOverlap(stitchedAfter, after[i].content, 150);
        }
        const combined = mergeOverlap(text, stitchedAfter, 150);
        let [trimmed, found] = trimToSentenceEnd(combined);
        if (trimmed.length - text.length > maxExpansionChars) {
          trimmed = trimmed.slice(0, text.length + maxExpansionChars);
          found = false;
        }
        text = trimmed;
        completeAfter = found;
      }
    } catch {
      // Fail open - keep the original text, unexpanded on this side.
    }
  }

  return {
    text,
    completeBefore,
    completeAfter,
    expandedBefore,
    expandedAfter,
    pageStart,
    pageEnd,
  };
}
