"""
Chatterbox voice service - a small FastAPI wrapper around Resemble AI's
open-source (MIT) Chatterbox TTS, specifically the Nano variant, which
Resemble ships for CPU inference ("3x realtime on 8 cores"). This is what
gives Urban AI Assistant's voice conversation a natural, ChatGPT-voice-
mode-like sound instead of the robotic default browser voice - and it
costs nothing to run: no API key, no per-character billing, just your own
compute (or a free host - see README.md for a Hugging Face Spaces option).

This process is meant to run continuously, separate from the Next.js app:
Next.js's app/api/tts/route.ts calls it over HTTP at CHATTERBOX_TTS_URL.
Run it with:

    uvicorn app:app --host 0.0.0.0 --port 8008

See README.md in this folder for full setup instructions, the Python
version note, and how to set a reference voice.
"""

import io
import logging
import os
from contextlib import asynccontextmanager

import torchaudio as ta
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("chatterbox-service")

# "cpu" works everywhere. If you end up running this natively on an Apple
# Silicon Mac (not through a Linux sandbox/VM), "mps" uses the Mac's own
# GPU and is noticeably faster - see README.md.
DEVICE = os.environ.get("CHATTERBOX_DEVICE", "cpu")

# Chatterbox's own examples always pass a short (~10s) reference clip via
# audio_prompt_path to clone a specific voice - it is not documented
# whether omitting it falls back to some default voice. Point this at a
# WAV file of a voice you like to get a consistent, chosen voice; if you
# leave it unset, generate() is called without a reference clip, which
# may or may not work depending on the installed Chatterbox version -
# check the startup log and the /health endpoint if voice output fails.
REFERENCE_VOICE_PATH = (
    os.environ.get("CHATTERBOX_REFERENCE_VOICE", "").strip() or None
)

_model = None
_model_load_error: str | None = None


def get_model():
    global _model, _model_load_error
    if _model is None and _model_load_error is None:
        try:
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            logger.info("Loading Chatterbox Nano on device=%s ...", DEVICE)
            _model = ChatterboxTurboTTS.from_pretrained(device=DEVICE, nano=True)
            logger.info("Chatterbox Nano loaded.")
        except Exception as exc:  # noqa: BLE001 - surface it, don't crash the process
            _model_load_error = str(exc)
            logger.exception("Failed to load Chatterbox model")
    if _model_load_error is not None:
        raise RuntimeError(_model_load_error)
    return _model


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load at startup, not on the first request - so the first real user
    # isn't the one waiting through the (slow, one-time) model load.
    try:
        get_model()
    except Exception:
        # Don't crash the whole process on a bad startup - /health will
        # report it, and /speak will return a clear error, rather than the
        # service refusing to even come up (which would take Next.js's
        # error handling out of the loop entirely).
        logger.error("Starting with no model loaded - /speak will fail until fixed.")
    yield


app = FastAPI(title="Chatterbox TTS service", lifespan=lifespan)


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    # 0.0-1.0: Chatterbox's own "monotone to dramatically expressive"
    # dial. Untested from this side (see the big warning up top) - if the
    # installed version rejects this kwarg, speak() below falls back to
    # calling generate() without it rather than failing the request.
    exaggeration: float = Field(0.6, ge=0.0, le=1.0)


@app.get("/health")
def health():
    return {
        "status": "ok" if _model is not None else "model_not_loaded",
        "device": DEVICE,
        "reference_voice_configured": REFERENCE_VOICE_PATH is not None,
        "error": _model_load_error,
    }


@app.post("/speak")
def speak(req: SpeakRequest):
    try:
        model = get_model()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=f"Model not loaded: {exc}")

    try:
        try:
            if REFERENCE_VOICE_PATH:
                wav = model.generate(
                    req.text,
                    audio_prompt_path=REFERENCE_VOICE_PATH,
                    exaggeration=req.exaggeration,
                )
            else:
                wav = model.generate(req.text, exaggeration=req.exaggeration)
        except TypeError:
            # Installed Chatterbox version doesn't take this kwarg -
            # fall back to its default expressiveness rather than failing
            # the request over a cosmetic parameter.
            logger.warning(
                "generate() rejected exaggeration=; retrying without it"
            )
            if REFERENCE_VOICE_PATH:
                wav = model.generate(req.text, audio_prompt_path=REFERENCE_VOICE_PATH)
            else:
                wav = model.generate(req.text)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Chatterbox generation failed")
        raise HTTPException(
            status_code=500,
            detail=(
                "Speech generation failed. If this is about a missing "
                "reference voice, set CHATTERBOX_REFERENCE_VOICE to a "
                "short (~10 second) WAV clip of a voice you like and "
                "restart the service. Original error: " + str(exc)
            ),
        )

    buffer = io.BytesIO()
    ta.save(buffer, wav, model.sr, format="wav")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="audio/wav")
