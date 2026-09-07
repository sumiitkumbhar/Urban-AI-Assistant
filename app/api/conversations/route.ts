// List/create conversations, scoped to an anonymous per-browser visitorId
// (see lib/visitorId.ts and sql/chat_history_setup.sql). No auth beyond
// that - matches the rest of this app, which has no login system.

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const visitorId = req.nextUrl.searchParams.get("visitorId");
    if (!visitorId) {
      return NextResponse.json({ error: "Missing visitorId" }, { status: 400 });
    }

    const { data, error } = await getSupabase()
      .from("conversations")
      .select("id, title, created_at, updated_at")
      .eq("visitor_id", visitorId)
      .order("updated_at", { ascending: false })
      .limit(100);

    if (error) throw error;

    return NextResponse.json({ conversations: data || [] });
  } catch (err: any) {
    console.error("GET /api/conversations failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to list conversations" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const visitorId = String(body?.visitorId || "").trim();
    if (!visitorId) {
      return NextResponse.json({ error: "Missing visitorId" }, { status: 400 });
    }

    const title =
      typeof body?.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 120)
        : "New conversation";

    const { data, error } = await getSupabase()
      .from("conversations")
      .insert({ visitor_id: visitorId, title })
      .select("id, title, created_at, updated_at")
      .single();

    if (error) throw error;

    return NextResponse.json({ conversation: data });
  } catch (err: any) {
    console.error("POST /api/conversations failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to create conversation" },
      { status: 500 }
    );
  }
}
