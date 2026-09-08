// app/api/client-log/route.ts
//
// Fire-and-forget sink for browser-side voice events that otherwise only
// ever show up in the browser's own devtools console - unreachable
// without a screenshot of exactly the right moment (as several rounds of
// TTS debugging this session found out the hard way). Anything posted
// here lands in client-debug.log at the repo root, readable the same way
// as voice-debug.log and voice-service/service.log.
//
// Deliberately dumb: no validation beyond "is this JSON", no auth (this
// only ever runs against your own local dev server), nothing that could
// throw and break the caller's actual voice flow.

import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const LOG_FILE = path.join(process.cwd(), "client-debug.log");

export async function POST(req: Request) {
  try {
    const body = await req.json();
    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} ${JSON.stringify(body)}\n`
    );
  } catch {
    // Never let logging itself surface as an error to the caller.
  }
  return NextResponse.json({ ok: true });
}
