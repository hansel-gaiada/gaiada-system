import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

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
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialReports-data", () => ({ getSocialReport: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn() }));
vi.mock("@/lib/socialReportsActions", () => ({
  saveReport: vi.fn(), submitReport: vi.fn(), sendBackReport: vi.fn(), proposeReportDraft: vi.fn(), approveReport: vi.fn(), deliverReport: vi.fn(),
}));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartment } from "@/lib/departments";
import { getSocialReport } from "@/lib/socialReports-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { asReportDetail, CHECK_SEND_REASON, type SocialReportDetail } from "@/lib/socialReports";
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
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getSocialReport).mockReset().mockResolvedValue(ok(detail()));
  vi.mocked(getAllocation).mockReset().mockResolvedValue({ kind: "ok", data: [{ engagementId: "e1", clientId: "cl-1", clientName: "Northwind Traders" }] as never });
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
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount("r1", "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
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
