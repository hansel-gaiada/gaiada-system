import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AssistantWorkspace } from "./AssistantWorkspace";
import type { AssistantThread } from "@/lib/assistant";
import type { AssistantOrigin } from "@/lib/assistantOrigin";
import * as actions from "@/lib/assistantActions";
import { replaceLocation } from "./navigate";

// DW-2h — the workspace as a whole: one Details panel, the department chip and prompts, the server-search
// fallback, and drawer <-> full page staying on one thread. The three panels load their own data and are
// stubbed; everything else is the real tree.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock("@/lib/prefsActions", () => ({ setAssistantRailCollapsedAction: vi.fn() }));
vi.mock("./navigate", () => ({ replaceLocation: vi.fn() }));
vi.mock("./MemoryPanel", () => ({ MemoryPanel: () => <div data-testid="memory-body" /> }));
vi.mock("./RosterPanel", () => ({ RosterPanel: () => <div data-testid="roster-body" /> }));
vi.mock("./CapabilitiesPanel", () => ({ CapabilitiesPanel: () => <div data-testid="capabilities-body" /> }));
vi.mock("@/lib/assistantActions", () => ({
  refreshThreadsAction: vi.fn(), refreshThreadAction: vi.fn(), createThreadAction: vi.fn(),
  renameThreadAction: vi.fn(), setThreadPinnedAction: vi.fn(), setThreadStatusAction: vi.fn(),
  setThreadBrainAction: vi.fn(), deleteThreadAction: vi.fn(), sendMessageAction: vi.fn(), stopStreamAction: vi.fn(),
  refreshCapabilitiesAction: vi.fn(), resolveCitationAction: vi.fn(),
  confirmWriteAction: vi.fn(), dismissWriteAction: vi.fn(),
}));

Element.prototype.scrollIntoView = vi.fn();

function thread(id: string, title: string, extra: Partial<AssistantThread> = {}): AssistantThread {
  return {
    id, ownerUserId: "u1", title, brainProvider: null, brainModel: null, hermesSessionId: null, status: "active",
    pinned: false, lastMessageAt: "2026-10-13T09:00:00Z", totalTokens: 0, totalCostUsd: "0.00",
    compactionSummary: null, compactionSummaryUptoSeq: null, createdAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T09:00:00Z",
    ...extra,
  };
}

const T1 = thread("t1", "Draft the Q3 update");
const T2 = thread("t2", "Plan the launch");
const OLD = thread("old-1", "Brief for the 2025 campaign", { lastMessageAt: "2025-01-02T09:00:00Z" });
const BY_ID: Record<string, AssistantThread> = { t1: T1, t2: T2, "old-1": OLD };

const WEB_DEV: AssistantOrigin = {
  path: "/departments/d-web/board",
  department: "Web Dev",
  page: "Board",
  prompts: [
    { label: "Summarise this week's requests", prompt: "Summarise this week's requests to the Web Dev team." },
    { label: "What is blocked on the board?", prompt: "Which tasks are blocked?" },
    { label: "Draft a client update", prompt: "Draft a short update for the client about " },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(actions.refreshThreadAction).mockImplementation(async (id: string) => ({
    ok: true, thread: BY_ID[id], messages: [], hasMoreMessages: false,
  }));
  vi.mocked(actions.refreshThreadsAction).mockResolvedValue({ ok: true, items: [], total: 0 });
  vi.mocked(actions.createThreadAction).mockResolvedValue({ ok: true, id: "t-new" });
  vi.mocked(actions.refreshCapabilitiesAction).mockResolvedValue({ ok: true, tools: [], hubConfigured: true, toolAgents: [] });
});

function renderPage(props: Partial<ComponentProps<typeof AssistantWorkspace>> = {}) {
  return render(<AssistantWorkspace initialThreads={[T1, T2]} initialActiveThreadId="t1" {...props} />);
}

describe("the Details panel", () => {
  it("is closed by default: one Details control, no tabs, and the old separate controls are gone", async () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Assistant details" })).not.toBeInTheDocument();
    for (const old of ["Memory", "Agents", "Capabilities"]) {
      expect(screen.queryByRole("button", { name: old })).not.toBeInTheDocument();
    }
    await waitFor(() => expect(actions.refreshThreadAction).toHaveBeenCalledWith("t1"));
  });

  it("opens one panel with three tabs from the one control, and closes it again, returning focus to the control", async () => {
    renderPage();
    const toggle = screen.getByRole("button", { name: "Details" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Memory", "Roster", "Capabilities"]);
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("memory-body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Roster" }));
    expect(screen.getByTestId("roster-body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    // Reopening remembers the tab the person was on.
    fireEvent.click(toggle);
    expect(screen.getByRole("tab", { name: "Roster" })).toHaveAttribute("aria-selected", "true");
  });

  it("'See everything I can do' in the empty state opens Details on the Capabilities tab", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "See everything I can do" }));
    expect(screen.getByRole("tab", { name: "Capabilities" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("capabilities-body")).toBeInTheDocument();
  });

  it("the panel adds a layout class only while it is open, so the conversation has the full width otherwise", () => {
    const { container } = renderPage();
    const root = container.querySelector(".asst-workspace")!;
    expect(root).not.toHaveClass("asst-workspace--with-details");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(root).toHaveClass("asst-workspace--with-details");
  });
});

