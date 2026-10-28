import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ThreadRail, SERVER_SEARCH_DEBOUNCE_MS } from "./ThreadRail";
import type { AssistantThread } from "@/lib/assistant";

// 2026-08-07 owner fix — the sidebar had no collapse affordance at all. This pins the three bars
// the ticket set: an accessible name + `aria-expanded` on the toggle, the toggle staying reachable
// (rendered) in BOTH states, and the search/session list genuinely unmounting (not just hidden)
// when collapsed.
function noop() {}
const threads: AssistantThread[] = [{
  id: "t1", ownerUserId: "u1", title: "Draft the Q3 update", brainProvider: null, brainTier: null, brainModel: null,
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

// DW-2h — the rail finds a thread the loaded list does not hold by asking the server's own list (`q`).
function thread(id: string, title: string, extra: Partial<AssistantThread> = {}): AssistantThread {
  return { ...threads[0], id, title, ...extra };
}

describe("ThreadRail — server search fallback (DW-2h)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const type = (value: string) => fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value } });
  const pause = () => act(async () => { await vi.advanceTimersByTimeAsync(SERVER_SEARCH_DEBOUNCE_MS); });

  it("does not ask the server while the loaded list has a title match", async () => {
    const searchServer = vi.fn().mockResolvedValue([]);
    render(<ThreadRail {...baseProps()} searchServer={searchServer} />);
    type("q3");
    await pause();
    expect(screen.getByText("Draft the Q3 update")).toBeInTheDocument();
    expect(searchServer).not.toHaveBeenCalled();
  });

  it("on a miss, asks the server with q once typing pauses, and shows what it finds", async () => {
    const searchServer = vi.fn().mockResolvedValue([thread("old-1", "Brief for the 2025 campaign", { lastMessageAt: "2025-01-02T09:00:00Z" })]);
    render(<ThreadRail {...baseProps()} searchServer={searchServer} />);
    type("campaign");
    expect(searchServer).not.toHaveBeenCalled(); // debounced
    expect(screen.getByRole("status")).toHaveTextContent("Searching older sessions");
    await pause();
    expect(searchServer).toHaveBeenCalledTimes(1);
    expect(searchServer).toHaveBeenCalledWith("campaign");
    expect(screen.getByText("Brief for the 2025 campaign")).toBeInTheDocument();
    expect(screen.queryByText("No sessions match your search.")).not.toBeInTheDocument();
  });

  it("debounces: typing on within the pause makes one request, for the final text", async () => {
    const searchServer = vi.fn().mockResolvedValue([]);
    render(<ThreadRail {...baseProps()} searchServer={searchServer} />);
    type("c");
    await act(async () => { await vi.advanceTimersByTimeAsync(SERVER_SEARCH_DEBOUNCE_MS - 50); });
    type("camp");
    await pause();
    expect(searchServer).toHaveBeenCalledTimes(1);
    expect(searchServer).toHaveBeenCalledWith("camp");
  });

  it("says so when neither the list nor the server has a match", async () => {
    render(<ThreadRail {...baseProps()} searchServer={vi.fn().mockResolvedValue([])} />);
    type("zzz");
    await pause();
    expect(screen.getByText("No sessions match your search.")).toBeInTheDocument();
  });

  it("never shows a stale answer: an older query's slow response is dropped, whatever order they resolve in", async () => {
    let resolveA!: (v: AssistantThread[]) => void;
    let resolveB!: (v: AssistantThread[]) => void;
    const searchServer = vi.fn()
      .mockImplementationOnce(() => new Promise<AssistantThread[]>((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise<AssistantThread[]>((r) => { resolveB = r; }));
    render(<ThreadRail {...baseProps()} searchServer={searchServer} />);
    type("alpha");
    await pause();
    type("alphabet");
    await pause();
    expect(searchServer).toHaveBeenCalledTimes(2);
    // The newer answer arrives first, then the older one: only the newer shows.
    await act(async () => { resolveB([thread("b", "Alphabet soup notes")]); });
    await act(async () => { resolveA([thread("a", "Alpha stale result")]); });
    expect(screen.getByText("Alphabet soup notes")).toBeInTheDocument();
    expect(screen.queryByText("Alpha stale result")).not.toBeInTheDocument();
  });

  it("an older response that lands while the newer one is still pending is not shown either", async () => {
    let resolveA!: (v: AssistantThread[]) => void;
    const searchServer = vi.fn()
      .mockImplementationOnce(() => new Promise<AssistantThread[]>((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise<AssistantThread[]>(() => {}));
    render(<ThreadRail {...baseProps()} searchServer={searchServer} />);
    type("alpha");
    await pause();
    type("alphabet");
    await pause();
    await act(async () => { resolveA([thread("a", "Alpha stale result")]); });
    expect(screen.queryByText("Alpha stale result")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Searching older sessions");
  });

  it("clearing the box drops the server results and shows the loaded list again", async () => {
    const searchServer = vi.fn().mockResolvedValue([thread("old-1", "Brief for the 2025 campaign")]);
    render(<ThreadRail {...baseProps()} searchServer={searchServer} />);
    type("campaign");
    await pause();
    expect(screen.getByText("Brief for the 2025 campaign")).toBeInTheDocument();
    type("");
    expect(screen.queryByText("Brief for the 2025 campaign")).not.toBeInTheDocument();
    expect(screen.getByText("Draft the Q3 update")).toBeInTheDocument();
  });

  it("without a server search the rail only filters what is loaded", async () => {
    render(<ThreadRail {...baseProps()} />);
    type("campaign");
    await pause();
    expect(screen.getByText("No sessions match your search.")).toBeInTheDocument();
  });

  it("a row the server found can be selected and pinned like any other", async () => {
    const onSelect = vi.fn();
    const onTogglePin = vi.fn();
    render(<ThreadRail {...baseProps()} onSelect={onSelect} onTogglePin={onTogglePin} searchServer={vi.fn().mockResolvedValue([thread("old-1", "Brief for the 2025 campaign")])} />);
    type("campaign");
    await pause();
    fireEvent.click(screen.getByRole("button", { name: "Brief for the 2025 campaign" }));
    expect(onSelect).toHaveBeenCalledWith("old-1");
    fireEvent.click(screen.getByRole("button", { name: 'Pin "Brief for the 2025 campaign"' }));
    expect(onTogglePin).toHaveBeenCalledWith("old-1", true);
    // The caller's list does not hold this row, so the rail mirrors the change itself.
    expect(screen.getByRole("button", { name: 'Unpin "Brief for the 2025 campaign"' })).toBeInTheDocument();
  });
});

describe("ThreadRail — pin on a row (DW-2h)", () => {
  it("every row leads with a pin button; pinning calls the handler with the new state", () => {
    const onTogglePin = vi.fn();
    render(<ThreadRail {...baseProps()} onTogglePin={onTogglePin} />);
    const pin = screen.getByRole("button", { name: 'Pin "Draft the Q3 update"' });
    expect(pin).toHaveAttribute("title", "Pin");
    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledWith("t1", true);
  });

  it("a pinned thread shows its state (Unpin label, filled star, accent modifier) under Pinned", () => {
    const onTogglePin = vi.fn();
    render(<ThreadRail {...baseProps()} threads={[{ ...threads[0], pinned: true }]} onTogglePin={onTogglePin} />);
    expect(screen.getByRole("region", { name: "Pinned sessions" })).toBeInTheDocument();
    const unpin = screen.getByRole("button", { name: 'Unpin "Draft the Q3 update"' });
    expect(unpin).toHaveClass("asst-rail__pin--on");
    expect(unpin).toHaveTextContent("★");
    fireEvent.click(unpin);
    expect(onTogglePin).toHaveBeenCalledWith("t1", false);
  });

  it("the pin is the first control of its row in the Tab order, ahead of the title", () => {
    render(<ThreadRail {...baseProps()} />);
    const row = screen.getByText("Draft the Q3 update").closest("li")!;
    const buttons = Array.from(row.querySelectorAll("button"));
    expect(buttons[0]).toHaveAccessibleName('Pin "Draft the Q3 update"');
  });
});
