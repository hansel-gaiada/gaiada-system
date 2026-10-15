import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-5 — /hr/settings: the tabs (each reads only what it shows), the honest lists (a refused or failed read is said in
// words, never an empty table, and a KPI whose read failed shows a dash), and the write controls per capability
// (hr.policy.manage shows every form; a read-only reader sees none; the delete asks first).

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const me = { userId: "u-1", roles: [] as { role: string; scopeType: string; scopeId: string | null }[], companies: [] };
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => me) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/hrPolicyActions", () => ({
  createCalendar: vi.fn(), addHoliday: vi.fn(), deleteHoliday: vi.fn(), createLeavePolicy: vi.fn(), updateLeavePolicy: vi.fn(),
  assignLeavePolicy: vi.fn(), createPayGrade: vi.fn(), createParameterSet: vi.fn(),
}));
vi.mock("@/lib/hr-full", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hr-full")>()),
  formatMoney: (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : `Rp ${v}`),
}));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let calendarsRead: Read, holidaysRead: Read, workingRead: Read, policiesRead: Read, assignmentsRead: Read, gradesRead: Read;
let setsRead: Read, stagesRead: Read, employeesRead: Read;
const spies = { holidays: vi.fn(), working: vi.fn(), assignments: vi.fn(), grades: vi.fn(), employees: vi.fn() };
vi.mock("@/lib/hr-full-data", () => ({
  listCalendarsResult: vi.fn(async () => calendarsRead),
  listHolidaysResult: vi.fn(async (_u: string, _t: string, id: string) => { spies.holidays(id); return holidaysRead; }),
  getWorkingDaysResult: vi.fn(async (...a: unknown[]) => { spies.working(a.slice(2)); return workingRead; }),
  listLeavePoliciesResult: vi.fn(async () => policiesRead),
  listPolicyAssignmentsResult: vi.fn(async (_u: string, _t: string, id: string) => { spies.assignments(id); return assignmentsRead; }),
  listPayGradesResult: vi.fn(async () => { spies.grades(); return gradesRead; }),
  listParameterSetsResult: vi.fn(async () => setsRead),
  listPipelineStagesResult: vi.fn(async () => stagesRead),
  listEmployeesResult: vi.fn(async () => { spies.employees(); return employeesRead; }),
}));

const calendar = (over: Record<string, unknown> = {}) => ({ id: "cal1", name: "Indonesia", countryCode: "ID", weekendDays: [6, 7], isDefault: true, holidayCount: 2, ...over });
const holiday = (over: Record<string, unknown> = {}) => ({ id: "h1", day: "2026-08-17", name: "Independence Day", kind: "public", deductsEntitlement: null, ...over });
const policy = (over: Record<string, unknown> = {}) => ({
  id: "lp1", name: "Annual leave", leaveType: "vacation", accrualMethod: "upfront", annualEntitlementMinutes: 5760, waitingPeriodMonths: 12,
  prorateFirstYear: true, carryoverMaxMinutes: 2400, carryoverExpiryMonths: 3, allowNegativeBalance: false, excludesHolidays: true,
  escalateOverMinutes: null, minNoticeDays: 0, isActive: true, ...over,
});
const grade = (over: Record<string, unknown> = {}) => ({
  id: "g1", code: "E3", name: "Engineer 3", track: "individual", level: 3, minAmount: "8000000", midAmount: "10000000", maxAmount: "12000000",
  currency: "IDR", rateBasis: "monthly", isActive: true, ...over,
});
const set = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "Indonesia 2026", countryCode: "ID", effectiveFrom: "2000-01-01", effectiveTo: null, ratifiedBy: null, ratifiedAt: null,
  sourceNote: null, parameterCount: 12, ...over,
});

import HrSettingsPage from "./page";

const as = (role: string) => { me.roles = [{ role, scopeType: "company", scopeId: "co-a" }]; };
async function renderPage(sp: Record<string, string> = {}) {
  render(await HrSettingsPage({ searchParams: Promise.resolve(sp) }));
}
// The card hint is a "?" button; it is not a control.
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent).filter((t) => t !== "?");

