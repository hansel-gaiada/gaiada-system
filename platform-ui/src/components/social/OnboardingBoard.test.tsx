import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5h (BFF §63.29.5): the onboarding board. The server's answer is drawn as it is: the client, officer, kickoff, progress, next step and late chip; the checklist by phase; the three
// writes (start, move the kickoff, tick) go to the server actions and a refusal is shown in words beside the control that made it, never a bare code. The button's gate is the server's
// `canStart` and the row's `startBlock`.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialOnboardingActions", () => ({ startOnboarding: vi.fn(), moveKickoff: vi.fn(), tickStep: vi.fn(), openBaselineAudit: vi.fn() }));

import { moveKickoff, openBaselineAudit, startOnboarding, tickStep } from "@/lib/socialOnboardingActions";
import { asOnboarding, onboardingRefusalText, type Onboarding } from "@/lib/socialOnboarding";
import { OnboardingBoard } from "./OnboardingBoard";

const st = (key: string, phase: string, phaseTitle: string, over: Record<string, unknown> = {}) => ({
  key, taskId: `t-${key}`, title: `Mock step ${key}`, phase, phaseTitle, role: "lead", roleLabel: "Lead", dueDate: "2026-11-10", done: false, late: false, ...over,
});
const started = (over: Record<string, unknown> = {}) => ({
  engagementId: "e1", clientId: "c1", clientName: "Mock Bakery", engagementStatus: "draft", officer: { id: "u1", name: "Mock Officer" }, projectId: "p1", applicationId: "a1", kickoff: "2026-11-02",
  progress: { done: 1, total: 3 }, next: { taskId: "t-b", title: "Mock step b", dueDate: "2026-11-03", late: true }, baselineAudit: null,
  steps: [st("a", "kickoff", "Kickoff", { done: true }), st("b", "kickoff", "Kickoff", { late: true, dueDate: "2026-11-03" }), st("c", "access", "Access", { role: "officer", roleLabel: "Officer" })],
  doneStatusId: "done", startBlock: null, ...over,
});
const fresh = (over: Record<string, unknown> = {}) => ({
  engagementId: "e2", clientId: "c2", clientName: "Mock Surf School", engagementStatus: "draft", officer: null, projectId: "p2", applicationId: null, kickoff: null, progress: { done: 0, total: 0 },
  next: null, baselineAudit: null, steps: [], doneStatusId: null, startBlock: null, ...over,
});
const data = (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Onboarding =>
  asOnboarding({ template: { id: "tpl", name: "Mock onboarding" }, canStart: true, items, ...over });
const mount = (d: Onboarding) => render(<OnboardingBoard deptId="d-soc" data={d} today="2026-11-02" />);
const card = (name: string) => screen.getByRole("article", { name: `${name} onboarding` });

beforeEach(() => { vi.clearAllMocks(); });

describe("the states", () => {
  it("says there is nobody being onboarded, in words, for an empty list", () => {
    mount(data([]));
    expect(screen.getByRole("status")).toHaveTextContent("No client is being onboarded");
  });
  it("says the company has no template, and who chooses it, when it has none", () => {
    mount(data([fresh({ startBlock: "onboarding_template_not_set" })], { template: null }));
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("has not chosen an onboarding template");
    expect(screen.getByRole("button", { name: "Start onboarding" })).toBeDisabled();
    expect(card("Mock Surf School")).toHaveTextContent("Choose one in Settings");
  });
  it("names the template when there is one", () => {
    mount(data([started()]));
    expect(screen.getByText("Mock onboarding")).toBeInTheDocument();
  });
});

describe("a client mid-onboarding", () => {
  it("shows the officer, the kickoff, the figures, the late count and the next step with its day", () => {
    mount(data([started()]));
    const c = card("Mock Bakery");
    expect(c).toHaveTextContent("Officer: Mock Officer");
    expect(c).toHaveTextContent("Kickoff 02 Nov 2026");
    expect(c).toHaveTextContent("1 of 3 steps");
    expect(within(c).getByText("1 late")).toBeInTheDocument();
    expect(c).toHaveTextContent("Next: Mock step b, due 03 Nov 2026 (late)");
    expect(within(c).getByRole("progressbar", { name: /33 percent/ })).toBeInTheDocument();
  });
  it("links the project, the allocation and, when there is one, the baseline audit with its state", () => {
    mount(data([started({ baselineAudit: { auditId: "au1", status: "final", overall: 71 } })]));
    const c = card("Mock Bakery");
    expect(within(c).getByRole("link", { name: "Open the project" })).toHaveAttribute("href", "/projects/p1");
    expect(within(c).getByRole("link", { name: "Set the allocation" })).toHaveAttribute("href", "/departments/d-soc/allocation");
    expect(within(c).getByRole("link", { name: "Baseline audit (final, 71 of 100)" })).toHaveAttribute("href", "/departments/d-soc/social-audit/au1");
    expect(within(c).queryByRole("button", { name: "Open baseline audit" })).toBeNull();
  });
  it("opens the baseline audit (creating it) when there is none, then goes to it", async () => {
    vi.mocked(openBaselineAudit).mockResolvedValue({ ok: true, auditId: "au9" });
    mount(data([started()]));
    fireEvent.click(within(card("Mock Bakery")).getByRole("button", { name: "Open baseline audit" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/departments/d-soc/social-audit/au9"));
    expect(openBaselineAudit).toHaveBeenCalledWith("e1");
  });
  it("shows a refusal of the audit in words", async () => {
    vi.mocked(openBaselineAudit).mockResolvedValue({ ok: false, error: "not authorized: x", message: onboardingRefusalText("not authorized: x", "audit") });
    mount(data([started()]));
    fireEvent.click(within(card("Mock Bakery")).getByRole("button", { name: "Open baseline audit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot do this.");
  });
  it("says every step is done, with an All done mark, when none is left", () => {
    mount(data([started({ progress: { done: 3, total: 3 }, next: null, steps: [st("a", "kickoff", "Kickoff", { done: true })] })]));
    expect(card("Mock Bakery")).toHaveTextContent("Every step is done.");
    expect(within(card("Mock Bakery")).getByText("All done")).toBeInTheDocument();
  });
});

describe("the checklist by phase", () => {
  it("opens and closes from a button that says whether it is open, and lists each phase with its counts", () => {
    mount(data([started()]));
    const toggle = within(card("Mock Bakery")).getByRole("button", { name: "Show checklist" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(within(card("Mock Bakery")).getByRole("button", { name: "Hide checklist" })).toHaveAttribute("aria-expanded", "true");
    const kick = screen.getByRole("region", { name: "Kickoff" });
    expect(kick).toHaveTextContent("Kickoff · 1 of 2");
    expect(within(kick).getByLabelText("Mark done: Mock step a")).toBeChecked();
    expect(within(kick).getByLabelText("Mark done: Mock step a")).toBeDisabled();
    expect(within(kick).getByLabelText("Mark done: Mock step b")).not.toBeChecked();
    expect(kick).toHaveTextContent("Due 03 Nov 2026 · late");
    const access = screen.getByRole("region", { name: "Access" });
    expect(access).toHaveTextContent("Officer");
    fireEvent.click(screen.getByRole("button", { name: "Hide checklist" }));
    expect(screen.queryByRole("region", { name: "Kickoff" })).toBeNull();
  });
  it("ticks a step through PM's route with the project's done status, then refreshes", async () => {
    vi.mocked(tickStep).mockResolvedValue({ ok: true });
    mount(data([started()]));
    fireEvent.click(screen.getByRole("button", { name: "Show checklist" }));
    fireEvent.click(screen.getByLabelText("Mark done: Mock step c"));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(tickStep).toHaveBeenCalledWith("t-c", "done");
  });
  it("says a refused tick in words, beside the client, and does not refresh", async () => {
    vi.mocked(tickStep).mockResolvedValue({ ok: false, error: "not authorized: cerbos denied update on pm_task", message: onboardingRefusalText("not authorized: cerbos denied update on pm_task", "tick") });
    mount(data([started()]));
    fireEvent.click(screen.getByRole("button", { name: "Show checklist" }));
    fireEvent.click(screen.getByLabelText("Mark done: Mock step c"));
    expect(await screen.findByRole("alert")).toHaveTextContent("You cannot change this step.");
    expect(nav.refresh).not.toHaveBeenCalled();
  });
  it("cannot be ticked when the project's done status is unknown", () => {
    mount(data([started({ doneStatusId: null })]));
    fireEvent.click(screen.getByRole("button", { name: "Show checklist" }));
    expect(screen.getByLabelText("Mark done: Mock step c")).toBeDisabled();
  });
});

describe("starting onboarding", () => {
  it("opens a form with today as the kickoff, starts with a fresh id and that day, refreshes and closes", async () => {
    vi.mocked(startOnboarding).mockResolvedValue({ ok: true, started: { applicationId: "a9", taskCount: 15 } });
    mount(data([fresh()]));
    fireEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
    const form = screen.getByRole("form", { name: "Start onboarding for Mock Surf School" });
    const day = within(form).getByLabelText("Kickoff day") as HTMLInputElement;
    expect(day.value).toBe("2026-11-02");
    fireEvent.change(day, { target: { value: "2026-11-09" } });
    fireEvent.click(within(form).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    const [eng, id, kickoff] = vi.mocked(startOnboarding).mock.calls[0];
    expect([eng, kickoff]).toEqual(["e2", "2026-11-09"]);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(screen.queryByRole("form", { name: /Start onboarding for/ })).toBeNull();
  });
  it("sends the same id on a retry of the same dialog, and a new one for a new dialog", async () => {
    vi.mocked(startOnboarding).mockResolvedValue({ ok: false, error: "no_project", message: onboardingRefusalText("no_project", "start") });
    mount(data([fresh()]));
    fireEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByRole("alert");
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(startOnboarding).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startOnboarding).mock.calls[0][1]).toBe(vi.mocked(startOnboarding).mock.calls[1][1]);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start onboarding" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(startOnboarding).toHaveBeenCalledTimes(3));
    expect(vi.mocked(startOnboarding).mock.calls[2][1]).not.toBe(vi.mocked(startOnboarding).mock.calls[0][1]);
  });
  it("says a refusal in words, not as a code", async () => {
    vi.mocked(startOnboarding).mockResolvedValue({ ok: false, error: "not authorized: cerbos denied manage on pm_project", message: onboardingRefusalText("not authorized: cerbos denied manage on pm_project", "start") });
    mount(data([fresh()]));
    fireEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("also needs the right to manage this client's project");
    expect(alert).not.toHaveTextContent("cerbos");
    expect(nav.refresh).not.toHaveBeenCalled();
  });
  it("is disabled with the reason beside it for a person who may not start, a client with no project and a company with no template", () => {
    mount(data([fresh(), fresh({ engagementId: "e3", clientName: "Mock Florist", projectId: null, startBlock: "no_project" })], { canStart: false }));
    const buttons = screen.getAllByRole("button", { name: "Start onboarding" });
    for (const b of buttons) expect(b).toBeDisabled();
    expect(card("Mock Surf School")).toHaveTextContent("Only the Social Media head, the GM, the owner and the superadmin can start onboarding.");
  });
  it("a client with no project says so even to the four, and links no project", () => {
    mount(data([fresh({ projectId: null, startBlock: "no_project" })]));
    const c = card("Mock Surf School");
    expect(c).toHaveTextContent("no ERP project yet");
    expect(within(c).getByRole("button", { name: "Start onboarding" })).toBeDisabled();
    expect(within(c).queryByRole("link", { name: "Open the project" })).toBeNull();
    expect(within(c).getByRole("button", { name: "Start onboarding" })).toHaveAccessibleDescription(/no ERP project yet/);
  });
});

describe("moving the kickoff", () => {
  it("opens a form with the current kickoff, moves it through PM's route and refreshes", async () => {
    vi.mocked(moveKickoff).mockResolvedValue({ ok: true });
    mount(data([started()]));
    fireEvent.click(screen.getByRole("button", { name: "Move kickoff" }));
    const form = screen.getByRole("form", { name: "Move the kickoff for Mock Bakery" });
    const day = within(form).getByLabelText("Kickoff day") as HTMLInputElement;
    expect(day.value).toBe("2026-11-02");
    expect(form).toHaveTextContent("Done steps stay where they are");
    fireEvent.change(day, { target: { value: "2026-11-09" } });
    fireEvent.click(within(form).getByRole("button", { name: "Move kickoff" }));
    await waitFor(() => expect(moveKickoff).toHaveBeenCalledWith("a1", "2026-11-09"));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
  it("says a refusal in words", async () => {
    vi.mocked(moveKickoff).mockResolvedValue({ ok: false, error: "not authorized: x", message: onboardingRefusalText("not authorized: x", "move") });
    mount(data([started()]));
    fireEvent.click(screen.getByRole("button", { name: "Move kickoff" }));
    fireEvent.click(within(screen.getByRole("form", { name: /Move the kickoff/ })).getByRole("button", { name: "Move kickoff" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Moving the kickoff needs the right to manage this client's project.");
  });
});

describe("keyboard and phone width", () => {
  it("every control is a real button, link, checkbox or input, so Tab and Enter reach it, and the date field is labelled", () => {
    mount(data([started(), fresh()]));
    for (const b of screen.getAllByRole("button")) expect(b.tagName).toBe("BUTTON");
    fireEvent.click(screen.getByRole("button", { name: "Start onboarding" }));
    expect(screen.getByLabelText("Kickoff day")).toHaveAttribute("type", "date");
  });
});
