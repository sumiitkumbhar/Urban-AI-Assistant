// lib/conversationMemory.ts
//
// Shared per-browser (no login) conversation persistence - see
// sql/chat_history_setup.sql and lib/visitorId.ts. Originally lived only
// inside app/api/rag-chat/route.ts (the Cloud path); extracted here so
// app/api/local-rag-chat/route.ts and app/api/local-rag-chat/stream/
// route.ts can save Local-mode turns through the exact same two
// functions instead of hand-rolling a second copy of this Supabase
// write logic - see urban-ai-architecture-plan.md's "conversation
// hydration bug" fix notes for why the two backends had silently
// diverged (Cloud persisted every turn, Local persisted nothing).
//
// Everything below is best-effort and additive: with no visitorId, or if
// persistence fails for any reason, the chat still answers exactly as it
// did before this feature existed - none of this can turn a working
// answer into a broken request.

import { getSupabase } from "@/lib/supabase";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export const CONVERSATION_HISTORY_LIMIT = 8;

export async function loadRecentMessages(
  conversationId: string
): Promise<ConversationTurn[]> {
  try {
    const { data, error } = await getSupabase()
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(CONVERSATION_HISTORY_LIMIT);

    if (error || !data) return [];

    return data
      .slice()
      .reverse()
      .map((row: any) => ({ role: row.role, content: row.content }));
  } catch (error) {
    console.error(
      "loadRecentMessages failed (continuing without history):",
      error
    );
    return [];
  }
}

// Resolves which conversation this turn belongs to: continues
// requestedConversationId if it's real and owned by this visitor,
// otherwise starts a fresh one titled from the first message. Returns
// null (never throws) if persistence isn't configured or fails, so the
// caller can just skip saving this turn.
export async function ensureConversation(
  visitorId: string,
  requestedConversationId: string,
  firstMessagePreview: string
): Promise<string | null> {
  try {
    if (requestedConversationId) {
      const { data, error } = await getSupabase()
        .from("conversations")
        .select("id, visitor_id")
        .eq("id", requestedConversationId)
        .maybeSingle();

      if (!error && data && data.visitor_id === visitorId) {
        return requestedConversationId;
      }
      // Requested id doesn't exist, or belongs to a different visitor -
      // fall through and start a fresh conversation rather than failing
      // the whole chat request over a stale or tampered id.
    }

    const title = firstMessagePreview.trim().slice(0, 60) || "New conversation";
    const { data, error } = await getSupabase()
      .from("conversations")
      .insert({ visitor_id: visitorId, title })
      .select("id")
      .single();

    if (error || !data) return null;
    return data.id;
  } catch (error) {
    console.error(
      "ensureConversation failed (continuing without persistence):",
      error
    );
    return null;
  }
}

export async function persistConversationTurn(
  conversationId: string,
  userQuery: string,
  assistantAnswer: string,
  assistantMetadata: Record<string, any>
) {
  try {
    const supabase = getSupabase();

    // Two sequential inserts, not one two-row insert - found live while
    // testing this fix: a single insert([...]) call gives both rows the
    // exact same chat_messages.created_at (Postgres's now() is evaluated
    // once per statement), and GET /api/conversations/[id]'s
    // .order("created_at", { ascending: true }) has no tiebreaker for
    // that exact tie. Postgres doesn't guarantee tie order is stable, so
    // a conversation with 2+ turns could - and, reproduced live, did -
    // come back with an assistant reply sorted BEFORE the user message
    // that prompted it once a second turn existed. Two awaited
    // statements get genuinely different timestamps, restoring the
    // correct order deterministically without a schema change.
    await supabase
      .from("chat_messages")
      .insert({ conversation_id: conversationId, role: "user", content: userQuery });

    await supabase.from("chat_messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: assistantAnswer,
      metadata: assistantMetadata,
    });

    await supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  } catch (error) {
    console.error(
      "persistConversationTurn failed (chat still answered fine):",
      error
    );
  }
}
