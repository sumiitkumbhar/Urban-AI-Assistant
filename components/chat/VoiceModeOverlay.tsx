"use client";

// Full-screen "voice mode" overlay, in the spirit of ChatGPT's voice
// conversation UI: tap in, get a focused, minimal screen with one big
// orb that visually tracks the conversation state (listening / thinking /
// speaking), instead of a small toggle buried under the text input. All
// the actual voice logic (dictation, hands-free auto-send, read-aloud)
// already lives in lib/useVoiceChat.ts and ChatInterface's handleSend -
// this component is purely the presentational layer on top of that state.

import React from "react";

export type VoiceOverlayState = "idle" | "listening" | "thinking" | "speaking";

interface VoiceModeOverlayProps {
  state: VoiceOverlayState;
  liveCaption: string;
  onOrbClick: () => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<VoiceOverlayState, string> = {
  idle: "Tap to talk",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export default function VoiceModeOverlay({
  state,
  liveCaption,
  onOrbClick,
  onClose,
}: VoiceModeOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#f7f4ee]">
      <button
        type="button"
        onClick={onClose}
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

      <button
        type="button"
        onClick={onOrbClick}
        aria-label={STATUS_LABEL[state]}
        title={STATUS_LABEL[state]}
        className="relative flex h-48 w-48 items-center justify-center rounded-full focus:outline-none"
      >
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
              : "bg-neutral-300 shadow-[0_0_20px_rgba(0,0,0,0.08)]"
          }`}
        />
      </button>

      <p className="mt-8 text-sm font-medium text-neutral-600">
        {STATUS_LABEL[state]}
      </p>

      {liveCaption && (
        <p className="mt-4 max-w-md px-6 text-center text-base text-neutral-800">
          {liveCaption}
        </p>
      )}

      <p className="absolute bottom-8 text-xs text-neutral-400">
        Tap the circle to interrupt or start talking again. Tap ✕ to end.
      </p>
    </div>
  );
}
