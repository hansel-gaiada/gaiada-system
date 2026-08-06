import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Message } from "./Message";
import { initialStreamState, type AssistantMessage } from "@/lib/assistant";

// VER-03 — pins the fix for the "spam every token" failure mode the a11y audit called out:
// `.asst-thread` (ThreadView) is `role="log"`, an implicit-polite live region, so ANY DOM mutation
// inside it — not just an explicit `aria-live="assertive"` — is fair game for a screen reader to
// announce. The typewriter smoother mutates the streaming row's text every ~16ms; without this row
// opting itself OUT via `aria-live="off"` while `streaming` is true, that reads as a token-by-token
// announcement storm. See Message.tsx's own header for the full reasoning.
function baseMessage(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "m1", seq: 1, role: "assistant", content: "Hello there", parts: null,
    provider: null, model: null, tokens: null, latencyMs: null, errorKind: null,
    createdAt: new Date().toISOString(), ...over,
  };
}

describe("Message — streaming aria-live containment", () => {
  it("sets aria-live=off on the row while it is the one actively streaming", () => {
    render(
      <Message
        message={baseMessage({ content: null })}
        streaming
        liveText="Hel"
        liveState={{ ...initialStreamState(), status: "streaming", text: "Hel" }}
        threadId="t1"
      />,
    );
    const article = screen.getByRole("article");
    expect(article).toHaveAttribute("aria-live", "off");
  });

  it("does NOT set aria-live on a finished/historical row — the log's own implicit polite live-ness is left to do its normal job of announcing new rows", () => {
    render(<Message message={baseMessage()} threadId="t1" />);
    const article = screen.getByRole("article");
    expect(article).not.toHaveAttribute("aria-live");
  });
});
