import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-5a (BFF §63.18): one monthly report as a person meets it. The writes are the demo store's (the twin DEMO_MODE serves): the actions module is replaced by one that calls `socialDemo`, the
// server's order of checks, so what a form posts is judged by the same rules the server applies and the page shows what comes back. The page is drawn from the report's own read, as the
// server page does, and `router.refresh` re-reads it. The clock is pinned to mid-month (Friday 16 October 2026) before the store seeds (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, back: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const persona = vi.hoisted(() => ({ user: "u-social" }));
vi.mock("@/lib/socialReportsActions", async () => {
  const { socialDemo } = await import("@/lib/demoSocial");
  const { refusalFromBody } = await import("@/lib/socialPipeline");
  const { asProposal, reportRefusalText } = await import("@/lib/socialReports");
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
    deliverReport: vi.fn(async (id: string) => write("deliver", call("POST", `reports/${id}/deliver`, {}), (j) => ({ filename: String(j.filename), clientReportId: String(j.clientReportId) }))),
    draftMonthlyReport: vi.fn(),
  };
});

import { socialDemo } from "@/lib/demoSocial";
import { demoReports } from "@/lib/demoSocialReports";
import { PIPE_ENGAGEMENTS } from "@/lib/demoSocialPipeline";
import { asReportDetail, asReportList, CHECK_SEND_REASON, type SocialReportDetail } from "@/lib/socialReports";
import { approveReport, deliverReport, proposeReportDraft, saveReport, sendBackReport, submitReport } from "@/lib/socialReportsActions";
import { SocialReportView } from "./SocialReportView";

