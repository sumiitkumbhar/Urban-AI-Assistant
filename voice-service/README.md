---
title: Urban AI Assistant Voice Service
emoji: 🗣️
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# CosyVoice voice service

A small FastAPI server that wraps [CosyVoice2](https://github.com/FunAudioLLM/CosyVoice)
(FunAudioLLM's open-source, Apache-2.0-licensed, LLM-based zero-shot TTS
model) so the Next.js app's voice conversation feature can call it over
HTTP. This is what makes voice mode sound like a specific, natural voice
instead of the robotic default browser voice - and there's no API key or
per-character billing, ever. You're running the model yourself.

This replaces the Chatterbox-based version of this service. The HTTP
contract (`POST /speak`, `GET /health`) and the env var name
(`CHATTERBOX_TTS_URL`, kept for backwards compatibility with your
existing `.env.local` and the `voice-agent/` integration) are unchanged,
so nothing on the Next.js side needs to change - only what's running
behind this URL is different.

## ⚠️ Be honest with yourself about performance first

CosyVoice2 is a real, ~0.5B-parameter LLM-based TTS system - meaningfully
heavier than the Chatterbox Nano model this service used to run, which
was specifically chosen for being small and CPU-fast. Two consequences:

- **No Apple Silicon acceleration.** CosyVoice's own code only checks for
  a CUDA GPU (`torch.device('cuda' if torch.cuda.is_available() else
  'cpu')`) - there's no MPS path, so on your Mac this runs on CPU only,
  not the GPU, whatever you set.
- **CPU generation is slow for a model this size.** Expect several
  seconds to generate a short reply, more for longer ones - not the "well
  within a normal reply time" the Chatterbox Nano version could claim.
  `app/api/tts/route.ts` already falls back to the browser's built-in
  voice on a timeout, so nothing breaks, but voice mode's *first*
  impression may be "that took a while" rather than instant.

If that trade-off isn't worth it for you, it's fine to leave
`CHATTERBOX_TTS_URL` unset and keep using the browser's built-in voice -
say so and we can revisit.

## ⚠️ I could not test-run this myself

Same situation as the Chatterbox version: I wrote and syntax-checked this
code against CosyVoice's own documented API (`cosyvoice/cli/cosyvoice.py`
in the repo you uploaded), but the sandboxed environment I have access to
blocks PyPI, GitHub, and ModelScope outright - the same restriction
that's blocked this whole project from reaching Supabase/Gemini directly.
**Please run the steps below yourself in a normal terminal with real
internet access** (your Mac's own Terminal.app, not through any Claude
bridge) and tell me what happens - paste me the error if anything in
CosyVoice's actual installed API differs from what's in `app.py`.

## Setup

### 1. Get the CosyVoice source next to this file

You already uploaded `CosyVoice-main.zip`, but a GitHub zip download does
**not** include the contents of git submodules - `third_party/Matcha-TTS`
in it is an empty folder. The clean fix is to just clone fresh instead of
unzipping:

```bash
cd voice-service
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git CosyVoice
```

(If you'd rather reuse the zip you already have: unzip it to
`voice-service/CosyVoice`, then separately run
`git clone https://github.com/shivammehta25/Matcha-TTS.git voice-service/CosyVoice/third_party/Matcha-TTS`
to fill in what the zip left empty.)

### 2. Python env and dependencies

CosyVoice is developed and tested on **Python 3.10**. If your default
`python3` is different (check with `python3 --version`), install 3.10
first (e.g. `brew install python@3.10`) and use that specifically below.

```bash
python3.10 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# If you hit sox compatibility issues:
brew install sox
```

This installs PyTorch and CosyVoice's other dependencies - expect this to
take a while and use a few GB of disk. (`requirements.txt` here is
trimmed down from CosyVoice's own - no gradio/webui, training, or
CUDA-only packages - since this service only needs inference.)

### 3. Model weights

You don't have to do anything for this step: `app.py` defaults
`COSYVOICE_MODEL_DIR` to the ModelScope model id `iic/CosyVoice2-0.5B`,
and CosyVoice2's constructor downloads it automatically the first time
the service starts (a few GB, one-time) into ModelScope's own cache dir
(typically `~/.cache/modelscope/hub/...`). If you'd rather pre-download
it yourself (e.g. ModelScope is slow from where you are) or keep the
weights inside this repo instead of the cache dir:

```bash
python3 -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir='CosyVoice/pretrained_models/CosyVoice2-0.5B')"
export COSYVOICE_MODEL_DIR=./CosyVoice/pretrained_models/CosyVoice2-0.5B
```

### 4. Choose a voice (required)

Unlike Chatterbox, CosyVoice2's zero-shot cloning needs **two** things: a
short (~10s) clean reference clip, *and* a text transcript of exactly
what's said in it. This step is not optional the way it sounds below:
the CosyVoice2-0.5B checkpoint ships with **zero built-in speakers**
(confirm with `curl localhost:8008/health` - `builtin_speakers` is `[]`),
so without a configured reference clip, every `/speak` request returns
503 and the app silently falls back to the browser's own robotic voice.
There's no way to get CosyVoice2 output without doing this step.

Drop the clip at `voice-service/reference_voice.wav`, then create
`voice-service/.env` (gitignored, next to `app.py`) with:

```
COSYVOICE_REFERENCE_VOICE=./reference_voice.wav
COSYVOICE_REFERENCE_PROMPT_TEXT=exactly what is said in the clip, transcribed
```

`app.py` loads this file itself on startup (via `python-dotenv`), so it
survives across terminal tabs and `uvicorn` restarts - unlike a plain
`export COSYVOICE_REFERENCE_VOICE=...` in your shell, which only lives
in that one terminal session and is gone the moment you open a new tab
or restart the process. (If you prefer `export` anyway, that still
works too - `.env` is just read first, then real env vars win if both
are set.)

## Run it

```bash
uvicorn app:app --host 0.0.0.0 --port 8008
```

Then check it's alive:

```bash
curl http://localhost:8008/health
```

And in the main app's `.env.local` (this name is unchanged on purpose -
see the top of this file):

```
CHATTERBOX_TTS_URL=http://localhost:8008
```

Restart the Next.js dev server after adding that, then try voice
conversation.

## Deploying to Hugging Face Spaces

The `Dockerfile` next to this README is set up for HF's Docker SDK, same
as before - but read the performance warning above first. Free "CPU
basic" hardware is a much rougher fit for CosyVoice2 than it was for
Chatterbox Nano; if you want this always-on and responsive, a paid GPU
Space (or your own always-on Mac, e.g. via a free
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/))
will actually feel good, free CPU likely won't. Steps are otherwise the
same as before: New Space → SDK: Docker → push this folder's contents →
wait for "Running" → set `CHATTERBOX_TTS_URL` to the Space's URL.

## `voice-agent/` (the Pipecat full-duplex pipeline)

If you're also using `voice-agent/`, nothing there needs to change -
`chatterbox_tts.py` calls this service's `/speak` HTTP endpoint by URL,
not by importing anything from this folder directly, so it works
unchanged against whichever engine is running here. It still reads
`CHATTERBOX_EXAGGERATION`; `app.py` now accepts and ignores that field
(CosyVoice has no equivalent parameter) rather than rejecting the
request.