describe("where you are: the department chip and its prompts", () => {
  it("shows the department and page the person came from, and that department's prompts", async () => {
    renderPage({ origin: WEB_DEV });
    expect(screen.getByText("Web Dev · Board")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Summarise this week's requests" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask about your projects" })).not.toBeInTheDocument();
  });

  it("a department prompt only pre-fills the composer: nothing is sent", async () => {
    renderPage({ origin: WEB_DEV });
    fireEvent.click(await screen.findByRole("button", { name: "Draft a client update" }));
    await waitFor(() => expect(screen.getByLabelText("Message the assistant")).toHaveValue("Draft a short update for the client about "));
    expect(actions.sendMessageAction).not.toHaveBeenCalled();
  });

  it("with no origin there is no department and today's suggestions show", async () => {
    renderPage({ origin: null });
    expect(await screen.findByRole("button", { name: "Ask about your projects" })).toBeInTheDocument();
    expect(screen.queryByText("Opened from")).not.toBeInTheDocument();
  });

  it("an origin that belongs to no department keeps today's suggestions and shows no department", async () => {
    renderPage({ origin: { path: "/projects/p-web-1", department: null, page: null, prompts: null } });
    expect(await screen.findByRole("button", { name: "Ask about your projects" })).toBeInTheDocument();
    expect(screen.queryByText("Opened from")).not.toBeInTheDocument();
  });
});

describe("finding an older thread", () => {
  it("a title the loaded list lacks is searched on the server, and the found thread opens like any other", async () => {
    vi.mocked(actions.refreshThreadsAction).mockResolvedValue({ ok: true, items: [OLD], total: 1 });
    const { container } = renderPage();
    fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "campaign" } });
    const found = await screen.findByRole("button", { name: "Brief for the 2025 campaign" }, { timeout: 3000 });
    expect(actions.refreshThreadsAction).toHaveBeenCalledWith({ q: "campaign" });
    fireEvent.click(found);
    await waitFor(() => expect(actions.refreshThreadAction).toHaveBeenCalledWith("old-1"));
    // Opening it adds it to the loaded list: the brain picker only renders for a thread the list holds.
    await waitFor(() => expect(container.querySelector(".asst-brain-picker")).not.toBeNull());
  });
});

describe("drawer and full page are one conversation", () => {
  it("the drawer's 'Open in full page' carries the SAME thread and the way back", async () => {
    renderPage({ variant: "drawer", origin: WEB_DEV });
    const link = await screen.findByRole("link", { name: /Open in full page/ });
    expect(link).toHaveAttribute("href", `/assistant?thread=t1&from=${encodeURIComponent("/departments/d-web/board")}`);
  });

  it("follows the thread the drawer created: the link carries that id", async () => {
    renderPage({ variant: "drawer", initialActiveThreadId: null, initialThreads: [] });
    const link = await screen.findByRole("link", { name: /Open in full page/ });
    expect(actions.createThreadAction).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute("href", "/assistant?thread=t-new");
  });

  it("without an origin the link is today's", async () => {
    renderPage({ variant: "drawer", origin: null });
    expect(await screen.findByRole("link", { name: /Open in full page/ })).toHaveAttribute("href", "/assistant?thread=t1");
  });

  it("a plain click REPLACES the drawer's history entry (so Back returns to the page the person came from)", async () => {
    renderPage({ variant: "drawer", origin: WEB_DEV });
    const link = await screen.findByRole("link", { name: /Open in full page/ });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // default prevented: the replace is the navigation
    expect(replaceLocation).toHaveBeenCalledWith(`/assistant?thread=t1&from=${encodeURIComponent("/departments/d-web/board")}`);
  });

  it("a modified click (open in a new tab) is left to the browser", async () => {
    renderPage({ variant: "drawer", origin: WEB_DEV });
    const link = await screen.findByRole("link", { name: /Open in full page/ });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it("the full page opens on the requested thread and loads its history, not the most recent one", async () => {
    renderPage({ initialActiveThreadId: "t2" });
    await waitFor(() => expect(actions.refreshThreadAction).toHaveBeenCalledWith("t2"));
    expect(actions.refreshThreadAction).not.toHaveBeenCalledWith("t1");
    expect(screen.getByRole("button", { name: "Plan the launch" })).toHaveAttribute("aria-current", "true");
  });

  it("the drawer opened on a thread reuses it instead of creating a new one", async () => {
    renderPage({ variant: "drawer", initialActiveThreadId: "t2" });
    await waitFor(() => expect(actions.refreshThreadAction).toHaveBeenCalledWith("t2"));
    expect(actions.createThreadAction).not.toHaveBeenCalled();
  });
});
