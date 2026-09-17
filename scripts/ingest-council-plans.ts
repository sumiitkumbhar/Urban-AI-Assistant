// scripts/ingest-council-plans.ts
//
// Batch ingestion for UK council planning documents (Local Plans, and
// Neighbourhood Plans once discovered) into the shared corpus.
//
// WHY THIS EXISTS: there is no API that lists or hosts these documents -
// each of England's 337 local planning authorities publishes its own
// Local Plan on its own council website, in its own format, with no
// common structure. See data/uk-lpa-tracker.csv for the full authority
// list (name, official website, jurisdiction key) pulled from
// planning.data.gov.uk's `local-planning-authority` dataset. That tracker
// starts with every `source_url` empty and `status` = "pending_discovery"
// - discovery (finding each council's actual Local Plan PDF URL and
// filling in source_url) is a separate, ongoing step, NOT done by this
// script. This script only handles the second half: given a tracker row
// that already has a source_url, download that PDF and ingest it with the
// CORRECT per-council jurisdiction tag (never guessed from the filename -
// see lib/chromaIngest.ts's IngestFile.jurisdictionKey/docType/title
// overrides, added specifically so bulk ingestion doesn't mis-tag every
// council's plan with the same hardcoded jurisdiction).
//
// USAGE:
//   npx tsx scripts/ingest-council-plans.ts [--limit N] [--tracker path/to/tracker.csv]
//
// Processes up to `limit` (default 5) rows whose status is
// "pending_ingest", in file order, downloading + ingesting each and
// writing the tracker back to disk after EVERY row (not just at the end)
// so a crash or interrupt never loses progress already made. Meant to be
// run repeatedly (e.g. by a scheduled task) in small batches rather than
// all at once - Gemini embedding calls are the bottleneck, and a single
// large Local Plan can be hundreds of pages.
//
// QUOTA HANDLING (added 2026-09-16, after two real runs both hit Gemini's
// free-tier daily cap partway through a batch): a 429/RESOURCE_EXHAUSTED
// failure is NOT the same kind of failure as a dead URL or a 403 - it says
// nothing about this particular council, only that today's shared embedding
// budget is spent. Treating it like any other error (permanently marking
// the row "error", requiring a human to notice and manually reset it before
// it's ever retried - see the git history around commit daac79f/Redcar and
// Cleveland for how that played out) is wrong twice over: it hides a
// perfectly good, still-pending council behind a false "error", and it lets
// the batch loop plow into every other queued row and pay the FULL retry
// backoff for each one, even though they're all doomed the moment the first
// one confirms the quota is out. So: a quota failure leaves the row's status
// exactly as it was (pending_ingest - untouched, no CSV write needed for
// status) and STOPS the batch immediately; the very next invocation of this
// script (whenever that is - later today if it was a short burst window,
// tomorrow if it's the daily cap) picks the same row right back up, and
// lib/chromaIngest.ts's own resume logic (see ingestOnePdf()) means a
// document that got partway through embedding continues from its last
// completed chunk instead of re-embedding (and re-spending quota on) work
// already done.
//
// REQUIRES REAL INTERNET ACCESS to both the council websites AND to
// Supabase + the Gemini embeddings API (via lib/chromaIngest.ts). If
// you're running this from an environment with restricted network egress
// (a locked-down CI runner, an agent sandbox with an allowlist, etc.) it
// will fail on the fetch() calls - run it somewhere with normal outbound
// HTTPS access instead.
//
// No CSV library dependency (npm install isn't reliably available in
// every environment this might run in) - the tiny parse/stringify below
// handles RFC4180-style quoting, which the tracker needs since several
// council names contain commas (e.g. "Bournemouth, Christchurch and
// Poole Council").

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Loaded explicitly (not via `-r dotenv/config`) and BEFORE the
// chromaIngest import below, so SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// GOOGLE_API_KEY are already in process.env by the time chromaIngest.ts's
// lazily-initialized clients read them.
dotenv.config({ path: path.join(process.cwd(), ".env.local") });

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

import { ingestMultiplePdfs } from "../lib/chromaIngest";
import { isRateLimitError } from "../lib/embeddings";
import { toLpaSlug } from "../lib/domain-vocabulary";

// A Policies Map is a cartographic PDF: site allocations drawn on a base map,
// with almost no extractable prose. Ingesting one produces a few dozen chunks
// of legend fragments and street names that match everything weakly and answer
// nothing - actively harmful to retrieval quality. Excluded by design; see
// PROJECT_STATE.md section 11c.
const EXCLUDED_DOC_TYPES = new Set(["local_plan_policies_map"]);

