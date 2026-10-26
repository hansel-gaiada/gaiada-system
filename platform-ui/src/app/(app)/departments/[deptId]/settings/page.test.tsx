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

import { getDepartment } from "@/lib/departments";
import { getCycleTable, getSocialSettings } from "@/lib/socialCycles-data";
import { saveCycleDeadlines, saveSocialSettings } from "@/lib/socialCyclesActions";
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
    const t = screen.getByRole("table");
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
  it("holds a marked slot for the step estimates (SCP-1a builds the route)", async () => {
    const { container } = await mount();
    const slot = container.querySelector('[data-slot="step-estimates"]')!;
    expect(slot).not.toBeNull();
    expect(within(slot as HTMLElement).getByRole("heading", { name: "Step estimates" })).toBeInTheDocument();
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
  });

  it("still shows the values and the table", async () => {
    await mount();
    expect(screen.getByLabelText(/Buffer \(working days\)/)).toHaveValue(1);
    expect(screen.getByText("Brand Alpha")).toBeInTheDocument();
    expect(screen.getByText("On track · 3 spare days")).toBeInTheDocument();
  });

  it("disables the inputs and the buttons, each pointing at the reason in words and as a title", async () => {
    await mount();
    const reasons = screen.getAllByText(PLAN_REFUSAL_REASON);
    expect(reasons.length).toBeGreaterThanOrEqual(2); // one under the settings, one under the table
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
