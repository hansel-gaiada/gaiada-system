import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-5a (BFF §63.18, §63.17): one monthly report. Server page: the readers are mocked, the element tree is rendered. A report that does not exist is a 404, a refused read is "no access", a
// failed one is "cannot tell", and the buttons follow the server's `canApprove` and `canDeliver`. A Sent report points at the client's Reports tab.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartmentNode: vi.fn() }));
vi.mock("@/lib/socialReports-data", () => ({ getSocialReport: vi.fn(), getSocialReports: vi.fn(), getReportRules: vi.fn() }));
vi.mock("@/lib/socialIdeas-data", () => ({ getIdeas: vi.fn() }));
vi.mock("@/lib/socialCycles-data", () => ({ getCycleTable: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn() }));
vi.mock("@/lib/socialReportsActions", () => ({
  draftReport: vi.fn(), saveReport: vi.fn(), submitReport: vi.fn(), sendBackReport: vi.fn(), proposeReportDraft: vi.fn(), approveReport: vi.fn(), deliverReport: vi.fn(),
}));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartmentNode } from "@/lib/departments";
import { getReportRules, getSocialReport, getSocialReports } from "@/lib/socialReports-data";
import { getIdeas } from "@/lib/socialIdeas-data";
import { getCycleTable } from "@/lib/socialCycles-data";
import { asReportRules } from "@/lib/socialReportKinds";
import defaults from "@/lib/socialRulesDefaults.json";
import { getAllocation } from "@/lib/socialAllocation-data";
import { asReportDetail, asReportList, CHECK_SEND_REASON, type SocialReportDetail } from "@/lib/socialReports";
import SocialReportPage from "./page";

const note = { insight: "An insight.", suggestion: "A suggestion." };
const detail = (over: Record<string, unknown> = {}): SocialReportDetail => asReportDetail({
  id: "r1", status: "in_review", engagementId: "e1", kind: "monthly", period: "2026-09", notes: { followers: note, engagement: note, audience: note }, actionPlan: [{ action: "Plan two reels.", owner: "agency", due: "2026-10-30" }],
  simulated: false, notesComplete: true, canApprove: true, canDeliver: true,
  document: {
    header: { tenantId: "co-a", grain: "company", scopeRef: "e1", scopeName: "Northwind Traders", periodKind: "month", periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30, periodLabel: "September 2026", generatedAt: "2026-10-05T00:00:00Z", sealed: false },
    kpis: [{ metricKey: "reach_month", label: "Reach", unit: "count", value: 12000, appraisalSafe: false }], series: [], distributions: [], tables: [], highlights: [], narrative: { source: "deterministic", text: "A good month." },
  },
  ...over,
});
const ok = (data: SocialReportDetail | null) => ({ kind: "ok" as const, data });
const mount = async (reportId = "r1", deptId = "d-soc") => render(await SocialReportPage({ params: Promise.resolve({ deptId, reportId }) }));

beforeEach(() => {
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartmentNode).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getSocialReport).mockReset().mockResolvedValue(ok(detail()));
  vi.mocked(getAllocation).mockReset().mockResolvedValue({ kind: "ok", data: [{ engagementId: "e1", clientId: "cl-1", clientName: "Northwind Traders" }] as never });
  vi.mocked(getReportRules).mockReset().mockResolvedValue({ kind: "ok", data: asReportRules({ rules: defaults }) });
  vi.mocked(getSocialReports).mockReset().mockResolvedValue({ kind: "ok", data: [] });
  vi.mocked(getIdeas).mockReset().mockResolvedValue({ kind: "ok", data: { items: [], canWrite: true } });
  vi.mocked(getCycleTable).mockReset().mockResolvedValue({ kind: "ok", data: { month: "2026-11", bufferWorkingDays: 1, holidaysKnown: true, canPlan: true, rows: [] } });
});

