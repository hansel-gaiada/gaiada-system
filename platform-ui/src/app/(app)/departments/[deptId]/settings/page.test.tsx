import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-1c (BFF §63.4, §63.5): the Social Media Settings page. The reads are the server's; the page draws the buffer, the boost factor, the calendar
// state, the step-estimates slot and the month's deadline table, disables every control with the reason unless `canPlan`, and words a refused read
// as "no access" and a failed one as "cannot tell", never as an empty table.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh, push: vi.fn() }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn(async () => ({ userId: "u-1", companies: [{ id: "co-a", vertical: "agency" }] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/socialCycles-data", () => ({ getSocialSettings: vi.fn(), getCycleTable: vi.fn() }));
vi.mock("@/lib/socialCyclesActions", () => ({ saveSocialSettings: vi.fn(), saveCycleDeadlines: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn() }));
vi.mock("@/lib/socialAllocationActions", () => ({ saveAllocation: vi.fn() }));
vi.mock("@/lib/socialReportSchedules-data", () => ({ getReportSchedules: vi.fn() }));
vi.mock("@/lib/socialRules-data", () => ({ getRules: vi.fn() }));
vi.mock("@/lib/socialRulesActions", () => ({ saveRules: vi.fn(), resetRules: vi.fn(), previewRules: vi.fn(), loadRulesHistory: vi.fn() }));
vi.mock("@/lib/socialReportSchedulesActions", () => ({ saveSchedule: vi.fn(), editSchedule: vi.fn(), setScheduleOn: vi.fn(), deleteSchedule: vi.fn(), runScheduleNow: vi.fn(), getRunProgress: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { getCycleTable, getSocialSettings } from "@/lib/socialCycles-data";
import { saveCycleDeadlines, saveSocialSettings } from "@/lib/socialCyclesActions";
import { getAllocation } from "@/lib/socialAllocation-data";
import { saveAllocation } from "@/lib/socialAllocationActions";
import { getReportSchedules } from "@/lib/socialReportSchedules-data";
import { getRules } from "@/lib/socialRules-data";
import { rulesAnswer } from "@/components/social/rulesTestKit";
import { asSchedule } from "@/lib/socialReportSchedules";
import type { AllocationRow } from "@/lib/socialAllocation";
import { PLAN_REFUSAL_REASON, type CycleRow, type CycleTable, type SocialSettings } from "@/lib/socialCycles";
import type { ReadResult } from "@/lib/readResult";
import SocialSettingsPage from "./page";

const counts = { counted: 0, planned: 0, inProduction: 0, withClient: 0, clientChanges: 0, approved: 0, scheduled: 0, live: 0, extra: 0, stories: 0 };
const alpha: CycleRow = {
  engagementId: "e-alpha", clientName: "Brand Alpha", officer: { id: "u-2", name: "Sam Officer" }, deliveryBatch: "A", cycleId: "c-alpha",
  deadline: "2026-09-15", readyBy: "2026-09-14", prefill: { deadline: "2026-09-15", batch: "A" }, target: 12,
  counts: { ...counts, counted: 8, planned: 1, inProduction: 3, withClient: 2, approved: 1, scheduled: 1, extra: 2, stories: 1 },
  health: { state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: "2026-09-10", readyBy: "2026-09-14" },
};
const beta: CycleRow = {
  engagementId: "e-beta", clientName: "Brand Beta", officer: null, deliveryBatch: "B", cycleId: null, deadline: null, readyBy: null,
  prefill: { deadline: "2026-09-30", batch: "B" }, target: null, counts, health: null,
};
const gamma: CycleRow = {
  engagementId: "e-gamma", clientName: "Brand Gamma", officer: { id: "u-3", name: "Kim Officer" }, deliveryBatch: null, cycleId: "c-gamma",
  deadline: "2026-09-10", readyBy: "2026-09-09", prefill: { deadline: null, batch: null }, target: 6,
  counts: { ...counts, counted: 5, planned: 5 },
  health: { state: "late", spareDays: -4, lateDays: 2, lateWith: "designer", latestSafeHandoff: "2026-09-04", readyBy: "2026-09-09" },
};
const settings = (over: Partial<SocialSettings> = {}): SocialSettings => ({
  bufferWorkingDays: 1, boostCandidateFactor: 1.25, holidayCalendar: { known: false, name: null }, canPlan: true, ...over,
});
const table = (over: Partial<CycleTable> = {}): CycleTable => ({ month: "2026-10", bufferWorkingDays: 1, holidaysKnown: false, canPlan: true, rows: [alpha, beta, gamma], ...over });
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const alloc = (over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: "e-alpha", clientId: "c-alpha", clientName: "Brand Alpha", status: "active", officer: null, postsPerCycle: 12, creativeSource: "creatives",
  deliveryBatch: "A", reportFormat: null, reportDueDay: null, platforms: [], formats: [], defaultPostTime: null, stepEstimates: { hod: 2, design: 3 },
  thisCycle: null, canPlan: true, ...over,
});

const mount = async (search: Record<string, string> = {}, deptId = "d-soc") =>
  render(await SocialSettingsPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  // Wednesday 14 October 2026, midday in Singapore. Only Date is faked, so the awaits in the page still run.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
  refresh.mockReset();
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getSocialSettings).mockReset().mockResolvedValue(ok(settings()));
  vi.mocked(getCycleTable).mockReset().mockResolvedValue(ok(table()));
  vi.mocked(saveSocialSettings).mockReset();
  vi.mocked(saveCycleDeadlines).mockReset();
  vi.mocked(getAllocation).mockReset().mockResolvedValue(ok([alloc(), alloc({ engagementId: "e-beta", clientName: "Brand Beta", stepEstimates: {} })]));
  vi.mocked(saveAllocation).mockReset();
  vi.mocked(getReportSchedules).mockReset().mockResolvedValue({ kind: "forbidden" });
  vi.mocked(getRules).mockReset().mockResolvedValue(ok(rulesAnswer()));
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the settings and the current month's table for the signed-in person", async () => {
    await mount();
    expect(getSocialSettings).toHaveBeenCalledWith("u-1", "co-a");
    expect(getCycleTable).toHaveBeenCalledWith("u-1", "co-a", "2026-10");
  });
  it("reads the month in ?month=, and the current month for a bad one", async () => {
    await mount({ month: "2026-12" });
    expect(getCycleTable).toHaveBeenLastCalledWith("u-1", "co-a", "2026-12");
    await mount({ month: "2026-13" });
    expect(getCycleTable).toHaveBeenLastCalledWith("u-1", "co-a", "2026-10");
  });
  it("is not found for a department that is not Social Media, or that does not exist", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mount({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    await expect(mount({}, "nope")).rejects.toThrow("notFound");
  });
});

