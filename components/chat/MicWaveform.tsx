"use client";

// Real microphone-amplitude waveform - Web Audio API only, never a canned
// looping animation. Runs on refs + requestAnimationFrame so a listening
// turn doesn't cost React 30-60 renders/sec; only each bar's own inline
// `transform` changes per frame, nothing in the component tree re-renders.
//
// Deliberately a SEPARATE getUserMedia() call from the one
// SpeechRecognition manages internally (lib/useVoiceChat.ts) -
// SpeechRecognition exposes no amplitude data of its own, so there's no
// stream to reuse. Two concurrent getUserMedia calls for the same
// physical mic are normal and, after the first permission grant, silent
// in Chrome/Edge. Not verified in Safari - if Safari double-prompts, or
// silently fails to grant a second concurrent stream, that's a real gap
// to fix here, not assume away.

import React, { useEffect, useRef } from "react";

export interface MicWaveformProps {
  /** Capture starts the moment this becomes true, stops - and every
   *  audio resource is released - the moment it becomes false. */
  active: boolean;
  /** Bar count. Odd counts read best (a visible center peak). */
  bars?: number;
  /** Controls size + color: height sets the bars' max height, `text-*`
   *  sets their color (bars use `bg-current`, so color is inherited). */
  className?: string;
  /** Fired once if the mic can't be opened, so a caller can show its own
   *  message instead of a waveform that just sits flat forever. */
  onError?: (message: string) => void;
}

const MIN_SCALE = 0.14; // near-flat at silence, never fully invisible
const MAX_SCALE = 1;
// Separate attack/release smoothing, applied per animation frame (not per
// audio sample - the analyser's own smoothing is left at 0 below, so all
// of it happens here in units this component controls): a bar jumps up
// fast on a loud syllable, eases back down between words instead of
// chattering frame to frame.
const ATTACK = 0.6;
const RELEASE = 0.15;

export function MicWaveform({
  active,
  bars = 5,
  className = "",
  onError,
}: MicWaveformProps) {
  const barRefs = useRef<Array<HTMLDivElement | null>>([]);
  const levelsRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!active) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      onErrorRef.current?.("Microphone input isn't available in this browser.");
      return;
    }

    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const AudioContextCtor =
          window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx: AudioContext = new AudioContextCtor();
        audioCtxRef.current = audioCtx;

        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        analyserRef.current = analyser;

        const freqData = new Uint8Array(analyser.frequencyBinCount);
        levelsRef.current = new Array(bars).fill(0);

        // Evenly-spaced bins across the lower half of the spectrum, where
        // human voice energy actually lives - the upper half is mostly
        // hiss/silence for speech and just reads as jittery noise if used.
        const usableBins = Math.floor(freqData.length * 0.5);
        const binStep = Math.max(1, Math.floor(usableBins / bars));

        const tick = () => {
          analyser.getByteFrequencyData(freqData);
          for (let i = 0; i < bars; i++) {
            const start = i * binStep;
            let sum = 0;
            let count = 0;
            for (let j = start; j < start + binStep && j < freqData.length; j++) {
              sum += freqData[j];
              count++;
            }
            const raw = count > 0 ? sum / count / 255 : 0; // 0..1
            const prev = levelsRef.current[i] || 0;
            const coeff = raw > prev ? ATTACK : RELEASE;
            const next = prev + (raw - prev) * coeff;
            levelsRef.current[i] = next;
            const el = barRefs.current[i];
            if (el) {
              const scale = MIN_SCALE + next * (MAX_SCALE - MIN_SCALE);
              el.style.transform = `scaleY(${scale})`;
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      })
      .catch((err: any) => {
        if (!cancelled) {
          onErrorRef.current?.(
            err?.name === "NotAllowedError"
              ? "Microphone access was denied."
              : "Couldn't access the microphone."
          );
        }
      });

    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      try {
        analyserRef.current?.disconnect();
      } catch {
        // ignore
      }
      analyserRef.current = null;
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      // Ease every bar back to resting height rather than snapping it -
      // toggling off shouldn't look like a glitch.
      barRefs.current.forEach((el) => {
        if (el) el.style.transform = `scaleY(${MIN_SCALE})`;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bars]);

  return (
    <div
      className={`flex items-end justify-center gap-[3px] ${className}`}
      aria-hidden="true"
    >
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="w-[3px] origin-bottom rounded-full bg-current transition-none"
          style={{ height: "100%", transform: `scaleY(${MIN_SCALE})` }}
        />
      ))}
    </div>
  );
}

export default MicWaveform;
