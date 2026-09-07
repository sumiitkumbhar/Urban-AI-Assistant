// lib/domain-vocabulary.ts
//
// Speech-to-text mangles domain jargon constantly - the failure that
// prompted this: "NPPF" came back from the mic as "NPP", which then went
// into retrieval AND into the answer prompt verbatim, so the reply
// confidently discussed "NPP" throughout. Retrieval alone can't fix that,
// because RAG runs *after* the transcript is already wrong.
//
// So this sits between transcription and retrieval:
//
//   audio -> STT -> [correctDomainTerms] -> retrieval -> answer
//
// It is deliberately deterministic (no LLM call, no network, sub-millisecond)
// for three reasons: this runs on the hot path of every single query; an LLM
// rewriting transcripts invisibly is exactly how a regulatory assistant
// starts quietly answering a different question than the one asked; and the
// whole point of the fix was latency-neutrality.
//
// Vocabulary comes from two real sources, not an invented word list:
//   1. The UK planning/building-regs terms this corpus is actually built on
//      (documents-to-ingest/National_Planning_Policy_Framework.pdf and the
//      Local Plan corpus - see claude/uk-council-corpus-pipeline.md).
//   2. Every English local planning authority name in
//      data/uk-lpa-tracker.csv (~500 councils), read at runtime.
//
// Corrections are returned, never applied silently - the caller surfaces
// them so a wrong guess is visible and challengeable rather than buried.

import fs from "fs";
import path from "path";

export interface DomainTerm {
  /** The correct surface form, spelled and cased as it should appear. */
  canonical: string;
  /**
   * "acronym" gets prefix/truncation rules (the NPP -> NPPF case, where STT
   * drops trailing letters); "phrase" gets whole-window similarity matching.
   */
  kind: "acronym" | "phrase";
}

export interface TermCorrection {
  /** Exactly what the user's transcript said. */
  from: string;
  /** What it was corrected to. */
  to: string;
  /** 0-1. Higher means a safer, more obvious correction. */
  confidence: number;
}

export interface CorrectionResult {
  correctedQuery: string;
  corrections: TermCorrection[];
}

// =============================================================================
// STATIC DOMAIN VOCABULARY
// =============================================================================
//
// The jargon this assistant's corpus is written in. Acronyms are the high-
// value entries: they're what STT gets wrong most (short, letter-by-letter,
// no dictionary support) and what changes an answer's meaning most.

const ACRONYMS: string[] = [
  // Core national policy - NPPF is the single most important term here.
  "NPPF",
  "PPG",
  "GPDO",
  "UCO",
  "DCO",
  "NSIP",
  // Plan-making
  "LPA",
  "SPD",
  "DPD",
  "LDF",
  "AMR",
  "SHLAA",
  "SHMA",
  // Obligations, levies, consents
  "CIL",
  "TPO",
  "CPO",
  "LDC",
  "HMO",
  "EPC",
  // Environment and assessment
  "BNG",
  "EIA",
  "SEA",
  "HRA",
  "SSSI",
  "AONB",
  "SuDS",
  // Standards and departments
  "NDSS",
  "BREEAM",
  "MHCLG",
  "DLUHC",
];

const PHRASES: string[] = [
  // Policy instruments people ask about by name
  "National Planning Policy Framework",
  "Planning Practice Guidance",
  "Local Plan",
  "Neighbourhood Plan",
  "Development Plan",
  "Article 4 Direction",
  "Permitted Development",
  "Prior Approval",
  "Change of Use",
  "Green Belt",
  "Conservation Area",
  "Listed Building",
  "Tree Preservation Order",
  "Community Infrastructure Levy",
  "Biodiversity Net Gain",
  "Use Classes Order",
  "Lawful Development Certificate",
  "Compulsory Purchase Order",
  // Statutory references spoken as words
  "Section 106",
  "Section 73",
  "Section 78",
  // Building regulations - Approved Documents get asked about by letter
  "Approved Document B",
  "Approved Document L",
  "Approved Document M",
  "Approved Document K",
  "Building Regulations",
  "Fire Safety",
  "Means of Escape",
];

