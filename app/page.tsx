"use client";

import React from "react";
import dynamic from "next/dynamic";

const ChatInterface = dynamic(() => import("@/components/chat/ChatInterface"), {
  ssr: false,
});

const GridPattern = () => (
  <div className="absolute inset-0 -z-10 h-full w-full bg-slate-950 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none">
    <div className="absolute left-0 right-0 top-0 -z-10 m-auto h-[310px] w-[310px] rounded-full bg-blue-500 opacity-10 blur-[100px]" />
    <div className="absolute bottom-0 right-0 -z-10 h-[310px] w-[310px] rounded-full bg-purple-500 opacity-10 blur-[100px]" />
  </div>
);

export default function UrbanCopilotPage() {
  return (
    <div className="relative h-screen overflow-hidden bg-slate-950 text-white">
      <GridPattern />
      <main className="relative z-10 h-full w-full">
        <ChatInterface />
      </main>
    </div>
  );
}