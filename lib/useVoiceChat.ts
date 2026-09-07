"use client";

// Voice I/O for the chat UI.
//
// Dictation (speech -> text) uses the browser's native SpeechRecognition -
// free, built-in, no server round trip. Chrome/Edge/Safari support it;
// Firefox doesn't, hence the sttSupported flag.
//
// Read-aloud (text -> speech) tries two things, in order:
//   1. The self-hosted voice service (see voice-service/ in the repo
//      root and app/api/tts/route.ts) - currently CosyVoice2, previously
//      Chatterbox. Open-source, runs on your own hardware or a free
//      host, no per-character billing. This is what gives a natural,
//      cloned-voice sound instead of a robotic one.
//   2. The browser's own built-in SpeechSynthesis, picking the best native
//      voice available, if the self-hosted service isn't configured/
//      reachable or the request fails for any reason. This means voice
//      conversation keeps working even before that service is set up -
//      it just sounds more robotic until it is.
//
// Nothing here costs money: no API key, no per-request billing, either
// direction, either path.

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
  startListening: () => void;
  stopListening: () => void;
  speak: (text: string, onDone?: () => void) => void;
  stopSpeaking: () => void;
}

// Free, built-in browser voices vary wildly in quality. This heuristic
// prefers whatever the browser/OS itself flags as a higher-quality
// (often actually neural/cloud-backed, still free-to-us) voice matching
// the user's language, and avoids the old low-quality synthetic ones when
// something better is available. Only used for the SpeechSynthesis
// fallback path - the primary self-hosted-voice path doesn't need this.
// Common name patterns for female- and male-associated system/network
// voices across macOS, Chrome, and Windows. SpeechSynthesisVoice doesn't
// expose an actual gender field in any browser, so this is a best-effort
// guess from the voice's own name - imperfect, but the practical option
// available for free.
const FEMALE_VOICE_NAME_HINTS =
  /female|samantha|victoria|ava|allison|susan|karen|moira|tessa|fiona|kate|zoe|emma|olivia|sofia|amelia|joanna|salli|kimberly|aria|jenny|libby|zira|hazel|catherine|nicky|serena|samira|kathy|shelley/i;

function pickBestBrowserVoice(
  voices: SpeechSynthesisVoice[],
  preferredLang: string
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const langPrefix = preferredLang.split("-")[0].toLowerCase();

  const score = (v: SpeechSynthesisVoice) => {
    const name = v.name.toLowerCase();
    let s = 0;
    if (v.lang?.toLowerCase() === preferredLang.toLowerCase()) s += 8;
    else if (v.lang?.toLowerCase().startsWith(langPrefix)) s += 4;
    if (/neural|natural|enhanced|premium/.test(name)) s += 6;
    if (/google/.test(name)) s += 3;
    if (v.localService === false) s += 1;
    if (/compact|espeak|robot/.test(name)) s -= 4;
    if (FEMALE_VOICE_NAME_HINTS.test(name)) s += 5;
    return s;
  };

  return [...voices].sort((a, b) => score(b) - score(a))[0] || null;
}

export function useVoiceChat(
  options: UseVoiceChatOptions = {}
): UseVoiceChatResult {
  const recognitionRef = useRef<any>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const bestBrowserVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
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

    setTtsSupported(typeof window.speechSynthesis !== "undefined");

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

  // ---- best available native voice, for the SpeechSynthesis fallback ----
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const lang =
      (typeof navigator !== "undefined" && navigator.language) || "en-GB";

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        bestBrowserVoiceRef.current = pickBestBrowserVoice(voices, lang);
      }
    };

    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
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

  const speakWithBrowserVoice = useCallback(
    (text: string, onDone?: () => void) => {
      if (typeof window === "undefined" || !window.speechSynthesis) {
        onDone?.();
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      if (bestBrowserVoiceRef.current) {
        utterance.voice = bestBrowserVoiceRef.current;
        utterance.lang = bestBrowserVoiceRef.current.lang;
      }
      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => {
        setIsSpeaking(false);
        onDone?.();
      };
      utterance.onerror = () => {
        setIsSpeaking(false);
        onDone?.();
      };
      window.speechSynthesis.speak(utterance);
    },
    []
  );

  const speak = useCallback(
    (text: string, onDone?: () => void) => {
      const trimmed = text.trim();
      if (!trimmed) {
        onDone?.();
        return;
      }

      if (typeof window === "undefined" || typeof fetch === "undefined") {
        speakWithBrowserVoice(trimmed, onDone);
        return;
      }

      // Try the self-hosted voice service first (app/api/tts/route.ts
      // proxies to voice-service/ - see that route for why this can 503
      // or 502 perfectly normally whenever the service isn't configured
      // or isn't running). Any failure here just falls back to the
      // browser's own voice rather than going silent.
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

          audio.onplay = () => setIsSpeaking(true);
          audio.onended = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(url);
            if (currentAudioRef.current === audio) currentAudioRef.current = null;
            onDone?.();
          };
          audio.onerror = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(url);
            if (currentAudioRef.current === audio) currentAudioRef.current = null;
            onDone?.();
          };

          await audio.play();
        })
        .catch(() => {
          // Self-hosted voice not configured/reachable/erroring - fall back to
          // the browser's built-in voice so voice mode still works.
          speakWithBrowserVoice(trimmed, onDone);
        });
    },
    [speakWithBrowserVoice]
  );

  const stopSpeaking = useCallback(() => {
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
      } catch {
        // ignore
      }
      currentAudioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, []);

  return {
    sttSupported,
    ttsSupported,
    isListening,
    isSpeaking,
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
