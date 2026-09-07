# PROJECT_STATE.md

Single source of truth for this repo. Written to answer three questions for a
developer or an AI assistant with no prior context:

1. **What are we building?** → sections 1–5
2. **What works / what breaks?** → sections 6–8
3. **What's next?** → sections 9–11

**Rules for this file:** update it after every meaningful code change (see
section 12 for the format). State only what has been verified by reading the
code or running something. Where a claim is unverified, it says so explicitly.
No guessing, no fluff, no secrets — environment variable *names* only, never
values.

- **Last audited:** 2026-09-07
- **Branch:** `chore/stabilization-pass` — last commit `ae09fc1` ("Add voice mode, conversation memory, document upload and RAG hardening")
- **`main` is at:** `f1928d0` — it does **not** yet contain any of the work below. Merge when ready: `git checkout main && git merge chore/stabilization-pass`
- **Uncommitted files:** 0 (working tree clean as of 2026-09-07)

---

## 0. START HERE — handoff brief

**If you are an AI assistant picking this project up cold, read this section
fully before doing anything.** The rest of the file is reference; this is
orientation.

### What this is
A RAG chatbot answering UK planning and building-regulations questions from
indexed official documents, with inline citations. Next.js 14 + Supabase
(Postgres/pgvector) + Gemini embeddings + Groq LLM. Full detail: §1–§5.

### State as of 2026-09-07
- Branch `main`, commit `c3600d4`. Working tree clean. **Not yet pushed to
  GitHub** — the repo exists at `github.com/sumiitkumbhar/Urban-AI-Assistant`
  but the last 10 commits are local only.
- The app **builds and type-checks** (`tsc --noEmit` clean).
- The live corpus is **one document**: the NPPF, 422 chunks. 614 other
  `documents` rows exist with zero chunks — debris from an earlier
  multi-region project. See §11d.

### Two decisions are pending — work is blocked on them
1. **`sql/2026-09-07-council-aware-retrieval.sql` has NOT been run.** It adds
   `scope`, `lpa_slugs`, `lpa_names`, `plan_status`, `content_sha256`, fixes
   citation links (RPCs currently never return `source_url`), and adds an
   optional council filter. Additive and behaviour-preserving until the app
   passes the new arguments. Until it runs, council-aware retrieval cannot work.
2. **`docs/local-postgres-corpus-proposal.md` is awaiting approval.** Whether
   the corpus moves to local Postgres + pgvector (no 500 MB ceiling) or stays
   on Supabase. This decides the ingestion plan.

### Constraints the project owner has set — do not violate these
- No new product features. No UI redesign. No voice work right now.
- **No RAG pipeline rewrite**, and no broad refactor of the 3,900-line
  `app/api/rag-chat/route.ts` unless a bug requires it.
- **No second vector database** (no Chroma/Pinecone/etc.). The stack is
  Postgres + pgvector and stays that way.
- No paid APIs. Everything runs on free tiers or self-hosted.
- Corpus scope: prove 5 councils with provable authority isolation before any
  bulk ingestion. Not 446.

### How to read claims in this file
Every claim is marked by how it was established. **"Type-checks" is not
"works".** Specifically, these are written but have **never been executed**:
- `voice-service/` (Chatterbox TTS) and `voice-agent/` (Pipecat) — Python,
  never installed or run
- the greeting fast path and domain-term correction — type-checked and
  unit-tested standalone, but never exercised against a running app
- `scripts/stabilization-test.mjs` — a ready-to-run harness, never run

Do not describe any of these as working. If you need them verified, the owner
must run them.

### Why so much is unverified
The previous assistant worked from a sandboxed environment that could not run
this app. Both blockers were verified, not assumed:
- **No runnable Next.js**: its shell was linux/arm64 while `node_modules`
  carries only `@next/swc-darwin-arm64` (installed on the Mac). `next dev`
  exits; `next build` stalls. This is what the earlier "16-minute stuck build"
  was — an artifact of where it ran, not a defect in the project.
- **No network to any dependency**: `api.groq.com`,
  `generativelanguage.googleapis.com`, `supabase.co`, `api.tavily.com`, PyPI,
  npm and GitHub all return `blocked-by-allowlist`.

**If you are ChatGPT (or any assistant without machine access), you cannot run
this either.** Ask the owner to run commands and paste output. Do not claim
anything was tested that you did not see output for.

### Immediate next action
Decide the two pending items above. Then, in order: run the migration →
wire `filter_lpa_slug` through `searchRAG()` → build the scope router
(national / local / user-PDF, §11c) → five-council pilot → measure real
storage → decide corpus size.

### Handing this project to another assistant
This file plus the repo is the entire handoff. Nothing important lives only in
a chat transcript. To bring a new assistant up to speed: give it this file
first, then `docs/local-postgres-corpus-proposal.md` and
`sql/2026-09-07-council-aware-retrieval.sql` if the corpus work is next.

---

## 1. What are we building?

**Urban AI Assistant** — a retrieval-augmented (RAG) chatbot that answers UK
planning and building-regulations questions from an indexed corpus of official
documents, with inline citations pointing back to the source text, plus a
hands-free voice conversation mode.

The user asks something like *"what does the NPPF say about green belt
development"*; the app retrieves matching chunks from its document corpus,
generates an answer with a Groq-hosted LLM, checks that answer against the
retrieved evidence, and renders it with clickable citations.

Note: the npm package is still named `zoning-copilot-ai` (v2.0.0) from an
earlier iteration — the product name is Urban AI Assistant.

**Design intent of the corpus:** the NPPF plus every English local planning
authority's Local Plan, tagged per council so retrieval stays
region-accurate. Ingestion of the council plans has *not* been run yet — see
section 7.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 14.2.35, App Router | React 18.2, TypeScript 5.9 |
| Styling | Tailwind CSS 3.4 | Warm-paper aesthetic, see section 8 |
| Database | Supabase (Postgres + pgvector) | corpus chunks, chat history, user uploads |
| Embeddings | Google Gemini `gemini-embedding-001`, 768 dims | via `@google/genai` |
| LLM | Groq, default `openai/gpt-oss-20b` | via `groq-sdk`; free tier |
| Web fallback | Google Custom Search + Tavily | used when the corpus doesn't cover the question |
| Voice (in-browser) | Web Speech API (STT) + browser SpeechSynthesis (TTS) | zero-dependency baseline |
| Voice (better TTS) | Chatterbox (Resemble AI, MIT) via local FastAPI service | `voice-service/`, optional |
| Voice (full-duplex) | Pipecat + local Whisper + Silero VAD | `voice-agent/`, optional, unproven |
| Runtime | Node >= 18.17 | all API routes are `runtime = "nodejs"` |

Everything in the live path runs on free tiers: Groq, Supabase (500MB),
Gemini embeddings, Tavily. Both voice upgrades are self-hosted and cost
nothing to run beyond your own compute.

---

## 3. Repo layout

```
app/
  page.tsx                    Single-page app; dynamically imports ChatInterface (ssr:false)
  layout.tsx                  Root layout
  contexts/AuthContext.tsx    ORPHANED - not imported anywhere
  api/
    rag-chat/route.ts         ~3900 lines. THE main endpoint: retrieval, answering,
                              groundedness, voice rewrite, greeting fast path, term correction
    conversations/route.ts    List/create saved conversations
    conversations/[id]/route.ts  Load/delete one conversation
    documents/upload/route.ts Per-conversation document upload
    tts/route.ts              Server-side proxy to the Chatterbox voice service
    voice-llm/route.ts        OpenAI-chat-completions-shaped shim over /api/rag-chat,
                              consumed by voice-agent/bot.py only
    rag/ingest/route.ts       PDF ingestion endpoint (depends on lib/chromaIngest stub)
    source-page/route.ts      Serves source document pages for citation previews
    health/route.ts           Liveness probe
components/
  chat/ChatInterface.tsx      ~2100 lines. The entire chat UI
  chat/ConversationSidebar.tsx  Saved conversation list
  chat/VoiceModeOverlay.tsx   Full-screen push-to-talk voice UI (browser STT)
  chat/VoiceAgentOverlay.tsx  Full-screen full-duplex voice UI (Pipecat) - beta, unproven
  citations/                  InlineCitation, ExpandableCitation, SourcePreview, SourcesSection
  ui/                         Local shadcn-style primitives (button, card, switch, tabs...)
lib/
  domain-vocabulary.ts        Speech/typo correction against domain terms (NEW 2026-09-06)
  embeddings.ts               Gemini embedding client, dimension config
  supabase.ts                 Lazy Supabase client
  useVoiceChat.ts             Browser STT/TTS hook + Chatterbox fetch with fallback
  userDocuments.ts            Per-conversation uploaded-document retrieval
  visitorId.ts                Anonymous per-browser id (no login)
  diagram-intent-detector.ts  Detects when a question wants a diagram
  question-patterns-store.ts  Known question patterns
  chromaIngest.ts             Ingestion helpers (used by scripts/, not by the app)
  validators/                 london-uk-validator.ts, nyc-usa-validator.ts (feasibility only)
  rag/                        ORPHANED - a whole parallel RAG implementation, 0 imports
  services/                   ORPHANED - groqService, groqLandAnalysisService, 0 imports
  geminiRag.ts, groq.ts, query-intent-detector.ts   ORPHANED, 0 imports
  utils/clauseExtractor.ts, contractAnalyzer.ts, reportGenerator.ts
                              Unfinished Indian-contract feature; EXCLUDED in tsconfig.json
voice-service/                Chatterbox TTS FastAPI server (Python) + Dockerfile + README
voice-agent/                  Pipecat full-duplex voice agent (Python) + README
data/uk-lpa-tracker.csv       503 rows: every English LPA, its plan URL and ingest status
documents-to-ingest/          National_Planning_Policy_Framework.pdf (only file present)
scripts/
  ingest-council-plans.ts     Bulk council-plan ingestion (npm run ingest:councils)
  _tmp_patch_voice_backend.py JUNK - leftover patch script, safe to delete
  _to_delete/                 JUNK - 4 leftover patch scripts, safe to delete
sql/                          chat_history_setup.sql, hybrid_search_setup.sql,
                              user_documents_setup.sql
```

