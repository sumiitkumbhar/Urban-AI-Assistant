#!/usr/bin/env node
/**
 * Stabilisation test harness — Priorities 2 and 4 of the stabilisation pass.
 *
 * Runs against a live dev server and records what the system ACTUALLY does:
 * no assertions are softened, nothing is marked passing that did not pass.
 *
 *   1. npm run dev          (in another terminal, with RAG_TIMING=1 in .env.local)
 *   2. node scripts/stabilization-test.mjs
 *
 * Writes stabilization-report.json next to the repo root and prints a summary.
 * Send that file (and the dev-server log, which carries the ⏱️ TIMING lines)
 * back for analysis.
 */

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const ENDPOINT = `${BASE}/api/rag-chat`;

async function ask(query, extra = {}) {
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, ...extra }),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw */ }
    return { ok: res.ok, status: res.status, ms, json, raw: json ? null : text.slice(0, 400) };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, json: null, raw: String(err) };
  }
}

const summarize = (r) => {
  const d = r.json?.data ?? {};
  const m = r.json?.metadata ?? {};
  return {
    http: r.status,
    ms: r.ms,
    server_ms: m.processing_time ?? null,
    answer: (r.json?.answer ?? r.raw ?? "").slice(0, 300),
    query_used: d.query ?? null,
    corrections: d.corrections ?? [],
    citations: Array.isArray(d.citations) ? d.citations.length : 0,
    sources: (d.citations ?? []).slice(0, 4).map((c) => c.title ?? c.id ?? "?"),
    results_count: d.resultsCount ?? null,
    groundedness: m.groundedness ?? null,
    confidence: m.confidence ?? null,
    web_fallback: m.webFallbackUsed ?? null,
    conversation_id: m.conversationId ?? null,
  };
};

// --------------------------------------------------------------------------
// Priority 2 — fast path + domain correction
// --------------------------------------------------------------------------
const P2 = [
  { id: "P2.1", query: "Hi",
    expect: "greeting fast path: instant, zero citations, zero retrieval",
    check: (s) => s.citations === 0 && s.results_count === 0 && s.http === 200 },
  { id: "P2.2", query: "Hi, what does the NPPF say about Green Belt development?",
    expect: "must NOT fast-path: full pipeline runs",
    check: (s) => s.results_count !== 0 || s.citations > 0 },
  { id: "P2.3", query: "What does NPP say about Green Belt?",
    expect: "corrects NPP -> NPPF, corrected term used for retrieval and answer",
    check: (s) => s.corrections.some((c) => c.to === "NPPF") && /NPPF/.test(s.query_used ?? "") },
  { id: "P2.4", query: "what does n p p f paragraph 11 say",
    expect: "collapses spelled-out letters -> NPPF",
    check: (s) => /NPPF/.test(s.query_used ?? "") },
  { id: "P2.5", query: "green bell policy near my land",
    expect: "corrects green bell -> Green Belt",
    check: (s) => /Green Belt/.test(s.query_used ?? "") },
  { id: "P2.6", query: "planning policy in tower hamlet",
    expect: "corrects council name -> Tower Hamlets",
    check: (s) => /Tower Hamlets/.test(s.query_used ?? "") },
  { id: "P2.7", query: "what are the rules in Durrham",
    expect: "corrects misspelled council -> Durham",
    check: (s) => /Durham/.test(s.query_used ?? "") },
  { id: "P2.8", query: "I am reading the local plan, is that ok",
    expect: "MUST NOT corrupt ordinary English (am -> AMR regression guard)",
    check: (s) => !s.corrections.some((c) => c.from.toLowerCase() === "am") },
];

