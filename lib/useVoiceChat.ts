"use client";

// Voice I/O for the chat UI.
//
// Dictation (speech -> text) uses the browser's native SpeechRecognition -
// free, built-in, no server round trip. Chrome/Edge/Safari support it;
// Firefox doesn't, hence the sttSupported flag.
//
// Read-aloud (text -> speech) goes through the self-hosted voice service
// only (see voice-service/ in the repo root and app/api/tts/route.ts) -
// currently CosyVoice2, previously Chatterbox. Open-source, runs on your
// own hardware or a free host, no per-character billing, and it's what
// gives a natural, cloned-voice sound instead of a robotic one.
//
// There used to be a second path here: the browser's own built-in
// SpeechSynthesis, as a fallback whenever the self-hosted service wasn't
// configured/reachable or a request failed. That's been removed on
// purpose - it's the "old robotic voice" - so a failure now just means
// this turn isn't spoken aloud (surfaced via ttsError) rather than
// silently swapping in a different-sounding voice mid-conversation.
//
// Nothing here costs money: no API key, no per-request billing.

import { useCallback, useEffect, useRef, useState } from "react";

// Fire-and-forget: posts to app/api/client-log/route.ts, which appends to
// client-debug.log at the repo root - so voice events that only ever
// happened in this browser tab's own console are readable back later the
// same way voice-debug.log and voice-service/service.log already are.
// Never awaited, never lets a failure here affect the actual voice flow.
function logClient(entry: Record<string, unknown>) {
  if (typeof fetch === "undefined") return;
  try {
    fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore
  }
}

export interface UseVoiceChatOptions {
  // Fired repeatedly while the user is still talking, with the
  // best-guess-so-far transcript - good for showing live "captions" in an
  // input box before the utterance is finished.
  onInterimTranscript?: (text: string) => void;
  // Fired once per utterance, with the final recognized text, right
  // before recognition stops itself (on a pause in speech).
  onFinalTranscript?: (text: string) => void;
}

export interface UseVoiceChatResult {
  sttSupported: boolean;
  ttsSupported: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  // True from the moment speak() is called until audio actually starts -
  // distinct from isSpeaking, which only covers actual playback. The
  // self-hosted voice service can take several real seconds to generate
  // audio on CPU-only hardware; without this, callers have no way to know
  // a reply is still being prepared, and end up treating that gap as
  // "done"/idle.
  isPreparingSpeech: boolean;
  // Set when the self-hosted voice service fails to produce audio (not
  // configured, unreachable, timed out, or errored). There is no fallback
  // voice anymore, so a failure here means this turn simply won't be
  // spoken aloud - callers can surface this instead of it looking like
  // voice mode just silently did nothing. Cleared at the start of every
  // speak() call.
  ttsError: string | null;
  // Set when SpeechRecognition itself reports an error (mic permission
  // denied, no usable input device, or - a real, seen-in-practice case -
  // "no-speech" when the mic opened fine but nothing was heard before it
  // gave up). Distinct from ttsError (that's the read-aloud half);
  // callers use this one to give the composer/voice-overlay mic control
  // its own restrained error state instead of silently reverting to
  // "idle" the way a raw isListening=false does. Cleared at the start of
  // every new listening attempt and the moment real speech is heard.
  sttError: string | null;
  startListening: () => void;
  stopListening: () => void;
  // onProgress fires on every `timeupdate` tick of the underlying <audio>
  // element with currentTime/duration, clamped to [0, 1] - the only
  // playback-position signal the self-hosted TTS gives us (one complete
  // blob per reply, no word or phoneme timing). Good for a proportional
  // "reveal the Nth word of the known full text" effect; NOT a real
  // per-word sync with what's actually being spoken at that instant.
  speak: (
    text: string,
    onDone?: () => void,
    onProgress?: (fraction: number) => void
  ) => void;
  stopSpeaking: () => void;
}

