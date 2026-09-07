// Anonymous per-browser identity for scoping saved conversations. There's
// no login system in this app (see sql/chat_history_setup.sql for the
// full rationale) - this is a random id generated once and kept in
// localStorage, sent as visitorId on every conversation-related request
// so a browser only ever sees its own chat history.

const STORAGE_KEY = "urban-ai-visitor-id";

export function getVisitorId(): string {
  if (typeof window === "undefined") return "";

  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;

    const generated =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    window.localStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    // localStorage unavailable (private mode, blocked storage, etc.) -
    // fall back to a per-render id rather than throwing. Conversation
    // history just won't persist across reloads for this visitor.
    return `anonymous-${Date.now()}`;
  }
}
