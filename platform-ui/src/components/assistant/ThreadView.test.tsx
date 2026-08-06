import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ThreadView } from "./ThreadView";
import { initialStreamState } from "@/lib/assistant";

// VER-03 — pins the heading-order fix: a brand-new user with zero threads sees ONLY this empty
// state (ThreadRail renders no "Pinned"/date-group `<h2>`s until at least one thread exists — see
// ThreadRail.tsx), and `CapabilityCards` renders its category titles as `<h3>` (CapabilityCards.tsx)
// — so this empty state's own "Assistant" label is the ONE thing on the page guaranteeing an `<h2>`
// exists before that `<h3>`. It was a plain `<p className="type-eyebrow">` before this fix, which
// made the page's heading levels skip straight from 1 to 3 in exactly that (very real, first-run)
// scenario. `CapabilityCards` itself is mocked out here — its own data-fetching is covered by its
// own tests; this test is only about ThreadView's heading structure.
vi.mock("./CapabilityCards", () => ({ CapabilityCards: () => <div data-testid="cap-cards-stub" /> }));

// jsdom has no layout engine, so it doesn't implement scrollIntoView at all — ThreadView's own
// autoscroll effect (unrelated to this fix) would otherwise throw on every render.
Element.prototype.scrollIntoView = vi.fn();

describe("ThreadView — empty-state heading order", () => {
  it("renders the empty-state label as a real <h2>, not a styled paragraph", () => {
    render(
      <ThreadView messages={[]} streamState={initialStreamState()} streamingMessageId={null} loading={false} />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Assistant" })).toBeInTheDocument();
  });

  it("still renders the conversation log region once messages exist (no empty-state heading then)", () => {
    render(
      <ThreadView
        messages={[{
          id: "m1", seq: 1, role: "user", content: "Hi", parts: null, provider: null, model: null,
          tokens: null, latencyMs: null, errorKind: null, createdAt: new Date().toISOString(),
        }]}
        streamState={initialStreamState()}
        streamingMessageId={null}
        loading={false}
      />,
    );
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Assistant" })).not.toBeInTheDocument();
  });
});