describe("what is asked of the platform", () => {
  it("reads the report for the signed-in person in the active company", async () => {
    await mount("r1");
    expect(getSocialReport).toHaveBeenCalledWith("u-1", "co-a", "r1");
  });
  it("sends a signed-out person to sign in, and is not found for another department or a report that does not exist", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mount()).rejects.toThrow("redirect:/login");
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount("r1", "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
    vi.mocked(getSocialReport).mockResolvedValue(ok(null));
    await expect(mount("gone")).rejects.toThrow("notFound");
  });
});

describe("the report", () => {
  it("draws the client and the month, the state, the saved notes and plan, the narrative and the buttons of the HoD check for one of the four", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Northwind Traders: September 2026" })).toBeInTheDocument();
    expect(screen.getByText("HoD check", { selector: ".scp-reports__state" })).toBeInTheDocument();
    expect((screen.getByLabelText("Followers insight") as HTMLTextAreaElement).value).toBe("An insight.");
    expect((screen.getByRole("textbox", { name: "Action 1" }) as HTMLTextAreaElement).value).toBe("Plan two reels.");
    expect((screen.getByLabelText("Due date of action 1") as HTMLInputElement).value).toBe("2026-10-30");
    expect((screen.getByLabelText("Narrative") as HTMLTextAreaElement).value).toBe("A good month.");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send back to draft" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send to the client" })).toBeNull();
    expect(screen.queryAllByRole("img", { name: "Simulated" })).toHaveLength(0);
  });
  it("for a person who is not one of the four, the check's buttons are disabled with the reason", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(detail({ canApprove: false, canDeliver: false })));
    await mount();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send back to draft" })).toBeDisabled();
    expect(screen.getAllByText(CHECK_SEND_REASON).length).toBeGreaterThanOrEqual(1);
  });
  it("a Ready report offers Send to the four, and is read-only", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(detail({ status: "approved" })));
    await mount();
    expect(screen.getByRole("button", { name: "Send to the client" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
  it("a Sent report is read-only and links the client's Reports tab, resolved from the engagement", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(detail({ status: "delivered" })));
    await mount();
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
    expect(screen.getByRole("link", { name: "Open this client's reports" })).toHaveAttribute("href", "/clients/cl-1/reports");
    expect(screen.queryByRole("button", { name: /Save|Approve|Send/ })).toBeNull();
  });
  it("a Sent report whose client cannot be resolved says it was sent, without a link", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(detail({ status: "delivered" })));
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "x" });
    await mount();
    expect(screen.getAllByText(/published to the client's portal reports/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("link", { name: "Open this client's reports" })).toBeNull();
  });
  it("only a Sent report reads the allocation", async () => {
    await mount();
    expect(getAllocation).not.toHaveBeenCalled();
  });
  it("a simulated report carries the mark beside its title and the watermark note", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(detail({ simulated: true })));
    await mount();
    expect(screen.getAllByRole("img", { name: "Simulated" })).toHaveLength(1);
    expect(screen.getByRole("note")).toHaveTextContent(/watermark/);
  });
  it("a refused read is no access and a failed one is cannot tell, with no report drawn", async () => {
    vi.mocked(getSocialReport).mockResolvedValue({ kind: "forbidden" });
    const a = await mount();
    expect(screen.queryByLabelText("Narrative")).toBeNull();
    expect(a.container.textContent).toMatch(/This report/);
    a.unmount();
    vi.mocked(getSocialReport).mockResolvedValue({ kind: "unavailable", reason: "bad gateway" });
    await mount();
    expect(screen.getByText(/bad gateway/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Narrative")).toBeNull();
  });
});