// --------------------------------------------------------------------------
// Priority 4 — core RAG behaviour
// --------------------------------------------------------------------------
const P4 = [
  ["P4.01", "NPPF factual", "What is the purpose of the NPPF?"],
  ["P4.02", "NPPF factual", "What does the NPPF say about the presumption in favour of sustainable development?"],
  ["P4.03", "Green Belt", "What are the exceptions to inappropriate development in the Green Belt?"],
  ["P4.04", "Green Belt", "What are the five purposes of the Green Belt?"],
  ["P4.05", "Housing", "How should local authorities assess housing need?"],
  ["P4.06", "Housing", "What does the NPPF say about affordable housing contributions?"],
  ["P4.07", "Dev management", "What are material considerations in determining a planning application?"],
  ["P4.08", "Dev management", "When can a local authority refuse permission on design grounds?"],
  ["P4.09", "Planning policy", "What weight should be given to an emerging local plan?"],
  ["P4.10", "Planning policy", "What is the tilted balance and when does it apply?"],
  ["P4.11", "Heritage", "How should harm to a listed building be weighed?"],
  ["P4.12", "Out of corpus", "What is the capital of Australia?"],
  ["P4.13", "Out of corpus", "What are the building regulations in Singapore for fire escapes?"],
  ["P4.14", "Ambiguous", "What about the height?"],
  ["P4.15", "Ambiguous", "Is it allowed?"],
  ["P4.16", "Wrong terminology", "What does the NPFF say about greenbelt?"],
  ["P4.17", "Wrong terminology", "Tell me about section 108 agreements"],
];

const results = { generated_at: new Date().toISOString(), base_url: BASE, p2: [], p4: [], p4_memory: [] };

console.log(`\nTarget: ${ENDPOINT}\n`);
const probe = await ask("Hi");
if (probe.status === 0) {
  console.error(`Cannot reach the dev server at ${BASE}.\nStart it first:  npm run dev\n${probe.raw}`);
  process.exit(1);
}

console.log("=== PRIORITY 2: fast path + domain correction ===");
for (const t of P2) {
  const s = summarize(await ask(t.query, { voiceMode: true }));
  let passed = false;
  try { passed = t.check(s); } catch { passed = false; }
  results.p2.push({ ...t, check: undefined, observed: s, pass: passed });
  console.log(`${passed ? "PASS" : "FAIL"} ${t.id} (${s.ms}ms) ${JSON.stringify(t.query)}`);
  console.log(`      query used: ${JSON.stringify(s.query_used)}`);
  if (s.corrections.length) console.log(`      corrections: ${JSON.stringify(s.corrections)}`);
  if (!passed) console.log(`      EXPECTED: ${t.expect}`);
}

console.log("\n=== PRIORITY 4: core RAG flow ===");
for (const [id, category, q] of P4) {
  const s = summarize(await ask(q));
  results.p4.push({ id, category, question: q, observed: s });
  console.log(
    `${id} [${category}] ${s.ms}ms  cites=${s.citations} grounded=${s.groundedness} conf=${s.confidence} web=${s.web_fallback}`
  );
  console.log(`      Q: ${q}`);
  console.log(`      A: ${s.answer.slice(0, 160).replace(/\n/g, " ")}...`);
}

// Conversation memory: two turns sharing a conversation.
console.log("\n=== PRIORITY 4: conversation memory (follow-up) ===");
const visitorId = `test-${Date.now()}`;
const first = summarize(await ask("What are the five purposes of the Green Belt?", { visitorId }));
const convId = first.conversation_id;
const follow = summarize(await ask("Which of those is most often cited in appeals?", { visitorId, conversationId: convId }));
results.p4_memory = [
  { turn: 1, question: "What are the five purposes of the Green Belt?", observed: first },
  { turn: 2, question: "Which of those is most often cited in appeals?", observed: follow, conversation_id_carried: Boolean(convId) },
];
console.log(`turn 1: ${first.ms}ms conversation_id=${convId}`);
console.log(`turn 2: ${follow.ms}ms  (follow-up understood? read the answer below)`);
console.log(`      A: ${follow.answer.slice(0, 200).replace(/\n/g, " ")}...`);

const p2pass = results.p2.filter((r) => r.pass).length;
console.log(`\n=== SUMMARY ===\nP2: ${p2pass}/${results.p2.length} passed`);
console.log(`P4: ${results.p4.length} questions recorded (judge citation/answer quality by reading the report)`);

const fs = await import("node:fs");
fs.writeFileSync("stabilization-report.json", JSON.stringify(results, null, 2));
console.log("\nWrote stabilization-report.json — send this file back for analysis.\n");
