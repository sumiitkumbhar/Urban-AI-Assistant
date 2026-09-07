// app/api/tts/route.ts
//
// Thin server-side proxy to the self-hosted Chatterbox voice service (see
// voice-service/ in the repo root for the actual model). Kept server-side
// so the service's URL is never exposed to the browser, and so the voice
// backend can be swapped later without touching the client at all.
//
// Zero-cost by design: Chatterbox is open-source (MIT) and runs on your
// own hardware or a free-tier host (see voice-service/README.md for a
// Hugging Face Spaces option) - there's no per-character billing here,
// unlike a hosted TTS API. If the service isn't configured or isn't
// reachable, this returns an error status and the client
// (lib/useVoiceChat.ts) falls back to the browser's own built-in
// text-to-speech rather than failing silently.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const CHATTERBOX_TTS_URL = process.env.CHATTERBOX_TTS_URL || "";

export async function POST(req: Request) {
  if (!CHATTERBOX_TTS_URL) {
    return NextResponse.json(
      {
        error:
          "CHATTERBOX_TTS_URL is not configured - set it in .env.local to your running voice-service instance (see voice-service/README.md). Falling back to browser voice.",
      },
      { status: 503 }
    );
  }

  let text = "";
  try {
    const body = await req.json();
    text = typeof body?.text === "string" ? body.text.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  // Chatterbox generation is real inference, not instant - give it real
  // headroom before giving up and letting the client fall back. Bumped
  // up from 30s because a free Hugging Face Space only gets 2 shared
  // vCPUs (Chatterbox Nano's "3x realtime" number was benchmarked on 8
  // cores), so generation is meaningfully slower there than on real
  // hardware.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const upstream = await fetch(
      `${CHATTERBOX_TTS_URL.replace(/\/$/, "")}/speak`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      }
    );

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: `Voice service returned ${upstream.status}`, detail },
        { status: 502 }
      );
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Voice service unreachable" },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
