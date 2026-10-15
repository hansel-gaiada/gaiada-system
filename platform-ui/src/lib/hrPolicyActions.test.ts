import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import {
  createReviewCycle, updateReviewCycle, addReviewParticipants, updateReviewParticipant, createCalendar, addHoliday, deleteHoliday,
  createLeavePolicy, updateLeavePolicy, assignLeavePolicy, createPayGrade, createParameterSet, ratifyParameterSet,
} from "./hrPolicyActions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-active") }));
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  platformFetch: vi.fn(),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [] })),
}));

// DW-7f-4 and DW-7f-5 — the review-cycle and HR-policy write actions. Backend: platform-nest hr-policy.controller.ts (Cerbos kind
// hr_policy: create/update/delete for hr_manager and company_admin, ratify for company_admin at high assurance). The routes
// 400 on a missing field, 404 on an unknown id; the database answers overlaps and duplicates in its own words.

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

function form(over: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(over)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}
const lastCall = () => {
  const [path, user, init] = vi.mocked(platformFetch).mock.calls[0];
  const req = init as RequestInit;
  return { path, user, init: req, body: req.body ? JSON.parse(String(req.body)) : undefined };
};
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
const BASE = "/api/co-a/modules/hr";

/** The refusals every action shares: a worded 403, the server's own 400/404/409 sentence, the generic fallback, no session. */
function sharedRefusals(name: string, call: () => Promise<{ ok: boolean; error?: string }>, forbidden: string) {
  it(`${name}: words a 403, passes the server's 400, 404 and 409 sentences back as sent, and revalidates nothing`, async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await call()).toEqual({ ok: false, error: `You don't have permission to ${forbidden}.` });
    for (const [status, text] of [[400, "periodEnd must be >= periodStart"], [404, "review cycle not found"], [409, "duplicate key value violates unique constraint"]] as const) {
      vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(status, text));
      expect((await call()).error).toBe(text);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it(`${name}: falls back to the raw body's message when the error text is the generic one`, async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "platform 400", undefined, undefined, undefined, { message: ["name required"] }));
    expect((await call()).error).toBe("name required");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(500, "platform 500"));
    expect((await call()).error).toBe("platform 500");
  });

  it(`${name}: does nothing without a session`, async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await call()).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
}

const refusesAll = async (call: (over: Record<string, string | string[]>) => Promise<{ ok: boolean }>, cases: Record<string, string | string[]>[]) => {
  for (const over of cases) expect((await call(over)).ok, JSON.stringify(over)).toBe(false);
  expect(platformFetch).not.toHaveBeenCalled();
};

