import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// One test: progress + SRM before the horizon (never a rate, difference, interval or p), the full result at it,
// the four actions only where the status allows, and every refusal as a sentence.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({ refresh }) }));
vi.mock("@/lib/webdeskContent", () => ({ listSites: vi.fn() }));
vi.mock("@/lib/experiments", () => ({ readExperimentDetail: vi.fn() }));
vi.mock("@/lib/experimentsActions", () => ({
  syncExperimentAction: vi.fn(), stopExperimentAction: vi.fn(), abortExperimentAction: vi.fn(), decideExperimentAction: vi.fn(),
}));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { listSites } from "@/lib/webdeskContent";
import { readExperimentDetail } from "@/lib/experiments";
import * as actions from "@/lib/experimentsActions";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import { parseResults, type Results } from "@/lib/experimentsModel";
import Page from "./page";

const sitesMock = vi.mocked(listSites);
const readMock = vi.mocked(readExperimentDetail);
const ctxMock = vi.mocked(requireWebsiteCtx);

const sites = () => ({ kind: "ok" as const, data: { tenants: [{ slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [{ siteId: "site-1", name: "gaiada.com", kind: "static", environments: [{ envId: "e", name: "live", domain: "gaiada.com", status: "active" }] }] }] } });
const experiment = (status: string) => ({
  id: "e1", propertyId: "p1", key: "hero", status, hypothesis: "A bigger button gets more leads.", item: { tenantSlug: "gaiada", siteId: "site-1", itemId: "i", collectionKey: "pages", locale: "en" },
  sectionId: "hero", goal: { event: "generate_lead" }, arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }], enrolment: "consented",
  preRegistration: { baselineRate: 0.03, baselineSource: "umami_28d", relativeMde: 0.2, alpha: 0.05, power: 0.8, nPerArm: 800, dailyUnits: 100, projectedDays: 16, locked: status !== "draft" },
  startedAt: "2026-10-01T00:00:00.000Z", stoppedAt: null, createdAt: "x",
});
const progress = { perArm: [{ key: "a", exposures: 120, target: 800, fraction: 0.15 }, { key: "b", exposures: "<5", target: 800, fraction: null }], elapsedDays: 3, minDays: 14, maxDays: 56, exposuresReached: false, minDaysReached: false };
const srm = (mismatch = false) => ({ evaluable: true, mismatch, message: mismatch ? "Sample ratio mismatch: the arms are not receiving visitors in the planned proportions." : "The arms are receiving visitors in the planned proportions." });
const collecting = (): Results => parseResults({ state: "ok", phase: "collecting", horizonReached: false, progress, srm: srm(), warnings: [] });
const horizon = (): Results => parseResults({
  state: "ok", phase: "horizon", horizonReached: true, progress: { ...progress, exposuresReached: true, minDaysReached: true, elapsedDays: 15 }, srm: srm(), warnings: [],
  analysis: {
    control: { key: "a", units: 900, conversions: 27, rate: 0.03 },
    comparisons: [
      { key: "b", units: 910, conversions: "<5", rate: null, difference: 0.012, ciLower: 0.004, ciUpper: 0.02, ciLevel: 0.95, method: "z", pRaw: 0.01, pAdjusted: 0.012, significantWinner: true },
    ],
    decision: { action: "ship", arm: "b" }, alpha: 0.05,
  },
});
const meWith = (role: string) => ({ roles: [{ role, scopeType: "company", scopeId: "co-1" }] });
const setup = (status: string, results: Results, role = "search_manager") => {
  ctxMock.mockResolvedValue({ userId: "u", me: meWith(role), company: "co-1", deptId: "dept-1", analyticsBase: "/departments/dept-1/website/analytics" } as never);
  readMock.mockResolvedValue({ kind: "ok", propertyId: "p1", experiment: experiment(status), results } as never);
};
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1", experimentId: "e1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); sitesMock.mockReset(); readMock.mockReset(); refresh.mockReset();
  Object.values(actions).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  sitesMock.mockResolvedValue(sites());
});

