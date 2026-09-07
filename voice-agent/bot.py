"""Urban AI Assistant - real-time voice agent, built with Pipecat.

This is the "full rewrite" option: it replaces the browser's own Speech
Recognition (components/chat/VoiceModeOverlay.tsx / lib/useVoiceChat.ts)
with continuous, server-side listening, so the assistant can actually hear
you while it's mid-sentence and stop talking the instant you start - real
barge-in, not just a manual "tap to interrupt" button. That's the trade
made deliberately here: heavier to run (Whisper + Chatterbox + VAD all on
one machine), in exchange for the pipeline that ChatGPT's voice mode
actually uses (listen continuously -> detect end-of-turn -> answer ->
speak -> get interrupted -> repeat), instead of a walkie-talkie loop.

Pipeline (see ../voice-service/README.md for the TTS half, already running
today):

    browser mic --ws--> [this process]
        Silero VAD (turn detection, on the user aggregator)
        -> local Whisper STT (MLX on Apple Silicon, faster-whisper
           elsewhere - audio never leaves this machine)
        -> OpenAILLMService, pointed at the Next.js app's
           /api/voice-llm shim instead of OpenAI's own API - that shim
           calls the real /api/rag-chat (Groq + retrieval + groundedness
           check + humanizeForSpeech) and hands back one complete answer
           shaped like an OpenAI chat-completion response. (See that
           route's own comment for why a shim, instead of writing a
           custom Pipecat LLM service against Pipecat's own - fast-moving -
           internal context/streaming protocol.)
        -> ChatterboxHttpTTSService (chatterbox_tts.py, this folder) -
           talks to the same voice-service/app.py the old pipeline uses
    --ws--> browser speaker

Honesty note, same as everywhere else in this project: I could not
install or run pipecat-ai anywhere in the environment this was written in
- PyPI is blocked by this sandbox's network policy (see
voice-service/README.md for the full story). Every class, import path, and
pattern below is copied from Pipecat's own current, real source
(github.com/pipecat-ai/pipecat and github.com/pipecat-ai/pipecat-examples -
specifically examples/simple-chatbot/server/bot-openai.py and
examples/websocket/bot.py), not guessed from memory or older tutorials
(this framework moved noticeably since most blog posts about it were
written - e.g. VAD is now wired through LLMContextAggregatorPair, not a
`vad_analyzer` field on the transport). But "copied correctly" isn't the
same as "verified by running it". Run it with the command at the bottom of
README.md and paste me the first error if one comes up.
"""

import os
import platform

import aiohttp
from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.serializers.protobuf import ProtobufFrameSerializer
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import BaseTransport
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams
from pipecat.workers.runner import WorkerRunner

from chatterbox_tts import ChatterboxHttpTTSService

load_dotenv(override=True)

# app/api/voice-llm/route.ts - the OpenAI-compat shim over /api/rag-chat.
# Point this at wherever the Next.js app is actually running (3000 is its
# local dev default).
RAG_LLM_URL = os.environ.get("RAG_LLM_URL", "http://localhost:3000/api/voice-llm")

# The already-running voice-service/ process (see its own README.md) -
# unchanged by this new pipeline, just called from a different caller.
CHATTERBOX_TTS_URL = os.environ.get("CHATTERBOX_TTS_URL", "http://localhost:8008")
CHATTERBOX_EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.6"))

IS_APPLE_SILICON = platform.system() == "Darwin" and platform.machine() == "arm64"


def make_stt_service():
    """Local Whisper: MLX (Apple's Metal, fast) on Apple Silicon by default,
    faster-whisper (CPU) everywhere else, or if WHISPER_BACKEND=faster is
    set explicitly. Either way transcription happens on this machine - no
    audio goes to a cloud STT API.
    """
    backend = os.environ.get("WHISPER_BACKEND", "mlx" if IS_APPLE_SILICON else "faster")

    if backend == "mlx":
        from pipecat.services.whisper.stt import MLXModel, WhisperSTTServiceMLX

        # LARGE_V3_TURBO is meaningfully more accurate and, per Pipecat's own
        # model list, still fast on Apple Silicon - worth trying if MEDIUM's
        # transcription quality feels like the weak link.
        model = os.environ.get("WHISPER_MLX_MODEL", MLXModel.MEDIUM.value)
        logger.info(f"Loading local Whisper (MLX, Apple Silicon), model={model} ...")
        return WhisperSTTServiceMLX(model=model)

    from pipecat.services.whisper.stt import Model, WhisperSTTService

    model = os.environ.get("WHISPER_MODEL", Model.DISTIL_MEDIUM_EN.value)
    logger.info(f"Loading local Whisper (faster-whisper, CPU), model={model} ...")
    return WhisperSTTService(model=model)


transport_params = {
    "websocket": lambda: FastAPIWebsocketParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
        add_wav_header=False,
        serializer=ProtobufFrameSerializer(),
    ),
}


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    """Assemble and run the voice pipeline for one connected client."""
    logger.info("Starting Urban AI Assistant voice agent")

    stt = make_stt_service()

    async with aiohttp.ClientSession() as session:
        tts = ChatterboxHttpTTSService(
            base_url=CHATTERBOX_TTS_URL,
            aiohttp_session=session,
            exaggeration=CHATTERBOX_EXAGGERATION,
        )

        # api_key is required by the OpenAI SDK client OpenAILLMService wraps
        # internally, but RAG_LLM_URL below is our own Next.js route (not
        # OpenAI's API) and ignores it entirely - no real OpenAI account is
        # involved in this pipeline.
        llm = OpenAILLMService(
            api_key=os.environ.get("RAG_LLM_API_KEY", "not-needed"),
            base_url=RAG_LLM_URL,
            model="urban-ai-rag",
        )

        # VAD lives on the user aggregator (current Pipecat API - see the
        # module docstring) so its speech start/stop signals drive turn
        # detection. Interruptions (bot stops the instant you start talking)
        # are on by default once VAD is configured this way; see Pipecat's
        # "Speech Input & Turn Detection" guide if you want to swap the
        # default timeout-based turn strategy for the smart-turn model.
        context = LLMContext()
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                vad_analyzer=SileroVADAnalyzer(),
            ),
        )

        pipeline = Pipeline(
            [
                transport.input(),
                stt,
                user_aggregator,
                llm,
                tts,
                transport.output(),
                assistant_aggregator,
            ]
        )

        worker = PipelineWorker(
            pipeline,
            params=PipelineParams(
                enable_metrics=True,
                enable_usage_metrics=True,
            ),
            idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
        )

        runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
        await runner.add_workers(worker)

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            logger.info("Voice client connected")

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport, client):
            logger.info("Voice client disconnected")
            await runner.cancel()

        await runner.run()


async def bot(runner_args: RunnerArguments):
    """Entry point Pipecat's runner calls for each new session."""
    transport = await create_transport(runner_args, transport_params)
    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
