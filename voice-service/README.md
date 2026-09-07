---
title: Urban AI Assistant Voice Service
emoji: 🗣️
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Chatterbox voice service

A small FastAPI server that wraps [Chatterbox](https://github.com/resemble-ai/chatterbox) (Resemble AI's open-source, MIT-licensed text-to-speech model) so the Next.js app's voice conversation feature can call it over HTTP. This is what makes voice mode sound natural instead of using the robotic default browser voice - and it costs nothing to run: no API key, no per-character billing, ever. You're running the model yourself.

It's a *separate* long-running process from the Next.js app. `app/api/tts/route.ts` calls it at whatever URL you set as `CHATTERBOX_TTS_URL`; if this service isn't running or isn't configured, voice mode automatically falls back to the browser's own built-in voice (see `lib/useVoiceChat.ts`), so nothing breaks if you skip this entirely or it's temporarily down.

## Why "Nano"

Chatterbox ships three sizes. This service uses **Nano** (110M parameters) specifically because Resemble describes it as running "3x faster than realtime on 8 CPU cores" - i.e. built to run on ordinary hardware, no GPU rental needed. The Turbo (350M) and Multilingual (500M) variants sound similar but want a GPU to be fast; skip them unless you already have one.

## ⚠️ Important: I could not test-run this myself

I wrote and verified this code (syntax-checked the Python, and it follows Chatterbox's own documented usage exactly), but I could not actually install or run it from this session - the sandboxed environment I have access to sits behind a network allowlist that blocks PyPI entirely (the same restriction that's blocked this whole project from reaching Supabase/Gemini directly). So: **please run the steps below yourself in a normal terminal with real internet access** (your Mac's own Terminal.app, not through any Claude bridge), and tell me what happens - if Chatterbox's actual installed API differs even slightly from its public docs, I'll need you to paste me the error to fix it.

## Setup

Chatterbox is developed and tested on **Python 3.11**. If your default `python3` is a different version (check with `python3 --version`), install 3.11 first (e.g. `brew install python@3.11` on macOS) and use that specifically below.

```bash
cd voice-service
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

This will download PyTorch and the Chatterbox Nano model weights - expect this to take a while and use a few GB of disk the first time.

### Optional: choose a voice

Chatterbox's own examples always pass a short (~10 second) reference audio clip to clone a specific voice - it's not clearly documented whether skipping this falls back to some default voice or not. To pick a voice, drop a short, clean WAV recording (anyone talking normally for ~10 seconds - no music/background noise) at `voice-service/reference_voice.wav` and set:

```bash
export CHATTERBOX_REFERENCE_VOICE=./reference_voice.wav
```

If you skip this, the service will try generating without a reference clip - check the `/health` endpoint and the service's logs if that doesn't produce audio, and let me know what error comes back so I can adjust the code.

### Apple Silicon (M1/M2/M3/M4) speed-up

If you're running this natively on your Mac (not inside a sandboxed VM), you can use its GPU:

```bash
export CHATTERBOX_DEVICE=mps
```

## Run it

```bash
uvicorn app:app --host 0.0.0.0 --port 8008
```

Then check it's alive:

```bash
curl http://localhost:8008/health
```

And in the main app's `.env.local`, point it there:

```
CHATTERBOX_TTS_URL=http://localhost:8008
```

Restart the Next.js dev server after adding that, then try voice conversation - it'll now call this service instead of falling back to the browser voice.

## Deploying to Hugging Face Spaces (free, always-on-ish, no bill)

This folder is already set up as a Hugging Face Space (the YAML block at
the very top of this file, plus the `Dockerfile` next to this README, are
what HF's Docker SDK reads). Steps:

1. Create a free account at [huggingface.co](https://huggingface.co/join) if you don't have one.
2. Click **New Space** → give it a name → SDK: **Docker** → hardware: **CPU basic** (free) → Create Space.
3. Push this `voice-service` folder's contents (`Dockerfile`, `app.py`, `requirements.txt`, this `README.md`, and `reference_voice.wav` if you added one) to the Space's own git repo - HF gives you the exact `git remote add`/`git push` commands on the Space's page, or you can drag-and-drop the files in the "Files" tab in your browser instead of using git at all.
4. Wait for the "Building" status to turn into "Running" (the first build installs PyTorch + Chatterbox, so expect several minutes).
5. Copy the Space's URL (looks like `https://<your-username>-<space-name>.hf.space`) and set it as `CHATTERBOX_TTS_URL` in the main app's `.env.local`.

**What "free" actually gets you here, honestly:**

- CPU Basic is 2 shared vCPUs - the "3x realtime" figure Resemble quotes for Nano was benchmarked on 8 cores, so expect noticeably slower than that, though still well within a normal conversational reply time for short answers.
- Free Spaces go to sleep after a period of inactivity and take a bit to wake back up (and reload the model into memory) on the next request - the very first message after a lull may lag or briefly fail; `app/api/tts/route.ts` already falls back to the browser's built-in voice automatically if a request times out, so nothing breaks, it just sounds robotic for that one reply.
- No API key, no per-character billing, no credit card - this is genuinely the $0 option, not a free trial.

### Other hosting options

- **Local development**: just leave `uvicorn app:app --host 0.0.0.0 --port 8008` running in a terminal tab while you work.
- **Your own Mac, always-on**: only works if the Mac stays on and is exposed to the internet (e.g. a free [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)) - more control than a free Space, but "always on" now means your Mac, not HF's servers.

Either way, the "no money" rule holds: nothing here is a paid API - the only real cost is whose compute keeps the process running.