// ═══════════════════════════════════════════════════════════ review cycles ═════════════════
describe("createReviewCycle", () => {
  const cycle = (over: Record<string, string> = {}) => form({
    name: "  2026 H2  ", kind: "probation", periodStart: "2026-07-01", periodEnd: "2026-12-31", opensOn: "2027-01-02", closesOn: "2027-01-31", ...over,
  });

  it("posts to review-cycles with the typed values and only the dates that were filled, then revalidates the reviews pages", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "c-1" });
    const r = await createReviewCycle("co-a", cycle());
    expect(r.ok).toBe(true);
    expect(r.id).toBe("c-1");
    expect(r.notice).toContain("draft");
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-cycles`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ name: "2026 H2", kind: "probation", periodStart: "2026-07-01", periodEnd: "2026-12-31", opensOn: "2027-01-02", closesOn: "2027-01-31" });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("omits a blank window, defaults the kind to periodic and falls back to the active company", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "c-1" });
    await createReviewCycle("", cycle({ kind: "", opensOn: "", closesOn: "" }));
    expect(lastCall().path).toBe("/api/co-active/modules/hr/review-cycles");
    expect(lastCall().body).toEqual({ name: "2026 H2", kind: "periodic", periodStart: "2026-07-01", periodEnd: "2026-12-31" });
  });

  it("refuses bad input without calling the server", async () => {
    await refusesAll((o) => createReviewCycle("co-a", cycle(o as Record<string, string>)), [
      { name: "" }, { kind: "yearly" }, { periodStart: "" }, { periodEnd: "31/12/2026" }, { periodEnd: "2026-06-30" },
      { opensOn: "tomorrow" }, { opensOn: "2027-02-01", closesOn: "2027-01-31" },
    ]);
  });
  sharedRefusals("createReviewCycle", () => createReviewCycle("co-a", cycle()), "create review cycles");
});

describe("updateReviewCycle", () => {
  const edit = (over: Record<string, string> = {}) => form({ name: "2026 H2", status: "open", opensOn: "2027-01-02", closesOn: "", ...over });

  it("patches the cycle with name, status and the window, a blank date sent as null to clear it", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateReviewCycle("co-a", "c-1", edit());
    expect(r).toMatchObject({ ok: true, id: "c-1" });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-cycles/c-1`);
    expect(c.init.method).toBe("PATCH");
    expect(c.body).toEqual({ name: "2026 H2", status: "open", opensOn: "2027-01-02", closesOn: null });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("accepts every status from any other: the server has no status machine", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    for (const status of ["draft", "open", "closed", "cancelled"]) {
      expect((await updateReviewCycle("co-a", "c-1", edit({ status }))).ok).toBe(true);
    }
  });

  it("refuses bad input without calling the server", async () => {
    await refusesAll((o) => updateReviewCycle("co-a", "c-1", edit(o as Record<string, string>)), [
      { name: "" }, { status: "" }, { status: "archived" }, { opensOn: "soon" }, { opensOn: "2027-02-01", closesOn: "2027-01-31" },
    ]);
    expect((await updateReviewCycle("co-a", "", edit())).ok).toBe(false);
  });
  sharedRefusals("updateReviewCycle", () => updateReviewCycle("co-a", "c-1", edit()), "edit review cycles");
});

describe("addReviewParticipants", () => {
  const people = (over: Record<string, string | string[]> = {}) => form({ subjectUserId: ["u-a", "u-b", "u-a"], reviewerUserId: "u-r", dueOn: "2027-01-15", ...over });

  it("posts the ticked people once each, with the reviewer and due date on every one, and counts what the server added", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ cycleId: "c-1", added: 2 });
    const r = await addReviewParticipants("co-a", "c-1", people());
    expect(r).toMatchObject({ ok: true, id: "c-1", notice: "2 people added." });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-cycles/c-1/participants`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ participants: [
      { subjectUserId: "u-a", reviewerUserId: "u-r", dueOn: "2027-01-15" },
      { subjectUserId: "u-b", reviewerUserId: "u-r", dueOn: "2027-01-15" },
    ] });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("omits a blank reviewer and due date", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ cycleId: "c-1", added: 1 });
    await addReviewParticipants("co-a", "c-1", people({ subjectUserId: "u-a", reviewerUserId: "", dueOn: "" }));
    expect(lastCall().body).toEqual({ participants: [{ subjectUserId: "u-a" }] });
  });

  it("says when the server skipped people already in the cycle, and when it added nobody", async () => {
    vi.mocked(platformFetch).mockResolvedValueOnce({ cycleId: "c-1", added: 1 });
    expect((await addReviewParticipants("co-a", "c-1", people())).notice).toBe("1 of 2 added; the rest were already in this cycle.");
    vi.mocked(platformFetch).mockResolvedValueOnce({ cycleId: "c-1", added: 0 });
    expect((await addReviewParticipants("co-a", "c-1", people())).notice).toBe("Nobody was added: all of them are already in this cycle.");
    vi.mocked(platformFetch).mockResolvedValueOnce({ cycleId: "c-1", added: 0 });
    expect((await addReviewParticipants("co-a", "c-1", people({ subjectUserId: "u-a" }))).notice).toBe("Nobody was added: that person is already in this cycle.");
    vi.mocked(platformFetch).mockResolvedValueOnce({});
    expect((await addReviewParticipants("co-a", "c-1", people())).notice).toContain("did not say how many");
  });

  it("refuses an empty selection and a bad due date without calling the server", async () => {
    await refusesAll((o) => addReviewParticipants("co-a", "c-1", people(o)), [{ subjectUserId: [] }, { subjectUserId: ["", " "] }, { dueOn: "next week" }]);
  });
  sharedRefusals("addReviewParticipants", () => addReviewParticipants("co-a", "c-1", people()), "add review participants");
});

describe("updateReviewParticipant", () => {
  const upd = (over: Record<string, string> = {}) => form({ participantId: "p-1", status: "submitted", outcome: "pass", outcomeNote: " Solid ", reviewerUserId: "", ...over });

  it("patches only the filled fields, and says the server records the submission time", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateReviewParticipant("co-a", upd());
    expect(r).toMatchObject({ ok: true, id: "p-1" });
    expect(r.notice).toContain("submission time");
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/review-participants/p-1`);
    expect(c.init.method).toBe("PATCH");
    expect(c.body).toEqual({ status: "submitted", outcome: "pass", outcomeNote: "Solid" });
    expect(revalidated()).toEqual(["/hr/reviews", "/hr/reviews/[cycleId]"]);
  });

  it("can change just the reviewer", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateReviewParticipant("co-a", upd({ status: "", outcome: "", outcomeNote: "", reviewerUserId: "u-r" }));
    expect(r.notice).toBe("Participant updated.");
    expect(lastCall().body).toEqual({ reviewerUserId: "u-r" });
  });

  it("refuses a missing participant, an unknown status or outcome (the database would 500), and a change of nothing", async () => {
    await refusesAll((o) => updateReviewParticipant("co-a", upd(o as Record<string, string>)), [
      { participantId: "" }, { status: "done" }, { outcome: "great" },
      { status: "", outcome: "", outcomeNote: "", reviewerUserId: "" },
    ]);
  });
  sharedRefusals("updateReviewParticipant", () => updateReviewParticipant("co-a", upd()), "update review participants");
});