// The tracker carries ~70 distinct doc_type values (local_plan,
// local_plan_core_strategy, local_plan_policies_map, local_plan_part2, ...).
// This turns one into a human label for the document title.
//
// This previously read `doc_type === "local_plan" ? "Local Plan" : "Neighbourhood Plan"`,
// which mislabelled every non-plain doc_type as a Neighbourhood Plan - 259 of
// the 468 queued rows, including every Core Strategy and Policies Map. Those
// titles are not cosmetic: `documents.title` is returned by the retrieval RPCs
// as `doc_title` and is what the UI shows as the citation, so a wrong title is
// a wrong citation on screen.
function docTypeLabel(docType: string): string {
  const raw = (docType || "").trim().toLowerCase();
  if (!raw) return "Local Plan";
  if (raw.includes("neighbourhood")) return "Neighbourhood Plan";
  if (raw === "local_plan") return "Local Plan";

  const known: Record<string, string> = {
    local_plan_core_strategy: "Core Strategy",
    local_plan_development_management: "Development Management Policies",
    local_plan_site_allocations: "Site Allocations",
    local_plan_policies_map: "Policies Map",
    local_plan_udp: "Unitary Development Plan",
    local_plan_udp_saved_policies: "Unitary Development Plan (Saved Policies)",
    local_plan_saved_policies: "Local Plan (Saved Policies)",
    joint_local_plan: "Joint Local Plan",
    joint_core_strategy: "Joint Core Strategy",
    district_plan: "District Plan",
    allocations_plan: "Allocations Plan",
  };
  if (known[raw]) return known[raw];

  // Generic fallback: "local_plan_part2_appendices" -> "Local Plan Part2 Appendices"
  return raw
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

interface TrackerRow {
  lpa_name: string;
  reference: string;
  organisation_name: string;
  organisation_website: string;
  jurisdiction_key: string;
  doc_type: string;
  source_url: string;
  status: string;
  notes: string;
}

const TRACKER_COLUMNS: (keyof TrackerRow)[] = [
  "lpa_name",
  "reference",
  "organisation_name",
  "organisation_website",
  "jurisdiction_key",
  "doc_type",
  "source_url",
  "status",
  "notes",
];

// --- Minimal RFC4180 CSV parse/stringify (no external dependency) ---

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function csvField(value: string): string {
  const v = value ?? "";
  if (/[",\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function loadTracker(trackerPath: string): TrackerRow[] {
  const text = fs.readFileSync(trackerPath, "utf-8");
  const table = parseCsv(text);
  const header = table[0];
  return table.slice(1).map((cols) => {
    const row: any = {};
    header.forEach((h, idx) => {
      row[h] = cols[idx] ?? "";
    });
    return row as TrackerRow;
  });
}

function saveTracker(trackerPath: string, rows: TrackerRow[]) {
  const lines = [TRACKER_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(TRACKER_COLUMNS.map((col) => csvField(row[col])).join(","));
  }
  fs.writeFileSync(trackerPath, lines.join("\n") + "\n", "utf-8");
}

// --- CLI args ---

function parseArgs(argv: string[]) {
  let limit = 5;
  let trackerPath = path.join(process.cwd(), "data", "uk-lpa-tracker.csv");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      limit = parseInt(argv[i + 1], 10) || limit;
      i++;
    } else if (argv[i] === "--tracker" && argv[i + 1]) {
      trackerPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return { limit, trackerPath };
}

async function downloadPdf(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    // Some council sites block requests with no browser-like UA.
    headers: { "User-Agent": "Mozilla/5.0 (compatible; UrbanAIAssistantBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const contentType = res.headers.get("content-type") || "";
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  // A council page that returns an HTML error/redirect page instead of a
  // PDF is a common failure mode worth catching explicitly rather than
  // feeding garbage into pdf-parse.
  const looksLikePdf = buffer.slice(0, 5).toString("ascii") === "%PDF-";
  if (!looksLikePdf) {
    throw new Error(
      `URL did not return a PDF (content-type: ${contentType || "unknown"}) - likely a dead link or a page that needs JS/redirects to reach the real file`
    );
  }
  return buffer;
}

async function main() {
  const { limit, trackerPath } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(trackerPath)) {
    console.error(`Tracker file not found: ${trackerPath}`);
    process.exit(1);
  }

  const rows = loadTracker(trackerPath);
  const pending = rows.filter((r) => r.status === "pending_ingest" && r.source_url?.trim());

  if (!pending.length) {
    console.log(
      `No rows with status="pending_ingest" and a source_url set. ` +
        `${rows.filter((r) => r.status === "pending_discovery").length} rows still need a Local Plan URL found first ` +
        `(fill in source_url and set status to "pending_ingest" to queue them).`
    );
    return;
  }

  await assertMigrationApplied();

  const skipped = pending.filter((r) => EXCLUDED_DOC_TYPES.has(r.doc_type));
  const ingestable = pending.filter((r) => !EXCLUDED_DOC_TYPES.has(r.doc_type));
  if (skipped.length) {
    console.log(
      `Skipping ${skipped.length} Policies Map row(s) - cartographic PDFs with ` +
        `no useful prose (see EXCLUDED_DOC_TYPES).`
    );
    for (const row of skipped) {
      row.status = "skipped_excluded";
      row.notes = "doc_type excluded from ingestion (policies map)";
    }
    saveTracker(trackerPath, rows);
  }

  const batch = ingestable.slice(0, limit);
  console.log(`Processing ${batch.length} of ${ingestable.length} pending council(s)...`);

  let totalBytes = 0;
  let totalChunks = 0;
  let processedCount = 0;
  let stoppedForQuota = false;

  for (const row of batch) {
    console.log(`\n=== ${row.organisation_name} (${row.jurisdiction_key}) ===`);
    console.log(`Source: ${row.source_url}`);

    try {
      const buffer = await downloadPdf(row.source_url);
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      console.log(
        `Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB ` +
          `(sha256 ${sha256.slice(0, 12)}...), ingesting...`
      );

      // The canonical slug comes from lpa_name via the SAME toLpaSlug() the
      // query-side router uses. One function, so a document is filed under
      // exactly the string a question will later be resolved to - deriving
      // them separately is how "reading" and "reading-borough" end up in the
      // same database and nothing matches.
      const lpaName = (row.lpa_name || row.organisation_name).trim();
      const lpaSlug = toLpaSlug(lpaName);
      if (!lpaSlug || lpaSlug.length < 3) {
        throw new Error(
          `Could not derive an LPA slug from "${lpaName}". Fix lpa_name in the ` +
            `tracker rather than ingesting a document no council filter can reach.`
        );
      }

      const [result] = await ingestMultiplePdfs(
        [
          {
            name: `${row.organisation_name.replace(/[^a-z0-9]+/gi, "_")}_${row.doc_type}.pdf`,
            buffer,
            title: `${row.organisation_name} ${docTypeLabel(row.doc_type)}`,
            jurisdictionKey: row.jurisdiction_key,
            docType: row.doc_type,
            sourceUrl: row.source_url,
            scope: "local",
            lpaSlugs: [lpaSlug],
            lpaNames: [lpaName],
            // The tracker records INGEST status, not adoption status. It has no
            // column that says whether a plan is adopted, emerging or
            // superseded, so the only honest value is 'unknown'. Do not infer
            // one from the filename or the year.
            planStatus: "unknown",
            contentSha256: sha256,
          },
        ],
        { region: "uk" as any }
      );

      totalBytes += buffer.length;
      // Only the chunks actually embedded/inserted THIS run count toward the
      // capacity projection below - result.chunks is the document's TOTAL
      // (including any chunks a previous, quota-cut-short run already
      // committed), which would double-count on a resumed document.
      totalChunks += result.newlyInserted;
      processedCount++;

      row.status = "ingested";
      row.notes =
        result.newlyInserted === result.chunks
          ? `${result.chunks} chunks, document_id=${result.document_id}, lpa=${lpaSlug}`
          : `${result.chunks} chunks total (${result.newlyInserted} newly embedded this run, ` +
            `resumed from a prior partial run), document_id=${result.document_id}, lpa=${lpaSlug}`;
      console.log(
        result.newlyInserted === result.chunks
          ? `OK: ${result.chunks} chunks ingested (document_id=${result.document_id}, lpa_slug=${lpaSlug})`
          : `OK: ${result.chunks} chunks total, ${result.newlyInserted} newly embedded this run ` +
            `(document_id=${result.document_id}, lpa_slug=${lpaSlug})`
      );
    } catch (err: any) {
      if (isRateLimitError(err)) {
        // Not this council's fault, and not permanent - see this file's
        // header comment. Leave status/notes untouched (it's still
        // "pending_ingest") so the very next run picks it straight back up,
        // and stop the batch now rather than let every remaining row pay
        // the full retry backoff for a guaranteed-doomed attempt.
        console.error(
          `\nEMBEDDING QUOTA APPEARS EXHAUSTED: ${String(err?.message || err).slice(0, 300)}\n` +
            `Leaving "${row.organisation_name}" as pending_ingest (any chunks already embedded for ` +
            `it this run are kept, per lib/chromaIngest.ts's resume logic) and stopping this batch here.\n` +
            `Re-run the same command later (today if this was a short burst window, tomorrow if it's ` +
            `the daily cap) to continue exactly where this left off.`
        );
        stoppedForQuota = true;
        saveTracker(trackerPath, rows);
        break;
      }
      row.status = "error";
      row.notes = String(err?.message || err).slice(0, 500);
      console.error(`FAILED: ${row.notes}`);
    }

    // Save after EVERY row, not just at the end - a batch of 5 where the
    // 4th one crashes the process should still have rows 1-3 persisted.
    saveTracker(trackerPath, rows);
  }

  const summary = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log("\n=== Tracker status summary ===");
  console.log(summary);

  if (stoppedForQuota) {
    console.log(
      `\nStopped early: ${processedCount}/${batch.length} council(s) in this batch were attempted ` +
        `before the quota hit; ${batch.length - processedCount} were left untouched (still pending_ingest).`
    );
  }

  await reportCapacity(totalBytes, totalChunks, processedCount);
}

/**
 * Refuses to run against an un-migrated database.
 *
 * Without the council columns every document would be ingested with no
 * lpa_slugs, which is not a partial success - it is a corpus that looks
 * populated while being invisible to every council-filtered query, and the
 * only way to tell is to re-ingest everything. Cheaper to stop here.
 */
async function assertMigrationApplied() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  const supabase = createClient(url, key);
  const { error } = await supabase
    .from("documents")
    .select("scope, lpa_slugs, plan_status, content_sha256")
    .limit(1);

  if (error) {
    console.error(
      "\nThe council-aware migration has not been applied to this database.\n" +
        `  ${error.message}\n\n` +
        "Run sql/2026-09-07-council-aware-retrieval.sql in the Supabase SQL\n" +
        "Editor first, then re-run this script. Nothing has been ingested.\n"
    );
    process.exit(1);
  }
  console.log("Preflight OK: council columns present.");
}

/**
 * Real measured numbers from this run, projected to the full tracker.
 *
 * The projection before any ingestion put the full corpus at 0.85-3.9 GB
 * against a 500 MB free tier - a range wide enough that the decision to bulk
 * ingest cannot responsibly be made on it. This replaces the estimate with
 * measurement, which is the entire purpose of running a 5-council pilot.
 */
async function reportCapacity(
  totalBytes: number,
  totalChunks: number,
  councilCount: number
) {
  if (!councilCount || !totalChunks) return;

  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(url, key);

  const { count: docCount } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true });
  const { count: chunkCount } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true });

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

  // 768-dim float4 embedding = 3072 bytes, plus the chunk text itself, plus
  // the tsvector and index overhead. The 2.2x multiplier is a rule of thumb,
  // NOT a measurement - the authoritative number is the database size shown
  // in the Supabase dashboard after this run. Compare the two.
  const embeddingBytes = totalChunks * 768 * 4;
  const estimatedDbBytes = (embeddingBytes + totalBytes * 0.35) * 2.2;

  console.log("\n=== Capacity (measured, this run) ===");
  console.log(`  councils processed:    ${councilCount}`);
  console.log(`  PDFs downloaded:       ${mb(totalBytes)} MB`);
  console.log(`  chunks newly embedded: ${totalChunks}`);
  console.log(`  chunks per council:    ${Math.round(totalChunks / councilCount)}`);
  console.log(`  est. database growth:  ~${mb(estimatedDbBytes)} MB`);
  console.log(`  => per council:        ~${mb(estimatedDbBytes / councilCount)} MB`);
  console.log(`\n  Projected for 335 councils: ~${(estimatedDbBytes / councilCount * 335 / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`  Supabase free tier:         0.50 GB`);
  console.log(`\n  Database now holds ${docCount ?? "?"} documents / ${chunkCount ?? "?"} chunks.`);
  console.log(
    "  CHECK THE ACTUAL SIZE in the Supabase dashboard before ingesting more -\n" +
      "  the estimate above is arithmetic, the dashboard is the truth."
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
