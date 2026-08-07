import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ThreadRail } from "./ThreadRail";
import type { AssistantThread } from "@/lib/assistant";

// 2026-08-07 owner fix — the sidebar had no collapse affordance at all. This pins the three bars
// the ticket set: an accessible name + `aria-expanded` on the toggle, the toggle staying reachable
// (rendered) in BOTH states, and the search/session list genuinely unmounting (not just hidden)
// when collapsed.
function noop() {}
const threads: AssistantThread[] = [{
  id: "t1", ownerUserId: "u1", title: "Draft the Q3 update", brainProvider: null, brainModel: null,
  hermesSessionId: null, status: "active", pinned: false, lastMessageAt: "2026-08-04T09:00:00Z",
  totalTokens: 0, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
  createdAt: "2026-08-04T09:00:00Z", updatedAt: "2026-08-04T09:00:00Z",
}];

function baseProps() {
  return {
    threads, activeThreadId: null, busy: false,
    onSelect: noop, onNew: noop, onRename: noop, onTogglePin: noop, onToggleArchive: noop, onDelete: noop,
  };
}

describe("ThreadRail — collapse toggle", () => {
  it("expanded: shows the search box + session list, and the toggle announces it can collapse", () => {
    render(<ThreadRail {...baseProps()} collapsed={false} onToggleCollapsed={noop} />);
    expect(screen.getByRole("button", { name: "Collapse sessions sidebar" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Search sessions")).toBeInTheDocument();
    expect(screen.getByText("Draft the Q3 update")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New chat" })).toBeInTheDocument();
  });

  it("collapsed: the toggle stays rendered (keyboard-reachable) but the search/list/new-chat-button do not", () => {
    render(<ThreadRail {...baseProps()} collapsed onToggleCollapsed={noop} />);
    const toggle = screen.getByRole("button", { name: "Expand sessions sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Search sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Draft the Q3 update")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New chat" })).not.toBeInTheDocument();
    // A collapsed rail still needs a way to start a new chat — the compact icon button.
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  });

  it("clicking the toggle calls the handler — the caller (AssistantWorkspace) owns the actual state", () => {
    const onToggleCollapsed = vi.fn();
    render(<ThreadRail {...baseProps()} collapsed={false} onToggleCollapsed={onToggleCollapsed} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sessions sidebar" }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});
