// app/api/tts/route.ts
//
// Thin server-side proxy to the self-hosted voice service (see
// voice-service/ in the repo root for the actual model - currently
// CosyVoice2, previously Chatterbox; the env var name below is kept as
// CHATTERBOX_TTS_URL for backwards compatibility rather than renamed).
// Kept server-side so the service's URL is never exposed to the browser,
// and so the voice backend can be swapped later without touching the
// client at all.
//
// Zero-cost by design: the model behind this is open-source and runs on
// your own hardware or a free-tier host (see voice-service/README.md,
// including an honest note about how well "free tier" actually performs
// for CosyVoice2 specifically) - there's no per-character billing here,
// unlike a hosted TTS API. If the service isn't configured or isn't
// reachable, this returns an error status. There is no browser-voice
// fallback on the client anymore (lib/useVoiceChat.ts) - a failure here
// means that turn just isn't spoken aloud, so getting this call to
// actually succeed matters more than it used to.

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

  // Real inference, not instant, and there's no fallback to bail out to
  // anymore - so it's better to wait than to give up early and go
  // silent. On CPU-only hardware (no CUDA/MPS in CosyVoice2's own code)
  // a full paragraph-length answer can genuinely take longer than the
  // 45s this used to allow - bumped to 3 minutes. If the voice service
  // is actually down or misconfigured, this still fails fast (the fetch
  // itself errors immediately on connection refused) - this timeout only
  // matters for a slow-but-working generation.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);

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
