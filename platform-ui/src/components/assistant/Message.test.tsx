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

// AIP-18 (BFF §66.11) — the soft stop's ONE quiet line under a reply: from the live `budget` frame while the row streams, from the `turn_budget` part on a
// finished or reloaded row. No numbers, never a modal, nothing when the turn was not stopped.
describe("Message: the soft stop's line", () => {
  const allowancePart = { type: "turn_budget", kind: "allowance", resetsAt: "2026-10-31T00:00:00.000Z" };
  const departmentPart = { type: "turn_budget", kind: "department", unitNodeId: "d-web", resetsAt: "2026-11-01T00:00:00.000Z" };
  const line = () => document.querySelector(".asst-msg__budget");

  it("shows the allowance line from the persisted part, with the reset time in local time and UTC", () => {
    render(<Message message={baseMessage({ parts: [{ type: "usage_meta", usageSource: "provider" }, allowancePart] })} threadId="t1" />);
    expect(line()).not.toBeNull();
    expect(line()).toHaveAttribute("role", "note");
    expect(line()?.textContent).toMatch(/^You have reached today's AI allowance\. Replies continue in a lighter mode until .*00:00 UTC.*\.$/);
  });
  it("shows the department line, naming the month and carrying no number", () => {
    render(<Message message={baseMessage({ parts: [departmentPart] })} threadId="t1" />);
    expect(line()?.textContent).toBe("Your department has reached its AI budget for October. Replies continue in a lighter mode.");
    expect(line()?.textContent).not.toMatch(/\d/);
  });
  it("shows exactly ONE line, and it is not a modal: no dialog, nothing that blocks", () => {
    render(<Message message={baseMessage({ parts: [allowancePart] })} threadId="t1" />);
    expect(document.querySelectorAll(".asst-msg__budget")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("is absent when the turn was not stopped: no part, other parts only, a null or odd parts value", () => {
    for (const parts of [null, [], [{ type: "usage_meta", usageSource: "estimate" }], "x", [{ type: "turn_budget", kind: "weekly" }]]) {
      const { unmount } = render(<Message message={baseMessage({ parts })} threadId="t1" />);
      expect(line()).toBeNull();
      unmount();
    }
  });
  it("shows the line from the live `budget` frame while the reply streams (the placeholder row has no part yet)", () => {
    render(
      <Message
        message={baseMessage({ content: null })}
        streaming
        liveText="Hel"
        liveState={{ ...initialStreamState(), status: "streaming", text: "Hel", turnBudget: { kind: "department", resetsAt: "2026-11-01T00:00:00.000Z" } }}
        threadId="t1"
      />,
    );
    expect(line()?.textContent).toContain("Your department has reached its AI budget for October.");
  });
  it("shows nothing while streaming an unstopped turn, even if an old part is on the row", () => {
    render(<Message message={baseMessage({ content: null, parts: null })} streaming liveText="Hel" liveState={{ ...initialStreamState(), status: "streaming", text: "Hel" }} threadId="t1" />);
    expect(line()).toBeNull();
  });
  it("never draws on a person's own message", () => {
    render(<Message message={baseMessage({ role: "user", parts: [allowancePart] })} threadId="t1" />);
    expect(line()).toBeNull();
  });
});
