"use client";

import React, { useEffect, useState, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { formatDistanceToNowStrict } from "date-fns";

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ConversationSidebarProps {
  visitorId: string;
  activeConversationId: string | null;
  loadingConversationId: string | null;
  refreshSignal: number;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  isOpen: boolean;
  onClose: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

type IconProps = React.SVGProps<SVGSVGElement>;

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

const PlusIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

const ChatBubbleIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </Svg>
);

const TrashIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

const PencilIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </Svg>
);

const CloseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
);

// A little panel-with-a-divider glyph, the common "toggle sidebar" mark.
// Rotates 180deg via the caller when collapsed, so one icon covers both
// directions instead of swapping between two.
const PanelIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16" />
  </Svg>
);

const SpinnerIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
    <circle
      cx="12"
      cy="12"
      r="9"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeOpacity="0.2"
    />
    <path
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
);

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

export default function ConversationSidebar({
  visitorId,
  activeConversationId,
  loadingConversationId,
  refreshSignal,
  onSelectConversation,
  onNewChat,
  isOpen,
  onClose,
  isCollapsed,
  onToggleCollapse,
}: ConversationSidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>(
    []
  );
  const [loading, setLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!visitorId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/conversations?visitorId=${encodeURIComponent(visitorId)}`
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data?.conversations)) {
        setConversations(data.conversations);
      }
    } catch {
      // best-effort - an empty/unchanged list just means the sidebar
      // stays as it was, the chat itself is unaffected.
    } finally {
      setLoading(false);
    }
  }, [visitorId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitorId, refreshSignal]);

  async function handleDelete(id: string) {
    setConfirmDeleteId(null);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      await fetch(
        `/api/conversations/${id}?visitorId=${encodeURIComponent(visitorId)}`,
        { method: "DELETE" }
      );
    } catch {
      // ignore - list will reconcile itself on next load()
    }
    if (id === activeConversationId) {
      onNewChat();
    }
  }

  async function commitRename(id: string) {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;

    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
    try {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId, title }),
      });
    } catch {
      // ignore - best-effort rename
    }
  }

  return (
    <>
      {/* mobile scrim */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-neutral-950/5 bg-[#f7f4ee]/95 backdrop-blur-xl transition-[transform,width] duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        } ${isCollapsed ? "lg:w-16" : "lg:w-72"}`}
      >
        {/* ---- collapsed icon rail (desktop only) ---- */}
        <div
          className={`hidden flex-1 flex-col items-center py-3 ${
            isCollapsed ? "lg:flex" : ""
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Urban AI Assistant"
            className="mb-3 h-6 w-6 object-contain"
          />
          <button
            type="button"
            onClick={onToggleCollapse}
            className="mb-3 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-neutral-600 hover:bg-neutral-950/5 hover:text-neutral-800"
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelIcon className="h-4 w-4 rotate-180" />
          </button>
          <button
            type="button"
            onClick={onNewChat}
            className="mb-4 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-neutral-950/10 bg-neutral-950/5 text-neutral-900 hover:bg-neutral-950/10"
            aria-label="New chat"
            title="New chat"
          >
            <PlusIcon className="h-4 w-4" />
          </button>

          <div
            className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-6"
            style={{
              maskImage:
                "linear-gradient(to bottom, black calc(100% - 2rem), transparent 100%)",
              WebkitMaskImage:
                "linear-gradient(to bottom, black calc(100% - 2rem), transparent 100%)",
            }}
          >
            {conversations.map((c) => {
              const isActive = c.id === activeConversationId;
              const isOpening = loadingConversationId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelectConversation(c.id)}
                  title={c.title}
                  aria-label={c.title}
                  className={`press relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[11px] font-semibold transition-colors ${
                    isActive
                      ? "bg-neutral-950 text-[#f7f4ee]"
                      : "text-neutral-500 hover:bg-neutral-950/[0.07] hover:text-neutral-900"
                  }`}
                >
                  {isOpening ? (
                    <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    // An initial derived from the conversation title, not a
                    // repeated speech-bubble glyph. Thirty identical icons
                    // stacked in a rail carry no information and read as a
                    // rendering fault; initials make the rail scannable and
                    // give the active item something to actually highlight.
                    <span aria-hidden="true">
                      {(c.title || "?").trim().charAt(0).toUpperCase()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ---- full sidebar (mobile always, desktop when expanded) ---- */}
        <div
          className={`flex flex-1 flex-col ${isCollapsed ? "lg:hidden" : ""}`}
        >
          <div className="flex items-center gap-2 px-4 pb-1 pt-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" className="h-6 w-6 object-contain" />
            <span className="text-sm font-semibold tracking-tight text-neutral-900">
              Urban AI Assistant
            </span>
          </div>

          <div className="flex items-center gap-2 p-3">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-neutral-600 hover:bg-neutral-950/5 hover:text-neutral-800 lg:flex"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onNewChat}
              className="flex flex-1 items-center gap-2 rounded-2xl border border-neutral-950/10 bg-neutral-950/5 px-3 py-2.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-950/10"
            >
              <PlusIcon className="h-4 w-4 text-neutral-950" />
              New chat
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-neutral-600 hover:bg-neutral-950/5 hover:text-neutral-800 lg:hidden"
              aria-label="Close sidebar"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {conversations.length === 0 && !loading && (
              <p className="px-3 py-4 text-xs text-neutral-500">
                Your saved chats will show up here.
              </p>
            )}

            <AnimatePresence initial={false}>
              {conversations.map((c) => {
                const isActive = c.id === activeConversationId;
                const isRenaming = renamingId === c.id;
                const isConfirming = confirmDeleteId === c.id;
                const isOpening = loadingConversationId === c.id;

                return (
                  <motion.div
                    key={c.id}
                    layout
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.15 }}
                    className={`group relative mb-1 flex items-center gap-2 rounded-2xl px-3 py-2.5 text-sm transition-colors ${
                      isActive
                        ? "bg-neutral-950/10 text-neutral-950"
                        : "text-neutral-700 hover:bg-neutral-950/5"
                    }`}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-neutral-950" />
                    )}

                    {isOpening ? (
                      <SpinnerIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-950" />
                    ) : (
                      <ChatBubbleIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                    )}

                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(c.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={() => commitRename(c.id)}
                        className="min-w-0 flex-1 rounded-lg border border-neutral-950/10 bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-950/30"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          onSelectConversation(c.id);
                          onClose();
                        }}
                        className="min-w-0 flex-1 truncate text-left"
                        title={c.title}
                      >
                        <span className="block truncate">{c.title}</span>
                        <span className="block truncate text-[10px] text-neutral-500">
                          {relativeTime(c.updated_at)}
                        </span>
                      </button>
                    )}

                    {!isRenaming && (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenamingId(c.id);
                            setRenameValue(c.title);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-950/10 hover:text-neutral-800"
                          aria-label="Rename conversation"
                        >
                          <PencilIcon className="h-3 w-3" />
                        </button>

                        {isConfirming ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(c.id);
                            }}
                            className="rounded-lg bg-neutral-950 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-neutral-800"
                          >
                            Confirm
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteId(c.id);
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-950/10 hover:text-neutral-950"
                            aria-label="Delete conversation"
                          >
                            <TrashIcon className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      </aside>
    </>
  );
}
