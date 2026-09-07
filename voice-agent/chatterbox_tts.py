"""Chatterbox HTTP TTS service for Pipecat.

Talks to the same self-hosted Chatterbox voice-service (see
../voice-service/README.md) that the old browser-based voice pipeline
already calls through app/api/tts/route.ts - this lets the new Pipecat
voice-agent reuse that exact process instead of duplicating a TTS backend.

Modeled directly on Pipecat's own PiperHttpTTSService
(pipecat.services.piper.tts) - that's the closest real, currently-shipping
example of "wrap a local HTTP TTS server as a Pipecat TTSService", verified
against the actual pipecat-ai source (github.com/pipecat-ai/pipecat) rather
than assumed. I could not install or run pipecat-ai anywhere in the
environment this was written in (same PyPI network restriction noted
throughout this project - see voice-service/README.md), so this has not
been executed. If the installed pipecat-ai version's TTSService base class
differs from what's used here, paste me the error and I'll fix it.
"""

from collections.abc import AsyncGenerator
from dataclasses import dataclass

import aiohttp
from loguru import logger

from pipecat.frames.frames import ErrorFrame, Frame, TTSStoppedFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService


@dataclass
class ChatterboxTTSSettings(TTSSettings):
    """Settings for ChatterboxHttpTTSService.

    Parameters:
        exaggeration: Chatterbox's own "monotone to dramatically expressive"
            dial (0.0-1.0). Mirrors the `exaggeration` field added to
            voice-service/app.py's SpeakRequest.
    """

    exaggeration: float = 0.6


class ChatterboxHttpTTSService(TTSService):
    """Wraps the self-hosted Chatterbox voice-service's POST /speak endpoint.

    voice-service/app.py streams back a WAV file (StreamingResponse), same
    shape as Piper's own HTTP server - so the same
    `_stream_audio_frames_from_iterator(strip_wav_header=True, ...)` helper
    Pipecat's base TTSService already provides handles the WAV header
    stripping and sample-rate detection/resampling automatically.
    """

    Settings = ChatterboxTTSSettings
    _settings: Settings

    def __init__(
        self,
        *,
        base_url: str,
        aiohttp_session: aiohttp.ClientSession,
        exaggeration: float = 0.6,
        settings: Settings | None = None,
        **kwargs,
    ):
        """Initialize the Chatterbox HTTP TTS service.

        Args:
            base_url: Base URL of the running voice-service (e.g.
                "http://localhost:8008") - same value as the Next.js app's
                CHATTERBOX_TTS_URL env var, minus the "/speak" suffix.
            aiohttp_session: Shared aiohttp ClientSession for HTTP requests.
            exaggeration: Default expressiveness (0.0-1.0) if not overridden
                via `settings`.
            settings: Runtime-updatable settings.
            **kwargs: Additional arguments passed to the parent TTSService.
        """
        default_settings = self.Settings(
            model=None, voice=None, language=None, exaggeration=exaggeration
        )
        if settings is not None:
            default_settings.apply_update(settings)

        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            settings=default_settings,
            **kwargs,
        )

        if base_url.endswith("/"):
            base_url = base_url[:-1]
        self._base_url = base_url
        self._session = aiohttp_session

    def can_generate_metrics(self) -> bool:
        """Chatterbox generation latency is worth tracking - it's the one
        piece of this pipeline running on ordinary CPU/MPS, not a cloud API.
        """
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        """Generate speech from text via voice-service's /speak endpoint.

        Args:
            text: The text to convert to speech.
            context_id: Unique identifier for this TTS context.

        Yields:
            Frame: Audio frames containing the synthesized speech, or an
                ErrorFrame if voice-service is unreachable or fails.
        """
        try:
            data = {"text": text, "exaggeration": self._settings.exaggeration}
            async with self._session.post(
                f"{self._base_url}/speak",
                json=data,
                headers={"Content-Type": "application/json"},
            ) as response:
                if response.status != 200:
                    error = await response.text()
                    yield ErrorFrame(
                        error=(
                            f"voice-service returned {response.status}: {error} "
                            f"(is it running at {self._base_url}? see "
                            "../voice-service/README.md)"
                        )
                    )
                    yield TTSStoppedFrame(context_id=context_id)
                    return

                await self.start_tts_usage_metrics(text)

                async for frame in self._stream_audio_frames_from_iterator(
                    response.content.iter_chunked(self.chunk_size),
                    strip_wav_header=True,
                    context_id=context_id,
                ):
                    await self.stop_ttfb_metrics()
                    yield frame
        except aiohttp.ClientConnectorError as e:
            yield ErrorFrame(
                error=(
                    f"Could not reach voice-service at {self._base_url}: {e}. "
                    "Is `uvicorn app:app --port 8008` running in voice-service/?"
                )
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"{self} exception: {e}")
            yield ErrorFrame(error=f"Unknown error occurred: {e}")
        finally:
            await self.stop_ttfb_metrics()
