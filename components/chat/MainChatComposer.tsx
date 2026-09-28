"use client";

/**
 * Main chat composer - extracted from ChatInterface.tsx's old inline
 * footer JSX (added 2026-09-28, unify-composers pass). This component
 * owns ONLY rendering; every piece of state and every handler lives in
 * ChatInterface.tsx exactly as before and is passed in as props. Nothing
 * about the actual chat/upload/voice/review behavior changed in this
 * extraction - same handlers, same conditions, same feature flags. What
 * changed is purely where the JSX lives and how it's wrapped: the caller
 * now renders `<FloatingComposerShell><MainChatComposer .../></FloatingComposerShell>`
 * instead of a hard-edged opaque footer div, and the input row is now the
 * shell's `children` while everything else (uploaded-doc list, pending-
 * upload choice card, the active-review chip, the feasibility drawing
 * upload, the mode selector, the Cloud/Local toggle, the voice-agent
 * button, and the helper text) renders as FloatingComposerShell's
 * `belowChildren` - a quiet stack of lightweight pills/chips below the
 * bar, not a second giant rounded card.
 *
 * See components/chat/ReportEditComposer.tsx for this shell's other
 * consumer - the two intentionally do NOT share business logic or state,
 * only the shell's visual primitives (see FloatingComposerShell's own
 * docstring).
 */

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MicWaveform } from "@/components/chat/MicWaveform";

type IconProps = React.SVGProps<SVGSVGElement>;

// Local copies of just the icons this composer needs - deliberately not
// imported from ChatInterface.tsx to avoid a circular import (ChatInterface
// renders this component, so this component can't import back from it).
// Kept pixel-identical to ChatInterface.tsx's own copies.
const Svg = ({ children, ...props }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {children}
  </svg>
);

const PaperAirplaneIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </Svg>
);

const DocumentIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M7 3h7l3 3v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M14 3v5h5" />
    <path d="M9 12h6" />
    <path d="M9 16h6" />
  </Svg>
);

const MicIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M12 19v3" />
    <path d="M8 22h8" />
  </Svg>
);

const SpeakerIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 9v6h4l5 5V4L8 9H4z" />
    <path d="M17 8a5 5 0 0 1 0 8" />
  </Svg>
);

// Small restrained spinner for the mic button's "processing" state (the
// message is loading, so dictation is briefly unavailable) - an actual
// spin via Tailwind's animate-spin, not a static icon, so "processing"
// reads as active/temporary rather than just another flavor of disabled.
const MicProcessingIcon = (props: IconProps) => (
  <Svg {...props} className={`${props.className || ""} animate-spin`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </Svg>
);

// Small restrained alert glyph for the mic button's "error" state
// (permission denied, no mic found, recognition network error, or a
// plain "didn't catch that"). Deliberately not a red/filled warning
// triangle - same neutral stroke treatment as every other composer icon,
// just a shape that reads as "something needs attention" at a glance.
const MicErrorIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5" />
    <path d="M12 16h.01" />
  </Svg>
);

const WaveformIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 10v4" />
    <path d="M8 6v12" />
    <path d="M12 3v18" />
    <path d="M16 6v12" />
    <path d="M20 10v4" />
  </Svg>
);

/**
 * Shared geometry for every icon-shaped control inside the composer row
 * (attach, mic, voice, send). 2026-09-28 icon-alignment fix: previously
 * each of these was hand-coded at `h-8 w-8` (24px at this app's compact
 * root font-size) and positioned with `absolute bottom-2`, bottom-anchored
 * inside a taller (33px) textarea box. That put each button's visual
 * center measurably below the textarea's own text-line center - live
 * `getBoundingClientRect()` measurement showed textarea centerY=678.16 vs
 * button centerY=682.66, a real ~4.5px mismatch (half the 9px height
 * difference between a 24px button bottom-aligned inside a 33px line box),
 * not a rounding artifact. Every control is now a real flex sibling of
 * the textarea inside one `flex items-center` row (see
 * MainChatComposerBar's return below) instead of being absolutely
 * positioned on top of it, so its vertical center always matches the
 * row's actual cross-axis center - no ad-hoc `top`, `margin-top`, or
 * per-icon nudge anywhere in this file. (This intentionally drops the old
 * "stay pinned to the bottom line as the textarea grows" behavior in
 * favor of exact rest-state centering, per explicit product direction.)
 */
const COMPOSER_ICON_BUTTON_BASE =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40";

