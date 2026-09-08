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
  startListening: () => void;
  stopListening: () => void;
  speak: (text: string, onDone?: () => void) => void;
  stopSpeaking: () => void;
}

export function useVoiceChat(
  options: UseVoiceChatOptions = {}
): UseVoiceChatResult {
  const recognitionRef = useRef<any>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPreparingSpeech, setIsPreparingSpeech] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
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

    recognition.onresult = (event: any) => {
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
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

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
    if (!recognitionRef.current || isListening) return;
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch {
      // start() throws if a recognition session is already active -
      // isListening/onend stay the source of truth either way.
    }
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

  const speak = useCallback((text: string, onDone?: () => void) => {
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
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`TTS service returned ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
        }
        const audio = new Audio(url);
        currentAudioRef.current = audio;

        audio.onplay = () => {
          setIsPreparingSpeech(false);
          setIsSpeaking(true);
        };
        audio.onended = () => {
          setIsSpeaking(false);
          setIsPreparingSpeech(false);
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
        // eslint-disable-next-line no-console
        console.error("Voice service call failed - not falling back to a browser voice:", error);
        setIsPreparingSpeech(false);
        setIsSpeaking(false);
        setTtsError(error?.message || "Voice service unreachable");
        onDone?.();
      });
  }, []);

  const stopSpeaking = useCallback(() => {
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
