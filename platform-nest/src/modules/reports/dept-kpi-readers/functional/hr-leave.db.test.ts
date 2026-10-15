// DW-7j f3 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): leave decided within 2 working days, called through its registered
// `gated("hr", ...)` wrapper with a ReaderCtx against live Postgres + RLS + the hr wall. The zone is Asia/Makassar (UTC+8, no DST):
// window Sep 1 .. Sep 30 2026 is [2026-08-31T16:00Z, 2026-09-30T16:00Z).
//
// September 2026: Sep 2 is a Wednesday, Sep 4 a Friday, Sep 5 and 6 the weekend, and Monday Sep 7 is a COMPANY HOLIDAY on the
// default calendar. The deadline is the end of the 2nd working day after the creation day:
//   created Wed Sep 2 -> Fri Sep 4      created Thu Sep 3 -> Tue Sep 8 (Fri 4, then skip Sat, Sun, the Mon holiday, Tue 8)
//   created Fri Sep 4 -> Wed Sep 9      created Sat Sep 5 -> Wed Sep 9      created Mon Sep 28 -> Wed Sep 30
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createCompany, createUser } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import { turnModulesOff } from "../../../../testing/finance-kpi-seed";
import { seedHolidayCalendar, seedLeave, type LeaveSeed } from "../../../../testing/hr-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const leaveDecided2d = FUNCTIONAL_READERS["hr.leave_decided_2d"];

