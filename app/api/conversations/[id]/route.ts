// Fetch, rename, or delete a single conversation and its messages.
// Every operation re-checks visitor_id ownership server-side before
// touching anything - a visitorId alone is not a secret (it's just a
// localStorage value), but this at least stops one browser from casually
// reading or editing another's saved chats by guessing a conversation id.

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

async function ownsConversation(id: string, visitorId: string) {
  const { data, error } = await getSupabase()
    .from("conversations")
    .select("id, visitor_id")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return !!data && data.visitor_id === visitorId;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const visitorId = req.nextUrl.searchParams.get("visitorId");
    if (!visitorId) {
      return NextResponse.json({ error: "Missing visitorId" }, { status: 400 });
    }

    // Ownership check and the message fetch don't depend on each other,
    // so run them concurrently instead of paying two round-trips in a
    // row - this is the request the sidebar waits on every time a saved
    // chat is opened, so shaving the extra latency here is worth it.
    const [owns, messagesResult] = await Promise.all([
      ownsConversation(params.id, visitorId),
      getSupabase()
        .from("chat_messages")
        .select("id, role, content, metadata, created_at")
        .eq("conversation_id", params.id)
        .order("created_at", { ascending: true }),
    ]);

    if (!owns) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (messagesResult.error) throw messagesResult.error;

    return NextResponse.json({ messages: messagesResult.data || [] });
  } catch (err: any) {
    console.error("GET /api/conversations/[id] failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to load conversation" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json().catch(() => ({}));
    const visitorId = String(body?.visitorId || "").trim();
    const title =
      typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "";

    if (!visitorId || !title) {
      return NextResponse.json(
        { error: "Missing visitorId or title" },
        { status: 400 }
      );
    }

    if (!(await ownsConversation(params.id, visitorId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { error } = await getSupabase()
      .from("conversations")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", params.id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("PATCH /api/conversations/[id] failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to rename conversation" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const visitorId = req.nextUrl.searchParams.get("visitorId");
    if (!visitorId) {
      return NextResponse.json({ error: "Missing visitorId" }, { status: 400 });
    }

    if (!(await ownsConversation(params.id, visitorId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // chat_messages has ON DELETE CASCADE on conversation_id, so its rows
    // for this conversation are removed automatically.
    const { error } = await getSupabase()
      .from("conversations")
      .delete()
      .eq("id", params.id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("DELETE /api/conversations/[id] failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to delete conversation" },
      { status: 500 }
    );
  }
}
