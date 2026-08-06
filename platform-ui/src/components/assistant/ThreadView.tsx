"use client";
import { useEffect, useRef } from "react";
import type { AssistantMessage, StreamState } from "@/lib/assistant";
import { Message } from "./Message";
import { StreamIndicator } from "./StreamIndicator";
import { CapabilityCards } from "./CapabilityCards";
import { useTypewriter } from "./useAssistantStream";

// ASST-07 — the center column. One rendering path for both history and the live reply: the
// currently-streaming row (if any) is looked up by id in the SAME `messages` array and gets the
// typewriter-smoothed live text overlaid; every other row renders straight from the last server
// fetch. That is what makes "refresh restores the exact transcript" true without a second code path.
export function ThreadView({
  messages, streamState, streamingMessageId, loading, threadId,
}: {
  messages: AssistantMessage[];
  streamState: StreamState;
  streamingMessageId: string | null;
  loading: boolean;
  /** T4 (ASST-23) — passed straight through to `Message` for the Confirm/Dismiss endpoints' URL;
   *  this component has no other use for it. `""` on the (rare) render with no active thread yet —
   *  harmless, since a thread-less render also has no messages, so no `ProposalCard` ever mounts to
   *  actually need it. */
  threadId: string;
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
    // ASST-18 — blueprint §8: "Empty state: capability cards — doubles as the discoverability
    // answer." `CapabilityCards` is the SAME component (and the same underlying fetch) the
    // right-rail panel renders — see that component's own header for why that is load-bearing.
    // VER-03 — this must be a real heading, not a styled `<p>`: `CapabilityCards` renders its
    // category titles as `<h3>` (see that file), and the ONLY thing that guarantees an `<h2>`
    // exists somewhere earlier in document order — so the page's heading levels go 1→2→3 instead
    // of skipping straight to 3 — is a brand-new user with zero threads at all: `ThreadRail` then
    // renders no group `<h2>`s either (its "Pinned"/date-group headings only exist once at least
    // one thread does), which is exactly the moment this empty state is the only thing on screen.
    return (
      <div className="asst-thread-empty asst-thread-empty--wide">
        <h2 className="type-eyebrow" style={{ margin: "0 0 8px", color: "var(--erp-accent)", display: "block" }}>Assistant</h2>
        <p>Ask a question about your projects, clients, or the platform — or try one of these:</p>
        <CapabilityCards variant="empty-state" />
      </div>
    );
  }

  return (
    <div className="asst-thread" role="log" aria-label="Conversation">
      {messages.map((m) => {
        const isLive = m.id === streamingMessageId && streamState.status === "streaming";
        return (
          <Message
            key={m.id}
            message={m}
            streaming={isLive}
            liveText={isLive ? displayText : undefined}
            liveState={isLive ? streamState : undefined}
            threadId={threadId}
          />
        );
      })}
      <StreamIndicator state={streamState} />
      <div ref={bottomRef} />
    </div>
  );
}
