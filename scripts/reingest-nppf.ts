/**
 * Re-ingests the NPPF after the chunk-boundary fix.
 *
 * Fixing lib/chunkText.ts does nothing to chunks already in the database: the
 * live corpus was built by the old chunker, and 157 of its 418 chunks begin or
 * end inside a word (see scripts/chunk-boundary.test.ts). Those rows have to be
 * rebuilt, which means deleting the existing document and its chunks first -
 * otherwise this simply adds a second copy of the NPPF and every query starts
 * competing against a duplicate.
 *
 *   npx tsx scripts/reingest-nppf.ts --dry-run    # show what it would delete
 *   npx tsx scripts/reingest-nppf.ts --confirm    # actually do it
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and GOOGLE_API_KEY in
 * .env.local. Re-embedding ~420 chunks costs one Gemini call per chunk.
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

import { ingestMultiplePdfs } from "../lib/chromaIngest";

const PDF = path.join(
  process.cwd(),
  "documents-to-ingest",
  "National_Planning_Policy_Framework.pdf"
);

async function main() {
  const confirm = process.argv.includes("--confirm");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }
  if (!fs.existsSync(PDF)) {
    console.error(`Not found: ${PDF}`);
    process.exit(1);
  }

  const supabase = createClient(url, key);

  // Find every document that has chunks, so nothing is deleted blind.
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, title, doc_type, region")
    .ilike("title", "%National Planning Policy Framework%");

  if (error) {
    console.error("Lookup failed:", error.message);
    process.exit(1);
  }
  if (!docs?.length) {
    console.log("No existing NPPF document found - this will be a fresh ingest.");
  }

  for (const d of docs ?? []) {
    const { count } = await supabase
      .from("chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", d.id);
    console.log(`  document_id=${d.id}  "${d.title}"  ${count ?? 0} chunks`);
  }

  if (!confirm) {
    console.log(
      "\nDry run. Nothing changed.\n" +
        "Re-run with --confirm to delete the rows listed above and rebuild them."
    );
    return;
  }

  for (const d of docs ?? []) {
    const { error: ce } = await supabase.from("chunks").delete().eq("document_id", d.id);
    if (ce) { console.error(`Failed deleting chunks for ${d.id}:`, ce.message); process.exit(1); }
    const { error: de } = await supabase.from("documents").delete().eq("id", d.id);
    if (de) { console.error(`Failed deleting document ${d.id}:`, de.message); process.exit(1); }
    console.log(`Deleted document ${d.id} and its chunks.`);
  }

  console.log("\nRe-ingesting with the fixed chunker...");
  const [result] = await ingestMultiplePdfs(
    [
      {
        name: "National_Planning_Policy_Framework.pdf",
        buffer: fs.readFileSync(PDF),
        title: "National Planning Policy Framework",
        jurisdictionKey: "uk",
        docType: "planning_policy",
        scope: "national",
        planStatus: "adopted",
      },
    ],
    { region: "uk" as any }
  );

  console.log(
    `Done: document_id=${result.document_id}, ${result.chunks} chunks.\n` +
      "Ask one of the prompt-card questions and check that no source preview " +
      "starts mid-word."
  );
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