// ═══════════════════════════════════════════════════════════ calendars ═════════════════════
describe("createCalendar", () => {
  const cal = (over: Record<string, string | string[]> = {}) => form({ name: "Indonesia", countryCode: "id", weekendDays: ["7", "6"], isDefault: "on", ...over });

  it("posts the name, an upper-cased country, sorted weekend days and the default flag", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "cal-1" });
    const r = await createCalendar("co-a", cal());
    expect(r).toMatchObject({ ok: true, id: "cal-1" });
    expect(r.notice).toContain("default");
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/calendars`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ name: "Indonesia", countryCode: "ID", weekendDays: [6, 7], isDefault: true });
    expect(revalidated()).toEqual(["/hr/settings", "/hr/settings/statutory/[setId]"]);
  });

  it("is not the default unless ticked, and defaults the country to ID", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "cal-1" });
    const r = await createCalendar("co-a", cal({ isDefault: "", countryCode: "" }));
    expect(r.notice).toBe("Calendar created.");
    expect(lastCall().body).toMatchObject({ countryCode: "ID", isDefault: false });
  });

  it("refuses a calendar with no weekend day (the server would swap in Saturday and Sunday), a bad day, a bad country or no name", async () => {
    await refusesAll((o) => createCalendar("co-a", cal(o)), [
      { weekendDays: [] }, { weekendDays: ["0"] }, { weekendDays: ["8"] }, { weekendDays: ["x"] }, { countryCode: "IDN" }, { name: "" },
    ]);
  });
  sharedRefusals("createCalendar", () => createCalendar("co-a", cal()), "create holiday calendars");
});

describe("addHoliday", () => {
  const hol = (over: Record<string, string> = {}) => form({ day: "2026-08-17", name: "Independence Day", kind: "public", deductsEntitlement: "on", ...over });

  it("posts a one-item holidays list; deductsEntitlement is sent for joint leave only", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ calendarId: "cal-1", upserted: 1 });
    const r = await addHoliday("co-a", "cal-1", hol());
    expect(r).toMatchObject({ ok: true, id: "cal-1" });
    expect(r.notice).toContain("replaced");
    expect(lastCall().path).toBe(`${BASE}/calendars/cal-1/holidays`);
    expect(lastCall().init.method).toBe("POST");
    expect(lastCall().body).toEqual({ holidays: [{ day: "2026-08-17", name: "Independence Day", kind: "public" }] });
    vi.mocked(platformFetch).mockClear();
    vi.mocked(platformFetch).mockResolvedValue({ calendarId: "cal-1", upserted: 1 });
    await addHoliday("co-a", "cal-1", hol({ kind: "joint_leave", deductsEntitlement: "" }));
    expect(lastCall().body).toEqual({ holidays: [{ day: "2026-08-17", name: "Independence Day", kind: "joint_leave", deductsEntitlement: false }] });
    expect(revalidated()).toContain("/hr/settings");
  });

  it("refuses bad input without calling the server", async () => {
    await refusesAll((o) => addHoliday("co-a", "cal-1", hol(o as Record<string, string>)), [{ day: "" }, { day: "17-08-2026" }, { name: "" }, { kind: "bank" }]);
    expect((await addHoliday("co-a", "", hol())).ok).toBe(false);
  });
  sharedRefusals("addHoliday", () => addHoliday("co-a", "cal-1", hol()), "add holidays");
});

describe("deleteHoliday", () => {
  it("sends a DELETE with no body and revalidates the settings page", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await deleteHoliday("co-a", "h-1");
    expect(r).toEqual({ ok: true, id: "h-1", notice: "Holiday deleted." });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/holidays/h-1`);
    expect(c.init.method).toBe("DELETE");
    expect(c.init.body).toBeUndefined();
    expect(revalidated()).toContain("/hr/settings");
  });
  it("refuses a missing id without calling the server", async () => {
    expect((await deleteHoliday("co-a", "")).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
  sharedRefusals("deleteHoliday", () => deleteHoliday("co-a", "h-1"), "delete holidays");
});

// ═══════════════════════════════════════════════════════════ leave policies ════════════════
describe("createLeavePolicy", () => {
  const pol = (over: Record<string, string> = {}) => form({
    name: " Annual leave ", leaveType: "vacation", accrualMethod: "monthly", annualEntitlementDays: "12", waitingPeriodMonths: "12",
    carryoverMaxDays: "5", carryoverExpiryMonths: "3", minNoticeDays: "7", escalateOverDays: "5.5",
    prorateFirstYear: "on", excludesHolidays: "on", ...over,
  });

  it("posts days as minutes (480 a day), the ticks as booleans and the leave type", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "lp-1" });
    const r = await createLeavePolicy("co-a", pol());
    expect(r).toMatchObject({ ok: true, id: "lp-1" });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/leave-policies`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      name: "Annual leave", accrualMethod: "monthly", leaveType: "vacation",
      annualEntitlementMinutes: 5760, waitingPeriodMonths: 12, carryoverMaxMinutes: 2400, carryoverExpiryMonths: 3, minNoticeDays: 7,
      escalateOverMinutes: 2640, prorateFirstYear: true, allowNegativeBalance: false, excludesHolidays: true,
    });
    expect(revalidated()).toContain("/hr/settings");
  });

  it("omits blank numbers, defaults the accrual to upfront and sends no escalation when blank", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "lp-1" });
    await createLeavePolicy("co-a", pol({
      accrualMethod: "", annualEntitlementDays: "", waitingPeriodMonths: "", carryoverMaxDays: "", carryoverExpiryMonths: "", minNoticeDays: "", escalateOverDays: "",
    }));
    expect(lastCall().body).toEqual({
      name: "Annual leave", accrualMethod: "upfront", leaveType: "vacation", prorateFirstYear: true, allowNegativeBalance: false, excludesHolidays: true,
    });
  });

  it("refuses bad input without calling the server", async () => {
    await refusesAll((o) => createLeavePolicy("co-a", pol(o as Record<string, string>)), [
      { name: "" }, { leaveType: "" }, { leaveType: "paid" }, { accrualMethod: "weekly" }, { annualEntitlementDays: "-1" },
      { waitingPeriodMonths: "61" }, { waitingPeriodMonths: "1.5" }, { carryoverExpiryMonths: "25" }, { minNoticeDays: "-2" },
      { escalateOverDays: "0" }, { carryoverMaxDays: "abc" },
    ]);
  });
  sharedRefusals("createLeavePolicy", () => createLeavePolicy("co-a", pol()), "create leave policies");
});

describe("updateLeavePolicy", () => {
  const pol = (over: Record<string, string> = {}) => form({
    name: "Annual leave", accrualMethod: "upfront", annualEntitlementDays: "12", waitingPeriodMonths: "12", carryoverMaxDays: "0",
    carryoverExpiryMonths: "0", minNoticeDays: "0", escalateOverDays: "", isActive: "on", ...over,
  });

  it("patches every editable field, a blank escalation as null and an unticked box as false", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await updateLeavePolicy("co-a", "lp-1", pol());
    expect(r).toMatchObject({ ok: true, id: "lp-1" });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/leave-policies/lp-1`);
    expect(c.init.method).toBe("PATCH");
    expect(c.body).toEqual({
      name: "Annual leave", accrualMethod: "upfront", annualEntitlementMinutes: 5760, waitingPeriodMonths: 12, carryoverMaxMinutes: 0,
      carryoverExpiryMonths: 0, minNoticeDays: 0, escalateOverMinutes: null, isActive: true,
      prorateFirstYear: false, allowNegativeBalance: false, excludesHolidays: false,
    });
    expect(c.body).not.toHaveProperty("leaveType");
  });

  it("deactivates with isActive false and sets an escalation threshold in minutes", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    await updateLeavePolicy("co-a", "lp-1", pol({ isActive: "", escalateOverDays: "10" }));
    expect(lastCall().body).toMatchObject({ isActive: false, escalateOverMinutes: 4800 });
  });

  it("refuses a blank number (the form always fills them), a bad value or no id", async () => {
    await refusesAll((o) => updateLeavePolicy("co-a", "lp-1", pol(o as Record<string, string>)), [
      { name: "" }, { accrualMethod: "" }, { accrualMethod: "weekly" }, { annualEntitlementDays: "" }, { waitingPeriodMonths: "" },
      { carryoverMaxDays: "" }, { carryoverExpiryMonths: "" }, { minNoticeDays: "" }, { waitingPeriodMonths: "99" },
    ]);
    expect((await updateLeavePolicy("co-a", "", pol())).ok).toBe(false);
  });
  sharedRefusals("updateLeavePolicy", () => updateLeavePolicy("co-a", "lp-1", pol()), "edit leave policies");
});