// =============================================================================
// GUARDS
// =============================================================================
//
// Ordinary English words are never corrected, whatever they resemble.
// Without this, "seal the gap" becomes "CIL the gap", "come back later"
// becomes "come back LDF", and the assistant starts hallucinating jargon
// into plain sentences - a far worse failure than the one being fixed.

const COMMON_WORDS = new Set<string>([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any",
  "are", "aren", "as", "ask", "at", "back", "bath", "be", "been", "before",
  "being", "best",
  "but", "buy", "by", "call", "can", "cost", "could", "did", "do", "does",
  "doing", "done", "down", "each", "even", "ever", "every", "few", "find",
  "first", "for", "from", "get", "give", "go", "good", "great", "had", "has",
  "have", "he", "help", "her", "here", "him", "his", "how", "i", "if", "in",
  "into", "is", "it", "its", "just", "know", "land", "last", "later", "law",
  "let", "like", "long", "look", "made", "make", "many", "may", "me", "mean",
  "might", "min", "more", "most", "much", "must", "my", "need", "new", "next",
  "no", "not", "now", "of", "off", "on", "one", "only", "or", "other", "our",
  "out", "over", "own", "part", "per", "plan", "put", "rate", "read",
  "reading", "real", "rule", "said", "same", "sale", "say", "see", "seal",
  "set", "she", "should", "show", "side", "site", "size", "so", "some", "such",
  "sure", "take", "tell", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "thing", "think", "this", "those", "to", "told",
  "too", "top", "try", "two", "under", "up", "us", "use", "used", "very",
  "want", "was", "way", "we", "well", "were", "what", "when", "where",
  "which", "while", "who", "why", "will", "with", "work", "would", "yes",
  "yet", "you", "your",
  // Short words that look like acronym fragments if you squint.
  "ave", "cut", "day", "due", "end", "fit", "fix", "got", "gap", "hot",
  "key", "lot", "low", "mid", "old", "pay", "run", "sea",
  "sew", "sit", "six", "ten", "tip", "ton", "win",
]);

// =============================================================================
// LPA NAMES (loaded from the repo's own tracker)
// =============================================================================

let lpaTermsCache: DomainTerm[] | null = null;

/**
 * Council names from data/uk-lpa-tracker.csv - the same list the ingestion
 * pipeline works from, so what gets corrected to is always something the
 * corpus is actually tagged with.
 *
 * Read once and cached. Any failure (file missing in a deployment that
 * doesn't ship data/, unreadable, malformed) returns an empty list rather
 * than throwing - a missing council list must degrade correction quality,
 * never break the chat.
 */
function loadLpaTerms(): DomainTerm[] {
  if (lpaTermsCache) return lpaTermsCache;

  const terms: DomainTerm[] = [];
  try {
    const csvPath = path.join(process.cwd(), "data", "uk-lpa-tracker.csv");
    const raw = fs.readFileSync(csvPath, "utf-8");
    const lines = raw.split(/\r?\n/).slice(1); // drop header
    const seen = new Set<string>();

    for (const line of lines) {
      if (!line.trim()) continue;
      // lpa_name is the first column. Handle a quoted first field defensively.
      let name: string;
      if (line.startsWith('"')) {
        const end = line.indexOf('"', 1);
        name = end > 0 ? line.slice(1, end) : line.split(",")[0];
      } else {
        name = line.split(",")[0];
      }
      name = name.trim();
      if (!name) continue;

      const add = (value: string) => {
        const key = value.toLowerCase();
        if (!value || seen.has(key)) return;
        // Single-word short names that are ordinary English ("Reading",
        // "Bath") would attract nonsense corrections - the full council
        // name still covers those places.
        if (!value.includes(" ") && (value.length < 5 || COMMON_WORDS.has(key))) {
          return;
        }
        seen.add(key);
        terms.push({ canonical: value, kind: "phrase" });
      };

      add(name);

      // People say "Tower Hamlets", not "London Borough of Tower Hamlets
      // Council" - index the distinctive part too.
      const shortName = name
        .replace(/^London Borough of\s+/i, "")
        .replace(/^Royal Borough of\s+/i, "")
        .replace(/^City of\s+/i, "")
        .replace(
          /\s+(County|Borough|District|City|Metropolitan|Unitary)?\s*Council$/i,
          ""
        )
        .trim();
      if (shortName !== name) add(shortName);
    }
  } catch {
    // Intentionally silent - see docstring.
  }

  lpaTermsCache = terms;
  return terms;
}

