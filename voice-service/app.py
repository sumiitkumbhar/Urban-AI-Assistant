"""
CosyVoice voice service - a small FastAPI wrapper around FunAudioLLM's
CosyVoice2 (Apache-2.0), an open-source, LLM-based zero-shot TTS model.
This is what gives Urban AI Assistant's voice conversation a natural,
cloned-voice sound instead of the robotic default browser voice - and it
costs nothing to run in API terms: no key, no per-character billing, just
your own compute (see README.md for the realistic hosting options - this
is a heavier model than the Chatterbox service it replaced, so "free
cloud CPU" is no longer a great fit; running it locally is the
recommended path).

This process is meant to run continuously, separate from the Next.js app:
Next.js's app/api/tts/route.ts calls it over HTTP at CHATTERBOX_TTS_URL
(name kept for backwards compatibility with existing .env.local files and
the voice-agent/ integration - it just points at "the voice service",
whichever engine is behind it). Run it with:

    uvicorn app:app --host 0.0.0.0 --port 8008

See README.md in this folder for full setup instructions: getting the
CosyVoice source + its Matcha-TTS submodule next to this file, model
download, and how to configure a cloned voice.
"""

import io
import logging
import os
import sys
from contextlib import asynccontextmanager

import torch
import torchaudio as ta
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cosyvoice-service")

# Load voice-service/.env (if present) before reading any env vars below.
# This matters specifically for COSYVOICE_REFERENCE_VOICE /
# COSYVOICE_REFERENCE_PROMPT_TEXT: a plain `export` in one terminal tab
# doesn't survive into a new tab or a later `uvicorn` restart, which is
# exactly how this service kept coming up with no cloned voice configured
# despite having been exported earlier. A .env file next to this one
# fixes that the same way .env.local already does for the Next.js app.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# The CosyVoice package isn't published to PyPI - it's used by putting the
# repo (and its Matcha-TTS submodule) on sys.path, exactly as CosyVoice's
# own README and examples do. See README.md for how this folder gets here.
_HERE = os.path.dirname(os.path.abspath(__file__))
_COSYVOICE_ROOT = os.environ.get(
    "COSYVOICE_REPO_DIR", os.path.join(_HERE, "CosyVoice")
)
sys.path.insert(0, _COSYVOICE_ROOT)
sys.path.insert(0, os.path.join(_COSYVOICE_ROOT, "third_party", "Matcha-TTS"))

# Passed straight through to CosyVoice2(model_dir=...). CosyVoice2's own
# constructor only auto-downloads via modelscope when model_dir does NOT
# already exist as a local path - and when it downloads, it passes
# model_dir itself to modelscope as the model id, so the default here
# has to be the actual ModelScope id ("iic/CosyVoice2-0.5B"), not an
# arbitrary local folder name (an earlier version of this file got that
# backwards and failed with "the request model: <local path> does not
# exist!"). This downloads to modelscope's own cache dir (typically
# ~/.cache/modelscope/hub/...) - the first request after a fresh start
# will be slow for that reason alone, separate from generation time. To
# keep the weights inside this repo instead, pre-download with
# `snapshot_download('iic/CosyVoice2-0.5B', local_dir=...)` (see
# README.md) and point COSYVOICE_MODEL_DIR at that local_dir.
MODEL_DIR = os.environ.get("COSYVOICE_MODEL_DIR", "iic/CosyVoice2-0.5B")

# CosyVoice2's zero-shot cloning needs a short reference clip *and* a
# text transcript of what's actually said in it - unlike Chatterbox,
# which only wanted the clip. Both must be set together, or neither.
REFERENCE_VOICE_PATH = os.environ.get("COSYVOICE_REFERENCE_VOICE", "").strip() or None
REFERENCE_PROMPT_TEXT = (
    os.environ.get("COSYVOICE_REFERENCE_PROMPT_TEXT", "").strip() or None
)

# The name this service registers the cloned voice under, once, at
# startup - so every /speak request reuses the already-processed
# embedding instead of re-analysing the reference clip on every call.
_SPK_ID = "urban_ai_voice"

_model = None
_model_load_error: str | None = None
_spk_registered = False


