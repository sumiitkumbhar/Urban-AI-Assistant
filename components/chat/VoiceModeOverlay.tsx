"use client";

// Full-screen "voice mode" overlay, in the spirit of ChatGPT's voice
// conversation UI: tap in, get a focused, minimal screen with one big
// orb that visually tracks the conversation state (listening / thinking /
// speaking), instead of a small toggle buried under the text input. All
// the actual voice logic (dictation, hands-free auto-send, read-aloud)
// already lives in lib/useVoiceChat.ts and ChatInterface's handleSend -
// this component is purely the presentational layer on top of that state.

import React from "react";
// MIT, npm install thinking-orbs - free, no paid tier needed (verified in
// node_modules/thinking-orbs/LICENSE before adding, per this project's
// zero-cost rule). Its own animated states replace the old ping/pulse
// rings + glow-shadow solid circle below, which also brings this overlay
// in line with DESIGN.md's "no glow" rule - the old `shadow-[0_0_...]`
// classes were a pre-existing exception to it.
import { ThinkingOrb } from "thinking-orbs";
import { MicWaveform } from "./MicWaveform";

export type VoiceOverlayState = "idle" | "listening" | "thinking" | "speaking";

// "listening" and "connecting" are literal matches in thinking-orbs'
// vocabulary; there's no per-stage breakdown for "thinking" here (unlike
// ThinkingIndicator's THINKING_STAGE_DEFS in ChatInterface.tsx), so it
// gets the generic busy state; "speaking" reuses "composing" (producing
// the response) for the same reason ChatInterface.tsx uses it for
// "Drafting a grounded answer…". This also doubles as the "output"
// visual for Speaking - there's no real output waveform here on purpose
// (see MicWaveform's own doc comment: it exists because we can measure
// real mic energy; there's no equivalent amplitude signal for CosyVoice2
// playback, and a decorative one would be exactly the "moves even while
// nothing is happening" fake the user explicitly called out for the mic
// case - the same reasoning applies to output).
const ORB_STATE: Record<VoiceOverlayState, React.ComponentProps<typeof ThinkingOrb>["state"]> = {
  idle: "breathing",
  listening: "listening",
  thinking: "working",
  speaking: "composing",
};

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

      {/* Everything below is one fixed-composition column: every slot
          (orb, waveform, label, transcript) always occupies the same
          height whether or not it currently has content, so switching
          states never changes the stack's total height. Before this, the
          waveform and transcript paragraph were only mounted in some
          states - each mount/unmount shifted how much content
          `justify-center` had to center, which is exactly what read as
          "the text is not centred, it's slightly up": the resting
          (idle/thinking) layout was shorter than the listening layout,
          so the whole group visibly re-centred itself on every state
          change instead of holding still. */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={onOrbClick}
          aria-label={STATUS_LABEL[state]}
          title={STATUS_LABEL[state]}
          className="relative flex h-48 w-48 items-center justify-center rounded-full focus:outline-none"
        >
          {/* theme="light" is pinned rather than "auto" - DESIGN.md rules
              out dark mode for this app, so there's no light/dark switch
              for the library to correctly auto-detect. */}
          <ThinkingOrb state={ORB_STATE[state]} size={64} theme="light" aria-label={STATUS_LABEL[state]} />
        </button>

        {/* Real mic-amplitude bars (components/chat/MicWaveform.tsx) - the
            orb's own "listening" animation is decorative, not driven by
            actual sound, so it was the main source of "I can't tell if
            it's hearing me." Only captures audio while genuinely
            listening (active={state === "listening"}), so the mic is
            never opened a moment longer than recognition itself is
            running - but the slot itself is always present at a fixed
            height so nothing above or below it moves when it appears. */}
        <div className="mt-6 flex h-8 items-center justify-center">
          <MicWaveform
            active={state === "listening"}
            bars={5}
            className="h-8 text-neutral-500"
          />
        </div>

        <p className="mt-3 text-sm font-medium text-neutral-600">
          {STATUS_LABEL[state]}
        </p>

        {/* Fixed-height transcript/reveal slot, always mounted. Listening:
            the user's own live transcript, muted and clamped to a few
            lines - it's a caption, not the main content, and shouldn't
            grow into a wall of text as a long sentence builds up word by
            word. Thinking: that same utterance stays put (not blanked)
            per the explicit requirement, just dimmed to show it's no
            longer live. Speaking: the assistant's reply, revealed word by
            word in step with playback (see voiceSpeakingReveal in
            ChatInterface.tsx) - the most important text on this screen
            while it's showing, so it gets the most prominent treatment. */}
        <div className="mt-4 flex min-h-[5.5rem] w-full max-w-md items-start justify-center px-6">
          {liveCaption && (
            <p
              className={
                state === "speaking"
                  ? "text-center text-lg leading-relaxed text-neutral-900 transition-opacity duration-150"
                  : state === "thinking"
                  ? "line-clamp-3 text-center text-base leading-relaxed text-neutral-400 transition-opacity duration-150"
                  : "line-clamp-3 text-center text-base leading-relaxed text-neutral-700 transition-opacity duration-150"
              }
            >
              {liveCaption}
            </p>
          )}
        </div>
      </div>

      <p className="absolute bottom-8 text-xs text-neutral-400">
        Tap the circle to interrupt or start talking again. Tap ✕ to end.
      </p>
    </div>
  );
}
