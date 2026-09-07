/**
 * Council scope router - routing table test.
 *
 * Mirrors routeCouncilScope() in app/api/rag-chat/route.ts. Deterministic and
 * offline: no database, no network, no LLM. The point of the router is that it
 * is reproducible, so it can and should be tested this way.
 *
 * Run from the repo root (cwd matters - the LPA list is read from
 * ./data/uk-lpa-tracker.csv):
 *
 *   ./node_modules/.bin/tsc --target es2020 --module commonjs \
 *     --moduleResolution node --esModuleInterop --skipLibCheck \
 *     --outDir .tmp-test scripts/council-router.test.ts lib/domain-vocabulary.ts \
 *   && node .tmp-test/scripts/council-router.test.js
 *
 * --esModuleInterop is not optional. Without it `import fs from "fs"` compiles
 * to an undefined default, loadLpaTerms() throws into its silent catch, the LPA
 * index comes back empty and EVERY council case quietly routes to NATIONAL -
 * which looks exactly like a broken matcher. Next.js sets this flag itself; a
 * hand-rolled tsc invocation does not.
 */
import { resolveCouncils, isLocalityDependent } from "../lib/domain-vocabulary";

type RouteKind =
  | "NATIONAL"
  | "COUNCIL_SPECIFIC"
  | "COMPARISON"
  | "COUNCIL_AMBIGUOUS";

function route(query: string): { kind: RouteKind; slugs: string[] } {
  const { matches } = resolveCouncils(query);
  if (matches.length >= 2)
    return { kind: "COMPARISON", slugs: matches.map((m) => m.slug) };
  if (matches.length === 1)
    return { kind: "COUNCIL_SPECIFIC", slugs: [matches[0].slug] };
  if (isLocalityDependent(query)) return { kind: "COUNCIL_AMBIGUOUS", slugs: [] };
  return { kind: "NATIONAL", slugs: [] };
}

interface Case {
  query: string;
  kind: RouteKind;
  slugs?: string[];
  why?: string;
}

const CASES: Case[] = [
  // --- Case B: national policy, no local dimension --------------------------
  { query: "What does the NPPF say about green belt development?", kind: "NATIONAL" },
  { query: "What is the presumption in favour of sustainable development?", kind: "NATIONAL" },
  { query: "Explain paragraph 11 of the NPPF", kind: "NATIONAL" },

  // --- Case A: exactly one authority named ----------------------------------
  { query: "What is Reading's policy on affordable housing?", kind: "COUNCIL_SPECIFIC", slugs: ["reading"] },
  { query: "Reading Borough Council minimum space standards", kind: "COUNCIL_SPECIFIC", slugs: ["reading"] },
  { query: "What are the rules in Tower Hamlets for basement extensions?", kind: "COUNCIL_SPECIFIC", slugs: ["tower-hamlets"] },
  { query: "Durham County Council housing land supply", kind: "COUNCIL_SPECIFIC", slugs: ["durham"] },

  // --- Case C: two or more authorities, answered separately, never merged ---
  { query: "How does Reading compare with Wokingham on affordable housing?", kind: "COMPARISON", slugs: ["reading", "wokingham"] },
  { query: "Compare Manchester and Leeds on tall buildings policy", kind: "COMPARISON", slugs: ["manchester", "leeds"] },

  // --- Regressions found by scripts/lpa-slug-roundtrip.test.ts -------------
  {
    query: "Telford & Wrekin Council employment land policy",
    kind: "COUNCIL_SPECIFIC",
    slugs: ["telford-and-wrekin"],
    why: 'both sides must normalise "&" to "and", or the council is unfindable',
  },
  {
    query: "Lake District National Park Authority housing policy",
    kind: "COUNCIL_SPECIFIC",
    slugs: ["lake-district-national-park-authority"],
    why: '"District" is part of this place name, not an administrative suffix',
  },

  // --- Case D: locality-dependent, no authority given -> ask ----------------
  { query: "What is the affordable housing threshold for my site?", kind: "COUNCIL_AMBIGUOUS" },

  // --- Regressions: ordinary English that must NOT be read as a council -----
  {
    query: "I am reading the guidance on flood risk",
    kind: "NATIONAL",
    why: '"reading" as a verb must not resolve to Reading Borough Council',
  },
  {
    query: "What does the sea view policy say nationally?",
    kind: "NATIONAL",
    why: '"sea"/"view" are ordinary words, not the SEA acronym or a place',
  },
];

let pass = 0;
const failures: string[] = [];

for (const c of CASES) {
  const got = route(c.query);
  const kindOk = got.kind === c.kind;
  const slugsOk =
    !c.slugs ||
    (got.slugs.length === c.slugs.length &&
      c.slugs.every((s) => got.slugs.includes(s)));

  if (kindOk && slugsOk) {
    pass++;
    console.log(`PASS  ${got.kind.padEnd(18)} ${c.query}`);
  } else {
    const detail =
      `want ${c.kind}${c.slugs ? `[${c.slugs.join(",")}]` : ""}, ` +
      `got ${got.kind}[${got.slugs.join(",")}]`;
    failures.push(`${c.query}\n        ${detail}${c.why ? `\n        (${c.why})` : ""}`);
    console.log(`FAIL  ${got.kind.padEnd(18)} ${c.query}`);
  }
}

console.log(`\n${pass}/${CASES.length} passed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
