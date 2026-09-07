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

import { ingestMultiplePdfs } from "../lib/chromaIngest";

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

  const batch = pending.slice(0, limit);
  console.log(`Processing ${batch.length} of ${pending.length} pending council(s)...`);

  for (const row of batch) {
    console.log(`\n=== ${row.organisation_name} (${row.jurisdiction_key}) ===`);
    console.log(`Source: ${row.source_url}`);

    try {
      const buffer = await downloadPdf(row.source_url);
      console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB, ingesting...`);

      const [result] = await ingestMultiplePdfs(
        [
          {
            name: `${row.organisation_name.replace(/[^a-z0-9]+/gi, "_")}_${row.doc_type}.pdf`,
            buffer,
            title: `${row.organisation_name} ${docTypeLabel(row.doc_type)}`,
            jurisdictionKey: row.jurisdiction_key,
            docType: row.doc_type,
            sourceUrl: row.source_url,
          },
        ],
        { region: "uk" as any }
      );

      row.status = "ingested";
      row.notes = `${result.chunks} chunks, document_id=${result.document_id}`;
      console.log(`OK: ${result.chunks} chunks ingested (document_id=${result.document_id})`);
    } catch (err: any) {
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
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