describe("experiment detail: before the horizon", () => {
  it("shows progress and SRM only: no rate, difference, interval, p or result", async () => {
    setup("running", collecting());
    await mount();
    expect(screen.getByTestId("exp-progress")).toBeTruthy();
    expect(screen.getByTestId("exp-srm").textContent).toContain("planned proportions");
    expect(within(screen.getByTestId("exp-progress")).getByText("fewer than 5")).toBeTruthy();
    expect(screen.queryByTestId("exp-analysis")).toBeNull();
    expect(screen.queryByTestId("exp-decision")).toBeNull();
    expect(screen.getByTestId("exp-hidden-note").textContent).toContain("no result is shown");
    const page = screen.getByTestId("experiment-detail").textContent!;
    expect(page).not.toMatch(/Chance this is luck|likely between|Against the control|Goals reached|Ship variant/);
  });
  it("even if the body carried an outcome, nothing of it is rendered before the horizon", async () => {
    const leaky = parseResults({
      state: "ok", phase: "collecting", horizonReached: false, progress, srm: srm(), warnings: [],
      analysis: { control: { key: "a", units: 900, conversions: 27, rate: 0.0312 }, comparisons: [{ key: "b", units: 900, conversions: 40, rate: 0.0444, difference: 0.0132, ciLower: 0.001, ciUpper: 0.025, ciLevel: 0.95, method: "z", pRaw: 0.04, pAdjusted: 0.04, significantWinner: true }], decision: { action: "ship", arm: "b" }, alpha: 0.05 },
      rate: 0.0444, difference: 0.0132, pValue: 0.04, conversions: 40,
    });
    setup("running", leaky);
    await mount();
    const text = screen.getByTestId("experiment-detail").textContent!;
    for (const needle of ["3.1%", "4.4%", "0.0444", "1.3 points", "0.04", "Ship variant", "winner", "Goals reached", "Rate"]) expect(text).not.toContain(needle);
    expect(screen.queryByTestId("exp-analysis")).toBeNull();
  });
  it("an SRM mismatch is an alert in words", async () => {
    setup("running", parseResults({ state: "ok", phase: "collecting", horizonReached: false, progress, srm: srm(true), warnings: [] }));
    await mount();
    expect(screen.getByTestId("exp-srm").getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("exp-srm").textContent).toContain("Sample ratio mismatch");
  });
  it("inconclusive at the time limit says keep the control and still shows no estimate", async () => {
    setup("running", parseResults({ state: "ok", phase: "inconclusive", horizonReached: false, progress, srm: srm(), warnings: [], decision: { action: "keep_control", reason: "inconclusive_at_max_duration" } }));
    await mount();
    expect(screen.getByTestId("exp-hidden-note").textContent).toContain("Keep the control");
    expect(screen.queryByTestId("exp-analysis")).toBeNull();
  });
});

describe("experiment detail: at the horizon and the other states", () => {
  it("shows the full result; fewer than 5 is words; a null rate is words, never 0", async () => {
    setup("stopped", horizon());
    await mount();
    const t = screen.getByTestId("exp-analysis");
    expect(within(t).getByText("3.0%")).toBeTruthy();
    expect(t.textContent).toContain("fewer than 5");
    expect(t.textContent).toContain("not shown (fewer than 5 goals)");
    expect(t.textContent).toContain("+1.2 points");
    expect(t.textContent).toContain("likely between +0.4 points and +2.0 points");
    expect(t.textContent).toContain("Chance this is luck: 1.2%");
    expect(screen.getByTestId("exp-decision").textContent).toContain("Ship variant b");
    expect(screen.queryByTestId("exp-hidden-note")).toBeNull();
  });
  it.each([
    ["unavailable", { state: "unavailable", reason: "unreachable", message: "m" }, "exp-state-unavailable", /Nothing is shown rather than zeros/],
    ["not_started", { state: "not_started", message: "The test has not started." }, "exp-state-not_started", /has not started/],
    ["aborted", { state: "aborted", message: "The test was aborted. No result is recorded." }, "exp-state-aborted", /No result is recorded/],
  ])("%s is words, never zeros and no progress table", async (_n, body, id, words) => {
    setup("running", parseResults(body));
    await mount();
    expect(screen.getByTestId(id).textContent).toMatch(words);
    expect(screen.queryByTestId("exp-progress")).toBeNull();
    expect(screen.queryByTestId("exp-analysis")).toBeNull();
  });
  it.each(["not_configured", "not_bound", "unreachable", "rejected", "truncated"])("unavailable reason %s has its own sentence", async (reason) => {
    setup("running", parseResults({ state: "unavailable", reason, message: "x" }));
    await mount();
    const s = screen.getByTestId("exp-state-unavailable").textContent!;
    expect(s).not.toContain(reason);
    expect(s).toMatch(/rather than/);
  });
});

