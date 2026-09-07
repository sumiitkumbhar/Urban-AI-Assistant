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
- **`/api/feasibility`** — called by `app/api/rag-chat/route.ts:3257`. Route does
  not exist. Fails inside a try/catch, logs, degrades silently.
- **`/api/analyze-drawing`** — called by `route.ts:3301`. Route does not exist.
  Same silent degradation.
- **`/api/diagram/svg`** — called by `ChatInterface.tsx:320`. Route does not exist.
- **`/api/diagram/png`** — called by `ChatInterface.tsx:2066`. Route does not exist.
  Diagram export is therefore dead.
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
| 5 | `next build` is extremely slow | Very heavy dependency set compiled by webpack (tesseract.js, pdfjs-dist, @napi-rs/canvas, sharp, react-pdf, playwright). See section 11 note | `package.json` |
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
2. **Runtime-verify the two 2026-09-06 backend changes.** Say "hi" (should return
   instantly, no `STEP 1` in the dev-server log) and ask about "NPPF" by voice
   (should show the amber correction note and use NPPF throughout).
3. **Confirm `next build` completes.** During this audit it was started twice
   and ran ~16 minutes without producing any output past the Next.js banner,
   then was killed to avoid leaving a runaway process on the machine. It is
   **not confirmed passing**. `tsc --noEmit` is clean and
   `@pipecat-ai/client-js` resolves, so this is a bundling-time problem, not a
   type or dependency problem. Run it in a terminal where it can take as long
   as it needs.
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

## 12. Change log

Append an entry after every meaningful change. Format: what changed, files
touched, what was tested, result.

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
