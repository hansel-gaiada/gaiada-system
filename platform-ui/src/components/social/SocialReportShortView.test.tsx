import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-A4 (BFF §63.24.7): a short kind's report (weekly) as a person meets it, and the period's navigation. The writes are the demo store's (the twin DEMO_MODE serves): the actions module is replaced
// by one that calls `socialDemo`, so what the form posts is judged by the rules the server applies. The clock is pinned to Friday 16 October 2026 before the stores seed (hence vi.hoisted).
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const persona = vi.hoisted(() => ({ user: "u-social" }));
vi.mock("@/lib/socialReportsActions", async () => {
  const { socialDemo } = await import("@/lib/demoSocial");
  const { refusalFromBody } = await import("@/lib/socialPipeline");
  const { asProposal, asCreatedReport, reportRefusalText } = await import("@/lib/socialReports");
  const call = (method: string, tail: string, body?: unknown) =>
    socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), persona.user)!;
  const write = <T extends object>(kind: Parameters<typeof reportRefusalText>[1], r: { status: number; json: unknown }, extra?: (j: Record<string, unknown>) => T) => {
    const j = r.json as Record<string, unknown>;
    if (r.status < 300) return { ok: true as const, ...(extra ? extra(j) : {}) };
    const refusal = refusalFromBody(r.status, String(j.error), j, typeof j.field === "string" ? j.field : undefined);
    return { ok: false as const, refusal, message: reportRefusalText(refusal, kind) };
  };
  return {
    saveReport: vi.fn(async (id: string, body: unknown) => write("save", call("PATCH", `reports/${id}`, body))),
    submitReport: vi.fn(async (id: string) => write("submit", call("PATCH", `reports/${id}`, { status: "in_review" }))),
    sendBackReport: vi.fn(async (id: string) => write("send_back", call("PATCH", `reports/${id}`, { status: "draft" }))),
    proposeReportDraft: vi.fn(async (id: string) => write("ai_draft", call("POST", `reports/${id}/ai-draft`, {}), (j) => ({ proposal: asProposal(j) }))),
    approveReport: vi.fn(async (id: string) => write("approve", call("POST", `reports/${id}/approve`, {}))),
    deliverReport: vi.fn(),
    draftReport: vi.fn(async (engagementId: string, kind: string, period: string, id: string) => write("create", call("POST", `engagements/${engagementId}/reports`, { id, kind, period }), (j) => ({ report: asCreatedReport(j) }))),
  };
});

import { socialDemo } from "@/lib/demoSocial";
import { demoReports } from "@/lib/demoSocialReports";
import { asReportDetail, asReportList, reportNav, type SocialReportDetail } from "@/lib/socialReports";
import { approveReport, draftReport, proposeReportDraft, saveReport, submitReport } from "@/lib/socialReportsActions";
import { SocialReportView } from "./SocialReportView";

const get = (tail: string, user: string, q = "") => socialDemo("GET", `/api/co-agency/modules/social/${tail}`, new URLSearchParams(q), undefined, user)!.json;
const list = (q: string) => asReportList(get("reports", "u-pm", q));
const read = (id: string): SocialReportDetail => asReportDetail(get(`reports/${id}`, persona.user));
const stored = (id: string) => demoReports.store.reports.find((r) => r.id === id)!;
const TODAY = "2026-10-16";
const mount = (id: string, withNav = true) => {
  const r = read(id);
  const n = withNav ? reportNav(r, list(`engagementId=${r.engagementId}&kind=${r.kind}`), TODAY) : undefined;
  return render(<SocialReportView deptId="d-soc" report={r} clientName={r.document.header.scopeName} clientReportsHref={null} nav={n} />);
};
const press = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

const WEEKLY_NOW = () => list("kind=weekly&period=2026-W42").find((r) => r.clientName === "Northwind Traders")!.id; // a Draft, live
const WEEKLY_LAST = () => list("kind=weekly&period=2026-W41").find((r) => r.clientName === "Northwind Traders")!.id; // Sent
const WEEKLY_HOTEL = () => list("kind=weekly&period=2026-W41").find((r) => r.clientName === "Harborlight Hotel")!.id; // a Draft, simulated

beforeEach(() => { vi.clearAllMocks(); persona.user = "u-social"; });

