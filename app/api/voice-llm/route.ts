// app/api/voice-llm/route.ts
//
// A minimal OpenAI-Chat-Completions-compatible shim over this app's own
// /api/rag-chat, so the new Pipecat voice-agent (see ../../voice-agent/)
// can drive RAG answers through Pipecat's real, well-tested
// OpenAILLMService (which supports pointing `base_url` at any
// OpenAI-compatible server) instead of a hand-written custom Pipecat LLM
// service.
//
// Why this indirection: Pipecat's own LLM integration is built around a
// universal conversation-context object and provider adapters that are
// still evolving fast (confirmed by reading its current source while
// building the voice-agent - VAD wiring alone has changed since most
// tutorials about it were written). Reusing OpenAILLMService as-is and
// putting the RAG-specific translation here, in plain TypeScript we can
// read and test directly, is far lower risk than reverse-engineering that
// internal protocol from outside the framework.
//
// Only the one shape OpenAILLMService's non-streaming path needs is
// implemented: POST { model, messages: [...] } -> a chat.completion object
// with a single message. `stream: true` is rejected outright - the RAG
// call this wraps (retrieval + Groq LLM + groundedness check +
// humanizeForSpeech, see app/api/rag-chat/route.ts) returns one complete,
// fact-checked answer, not token deltas, so there is nothing to stream
// without a separate, larger refactor of that pipeline.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface CompatMessage {
  role: string;
  content: string;
}

interface CompatRequestBody {
  model?: string;
  messages?: CompatMessage[];
  stream?: boolean;
}

export async function POST(req: Request) {
  let body: CompatRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON body" } },
      { status: 400 }
    );
  }

  if (body.stream) {
    return NextResponse.json(
      {
        error: {
          message:
            "This shim does not support stream:true - the RAG backend it calls " +
            "(retrieval + groundedness check + spoken-text rewrite) returns one " +
            "complete answer, not token deltas. Configure the voice-agent's " +
            "OpenAILLMService without streaming.",
        },
      },
      { status: 400 }
    );
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserMessage = [...messages].reverse().find((m) => m?.role === "user");
  const query = (lastUserMessage?.content || "").trim();

  if (!query) {
    return NextResponse.json(
      { error: { message: "No user message found in messages[]" } },
      { status: 400 }
    );
  }

  // Same-origin self-call - works in dev and prod without a separate env
  // var, since this route and /api/rag-chat are always served together.
  const origin = new URL(req.url).origin;

  let upstream: Response;
  try {
    upstream = await fetch(`${origin}/api/rag-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        mode: "default",
        voiceMode: true,
      }),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: { message: error?.message || "/api/rag-chat unreachable" } },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: { message: `/api/rag-chat returned ${upstream.status}: ${detail}` } },
      { status: 502 }
    );
  }

  const ragJson = await upstream.json().catch(() => null);
  // Prefer the humanized, spoken-style rewrite (see humanizeForSpeech in
  // app/api/rag-chat/route.ts) - falls back to the on-screen answer only if
  // that step failed.
  const content: string =
    ragJson?.data?.speechText ||
    ragJson?.answer ||
    "Sorry, I couldn't come up with an answer to that.";

  return NextResponse.json({
    id: `voice-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "urban-ai-rag",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