let vocabularyCache: DomainTerm[] | null = null;

function getVocabulary(): DomainTerm[] {
  if (vocabularyCache) return vocabularyCache;
  vocabularyCache = [
    ...ACRONYMS.map((canonical) => ({ canonical, kind: "acronym" as const })),
    ...PHRASES.map((canonical) => ({ canonical, kind: "phrase" as const })),
    ...loadLpaTerms(),
  ];
  return vocabularyCache;
}

// =============================================================================
// STRING SIMILARITY
// =============================================================================

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

// =============================================================================
// TOKENIZATION
// =============================================================================

/**
 * Collapses letter-by-letter dictation into the acronym it was meant to be:
 * "n p p f" / "N.P.P.F." / "n-p-p-f" -> "nppf". Whisper and the browser's
 * recognizer both do this when someone enunciates an acronym clearly, which
 * is exactly when they're *trying* to be understood.
 */
function collapseSpelledOutLetters(text: string): string {
  return text
    .replace(/\b(?:[a-zA-Z][.\-]){2,}[a-zA-Z]\b\.?/g, (match) =>
      match.replace(/[.\-]/g, "")
    )
    .replace(/\b(?:[a-zA-Z]\s+){1,7}[a-zA-Z]\b/g, (match) => {
      const letters = match.trim().split(/\s+/);
      // Only collapse runs of 3+ single letters. Two in a row ("a b") is
      // far more likely to be ordinary text than a dictated acronym.
      return letters.length >= 3 ? letters.join("") : match;
    });
}

interface Candidate {
  term: DomainTerm;
  confidence: number;
}

/**
 * Scores how likely `token` is a mangled rendering of `term`.
 * Returns null when it isn't a plausible match at all.
 */