describe("a weekly report as a person meets it", () => {
  it("shows the summary and the next-period line as two fields, never the printed line inside the summary", () => {
    const id = WEEKLY_NOW();
    mount(id);
    const saved = stored(id);
    expect(screen.getByLabelText("Summary")).toHaveValue(saved.narrativeMd);
    expect(screen.getByLabelText("Next week")).toHaveValue(saved.nextPeriod);
    expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).not.toMatch(/Next week:/);
    expect(screen.getByRole("heading", { name: /Weekly report, Week 42, 2026/ })).toBeInTheDocument();
    expect(screen.getByText(/These numbers are live while the report is a draft/)).toBeInTheDocument();
  });
  it("saves exactly the summary and the line (and nothing of the notes), then reads the page again", async () => {
    const id = WEEKLY_NOW();
    mount(id);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "A steady week." } });
    fireEvent.change(screen.getByLabelText("Next week"), { target: { value: "  " } });
    press("Save");
    await waitFor(() => expect(saveReport).toHaveBeenCalledWith(id, { narrativeMd: "A steady week.", nextPeriod: null }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(stored(id)).toMatchObject({ narrativeMd: "A steady week.", nextPeriod: null });
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("refuses a summary over the limit before the request, in words, and the field says so", () => {
    const id = WEEKLY_HOTEL();
    persona.user = "u-social";
    mount(id);
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "x".repeat(1001) } });
    press("Save");
    expect(saveReport).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The summary is over 1000 characters.");
    expect(screen.getByLabelText("Summary")).toHaveAttribute("aria-invalid", "true");
  });
  it("Draft with AI fills the two fields and saves NOTHING; the plain template says so for the simulated client", async () => {
    const id = WEEKLY_HOTEL();
    mount(id);
    const before = JSON.stringify(stored(id));
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "" } });
    press("Draft with AI");
    await waitFor(() => expect(proposeReportDraft).toHaveBeenCalledWith(id));
    expect(await screen.findByText(/plain template from the period's numbers/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is saved until you press Save/)).toBeInTheDocument();
    expect((screen.getByLabelText("Summary") as HTMLTextAreaElement).value).toMatch(/Summary for Week 41/);
    expect((screen.getByLabelText("Next week") as HTMLTextAreaElement).value).toMatch(/next week/);
    expect(JSON.stringify(stored(id))).toBe(before);
    expect(saveReport).not.toHaveBeenCalled();
  });
  it("the officer submits for the HoD check once the changes are saved, and the four approve it", async () => {
    const eng = stored(WEEKLY_NOW()).engagementId;
    const id = (socialDemo("POST", `/api/co-agency/modules/social/engagements/${eng}/reports`, new URLSearchParams(), JSON.stringify({ id: "soc-rep-short-1", kind: "weekly", period: "2026-W40" }), "u-social")!.json as { id: string }).id;
    const view = mount(id);
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Changed." } });
    expect(screen.getByRole("button", { name: /Submit for the HoD check/ })).toBeDisabled(); // save first
    press("Save");
    await screen.findByText("Saved.");
    view.unmount();
    mount(id);
    press(/Submit for the HoD check/);
    await waitFor(() => expect(submitReport).toHaveBeenCalledWith(id));
    expect(stored(id).status).toBe("in_review");
    view.unmount();
    persona.user = "u-pm";
    mount(id);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    press("Approve");
    await waitFor(() => expect(approveReport).toHaveBeenCalledWith(id));
    expect(stored(id).status).toBe("approved");
  });
  it("says the server's refusal in words: an approval with no summary is summary_missing, never the bare code", async () => {
    const made = socialDemo("POST", `/api/co-agency/modules/social/engagements/${stored(WEEKLY_NOW()).engagementId}/reports`, new URLSearchParams(), JSON.stringify({ id: "soc-rep-short-2", kind: "daily", period: "2026-10-09" }), "u-social");
    const id = (made!.json as { id: string }).id;
    socialDemo("PATCH", `/api/co-agency/modules/social/reports/${id}`, new URLSearchParams(), JSON.stringify({ narrativeMd: "x", nextPeriod: null }), "u-social");
    socialDemo("PATCH", `/api/co-agency/modules/social/reports/${id}`, new URLSearchParams(), JSON.stringify({ status: "in_review" }), "u-social");
    persona.user = "u-pm";
    const r = read(id);
    // someone blanked the summary between the page's read and the click
    render(<SocialReportView deptId="d-soc" report={r} clientName="Northwind Traders" clientReportsHref={null} />);
    stored(id).narrativeMd = "";
    press("Approve");
    expect(await screen.findByText(/The HoD check cannot pass yet: the report has no summary/)).toBeInTheDocument();
  });
  it("a Sent weekly report is read-only, with no buttons of the form", () => {
    mount(WEEKLY_LAST());
    expect(screen.queryByRole("button", { name: /Save|Approve|Submit|Draft with AI/ })).toBeNull();
    expect(screen.getByLabelText("Summary").closest("fieldset")).toBeDisabled();
  });
});

describe("the period's navigation", () => {
  it("links the period before when the client has that report, and drafts the one after when it has none and has begun", async () => {
    const id = WEEKLY_NOW();
    mount(id);
    const n = screen.getByRole("navigation", { name: "Report periods" });
    expect(within(n).getByRole("link", { name: /Previous: Week 41, 2026/ })).toHaveAttribute("href", `/departments/d-soc/social-reports/${WEEKLY_LAST()}`);
    // week 43 has not begun on 16 October: nothing to draft, said so
    expect(within(n).getByText("The next period has not begun.")).toBeInTheDocument();
  });
  it("a missing period before is a button that drafts it (one create with the kind and the period, then it opens)", async () => {
    const eng = stored(WEEKLY_NOW()).engagementId;
    const made = socialDemo("POST", `/api/co-agency/modules/social/engagements/${eng}/reports`, new URLSearchParams(), JSON.stringify({ id: "soc-rep-nav-1", kind: "weekly", period: "2026-W30" }), "u-social");
    const id = (made!.json as { id: string }).id;
    mount(id);
    const n = screen.getByRole("navigation", { name: "Report periods" });
    fireEvent.click(within(n).getByRole("button", { name: /Previous: draft the report for Week 29, 2026/ }));
    await waitFor(() => expect(draftReport).toHaveBeenCalledWith(eng, "weekly", "2026-W29", expect.stringMatching(/^[0-9a-f-]{36}$/)));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(expect.stringMatching(/^\/departments\/d-soc\/social-reports\/[0-9a-f-]{36}$/)));
  });
});
