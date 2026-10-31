import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-A4 (BFF §63.25.4): "Ideas for next month" on the monthly report. The writes are the demo store's (the twin DEMO_MODE serves): the actions module is replaced by one that calls `socialDemo`, so what a
// click posts is judged by the server's order of checks. The page's read is the ideas list the demo serves, so each test sees the seeded ideas (one in each state) as the server would answer them. The clock is
// pinned to Friday 16 October 2026 before the stores seed (hence vi.hoisted).
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const persona = vi.hoisted(() => ({ user: "u-social" }));
vi.mock("@/lib/socialIdeasActions", async () => {
  const { socialDemo } = await import("@/lib/demoSocial");
  const { refusalFromBody } = await import("@/lib/socialPipeline");
  const { asIdeaAnswer, asIdea, ideaRefusalText } = await import("@/lib/socialIdeas");
  const call = (method: string, tail: string, body?: unknown) =>
    socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), persona.user)!;
  const write = <T extends object>(kind: Parameters<typeof ideaRefusalText>[1], r: { status: number; json: unknown }, extra?: (j: Record<string, unknown>) => T) => {
    const j = r.json as Record<string, unknown>;
    if (r.status < 300) return { ok: true as const, ...(extra ? extra(j) : {}) };
    const refusal = refusalFromBody(r.status, String(j.error), j, typeof j.field === "string" ? j.field : undefined);
    return { ok: false as const, refusal, message: ideaRefusalText(refusal, kind) };
  };
  return {
    addIdea: vi.fn(async (eng: string, body: object, id: string) => write("add", call("POST", `engagements/${eng}/ideas`, { id, ...body }), (j) => ({ idea: asIdeaAnswer(j) }))),
    shareIdea: vi.fn(async (id: string) => write("share", call("POST", `ideas/${id}/share`, {}), (j) => ({ idea: asIdeaAnswer(j) }))),
    planIdea: vi.fn(async (id: string, cycleId: string) => write("plan", call("POST", `ideas/${id}/plan`, { cycleId }), (j) => ({ idea: asIdea((j as { idea: unknown }).idea), post: (j as { post: object }).post }))),
    deleteIdea: vi.fn(async (id: string) => write("delete", call("DELETE", `ideas/${id}`), () => ({}))),
  };
});

import { socialDemo } from "@/lib/demoSocial";
import { demoIdeaStore } from "@/lib/demoSocialIdeas";
import { PIPE_ENGAGEMENTS } from "@/lib/demoSocialPipeline";
import { asIdeaList } from "@/lib/socialIdeas";
import { asReportList } from "@/lib/socialReports";
import { addIdea, deleteIdea, planIdea, shareIdea } from "@/lib/socialIdeasActions";
import { ReportIdeas } from "./ReportIdeas";

const NORTH = PIPE_ENGAGEMENTS[0].id;
const REPORT = () => asReportList(socialDemo("GET", "/api/co-agency/modules/social/reports", new URLSearchParams(), undefined, "u-pm")!.json).find((r) => r.clientName === "Northwind Traders" && r.period === "2026-09")!.id;
const CYCLES = [{ cycleId: `soc-cyc-${NORTH}-2026-11`, month: "2026-11" }, { cycleId: `soc-cyc-${NORTH}-2026-12`, month: "2026-12" }];
const read = () => asIdeaList(socialDemo("GET", `/api/co-agency/modules/social/engagements/${NORTH}/ideas`, new URLSearchParams(), undefined, persona.user)!.json);
const mount = (over: Partial<Parameters<typeof ReportIdeas>[0]> = {}) => render(
  <ReportIdeas deptId="d-soc" engagementId={NORTH} reportId={REPORT()} ideas={read()} metricRequired cycles={CYCLES} {...over} />,
);
const press = (scope: HTMLElement | null, name: RegExp | string) => fireEvent.click(within(scope ?? document.body).getByRole("button", { name }));
const fresh = (): string => {
  const r = socialDemo("POST", `/api/co-agency/modules/social/engagements/${NORTH}/ideas`, new URLSearchParams(), JSON.stringify({ saw: `Saw ${demoIdeaStore.seq}`, metric: "Reach", suggestion: `Suggest ${demoIdeaStore.seq}`, reportId: REPORT() }), "u-social")!;
  return (r.json as { idea: { id: string } }).idea.id;
};

beforeEach(() => { vi.clearAllMocks(); persona.user = "u-social"; });