const shortDetail = (over: Record<string, unknown> = {}) => detail({
  kind: "weekly", period: "2026-W45", status: "draft", notes: {}, actionPlan: [], nextPeriod: "Two posts go out on Tuesday.", live: true, due: "2026-11-10", notesComplete: true,
  document: {
    header: { tenantId: "co-a", grain: "company", scopeRef: "e1", scopeName: "Northwind Traders", periodKind: "custom", periodStart: "2026-11-02", periodEnd: "2026-11-08", dayCount: 7, periodLabel: "Week 45", generatedAt: "2026-11-09T00:00:00Z", sealed: false },
    kpis: [{ metricKey: "reach_month", label: "Reach", unit: "count", value: 4200, appraisalSafe: false }], series: [], distributions: [],
    tables: [
      { key: "best_post", label: "Best post by reach", columns: [], rows: [{ post: "Harvest collection arrives", network: "Instagram", publishedAt: "2026-11-04", reach: 1800 }] },
      { key: "next_period", label: "Coming up the next week", columns: [], rows: [{ postId: "p9", title: "Autumn recipe reel", format: "reel", scheduledAt: "2026-11-10T09:00:00Z", phase: "planned", phaseLabel: "Planned" }] },
    ],
    highlights: [], narrative: { source: "ai", text: "A quiet week.\n\nNext week: Two posts go out on Tuesday." },
  },
  ...over,
});

describe("a short kind's page (weekly)", () => {
  it("draws the title, the due day, the live numbers, the best post, the next period from the pipeline and 'What to tell the client'", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(shortDetail()));
    await mount();
    expect(screen.getByRole("heading", { name: /Northwind Traders: Weekly report, Week 45, 2026/ })).toBeInTheDocument();
    expect(screen.getByText(/Due 10 Nov 2026/)).toBeInTheDocument();
    expect(screen.getByText(/These numbers are live while the report is a draft/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Best post" })).toBeInTheDocument();
    expect(screen.getByText("Harvest collection arrives")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Coming up the next week" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Autumn recipe reel" })).toHaveAttribute("href", "/departments/d-soc/posts/p9");
    expect(screen.getByRole("heading", { name: "What to tell the client" })).toBeInTheDocument();
    // the summary is the saved text, not the printed line; the next line is its own field
    expect(screen.getByLabelText("Summary")).toHaveValue("A quiet week.");
    expect(screen.getByLabelText("Next week")).toHaveValue("Two posts go out on Tuesday.");
    // no notes, plan or narrative on a short kind
    expect(screen.queryByLabelText("Narrative")).toBeNull();
    expect(screen.queryByRole("group", { name: "Followers" })).toBeNull();
  });
  it("says plainly when nothing is dated for the next period and when no post has a reach", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(shortDetail({ document: { ...shortDetail().document, tables: [] } })));
    await mount();
    expect(screen.getByText(/Nothing is dated for the next week in the pipeline/)).toBeInTheDocument();
    expect(screen.getByText(/No post of this period has a reach yet/)).toBeInTheDocument();
  });
  it("navigates to the period before and after: a link when the client has that report, a button that drafts it when not", async () => {
    vi.mocked(getSocialReports).mockResolvedValue({ kind: "ok", data: asReportList({ reports: [{ id: "w39", engagementId: "e1", clientName: "Northwind Traders", period: "2026-W39", kind: "weekly", status: "delivered", notesComplete: true }] }) });
    vi.mocked(getSocialReport).mockResolvedValue(ok(shortDetail({ period: "2026-W40" }))); // a past week: the week after it has begun
    await mount();
    expect(getSocialReports).toHaveBeenCalledWith("u-1", "co-a", { engagementId: "e1", kind: "weekly" });
    const nav = screen.getByRole("navigation", { name: "Report periods" });
    expect(within(nav).getByRole("link", { name: /Previous: Week 39, 2026/ })).toHaveAttribute("href", "/departments/d-soc/social-reports/w39");
    expect(within(nav).getByRole("button", { name: /Next: draft the report for Week 41, 2026/ }).textContent).toMatch(/Next: draft Week 41/);
  });
  it("the check waits on the summary: Approve is disabled with the reason when none is saved", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(shortDetail({ status: "in_review", document: { ...shortDetail().document, narrative: { source: "ai", text: "" } }, nextPeriod: null })));
    await mount();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText("The summary needs to be written before the check can pass.")).toBeInTheDocument();
  });
  it("does not read the ideas or the cycles, and draws no 'Ideas for next month' (the monthly's alone)", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(shortDetail()));
    await mount();
    expect(getIdeas).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Ideas for next month" })).toBeNull();
  });
});

