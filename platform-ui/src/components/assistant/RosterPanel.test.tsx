import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RosterPanel } from "./RosterPanel";
import type { RosterAgent } from "@/lib/assistant";

// AIP-14 — the Roster tab lists the current department's agents (and the general ones) first, the rest under a collapsed
// "Other agents". The actions are the only outside world: a stub roster stands in for the runner's registry.
const agent = (name: string, departments: string[]): RosterAgent => ({
  name, tools: [`${name}.tool`], maxSteps: 4, maxToolCalls: 2, writeCapable: false, evaledProviders: [], departments,
});
const AGENTS = [agent("general-agent", []), agent("social-agent", ["social-media"]), agent("finance-agent", ["finance"])];

const refreshRosterAction = vi.fn();
vi.mock("@/lib/assistantActions", () => ({
  refreshRosterAction: (...a: unknown[]) => refreshRosterAction(...a),
  refreshHandoffsAction: vi.fn(async () => ({ ok: true, items: [] })),
  createHandoffAction: vi.fn(),
  getHandoffTranscriptAction: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  refreshRosterAction.mockResolvedValue({ ok: true, agents: AGENTS, supervisor: { name: "supervisor" }, runnerConfigured: true, episodicHistory: [] });
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