describe.skipIf(!TEST_URL)("DW-7j f3 leave decided within 2 working days (live PG + RLS + hr wall)", () => {
  let co: string;
  let bare: string; // no HR calendar: Monday to Friday, no holidays
  let other: string;
  let off: string;
  let subject: string;
  let savedTz: string;

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-hr", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });

  /** `date` local + `h` hours (+ `s` seconds). */
  const local = (date: string, h: number, s = 0) => at(date, h * 3600 + s);
  const leave = async (
    tenant: string,
    created: Date,
    status: LeaveSeed["status"],
    o: { decidedAt?: Date | null; updatedAt?: Date; deleted?: boolean } = {},
  ) => seedLeave({ tenant, subject, created, status, ...o });

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    subject = await createUser("subject@dw7jf3.test");
    co = await createCompany("DW-7j f3 Co", ["hr"]);
    bare = await createCompany("DW-7j f3 Bare", ["hr"]);
    other = await createCompany("DW-7j f3 Other", ["hr"]);
    off = await createCompany("DW-7j f3 Off", ["hr"]);

    // co: the default calendar (Sat+Sun, Mon Sep 7 a company holiday) and a NON-default one whose Wed Sep 9 holiday must be ignored
    await seedHolidayCalendar(co, [["2026-09-07", "company"]], [["2026-09-09", "public"]]);

    // Created Wednesday Sep 2: deadline the end of Friday Sep 4
    await leave(co, await local("2026-09-02", 9), "approved", { decidedAt: await local("2026-09-04", 0, 86399) }); // a1: Sep 4 23:59:59 local, on time
    await leave(co, await local("2026-09-02", 9), "approved", { decidedAt: await local("2026-09-05", 0) }); // a2: Sep 5 00:00 local (UTC date Sep 4): LATE
    await leave(co, await local("2026-09-02", 9), "denied", { decidedAt: await local("2026-09-03", 10) }); // a3: denied Sep 3, on time
    await leave(co, await local("2026-09-02", 9), "approved", { decidedAt: null, updatedAt: await local("2026-09-04", 10) }); // a4: no decided_at, falls back to updated_at, on time
    await leave(co, await local("2026-09-02", 9), "approved", { decidedAt: null, updatedAt: await local("2026-09-07", 10) }); // a5: fallback, LATE
    // Created Thursday Sep 3: Fri 4 (1st), the weekend and the Mon holiday skipped, Tue 8 (2nd)
    await leave(co, await local("2026-09-03", 9), "approved", { decidedAt: await local("2026-09-07", 12) }); // b1: decided ON the holiday Monday, on time
    await leave(co, await local("2026-09-03", 9), "approved", { decidedAt: await local("2026-09-08", 0, 86399) }); // b2: Tue Sep 8 23:59:59, on time
    await leave(co, await local("2026-09-03", 9), "approved", { decidedAt: await local("2026-09-09", 0) }); // b3: Wed Sep 9 00:00, LATE
    // Created Friday Sep 4 and Saturday Sep 5: the same deadline, Wednesday Sep 9
    await leave(co, await local("2026-09-04", 9), "approved", { decidedAt: await local("2026-09-09", 12) }); // c1: on time
    await leave(co, await local("2026-09-04", 9), "approved", { decidedAt: await local("2026-09-10", 0) }); // c2: Thu Sep 10 00:00, LATE (the spare calendar's Sep 9 holiday is ignored)
    await leave(co, await local("2026-09-05", 9), "approved", { decidedAt: await local("2026-09-09", 12) }); // c3: created on the Saturday, on time
    // Pending: Sep 2 (deadline Sep 4), Mon Sep 28 (deadline Sep 30 = asOf), Tue Sep 29 (deadline Oct 1, after asOf)
    await leave(co, await local("2026-09-02", 9), "pending"); // p1: past its deadline, counted, late
    await leave(co, await local("2026-09-28", 9), "pending"); // p2: due on asOf, counted, late
    await leave(co, await local("2026-09-29", 9), "pending"); // p3: not due yet, left out
    // The window's edges: first instant in, 1 s before it out; last second in, first instant after out
    await leave(co, await local("2026-09-01", 0), "approved", { decidedAt: await local("2026-09-01", 12) }); // w1: Sep 1 00:00 local, in, on time
    await leave(co, await local("2026-09-01", 0, -1), "approved", { decidedAt: await local("2026-09-01", 0, 10) }); // w2: Aug 31 23:59:59 local, OUT
    await leave(co, await local("2026-09-30", 0, 86399), "approved", { decidedAt: await local("2026-09-30", 0, 86399) }); // w3: Sep 30 23:59:59 local, in, on time
    await leave(co, await local("2026-10-01", 0), "approved", { decidedAt: await local("2026-10-01", 10) }); // w4: Oct 1 00:00 local, OUT
    // never counted
    await leave(co, await local("2026-09-02", 9), "cancelled", { decidedAt: await local("2026-09-02", 12) }); // cancelled
    await leave(co, await local("2026-09-02", 9), "approved", { decidedAt: await local("2026-09-02", 12), deleted: true }); // deleted
    // another company's requests
    await leave(other, await local("2026-09-02", 9), "approved", { decidedAt: await local("2026-09-02", 12) });
    await leave(other, await local("2026-09-02", 9), "approved", { decidedAt: await local("2026-09-02", 13) });
    // bare (no calendar: Mon-Fri, no holidays): created Thu Sep 3, so the deadline is Monday Sep 7
    await leave(bare, await local("2026-09-03", 9), "approved", { decidedAt: await local("2026-09-07", 12) }); // on time (Monday is a working day here)
    await leave(bare, await local("2026-09-03", 9), "approved", { decidedAt: await local("2026-09-08", 12) }); // LATE
    // off: a company whose HR module is turned off after its rows exist
    await leave(off, await local("2026-09-02", 9), "approved", { decidedAt: await local("2026-09-02", 12) });
    await turnModulesOff(off);
  }, 180_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("decided plus pending-past-deadline over decided by the end of the 2nd working day after creation, in REPORTS_TZ", async () => {
    // counted: a1..a5, b1..b3, c1..c3, p1, p2, w1, w3 = 15; on time: a1 a3 a4, b1 b2, c1 c3, w1 w3 = 9
    expect(await leaveDecided2d(ctx())).toEqual({ value: 9 / 15, numerator: 9, denominator: 15 });
  });

  it("the deadline's end is 23:59:59 REPORTS_TZ of the deadline day, not the UTC date (a1 on time, a2 late)", async () => {
    // Sep 2 only: a1 a2 a3 a4 a5 p1 -> 3 on time of 6
    expect(await leaveDecided2d(ctx({ start: "2026-09-02", end: "2026-09-02" }))).toEqual({ value: 3 / 6, numerator: 3, denominator: 6 });
  });

  it("a decided request with no decided_at falls back to updated_at (a4 on time, a5 late)", async () => {
    const r = await leaveDecided2d(ctx({ start: "2026-09-02", end: "2026-09-02" }));
    // a4 is on time only through its updated_at: without the fallback the numerator would be 2
    expect(r?.numerator).toBe(3);
  });

  it("a weekend and a company holiday between creation and decision stretch the deadline (Thu -> Tue)", async () => {
    // Sep 3 only: b1 (decided on the holiday Monday) and b2 (Tue 23:59:59) on time, b3 (Wed 00:00) late
    expect(await leaveDecided2d(ctx({ start: "2026-09-03", end: "2026-09-03" }))).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
  });

  it("a request created on the Friday or on the Saturday is due Wednesday; the spare calendar's holiday is ignored", async () => {
    // Sep 4 .. Sep 5: c1 and c3 on time, c2 (Thu Sep 10) late: it would be on time if the spare calendar's Sep 9 holiday counted
    expect(await leaveDecided2d(ctx({ start: "2026-09-04", end: "2026-09-05" }))).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
  });

  it("with no HR calendar the week is Monday to Friday with no holidays (Thursday's request must be decided by Monday)", async () => {
    expect(await leaveDecided2d(ctx({ tenantId: bare }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
  });

  it("a pending request counts, late, once its deadline is due on asOf, and is left out before that", async () => {
    // asOf Sep 3: p1 (deadline Sep 4) and p2 are not due: 13 counted, 9 on time
    expect(await leaveDecided2d(ctx({ asOf: "2026-09-03" }))).toEqual({ value: 9 / 13, numerator: 9, denominator: 13 });
    // asOf Sep 4: p1 is due on asOf and counts as late; p2 is not due
    expect(await leaveDecided2d(ctx({ asOf: "2026-09-04" }))).toEqual({ value: 9 / 14, numerator: 9, denominator: 14 });
    // asOf Sep 30: p2's deadline (Sep 30) is due on asOf; p3's (Oct 1) is not
    expect(await leaveDecided2d(ctx({ asOf: "2026-09-30" }))).toEqual({ value: 9 / 15, numerator: 9, denominator: 15 });
  });

  it("the window's first and last instants are in, the instants just outside are out (created_at, half-open)", async () => {
    const one = (d: string) => ctx({ start: d, end: d, asOf: d });
    expect(await leaveDecided2d(one("2026-09-01"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w1 only (w2 is Aug 31)
    expect(await leaveDecided2d(one("2026-08-31"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w2 only
    expect(await leaveDecided2d(one("2026-09-30"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w3 only
    expect(await leaveDecided2d(one("2026-10-01"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w4 only
  });

  it("a cancelled and a deleted request are never counted; another company's requests are never counted; the unit makes no difference", async () => {
    expect((await leaveDecided2d(ctx()))?.denominator).toBe(15); // the cancelled, the deleted and other's two would make it 19
    expect(await leaveDecided2d(ctx({ unitId: "d-any" }))).toEqual(await leaveDecided2d(ctx()));
    expect(await leaveDecided2d(ctx({ tenantId: other, start: "2026-09-02", end: "2026-09-02" }))).toEqual({ value: 1, numerator: 2, denominator: 2 });
  });

  it("null when nothing is measurable: an empty window, or only a pending request whose deadline has not come", async () => {
    expect(await leaveDecided2d(ctx({ start: "2026-11-01", end: "2026-11-30", asOf: "2026-11-30" }))).toBeNull();
    expect(await leaveDecided2d(ctx({ start: "2026-09-29", end: "2026-09-29", asOf: "2026-09-29" }))).toBeNull(); // p3 only, deadline Oct 1 > asOf
  });

  it("null, never an error, for a company that turned HR off (its old rows stay unread)", async () => {
    expect(await leaveDecided2d(ctx({ tenantId: off }))).toBeNull();
  });
});