---

## 4. Exact RAG flow

`POST /api/rag-chat` — the console logs the numbered steps below, so a slow or
failing request can be located by reading the dev-server output.

```
Request body: { query, mode, region?, topK?, threshold?, visitorId?,
                conversationId?, voiceMode?, drawingFile? }

 0a. GREETING FAST PATH        matchGreetingFastPath(rawQuery)
                               Whole-message match against greetings/thanks/
                               goodbyes/"what can you do". On a hit: return a
                               canned reply immediately. NOTHING below runs -
                               no embeddings, no LLM, no DB write.
 0b. DOMAIN TERM CORRECTION    correctDomainTerms(rawQuery, { voiceMode })
                               Fixes STT/typo damage to domain jargon
                               ("NPP" -> "NPPF") before anything reads the
                               query. The corrected string is bound as `query`,
                               so retrieval AND the answer prompt both see it.
                               Corrections are returned to the client, not
                               applied silently.
 --  conversation memory       ensureConversation + loadRecentMessages
                               (skipped entirely when no visitorId)
 --  follow-up condensing      condenseFollowUpQuery() - LLM call, only when
                               conversation history exists. Produces
                               `retrievalQuery`; the original wording is kept
                               for the prompt.
 --  diagram intent            detectDiagramIntent() - pattern match, no LLM
 1.  RETRIEVAL                 searchRAG() -> Supabase RPCs
                                 match_rag_chunks           (vector, pgvector)
                                 match_rag_chunks_fulltext  (keyword)
                               Hybrid: both, merged. topK default 25,
                               similarity threshold default 0.3.
 1.25 USER DOCUMENTS           searchUserDocumentChunks() - documents uploaded
                               earlier in THIS conversation, merged in
 1.5  LLM RERANK               rerankWithGroq()            [Groq call #1]
 2.   RERANK                   local reranking pass
 3.   REGION FILTER            document-region filtering
 4.   CITATIONS                build document citations
 5.   WEB FALLBACK             Google CSE / Tavily, only if corpus coverage is weak
 6.   ANSWER GATING            decide: full answer / web-only / partial / basic
 7.   GENERATE                 generateAnswer() or generateBasicAnswer()
                                                            [Groq call #2]
 6.5  GROUNDEDNESS             checkGroundedness() - LLM-as-judge, scores the
                               answer against retrieved evidence
                                                            [Groq call #3]
 --   DIAGRAM                  optional diagram spec + SVG generation
 8.   VOICE REWRITE            humanizeForSpeech() - only when voiceMode=true.
                               Rewrites the cited, document-shaped answer into
                               something a person would say out loud.
                                                            [Groq call #4]

Response: { success, answer, diagram?, svgContent?,
            data: { citations, query, region, resultsCount, references,
                    missingCoverage?, speechText?, corrections? },
            metadata: { processing_time, confidence, groundedness,
                        unsupportedClaims, webFallbackUsed, conversationId } }
```

**Latency characteristic:** a fully-covered question costs up to 4 sequential
Groq calls plus embedding + two DB queries. This is why the greeting fast path
exists. Time-to-first-token is *not* optimised — the pipeline is blocking and
does not stream.

### Voice flow (two independent paths)

**Path A — in-browser (default, works today):**
```
mic -> Web Speech API (browser STT) -> /api/rag-chat (voiceMode:true)
    -> data.speechText -> /api/tts -> voice-service (Chatterbox)  [if configured]
                       -> browser SpeechSynthesis                 [fallback]
```
Turn-based: it records, stops, thinks, then speaks. It cannot hear you while
speaking, so it cannot be interrupted mid-sentence.

**Path B — full-duplex (beta, never run end to end):**
```
mic --websocket--> voice-agent/bot.py (Pipecat)
    Silero VAD (turn detection)
    -> local Whisper STT (MLX on Apple Silicon / faster-whisper elsewhere)
    -> OpenAILLMService pointed at /api/voice-llm -> /api/rag-chat
    -> ChatterboxHttpTTSService -> voice-service
--websocket--> browser speaker
```
Requires three processes running at once (Next.js, voice-service, voice-agent)
and `NEXT_PUBLIC_VOICE_AGENT_URL` set, which is what reveals the
"Full-duplex voice (beta)" button in the UI.

---

## 5. AI models and configuration (no secrets)

| Purpose | Model | Set by | Default |
|---|---|---|---|
| All chat/answering/reranking/judging | Groq | `GROQ_CHAT_MODEL` | `openai/gpt-oss-20b` |
| Embeddings | Gemini | `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` |
| Embedding dimensions | — | hardcoded, `lib/embeddings.ts` | `768` |
| Retrieval top-K | — | request body `topK` | `25` (max 50) |
| Similarity threshold | — | request body `threshold` | `0.3` |
| Chatterbox TTS expressiveness | — | `CHATTERBOX_EXAGGERATION` | `0.6` |
| Whisper (voice-agent) | MLX medium / distil-medium.en | `WHISPER_MLX_MODEL` / `WHISPER_MODEL` | see `voice-agent/bot.py` |

**Environment variables (names only — see `.env.example`):**

- Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`
- Optional: `TAVILY_API_KEY`, `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_ID`, `GEMINI_EMBEDDING_MODEL`, `GROQ_CHAT_MODEL`, `NEXT_PUBLIC_BASE_URL`
- Voice: `CHATTERBOX_TTS_URL`, `NEXT_PUBLIC_VOICE_AGENT_URL`, `RAG_LLM_URL`
- **Never set `NEXT_PUBLIC_GROQ_API_KEY`.** It is read as a fallback inside two
  orphaned service files; if those are ever imported into a client component it
  would ship the Groq key to the browser.

---

## 6. Feature status

### Working
Verified by reading the code end to end and by a clean `tsc --noEmit` across the
project. "Runtime-verified" is called out where it applies.

- **Text Q&A with inline citations** — the fully-implemented path. `/api/rag-chat`
  with no file upload.
- **Hybrid retrieval** — vector + full-text Supabase RPCs, merged.
- **Groundedness check** — LLM-as-judge scores each answer against its evidence;
  surfaced in the UI.
- **Web fallback** — Google CSE / Tavily when corpus coverage is weak.
- **Conversation memory** — anonymous `visitorId`, saved conversations, sidebar,
  follow-up condensing.
- **Per-conversation document upload** — upload a PDF, then ask about it; merged
  with corpus retrieval.
- **Voice mode (browser STT + browser TTS)** — works with no extra setup.
- **Greeting fast path** — added 2026-09-06. Type-checked. Not yet runtime-verified.
- **Domain term correction** — added 2026-09-06. Unit-tested standalone, 16/16
  cases passing (see section 12). Not yet runtime-verified inside the app.

### Partial
- **Chatterbox TTS (`voice-service/`)** — code complete and syntax-checked, but
  **never executed**. Every environment available to the AI assistant blocks
  PyPI, so `pip install -r requirements.txt` has never run. Needs a real
  terminal. Until then voice mode silently uses the browser voice.
- **Full-duplex voice agent (`voice-agent/`)** — code complete, written against
  Pipecat's current verified source. **Never executed** (PyPI blocked). The
  browser-side packages (`@pipecat-ai/client-js`, `@pipecat-ai/websocket-transport`)
  **are** installed as of 2026-09-06.
- **Corpus coverage** — `documents-to-ingest/` contains only the NPPF. The 335
  queued council plans in `data/uk-lpa-tracker.csv` have not been ingested.
  *(The live contents of the Supabase corpus cannot be verified from this
  machine without running the app — treat corpus breadth as unconfirmed.)*
- **Feasibility / permitting / risk modes** — selectable in the UI, but the
  backing routes don't exist (below), so they degrade to normal Q&A.

### Broken / missing
- **`/api/feasibility`** — called by `app/api/rag-chat/route.ts`. Route does not
  exist. **As of 2026-09-07 the UI that reached it is gated off** (`FEATURES.modeSelector`
  in `ChatInterface.tsx`), so it is no longer reachable from the app.
- **`/api/analyze-drawing`** — route does not exist. **Gated off 2026-09-07**
  (`FEATURES.drawingAnalysis`).
- **`/api/diagram/svg`** — route does not exist. **Gated off 2026-09-07**
  (`FEATURES.diagramSvgFetch`). Previously fired on every answer containing a
  diagram trigger and always failed. Diagrams that arrive with server-rendered
  `svgContent` still render normally.
- **`/api/diagram/png`** — route does not exist. Export button **gated off
  2026-09-07** (`FEATURES.diagramPngExport`).
- **"Permitting" and "Risk review" modes never did anything.** Verified: `mode`
  is only ever read for `"feasibility"` in `app/api/rag-chat/route.ts`; there is
  no code path for the other two, so they behaved identically to Auto. The whole
  mode selector is now gated off.
- **npm scripts** `rag:dev`, `index:corpus`, `extract-questions`,
  `analyze-questions` — all point at files that were never committed
  (`server/index.ts`, `scripts/index-corpus.cjs`, etc.). They fail if run.
- **`complianceResult`** — `ChatInterface.tsx:1128` reads it from three possible
  places, but nothing in the codebase ever sets it. Vestigial; that UI branch
  never renders.
- **`/api/health`** reports `service: "generate-report"` — a stale name from a
  previous project. Cosmetic.

---

## 7. Known bugs, with likely cause and file

| # | Symptom | Likely cause | File(s) |
|---|---|---|---|
| 1 | Feasibility mode does nothing beyond a normal answer | Route missing; also `NEXT_PUBLIC_BASE_URL` defaults to `""`, so the server-side fetch becomes a relative URL and throws before it can even 404 | `app/api/rag-chat/route.ts:3253-3275` |
| 2 | Drawing upload in feasibility mode has no effect | `/api/analyze-drawing` missing, same relative-URL problem | `app/api/rag-chat/route.ts:3295-3320` |
| 3 | Diagram export buttons fail | `/api/diagram/svg` and `/api/diagram/png` missing | `ChatInterface.tsx:320, 2066` |
| 4 | Answers are slow even for trivial input | Blocking pipeline, up to 4 sequential Groq calls, no streaming. Greetings are now fast-pathed (2026-09-06), but everything else still pays full cost | `app/api/rag-chat/route.ts` |
| 5 | `next build`/`next dev` hang or exit in the assistant's shell | **Not a project defect.** That shell is a linux/arm64 VM; `node_modules` was installed on macOS, so only `@next/swc-darwin-arm64` is present and no SWC binary can load. Reproduces only there. Status on macOS: unverified | `node_modules/@next/` |
| 6 | Council plans unavailable to answers | Ingestion never run — blocked by network egress restrictions in the AI assistant's environments | `scripts/ingest-council-plans.ts`, `data/uk-lpa-tracker.csv` |
| 7 | Dead code inflates the repo and confuses navigation | `lib/rag/*`, `lib/services/*`, `lib/groq.ts`, `lib/geminiRag.ts`, `lib/query-intent-detector.ts`, `app/contexts/AuthContext.tsx` all have **0 imports** (verified) | as listed |
| 8 | ~~Leftover junk in `scripts/`~~ | RESOLVED 2026-09-07 — deleted, and `.gitignore` now excludes `scripts/_tmp_*.py` and `scripts/_to_delete/` | — |

---

## 8. Current UI

Single-page app (`app/page.tsx` renders `ChatInterface` client-side only).

- **Aesthetic:** warm paper — `#f7f4ee` ground, faint horizontal ruling, soft
  vignette, film grain. Colour is used only in *content* (confidence shading,
  source cards), never in the chrome.
- **Main column:** message thread. Assistant answers render markdown with
  inline citation tokens (`[D1]`, `[W1]`) that expand into source previews.
- **Below each answer:** processing time, confidence, groundedness score, and —
  new on 2026-09-06 — an amber note when a domain term was corrected
  ("Heard "NPP" as "NPPF" — answered on that basis").
- **Left:** `ConversationSidebar` with saved conversations.
- **Composer:** text input, document upload, and a mode selector —
  Auto (default) / Feasibility / Permitting / Risk review.
- **Under the composer:** "Start voice conversation" (always shown when the
  browser supports speech), and "Full-duplex voice (beta)" (only when
  `NEXT_PUBLIC_VOICE_AGENT_URL` is set).
- **Voice overlays:** both are full-screen with a single animated orb that
  tracks state (idle / listening / thinking / speaking) plus a live caption.

---

## 9. Recent changes

| Date | Change | Files |
|---|---|---|
| 2026-09-01 | Removed unconfigured Clerk auth (was throwing on every request); fixed build-breaking TypeScript errors; added `.env.example` | `app/layout.tsx`, `lib/types/questionAnalysis.ts`, `lib/chromaIngest.ts`, `tsconfig.json` |
| 2026-09-03 | UK council corpus pipeline: 503-row LPA tracker, per-file ingest overrides, batch ingest script. 335 rows queued, none ingested (network blocked) | `data/uk-lpa-tracker.csv`, `scripts/ingest-council-plans.ts`, `lib/chromaIngest.ts` |
| 2026-09-05 | Voice mode v1: browser STT/TTS hook, full-screen overlay, Chatterbox TTS service + server proxy, spoken-style answer rewrite | `lib/useVoiceChat.ts`, `components/chat/VoiceModeOverlay.tsx`, `app/api/tts/route.ts`, `voice-service/*`, `humanizeForSpeech()` in `rag-chat/route.ts` |
| 2026-09-06 | Chatterbox: exposed `exaggeration` control with a safe fallback; added Dockerfile + HF Spaces metadata; `humanizeForSpeech` prompt now allows sparing natural filler ("so", "um") and pause punctuation | `voice-service/app.py`, `voice-service/Dockerfile`, `voice-service/README.md`, `app/api/rag-chat/route.ts`, `app/api/tts/route.ts` |
| 2026-09-06 | Full-duplex voice agent (Pipecat): local Whisper + Silero VAD + Chatterbox TTS, OpenAI-compat shim so Pipecat's own `OpenAILLMService` drives the existing RAG backend | `voice-agent/*`, `app/api/voice-llm/route.ts`, `components/chat/VoiceAgentOverlay.tsx`, `components/chat/ChatInterface.tsx`, `package.json`, `.env.example` |
| 2026-09-06 | Greeting/small-talk fast path — bypasses the entire RAG pipeline for greetings, thanks, goodbyes, capability questions | `app/api/rag-chat/route.ts` |
| 2026-09-06 | Domain term correction — deterministic STT/typo correction against corpus vocabulary, surfaced in the UI | `lib/domain-vocabulary.ts` (new), `app/api/rag-chat/route.ts`, `components/chat/ChatInterface.tsx` |
| 2026-09-07 | This file created | `PROJECT_STATE.md` |

---

## 10. Current task

Making the voice experience feel human rather than robotic. Three things landed
for that (better TTS, real turn-taking, and transcript correction); none of the
Python-side voice work has been executed yet because every environment
available to the AI assistant blocks PyPI.

---

## 11. Next actions

Ordered by value for effort.

1. **Run `voice-service/` once, in a real terminal.** `pip install -r
   requirements.txt` then `uvicorn app:app --port 8008`. This is the single
   biggest quality jump available (natural voice instead of the robotic browser
   one) and it has never been executed. Capture the first error if it fails.
2. **Run the stabilisation harness on the Mac.** `RAG_TIMING=1` in `.env.local`,
   `npm run dev`, then `node scripts/stabilization-test.mjs`. This covers
   Priority 2 (fast path + correction, 8 checks) and Priority 4 (17 RAG
   questions + a conversation-memory pair) and writes
   `stabilization-report.json`. The dev-server output carries the Priority 5
   `⏱️ TIMING` lines.
3. **Confirm `next build` completes on macOS.** ROOT CAUSE OF THE EARLIER HANG
   FOUND (2026-09-07): the assistant's shell runs in a **linux/arm64** VM, but
   `node_modules/@next/` contains only `swc-darwin-arm64` (installed on the Mac).
   Next.js cannot load an SWC binary there, so both `next build` and `next dev`
   stall or exit immediately — the 16-minute "hang" was an artifact of *where it
   was run*, not a defect in this project. Installing the linux binary needs the
   npm registry, which is blocked. **Whether the build succeeds on macOS is still
   unverified** and can only be checked on the Mac itself.
4. **Decide the fate of the four missing routes.** Either implement
   `/api/feasibility`, `/api/analyze-drawing`, `/api/diagram/svg`,
   `/api/diagram/png`, or remove the UI affordances that call them. Right now
   they present features that silently do nothing.
5. **Ingest the council corpus.** 335 plans are queued and ready; needs a machine
   with unrestricted internet to run `npm run ingest:councils`.
6. **Delete the dead code** listed in section 7, row 7, and the junk in
   `scripts/`. Zero imports, verified.
7. ~~**Commit.**~~ Done 2026-09-07 — `ae09fc1` on `chore/stabilization-pass`.
   Still to do: merge that branch into `main` so the portfolio repo shows the work.
8. **Later: latency.** Streaming, and collapsing the 4 sequential Groq calls,
   are the remaining wins after the greeting fast path.

---

## 11b. Council corpus ingestion — audit (2026-09-07)

Audit of the ingestion path **before** downloading anything. Conclusion up
front: **do not start bulk ingestion.** Two independent blockers, one of them
fatal on the current plan.

### Tracker (`data/uk-lpa-tracker.csv`)
- 502 rows. **468 `pending_ingest`** (a URL is filled in), 34 `pending_discovery`.
- 468 URLs, **446 unique** → 22 rows share a URL (joint/shared plans, expected —
  each authority needs its own row but the document is identical).
- ~70 distinct `doc_type` values. Notably **40 rows are `local_plan_policies_map`**
  — map PDFs that typically carry almost no extractable text and would produce
  near-empty or junk chunks. Candidates to exclude.
- Some rows are explicitly superseded-era documents (`local_plan_udp`,
  `*_saved_policies`), which is the "conflicting versions" risk to watch.

### Schema (write side vs read side)
Ingestion writes `documents`(title, region, jurisdiction_level, doc_type,
source_path, **source_url**, year, citation_ref, updated_at) and
`chunks`(document_id, chunk_index, content, page, page_label, clause,
clause_label, section, region, doc_type, embedding).

Retrieval (`match_rag_chunks_fulltext` in `sql/hybrid_search_setup.sql`, and
`match_rag_chunks`) returns: region, jurisdiction, doc_title, doc_path,
doc_kind, clause_label, section_heading, citation_full, content, distance,
page_from, page_to, rank.

**Metadata coverage against the requested minimum:**

| Field | Stored? | Reaches retrieval? | Note |
|---|---|---|---|
| Council / LPA name | Yes, inside `documents.title` | Yes, as `doc_title` | Only as free text; also in `jurisdiction_level` as an ONS code (`UK-ENG-E60000001`) |
| Document title | Yes | Yes | See title bug, fixed below |
| Source URL | Yes (`documents.source_url`) | **NO** | RPCs return `source_path`, never `source_url` |
| Document type | Yes | Yes (`doc_kind`) | |
| Region / country | Yes (`uk`) | Yes | Country-level only |
| Page number | Yes | Yes (`page_from`/`page_to`) | Real page numbers, good |
| Section / heading | **No** | n/a | `section`/`clause` written as `null` by design |
| Chunk text | Yes | Yes | |
| Embedding | Yes, 768-dim Gemini | Yes | Matches live config |
| Ingestion timestamp | Partial (`updated_at` date) | No | |

### Blocker 1 — council-specific retrieval does not exist
`searchRAG()` passes only `filter_region`, and region is country-level
(`india`/`uk`/`usa`). **There is no council/LPA filter anywhere.** All 468
plans would land in region `uk` alongside the NPPF and be retrieved
undifferentiated. `jurisdiction_level` (the ONS code) is returned as
`jurisdiction` but is not used for filtering, display, or citations.

Consequence for the requested pilot test: "confirm another council's Local Plan
is not incorrectly treated as Reading policy" **cannot pass today** — nothing in
the system scopes retrieval to a council. The only signal is the council name
happening to appear in `doc_title` and in the chunk text.

### Blocker 2 — citation links will not work
Citations build `directLink` from `chunk.doc_path` and only if it starts with
`http` (`app/api/rag-chat/route.ts`). Ingestion sets `source_path` to the
**file name**, and puts the real URL in `source_url`, which the RPCs never
return. So every ingested council plan would produce a citation with no working
link back to the council's PDF.

### Capacity check — MANDATORY STOP
Measured with the repo's own chunker (`CHUNK_TARGET_CHARS = 1100`,
`CHUNK_OVERLAP_CHARS = 150`) against the NPPF PDF actually in the repo:

- 130 pages → **351 chunks**, **2.7 chunks/page**, **919 chars/chunk average**

Per-chunk storage: 768-dim `vector` ≈ 3.0 KB, content ≈ 0.9 KB, generated
`content_tsv` ≈ 0.6 KB, other columns + row overhead ≈ 0.2 KB →
**≈ 4.7 KB/chunk of data**, or **≈ 8 KB/chunk** once the GIN and pgvector
indexes are counted.

Projection for 446 unique documents (page counts are estimates — the PDFs have
not been downloaded):

| Avg pages/plan | Chunks | Data only | With indexes |
|---|---|---|---|
| 150 | ~181,000 | ~0.85 GB | ~1.4 GB |
| 250 | ~301,000 | ~1.4 GB | ~2.4 GB |
| 400 | ~482,000 | ~2.3 GB | ~3.9 GB |

**Every scenario exceeds the Supabase 500 MB free tier — the most conservative
by ~1.7×, the mid case by ~5×.** Roughly **90–160 average plans** fit in 500 MB,
not 446. Bulk ingestion as planned would fill the database and start failing
partway through, leaving a half-ingested corpus.

Options to analyse before proceeding (not applied — this needs a decision):
1. **Ingest progressively** — highest-value councils first (e.g. London boroughs
   + core cities, ~50–90 authorities) and stop at a storage budget.
2. **Exclude `local_plan_policies_map` (40 rows)** — near-zero text value.
3. **Deduplicate the 22 shared-URL rows** — ingest once, link many authorities.
4. **Drop superseded documents** (`local_plan_udp`, `*_saved_policies`).
5. **Larger chunks** — 2,000–2,500 chars would roughly halve chunk count and
   embedding storage, at some retrieval-precision cost.
6. **Paid tier** — 8 GB Pro comfortably holds the full corpus (out of scope
   under the current no-paid-services constraint).

### Pipeline robustness (already good, verified by reading)
- ✅ Validates downloads by content-type **and** `%PDF-` magic bytes — an HTML
  error page is rejected, not ingested.
- ✅ Embeds **sequentially with a delay** and retries with backoff (3 attempts)
  — no uncontrolled parallel Gemini requests.
- ✅ Chunks inserted in batches of 20; tracker saved after every council, so an
  interrupt resumes safely.
- ❌ **No duplicate detection.** Re-running would ingest documents again, and the
  22 shared-URL rows would each create their own copy. Required before bulk.

### Fixed during this audit
- **Document titles were wrong for 259 of 468 rows.** The script read
  `doc_type === "local_plan" ? "Local Plan" : "Neighbourhood Plan"`, labelling
  every Core Strategy, Policies Map, Part 2, etc. as a *Neighbourhood Plan*.
  Since `documents.title` becomes `doc_title` and is shown as the citation, this
  was a wrong-citation bug, not a cosmetic one. Replaced with `docTypeLabel()`.

### Not verifiable from here
- Whether `documents.source_url` exists as a column in the live database (the
  `documents`/`chunks` DDL is not in the repo — only `hybrid_search_setup.sql`,
  `chat_history_setup.sql`, `user_documents_setup.sql`). **If that column is
  missing, every ingestion insert fails immediately.** Check before the pilot.
- `match_rag_chunks` (vector RPC) source is not in the repo either, so its exact
  return shape is unverified.
- Actual page counts, and therefore the true corpus size.

## 11c. Council-aware retrieval — design (2026-09-07)

Status: **design only, nothing implemented.** Blocked on schema verification —
see "Step 0" below. Scope is deliberately narrow: corpus architecture,
provenance, council-aware retrieval, safe ingestion. No voice, UI, model,
framework, feasibility or diagram work, and no broad refactor of the RAG route.

### The target shape

```
                    USER QUESTION
                         │
                         ▼
                  Determine scope          <- deterministic, no LLM call
            ┌────────────┼────────────┐
            ▼            ▼            ▼
        NATIONAL       LOCAL       USER PDF
          NPPF      correct LPA   uploaded doc
            └────────────┼────────────┘
                         ▼
                  RERANK EVIDENCE          <- existing rerankers, unchanged
                         ▼
                  GROUNDED ANSWER          <- existing generation, unchanged
                         ▼
                  SOURCE CITATIONS         <- now with working source URLs
```

The failure mode being designed out: search everything, hope the reranker
picks the right council. With hundreds of Local Plans in one undifferentiated
index that is not reliable, and a wrong council's policy presented as
authoritative is worse than no answer.

### Step 0 — schema verification (BLOCKING, awaiting result)
`sql/inspect-schema.sql` (read-only) must be run in the Supabase SQL Editor
first. The assistant cannot reach Supabase — the project host returns
`X-Proxy-Error: blocked-by-allowlist` — and the `documents`/`chunks` DDL is not
in this repo, so every design decision below is provisional until the real
columns, RPC bodies, indexes and constraints are known. Block 7 of that file
answers the most urgent question: whether `documents.source_url` exists at all.
If it does not, ingestion fails on its first insert.

### 1. Canonical council identity
Council identity must not depend on matching free text in titles.

- `documents.scope text not null default 'local'` — `'national'` | `'local'`
- `documents.lpa_slugs text[]` — canonical slugs, e.g. `{reading}`,
  `{tower-hamlets}`. Empty/null for national documents.
- `documents.lpa_names text[]` — human-readable, index-aligned with the slugs,
  for display and citations.

NPPF: `scope='national'`, `lpa_slugs = null`.
Local Plan: `scope='local'`, `lpa_slugs = '{reading}'`.

Slugs come from the tracker at ingestion time (the pipeline already knows which
council a document belongs to — `row.jurisdiction_key` / `row.organisation_name`),
never inferred afterwards from a title.

### 2. Shared/joint plans — how the relationship works (answering the question asked)
An array column, not duplicated chunks, and not a join table.

One physical PDF → **one `documents` row → one set of `chunks`**. Authorities
that share it are additional entries in that row's `lpa_slugs`:

```
Babergh and Mid Suffolk Joint Local Plan
  documents.lpa_slugs = '{babergh, mid-suffolk}'
  documents.lpa_names = '{Babergh District Council, Mid Suffolk District Council}'
```

Retrieval filters with array containment:
`where filter_lpa_slug is null or d.lpa_slugs @> array[filter_lpa_slug]`,
backed by `create index on documents using gin (lpa_slugs)`.

Why an array rather than a `document_lpas` join table: the retrieval RPCs
**already** `join documents d on d.id = c.document_id`, so the filter costs one
extra indexed predicate and no new join. A join table is more normalised and
would be the right call if per-authority attributes were needed (adoption date
per council, lead authority), but nothing needs that yet. This is reversible —
the array can be migrated to a join table later without touching chunks.

The 22 shared-URL tracker rows collapse to ~11 documents ingested once each,
with the participating councils listed in `lpa_slugs`. Chunks are never copied.

### 3. Provenance / citations
Both RPCs must return `d.source_url` alongside the existing `d.source_path`.
The application prefers `source_url` when building `directLink`, falling back to
`source_path` only when it already looks like a URL (current behaviour). Each
citation then carries: council name, document title, document type, page number,
source URL, and LPA slug.

### 4. `filter_lpa_slug`, added alongside — not replacing — `filter_region`

| Case | Question | Retrieval |
|---|---|---|
| A. Council-specific | "Reading's policy on tall buildings" | `scope='national'` OR `lpa_slugs @> {reading}`. Other councils excluded. |
| B. National | "What does the NPPF say about Green Belt?" | `scope='national'` preferred; local plans not blended in. |
| C. Comparison | "Compare Reading and Oxford on density" | `{reading, oxford}` ∪ national, evidence labelled by authority throughout. |
| D. Locality-dependent, unspecified | "How many parking spaces are required?" | **Ask which council.** Never blend or invent local policy. National context may be offered alongside the question. |

Case D is the one that most protects credibility, and it is a behaviour change
rather than a filter: detect that the answer is authority-dependent, detect that
no authority was given, and ask.

### 5. Council detection — deterministic, reusing what exists
`lib/domain-vocabulary.ts` already loads all 502 LPA names from
`data/uk-lpa-tracker.csv` and resolves fuzzy/misheard variants
("tower hamlet" → "Tower Hamlets", "Durrham" → "Durham"). Extending it to
return a canonical slug turns the existing corrector into the council resolver —
no new LLM call, per the requirement. It must handle "Reading",
"Reading Borough", "Reading Borough Council" → `reading`.

Ambiguity (e.g. bare "Newcastle" → Newcastle-upon-Tyne vs Newcastle-under-Lyme)
resolves to a clarifying question, never a guess.

### 6. Idempotency
- `documents.content_sha256 text` — SHA-256 of the downloaded PDF bytes.
- `documents.source_url text` — the canonical URL.
- Unique constraint on `content_sha256`.

Re-run behaviour: same hash already present → **skip** (no re-embedding, no
duplicate chunks). Same URL, different hash → the council republished the
document; record it explicitly as a new version and mark the previous one
superseded, rather than silently appending a second copy.

### 7. Plan status
`documents.plan_status text not null default 'unknown'` —
`adopted` | `emerging` | `superseded` | `unknown`.

The tracker does not carry reliable adoption status, so everything ingested now
is `unknown`. **No status will be fabricated.** `local_plan_udp` and
`*_saved_policies` rows are *candidates* for `superseded` but will not be
auto-labelled on a naming guess.

### 8. Policies Maps excluded from this phase
The 40 `local_plan_policies_map` rows stay in the tracker, untouched, and are
skipped by ingestion. They are spatial documents; PDF text extraction is the
wrong tool. Future GIS/spatial capability, not deleted.

### Pilot (only after Step 0 and implementation type-check)
Five councils plus the national layer: Reading, Manchester, Birmingham, one
London borough, one smaller district/unitary — plus NPPF.

Definition of done is behavioural, not "TypeScript passes":
Reading question → Reading + national, zero other councils; Manchester question
→ Manchester + national, zero Reading; unspecified locality → asks which
council; national question → national sources; comparison → both councils with
separated provenance; every citation resolves to the correct source document.

## 11d. Live Supabase schema — VERIFIED (2026-09-07)

Ground truth, from `sql/inspect-schema-oneshot.sql` run in the SQL Editor.
Supersedes every assumption made from reading code alone.

### Headline: the corpus is effectively empty, and it is not a UK planning corpus

| Metric | Value |
|---|---|
| `documents` rows | **615** |
| `chunks` rows | **422** |
| Database size | **19 MB** (of 500 MB free tier) |
| `chunks` total / heap / indexes | 7656 kB / 1024 kB / 4896 kB |
| `documents` total | 264 kB |

**There are more documents than chunks.** The NPPF alone measures ~351 chunks,
so essentially every one of the 615 document rows has **zero** chunks. Whatever
populated `documents` never populated `chunks` for them. Retrieval has almost
nothing to retrieve.

What is actually in there (by `doc_type`) is the legacy multi-region corpus from
the project's `zoning-copilot-ai` era — US construction contracts (FIDIC, AIA
General Conditions), FEMA flood-risk mapping, IBC/IRC building codes, NYC land
use, Jamaica zoning maps, Indian regulations. **Exactly one document has
`doc_type = 'planning_policy'` in region `uk`.** 475 of 615 rows are
`doc_type = 'other'`.

### Confirmed schema

`documents`: `id`, `region` (NOT NULL), `jurisdiction_level`, `doc_type`,
`title` (NOT NULL), `source_path` (NOT NULL), **`source_url`** (exists —
nullable), `year`, `citation_ref`, `updated_at`, `created_at`.

`chunks`: `id`, `document_id` (FK → documents), `chunk_index`, `content`,
`page`, `clause`, `section`, `region` (NOT NULL), `doc_type`, `embedding`
(`vector`), `created_at`, `page_label`, `clause_label`, `content_tsv`.

Both RPCs exist with the signatures the code expects. `match_rag_chunks`
returns 13 columns, `match_rag_chunks_fulltext` the same plus `rank`.
**Neither returns `source_url`** — confirming the dead-citation-link finding.

### Four problems found in the live database

1. **Inconsistent `region` values.** Both `uk`/`usa`/`india` *and* `US`/`IN`
   are present (39 `US`, 31 `IN`, plus more). `filter_region` uses exact
   equality and the app only ever sends `uk`/`usa`/`india`, so **~87 documents
   are unreachable** whenever a region filter is applied.
2. **Duplicate vector indexes.** `idx_chunks_embedding` and
   `idx_chunks_embedding_cosine` are both
   `ivfflat (embedding vector_cosine_ops) WITH (lists='100')` — the same index
   twice. Double the write cost and storage for no benefit; together they are
   most of the 4896 kB of chunk indexes.
3. **`lists = 100` is badly tuned for this data.** The usual guidance is roughly
   `rows / 1000`; with 422 rows most of the 100 lists are empty, which hurts
   recall. It would need revisiting at corpus scale anyway.
4. **No uniqueness beyond the primary keys.** No constraint prevents ingesting
   the same document twice — confirming the idempotency work is required, not
   optional.

### Why this is good news for the plan
- Nothing valuable is at risk. There is no real corpus to damage or migrate.
- The storage budget is effectively untouched: **19 MB used, ~481 MB free**, and
  much of that 19 MB is index overhead plus 614 content-free document rows.
- The five-council pilot can be measured against a clean, known baseline.
- `source_url` already exists, so ingestion will not fail on its first insert —
  the earlier worst case is ruled out.

### Revised storage view
The theoretical 4.7–8 KB/chunk estimate cannot be checked against this data:
422 chunks carrying 4896 kB of index is dominated by fixed ivfflat overhead and
the duplicate index, not by per-row cost. **The pilot must supply the real
number.** Baseline for that measurement: **19 MB**.

### ANSWERED: exactly one document has chunks
```
id=815  National Planning Policy Framework  region=uk  doc_type=planning_policy  chunks=422
```
That is the entire live corpus. All 614 other document rows have **zero**
chunks. The app today is, literally, an NPPF-only assistant.

Two consequences worth noting:
- The inconsistent `region` values (`US`/`IN`) matter **less than first stated**:
  every affected row is chunk-less, so those documents were never reachable by
  retrieval anyway. It is corpus debris, not a live retrieval bug.
- Real per-chunk storage, measured: `chunks` heap 1024 kB + TOAST ≈ 1736 kB over
  422 chunks ≈ **6.5 KB/chunk of data**, plus 4896 kB of indexes (inflated by
  the duplicated ivfflat index and ivfflat's fixed per-list overhead at tiny
  scale). Higher than the 4.7 KB theoretical estimate. The pilot still supplies
  the number that matters.

## 12. Change log

Append an entry after every meaningful change. Format: what changed, files
touched, what was tested, result.

### 2026-09-07 — Reviewed the Codex UI branch (PR #2). NOT merged.

**The branch forks from a different app than the one on this machine.** It is
based on `f1928d0`, which is `origin/main` — and `origin/main` does **not** have
the 18 commits sitting unpushed here. Concretely, `codex/ui-revamp-preserve-palette`
has no `ConversationSidebar.tsx`, no `VoiceAgentOverlay.tsx`, no
`lib/domain-vocabulary.ts`, no `lib/userDocuments.ts`, no `app/api/conversations/*`,
a 2,832-line `rag-chat/route.ts` against this machine's 4,206, and the **dark
slate/purple palette** rather than the paper palette (`#f7f4ee` / `neutral-950`)
this app now uses. Merging it as-is would revert the sidebar, conversation
memory, voice mode, document upload and council-aware retrieval, and change the
palette back. **Decision required from Sumit before any merge.**

- **Reviewed at:** `3521f1e` (the second commit, which corrects the first).
- **Palette claim — verified mechanically, and it holds.** `app/page.tsx`,
  `app/globals.css` and `tailwind.config.js` are byte-identical to its base;
  `app/workspace.css` contains **0** paint declarations; colour-utility usage in
  `ChatInterface.tsx` differs from base only by *count* (the new header reusing
  `bg-white/5`, `border-white/10`, `text-slate-200`), never by a new or removed
  colour; **0** hex/rgb/hsl literals added.
- **Defect found and fixed — the welcome screen fit no common laptop viewport.**
  Measured in headless Chromium: at 1366×768 the scroll area had 384px for 592px
  of content, so the three prompt cards were clipped mid-word. The composer sat
  at **252px at rest** (31% of the viewport), each card was **204px** because the
  arrow took its own row, and the hero clamp resolved to 60px. Fixed to 195px /
  content-sized cards / trimmed hero, plus **height-based** media queries — this
  is a height problem and width breakpoints cannot see it.
  **Verified no overflow at 1920×1080, 1440×900, 1366×768, 1280×720, 1152×700,
  1024×800**, none horizontal at any size.
- **Two more fixed:** card labels were a literal array indexed in parallel with
  the questions 900 lines away (a fourth suggestion would render a blank bold
  line); the mode menu closed on Escape but not on clicking away.
- **Result:** `codex/ui-revamp-reviewed` (`082c35d`) exists **locally only**.
  `tsc --noEmit` exit 0. Reduced-motion CSS confirmed under
  `--force-prefers-reduced-motion`. Nothing merged, nothing pushed.
- **NOT verified, and must be before merge:** `next build` (needs
  `@next/swc-linux-arm64`; only the darwin binary is installed and the npm
  registry is 403 from both the cloud sandbox and the device VM) and live chat
  replies + citations (need Supabase, Gemini, Groq). Layout evidence comes from a
  static harness using the branch's real compiled Tailwind + `workspace.css`, not
  from the running app.

### 2026-09-07 — Council-aware retrieval: implemented, migration still pending
- **Changed:**
  - `app/api/rag-chat/route.ts` — added `routeCouncilScope()` and
    `buildCouncilClarification()`. Four cases: A `COUNCIL_SPECIFIC` (one
    authority named → `filter_lpa_slug`), B `NATIONAL` (unchanged behaviour),
    C `COMPARISON` (one retrieval **per authority**, run in parallel and
    concatenated — a merged query lets the reranker return five chunks from one
    council and none from the other), D `COUNCIL_AMBIGUOUS` (locality-dependent
    with no authority named → ask, never blend; this turn **is** persisted so
    the follow-up "Reading" has context). `searchRAG()` takes an optional
    `lpaSlug`. Detection is deterministic — no LLM.
  - `sql/2026-09-07-council-aware-retrieval.sql` — hardened. Both RPC drops now
    enumerate every overload from `pg_proc` instead of guessing an argument
    list; a `drop function` that doesn't match exactly is a silent no-op and
    the `create` after it fails with "cannot change return type", leaving the
    migration half-applied. Step 2 now reports rows marked national and how
    many actually have chunks.
  - `lib/chromaIngest.ts` — `IngestFile` gains optional `scope`, `lpaSlugs`,
    `lpaNames`, `planStatus`, `contentSha256`; fields are only sent when
    present, so an un-migrated database still works. Skips re-embedding when
    `content_sha256` already exists.
  - `scripts/ingest-council-plans.ts` — preflight that **refuses to run**
    against an un-migrated database; skips the 40 Policies Map rows; always
    writes `plan_status='unknown'` (the tracker records ingest status, not
    adoption status); prints measured capacity at the end.
  - `lib/domain-vocabulary.ts` — **two real bugs fixed.** `&` normalised
    differently on the ingest and query sides ("telford-and-wrekin" vs
    "telford wrekin"), and a global `\b(district|borough)\b` strip mangled
    "Lake District National Park Authority" into
    "lake-national-park-authority". Four councils would have been ingested
    permanently unreachable.
  - `scripts/council-router.test.ts`, `scripts/lpa-slug-roundtrip.test.ts` (new).
- **Tested:** router 14/14; slug round-trip **337/337** councils; `tsc --noEmit`
  exit 0. All offline — **nothing has been tested against the database.**
- **Result:** Committed as `6ae5c5f` and `786e6e8`. **Blocked:** the migration
  has not been run. Until it is, `filter_lpa_slug` is rejected by Postgres, the
  code catches that once and retries **unfiltered** with a warning in the log,
  and council-specific answers are not trustworthy.

**Tracker capacity note:** 502 rows, 468 `pending_ingest` with a `source_url`,
of which 40 are Policies Maps → **428 ingestable documents**. The pilot takes
the first 5.

### 2026-09-07 — Premium UI pass 3: three defects found in screenshots
- **Changed:**
  - `app/globals.css` — appended a TOKEN CORRECTION block, last in the
    cascade. **Root cause of the black composer:** a stray `:root` block near
    line 7843 sets `--glass: rgba(10,10,11,0.95)` and `--text: #ffffff`, and
    the rule at ~line 2533 applies both to every `input[type="text"]` with
    `!important`. Tailwind classes on the input could never win. The new
    block restores `--glass: #fbf9f5`, `--text: #1c1a16`,
    `--border: rgb(61 52 38 / 0.14)`, `--bg: #f7f4ee`, plus `.uaa-composer`
    overrides for the pill radius and paper background.
  - `components/chat/ConversationSidebar.tsx` — **regression I introduced and
    have now removed.** The collapsed rail showed each conversation's first
    letter; since nearly every title begins "What" or "How", the rail was a
    column of identical letters and read as a rendering fault. Replaced with
    a position mark (short dash, elongating to an ink pill when active),
    capped at `RAIL_VISIBLE = 14` with a `+N` button that expands the
    sidebar. Titles are still exposed via `title` and `aria-label`.
  - `components/chat/ChatInterface.tsx` — the conversation column now
    reserves `min-h-[calc(100vh-16rem)]`, the same height the welcome screen
    already reserved. Previously the scroll container shrank the instant the
    first message was sent, which is what made the thinking indicator look
    like it snapped to the top of an empty page.
- **Tested:** `npx tsc --noEmit` on the Mac — exit 0. Not yet verified in a
  browser; the dev server must be restarted and the three items re-checked
  visually (composer is paper-coloured, rail shows dashes not letters, no
  jump on send).
- **Result:** Committed as `a6e1ace`. **Not pushed** — `git push` still has to
  be run by Sumit; GitHub is unreachable from the assistant's shell.

### 2026-09-07 — Proposal: local PostgreSQL + pgvector for the corpus
- **Changed:** `docs/local-postgres-corpus-proposal.md` (new). **Proposal only —
  no code changed, nothing migrated.**
- **Tested:** Audited the actual Supabase coupling rather than assuming it.
  Corpus usage is **4 call sites**: two `.rpc()` calls in
  `app/api/rag-chat/route.ts` and two `.from().insert()` calls in
  `lib/chromaIngest.ts`. Conversation memory (~11 sites) and uploaded documents
  (~8 sites) are separate and stay on Supabase. `lib/supabase.ts` is 30 lines
  with no auth/storage/realtime/RLS. Read both RPC bodies: they use only
  `vector`/`<=>`, `tsvector`, `websearch_to_tsquery`, `ts_rank_cd`, generated
  columns and `language sql` — all standard Postgres + pgvector, nothing
  Supabase-specific. `pg@^8.16.3` is already a dependency.
- **Result:** The split is a small change technically, and
  `sql/2026-09-07-council-aware-retrieval.sql` runs unchanged on local Postgres.
  **The real cost is deployment, not engineering:** a database on the Mac cannot
  serve a public portfolio URL. Recommended resolution is a `CorpusRepository`
  interface with two implementations selected by `CORPUS_BACKEND` — local
  Postgres for development with no storage ceiling, Supabase free with a curated
  30–60 council corpus for the public deploy. Also flagged: `halfvec` (2-byte
  floats) roughly halves embedding storage on either backend, and HNSW replaces
  the currently mistuned `ivfflat lists=100`. Awaiting approval before any code.

### 2026-09-07 — Council-aware retrieval: migration + council resolver
- **Changed:** (a) `sql/2026-09-07-council-aware-retrieval.sql` — additive
  migration adding `scope`, `lpa_slugs`, `lpa_names`, `plan_status` and
  `content_sha256` to `documents`, a GIN index for council filtering, a partial
  unique index on the content hash for idempotency, and recreated RPCs that now
  return `doc_url` (fixing dead citation links) plus the council fields, with
  optional `filter_lpa_slug` / `filter_scope` defaulted to null so existing
  4-argument calls behave exactly as today. Marks the NPPF `scope='national'`.
  Drops the duplicate `idx_chunks_embedding_cosine` (the only destructive
  statement, called out separately). (b) Council resolver in
  `lib/domain-vocabulary.ts`: `toLpaSlug()`, `resolveCouncils()`,
  `isLocalityDependent()` — deterministic, no LLM call, reusing the LPA
  vocabulary already loaded for transcript correction.
- **Files:** `sql/2026-09-07-council-aware-retrieval.sql` (new),
  `lib/domain-vocabulary.ts`, `PROJECT_STATE.md`.
- **Tested:** Compiled standalone and run under Node against 14 resolver cases
  plus 5 locality-dependence cases. **14/14 and 5/5 pass.** Project
  `tsc --noEmit` clean.
- **Notable:** "Reading" is both a council and a verb, and it was already in the
  common-word guard added earlier to stop "I am reading" being corrupted — so
  Reading Borough Council was initially unfindable. Rather than removing the
  guard, ambiguous names stay indexed and require a disambiguating signal
  (administrative qualifier, possessive, locative preposition, or capitalisation).
  A second round found that "What **is Reading's** policy" was rejected by the
  verb heuristic matching "is reading"; positive signals now run before it.
  Result: "Reading Borough Council", "Reading Borough", "in Reading" and
  "Reading's policy" all resolve to `reading`, while "I am reading the local
  plan", "after reading the policy" and "it is worth reading the guidance"
  correctly resolve to no council.
- **Result:** Migration ready for review; **not yet run** — it alters the live
  database, so it needs sign-off first. Resolver is done and tested. Retrieval
  wiring (passing `filter_lpa_slug` through `searchRAG`, the scope router for
  Cases A–D, and citation `directLink` preferring `doc_url`) comes next, after
  the migration is applied.

### 2026-09-07 — Live schema verified; corpus found to be effectively empty
- **Changed:** Documentation only — section 11d records verified ground truth.
  No schema or code changes.
- **Tested:** `sql/inspect-schema-oneshot.sql` run in the Supabase SQL Editor;
  output read directly from the exported CSV.
- **Result:** Assumptions replaced with facts. `documents.source_url` **exists**
  (worst case ruled out). But **615 documents vs 422 chunks** means nearly every
  document row has no chunks, and the content that is there is the legacy
  US/India/UK `zoning-copilot-ai` corpus (FIDIC contracts, IBC/IRC, NYC land
  use), not UK planning — only **one** document is `uk`/`planning_policy`.
  Also found: inconsistent region values (`US`/`IN` vs `usa`/`india`) leaving
  ~87 documents unreachable behind the region filter; two identical ivfflat
  indexes on `chunks.embedding`; `lists=100` mistuned for 422 rows; and no
  uniqueness constraint to prevent duplicate ingestion. Database is 19 MB of
  500 MB, so the pilot has a clean baseline and ~481 MB of headroom.

### 2026-09-07 — Council-aware retrieval: design + schema inspection SQL
- **Changed:** Added `sql/inspect-schema.sql` (read-only) and recorded the
  council-aware retrieval design in section 11c: canonical `lpa_slugs`/`scope`
  identity, shared-plan modelling via an array column (one document, one set of
  chunks, never duplicated), provenance fix so citations return `source_url`,
  an optional `filter_lpa_slug` alongside the existing region filter, the four
  retrieval cases including "ask which council" for unspecified locality,
  deterministic council detection reusing `lib/domain-vocabulary.ts`, content-hash
  idempotency, and `plan_status` defaulting to `unknown`.
- **Files:** `sql/inspect-schema.sql` (new), `PROJECT_STATE.md`.
- **Tested:** Confirmed the live schema cannot be inspected from here — the
  Supabase project host returns `X-Proxy-Error: blocked-by-allowlist`. No schema
  changes made, nothing guessed.
- **Result:** Design ready for review. **Implementation is blocked on Step 0**:
  `sql/inspect-schema.sql` must be run in the Supabase SQL Editor and its output
  returned, because the `documents`/`chunks` DDL is not in this repo. Block 7 in
  particular determines whether `documents.source_url` exists — if it does not,
  ingestion fails on its first insert.

### 2026-09-07 — Council corpus: ingestion audit + title bug fix
- **Changed:** Audited the full ingestion path before downloading anything (see
  section 11b). Fixed the document-title bug in `scripts/ingest-council-plans.ts`
  by adding `docTypeLabel()`.
- **Files:** `scripts/ingest-council-plans.ts`, `PROJECT_STATE.md`.
- **Tested:** `tsc --noEmit` clean (exit 0). Capacity figures measured by running
  the repo's own chunking logic over the NPPF PDF in `documents-to-ingest/`
  (130 pages → 351 chunks, 2.7/page, 919 chars/chunk), not estimated.
- **Result:** **Bulk ingestion stopped before it started.** Three findings:
  (1) projected corpus is 0.85–3.9 GB against a 500 MB free tier — every
  scenario over budget; (2) no council-level retrieval filter exists, so the
  pilot's "don't treat another council's plan as Reading policy" test cannot
  pass today; (3) citation links would be dead because the RPCs return
  `source_path` (a filename) and never `source_url`. Title bug fixed:
  259 of 468 documents would have been titled "... Neighbourhood Plan".

### 2026-09-07 — Priority 5 instrumentation + P2/P4 test harness
- **Changed:** (a) Added opt-in per-stage latency instrumentation to
  `app/api/rag-chat/route.ts`, off unless `RAG_TIMING=1`. Marks sit next to the
  STEP logs that already existed, so it measures the current flow rather than
  reshaping it — no refactor of the 3,900-line route. Emits one
  `⏱️ TIMING {...}` line per request with per-stage milliseconds, the slowest
  stage, and the total. Stages covered: term correction, conversation memory +
  condense, embedding/vector/keyword search, Groq rerank, local rerank, region
  filter, web fallback, answer generation, post-generation assembly,
  groundedness, voice rewrite. (b) Added `scripts/stabilization-test.mjs`, a
  dependency-free harness that runs Priority 2 and Priority 4 against a live
  dev server and writes `stabilization-report.json`.
- **Files:** `app/api/rag-chat/route.ts` (14 insertions),
  `scripts/stabilization-test.mjs` (new), `.gitignore`.
- **Tested:** `tsc --noEmit` clean (exit 0); `node --check` on the harness.
- **Result:** Instrumentation and harness are in place. **No latency numbers
  and no P2/P4 results yet** — see the blocker below.

### 2026-09-07 — BLOCKER: the assistant cannot execute this app
Recorded because it determines who can complete Priorities 2, 4, 5 and 6.

The assistant's shell is an isolated **linux/arm64** VM. Two independent hard
blocks, both verified today:

1. **No runnable Next.js.** `node_modules/@next/` contains only
   `swc-darwin-arm64` (installed on the Mac). `next dev` exits with "Failed to
   load SWC binary for linux/arm64"; `next build` stalls with no output — which
   is exactly what the earlier "16-minute hang" was. Installing the linux binary
   requires the npm registry, which is blocked.
2. **No network to any service the app needs.** `api.groq.com`,
   `generativelanguage.googleapis.com`, `supabase.co` and `api.tavily.com` all
   return `X-Proxy-Error: blocked-by-allowlist`. PyPI is blocked too, which is
   why `voice-service/` has never run.

Consequence: Priorities 2, 4, 5 and 6 can only be executed on the Mac itself.
Everything that does not need to run the app (Priorities 1, 3, the P5
instrumentation, and the P7 diagnosis) was completed by the assistant.

**To unblock, on the Mac:** add `RAG_TIMING=1` to `.env.local`, run
`npm run dev`, then `node scripts/stabilization-test.mjs`. Send back
`stabilization-report.json` plus the dev-server output (which carries the
`⏱️ TIMING` lines).

### 2026-09-07 — Priority 3: gate UI for functionality with no backend
- **Changed:** Added a `FEATURES` flag block to `ChatInterface.tsx` and gated
  four controls whose API routes do not exist: the entire mode selector
  (Auto/Feasibility/Permitting/Risk), the drawing-analysis upload, the
  client-side diagram SVG re-fetch, and the Download PNG button. No code was
  deleted — every path is intact and returns the moment its route exists and
  its flag flips.
- **Notable finding:** only `feasibility` was ever wired to anything. `mode` is
  read exactly twice in `app/api/rag-chat/route.ts`, both times for
  `"feasibility"`. **`"permitting"` and `"risk"` had no code path at all** and
  behaved identically to Auto — three of the four modes were decorative.
- **Files:** `components/chat/ChatInterface.tsx` (7 edits).
- **Tested:** `tsc --noEmit` across the project. Grep-verified that all four
  missing-route call sites are now behind flags, and that the working features
  (document upload, voice entry points, sources/citations, groundedness display,
  conversation sidebar) are untouched and ungated.
- **Result:** Type-check clean, exit 0. The app no longer offers any control
  that silently does nothing. **Not visually confirmed in a browser** — the
  assistant cannot run Next.js (see the SWC note in section 11).

### 2026-09-07 — Priority 1: checkpoint commit of all outstanding work
- **Changed:** Committed ~2 weeks of accumulated work that had been sitting
  uncommitted. No behavioural change — a checkpoint taken before the
  stabilisation pass. Added `.gitignore` rules for build artifacts
  (`tsconfig.tsbuildinfo`), Python caches (`voice-agent/venv/`, `__pycache__/`,
  `*.pyc`) and throwaway patch scripts. Deleted the leftover temp patch scripts.
- **Commit:** `ae09fc1` on branch `chore/stabilization-pass`
  (48 files, +8689 / -586). Authored as
  `Sumit Kumbhar <99684211+sumiitkumbhar@users.noreply.github.com>` — the
  repo-local identity was unset, so it was set to the GitHub-linked address
  already used in this repo's history (the most recent prior commit used a
  machine-local address that does not link to a GitHub profile).
- **Files:** all 48 — the full voice stack (`voice-service/`, `voice-agent/`,
  `app/api/tts`, `app/api/voice-llm`, both overlays, `lib/useVoiceChat.ts`),
  conversation memory (`app/api/conversations/*`, `lib/visitorId.ts`,
  `ConversationSidebar.tsx`), document upload (`app/api/documents/upload`,
  `lib/userDocuments.ts`), retrieval hardening (`app/api/rag-chat/route.ts`,
  `lib/domain-vocabulary.ts`, `lib/embeddings.ts`, `lib/supabase.ts`),
  corpus assets (`data/`, `documents-to-ingest/`, `scripts/`, `sql/`),
  and `PROJECT_STATE.md`.
- **Tested:** Pre-commit safety audit. Scanned all 102 candidate files for
  `gsk_`/`AIza`/`sk-`/`tvly-`/`eyJ`/credentialed `postgres://` patterns:
  **0 matches in any text file**. The single binary hit
  (`National_Planning_Policy_Framework.pdf`) was verified as a false positive —
  random `eyJ` bytes inside a compressed stream of a genuine `%PDF-1.3` file.
  Confirmed `.env.local` is both untracked and gitignored; only `.env.example`
  (all values blank) is tracked. Verified nothing ignored or junk was staged.
- **Result:** Committed. Working tree clean. **Blocker found and cleared:** a
  stale, empty `.git/index.lock` dated 2026-09-02 was silently blocking every
  git write; it needed a device delete-permission grant to remove. Worth knowing
  if git ever appears to hang again.

### 2026-09-07 — PROJECT_STATE.md created
- **Changed:** Added this file as the repo's single source of truth.
- **Files:** `PROJECT_STATE.md` (new).
- **Tested:** Audit only — no code changed. Verified against the live repo:
  API route inventory, `package.json`, installed `node_modules/@pipecat-ai`,
  model/config constants, env-var usage, git log/status, orphaned-module import
  counts (0 for each listed), missing-route call sites with line numbers.
- **Result:** Documented. `next build` was started during the audit, ran ~16
  minutes without progressing past the Next.js banner, and was killed rather
  than left running; recorded as unconfirmed rather than assumed passing.
  `node require.resolve('@pipecat-ai/client-js')` succeeds, so the 2026-09-06
  "Module not found" build error is confirmed resolved.

### 2026-09-06 — Domain term correction (STT jargon repair)
- **Changed:** New `correctDomainTerms()` runs before retrieval, fixing domain
  terms the speech recognizer mangles ("NPP" → "NPPF"). Corrected text feeds
  both retrieval and the answer prompt, which is what stopped the answer
  parroting the wrong term throughout. Vocabulary is the corpus's own: UK
  planning/building-regs terms plus ~500 council names read from
  `data/uk-lpa-tracker.csv`. Corrections are shown in the UI, never applied
  silently.
- **Files:** `lib/domain-vocabulary.ts` (new), `app/api/rag-chat/route.ts`,
  `components/chat/ChatInterface.tsx`.
- **Tested:** Compiled standalone and run under Node against 16 cases.
  Three real bugs were found and fixed before integration: "I **am** reading"
  → "I **AMR** reading" (2-letter token matching an acronym prefix — fixed with
  structural length floors, not just a word-list patch); "the **sea** view" →
  "the **SEA** view" (casing pass ran before the common-word guard — reordered);
  council names never matched at all (every one is multi-word and only single
  tokens were compared — added a phrase-window pass). Then `tsc --noEmit`.
- **Result:** 16/16 passing. `NPP`→`NPPF` (all occurrences), `n p p f`→`NPPF`,
  `tower hamlet`→`Tower Hamlets`, `Durrham`→`Durham`, `green bell`→`Green Belt`;
  "sew", "seal", "later", "am", "sea" and ordinary sentences untouched.
  ~1.4 ms per query. Type-check clean. **Not yet runtime-verified in the app.**

### 2026-09-06 — Greeting / small-talk fast path
- **Changed:** `/api/rag-chat` now answers greetings, thanks, goodbyes and
  "what can you do" immediately, before embeddings, vector search, reranking,
  answering, groundedness, or the voice rewrite. Matches the whole message, never
  a prefix, so "hi, can you tell me about loft conversions" still gets full
  retrieval. Trade-off taken deliberately: fast-pathed turns are not written to
  conversation history.
- **Files:** `app/api/rag-chat/route.ts`.
- **Tested:** `npx tsc --noEmit` across the project.
- **Result:** Clean, zero errors. **Not yet runtime-verified.**

### 2026-09-06 — Full-duplex voice agent (Pipecat)
- **Changed:** New `voice-agent/` service — Silero VAD turn detection, local
  Whisper STT, existing Chatterbox TTS, and Pipecat's own `OpenAILLMService`
  pointed at a new OpenAI-compatible shim (`/api/voice-llm`) so the existing RAG
  backend drives the conversation. New beta UI overlay, gated behind
  `NEXT_PUBLIC_VOICE_AGENT_URL`; the original voice mode is untouched.
- **Files:** `voice-agent/bot.py`, `voice-agent/chatterbox_tts.py`,
  `voice-agent/requirements.txt`, `voice-agent/README.md`,
  `app/api/voice-llm/route.ts`, `components/chat/VoiceAgentOverlay.tsx`,
  `components/chat/ChatInterface.tsx`, `package.json`, `.env.example`.
- **Tested:** Python syntax-checked. Every Pipecat class, import path and pattern
  was copied from Pipecat's current source and official examples rather than
  from memory. `npm install` later resolved the missing client packages.
- **Result:** Type-check clean; the "Module not found: @pipecat-ai/client-js"
  build error is confirmed resolved (module resolves from `node_modules`).
  **The Python side has never been executed** — PyPI is blocked in every
  environment available to the assistant.