def get_model():
    global _model, _model_load_error, _spk_registered
    if _model is None and _model_load_error is None:
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2

            logger.info("Loading CosyVoice2 from %s ...", MODEL_DIR)
            _model = CosyVoice2(MODEL_DIR)
            logger.info(
                "CosyVoice2 loaded (sample_rate=%s, cuda=%s).",
                _model.sample_rate,
                torch.cuda.is_available(),
            )
        except Exception as exc:  # noqa: BLE001 - surface it, don't crash the process
            _model_load_error = str(exc)
            logger.exception("Failed to load CosyVoice2 model")

        # Voice-clone registration is optional and separate from model
        # loading on purpose: a bad/missing reference clip should mean
        # "no cloned voice available" (falls back to inference_sft /
        # a clear error at /speak time), not "the whole service is down".
        if _model is not None and REFERENCE_VOICE_PATH and REFERENCE_PROMPT_TEXT:
            try:
                from cosyvoice.utils.file_utils import load_wav

                logger.info("Registering cloned voice from %s ...", REFERENCE_VOICE_PATH)
                prompt_wav = load_wav(REFERENCE_VOICE_PATH, 16000)
                _model.add_zero_shot_spk(REFERENCE_PROMPT_TEXT, prompt_wav, _SPK_ID)
                _spk_registered = True
                logger.info("Cloned voice registered as %r.", _SPK_ID)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Could not register cloned voice from %s - continuing "
                    "without it (check the path and that it's a valid WAV).",
                    REFERENCE_VOICE_PATH,
                )
        elif _model is not None and (REFERENCE_VOICE_PATH or REFERENCE_PROMPT_TEXT):
            logger.warning(
                "Only one of COSYVOICE_REFERENCE_VOICE / "
                "COSYVOICE_REFERENCE_PROMPT_TEXT is set - both are "
                "required for voice cloning. Falling back to whatever "
                "speakers (if any) ship with the model."
            )
    if _model_load_error is not None:
        raise RuntimeError(_model_load_error)
    return _model


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load (and register the cloned voice, if configured) at startup, not
    # on the first request - both steps are slow one-time costs, and the
    # first real user shouldn't be the one waiting through them.
    try:
        get_model()
    except Exception:
        logger.error("Starting with no model loaded - /speak will fail until fixed.")
    yield


app = FastAPI(title="CosyVoice TTS service", lifespan=lifespan)


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    speed: float = Field(1.0, ge=0.5, le=2.0)
    # Accepted for backwards compatibility with callers built against the
    # old Chatterbox service (voice-agent/chatterbox_tts.py sends this) -
    # CosyVoice has no equivalent knob, so it's parsed and ignored rather
    # than rejected.
    exaggeration: float | None = None


@app.get("/health")
def health():
    spks = []
    if _model is not None:
        try:
            spks = _model.list_available_spks()
        except Exception:  # noqa: BLE001
            pass
    return {
        "status": "ok" if _model is not None else "model_not_loaded",
        "model_dir": MODEL_DIR,
        "cuda_available": torch.cuda.is_available(),
        "cloned_voice_registered": _spk_registered,
        "reference_voice_configured": REFERENCE_VOICE_PATH is not None
        and REFERENCE_PROMPT_TEXT is not None,
        "builtin_speakers": spks,
        "error": _model_load_error,
    }


@app.post("/speak")
def speak(req: SpeakRequest):
    try:
        model = get_model()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Model not loaded: {exc}")

    try:
        from cosyvoice.utils.file_utils import load_wav

        if _spk_registered:
            outputs = model.inference_zero_shot(
                req.text, "", "", zero_shot_spk_id=_SPK_ID, stream=False, speed=req.speed
            )
        elif REFERENCE_VOICE_PATH and REFERENCE_PROMPT_TEXT:
            # Registration failed at startup but the config is there -
            # retry per-request rather than failing every call forever.
            prompt_wav = load_wav(REFERENCE_VOICE_PATH, 16000)
            outputs = model.inference_zero_shot(
                req.text,
                REFERENCE_PROMPT_TEXT,
                prompt_wav,
                stream=False,
                speed=req.speed,
            )
        else:
            spks = model.list_available_spks()
            if not spks:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "No cloned or built-in voice available. Set "
                        "COSYVOICE_REFERENCE_VOICE to a short (~10s) WAV "
                        "clip and COSYVOICE_REFERENCE_PROMPT_TEXT to a "
                        "transcript of what's said in it, then restart "
                        "the service. See README.md."
                    ),
                )
            outputs = model.inference_sft(req.text, spks[0], stream=False, speed=req.speed)

        chunks = [o["tts_speech"] for o in outputs]
        if not chunks:
            raise HTTPException(status_code=500, detail="Model produced no audio")
        wav = torch.cat(chunks, dim=1) if len(chunks) > 1 else chunks[0]
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("CosyVoice generation failed")
        raise HTTPException(
            status_code=500,
            detail=f"Speech generation failed. Original error: {exc}",
        )

    buffer = io.BytesIO()
    ta.save(buffer, wav, model.sample_rate, format="wav")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="audio/wav")
