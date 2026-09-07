"use client";

import dynamic from "next/dynamic";

const ChatInterface = dynamic(() => import("@/components/chat/ChatInterface"), {
  ssr: false,
  loading: () => (
    <main className="urban-boot" aria-busy="true" aria-label="Loading Urban AI Assistant">
      <span className="urban-wordmark">urban<span>ai</span></span>
      <p>Opening your workspace…</p>
    </main>
  ),
});

export default function UrbanCopilotPage() {
  return <ChatInterface />;
}