describe("assignLeavePolicy", () => {
  const asg = (over: Record<string, string> = {}) => form({ target: "person", subjectUserId: "u-a", unitNodeId: "", effectiveFrom: "2026-01-01", effectiveTo: "", ...over });

  it("posts one target at most: a person, a unit, or neither for the company default", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "a-1" });
    expect(await assignLeavePolicy("co-a", "lp-1", asg())).toMatchObject({ ok: true, id: "a-1" });
    expect(lastCall().path).toBe(`${BASE}/leave-policies/lp-1/assignments`);
    expect(lastCall().init.method).toBe("POST");
    expect(lastCall().body).toEqual({ effectiveFrom: "2026-01-01", subjectUserId: "u-a" });
    vi.mocked(platformFetch).mockClear();
    vi.mocked(platformFetch).mockResolvedValue({ id: "a-2" });
    await assignLeavePolicy("co-a", "lp-1", asg({ target: "unit", unitNodeId: "dept-3", subjectUserId: "u-a", effectiveTo: "2026-12-31" }));
    expect(lastCall().body).toEqual({ effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", unitNodeId: "dept-3" });
    vi.mocked(platformFetch).mockClear();
    vi.mocked(platformFetch).mockResolvedValue({ id: "a-3" });
    await assignLeavePolicy("co-a", "lp-1", asg({ target: "tenant", subjectUserId: "u-a", unitNodeId: "dept-3" }));
    expect(lastCall().body).toEqual({ effectiveFrom: "2026-01-01" });
    expect(revalidated()).toContain("/hr/settings");
  });

  it("refuses a target with nothing chosen, a bad date or an end before the start", async () => {
    await refusesAll((o) => assignLeavePolicy("co-a", "lp-1", asg(o as Record<string, string>)), [
      { target: "person", subjectUserId: "" }, { target: "unit", unitNodeId: "" }, { target: "group" }, { effectiveFrom: "" },
      { effectiveFrom: "1 Jan" }, { effectiveTo: "2025-12-31" },
    ]);
  });
  sharedRefusals("assignLeavePolicy", () => assignLeavePolicy("co-a", "lp-1", asg()), "assign leave policies");
});