/** Button variant of the shared icon-control geometry (mic, voice, send). The attach control is a <label> instead (needs to wrap a hidden file input) and applies COMPOSER_ICON_BUTTON_BASE directly - see its usage below. */
function ComposerIconButton({
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`${COMPOSER_ICON_BUTTON_BASE} ${className}`} {...props} />;
}

export interface UploadedDocSummary {
  id: string;
  name: string;
  status: "uploading" | "ready" | "error";
}

export type ChatMode = "auto" | "feasibility" | "permitting" | "risk";
export type RagSource = "cloud" | "local";

export interface MainChatComposerProps {
  // Core input
  composerRef: React.RefObject<HTMLTextAreaElement>;
  inputValue: string;
  onInputChange: (value: string) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  isLoading: boolean;
  onSend: () => void;

  // Attach
  onFileSelected: React.ChangeEventHandler<HTMLInputElement>;
  isUploadingDoc: boolean;
  isReviewing: boolean;
  pendingUploadFile: File | null;

  // Mic / voice
  sttSupported: boolean;
  ttsSupported: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  /** Set when SpeechRecognition itself reported an error on the last
   *  attempt (see lib/useVoiceChat.ts) - drives the mic button's own
   *  restrained error state instead of silently reverting to idle. */
  sttError: string | null;
  onMicClick: () => void;
  onStartVoiceConversation: () => void;
  drawingFile: File | null;
  isEditingClause: boolean;

  // Uploaded-document list
  uploadedDocs: UploadedDocSummary[];
  onDismissUploadedDoc: (id: string) => void;

  // Pending-upload choice card
  reviewPostcode: string;
  onReviewPostcodeChange: (value: string) => void;
  onAskQuestionsAboutFile: (file: File) => void;
  onRunComplianceReview: (file: File, postcode: string) => void;
  onCancelPendingUpload: () => void;
  /** Rendered inside the "Run compliance review" button while isReviewing - ChatInterface.tsx's own <ReviewingLabel/> (kept there since it depends on the review-stage ThinkingOrb machinery). */
  reviewingLabel: React.ReactNode;

  // Active review banner -> now a quiet chip, not a bordered card
  activeReview: { label: string } | null;
  onExitReviewChat: () => void;

  // Feasibility-mode drawing upload (FEATURES.drawingAnalysis)
  drawingAnalysisEnabled: boolean;
  chatMode: ChatMode;
  onDrawingFileChange: (file: File | null) => void;

  // Mode selector (FEATURES.modeSelector)
  modeSelectorEnabled: boolean;
  isModeMenuOpen: boolean;
  onToggleModeMenu: () => void;
  onSelectChatMode: (mode: ChatMode) => void;

  // Cloud/Local toggle (FEATURES.ragSourceToggle)
  ragSourceToggleEnabled: boolean;
  ragSource: RagSource;
  onRagSourceChange: (source: RagSource) => void;
  localRagStatus: "unknown" | "checking" | "reachable" | "unreachable";

  // Full-duplex voice (beta)
  voiceAgentUrl?: string | null;
  onOpenVoiceAgentOverlay: () => void;
}