function scoreMatch(token: string, term: DomainTerm): Candidate | null {
  const lowerToken = token.toLowerCase();
  const lowerCanonical = term.canonical.toLowerCase();

  // Already correct.
  if (lowerToken === lowerCanonical) return null;

  if (term.kind === "acronym") {
    // Acronyms are only ever confused with other short alphanumeric runs.
    if (!/^[a-z0-9]{3,8}$/.test(lowerToken)) return null;

    // The headline case: STT dropped trailing characters. "NPP" -> "NPPF".
    //
    // Both length floors matter. Tokens shorter than 3 characters are
    // essentially always ordinary English ("am", "is", "to"), and treating
    // them as acronym fragments turned "I am reading" into "I AMR reading"
    // in testing. Canonicals shorter than 4 give a prefix rule nothing
    // meaningful to match on.
    if (
      lowerCanonical.length >= 4 &&
      lowerCanonical.startsWith(lowerToken) &&
      lowerCanonical.length - lowerToken.length <= 2
    ) {
      return { term, confidence: 0.95 };
    }

    // Same length, one character wrong: "NPPS" -> "NPPF". Restricted to
    // canonicals of 4+ so a three-letter acronym can't swallow a
    // one-character-off English word ("sew" -> "SEA").
    if (
      lowerCanonical.length >= 4 &&
      lowerToken.length === lowerCanonical.length &&
      levenshtein(lowerToken, lowerCanonical) === 1
    ) {
      return { term, confidence: 0.85 };
    }

    // One character inserted or dropped mid-word, for canonicals long
    // enough that this isn't just noise.
    if (
      lowerCanonical.length >= 5 &&
      Math.abs(lowerToken.length - lowerCanonical.length) === 1 &&
      levenshtein(lowerToken, lowerCanonical) === 1
    ) {
      return { term, confidence: 0.82 };
    }

    return null;
  }

  // Phrases (council names, policy instrument names): whole-window
  // similarity. The floor here is deliberately below the caller's
  // threshold - scoreMatch decides "is this plausible at all", the caller
  // decides "is this confident enough to act on", and only the caller
  // knows whether this was a voice transcript.
  if (lowerCanonical.length < 5) return null;
  const score = similarity(lowerToken, lowerCanonical);
  if (score >= 0.8) return { term, confidence: score };
  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

let canonicalByLowerCache: Map<string, string> | null = null;

/** Every canonical term keyed by its lowercase form, for casing lookups. */
function canonicalByLower(): Map<string, string> {
  if (canonicalByLowerCache) return canonicalByLowerCache;
  const map = new Map<string, string>();
  for (const term of getVocabulary()) {
    map.set(term.canonical.toLowerCase(), term.canonical);
  }
  canonicalByLowerCache = map;
  return map;
}

interface PhraseMatch {
  start: number;
  end: number;
  original: string;
  canonical: string;
  confidence: number;
}

/**
 * Matches multi-word terms across token windows, so "tower hamlet planning"
 * finds "Tower Hamlets" even though no single token resembles it. Without
 * this pass the ~500 council names in the tracker are dead weight, since
 * every one of them is multi-word.
 *
 * Overlapping candidates are resolved highest-confidence-first, and
 * replacements are spliced right-to-left so earlier spans keep their
 * offsets.
 */
function correctPhrases(
  text: string,
  vocabulary: DomainTerm[],
  threshold: number
): { text: string; corrections: TermCorrection[] } {
  const multiWord = vocabulary.filter(
    (t) => t.canonical.includes(" ") && t.canonical.length >= 8
  );
  if (!multiWord.length) return { text, corrections: [] };

  const tokens: { value: string; start: number; end: number }[] = [];
  const tokenPattern = /[A-Za-z0-9][A-Za-z0-9'-]*/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    tokens.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const candidates: PhraseMatch[] = [];
  const maxWindow = 4;

  for (let i = 0; i < tokens.length; i++) {
    for (let size = 2; size <= maxWindow && i + size <= tokens.length; size++) {
      const start = tokens[i].start;
      const end = tokens[i + size - 1].end;
      const windowText = text.slice(start, end);
      const lowerWindow = windowText.toLowerCase();

      for (const term of multiWord) {
        const lowerCanonical = term.canonical.toLowerCase();
        // Cheap rejects before paying for edit distance: this runs across
        // ~500 council names on every query.
        if (Math.abs(lowerWindow.length - lowerCanonical.length) > 4) continue;
        if (lowerWindow[0] !== lowerCanonical[0]) continue;

        if (lowerWindow === lowerCanonical) {
          if (windowText !== term.canonical) {
            candidates.push({
              start,
              end,
              original: windowText,
              canonical: term.canonical,
              confidence: 1,
            });
          }
          continue;
        }

        const score = similarity(lowerWindow, lowerCanonical);
        if (score >= Math.max(threshold, 0.85)) {
          candidates.push({
            start,
            end,
            original: windowText,
            canonical: term.canonical,
            confidence: score,
          });
        }
      }
    }
  }

  if (!candidates.length) return { text, corrections: [] };

  candidates.sort((a, b) => b.confidence - a.confidence);
  const accepted: PhraseMatch[] = [];
  for (const candidate of candidates) {
    const overlaps = accepted.some(
      (a) => candidate.start < a.end && a.start < candidate.end
    );
    if (!overlaps) accepted.push(candidate);
  }

  accepted.sort((a, b) => b.start - a.start);
  let result = text;
  const corrections: TermCorrection[] = [];
  for (const item of accepted) {
    result =
      result.slice(0, item.start) + item.canonical + result.slice(item.end);
    // Pure casing normalization isn't a correction - nothing was misheard.
    if (item.original.toLowerCase() !== item.canonical.toLowerCase()) {
      corrections.push({
        from: item.original,
        to: item.canonical,
        confidence: Number(item.confidence.toFixed(2)),
      });
    }
  }

  return { text: result, corrections };
}

export interface CorrectOptions {
  /**
   * Voice transcripts earn a slightly lower bar - mishearing is the
   * expected failure mode there, whereas typed text is usually deliberate.
   */
  voiceMode?: boolean;
}

/**
 * Corrects domain terms the speech recognizer (or a typo) mangled, using
 * only vocabulary this corpus actually contains.
 *
 * Every correction is reported back so the caller can show it. Nothing here
 * rewrites meaning: it only ever swaps a token for a known domain term it
 * closely resembles, and never touches ordinary English words.
 */
export function correctDomainTerms(
  query: string,
  options: CorrectOptions = {}
): CorrectionResult {
  const original = query ?? "";
  if (!original.trim()) {
    return { correctedQuery: original, corrections: [] };
  }

  const threshold = options.voiceMode ? 0.82 : 0.9;
  const vocabulary = getVocabulary();

  const collapsed = collapseSpelledOutLetters(original);
  const corrections: TermCorrection[] = [];

  // Multi-word terms first ("tower hamlet" -> "Tower Hamlets", "green bell"
  // -> "Green Belt"). Runs before the single-token pass so a phrase isn't
  // half-rewritten token by token.
  const phraseResult = correctPhrases(collapsed, vocabulary, threshold);
  corrections.push(...phraseResult.corrections);
  const afterPhrases = phraseResult.text;
  // One decision per distinct token, applied to every occurrence - the
  // original bug was the wrong term repeating throughout an answer, so a
  // half-corrected query would just reproduce it.
  const decided = new Map<string, string | null>();

  const correctedQuery = afterPhrases.replace(
    /[A-Za-z0-9][A-Za-z0-9'-]*/g,
    (token) => {
    const lower = token.toLowerCase();

    if (decided.has(lower)) {
      const decision = decided.get(lower);
      return decision ?? token;
    }

    // Ordinary English is left alone, always - and this check has to come
    // first, before even the casing pass below. "SEA" (Strategic
    // Environmental Assessment) is a real term in this vocabulary, and
    // without this ordering "the sea view from the site" came back as "the
    // SEA view from the site" in testing.
    if (COMMON_WORDS.has(lower) || token.length < 2) {
      decided.set(lower, null);
      return token;
    }

    // A term that's already right but miscased ("nppf", after letter-by-letter
    // dictation was collapsed) gets normalized to house spelling. Nothing was
    // misheard, so it isn't reported as a correction.
    const exact = canonicalByLower().get(lower);
    if (exact) {
      decided.set(lower, exact === token ? null : exact);
      return exact;
    }

    let best: Candidate | null = null;
    for (const term of vocabulary) {
      // Multi-word phrases can't match a single token.
      if (term.kind === "phrase" && term.canonical.includes(" ")) continue;
      const candidate = scoreMatch(token, term);
      if (candidate && (!best || candidate.confidence > best.confidence)) {
        best = candidate;
      }
    }

    if (best && best.confidence >= threshold) {
      decided.set(lower, best.term.canonical);
      corrections.push({
        from: token,
        to: best.term.canonical,
        confidence: Number(best.confidence.toFixed(2)),
      });
      return best.term.canonical;
    }

    decided.set(lower, null);
    return token;
    }
  );

  return { correctedQuery, corrections };
}