const get = (tail: string, user: string) => socialDemo("GET", `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), undefined, user)!.json;
const idOf = (client: string, period: string) => asReportList(get("reports", "u-pm")).find((r) => r.clientName === client && r.period === period)!.id;
const read = (id: string, user = persona.user): SocialReportDetail => asReportDetail(get(`reports/${id}`, user));
const mount = (id: string, over: Partial<{ clientReportsHref: string | null }> = {}) => {
  const r = read(id);
  return render(<SocialReportView deptId="d-soc" report={r} clientName={r.document.header.scopeName} clientReportsHref={over.clientReportsHref ?? null} />);
};
const press = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));
const stored = (id: string) => JSON.stringify(demoReports.store.reports.find((r) => r.id === id));

// Each test takes a report no earlier test moved, and says which.
const NORTH_THIS = () => idOf("Northwind Traders", "2026-10"); // Draft, the audience area missing
const NORTH_LAST = () => idOf("Northwind Traders", "2026-09"); // Ready
const NORTH_AUG = () => idOf("Northwind Traders", "2026-08"); // Sent
const HOTEL_LAST = () => idOf("Harborlight Hotel", "2026-09"); // HoD check, simulated
/** A report of the spa's drafted for a month of its own, so no other test has moved it; `submit` hands it to the HoD check, `emptyAudience` blanks one area first. */
const SPA = PIPE_ENGAGEMENTS[1].id;
function fresh(period: string, o: { submit?: boolean; emptyAudience?: boolean } = {}): string {
  const call = (method: string, tail: string, body: unknown) => socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), JSON.stringify(body), "u-social-2")!;
  const made = call("POST", `engagements/${SPA}/reports`, { id: `soc-rep-view-${period}`, kind: "monthly", period });
  expect(made.status).toBe(201);
  const id = (made.json as { id: string }).id;
  if (o.emptyAudience) expect(call("PATCH", `reports/${id}`, { notes: { followers: { insight: "i", suggestion: "s" }, engagement: { insight: "i", suggestion: "s" } } }).status).toBe(200);
  if (o.submit) expect(call("PATCH", `reports/${id}`, { status: "in_review" }).status).toBe(200);
  return id;
}

beforeEach(() => { vi.clearAllMocks(); persona.user = "u-social"; });

describe("a draft, as the officer meets it", () => {
  it("shows the title, the state, the numbers, the three areas, the plan and the narrative, with the limits", () => {
    mount(NORTH_THIS());
    expect(screen.getByRole("heading", { name: /Northwind Traders: September 2026|Northwind Traders: October 2026/ })).toBeInTheDocument();
    expect(screen.getByText("Draft", { selector: ".scp-reports__state" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The month's numbers" })).toBeInTheDocument();
    for (const area of ["Followers", "Engagement", "Audience"]) {
      const g = screen.getByRole("group", { name: area });
      expect(within(g).getByLabelText(`${area} insight`)).toBeInTheDocument();
      expect(within(g).getByLabelText(`${area} suggestion`)).toBeInTheDocument();
    }
    expect(screen.getAllByText(/\/ 500$/).length).toBe(6);
    expect(screen.getByRole("heading", { name: "Action plan" })).toBeInTheDocument();
    expect(screen.getByLabelText("Narrative")).toBeInTheDocument();
    expect(screen.getByText(/At most 10 actions of up to 300 characters/)).toBeInTheDocument();
  });
  it("draws the notes and the plan once: from the report's own fields, not from the document's two tables", () => {
    mount(NORTH_THIS());
    expect(screen.queryByRole("heading", { name: "Insights and suggestions" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Action plan", level: 3 }) && screen.getAllByRole("heading", { name: "Action plan" })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Top posts" })).toBeInTheDocument(); // the numbers' own tables stay
  });
  it("has Save, Draft with AI and Submit; nothing of the check or of sending", () => {
    mount(NORTH_THIS());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing to save yet
    for (const n of ["Draft with AI", "Submit for the HoD check"]) expect(screen.getByRole("button", { name: n })).toBeEnabled();
    for (const n of [/Approve/, /Send back/, /Send to the client/]) expect(screen.queryByRole("button", { name: n })).toBeNull();
  });
  it("explains, area by area, what is missing from the notes", () => {
    mount(NORTH_THIS());
    const note = screen.getByText("The HoD check cannot pass yet.").closest("div")!;
    expect(within(note).getByText("Audience: the insight and the suggestion are missing.")).toBeInTheDocument();
    expect(within(note).queryByText(/Followers:/)).toBeNull();
  });
  it("Save sends what was typed, and Submit waits for the changes to be saved", async () => {
    const id = NORTH_THIS();
    mount(id);
    fireEvent.change(screen.getByLabelText("Audience insight"), { target: { value: "Weekday evenings." } });
    fireEvent.change(screen.getByLabelText("Audience suggestion"), { target: { value: "Move a post to the evening." } });
    expect(screen.getByRole("button", { name: "Submit for the HoD check" })).toBeDisabled();
    expect(screen.getByText("Save your changes first: the check reads what is saved.")).toBeInTheDocument();
    press("Save");
    await waitFor(() => expect(saveReport).toHaveBeenCalledTimes(1));
    const body = vi.mocked(saveReport).mock.calls[0][1] as { notes: { audience: { insight: string } }; actionPlan: unknown[]; narrativeMd: string };
    expect(body.notes.audience.insight).toBe("Weekday evenings.");
    expect(vi.mocked(saveReport).mock.calls[0][0]).toBe(id);
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
    expect(read(id).notesComplete).toBe(true);
  });
  it("adds and removes plan rows, at most ten, and checks a row before it asks the server", async () => {
    mount(NORTH_THIS());
    for (let i = 0; i < 9; i++) press("Add an action");
    expect(screen.getAllByRole("group", { name: /^Action \d+$/ })).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Add an action" })).toBeDisabled();
    expect(screen.getByText(/the most actions it can hold \(10\)/)).toBeInTheDocument();
    press("Remove action 10");
    expect(screen.getAllByRole("group", { name: /^Action \d+$/ })).toHaveLength(9);
    press("Save"); // the new rows are blank
    expect(await screen.findByText("Action 2: write the action, or remove the row.")).toBeInTheDocument();
    expect(saveReport).not.toHaveBeenCalled();
  });
  it("a note over 500 characters is said before the request, naming the area", () => {
    mount(NORTH_THIS());
    fireEvent.change(screen.getByLabelText("Followers insight"), { target: { value: "x".repeat(501) } });
    press("Save");
    expect(screen.getByText("Followers: the insight is over 500 characters.")).toBeInTheDocument();
    expect(saveReport).not.toHaveBeenCalled();
  });
  it("Submit hands the report to the HoD check", async () => {
    persona.user = "u-social-2";
    const id = fresh("2026-07");
    mount(id);
    press("Submit for the HoD check");
    await waitFor(() => expect(submitReport).toHaveBeenCalledWith(id));
    await waitFor(() => expect(screen.getByText("Submitted for the HoD check.")).toBeInTheDocument());
    expect(read(id).status).toBe("in_review");
  });
});

describe("Draft with AI fills the form and saves nothing", () => {
  it("lays the proposal over the form, says it is unsaved, and leaves the stored report untouched until Save", async () => {
    const id = NORTH_THIS();
    const before = stored(id);
    mount(id);
    press("Draft with AI");
    await waitFor(() => expect(proposeReportDraft).toHaveBeenCalledWith(id));
    await waitFor(() => expect(screen.getByText(/Drafted with AI from the month's numbers/)).toBeInTheDocument());
    expect(screen.getByText("Nothing is saved until you press Save.")).toBeInTheDocument();
    expect((screen.getByLabelText("Audience insight") as HTMLTextAreaElement).value).not.toBe("");
    expect(saveReport).not.toHaveBeenCalled();
    expect(stored(id)).toBe(before);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Submit for the HoD check" })).toBeDisabled(); // unsaved
  });
  it("says when it fell back to the plain template", async () => {
    persona.user = "u-pm";
    mount(HOTEL_LAST());
    press("Draft with AI");
    expect(await screen.findByText(/plain template from the month's numbers/)).toBeInTheDocument();
    expect(screen.getByText("Nothing is saved until you press Save.")).toBeInTheDocument();
  });
  it("a person who may not write is refused in words, naming who may, and the form is left as it was", async () => {
    persona.user = "u-copy";
    const id = NORTH_THIS();
    const r = read(id, "u-copy");
    render(<SocialReportView deptId="d-soc" report={r} clientName="Northwind Traders" clientReportsHref={null} />);
    press("Draft with AI");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/You cannot do this\. Only this client's officer and the Social Media approvers can write the report/);
  });
});

describe("the HoD check", () => {
  it("shows the officer Approve and Send back disabled, with the reason (SCP-Q20), and the server would refuse them anyway", async () => {
    mount(HOTEL_LAST()); // persona: the officer
    for (const n of ["Approve", "Send back to draft"]) expect(screen.getByRole("button", { name: n })).toBeDisabled();
    expect(screen.getAllByText(CHECK_SEND_REASON).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "Submit for the HoD check" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument(); // still editable
  });
  it("lets the HoD approve it: the server's answer is shown, and the page is read again", async () => {
    persona.user = "u-pm";
    const id = HOTEL_LAST();
    mount(id);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    press("Approve");
    await waitFor(() => expect(approveReport).toHaveBeenCalledWith(id));
    await waitFor(() => expect(screen.getByText("Approved. The report is Ready to send.")).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
    expect(read(id).status).toBe("approved");
  });
  it("blocks Approve with the reason while an area is missing, and shows the server's `notes_incomplete` if it is asked anyway", async () => {
    // A report the officer submitted with the audience area still empty: the check cannot pass.
    const id = fresh("2026-06", { submit: true, emptyAudience: true });
    persona.user = "u-pm";
    const r = read(id);
    expect(r).toMatchObject({ status: "in_review", notesComplete: false, canApprove: true });
    const { rerender } = render(<SocialReportView deptId="d-soc" report={r} clientName="Northwind Traders" clientReportsHref={null} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText(/Each of the three areas needs an insight and a suggestion before the check can pass/)).toBeInTheDocument();
    expect(screen.getByText("Audience: the insight and the suggestion are missing.")).toBeInTheDocument();
    // a page that thought the notes complete (a stale read): the server's refusal is shown in words
    rerender(<SocialReportView deptId="d-soc" report={{ ...r, notesComplete: true }} clientName="Northwind Traders" clientReportsHref={null} />);
    press("Approve");
    expect(await screen.findByRole("alert")).toHaveTextContent(/an area is missing its insight or its suggestion/);
  });
  it("lets the HoD send it back to draft", async () => {
    const id = fresh("2026-05", { submit: true });
    persona.user = "u-gm";
    mount(id);
    press("Send back to draft");
    await waitFor(() => expect(sendBackReport).toHaveBeenCalledWith(id));
    await waitFor(() => expect(screen.getByText("Sent back to draft.")).toBeInTheDocument());
    expect(read(id).status).toBe("draft");
  });
});

describe("Ready, Sent and a simulated report", () => {
  it("a Ready report is read-only; the officer's Send is disabled with the reason, and the four's is live", () => {
    const id = NORTH_LAST();
    const { unmount } = mount(id);
    expect(screen.getByRole("button", { name: "Send to the client" })).toBeDisabled();
    expect(screen.getByText(CHECK_SEND_REASON)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Draft with AI" })).toBeNull();
    expect(screen.getByLabelText("Followers insight")).toBeDisabled();
    unmount();
    persona.user = "u-pm";
    mount(id);
    expect(screen.getByRole("button", { name: "Send to the client" })).toBeEnabled();
  });
  it("Send to the client publishes it, and says where the client reads it", async () => {
    persona.user = "demo-owner";
    const id = NORTH_LAST();
    mount(id);
    press("Send to the client");
    await waitFor(() => expect(deliverReport).toHaveBeenCalledWith(id));
    await waitFor(() => expect(screen.getByText(/^Sent: social-report-2026-09-.*\.pdf\. The PDF is published to the client's portal reports\.$/)).toBeInTheDocument());
    expect(read(id).status).toBe("delivered");
  });
  it("a Sent report is read-only, with nothing to press and a link to the client's reports", () => {
    persona.user = "u-pm";
    mount(NORTH_AUG(), { clientReportsHref: "/clients/cl-1/reports" });
    expect(screen.getByText("Sent", { selector: ".scp-reports__state" })).toBeInTheDocument();
    for (const b of screen.queryAllByRole("button")) expect(b, b.textContent ?? "").toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save|Approve|Send/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open this client's reports" })).toHaveAttribute("href", "/clients/cl-1/reports");
    expect(screen.getAllByText(/can no longer be changed/).length).toBeGreaterThanOrEqual(1);
  });
  it("a simulated report carries the SIMULATED mark beside its title once, and a note that the PDF is watermarked", () => {
    persona.user = "u-pm";
    mount(HOTEL_LAST());
    expect(screen.getAllByRole("img", { name: "Simulated" })).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Simulated" }).closest(".scp-report__head")).not.toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(/came from the social simulator/);
    expect(screen.getByRole("note")).toHaveTextContent(/watermark/);
  });
  it("a real report has no mark and no note", () => {
    mount(NORTH_LAST());
    expect(screen.queryAllByRole("img", { name: "Simulated" })).toHaveLength(0);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