describe("the deadline table", () => {
  it("draws one row per client with its pre-fill, deadline, ready-by, posts and health chip", async () => {
    await mount();
    const t = screen.getByRole("table", { name: /Deadline per client/ });
    expect(within(t).getByText(/Deadline per client for October 2026/)).toBeInTheDocument();
    const rows = within(t).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const a = within(rows[0]);
    expect(a.getByText("Brand Alpha")).toBeInTheDocument();
    expect(a.getByText("Officer: Sam Officer")).toBeInTheDocument();
    expect(a.getByText("15 Sep")).toBeInTheDocument(); // the pre-fill
    expect(a.getByText("Batch A")).toBeInTheDocument();
    expect(a.getByLabelText("Deadline for Brand Alpha")).toHaveValue("2026-09-15");
    expect(a.getByText("14 Sep")).toBeInTheDocument(); // ready-by
    expect(a.getByText("8 of 12")).toBeInTheDocument();
    expect(a.getByText("+ 2 extra · 1 story")).toBeInTheDocument();
    expect(a.getByText("On track · 3 spare days")).toBeInTheDocument();
    // a client with no cycle: no health, no ready-by, an empty deadline box, the pre-fill offered
    const b = within(rows[1]);
    expect(b.getByText("No cycle")).toBeInTheDocument();
    expect(b.getByText("Not set")).toBeInTheDocument();
    expect(b.getByLabelText("Deadline for Brand Beta")).toHaveValue("");
    expect(b.getByText("No officer yet")).toBeInTheDocument();
    // no batch: no pre-fill; late: the days and who
    expect(within(rows[2]).getByText("No batch set")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Late · 2 days · with the designer")).toBeInTheDocument();
  });

  it("limits the deadline box to the cycle's range: three months before the month to its last day", async () => {
    await mount();
    const input = screen.getByLabelText("Deadline for Brand Alpha");
    expect(input).toHaveAttribute("min", "2026-07-01");
    expect(input).toHaveAttribute("max", "2026-10-31");
  });

  it("says when no client has an open engagement", async () => {
    vi.mocked(getCycleTable).mockResolvedValue(ok(table({ rows: [] })));
    await mount();
    expect(screen.getByText(/No client has an open engagement/)).toBeInTheDocument();
  });

  it("links the previous and next month, and 'This month' only away from the current one", async () => {
    const first = await mount();
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByRole("link", { name: "Previous month, September 2026" })).toHaveAttribute("href", "/departments/d-soc/settings?month=2026-09");
    expect(within(nav).getByRole("link", { name: "Next month, November 2026" })).toHaveAttribute("href", "/departments/d-soc/settings?month=2026-11");
    expect(within(nav).queryByRole("link", { name: "This month" })).not.toBeInTheDocument();
    first.unmount();
    await mount({ month: "2026-11" });
    const n2 = screen.getByRole("navigation", { name: "Month" });
    expect(within(n2).getByRole("link", { name: "This month" })).toHaveAttribute("href", "/departments/d-soc/settings");
    expect(within(n2).getByRole("link", { name: "Previous month, October 2026" })).toHaveAttribute("href", "/departments/d-soc/settings");
  });
});