// ═══════════════════════════════════════════════════════════ pay grades ════════════════════
describe("createPayGrade", () => {
  const grade = (over: Record<string, string> = {}) => form({
    code: "E3", name: "Engineer 3", track: "individual", level: "3", minAmount: "8000000.50", midAmount: "10000000", maxAmount: "12000000",
    currency: "idr", rateBasis: "monthly", ...over,
  });

  it("posts decimal band amounts as numbers with an upper-cased currency, and revalidates settings and compensation", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "g-1" });
    const r = await createPayGrade("co-a", grade());
    expect(r).toMatchObject({ ok: true, id: "g-1" });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/pay-grades`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      code: "E3", name: "Engineer 3", track: "individual", currency: "IDR", rateBasis: "monthly", minAmount: 8000000.5, maxAmount: 12000000,
      level: 3, midAmount: 10000000,
    });
    expect(revalidated()).toEqual(["/hr/settings", "/hr/compensation"]);
  });

  it("omits a blank level and midpoint, and defaults track, currency and rate basis", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "g-1" });
    await createPayGrade("co-a", grade({ level: "", midAmount: "", track: "", currency: "", rateBasis: "" }));
    expect(lastCall().body).toEqual({
      code: "E3", name: "Engineer 3", track: "individual", currency: "IDR", rateBasis: "monthly", minAmount: 8000000.5, maxAmount: 12000000,
    });
  });

  it("refuses bad input without calling the server, a band the database would refuse included", async () => {
    await refusesAll((o) => createPayGrade("co-a", grade(o as Record<string, string>)), [
      { code: "" }, { name: "" }, { track: "board" }, { rateBasis: "yearly" }, { currency: "RUPIAH" }, { level: "0" }, { level: "1.5" },
      { minAmount: "" }, { maxAmount: "" }, { minAmount: "-1" }, { minAmount: "abc" }, { minAmount: "1.005" },
      { maxAmount: "7000000" }, { midAmount: "7000000" }, { midAmount: "13000000" },
    ]);
  });
  sharedRefusals("createPayGrade", () => createPayGrade("co-a", grade()), "create pay grades");
});

// ═══════════════════════════════════════════════════════════ statutory parameters ══════════
describe("createParameterSet", () => {
  const set = (over: Record<string, string | string[]> = {}) => form({
    name: "Indonesia 2026", countryCode: "id", effectiveFrom: "2026-01-01", effectiveTo: "", sourceNote: "PMK 168/2023",
    paramKey: ["bpjs.kes.rate", "tax.brackets", ""],
    paramValueNum: ["0.04", "", ""],
    paramValueJson: ["", '[{"upTo":60000000,"rate":0.05}]', ""],
    paramUnit: ["rate", "", ""],
    paramNote: ["Employer share", "", ""],
    ...over,
  });

  it("posts the set with its parameters, skipping blank rows, and says it is unratified", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "s-1", ratified: false });
    const r = await createParameterSet("co-a", set());
    expect(r).toMatchObject({ ok: true, id: "s-1" });
    expect(r.notice).toContain("2 parameters, UNRATIFIED");
    expect(r.notice).toContain("override");
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/statutory-parameters`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      name: "Indonesia 2026", countryCode: "ID", effectiveFrom: "2026-01-01", sourceNote: "PMK 168/2023",
      parameters: [
        { key: "bpjs.kes.rate", valueNum: 0.04, unit: "rate", note: "Employer share" },
        { key: "tax.brackets", valueJson: [{ upTo: 60000000, rate: 0.05 }] },
      ],
    });
    expect(revalidated()).toEqual(["/hr/settings", "/hr/settings/statutory/[setId]"]);
  });

  it("can create a set with no parameters, with an end date", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "s-1", ratified: false });
    const r = await createParameterSet("co-a", set({ effectiveTo: "2026-12-31", sourceNote: "", paramKey: [], paramValueNum: [], paramValueJson: [], paramUnit: [], paramNote: [] }));
    expect(r.notice).toContain("0 parameters");
    expect(lastCall().body).toEqual({ name: "Indonesia 2026", countryCode: "ID", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", parameters: [] });
  });

  it("refuses bad input without calling the server: dates, units, one-of number or JSON, duplicate keys, bad JSON, too many decimals", async () => {
    const rows = (over: Partial<Record<"paramKey" | "paramValueNum" | "paramValueJson" | "paramUnit", string>>) => ({
      paramKey: [over.paramKey ?? "k"], paramValueNum: [over.paramValueNum ?? "1"], paramValueJson: [over.paramValueJson ?? ""],
      paramUnit: [over.paramUnit ?? ""], paramNote: [""],
    });
    await refusesAll((o) => createParameterSet("co-a", set(o)), [
      { name: "" }, { countryCode: "IDN" }, { effectiveFrom: "" }, { effectiveFrom: "Jan 1" }, { effectiveTo: "2025-12-31" },
      rows({ paramKey: "" }),                                   // a value with no key
      rows({ paramValueNum: "" }),                              // neither a number nor JSON
      rows({ paramValueJson: "[1]" }),                          // both
      rows({ paramUnit: "percent" }),                           // not in the unit CHECK
      rows({ paramValueNum: "", paramValueJson: "{not json" }), // not JSON
      rows({ paramValueNum: "", paramValueJson: "null" }),      // a JSON null counts as no value
      rows({ paramValueNum: "0.1234567" }),                     // numeric(18,6)
      rows({ paramValueNum: "1000000000000" }),                 // too many digits
      { paramKey: ["k", "k"], paramValueNum: ["1", "2"], paramValueJson: ["", ""], paramUnit: ["", ""], paramNote: ["", ""] }, // duplicate key
    ]);
  });
  sharedRefusals("createParameterSet", () => createParameterSet("co-a", set()), "create statutory parameter sets");
});

