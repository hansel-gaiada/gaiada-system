import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RosterPanel } from "./RosterPanel";
import type { AssistantHandoff, RosterAgent } from "@/lib/assistant";

// AIP-14 — the Roster tab lists the current department's agents (and the general ones) first, the rest under a collapsed
// "Other agents". The actions are the only outside world: a stub roster stands in for the runner's registry.
const agent = (name: string, departments: string[]): RosterAgent => ({
  name, tools: [`${name}.tool`], maxSteps: 4, maxToolCalls: 2, writeCapable: false, evaledProviders: [], departments,
});
const AGENTS = [agent("general-agent", []), agent("social-agent", ["social-media"]), agent("finance-agent", ["finance"])];

const refreshRosterAction = vi.fn();
const cancelHandoffAction = vi.fn();
const refreshHandoffsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/assistantActions", () => ({
  refreshRosterAction: (...a: unknown[]) => refreshRosterAction(...a),
  refreshHandoffsAction: (...a: unknown[]) => refreshHandoffsMock(...a),
  createHandoffAction: vi.fn(),
  getHandoffTranscriptAction: vi.fn(),
  cancelHandoffAction: (...a: unknown[]) => cancelHandoffAction(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  refreshRosterAction.mockResolvedValue({ ok: true, agents: AGENTS, supervisor: { name: "supervisor" }, runnerConfigured: true, episodicHistory: [] });
  refreshHandoffsMock.mockResolvedValue({ ok: true, items: [] });
  cancelHandoffAction.mockResolvedValue({ ok: true });
});

const registry = () => screen.getByRole("region", { name: "Registry" });

describe("RosterPanel department filter", () => {
  it("with no department the registry is exactly as before: every agent, no Other agents disclosure", async () => {
    render(<RosterPanel activeThreadId="t1" />);
    await screen.findByText("general-agent", { selector: "p" });
    const names = within(registry()).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
    expect(names).toEqual(["general-agent", "social-agent", "finance-agent", expect.stringContaining("supervisor")]);
    expect(screen.queryByText(/Other agents/)).not.toBeInTheDocument();
  });

  it("with a department it lists that department's and the general agents, and the rest under a collapsed Other agents", async () => {
    const { container } = render(<RosterPanel activeThreadId="t1" workspaceKey="social-media" />);
    await screen.findByText("social-agent", { selector: "p" });
    const details = container.querySelector("details.asst-roster__other") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false); // collapsed by default
    expect(within(details).getByText("Other agents (1)")).toBeInTheDocument();
    // The visible list: department + general (+ supervisor), not the finance agent.
    const topList = registry().querySelector(":scope > ul") as HTMLElement;
    expect(within(topList).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent)).toEqual(["general-agent", "social-agent", expect.stringContaining("supervisor")]);
    expect(within(topList).queryByText("finance-agent")).not.toBeInTheDocument();
    // Nothing is hidden for good: the finance agent is in the disclosure, and the hand-off picker still offers it.
    expect(within(details).getByText("finance-agent")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Specialist")).getAllByRole("option").map((o) => o.textContent)).toEqual(["general-agent", "social-agent", "finance-agent"]);
  });

  it("opens the Other agents disclosure on activation", async () => {
    const { container } = render(<RosterPanel activeThreadId="t1" workspaceKey="finance" />);
    await screen.findByText("finance-agent", { selector: "p" });
    const details = container.querySelector("details.asst-roster__other") as HTMLDetailsElement;
    fireEvent.click(within(details).getByText("Other agents (1)"));
    await waitFor(() => expect(details.open).toBe(true));
    expect(within(details).getByText("social-agent")).toBeVisible();
  });

  it("a department every agent is shown in has no Other agents disclosure", async () => {
    refreshRosterAction.mockResolvedValue({ ok: true, agents: [agent("g1", []), agent("g2", ["hr"])], supervisor: null, runnerConfigured: true, episodicHistory: [] });
    const { container } = render(<RosterPanel activeThreadId="t1" workspaceKey="hr" />);
    await screen.findByText("g2", { selector: "p" });
    expect(container.querySelector("details.asst-roster__other")).toBeNull();
  });
});