describe("the way into the sheet import (SCP-6a)", () => {
  it("links 'Import from your sheet' for a person who may plan", async () => {
    const { container } = await mount();
    const slot = container.querySelector('[data-slot="sheet-import"]') as HTMLElement;
    expect(slot).not.toBeNull();
    expect(within(slot).getByRole("heading", { name: "Moving from the sheet?" })).toBeInTheDocument();
    expect(within(slot).getByRole("link", { name: "Import from your sheet" })).toHaveAttribute("href", "/departments/d-soc/settings/import");
  });
  it("shows no link to a person who may not plan", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue(ok(settings({ canPlan: false })));
    const { container } = await mount();
    expect(container.querySelector('[data-slot="sheet-import"]')).toBeNull();
    expect(screen.queryByRole("link", { name: "Import from your sheet" })).not.toBeInTheDocument();
  });
});

describe("the settings section", () => {
  it("shows the buffer and the factor, and says 'weekends only' with no holiday calendar", async () => {
    await mount();
    expect(screen.getByLabelText(/Buffer \(working days\)/)).toHaveValue(1);
    expect(screen.getByLabelText(/Boost-candidate factor/)).toHaveValue(1.25);
    expect(screen.getByText("Weekends only")).toBeInTheDocument();
    expect(screen.getByText(/no default holiday calendar/)).toBeInTheDocument();
  });
  it("names the calendar when one is known", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue(ok(settings({ holidayCalendar: { known: true, name: "Public holidays 2026" } })));
    await mount();
    expect(screen.getByText("Public holidays 2026")).toBeInTheDocument();
    expect(screen.queryByText("Weekends only")).not.toBeInTheDocument();
  });
  it("fills the marked slot with each client's step estimates (SCP-1a)", async () => {
    const { container } = await mount();
    const slot = container.querySelector('[data-slot="step-estimates"]') as HTMLElement;
    expect(slot).not.toBeNull();
    const s = within(slot);
    expect(s.getByRole("heading", { name: "Step estimates" })).toBeInTheDocument();
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
    expect(s.getByLabelText("HoD approval for Brand Alpha (working days)")).toHaveValue(2);
    expect(s.getByLabelText("Design for Brand Alpha (working days)")).toHaveValue(3);
    expect(s.getByLabelText("Proofread for Brand Alpha (working days)")).toHaveValue(null);
    expect(s.getByLabelText("Scheduling for Brand Beta (working days)")).toHaveValue(null);
  });
  it("saves a client's estimates through the allocation route: the whole set, an empty box cleared", async () => {
    vi.mocked(saveAllocation).mockResolvedValue({ ok: true, row: alloc({ stepEstimates: { hod: 2, design: 5 } }) });
    const { container } = await mount();
    const s = within(container.querySelector('[data-slot="step-estimates"]') as HTMLElement);
    const save = s.getByRole("button", { name: "Save step estimates for Brand Alpha" });
    expect(save).toBeDisabled(); // nothing changed yet
    fireEvent.change(s.getByLabelText("Design for Brand Alpha (working days)"), { target: { value: "5" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(saveAllocation).toHaveBeenCalledWith("e-alpha", { stepEstimates: { hod: 2, design: 5 } }));
    expect(await s.findByText("Saved.")).toBeInTheDocument();
    fireEvent.change(s.getByLabelText("HoD approval for Brand Alpha (working days)"), { target: { value: "" } });
    vi.mocked(saveAllocation).mockResolvedValue({ ok: true, row: alloc({ stepEstimates: { design: 5 } }) });
    fireEvent.click(s.getByRole("button", { name: "Save step estimates for Brand Alpha" }));
    await waitFor(() => expect(saveAllocation).toHaveBeenLastCalledWith("e-alpha", { stepEstimates: { design: 5 } }));
  });
  it("will not send an estimate outside 0 to 30 or a fraction", async () => {
    const { container } = await mount();
    const s = within(container.querySelector('[data-slot="step-estimates"]') as HTMLElement);
    const save = s.getByRole("button", { name: "Save step estimates for Brand Alpha" });
    fireEvent.change(s.getByLabelText("Design for Brand Alpha (working days)"), { target: { value: "31" } });
    expect(save).toBeDisabled();
    fireEvent.change(s.getByLabelText("Design for Brand Alpha (working days)"), { target: { value: "2.5" } });
    expect(save).toBeDisabled();
    expect(saveAllocation).not.toHaveBeenCalled();
  });
  it("is read-only with the reason for anyone who may not plan", async () => {
    vi.mocked(getAllocation).mockResolvedValue(ok([alloc({ canPlan: false })]));
    const { container } = await mount();
    const s = within(container.querySelector('[data-slot="step-estimates"]') as HTMLElement);
    expect(s.getByLabelText("Design for Brand Alpha (working days)")).toBeDisabled();
    expect(s.getByRole("button", { name: "Save step estimates for Brand Alpha" })).toBeDisabled();
    expect(s.getByText(PLAN_REFUSAL_REASON)).toBeInTheDocument();
  });
  it("says so in the slot, and leaves the rest of the page, when the allocation cannot be read", async () => {
    vi.mocked(getAllocation).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    const { container } = await mount();
    const slot = within(container.querySelector('[data-slot="step-estimates"]') as HTMLElement);
    expect(slot.getByText(/cannot be shown right now \(platform 500\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Buffer \(working days\)/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Deadline per client/ })).toBeInTheDocument();
  });

  it("saves only what changed, and says how many cycles moved", async () => {
    vi.mocked(saveSocialSettings).mockResolvedValue({ ok: true, settings: settings({ bufferWorkingDays: 3 }), cyclesRecomputed: 2 });
    await mount();
    const save = screen.getByRole("button", { name: "Save settings" });
    expect(save).toBeDisabled(); // nothing changed yet
    fireEvent.change(screen.getByLabelText(/Buffer \(working days\)/), { target: { value: "3" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(saveSocialSettings).toHaveBeenCalledWith({ bufferWorkingDays: 3 }));
    expect(await screen.findByText(/Saved\. 2 open cycles' ready-by date moved/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });
  it("will not send a buffer outside 0 to 10 or a factor with three decimals", async () => {
    await mount();
    const save = screen.getByRole("button", { name: "Save settings" });
    fireEvent.change(screen.getByLabelText(/Buffer \(working days\)/), { target: { value: "11" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Buffer \(working days\)/), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/Boost-candidate factor/), { target: { value: "1.255" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Boost-candidate factor/), { target: { value: "1.5" } });
    expect(save).toBeEnabled();
  });
  it("shows the server's refusal in words", async () => {
    vi.mocked(saveSocialSettings).mockResolvedValue({ ok: false, error: "not_a_social_approver", message: PLAN_REFUSAL_REASON });
    await mount();
    fireEvent.change(screen.getByLabelText(/Buffer \(working days\)/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(PLAN_REFUSAL_REASON);
  });
});

describe("saving deadlines", () => {
  it("'Use' copies the pre-fill into the box, and Save sends only the rows that changed", async () => {
    vi.mocked(saveCycleDeadlines).mockResolvedValue({ ok: true, table: table({ rows: [alpha, { ...beta, cycleId: "c-beta", deadline: "2026-09-30", readyBy: "2026-09-29" }, gamma] }) });
    await mount();
    const save = screen.getByRole("button", { name: /^Save deadlines/ });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use the pre-fill for Brand Beta" }));
    expect(screen.getByLabelText("Deadline for Brand Beta")).toHaveValue("2026-09-30");
    expect(screen.getByRole("button", { name: "Save deadlines (1)" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save deadlines (1)" }));
    await waitFor(() => expect(saveCycleDeadlines).toHaveBeenCalledWith("2026-10", [{ engagementId: "e-beta", deadline: "2026-09-30" }]));
    expect(await screen.findByText("Saved 1 deadline.")).toBeInTheDocument();
    expect(screen.getByText("29 Sep")).toBeInTheDocument(); // the ready-by the server computed
  });

  it("an edited deadline is sent too; the pre-fill button is disabled once the box holds it", async () => {
    vi.mocked(saveCycleDeadlines).mockResolvedValue({ ok: true, table: table() });
    await mount();
    fireEvent.change(screen.getByLabelText("Deadline for Brand Alpha"), { target: { value: "2026-09-12" } });
    expect(screen.getByRole("button", { name: "Use the pre-fill for Brand Alpha" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use the pre-fill for Brand Alpha" }));
    // back to the stored value: nothing to save
    expect(screen.getByRole("button", { name: /^Save deadlines/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Deadline for Brand Alpha"), { target: { value: "2026-09-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save deadlines (1)" }));
    await waitFor(() => expect(saveCycleDeadlines).toHaveBeenCalledWith("2026-10", [{ engagementId: "e-alpha", deadline: "2026-09-12" }]));
  });

  it("'Fill empty rows from the pre-fill' fills the rows that have a pre-fill and no deadline", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Fill empty rows from the pre-fill" }));
    expect(screen.getByLabelText("Deadline for Brand Beta")).toHaveValue("2026-09-30");
    expect(screen.getByLabelText("Deadline for Brand Alpha")).toHaveValue("2026-09-15"); // untouched
  });

  it("shows a refusal of the whole save in words and keeps the drafts", async () => {
    vi.mocked(saveCycleDeadlines).mockResolvedValue({ ok: false, error: "invalid_field", field: "rows[0].deadline", message: "A deadline must be a real date from three months before the month to its last day." });
    await mount();
    fireEvent.change(screen.getByLabelText("Deadline for Brand Beta"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save deadlines (1)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/real date/);
    expect(screen.getByLabelText("Deadline for Brand Beta")).toHaveValue("2026-09-30");
  });
});

describe("without the right to plan: readable, every control disabled WITH the reason", () => {
  beforeEach(() => {
    vi.mocked(getSocialSettings).mockResolvedValue(ok(settings({ canPlan: false })));
    vi.mocked(getCycleTable).mockResolvedValue(ok(table({ canPlan: false })));
    vi.mocked(getAllocation).mockResolvedValue(ok([alloc({ canPlan: false })]));
  });

  it("still shows the values and the table", async () => {
    await mount();
    expect(screen.getByLabelText(/Buffer \(working days\)/)).toHaveValue(1);
    expect(within(screen.getByRole("table", { name: /Deadline per client/ })).getByText("Brand Alpha")).toBeInTheDocument();
    expect(screen.getByText("On track · 3 spare days")).toBeInTheDocument();
  });

  it("disables the inputs and the buttons, each pointing at the reason in words and as a title", async () => {
    await mount();
    const reasons = screen.getAllByText(PLAN_REFUSAL_REASON);
    expect(reasons.length).toBeGreaterThanOrEqual(3); // one under the settings, one under the step estimates, one under the table
    const controls = [
      screen.getByLabelText(/Buffer \(working days\)/), screen.getByLabelText(/Boost-candidate factor/),
      screen.getByRole("button", { name: "Save settings" }), screen.getByLabelText("Deadline for Brand Alpha"),
      screen.getByRole("button", { name: /^Save deadlines/ }), screen.getByRole("button", { name: "Fill empty rows from the pre-fill" }),
      screen.getByRole("button", { name: "Use the pre-fill for Brand Beta" }),
    ];
    for (const c of controls) {
      expect(c).toBeDisabled();
      const id = c.getAttribute("aria-describedby");
      expect(id, c.outerHTML).toBeTruthy();
      expect(document.getElementById(id!)).toHaveTextContent(PLAN_REFUSAL_REASON);
    }
    expect(screen.getByRole("button", { name: "Save settings" })).toHaveAttribute("title", PLAN_REFUSAL_REASON);
    expect(screen.getByRole("button", { name: /^Save deadlines/ })).toHaveAttribute("title", PLAN_REFUSAL_REASON);
  });

  it("never calls the server", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save deadlines/ }));
    expect(saveSocialSettings).not.toHaveBeenCalled();
    expect(saveCycleDeadlines).not.toHaveBeenCalled();
  });

  it("with canPlan the same controls are enabled and carry no reason", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue(ok(settings({ canPlan: true })));
    vi.mocked(getCycleTable).mockResolvedValue(ok(table({ canPlan: true })));
    vi.mocked(getAllocation).mockResolvedValue(ok([alloc({ canPlan: true })]));
    await mount();
    expect(screen.getByLabelText(/Buffer \(working days\)/)).toBeEnabled();
    expect(screen.getByLabelText("Deadline for Brand Alpha")).toBeEnabled();
    expect(screen.queryByText(PLAN_REFUSAL_REASON)).not.toBeInTheDocument();
  });
});

describe("refused and failed reads are never an empty page", () => {
  it("a 403 on either read is the 'no access' state", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/Social Media settings/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("a failed read says it cannot tell", async () => {
    vi.mocked(getCycleTable).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText(/platform 500/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

// SCP-5 W5-A6 (BFF §63.24.9): the Report automation section sits below the deadline table, for the four only, and is never an empty section that implies there is nothing.
describe("Report automation", () => {
  const schedule = () => asSchedule({
    id: "s1", kind: "weekly", scope: "all", clients: [], timing: { weekday: 1, at: "08:00" }, timingText: "Every Monday at 08:00, for the week before", enabled: true, pausedReason: null,
    owner: { id: "u-2", name: "Sam Officer" }, nextRunAt: "2026-10-19T08:00:00.000Z", nextPeriod: "2026-W42", lastRunAt: null, lastPeriod: null, lastRun: null,
    spend: { last30Days: { runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null }, monthToDate: { runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null } },
  });
  it("shows the section after the deadlines when the server lets the person read schedules, and offers the allocation clients to the picker", async () => {
    vi.mocked(getReportSchedules).mockResolvedValue(ok([schedule()]));
    await mount();
    expect(getReportSchedules).toHaveBeenCalledWith("u-1", "co-a");
    const heading = screen.getByRole("heading", { name: "Report automation" });
    expect(heading.compareDocumentPosition(screen.getByRole("heading", { name: "Deadlines" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Weekly report" })).toHaveTextContent("Every Monday at 08:00, for the week before");
    fireEvent.click(screen.getByRole("button", { name: "Add a schedule" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("radio", { name: /Only these clients/ }));
    expect(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "Brand Beta" })).toBeInTheDocument();
  });
  it("is hidden, and not even read, without canPlan", async () => {
    vi.mocked(getSocialSettings).mockResolvedValue(ok(settings({ canPlan: false })));
    await mount();
    expect(screen.queryByRole("heading", { name: "Report automation" })).not.toBeInTheDocument();
    expect(getReportSchedules).not.toHaveBeenCalled();
  });
  it("is hidden when the server refuses the read", async () => {
    await mount();
    expect(screen.queryByRole("heading", { name: "Report automation" })).not.toBeInTheDocument();
  });
  it("says it cannot tell when the read fails", async () => {
    vi.mocked(getReportSchedules).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByRole("heading", { name: "Report automation" })).toBeInTheDocument();
    expect(screen.getByText(/cannot be shown right now \(platform 500\)/)).toBeInTheDocument();
  });
});

// SCP-5 W5-C5 (BFF §63.30.5): the company's rules sit between the deadline table and Report automation, one section each. A refused read says so and a failed one says it cannot tell: neither draws the defaults.
describe("Company rules", () => {
  it("reads the rules for the signed-in person and draws the Reports section after the deadlines and before Report automation", async () => {
    vi.mocked(getReportSchedules).mockResolvedValue(ok([]));
    await mount();
    expect(getRules).toHaveBeenCalledWith("u-1", "co-a");
    const reports = screen.getByRole("heading", { name: "Reports" });
    expect(screen.getByRole("heading", { name: "Deadlines" }).compareDocumentPosition(reports) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reports.compareDocumentPosition(screen.getByRole("heading", { name: "Report automation" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "Report rules" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Ideas for next month" })).toBeInTheDocument();
  });
  it("offers the allocation's open clients to the previews", async () => {
    await mount();
    const pick = screen.getAllByLabelText("For client")[0];
    expect(within(pick).getByRole("option", { name: "Brand Alpha" })).toBeInTheDocument();
  });
  it("shows the values read-only to a person who cannot edit, and still draws the sections", async () => {
    vi.mocked(getRules).mockResolvedValue(ok(rulesAnswer({ canEdit: false })));
    await mount();
    expect(screen.getByRole("region", { name: "Report rules" })).toBeInTheDocument();
    expect(screen.getByLabelText("The fiscal year starts in")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save report rules" })).not.toBeInTheDocument();
  });
  it("says the rules cannot be shown for a refused read, and draws no values", async () => {
    vi.mocked(getRules).mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByRole("heading", { name: "Company rules" })).toBeInTheDocument();
    expect(screen.getByText(/rules cannot be shown to you/)).toBeInTheDocument();
    expect(screen.queryByLabelText("The fiscal year starts in")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deadlines" })).toBeInTheDocument();
  });
  it("says it cannot tell for a failed read, never the defaults", async () => {
    vi.mocked(getRules).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount();
    expect(screen.getByText(/cannot be shown right now \(platform 500\)\. They are not lost, and they are not the defaults/)).toBeInTheDocument();
    expect(screen.queryByLabelText("The fiscal year starts in")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reports" })).not.toBeInTheDocument();
  });
});