describe("a long kind other than the monthly", () => {
  it("is the monthly's page over its range, without the ideas", async () => {
    vi.mocked(getSocialReport).mockResolvedValue(ok(detail({ kind: "quarterly", period: "2026-Q3" })));
    await mount();
    expect(screen.getByRole("heading", { name: /Northwind Traders: Quarterly report, Q3 2026/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Narrative")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Followers" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ideas for next month" })).toBeNull();
    expect(getIdeas).not.toHaveBeenCalled();
  });
});

describe("'Ideas for next month' on the monthly report", () => {
  const idea = (over: Record<string, unknown> = {}) => ({ id: "i1", engagementId: "e1", saw: "Reels drew replies", metric: "Reply rate", suggestion: "Plan two reels", status: "proposed", reportId: "r1", post: null, sharedAt: null, sharedBy: null, createdBy: { id: "u-2", name: "Dewi" }, createdAt: "2026-10-02T04:00:00Z", ...over });
  it("reads the client's ideas and the cycles of the months after the report, and draws the section under the report", async () => {
    vi.mocked(getIdeas).mockResolvedValue({ kind: "ok", data: { canWrite: true, items: [
      idea(), idea({ id: "i2", status: "shared", sharedAt: "2026-10-03T00:00:00Z", sharedBy: { id: "u-3", name: "Putu" } }),
      idea({ id: "i3", status: "planned", post: { id: "p5", title: "Plan two reels", pipelineStatus: "planned", cycleMonth: "2026-11" } }),
    ] as never } });
    vi.mocked(getCycleTable).mockImplementation(async (_u, _t, month) => ({ kind: "ok", data: { month, bufferWorkingDays: 1, holidaysKnown: true, canPlan: true, rows: [{ engagementId: "e1", cycleId: `c-${month}` }] as never } }));
    await mount();
    expect(getIdeas).toHaveBeenCalledWith("u-1", "co-a", "e1");
    const months = vi.mocked(getCycleTable).mock.calls.map((c) => c[2]);
    expect(months.length).toBeGreaterThanOrEqual(1);
    expect(months.every((m) => m > "2026-09")).toBe(true);
    const section = screen.getByRole("region", { name: "Ideas for next month" });
    expect(within(section).getAllByText(/^(Proposed|Shared with client|Added to plan)$/)).toHaveLength(3);
    expect(within(section).getByRole("link", { name: /Open post/ })).toHaveAttribute("href", "/departments/d-soc/posts/p5");
  });
  it("shows no action to a person the read says may not write, and says who may", async () => {
    vi.mocked(getIdeas).mockResolvedValue({ kind: "ok", data: { canWrite: false, items: [idea() as never] } });
    await mount();
    const section = screen.getByRole("region", { name: "Ideas for next month" });
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("form", { name: "Add an idea" })).toBeNull();
    expect(within(section).getByText(/Only this client's officer/)).toBeInTheDocument();
  });
  it("a failed ideas read says it cannot tell, never 'no ideas'", async () => {
    vi.mocked(getIdeas).mockResolvedValue({ kind: "unavailable", reason: "bad gateway" });
    await mount();
    const section = screen.getByRole("region", { name: "Ideas for next month" });
    expect(within(section).getByText(/could not be read just now. bad gateway/)).toBeInTheDocument();
    expect(within(section).queryByText(/No ideas for this client yet/)).toBeNull();
  });
});