describe("the list", () => {
  it("draws each idea's three parts and its state in the design's words, with Open post on the one added to the plan", () => {
    mount();
    const list = within(screen.getByRole("list", { name: "Ideas" }));
    expect(list.getAllByText(/^(Proposed|Shared with client|Added to plan)$/).map((e) => e.textContent).sort()).toEqual(["Added to plan", "Proposed", "Shared with client"]);
    const planned = list.getByText("Added to plan").closest("li")!;
    expect(within(planned).getByRole("link", { name: /Open post \(November 2026\)/ })).toHaveAttribute("href", expect.stringMatching(/^\/departments\/d-soc\/posts\//));
    expect(within(planned).getByText("Behind-the-scenes posts earned the most saves.")).toBeInTheDocument();
    expect(within(planned).getByText("Saves")).toBeInTheDocument();
    expect(within(planned).queryByRole("button")).toBeNull(); // a planned idea cannot change
    const shared = list.getByText("Shared with client").closest("li")!;
    expect(within(shared).getByText(/Shared with the client by/)).toBeInTheDocument();
  });
  it("offers each state only its actions: proposed has all three, shared has plan and delete, planned none", () => {
    mount();
    const list = within(screen.getByRole("list", { name: "Ideas" }));
    const names = (state: string) => within(list.getByText(state).closest("li")!).queryAllByRole("button").map((b) => b.textContent);
    expect(names("Proposed")).toEqual(["Add to next plan", "Mark shared", "Delete"]);
    expect(names("Shared with client")).toEqual(["Add to next plan", "Delete"]);
    expect(names("Added to plan")).toEqual([]);
  });
  it("shows no action and no form where the read says the viewer may not write, and says who may", () => {
    persona.user = "u-social-2"; // another client's officer: reads, never writes
    mount();
    const section = screen.getByRole("region", { name: "Ideas for next month" });
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("form", { name: "Add an idea" })).toBeNull();
    expect(within(section).getByText(/Only this client's officer, the Social Media head/)).toBeInTheDocument();
    expect(within(section).getAllByRole("listitem").length).toBeGreaterThan(0); // the ideas are still read
  });
  it("says it cannot tell when the ideas could not be read, never that there are none", () => {
    mount({ ideas: { unavailable: "bad gateway" } });
    expect(screen.getByText(/could not be read just now\. bad gateway/)).toBeInTheDocument();
    expect(screen.queryByText(/No ideas for this client yet/)).toBeNull();
    expect(screen.queryByRole("form", { name: "Add an idea" })).toBeNull();
  });
  it("says a client with no ideas has none, and offers the first", () => {
    mount({ ideas: { items: [], canWrite: true } });
    expect(screen.getByText(/No ideas for this client yet\. Add the first one below\./)).toBeInTheDocument();
  });
});

describe("Add idea", () => {
  it("checks the form before the request: what we saw, the metric (required by the company) and what we suggest, each named", () => {
    mount();
    const form = screen.getByRole("form", { name: "Add an idea" });
    fireEvent.click(within(form).getByRole("button", { name: "Add idea" }));
    expect(addIdea).not.toHaveBeenCalled();
    expect(within(form).getByRole("alert")).toHaveTextContent("Write what we saw.");
    fireEvent.change(within(form).getByLabelText("What we saw"), { target: { value: "Stories drew replies" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add idea" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Name the metric this rests on.");
    expect(within(form).getByLabelText("The metric it rests on")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(within(form).getByLabelText("The metric it rests on"), { target: { value: "Reply rate" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add idea" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Write what we suggest.");
  });
  it("a metric the company makes optional may be left out", async () => {
    mount({ metricRequired: false });
    const form = screen.getByRole("form", { name: "Add an idea" });
    expect(within(form).getByText("Optional under your company's rules.")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("What we saw"), { target: { value: "Quiet Sundays" } });
    fireEvent.change(within(form).getByLabelText("What we suggest"), { target: { value: "Skip Sunday posts" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add idea" }));
    // the demo's company rule is the seed's (the metric is required): the server's own refusal is said in words, not as a code
    await waitFor(() => expect(addIdea).toHaveBeenCalledWith(NORTH, { saw: "Quiet Sundays", metric: null, suggestion: "Skip Sunday posts", reportId: REPORT() }, expect.any(String)));
    expect(await screen.findByText(/metric is required by your company's rules/)).toBeInTheDocument();
  });
  it("posts the three texts with the report's id and a fresh id, then says so, clears the form and reads the page again", async () => {
    mount();
    const form = screen.getByRole("form", { name: "Add an idea" });
    fireEvent.change(within(form).getByLabelText("What we saw"), { target: { value: "  Stories drew replies  " } });
    fireEvent.change(within(form).getByLabelText("The metric it rests on"), { target: { value: "Reply rate" } });
    fireEvent.change(within(form).getByLabelText("What we suggest"), { target: { value: "Plan two stories" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add idea" }));
    await waitFor(() => expect(addIdea).toHaveBeenCalledTimes(1));
    const [eng, body, id] = vi.mocked(addIdea).mock.calls[0];
    expect(eng).toBe(NORTH);
    expect(body).toEqual({ saw: "Stories drew replies", metric: "Reply rate", suggestion: "Plan two stories", reportId: REPORT() });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(await screen.findByText("Idea added.")).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
    expect(within(form).getByLabelText("What we saw")).toHaveValue("");
    expect(read().items.find((i) => i.saw === "Stories drew replies")).toMatchObject({ status: "proposed", reportId: REPORT() });
  });
});

describe("Mark shared and Delete", () => {
  it("Mark shared moves a proposed idea to shared", async () => {
    const id = fresh();
    mount();
    const li = screen.getByText(`Suggest ${demoIdeaStore.seq - 1}`).closest("li") ?? screen.getAllByRole("listitem").find((l) => l.textContent?.includes("Suggest"))!;
    press(li as HTMLElement, "Mark shared");
    await waitFor(() => expect(shareIdea).toHaveBeenCalledWith(id));
    expect(await screen.findByText("Marked as shared.")).toBeInTheDocument();
    expect(read().items.find((i) => i.id === id)?.status).toBe("shared");
  });
  it("Delete removes an idea that is not planned, named for the keyboard by the idea it removes", async () => {
    const id = fresh();
    mount();
    const del = screen.getByRole("button", { name: `Delete the idea: Suggest ${demoIdeaStore.seq - 1}` });
    fireEvent.click(del);
    await waitFor(() => expect(deleteIdea).toHaveBeenCalledWith(id));
    expect(await screen.findByText("Idea deleted.")).toBeInTheDocument();
    expect(read().items.some((i) => i.id === id)).toBe(false);
  });
  it("a refusal the server still gives is said in words: a planned idea (a stale page) cannot be deleted", async () => {
    const planned = read().items.find((i) => i.status === "planned")!;
    // a page read before the idea was planned still draws its buttons
    mount({ ideas: { canWrite: true, items: [{ ...planned, status: "proposed" }] } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete the idea/ }));
    expect(await screen.findByText(/already in a plan, so it cannot change/)).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled(); // and the page is read again, so what is drawn is true
    expect(screen.queryByText("Idea deleted.")).toBeNull();
  });
});

describe("Add to next plan", () => {
  it("opens a cycle picker of the coming months, and makes a planned post of the picked one", async () => {
    const id = fresh();
    mount();
    const li = screen.getAllByRole("listitem").find((l) => l.textContent?.includes(`Suggest ${demoIdeaStore.seq - 1}`))!;
    press(li, "Add to next plan");
    const group = within(li).getByRole("group", { name: "Add to next plan" });
    expect(within(group).getAllByRole("option").map((o) => o.textContent)).toEqual(["November 2026", "December 2026"]);
    fireEvent.change(within(group).getByLabelText("Plan month"), { target: { value: CYCLES[0].cycleId } });
    fireEvent.click(within(group).getByRole("button", { name: "Add to plan" }));
    await waitFor(() => expect(planIdea).toHaveBeenCalledWith(id, CYCLES[0].cycleId));
    expect(await screen.findByText("Added to the plan.")).toBeInTheDocument();
    const after = read().items.find((i) => i.id === id)!;
    expect(after).toMatchObject({ status: "planned", post: { pipelineStatus: "planned", cycleMonth: "2026-11" } });
  });
  it("says the client has no plan month to add to, rather than offering an empty picker", () => {
    mount({ cycles: [] });
    const li = screen.getAllByText("Proposed")[0].closest("li")!;
    press(li, "Add to next plan");
    expect(within(li).getByText(/no plan month set up for the coming months/)).toBeInTheDocument();
    expect(within(li).queryByRole("combobox")).toBeNull();
  });
  it("a closed cycle is refused in words, and the idea stays as it was", async () => {
    const id = fresh();
    mount({ cycles: [{ cycleId: `soc-cyc-${NORTH}-2026-09`, month: "2026-09" }] });
    const li = screen.getAllByRole("listitem").find((l) => l.textContent?.includes(`Suggest ${demoIdeaStore.seq - 1}`))!;
    press(li, "Add to next plan");
    fireEvent.click(within(li).getByRole("button", { name: "Add to plan" }));
    expect(await screen.findByText(/plan month is already over/)).toBeInTheDocument();
    expect(read().items.find((i) => i.id === id)?.status).toBe("proposed");
  });
});
