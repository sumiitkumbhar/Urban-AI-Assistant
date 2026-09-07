/**
 * LPA slug round-trip: every council in the tracker must be reachable.
 *
 * Ingestion files a document under toLpaSlug(lpa_name). Retrieval finds it by
 * resolveCouncils(question) producing that same slug. If the two disagree for
 * a council, its documents are ingested permanently invisible - the filter
 * matches nothing, retrieval silently returns national policy instead, and
 * NOTHING in the application reports a problem. The answer just quietly stops
 * being about that council.
 *
 * That failure mode is undetectable in production, so it has to be caught
 * here. This walks all 337 councils in data/uk-lpa-tracker.csv and asserts the
 * round trip for each. It found four real cases the first time it ran:
 * "Telford & Wrekin" and "Hammersmith & Fulham" (the two sides normalised "&"
 * differently) and the two National Park Authorities (a global "District"
 * strip mangling "Lake District" into "lake").
 *
 * Run from the repo root (cwd matters - the CSV path is relative):
 *
 *   ./node_modules/.bin/tsc --target es2020 --module commonjs \
 *     --moduleResolution node --esModuleInterop --skipLibCheck \
 *     --outDir .tmp-test scripts/lpa-slug-roundtrip.test.ts lib/domain-vocabulary.ts \
 *   && node .tmp-test/scripts/lpa-slug-roundtrip.test.js
 *
 * --esModuleInterop is required; without it the CSV read fails into a silent
 * catch and every council appears to pass by being absent.
 */
import fs from "fs";
import path from "path";
import { toLpaSlug, resolveCouncils } from "../lib/domain-vocabulary";

const csvPath = path.join(process.cwd(), "data", "uk-lpa-tracker.csv");
const raw = fs.readFileSync(csvPath, "utf-8").split(/\r?\n/).slice(1);

const names: string[] = [];
for (const line of raw) {
  if (!line.trim()) continue;
  let name: string;
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    name = end > 0 ? line.slice(1, end) : line.split(",")[0];
  } else {
    name = line.split(",")[0];
  }
  name = name.trim();
  if (name && !names.includes(name)) names.push(name);
}

console.log(`Checking ${names.length} distinct councils...\n`);

const unusable: string[] = [];
const unreachable: string[] = [];

for (const name of names) {
  const slug = toLpaSlug(name);

  if (!slug || slug.length < 3) {
    unusable.push(`${name}  ->  "${slug}"`);
    continue;
  }

  const { matches } = resolveCouncils(
    `What is the affordable housing policy in ${name}?`
  );
  if (!matches.some((m) => m.slug === slug)) {
    unreachable.push(
      `${name}\n        ingest slug: "${slug}"\n        router found: [${
        matches.map((m) => m.slug).join(", ") || "nothing"
      }]`
    );
  }
}

if (unusable.length) {
  console.log(`UNUSABLE SLUG (${unusable.length}):`);
  unusable.forEach((u) => console.log(`  - ${u}`));
  console.log();
}
if (unreachable.length) {
  console.log(`UNREACHABLE - would be ingested invisibly (${unreachable.length}):`);
  unreachable.forEach((u) => console.log(`  - ${u}`));
  console.log();
}

const failed = unusable.length + unreachable.length;
console.log(`${names.length - failed}/${names.length} councils round-trip cleanly`);
if (failed) process.exit(1);