/** The composer bar itself - meant to be FloatingComposerShell's `children`. */
export function MainChatComposerBar({
  composerRef,
  inputValue,
  onInputChange,
  onKeyDown,
  isLoading,
  onSend,
  onFileSelected,
  isUploadingDoc,
  isReviewing,
  pendingUploadFile,
  sttSupported,
  ttsSupported,
  isListening,
  isSpeaking,
  sttError,
  onMicClick,
  onStartVoiceConversation,
  drawingFile,
  isEditingClause,
}: Pick<
  MainChatComposerProps,
  | "composerRef"
  | "inputValue"
  | "onInputChange"
  | "onKeyDown"
  | "isLoading"
  | "onSend"
  | "onFileSelected"
  | "isUploadingDoc"
  | "isReviewing"
  | "pendingUploadFile"
  | "sttSupported"
  | "ttsSupported"
  | "isListening"
  | "isSpeaking"
  | "sttError"
  | "onMicClick"
  | "onStartVoiceConversation"
  | "drawingFile"
  | "isEditingClause"
>) {
  return (
    <div className="flex items-center gap-2 p-2">
      {/* Attach - a real flex sibling of the textarea now, not absolutely
          positioned on top of it (see ComposerIconButton's doc comment
          above for why). Applies the shared base class directly since a
          <label> (not <button>) is needed here to wrap the hidden file
          input. */}
      <label
        className={`${COMPOSER_ICON_BUTTON_BASE} press relative cursor-pointer border border-neutral-950/[0.06] bg-neutral-100/70 text-neutral-800 hover:bg-neutral-200/90 hover:border-neutral-950/20 before:absolute before:-inset-1.5 before:content-['']`}
        title="Attach file"
        aria-label="Attach file"
      >
        <input
          type="file"
          onChange={onFileSelected}
          className="hidden"
          disabled={isLoading || isUploadingDoc || isReviewing || !!pendingUploadFile}
        />
        <DocumentIcon className="h-5 w-5" />
      </label>

      <textarea
        ref={composerRef}
        rows={1}
        value={inputValue}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask anything"
        aria-label="Ask a question"
        className="uaa-composer block min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-sm leading-6 focus:outline-none"
        disabled={isLoading}
      />

      <div className="flex shrink-0 items-center gap-2">
        {sttSupported && (() => {
          // isLoading already disables the button below (a reply is in
          // flight, dictating a new one mid-turn isn't supported) - the
          // "processing" state gives that same moment a small active
          // spinner instead of just a dimmed, inert-looking mic icon, so
          // it reads as "busy, back in a moment" rather than "broken."
          const isProcessing = isLoading && !isListening && !isSpeaking;
          const isError = !!sttError && !isListening && !isSpeaking && !isProcessing;
          const label = isSpeaking
            ? "Stop speaking"
            : isListening
            ? "Stop listening"
            : isProcessing
            ? "Processing…"
            : isError
            ? sttError || "Microphone error"
            : "Dictate message";
          return (
            <ComposerIconButton
              type="button"
              onClick={onMicClick}
              disabled={isLoading || isUploadingDoc}
              className={`border ${
                isListening
                  ? "animate-pulse border-red-300 bg-red-100 text-red-600"
                  : isSpeaking
                  ? "border-neutral-950/10 bg-neutral-200 text-neutral-800"
                  : isError
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : "border-neutral-950/[0.06] bg-neutral-100/70 text-neutral-700 hover:bg-neutral-200/90"
              }`}
              title={label}
              aria-label={label}
            >
              {isSpeaking ? (
                <SpeakerIcon className="h-5 w-5" />
              ) : isListening ? (
                // Real mic-amplitude bars (components/chat/MicWaveform.tsx)
                // replace the static icon the instant listening starts -
                // per explicit feedback, a color change alone isn't
                // enough confirmation that speech is actually being
                // captured.
                <MicWaveform active={isListening} bars={4} className="h-4 w-5" />
              ) : isProcessing ? (
                <MicProcessingIcon className="h-5 w-5" />
              ) : isError ? (
                <MicErrorIcon className="h-5 w-5" />
              ) : (
                <MicIcon className="h-5 w-5" />
              )}
            </ComposerIconButton>
          );
        })()}

        {/* Text present (or a drawing file staged) -> Send. Empty composer
            with voice available -> the hands-free "voice conversation"
            control. Falls back to a disabled Send when voice isn't
            supported, so the empty-composer state never shows nothing at
            all. Unchanged from the pre-extraction behavior. */}
        {!inputValue.trim() && !drawingFile && sttSupported && ttsSupported ? (
          <ComposerIconButton
            type="button"
            onClick={onStartVoiceConversation}
            disabled={isLoading || isUploadingDoc || isReviewing || isEditingClause}
            className="press border border-neutral-950/[0.06] bg-neutral-100/70 text-neutral-700 hover:bg-neutral-200/90 hover:border-neutral-950/20"
            title="Start voice conversation"
            aria-label="Start voice conversation"
          >
            <WaveformIcon className="h-5 w-5" />
          </ComposerIconButton>
        ) : (
          <ComposerIconButton
            onClick={onSend}
            disabled={(!inputValue.trim() && !drawingFile) || isLoading || isUploadingDoc || isReviewing || isEditingClause}
            className="press bg-neutral-950 shadow-paper-sm hover:bg-neutral-800 hover:shadow-paper-md disabled:shadow-none"
            aria-label="Send message"
          >
            <PaperAirplaneIcon className="h-5 w-5 text-white" />
          </ComposerIconButton>
        )}
      </div>
    </div>
  );
}

