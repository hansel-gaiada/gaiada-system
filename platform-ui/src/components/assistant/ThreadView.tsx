"use client";
import { useEffect, useRef } from "react";
import type { AssistantMessage, StreamState } from "@/lib/assistant";
import { Message } from "./Message";
import { StreamIndicator } from "./StreamIndicator";
import { EmptyStateSuggestions } from "./EmptyStateSuggestions";
import { useTypewriter } from "./useAssistantStream";

// ASST-07 — the center column. One rendering path for both history and the live reply: the
// currently-streaming row (if any) is looked up by id in the SAME `messages` array and gets the
// typewriter-smoothed live text overlaid; every other row renders straight from the last server
// fetch. That is what makes "refresh restores the exact transcript" true without a second code path.
export function ThreadView({
  messages, streamState, streamingMessageId, loading, threadId, onSuggestionPick, onOpenCapabilities,
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
  /** Empty-state suggestion tile click — hands the prompt text up to `AssistantWorkspace`'s
   *  composer prefill (see `Composer`'s `prefill` prop). Defaulted to a no-op so this component
   *  never silently drops the tile row just because a caller (a test, most likely) forgot to wire
   *  it — the real app always supplies it. */
  onSuggestionPick?: (prompt: string) => void;
  /** Opens the SAME right-rail Capabilities panel the toolbar button does — the empty state's
   *  explicit escape hatch to the full tool catalogue (see `EmptyStateSuggestions`'s header). */
  onOpenCapabilities?: () => void;
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
    // 2026-08-07 owner fix — this used to render the FULL raw tool catalogue (`CapabilityCards`,
    // dozens of dot-namespaced names + developer-facing prose) as the first thing anyone saw in a
    // brand-new chat. It now leads with a short, human-readable set of things a person actually
    // wants to do (`EmptyStateSuggestions`) — the catalogue itself moved to the toolbar's existing
    // "Capabilities" button/panel (this view's own "See everything I can do" tile opens the SAME
    // panel), never deleted. VER-03's heading-order fix (a real `<h2>` here, not a styled `<p>`) no
    // longer even needs the reasoning it originally had: `EmptyStateSuggestions` renders no
    // headings of its own, so there is nothing to order against — the `<h2>` below is simply this
    // view's own label, kept for the same reason any page needs one.
    return (
      <div className="asst-thread-empty asst-thread-empty--wide">
        <h2 className="type-eyebrow" style={{ margin: "0 0 8px", color: "var(--erp-accent)", display: "block" }}>Assistant</h2>
        <p>Ask a question about your projects, clients, or the platform — or try one of these:</p>
        <EmptyStateSuggestions
          onPick={onSuggestionPick ?? (() => {})}
          onOpenCapabilities={onOpenCapabilities ?? (() => {})}
        />
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
