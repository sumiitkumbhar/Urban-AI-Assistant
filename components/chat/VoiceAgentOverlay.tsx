"use client";

// Full-duplex voice overlay backed by voice-agent/ (Pipecat) instead of the
// browser's own Speech Recognition - see voice-agent/README.md for the full
// architecture. Visually mirrors components/chat/VoiceModeOverlay.tsx so the
// two feel like the same feature, but the underlying connection is a
// continuous WebSocket audio stream (via @pipecat-ai/client-js), not
// record-transcribe-send-play round trips - which is what makes real
// barge-in (talk over it, it stops instantly) possible here and not there.
//
// I could not install @pipecat-ai/client-js or @pipecat-ai/websocket-transport
// anywhere in the environment this was written in (same PyPI/npm-registry
// network restriction noted throughout this project), so this component has
// not been run. The client-side API used here (PipecatClient, startBot,
// connect, the callback names) is copied from Pipecat's own current,
// verified example client (pipecat-ai/pipecat-examples/websocket/client) -
// but paste me the first error if one shows up when you actually run it.

import React, { useCallback, useEffect, useRef, useState } from "react";

export type VoiceAgentState =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

interface VoiceAgentOverlayProps {
  onClose: () => void;
}

const STATUS_LABEL: Record<VoiceAgentState, string> = {
  connecting: "Connecting…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

export default function VoiceAgentOverlay({ onClose }: VoiceAgentOverlayProps) {
  const [state, setState] = useState<VoiceAgentState>("connecting");
  const [caption, setCaption] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Typed loosely on purpose - see the top-of-file note on why these
  // packages' actual runtime shapes couldn't be verified here.
  const clientRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const baseUrl =
        process.env.NEXT_PUBLIC_VOICE_AGENT_URL || "http://localhost:7861";

      let PipecatClient: any;
      let WebSocketTransport: any;
      try {
        // Dynamic import: these packages are only needed for this one
        // beta voice mode, not the rest of the app, so they're kept out
        // of the main bundle and out of every other page's load.
        [{ PipecatClient }, { WebSocketTransport }] = await Promise.all([
          import("@pipecat-ai/client-js"),
          import("@pipecat-ai/websocket-transport"),
        ]);
      } catch (error: any) {
        if (!cancelled) {
          setState("error");
          setErrorMessage(
            "Voice agent packages aren't installed yet - run `npm install` " +
              "(package.json already lists @pipecat-ai/client-js and " +
              "@pipecat-ai/websocket-transport)."
          );
        }
        return;
      }

      if (cancelled) return;

      const client = new PipecatClient({
        transport: new WebSocketTransport(),
        enableMic: true,
        enableCam: false,
        callbacks: {
          onBotReady: () => {
            if (!cancelled) setState("listening");
          },
          onDisconnected: () => {
            if (!cancelled) setState("connecting");
          },
          onUserStartedSpeaking: () => {
            if (!cancelled) setState("listening");
          },
          onUserStoppedSpeaking: () => {
            if (!cancelled) setState("thinking");
          },
          onBotStartedSpeaking: () => {
            if (!cancelled) setState("speaking");
          },
          onBotStoppedSpeaking: () => {
            if (!cancelled) setState("listening");
          },
          onUserTranscript: (transcript: { text: string; final: boolean }) => {
            if (!cancelled && transcript?.final) setCaption(transcript.text);
          },
          onBotOutput: (data: { text?: string }) => {
            if (!cancelled && data?.text) setCaption(data.text);
          },
          onTrackStarted: (
            track: MediaStreamTrack,
            participant?: { local?: boolean }
          ) => {
            if (
              !cancelled &&
              !participant?.local &&
              track.kind === "audio" &&
              audioRef.current
            ) {
              audioRef.current.srcObject = new MediaStream([track]);
            }
          },
          onError: (error: any) => {
            if (!cancelled) {
              setState("error");
              setErrorMessage(
                typeof error === "string"
                  ? error
                  : error?.message || "Voice agent reported an error"
              );
            }
          },
        },
      });

      clientRef.current = client;

      try {
        await client.initDevices();
        const startResult = await client.startBot({
          endpoint: `${baseUrl.replace(/\/$/, "")}/start`,
          requestData: { transport: "websocket" },
        });
        if (cancelled) return;
        await client.connect({ wsUrl: startResult?.wsUrl });
      } catch (error: any) {
        if (!cancelled) {
          setState("error");
          setErrorMessage(
            error?.message ||
              `Could not reach the voice agent at ${baseUrl}. Is ` +
                "`python bot.py -t websocket` running in voice-agent/? " +
                "See voice-agent/README.md."
          );
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      clientRef.current?.disconnect?.();
    };
  }, []);

  const handleClose = useCallback(() => {
    clientRef.current?.disconnect?.();
    onClose();
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#f7f4ee]">
      {/* Bot audio plays through this element once onTrackStarted fires -
          hidden because there's nothing useful to look at, just listen to. */}
      <audio ref={audioRef} autoPlay hidden />

      <button
        type="button"
        onClick={handleClose}
        aria-label="End voice conversation"
        title="End voice conversation"
        className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-full border border-neutral-950/10 bg-white text-neutral-700 shadow-sm transition hover:bg-neutral-100"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      <div className="relative flex h-48 w-48 items-center justify-center rounded-full">
        {state === "listening" && (
          <>
            <span className="absolute inset-0 animate-ping rounded-full bg-neutral-950/10" />
            <span
              className="absolute inset-4 animate-ping rounded-full bg-neutral-950/10"
              style={{ animationDelay: "300ms" }}
            />
          </>
        )}
        {state === "speaking" && (
          <span className="absolute inset-2 animate-pulse rounded-full bg-neutral-950/10" />
        )}

        <span
          className={`h-32 w-32 rounded-full transition-all duration-500 ${
            state === "speaking"
              ? "scale-110 bg-neutral-950 shadow-[0_0_60px_rgba(0,0,0,0.35)]"
              : state === "thinking"
              ? "animate-pulse bg-neutral-700 shadow-[0_0_40px_rgba(0,0,0,0.2)]"
              : state === "listening"
              ? "scale-105 bg-neutral-900 shadow-[0_0_50px_rgba(0,0,0,0.3)]"
              : state === "error"
              ? "bg-red-400 shadow-[0_0_20px_rgba(220,38,38,0.25)]"
              : "bg-neutral-300 shadow-[0_0_20px_rgba(0,0,0,0.08)]"
          }`}
        />
      </div>

      <p className="mt-8 text-sm font-medium text-neutral-600">
        {STATUS_LABEL[state]}
      </p>

      {caption && state !== "error" && (
        <p className="mt-4 max-w-md px-6 text-center text-base text-neutral-800">
          {caption}
        </p>
      )}

      {state === "error" && errorMessage && (
        <p className="mt-4 max-w-md px-6 text-center text-sm text-red-600">
          {errorMessage}
        </p>
      )}

      <p className="absolute bottom-8 max-w-sm px-6 text-center text-xs text-neutral-400">
        Full-duplex voice (beta) - just start talking, interrupt anytime. Tap
        ✕ to end.
      </p>
    </div>
  );
}
