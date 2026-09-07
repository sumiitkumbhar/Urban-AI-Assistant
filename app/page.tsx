"use client";

import React from "react";
import dynamic from "next/dynamic";

const ChatInterface = dynamic(() => import("@/components/chat/ChatInterface"), {
  ssr: false,
});

// Warm paper ground - faint horizontal notebook ruling plus a visible-but-
// gentle film grain, standing in for the matte e-ink texture of the
// reference device. Every color cue in this app still lives in content
// (confidence shading, source cards), never in the chrome itself.
const RuledPaper = () => (
  <div className="fixed inset-0 -z-10 h-full w-full bg-[#f7f4ee] bg-[linear-gradient(to_bottom,rgb(61_52_38_/_0.055)_1px,transparent_1px)] bg-[size:100%_32px] pointer-events-none" />
);

// A very soft vignette - paper photographed under uneven light rather than
// a flat digital fill.
const Vignette = () => (
  <div
    className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
    style={{
      background:
        "radial-gradient(120% 120% at 50% 0%, transparent 40%, rgba(0,0,0,0.1) 100%)",
    }}
  />
);

// Fractal-noise overlay for a matte, textured finish - dialed up enough to
// actually read as paper grain up close, not just a hint.
const GrainOverlay = () => (
  <div
    className="pointer-events-none absolute inset-0 -z-10 h-full w-full opacity-[0.16] mix-blend-multiply"
    style={{
      backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
    }}
  />
);

export default function UrbanCopilotPage() {
  return (
    <div className="relative h-screen overflow-hidden bg-[#f7f4ee] text-neutral-950">
      <RuledPaper />
      <Vignette />
      <GrainOverlay />
      <main className="relative z-10 h-full w-full">
        <ChatInterface />
      </main>
    </div>
  );
}
