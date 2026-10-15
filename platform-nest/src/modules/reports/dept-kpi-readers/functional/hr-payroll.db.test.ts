// DW-7j f4 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): payroll paid by its pay date, called through its registered
// `gated("hr", ...)` wrapper with a ReaderCtx against live Postgres + RLS + the hr wall. The zone is Asia/Makassar (UTC+8, no DST),
// so a run paid at 00:00 local on the day after its pay date is still on the pay date in UTC. `pay_date` is a DATE: the window's
// start and end select it as an inclusive date range, no zone involved.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createCompany, createUser } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import { turnModulesOff } from "../../../../testing/finance-kpi-seed";
import { seedPayrollRun, type PayrollSeed } from "../../../../testing/hr-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const payrollOnTime = FUNCTIONAL_READERS["hr.payroll_on_time"];

describe.skipIf(!TEST_URL)("DW-7j f4 payroll paid by the pay date (live PG + RLS + hr wall)", () => {
  let co: string;
  let other: string;
  let off: string;
  let actor: string;
  let savedTz: string;

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-hr", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-15", ...over,
  });
  const local = (date: string, h: number, s = 0) => at(date, h * 3600 + s);
  const run = (tenant: string, o: Omit<PayrollSeed, "tenant" | "actor">) => seedPayrollRun({ tenant, actor, ...o });

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    actor = await createUser("actor@dw7jf4.test");
    co = await createCompany("DW-7j f4 Co", ["hr"]);
    other = await createCompany("DW-7j f4 Other", ["hr"]);
    off = await createCompany("DW-7j f4 Off", ["hr"]);

    // Paid: on time when paid_at's REPORTS_TZ date is on or before pay_date
    await run(co, { status: "paid", payDate: "2026-09-10", paidAt: await local("2026-09-10", 0, 86399) }); // r1: Sep 10 23:59:59 local, on time
    await run(co, { status: "paid", payDate: "2026-09-10", paidAt: await local("2026-09-11", 0) }); // r2: Sep 11 00:00 local (UTC date Sep 10): LATE
    await run(co, { status: "paid", payDate: "2026-09-12", paidAt: await local("2026-09-05", 9) }); // r3: paid early, on time
    // Not paid: counted once its pay date is due (<= asOf Sep 15), and never on time
    await run(co, { status: "approved", payDate: "2026-09-14" }); // r4: due, counted, late
    await run(co, { status: "approved", payDate: "2026-09-20" }); // r5: pay date after asOf, left out
    // Paid before its pay date: counted although the pay date is after asOf
    await run(co, { status: "paid", payDate: "2026-09-25", paidAt: await local("2026-09-14", 9) }); // r6: counted, on time
    await run(co, { status: "paid", payDate: "2026-09-20", paidAt: null }); // r7: paid with no paid_at: counted, not on time
    await run(co, { status: "approved", payDate: "2026-09-22" }); // r12: alone on Sep 22, after asOf, left out
    // never counted
    await run(co, { status: "cancelled", payDate: "2026-09-10" }); // r8: cancelled
    await run(co, { status: "draft", payDate: null }); // r9: no pay_date
    await run(co, { kind: "thr", status: "paid", payDate: "2026-09-10", paidAt: await local("2026-09-05", 9) }); // r10: not a regular run
    await run(co, { kind: "correction", status: "approved", payDate: "2026-09-10" }); // r10b: not a regular run
    await run(co, { status: "paid", payDate: "2026-09-10", paidAt: await local("2026-09-05", 9), deleted: true }); // r11: deleted
    // The window's edges (pay_date is a date, inclusive): Sep 1 and Sep 30 in, Aug 31 and Oct 1 out
    await run(co, { status: "paid", payDate: "2026-09-01", paidAt: await local("2026-09-01", 12) }); // b1: in, on time
    await run(co, { status: "paid", payDate: "2026-08-31", paidAt: await local("2026-08-31", 12) }); // b2: OUT
    await run(co, { status: "paid", payDate: "2026-09-30", paidAt: await local("2026-09-29", 12) }); // b3: in (paid), on time
    await run(co, { status: "paid", payDate: "2026-10-01", paidAt: await local("2026-09-29", 12) }); // b4: OUT
    // another company's run
    await run(other, { status: "paid", payDate: "2026-09-10", paidAt: await local("2026-09-10", 12) });
    // off: HR turned off after its rows exist
    await run(off, { status: "paid", payDate: "2026-09-10", paidAt: await local("2026-09-10", 12) });
    await turnModulesOff(off);
  }, 180_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("regular runs due or paid over those paid by their pay date, by paid_at's REPORTS_TZ date", async () => {
    // counted: r1 r2 r3 r4 r6 r7 b1 b3 = 8; on time: r1 r3 r6 b1 b3 = 5
    expect(await payrollOnTime(ctx())).toEqual({ value: 5 / 8, numerator: 5, denominator: 8 });
  });

  it("paid_at is read in REPORTS_TZ: Sep 11 00:00 local is late although its UTC date is the pay date (r2)", async () => {
    expect(await payrollOnTime(ctx({ start: "2026-09-10", end: "2026-09-10" }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 }); // r1 on time, r2 late
  });

  it("an unpaid run counts once its pay date is due on asOf, and is left out before that", async () => {
    // asOf Sep 13: r4 (pay date Sep 14) is not due yet: 7 counted
    expect(await payrollOnTime(ctx({ asOf: "2026-09-13" }))).toEqual({ value: 5 / 7, numerator: 5, denominator: 7 });
    // asOf Sep 14: r4 is due on asOf
    expect(await payrollOnTime(ctx({ asOf: "2026-09-14" }))).toEqual({ value: 5 / 8, numerator: 5, denominator: 8 });
    // asOf Sep 30: r5 and r12 are due too, late
    expect(await payrollOnTime(ctx({ asOf: "2026-09-30" }))).toEqual({ value: 5 / 10, numerator: 5, denominator: 10 });
  });

  it("a run paid before its pay date counts even though the pay date is after asOf (r6); paid with no paid_at counts, late (r7)", async () => {
    expect(await payrollOnTime(ctx({ start: "2026-09-25", end: "2026-09-25" }))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // r6
    // Sep 20 holds r5 (unpaid, not due on asOf Sep 15: left out) and r7 (paid, no paid_at: counted, not on time)
    expect(await payrollOnTime(ctx({ start: "2026-09-20", end: "2026-09-20" }))).toEqual({ value: 0, numerator: 0, denominator: 1 });
  });

  it("a non-regular run, a cancelled run, a deleted run and a run with no pay_date are never counted", async () => {
    // Sep 10 holds r1 r2 (counted) plus the thr, correction, cancelled and deleted runs, which must not be
    expect((await payrollOnTime(ctx({ start: "2026-09-10", end: "2026-09-10" })))?.denominator).toBe(2);
    expect((await payrollOnTime(ctx()))?.denominator).toBe(8);
  });

  it("the window's first and last pay dates are in, the days just outside are out (an inclusive date range)", async () => {
    const one = (d: string) => ctx({ start: d, end: d, asOf: d });
    expect(await payrollOnTime(one("2026-09-01"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // b1 only
    expect(await payrollOnTime(one("2026-08-31"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // b2 only
    expect(await payrollOnTime(one("2026-09-30"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // b3 only
    expect(await payrollOnTime(one("2026-10-01"))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // b4 only
  });

  it("company grain: the unit makes no difference; another company's run is never counted", async () => {
    expect(await payrollOnTime(ctx({ unitId: "d-any" }))).toEqual(await payrollOnTime(ctx()));
    expect(await payrollOnTime(ctx({ tenantId: other }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
  });

  it("null when nothing is measurable: an empty window, or only an unpaid run whose pay date has not come", async () => {
    expect(await payrollOnTime(ctx({ start: "2026-11-01", end: "2026-11-30", asOf: "2026-11-30" }))).toBeNull();
    expect(await payrollOnTime(ctx({ start: "2026-09-22", end: "2026-09-22", asOf: "2026-09-21" }))).toBeNull(); // r12 only
  });

  it("null, never an error, for a company that turned HR off", async () => {
    expect(await payrollOnTime(ctx({ tenantId: off }))).toBeNull();
  });
});
