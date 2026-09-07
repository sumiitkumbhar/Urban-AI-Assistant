# Urban AI Assistant - voice-agent (Pipecat, full rewrite)

A real-time voice pipeline built with [Pipecat](https://github.com/pipecat-ai/pipecat), replacing the browser's own Speech Recognition (`components/chat/VoiceModeOverlay.tsx` / `lib/useVoiceChat.ts`) with continuous, server-side listening. This is what gets you real barge-in - talk over the assistant and it stops instantly - instead of the old record-then-wait-then-play loop, which can't be interrupted mid-sentence because it isn't listening while it's talking.

**This is heavier than the old pipeline.** It runs local Whisper (speech-to-text) *and* Chatterbox (text-to-speech) *and* Silero VAD (voice activity detection) all on one machine, continuously, for as long as a voice session is open. That's a deliberate trade - see the chat where this was discussed - and it's why this is meant to run on your own Mac, not the free Hugging Face Space `voice-service/` can optionally use.

## How it fits together

```
 browser mic --ws--> [bot.py, this folder]
     Silero VAD (turn detection)
     -> local Whisper STT (MLX on your M-series Mac - see below)
     -> OpenAILLMService, pointed at /api/voice-llm (not OpenAI itself -
        see that route's comment) -> your existing /api/rag-chat
     -> ChatterboxHttpTTSService -> the voice-service/ you already have running
 --ws--> browser speaker
```

Three processes run at once during a voice conversation:

1. **The Next.js app** (`npm run dev`, or however you already run it) - unchanged, plus one new route: `app/api/voice-llm/route.ts`.
2. **`voice-service/`** - unchanged, the Chatterbox TTS server from before (`uvicorn app:app --port 8008`).
3. **`voice-agent/`** (this folder) - the new Pipecat process, listening on port 7861 by default.

## Setup

```bash
cd voice-agent
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

This pulls in PyTorch-adjacent ML packages (Whisper, Silero) - expect it to take a few minutes and a couple GB of disk, similar to `voice-service/`'s setup.

### Environment variables (optional - all have working defaults)

```bash
export RAG_LLM_URL=http://localhost:3000/api/voice-llm   # your Next.js app
export CHATTERBOX_TTS_URL=http://localhost:8008          # your voice-service/
export CHATTERBOX_EXAGGERATION=0.6                        # same dial as voice-service/app.py
export WHISPER_BACKEND=mlx                                 # "mlx" (Apple Silicon) or "faster" (CPU)
```

## Run it

Start all three processes (separate terminal tabs):

```bash
# 1. Next.js app (if not already running)
npm run dev

# 2. Chatterbox TTS (if not already running - see ../voice-service/README.md)
cd voice-service && uvicorn app:app --host 0.0.0.0 --port 8008

# 3. This voice agent
cd voice-agent && source venv/bin/activate
python bot.py -t websocket --host 0.0.0.0 --port 7861
```

The third command starts a local server at `http://localhost:7861`. A browser client connects by calling `POST /start` (which allocates a session and hands back a WebSocket URL), then opens that WebSocket - `components/chat/VoiceAgentOverlay.tsx` does this automatically via `@pipecat-ai/client-js`.

Then set, in the Next.js app's `.env.local`:

```
NEXT_PUBLIC_VOICE_AGENT_URL=http://localhost:7861
RAG_LLM_URL=http://localhost:3000/api/voice-llm
```

and restart `npm run dev` so the new "Full-duplex voice (beta)" button appears next to the existing "Start voice conversation" one.

### Trying it before touching the app's UI

Pipecat ships a minimal reference client for exactly this transport at [github.com/pipecat-ai/pipecat-examples/tree/main/websocket/client](https://github.com/pipecat-ai/pipecat-examples/tree/main/websocket/client) - worth running that first (point its `VITE_PIPECAT_BASE_URL` at `http://localhost:7861`) to confirm the backend actually works end to end before debugging it through the full Next.js app. If something's going to go wrong the first time - and given nobody has run this specific combination before, something probably will - it's much faster to find out there than inside React.

## ⚠️ I could not run this myself

Same situation as `voice-service/README.md`: the sandbox this was written in blocks PyPI outright, so I could not install `pipecat-ai` or run any of this. Every import path, class name, and pattern in `bot.py` and `chatterbox_tts.py` is copied directly from Pipecat's own current, real source and examples (not memory, not older tutorials - this framework has moved since most blog posts about it were written), but "copied correctly" is not the same as "verified by running it."

**Please run it yourself and tell me what happens.** If the first error is an import error, a changed parameter name, or a class that's moved, paste it to me exactly and I'll fix the code - I just can't be the one running it to find out.

## Known rough edges to expect

- **First run is slow.** Whisper (MLX or faster-whisper) downloads its model weights the first time it loads, same as Chatterbox did.
- **CPU/GPU load.** Running Whisper, Chatterbox, and VAD together is real work - if responses feel sluggish, `WHISPER_MLX_MODEL=tiny` or `WHISPER_MODEL=tiny` (see `bot.py`) trades transcription accuracy for speed.
- **Latency is bounded by `/api/rag-chat`, not this pipeline.** The RAG answer (retrieval + Groq LLM + groundedness check + `humanizeForSpeech`) is one blocking call - this pipeline doesn't stream partial LLM tokens into TTS the way a from-scratch Realtime API integration would, because your RAG accuracy checks aren't themselves streamable without a separate, larger refactor. What you get here is real turn detection and real interruption; time-to-first-word-of-answer is a separate, later optimization.