beforeEach(() => {
  for (const s of Object.values(spies)) s.mockReset();
  calendarsRead = { kind: "ok", data: [calendar()] };
  holidaysRead = { kind: "ok", data: [holiday(), holiday({ id: "h2", day: "2026-08-18", name: "Cuti bersama", kind: "joint_leave", deductsEntitlement: true })] };
  workingRead = { kind: "ok", data: { from: "2026-08-01", to: "2026-08-31", calendarId: "cal1", calendarDays: 31, workingDays: 19, weekendDays: 10, holidayDays: 1, jointLeaveChargedDays: 1, chargeableDays: 20 } };
  policiesRead = { kind: "ok", data: [policy()] };
  assignmentsRead = { kind: "ok", data: [
    { id: "a1", subjectUserId: "u-a", unitNodeId: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    { id: "a2", subjectUserId: null, unitNodeId: "dept-3", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" },
    { id: "a3", subjectUserId: null, unitNodeId: null, effectiveFrom: "2025-01-01", effectiveTo: null },
  ] };
  gradesRead = { kind: "ok", data: [grade()] };
  setsRead = { kind: "ok", data: [set()] };
  stagesRead = { kind: "ok", data: [{ id: "st1", key: "applied", label: "Applied", sortOrder: 1, isTerminal: false, terminalKind: null, requiresInterview: false, isActive: true }] };
  employeesRead = { kind: "ok", data: [{ id: "e1", userId: "u-a", displayName: "Budi", employmentStatus: "active" }] };
});
afterEach(() => cleanup());

describe("/hr/settings — layout", () => {
  it("shows the five tabs as links and marks the current one, defaulting to holiday calendars and ignoring an unknown tab", async () => {
    as("hr_manager");
    await renderPage({ tab: "bogus" });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.querySelectorAll("a")).toHaveLength(5);
    expect(screen.getByRole("link", { name: "Holiday calendars" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Statutory parameters" })).toHaveAttribute("href", "/hr/settings?tab=statutory");
  });

  it("KPI tiles say they cannot be read when their reads fail, never a zero", async () => {
    as("hr_manager");
    calendarsRead = { kind: "forbidden" };
    policiesRead = { kind: "unavailable", reason: "platform 500" };
    stagesRead = { kind: "forbidden" };
    setsRead = { kind: "unavailable", reason: "platform 503" };
    await renderPage();
    expect(screen.getAllByText("cannot be read")).toHaveLength(4);
  });

  it("only the current tab reads what it shows", async () => {
    as("hr_manager");
    await renderPage({ tab: "funnel" });
    expect(spies.grades).not.toHaveBeenCalled();
    expect(spies.holidays).not.toHaveBeenCalled();
    expect(spies.employees).not.toHaveBeenCalled();
    expect(screen.getByText("1. Applied")).toBeInTheDocument();
  });
});

describe("/hr/settings — calendars tab", () => {
  it("lists the calendars with weekend names, and offers the add form to hr.policy.manage", async () => {
    as("hr_manager");
    await renderPage({ tab: "calendars" });
    expect(screen.getAllByText("Indonesia · default").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Sat, Sun")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Holidays of Indonesia" })).toHaveAttribute("href", "/hr/settings?tab=calendars&calendar=cal1");
    expect(buttons()).toContain("Add calendar");
  });

  it("a refused calendar read is said in words, not as no calendar", async () => {
    as("hr_manager");
    calendarsRead = { kind: "forbidden" };
    await renderPage({ tab: "calendars" });
    expect(screen.getByText(/You don't have access to the holiday calendars/)).toBeInTheDocument();
    expect(screen.queryByText(/No calendar\./)).toBeNull();
  });

  it("says there is no calendar only when the server answered an empty list", async () => {
    as("hr_manager");
    calendarsRead = { kind: "ok", data: [] };
    await renderPage({ tab: "calendars" });
    expect(screen.getByText(/No calendar\./)).toBeInTheDocument();
  });

  it("shows the selected calendar's holidays, with the add form and a confirmed delete for hr.policy.manage", async () => {
    as("hr_manager");
    await renderPage({ tab: "calendars", calendar: "cal1" });
    expect(spies.holidays).toHaveBeenCalledWith("cal1");
    expect(screen.getByText("Independence Day")).toBeInTheDocument();
    expect(screen.getByText("Cuti bersama")).toBeInTheDocument();
    expect(buttons()).toContain("Add a holiday");
    fireEvent.click(screen.getByRole("button", { name: "Delete Independence Day on 2026-08-17" }));
    expect(screen.getByRole("group", { name: "Confirm deleting Independence Day on 2026-08-17" })).toBeInTheDocument();
  });

  it("offers no add and no delete to a read-only reader", async () => {
    as("hr_staff");
    await renderPage({ tab: "calendars", calendar: "cal1" });
    expect(screen.getByText("Independence Day")).toBeInTheDocument();
    // The one button is the working-day check's own (a GET), not a write.
    expect(buttons()).toEqual(["Count working days"]);
  });

  it("says a refused holiday read in words, not as no holidays", async () => {
    as("hr_manager");
    holidaysRead = { kind: "unavailable", reason: "platform 500" };
    await renderPage({ tab: "calendars", calendar: "cal1" });
    expect(screen.getByText(/This calendar's holidays cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText(/no holidays yet/)).toBeNull();
  });

  it("says when a requested calendar is not in the list", async () => {
    as("hr_manager");
    await renderPage({ tab: "calendars", calendar: "gone" });
    expect(screen.getByText(/That calendar is not in this company's list/)).toBeInTheDocument();
    expect(spies.holidays).not.toHaveBeenCalled();
  });

  it("runs the working-day check from the query string against the chosen calendar, and shows the server's counts", async () => {
    as("hr_staff");
    await renderPage({ tab: "calendars", calendar: "cal1", from: "2026-08-01", to: "2026-08-31" });
    expect(spies.working).toHaveBeenCalledWith(["2026-08-01", "2026-08-31", "cal1"]);
    expect(screen.getByText("19")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
  });

  it("says a bad range in the server's words, not as zero days", async () => {
    as("hr_staff");
    workingRead = { kind: "unavailable", reason: "to must be >= from" };
    await renderPage({ tab: "calendars", from: "2026-09-01", to: "2026-08-01" });
    expect(screen.getByText("to must be >= from")).toBeInTheDocument();
    expect(spies.working).toHaveBeenCalledWith(["2026-09-01", "2026-08-01", "cal1"]);
  });
});

describe("/hr/settings — leave policies tab", () => {
  it("lists the policies in days and offers add and a Manage link per policy", async () => {
    as("hr_manager");
    await renderPage({ tab: "leave" });
    expect(screen.getByText("Annual leave")).toBeInTheDocument();
    expect(screen.getByText("12d")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage Annual leave" })).toHaveAttribute("href", "/hr/settings?tab=leave&policy=lp1");
    expect(buttons()).toContain("Add leave policy");
    expect(spies.assignments).not.toHaveBeenCalled();
  });

  it("a refused policy read is said in words, not as no policies", async () => {
    as("hr_manager");
    policiesRead = { kind: "forbidden" };
    await renderPage({ tab: "leave" });
    expect(screen.getByText(/You don't have access to the leave policies/)).toBeInTheDocument();
    expect(screen.queryByText(/No leave policies\./)).toBeNull();
  });

  it("shows the selected policy's assignments with who they apply to, and the edit and assign controls to hr.policy.manage", async () => {
    as("hr_manager");
    await renderPage({ tab: "leave", policy: "lp1" });
    expect(spies.assignments).toHaveBeenCalledWith("lp1");
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.getByText("Org unit dept-3")).toBeInTheDocument();
    expect(screen.getByText("Everyone in the company (default)")).toBeInTheDocument();
    expect(buttons()).toEqual(expect.arrayContaining(["Edit this policy", "Assign this policy"]));
  });

  it("says a refused assignment read in words, not as unassigned", async () => {
    as("hr_staff");
    assignmentsRead = { kind: "forbidden" };
    await renderPage({ tab: "leave", policy: "lp1" });
    expect(screen.getByText(/You don't have access to this policy's assignments/)).toBeInTheDocument();
    expect(screen.queryByText(/not assigned to anyone yet/)).toBeNull();
    expect(buttons()).toEqual([]);
  });

  it("with the employee list refused, offers the edit but says so in place of the assign form", async () => {
    as("hr_manager");
    employeesRead = { kind: "forbidden" };
    await renderPage({ tab: "leave", policy: "lp1" });
    expect(screen.getByText(/You don't have access to the employee list/)).toBeInTheDocument();
    expect(buttons()).toContain("Edit this policy");
    expect(buttons()).not.toContain("Assign this policy");
    // A person is named only when the list was read; otherwise nothing is claimed.
    expect(screen.getByText("A person (name not shown)")).toBeInTheDocument();
  });
});

describe("/hr/settings — pay grades tab", () => {
  it("lists the grades and offers the add form to hr.policy.manage", async () => {
    as("hr_manager");
    await renderPage({ tab: "grades" });
    expect(screen.getByText("E3 · Engineer 3")).toBeInTheDocument();
    expect(screen.getByText("Rp 8000000 – Rp 12000000 (mid Rp 10000000)")).toBeInTheDocument();
    expect(buttons()).toContain("Add pay grade");
  });

  it("offers nothing to write to a reader, and says a refused read in words", async () => {
    as("hr_staff");
    gradesRead = { kind: "forbidden" };
    await renderPage({ tab: "grades" });
    expect(screen.getByText(/You don't have access to the pay grades/)).toBeInTheDocument();
    expect(screen.queryByText(/No grade structure defined/)).toBeNull();
    expect(buttons()).toEqual([]);
  });

  it("says no structure only when the server answered an empty list", async () => {
    as("hr_staff");
    gradesRead = { kind: "ok", data: [] };
    await renderPage({ tab: "grades" });
    expect(screen.getByText(/No grade structure defined/)).toBeInTheDocument();
  });
});

describe("/hr/settings — statutory tab", () => {
  it("lists the sets, each linking to its own page, and offers the add form to hr.policy.manage", async () => {
    as("hr_manager");
    await renderPage({ tab: "statutory" });
    expect(screen.getByRole("link", { name: "Indonesia 2026" })).toHaveAttribute("href", "/hr/settings/statutory/s1");
    expect(screen.getAllByText(/^unratified$/i).length).toBeGreaterThanOrEqual(1);
    expect(buttons()).toContain("Add parameter set");
    // Ratify is on the set's own page, beside its numbers, never in the list.
    expect(buttons()).not.toContain("Ratify this set");
  });

  it("a failed read is said in words, not as no parameter sets", async () => {
    as("hr_manager");
    setsRead = { kind: "unavailable", reason: "platform 500" };
    await renderPage({ tab: "statutory" });
    expect(screen.getByText(/The statutory parameter sets cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText(/No parameter sets configured/)).toBeNull();
  });

  it("offers no add to a reader", async () => {
    as("hr_staff");
    await renderPage({ tab: "statutory" });
    expect(buttons()).toEqual([]);
  });
});

describe("/hr/settings — funnel tab", () => {
  it("is read-only here and points to the recruitment page", async () => {
    as("hr_manager");
    await renderPage({ tab: "funnel" });
    expect(buttons()).toEqual([]);
    expect(screen.getByRole("link", { name: "recruitment" })).toHaveAttribute("href", "/hr/recruitment");
  });

  it("a refused stage read is said in words, not as no stages", async () => {
    as("hr_manager");
    stagesRead = { kind: "forbidden" };
    await renderPage({ tab: "funnel" });
    expect(screen.getAllByText(/You don't have access to the recruitment stages/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/No stages defined/)).toBeNull();
  });
});
