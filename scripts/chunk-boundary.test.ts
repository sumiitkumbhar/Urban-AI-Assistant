/**
 * Chunk boundaries must not cut words in half.
 *
 * The live corpus contains a chunk beginning "utside of the settlement
 * boundary" - the overlap was taken with a raw character offset that landed
 * inside "outside". That is not only an ugly citation: the embedding is
 * computed over a fragment whose first token is a word that does not exist,
 * so the chunk is both harder to retrieve and misleading when shown.
 *
 * This runs the REAL chunker over the REAL document and asserts that no chunk
 * starts or ends on a broken word. A word is "broken" if the chunk boundary
 * falls inside one - detected by checking the character in the source text
 * immediately outside the boundary.
 *
 *   ./node_modules/.bin/tsc --target es2020 --module commonjs \
 *     --moduleResolution node --esModuleInterop --skipLibCheck \
 *     --outDir .tmp-test scripts/chunk-boundary.test.ts \
 *   && node .tmp-test/scripts/chunk-boundary.test.js <path-to-extracted.txt>
 */
import fs from "fs";
import { chunkPageText } from "../lib/chunkText";

const file = process.argv[2];
if (!file) {
  console.error("usage: chunk-boundary.test.js <extracted-text-file>");
  process.exit(1);
}
const text = fs.readFileSync(file, "utf-8");
const pages = text.split(/\f/).filter((p) => p.trim());

// Normalised the same way chunkPageText normalises, so token lookups line up.
const source = " " + text.replace(/\s+/g, " ").trim() + " ";

/**
 * A boundary token is intact if it appears in the source delimited by
 * whitespace. Tokens are taken whole - hyphens, digits, URLs and trailing
 * punctuation included - because "sub-paragraphs", "up-to-date" and
 * "http://x.com/mhclg" are single words, and stripping their punctuation
 * invents breaks that are not there.
 */
function intact(token: string): boolean {
  if (!token || token.length < 3) return true;
  return source.includes(" " + token + " ");
}

function audit(label: string, chunker: (p: string) => string[]) {
  let total = 0;
  const broken: string[] = [];
  for (const page of pages) {
    for (const chunk of chunker(page)) {
      total++;
      const tokens = chunk.trim().split(/\s+/);
      const first = tokens[0];
      const last = tokens[tokens.length - 1];
      if (!intact(first)) broken.push(`STARTS "${chunk.slice(0, 55).replace(/\s+/g, " ")}…"`);
      else if (!intact(last)) broken.push(`ENDS "…${chunk.slice(-55).replace(/\s+/g, " ")}"`);
    }
  }
  console.log(`\n${label}: ${total} chunks, ${broken.length} with a boundary inside a word`);
  broken.slice(0, 8).forEach((b) => console.log("   - " + b));
  return broken.length;
}

// The chunker as it was when the live corpus was built, reproduced here so the
// difference is measured rather than asserted.
const T = 1100, O = 150;
function oldChunker(pageText: string): string[] {
  const cleaned = pageText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return [];
  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return [];
  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (current && current.length + para.length + 1 > T) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - O));
    }
    current = current ? `${current}\n${para}` : para;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.flatMap((c) => {
    if (c.length <= T * 1.5) return [c];
    const pieces: string[] = [];
    for (let i = 0; i < c.length; i += T) pieces.push(c.slice(i, i + T));
    return pieces;
  });
}

const before = audit("OLD chunker (what built the live corpus)", oldChunker);
const after = audit("NEW chunker", chunkPageText);

console.log(`\n${before} -> ${after}`);
if (after > 0) {
  console.log("FAIL: the new chunker still cuts words.");
  process.exit(1);
}
console.log("PASS: no chunk begins or ends inside a word.");
