// DW-7j f11 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): leavers whose login is closed by the 1st working day after they leave,
// called through its registered `gated("hr", ...)` wrapper with a ReaderCtx against live Postgres + RLS + the hr wall. The zone is
// Asia/Makassar (UTC+8, no DST).
//
// September 2026: Sep 1 is a Tuesday; Fri Sep 4, Sat 5, Sun 6, and Monday Sep 7 is a COMPANY HOLIDAY on the default calendar.
// The deadline is the end of the 1st working day after `effective_on`:
//   effective Wed Sep 2 -> Thu Sep 3         effective Fri Sep 4 -> Tue Sep 8 (weekend and the Mon holiday skipped)
//   effective Fri Sep 11 -> Mon Sep 14       effective Mon Sep 14 -> Tue Sep 15
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createCompany, createUser } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import { turnModulesOff } from "../../../../testing/finance-kpi-seed";
import { seedHolidayCalendar } from "../../../../testing/hr-kpi-seed";
import { seedAccountActivity, seedLeaver, type LeaverSeed } from "../../../../testing/it-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const leaverAccessClosed = FUNCTIONAL_READERS["it.leaver_access_closed"];

describe.skipIf(!TEST_URL)("DW-7j f11 leaver access closed (live PG + RLS + hr wall)", () => {
  let co: string;
  let bare: string; // no HR calendar: Monday to Friday, no holidays
  let other: string;
  let off: string;
  let empty: string;
  let fresh: string; // one leaver effective on asOf, deadline tomorrow, login still open
  let due: string; // a leaver effective on asOf and already disabled, and one whose deadline is due on asOf
  let actor: string;
  let savedTz: string;
  let seq = 0;

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-it", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });
  /** `date` local + `h` hours (+ `s` seconds). */
  const local = (date: string, h = 0, s = 0) => at(date, h * 3600 + s);

  /** A leaver effective on `effectiveOn`, with the login disabled at `disabledAt` (never when null). Returns the user. */
  const leaver = async (
    tenant: string,
    effectiveOn: string,
    disabledAt: Date | null,
    o: Partial<Pick<LeaverSeed, "status" | "deleted" | "employeeUser" | "subjectUser">> = {},
  ): Promise<string> => {
    const user = await createUser(`leaver${(seq += 1)}@dw7jf11.test`);
    await seedLeaver({ tenant, user, effectiveOn, actor, ...o });
    if (disabledAt) await seedAccountActivity(tenant, user, disabledAt);
    return user;
  };

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    actor = await createUser("actor@dw7jf11.test");
    co = await createCompany("DW-7j f11 Co", ["hr"]);
    bare = await createCompany("DW-7j f11 Bare", ["hr"]);
    other = await createCompany("DW-7j f11 Other", ["hr"]);
    off = await createCompany("DW-7j f11 Off", ["hr"]);
    empty = await createCompany("DW-7j f11 Empty", ["hr"]);
    fresh = await createCompany("DW-7j f11 Fresh", ["hr"]);
    due = await createCompany("DW-7j f11 Due", ["hr"]);

    await seedHolidayCalendar(co, [["2026-09-07", "company"]], [["2026-09-08", "public"]]); // the spare calendar's Sep 8 holiday must be ignored

    // counted, on time
    await leaver(co, "2026-09-01", await local("2026-09-02", 12)); // La: the window's first day in
    const l1 = await leaver(co, "2026-09-02", await local("2026-09-03", 0, 86399)); // L1: day 1, Thu 23:59:59 local
    await seedAccountActivity(co, l1, await local("2026-09-05", 10), { verb: "it.account.enable" });
    await seedAccountActivity(co, l1, await local("2026-09-08", 10)); // L1 disabled again later: the earliest disable decides
    await leaver(co, "2026-09-04", await local("2026-09-08", 0, 86399)); // L4: Fri -> weekend, Mon holiday, Tue Sep 8 23:59:59: on time only through the holiday
    await leaver(co, "2026-09-11", await local("2026-09-14", 0, 86399)); // L5: Fri -> Mon Sep 14 23:59:59, on time
    await leaver(co, "2026-09-14", await local("2026-09-10", 9)); // L8: disabled BEFORE the effective date
    await leaver(co, "2026-09-16", await local("2026-09-17", 10), { status: "completed" }); // Lc: a completed separation counts
    await leaver(co, "2026-09-21", await local("2026-09-22", 10), { subjectUser: null }); // Lfb: the login only on the employee row
    await leaver(co, "2026-09-30", await local("2026-09-30", 23)); // Lend: the window's last day in, disabled that night
    // counted, late or never
    await leaver(co, "2026-09-02", await local("2026-09-04")); // L2: day 2 (Fri 00:00 local): LATE
    const l3 = await leaver(co, "2026-09-09", null); // L3: never disabled
    await seedAccountActivity(co, l3, await local("2026-09-10", 10), { verb: "it.account.enable" }); // an enable is not a disable
    await seedAccountActivity(co, l3, await local("2026-09-10", 11), { entityType: "user" }); // not an it_account activity
    await seedAccountActivity(other, l3, await local("2026-09-10", 12)); // another company's activity for the same id
    await leaver(co, "2026-09-04", await local("2026-09-09")); // L7: Wed Sep 9 00:00: LATE (the spare calendar's holiday is ignored)
    await leaver(co, "2026-09-11", await local("2026-09-15")); // L6: Tue Sep 15 00:00: LATE
    // never counted
    await seedLeaver({ tenant: co, user: null, effectiveOn: "2026-09-09", actor }); // no login at all
    await leaver(co, "2026-09-09", null, { status: "draft" });
    await leaver(co, "2026-09-09", null, { status: "pending_approval" });
    await leaver(co, "2026-09-09", null, { status: "cancelled" });
    await leaver(co, "2026-09-09", null, { deleted: true });
    await leaver(co, "2026-08-31", null); // the day before the window
    await leaver(co, "2026-10-01", null); // the day after
    await leaver(co, "2026-10-05", null); // not yet effective at asOf
    // another company's leaver
    await leaver(other, "2026-09-02", await local("2026-09-03", 10));
    // bare: no calendar, Fri Sep 4 -> Mon Sep 7 (a working day here)
    await leaver(bare, "2026-09-04", await local("2026-09-07", 12)); // on time
    await leaver(bare, "2026-09-04", await local("2026-09-08", 12)); // LATE
    // fresh and due: Wed Sep 30 is asOf and its deadline is Thu Oct 1 (tomorrow)
    await leaver(fresh, "2026-09-30", null); // not disabled yet, deadline not due: not counted at all
    await leaver(due, "2026-09-30", await local("2026-09-30", 10)); // the same case, but disabled today: counted, on time
    await leaver(due, "2026-09-29", null); // Tue Sep 29: the deadline (Wed Sep 30) is due on asOf and the login is open: counted, late
    // off: HR turned off after its rows exist
    await leaver(off, "2026-09-02", await local("2026-09-03", 10));
    await turnModulesOff(off);
  }, 180_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("leavers whose login was disabled by the 1st working day after they left, over the leavers that took effect and are due", async () => {
    // counted: La L1 L4 L5 L8 Lc Lfb Lend (on time) + L2 L3 L7 L6 (late or never) = 12; on time = 8
    expect(await leaverAccessClosed(ctx())).toEqual({ value: 8 / 12, numerator: 8, denominator: 12 });
  });

  it("disabled on day 1 is closed, on day 2 is late; the earliest disable decides, a later re-disable or an enable does not change it (Sep 2: L1, L2)", async () => {
    expect(await leaverAccessClosed(ctx({ start: "2026-09-02", end: "2026-09-02" }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
  });

  it("a weekend and a company holiday stretch the deadline: Friday's leaver has until Tuesday, not Monday (Sep 4)", async () => {
    // L4 (Tue 23:59:59, on time through the holiday) and L7 (Wed 00:00, late); the spare calendar's Sep 8 holiday is ignored
    expect(await leaverAccessClosed(ctx({ start: "2026-09-04", end: "2026-09-04" }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
  });

  it("a weekend alone stretches it to Monday (Sep 11)", async () => {
    expect(await leaverAccessClosed(ctx({ start: "2026-09-11", end: "2026-09-11" }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
  });

  it("a login disabled before the effective date counts (L8)", async () => {
    expect(await leaverAccessClosed(ctx({ start: "2026-09-14", end: "2026-09-14" }))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // L8
  });

  it("only separations that took effect count: approved and completed; a draft, a pending, a cancelled and a deleted one do not", async () => {
    // Sep 9: L3 (approved, never disabled) is the only one counted: the no-login leaver, the draft, the pending, the cancelled and the deleted are not
    expect(await leaverAccessClosed(ctx({ start: "2026-09-09", end: "2026-09-09" }))).toEqual({ value: 0, numerator: 0, denominator: 1 });
    // a completed one is counted and on time (Sep 16)
    expect(await leaverAccessClosed(ctx({ start: "2026-09-16", end: "2026-09-16" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("the login comes from the separation, else from the employee (Lfb has it on the employee only)", async () => {
    expect(await leaverAccessClosed(ctx({ start: "2026-09-21", end: "2026-09-22", asOf: "2026-09-22" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("the window's edges are dates, inclusive: the first and last day are in, the day before and the day after are out", async () => {
    expect((await leaverAccessClosed(ctx()))?.denominator).toBe(12); // Aug 31, Oct 1 and Oct 5 would make it 15
    // asOf stays Sep 30 (past every deadline but Lend's, which is disabled): each single-day window reads its own leaver only
    const one = (d: string) => ctx({ start: d, end: d });
    expect(await leaverAccessClosed(one("2026-09-01"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // La only
    expect(await leaverAccessClosed(one("2026-08-31"))).toEqual({ value: 0, numerator: 0, denominator: 1 }); // the Aug 31 leaver only
    expect(await leaverAccessClosed(one("2026-10-01"))).toBeNull(); // the Oct 1 leaver is not effective yet at asOf Sep 30
    expect(await leaverAccessClosed(one("2026-09-30"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // Lend only
  });

  it("a separation that is not yet effective at asOf is left out", async () => {
    // asOf Sep 20: Lfb (Sep 21) and Lend (Sep 30) are not effective yet: 10 counted, 6 on time
    expect(await leaverAccessClosed(ctx({ asOf: "2026-09-20" }))).toEqual({ value: 6 / 10, numerator: 6, denominator: 10 });
    // October's leavers (Oct 1, Oct 5) are all after asOf Sep 30
    expect(await leaverAccessClosed(ctx({ start: "2026-10-01", end: "2026-10-31", asOf: "2026-09-30" }))).toBeNull();
    // asOf Oct 1: the Oct 1 leaver is effective but its deadline (Oct 2) is not due and the login is open: still not counted; Oct 5 is not effective
    expect(await leaverAccessClosed(ctx({ start: "2026-10-01", end: "2026-10-31", asOf: "2026-10-01" }))).toBeNull();
    // asOf Oct 2: the Oct 1 leaver's deadline is due and the login is open: counted, late; Oct 5 is still not effective
    expect(await leaverAccessClosed(ctx({ start: "2026-10-01", end: "2026-10-31", asOf: "2026-10-02" }))).toEqual({ value: 0, numerator: 0, denominator: 1 });
  });

  it("a leaver whose deadline is still ahead and whose login is open is not counted; disabled already, or once the deadline is due, it is", async () => {
    // fresh: effective Wed Sep 30 = asOf, deadline Thu Oct 1, never disabled: not counted at all
    expect(await leaverAccessClosed(ctx({ tenantId: fresh, start: "2026-09-30", end: "2026-09-30" }))).toBeNull();
    // the same leaver the day the deadline falls due (asOf Oct 1): counted, not closed
    expect(await leaverAccessClosed(ctx({ tenantId: fresh, start: "2026-09-30", end: "2026-10-01", asOf: "2026-10-01" }))).toEqual({ value: 0, numerator: 0, denominator: 1 });
    // due: the leaver effective Sep 30 who is disabled today is counted and on time
    expect(await leaverAccessClosed(ctx({ tenantId: due, start: "2026-09-30", end: "2026-09-30" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    // and the leaver effective Sep 29 (deadline Sep 30 = asOf, login open) is counted, late
    expect(await leaverAccessClosed(ctx({ tenantId: due, start: "2026-09-29", end: "2026-09-30" }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
  });

  it("another company's leavers and disables are never counted; the unit makes no difference", async () => {
    expect(await leaverAccessClosed(ctx({ tenantId: other }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(await leaverAccessClosed(ctx({ unitId: "d-any" }))).toEqual(await leaverAccessClosed(ctx()));
  });

  it("with no HR calendar the week is Monday to Friday with no holidays (Friday's leaver must be closed by Monday)", async () => {
    expect(await leaverAccessClosed(ctx({ tenantId: bare }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
  });

  it("null when there is no leaver in the window, and for a company with none", async () => {
    expect(await leaverAccessClosed(ctx({ start: "2026-11-01", end: "2026-11-30", asOf: "2026-11-30" }))).toBeNull();
    expect(await leaverAccessClosed(ctx({ tenantId: empty }))).toBeNull();
  });

  it("null, never an error, for a company that turned HR off (its old rows stay unread)", async () => {
    expect(await leaverAccessClosed(ctx({ tenantId: off }))).toBeNull();
  });
});