describe("experiment detail: actions", () => {
  const shown = () => ["sync", "stop", "abort", "decide"].filter((n) => screen.queryByTestId(`exp-${n}`));
  it.each([
    ["draft", ["sync", "abort"]],
    ["running", ["stop", "abort"]],
    ["stopped", ["abort", "decide"]],
    ["aborted", []],
    ["decided", []],
  ])("%s shows %j", async (status, want) => {
    setup(status, parseResults({ state: "aborted", message: "m" }));
    await mount();
    expect(shown()).toEqual(want);
  });
  it("a refusal is shown as a plain sentence and the page is not refreshed", async () => {
    setup("running", collecting());
    vi.mocked(actions.stopExperimentAction).mockResolvedValue({ ok: false, message: "The test has not reached its planned size yet, so it cannot be stopped." });
    await mount();
    fireEvent.click(screen.getByTestId("exp-stop"));
    await waitFor(() => expect(screen.getByTestId("exp-action-msg")).toBeTruthy());
    expect(screen.getByTestId("exp-action-msg").textContent).toContain("not reached its planned size");
    expect(screen.getByTestId("exp-action-msg").getAttribute("role")).toBe("alert");
    expect(refresh).not.toHaveBeenCalled();
    expect(actions.stopExperimentAction).toHaveBeenCalledWith("p1", "e1");
  });
  it("success refreshes the page", async () => {
    setup("draft", parseResults({ state: "not_started", message: "m" }));
    vi.mocked(actions.syncExperimentAction).mockResolvedValue({ ok: true, message: "The test is live on the page. It is now running." });
    await mount();
    fireEvent.click(screen.getByTestId("exp-sync"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it("decide sends the note", async () => {
    setup("stopped", horizon());
    vi.mocked(actions.decideExperimentAction).mockResolvedValue({ ok: false, message: "The test block is still live on the page." });
    await mount();
    fireEvent.change(screen.getByLabelText("Note for the decision (optional)"), { target: { value: "ship b" } });
    fireEvent.click(screen.getByTestId("exp-decide"));
    await waitFor(() => expect(actions.decideExperimentAction).toHaveBeenCalledWith("p1", "e1", "ship b"));
  });
});

describe("experiment detail: guards", () => {
  it("404s without search view and reads nothing", async () => {
    ctxMock.mockResolvedValue({ userId: "u", me: meWith("member"), company: "co-1", deptId: "dept-1", analyticsBase: "/a" } as never);
    await expect(mount()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(readMock).not.toHaveBeenCalled();
  });
  it("asks for the Analytics tab context", async () => {
    setup("running", collecting());
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "analytics");
    expect(readMock).toHaveBeenCalledWith("u", "co-1", ["gaiada.com"], "e1");
  });
  it("a refused read is a refusal, not an empty page", async () => {
    ctxMock.mockResolvedValue({ userId: "u", me: meWith("search_manager"), company: "co-1", deptId: "dept-1", analyticsBase: "/a" } as never);
    readMock.mockResolvedValue({ kind: "not_found", slug: "experiment" } as never);
    await mount();
    expect(screen.queryByTestId("experiment-detail")).toBeNull();
  });
});