// AIP-18 (BFF §66.11) — a hand-off HELD over budget: "Waiting: over budget", why, that it starts by itself, and a Cancel that calls the cancel route.
describe("RosterPanel: held hand-offs", () => {
  const handoff = (over: Partial<AssistantHandoff> = {}): AssistantHandoff => ({
    id: "h1", threadId: "t1", ownerUserId: "u1", agent: "general-agent", goalText: "Write the weekly report", goalId: null, runId: null, status: "held",
    outcome: null, errorKind: null, approvalId: null, createdAt: "2026-10-30T09:00:00Z", updatedAt: "2026-10-30T09:00:00Z",
    holdKind: "allowance", holdUnitNodeId: null, heldAt: "2026-10-30T09:00:00Z", ...over,
  });
  const handoffs = () => screen.getByRole("region", { name: "This thread's handoffs" });

  it("labels a held hand-off 'Waiting: over budget' and says it starts by itself, by the kind of hold", async () => {
    refreshHandoffsMock.mockResolvedValue({ ok: true, items: [handoff(), handoff({ id: "h2", holdKind: "department", holdUnitNodeId: "d-web" })] });
    render(<RosterPanel activeThreadId="t1" />);
    await screen.findAllByText("Waiting: over budget");
    expect(within(handoffs()).getAllByText("Waiting: over budget")).toHaveLength(2);
    expect(within(handoffs()).getByText(/daily AI allowance is used up. It starts by itself when the allowance resets/)).toBeInTheDocument();
    expect(within(handoffs()).getByText(/department's AI budget is used up. It starts by itself when the stop ends/)).toBeInTheDocument();
  });
  it("cancels a held hand-off through the cancel route and refreshes the list", async () => {
    refreshHandoffsMock.mockResolvedValue({ ok: true, items: [handoff()] });
    render(<RosterPanel activeThreadId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(cancelHandoffAction).toHaveBeenCalledWith("t1", "h1"));
    await waitFor(() => expect(refreshHandoffsMock.mock.calls.length).toBeGreaterThan(1));
  });
  it("says why when the hand-off had already started (409), and still refreshes", async () => {
    refreshHandoffsMock.mockResolvedValue({ ok: true, items: [handoff()] });
    cancelHandoffAction.mockResolvedValue({ ok: false, status: 409, error: "This hand-off is not waiting any more: it has already started or ended." });
    render(<RosterPanel activeThreadId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not waiting any more");
  });
  it("offers Cancel only on a held row, never on a queued, running or finished one", async () => {
    refreshHandoffsMock.mockResolvedValue({
      ok: true,
      items: [handoff({ id: "q", status: "queued", goalId: "g1", holdKind: null }), handoff({ id: "r", status: "running", goalId: "g2", holdKind: null }), handoff({ id: "o", status: "ok", goalId: "g3", holdKind: "allowance" })],
    });
    render(<RosterPanel activeThreadId="t1" />);
    await screen.findByText("Queued");
    expect(within(handoffs()).queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
    expect(within(handoffs()).queryByText("Waiting: over budget")).not.toBeInTheDocument();
    expect(within(handoffs()).queryByText(/starts by itself/)).not.toBeInTheDocument();
  });
  it("keeps showing a hand-off that is held with no hold fields (an older server), with the plain note", async () => {
    const { holdKind: _k, holdUnitNodeId: _u, heldAt: _h, ...bare } = handoff();
    refreshHandoffsMock.mockResolvedValue({ ok: true, items: [bare as AssistantHandoff] });
    render(<RosterPanel activeThreadId="t1" />);
    await screen.findByText("Waiting: over budget");
    expect(within(handoffs()).getByText("It starts by itself when the stop ends.")).toBeInTheDocument();
  });
});