/** Everything else - meant to be FloatingComposerShell's `belowChildren`. */
export function MainChatComposerContext(props: MainChatComposerProps) {
  const {
    isReviewing,
    pendingUploadFile,
    reviewPostcode,
    onReviewPostcodeChange,
    onAskQuestionsAboutFile,
    onRunComplianceReview,
    onCancelPendingUpload,
    reviewingLabel,
    uploadedDocs,
    onDismissUploadedDoc,
    activeReview,
    onExitReviewChat,
    drawingAnalysisEnabled,
    chatMode,
    drawingFile,
    onDrawingFileChange,
    isLoading,
    modeSelectorEnabled,
    isModeMenuOpen,
    onToggleModeMenu,
    onSelectChatMode,
    ragSourceToggleEnabled,
    ragSource,
    onRagSourceChange,
    localRagStatus,
    voiceAgentUrl,
    onOpenVoiceAgentOverlay,
  } = props;

  return (
    <>
      {uploadedDocs.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          {uploadedDocs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-950/10 bg-white/80 px-3 py-2 backdrop-blur-xl"
            >
              <div className="min-w-0">
                <p className="truncate text-xs text-neutral-700">
                  <span className="text-neutral-800">{doc.name}</span>
                </p>
                <p className="text-[11px] text-neutral-500">
                  {doc.status === "uploading" && "Reading and indexing this document…"}
                  {doc.status === "ready" && "Ready — your questions in this chat will now use it."}
                  {doc.status === "error" && "Couldn't process this file — try again or ask without it."}
                </p>
              </div>
              <button
                onClick={() => onDismissUploadedDoc(doc.id)}
                className="shrink-0 rounded-xl border border-neutral-950/20 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/15 hover:text-neutral-950"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {pendingUploadFile && (
          <motion.div
            key="pending-upload-choice-card"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="w-full space-y-2 rounded-2xl border border-neutral-950/10 bg-white/80 px-3 py-3 backdrop-blur-xl"
          >
            <p className="truncate text-xs text-neutral-700">
              <span className="text-neutral-800">{pendingUploadFile.name}</span>
              {" — what would you like to do with it?"}
            </p>

            <input
              type="text"
              value={reviewPostcode}
              onChange={(e) => onReviewPostcodeChange(e.target.value)}
              placeholder="Postcode, e.g. SW1V 3LX — optional, I'll try to detect it from the document if left blank"
              disabled={isReviewing}
              className="block w-full rounded-xl border border-neutral-950/10 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:border-neutral-950/25"
            />

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isReviewing}
                onClick={() => onAskQuestionsAboutFile(pendingUploadFile)}
                className="rounded-xl border border-neutral-950/20 bg-white px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Ask questions about it
              </button>
              <button
                type="button"
                disabled={isReviewing}
                onClick={() => onRunComplianceReview(pendingUploadFile, reviewPostcode)}
                title={
                  !reviewPostcode.trim()
                    ? "No postcode entered - I'll try to detect the site from the document itself"
                    : undefined
                }
                className="rounded-xl border border-neutral-950/20 bg-neutral-950 px-3 py-1.5 text-xs text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isReviewing ? reviewingLabel : "Run compliance review"}
              </button>
              <button
                type="button"
                disabled={isReviewing}
                onClick={onCancelPendingUpload}
                className="rounded-xl px-3 py-1.5 text-xs text-neutral-500 transition hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active-review indicator - now a quiet chip (2026-09-28, per
          explicit request: "do not put 'Discussing the compliance
          review...' inside another huge rounded rectangle... a quiet
          contextual line/chip"), replacing the old bordered
          rounded-2xl card. */}
      <AnimatePresence>
        {activeReview && (
          <motion.div
            key="active-review-chip"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="flex items-center gap-2 rounded-full bg-neutral-950/[0.06] px-3 py-1 backdrop-blur-xl"
          >
            <p className="truncate text-[11px] text-neutral-600">
              Discussing: <span className="text-neutral-800">{activeReview.label}</span>
            </p>
            <button
              type="button"
              onClick={onExitReviewChat}
              className="shrink-0 text-[11px] font-medium text-neutral-500 underline decoration-neutral-400 underline-offset-2 transition hover:text-neutral-900"
            >
              Exit review chat
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {drawingAnalysisEnabled && chatMode === "feasibility" && (
        <div className="w-full space-y-2">
          <label className="block text-xs text-neutral-600">
            Optional: Upload floor plan or site plan for automatic analysis
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onDrawingFileChange(file);
              }}
              className="mt-1 block w-full text-xs text-neutral-600 file:mr-4 file:rounded-xl file:border-0 file:bg-neutral-200 file:px-4 file:py-2 file:text-xs file:text-neutral-950 hover:file:bg-neutral-300"
              disabled={isLoading}
            />
          </label>

          {drawingFile && (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-950/10 bg-white/80 px-3 py-2 backdrop-blur-xl">
              <div className="min-w-0">
                <p className="truncate text-xs text-neutral-700">
                  Drawing: <span className="text-neutral-800">{drawingFile.name}</span>
                </p>
                <p className="text-[11px] text-neutral-500">Will be analyzed for code compliance when you send</p>
              </div>
              <button
                onClick={() => onDrawingFileChange(null)}
                className="rounded-xl border border-neutral-950/20 bg-neutral-950/[0.06] px-3 py-1.5 text-xs text-neutral-900 transition hover:bg-neutral-950/15 hover:text-neutral-950"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      )}

      {modeSelectorEnabled && (
        <div className="relative text-center text-[11px] text-neutral-600">
          <button
            type="button"
            onClick={onToggleModeMenu}
            className="inline-flex items-center gap-1 rounded-full hover:text-neutral-900"
          >
            <span>
              {chatMode === "auto" && "Mode: Auto – describe what you want; the assistant will choose Feasibility, Permitting, or Risk."}
              {chatMode === "feasibility" && "Mode: Feasibility – share the site location, jurisdiction, and what you want to build."}
              {chatMode === "permitting" && "Mode: Permitting – upload your submission pack and specify the authority/jurisdiction."}
              {chatMode === "risk" && "Mode: Risk – provide project context/documents to analyze what could get rejected or delayed."}
            </span>
            <span aria-hidden="true">▾</span>
          </button>

          {isModeMenuOpen && (
            <div className="absolute bottom-6 left-1/2 z-10 w-44 -translate-x-1/2 rounded-2xl border border-neutral-950/10 bg-neutral-100/95 py-1 text-xs text-neutral-900 shadow-lg backdrop-blur-xl">
              {[
                { id: "auto" as const, label: "Auto (default)" },
                { id: "feasibility" as const, label: "Feasibility" },
                { id: "permitting" as const, label: "Permitting" },
                { id: "risk" as const, label: "Risk review" },
              ].map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => onSelectChatMode(mode.id)}
                  className={`flex w-full items-center justify-between px-3 py-2 hover:bg-neutral-950/10 ${
                    chatMode === mode.id ? "text-neutral-950" : ""
                  }`}
                >
                  <span>{mode.label}</span>
                  {chatMode === mode.id && <span>•</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {ragSourceToggleEnabled && (
        <div className="flex items-center justify-center gap-2 text-[11px] text-neutral-600">
          <span>Answers from:</span>
          <div className="relative inline-flex overflow-hidden rounded-full bg-neutral-950/[0.05] backdrop-blur-xl">
            {(["cloud", "local"] as const).map((source) => (
              <button
                key={source}
                type="button"
                onClick={() => onRagSourceChange(source)}
                className={`relative z-10 px-2.5 py-1 transition-colors duration-150 ${
                  ragSource === source ? "text-neutral-100" : "hover:bg-neutral-950/5"
                }`}
              >
                {ragSource === source && (
                  <motion.span
                    layoutId="ragSourcePill"
                    className="absolute inset-0 -z-10 rounded-full bg-neutral-950"
                    transition={{ type: "spring", stiffness: 500, damping: 35 }}
                  />
                )}
                {source === "cloud" ? "Cloud" : "Local (offline)"}
              </button>
            ))}
          </div>
          {ragSource === "local" && localRagStatus === "checking" && (
            <span className="text-neutral-500">checking…</span>
          )}
          {ragSource === "local" && localRagStatus === "unreachable" && (
            <span className="text-red-600">service not running - see local-rag/README.md</span>
          )}
        </div>
      )}

      {voiceAgentUrl && (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onOpenVoiceAgentOverlay}
            title="Full-duplex voice - real barge-in, requires voice-agent/ running (see its README)"
            className="press inline-flex items-center gap-1.5 rounded-full bg-neutral-950/[0.05] px-3 py-1.5 text-[11px] text-neutral-700 backdrop-blur-xl hover:bg-neutral-950/[0.08]"
          >
            <MicIcon className="h-3.5 w-3.5" />
            Full-duplex voice (beta)
          </button>
        </div>
      )}

      <p className="text-center text-[11px] text-neutral-500">
        Enter to send. Shift+Enter for new line. AI can be wrong.
      </p>
    </>
  );
}