describe("ratifyParameterSet", () => {
  it("posts to ratify with the note, and says payroll needs no override from now on, with the server's date", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, ratified: true, ratifiedAt: "2026-10-15T08:00:00.000Z" });
    const r = await ratifyParameterSet("co-a", "s-1", "  PMK 168/2023 verified  ");
    expect(r).toEqual({
      ok: true, id: "s-1",
      notice: "Parameter set ratified on 2026-10-15. Payroll will use these parameters without an override from now on.",
    });
    const c = lastCall();
    expect(c.path).toBe(`${BASE}/statutory-parameters/s-1/ratify`);
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({ note: "PMK 168/2023 verified" });
    expect(revalidated()).toEqual(["/hr/settings", "/hr/settings/statutory/[setId]"]);
  });

  it("sends an empty body when there is no note", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true, ratified: true });
    await ratifyParameterSet("co-a", "s-1");
    expect(lastCall().body).toEqual({});
  });

  it("does not claim a ratification the server did not confirm", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ok: true });
    const r = await ratifyParameterSet("co-a", "s-1");
    expect(r.ok).toBe(true);
    expect(r.notice).toContain("did not confirm");
    expect(r.notice).not.toContain("without an override");
  });

  it("words a 403 with the high-assurance requirement, and passes the 'already ratified' 400 and the 404 back as sent", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    const denied = await ratifyParameterSet("co-a", "s-1");
    expect(denied.error).toContain("You don't have permission to ratify statutory parameters.");
    expect(denied.error).toContain("high-assurance sign-in");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "parameter set is already ratified"));
    expect((await ratifyParameterSet("co-a", "s-1")).error).toBe("parameter set is already ratified");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "parameter set not found"));
    expect((await ratifyParameterSet("co-a", "s-1")).error).toBe("parameter set not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a missing id and does nothing without a session", async () => {
    expect((await ratifyParameterSet("co-a", "")).ok).toBe(false);
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await ratifyParameterSet("co-a", "s-1")).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
});
