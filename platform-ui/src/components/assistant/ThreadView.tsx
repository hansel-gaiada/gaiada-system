"use client";
import { useEffect, useRef } from "react";
import type { AssistantMessage, StreamState } from "@/lib/assistant";
import { Message } from "./Message";
import { StreamIndicator } from "./StreamIndicator";
import { useTypewriter } from "./useAssistantStream";

// ASST-07 — the center column. One rendering path for both history and the live reply: the
// currently-streaming row (if any) is looked up by id in the SAME `messages` array and gets the
// typewriter-smoothed live text overlaid; every other row renders straight from the last server
// fetch. That is what makes "refresh restores the exact transcript" true without a second code path.
export function ThreadView({
  messages, streamState, streamingMessageId, loading,
}: {
  messages: AssistantMessage[];
  streamState: StreamState;
  streamingMessageId: string | null;
  loading: boolean;
}) {
  const displayText = useTypewriter(streamState.text);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, displayText, streamState.status]);

  if (loading) {
    return <div className="asst-thread-empty" aria-hidden="true" />;
  }

  if (messages.length === 0 && streamState.status === "idle") {
    return (
      <div className="asst-thread-empty">
        <p className="type-eyebrow" style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Assistant</p>
        <p>Ask a question about your projects, clients, or the platform — or start drafting something.</p>
      </div>
    );
  }

  return (
    <div className="asst-thread" role="log" aria-label="Conversation">
      {messages.map((m) => {
        const isLive = m.id === streamingMessageId && streamState.status === "streaming";
        return <Message key={m.id} message={m} streaming={isLive} liveText={isLive ? displayText : undefined} />;
      })}
      <StreamIndicator state={streamState} />
      <div ref={bottomRef} />
    </div>
  );
}