export function useVoiceChat(
  options: UseVoiceChatOptions = {}
): UseVoiceChatResult {
  const recognitionRef = useRef<any>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  // Safari (confirmed via voice-service/service.log + voice-debug.log: the
  // server generated and returned audio successfully, 200 OK every time -
  // the browser just never played it) blocks a programmatic audio.play()
  // call unless it happens inside a genuine, recent user gesture. speak()
  // is invoked well after that: it's called once RAG generation AND
  // CosyVoice2 TTS generation both finish, which on this CPU-only setup is
  // ~10+ real seconds after the tap that started listening - long past
  // whatever window Safari still considers "the user just interacted."
  // Fix: play a near-silent, effectively-inaudible clip synchronously
  // inside the tap handler itself (startListening, below - every call
  // site that starts a turn calls this directly from an onClick). Safari
  // treats any successful media playback during a real user gesture as
  // unlocking playback for the rest of the page's session, so the *real*
  // audio.play() call inside speak() - on a different <audio> element,
  // called much later, asynchronously - then succeeds too.
  const audioUnlockedRef = useRef(false);
  // Lets stopSpeaking() actually cancel an in-flight speak() call, not
  // just pause audio that has already started. Without this, closing
  // voice mode while a reply is still being generated (fetch to
  // /api/tts, or CosyVoice2 still synthesizing on the server - up to 3
  // minutes now) did nothing to that pending request: it kept running in
  // the background, and whenever it eventually resolved it would still
  // create a new <audio> element and call .play() on it - audio starting
  // to play, or the mic reopening via onDone, well after the user closed
  // the conversation and walked away. That's the "mic is still listening
  // after I closed the chat" report.
  const speakAbortRef = useRef<AbortController | null>(null);

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPreparingSpeech, setIsPreparingSpeech] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [sttError, setSttError] = useState<string | null>(null);
  const [sttSupported, setSttSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);

  // Keep the latest callbacks in refs so the recognition instance (built
  // once, below) always calls whatever handler the current render passed
  // in, without needing to be torn down and rebuilt, and without the
  // caller needing to memoize onFinalTranscript/onInterimTranscript.
  const onInterimRef = useRef(options.onInterimTranscript);
  const onFinalRef = useRef(options.onFinalTranscript);
  useEffect(() => {
    onInterimRef.current = options.onInterimTranscript;
    onFinalRef.current = options.onFinalTranscript;
  }, [options.onInterimTranscript, options.onFinalTranscript]);

  // ---- dictation (SpeechRecognition) ----
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Playback capability, not speech-synthesis support: the self-hosted
    // voice comes back as an audio file played through a plain <audio>
    // element, which every browser that can run this app supports.
    setTtsSupported(typeof window.Audio !== "undefined");

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setSttSupported(false);
      return;
    }
    setSttSupported(true);

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang =
      (typeof navigator !== "undefined" && navigator.language) || "en-GB";

    recognition.onstart = () => {
      logClient({ source: "stt", event: "start" });
    };

    recognition.onresult = (event: any) => {
      setSttError(null);
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }
      if (interimText) onInterimRef.current?.(interimText);
      if (finalText.trim()) onFinalRef.current?.(finalText.trim());
      logClient({
        source: "stt",
        event: "result",
        interim_length: interimText.length,
        final_length: finalText.trim().length,
      });
    };

    recognition.onerror = (event: any) => {
      // event.error is one of SpeechRecognition's own error codes -
      // "not-allowed" (mic permission), "no-speech" (mic open but heard
      // nothing), "audio-capture" (no working input device), "network",
      // "aborted". Logged so a stuck-on-"Listening..." report is
      // diagnosable from client-debug.log instead of another screenshot
      // round - this fires even when recognition never reaches onresult.
      logClient({ source: "stt", event: "error", error: event?.error });
      setIsListening(false);
      // "aborted" fires on a perfectly normal stopListening() call (the
      // user tapped the mic to cancel, or it was torn down on unmount) -
      // that's not an error a person should ever see surfaced.
      if (event?.error === "aborted") {
        setSttError(null);
        return;
      }
      const message =
        event?.error === "not-allowed"
          ? "Microphone access was denied."
          : event?.error === "no-speech"
          ? "Didn't catch that - try again."
          : event?.error === "audio-capture"
          ? "No microphone found."
          : event?.error === "network"
          ? "Speech recognition network error."
          : "Couldn't hear you - try again.";
      setSttError(message);
    };
    recognition.onend = () => {
      logClient({ source: "stt", event: "end" });
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.stop();
      } catch {
        // ignore - already stopped, or never actually started
      }
    };
  }, []);

  const startListening = useCallback(() => {
    const beginRecognition = () => {
      if (!recognitionRef.current || isListening) return;
      try {
        setSttError(null);
        recognitionRef.current.start();
        setIsListening(true);
      } catch (error: any) {
        // start() throws if a recognition session is already active -
        // isListening/onend stay the source of truth either way.
        logClient({
          source: "stt",
          event: "start_threw",
          error: error?.message || String(error),
        });
      }
    };

    // The unlock clip's play() call must happen synchronously in this
    // same tap for Safari to count it as a real user gesture (see
    // audioUnlockedRef's comment above) - but recognition.start() does
    // NOT need to be synchronous with it, and on a Bluetooth headset
    // starting playback and starting microphone capture at the exact
    // same instant can fight over the audio session (switching between
    // playback-only and playback+record profiles) and leave recognition
    // listening to nothing. So: fire the unlock now, but only start
    // recognition once that playback attempt has actually settled either
    // way, not racing the two.
    if (!audioUnlockedRef.current && typeof window !== "undefined") {
      audioUnlockedRef.current = true;
      try {
        const unlock = new Audio(
          "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA"
        );
        unlock.volume = 0;
        unlock.muted = true;
        const playResult = unlock.play();
        if (playResult && typeof playResult.then === "function") {
          playResult
            .then(() => unlock.pause())
            .catch(() => {
              // If even this fails, the real speak() call will fail the
              // same way and surface via ttsError - nothing more to do
              // here.
            })
            .finally(beginRecognition);
          return;
        }
      } catch {
        // ignore - worst case, playback stays locked and speak() surfaces
        // that through ttsError same as any other failure. Fall through
        // to beginRecognition() below either way.
      }
    }

    beginRecognition();
  }, [isListening]);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
    } catch {
      // ignore - already stopped
    }
    setIsListening(false);
  }, []);

  const speak = useCallback(
    (text: string, onDone?: () => void, onProgress?: (fraction: number) => void) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onDone?.();
      return;
    }

    setTtsError(null);

    if (typeof window === "undefined" || typeof fetch === "undefined") {
      onDone?.();
      return;
    }

    setIsPreparingSpeech(true);

    const controller = new AbortController();
    speakAbortRef.current = controller;

    // The self-hosted voice service (app/api/tts/route.ts proxies to
    // voice-service/ - see that route for why this can 503 or 502
    // perfectly normally whenever the service isn't configured or isn't
    // running) is the only voice now. On any failure this turn just isn't
    // spoken aloud - logged clearly and surfaced via ttsError, rather than
    // masked by quietly switching to a different-sounding fallback voice.
    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`TTS service returned ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        if (speakAbortRef.current === controller) speakAbortRef.current = null;

        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
        }
        const audio = new Audio(url);
        currentAudioRef.current = audio;

        audio.onplay = () => {
          setIsPreparingSpeech(false);
          setIsSpeaking(true);
        };
        // duration is unknown (NaN/Infinity) for a brief moment right
        // after the element is created - guard both before trusting it.
        audio.ontimeupdate = () => {
          if (
            onProgress &&
            Number.isFinite(audio.duration) &&
            audio.duration > 0
          ) {
            onProgress(Math.min(1, audio.currentTime / audio.duration));
          }
        };
        audio.onended = () => {
          setIsSpeaking(false);
          setIsPreparingSpeech(false);
          onProgress?.(1);
          URL.revokeObjectURL(url);
          if (currentAudioRef.current === audio) currentAudioRef.current = null;
          onDone?.();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          setIsPreparingSpeech(false);
          setTtsError("Playback failed.");
          URL.revokeObjectURL(url);
          if (currentAudioRef.current === audio) currentAudioRef.current = null;
          onDone?.();
        };

        await audio.play();
      })
      .catch((error: any) => {
        if (speakAbortRef.current === controller) speakAbortRef.current = null;
        if (error?.name === "AbortError") {
          // Deliberately cancelled via stopSpeaking() (e.g. the user
          // closed voice mode) - not a failure, and onDone is skipped on
          // purpose: whatever called stopSpeaking() has already decided
          // what happens next, so this call ends quietly instead of
          // re-triggering a "reply finished" side effect (like
          // re-opening the mic) for a reply the user no longer wants.
          setIsPreparingSpeech(false);
          setIsSpeaking(false);
          return;
        }
        // eslint-disable-next-line no-console
        console.error("Voice service call failed - not falling back to a browser voice:", error);
        setIsPreparingSpeech(false);
        setIsSpeaking(false);
        setTtsError(error?.message || "Voice service unreachable");
        onDone?.();
      });
    },
    []
  );

  const stopSpeaking = useCallback(() => {
    if (speakAbortRef.current) {
      speakAbortRef.current.abort();
      speakAbortRef.current = null;
    }
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
      } catch {
        // ignore
      }
      currentAudioRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  return {
    sttSupported,
    ttsSupported,
    isListening,
    isSpeaking,
    isPreparingSpeech,
    ttsError,
    sttError,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
  };
}

// Strips the markdown/citation scaffolding every RAG answer is wrapped in
// (### headers, [D1]/[W2] citation markers, a trailing References block,
// bold/italic/code markers, bullet punctuation) down to plain, speakable
// prose. This is the FALLBACK path only - when the backend already
// returned a proper spoken-style rewrite (data.speechText, see
// app/api/rag-chat/route.ts's humanizeForSpeech), use that instead; call
// this only when speechText isn't available, so voice mode still reads
// something reasonable rather than nothing.
export function sanitizeForSpeech(markdown: string): string {
  if (!markdown) return "";

  let text = markdown;

  // Drop everything from a "### References" section onward - a spoken
  // citation list isn't useful and reads terribly.
  text = text.replace(/#{1,6}\s*References[\s\S]*$/i, "");

  // This app's answer templates structure every reply with document-style
  // section labels (### Direct Answer, ### Notes, ### Related Provisions,
  // ### Summary). Nobody says "Direct Answer" out loud mid-conversation -
  // drop the whole heading line rather than just its "###" prefix.
  text = text.replace(
    /^#{1,6}\s*(Direct Answer|Notes|Related Provisions|Summary)\s*$/gim,
    ""
  );

  // Any remaining heading markers -> keep the text, drop the "###".
  text = text.replace(/^#{1,6}\s*/gm, "");

  // Inline citation markers like [D1], [W2], [12].
  text = text.replace(/\[[DW]?\d+\]/g, "");

  // Bold / italic / inline-code markers, keeping the wrapped text.
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  text = text.replace(/\*(.*?)\*/g, "$1");
  text = text.replace(/`([^`]*)`/g, "$1");

  // Bullet / numbered-list markers at the start of a line.
  text = text.replace(/^\s*[-*]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");

  // Every line break becomes a sentence pause - reading a list or a new
  // paragraph without one runs everything together with no breath.
  text = text
    .replace(/\n+/g, ". ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();

  return text;
}
