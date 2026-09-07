/**
 * Text chunking for ingestion.
 *
 * Lives in its own module with no imports so it can be exercised directly
 * against a real document (scripts/chunk-boundary.test.ts) without dragging in
 * Supabase, the embedding client or Next's "@/" path alias.
 */

export const CHUNK_TARGET_CHARS = 1100;
export const CHUNK_OVERLAP_CHARS = 150;

export function chunkPageText(pageText: string): string[] {
  const cleaned = pageText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return [];

  // Split on paragraph breaks first, then greedily pack paragraphs into
  // ~CHUNK_TARGET_CHARS chunks so we don't cut mid-sentence when we can
  // avoid it. A small overlap is carried into the next chunk so a claim
  // that straddles a chunk boundary is still retrievable from either side.
  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return [];

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 1) > CHUNK_TARGET_CHARS) {
      chunks.push(current.trim());
      current = tailFrom(current, CHUNK_OVERLAP_CHARS);
    }
    current = current ? `${current}\n${para}` : para;
  }
  if (current.trim()) chunks.push(current.trim());

  // A single paragraph longer than the target on its own - hard-split it.
  return chunks.flatMap((c) =>
    c.length <= CHUNK_TARGET_CHARS * 1.5 ? [c] : hardSplit(c)
  );
}

/**
 * The last ~`chars` characters of `text`, started at a boundary a reader
 * would recognise.
 *
 * Taking `text.slice(text.length - chars)` outright is what produced chunks
 * beginning "utside of the settlement boundary" in the live corpus - the
 * offset landed inside "outside" and took the tail. That costs twice: the
 * citation shown to the user is visibly broken, and the embedding is computed
 * over a fragment whose first token is a word that does not exist.
 *
 * Prefers a sentence start, falls back to a word start, and never returns
 * more than double the requested length while looking for one.
 */
export function tailFrom(text: string, chars: number): string {
  if (text.length <= chars) return text;

  const raw = text.length - chars;
  const window = text.slice(Math.max(0, raw - chars));
  const offsetOfWindow = Math.max(0, raw - chars);

  // A sentence boundary inside the window, at or after the raw offset.
  const sentence = /[.!?:;]\s+|\n/g;
  let best = -1;
  let m: RegExpExecArray | null;
  while ((m = sentence.exec(window)) !== null) {
    const abs = offsetOfWindow + m.index + m[0].length;
    if (abs >= raw) { best = abs; break; }
    best = abs;
  }
  if (best >= 0 && text.length - best >= chars / 3) return text.slice(best).trimStart();

  // Otherwise the next word boundary at or after the raw offset.
  const space = text.indexOf(" ", raw);
  if (space !== -1) return text.slice(space + 1);

  return text.slice(raw).replace(/^\S+\s*/, "");
}

/**
 * Splits an over-long paragraph without cutting a word in half at either end.
 * Breaks at the last sentence end inside the budget, else the last space.
 */
export function hardSplit(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;

  while (rest.length > CHUNK_TARGET_CHARS) {
    const budget = rest.slice(0, CHUNK_TARGET_CHARS);
    let cut = Math.max(
      budget.lastIndexOf(". "),
      budget.lastIndexOf("; "),
      budget.lastIndexOf(": "),
      budget.lastIndexOf("\n")
    );
    // Only honour a sentence break if it is not so early that it wastes the
    // chunk; otherwise fall back to the last whitespace.
    if (cut < CHUNK_TARGET_CHARS * 0.5) cut = budget.lastIndexOf(" ");
    if (cut <= 0) cut = CHUNK_TARGET_CHARS; // one unbroken token - nothing to do

    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trimStart();
  }

  if (rest.trim()) pieces.push(rest.trim());
  return pieces;
}
