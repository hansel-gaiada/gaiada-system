// DW-7j f9 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): client payments confirmed within 1 working day, called DIRECTLY with a
// ReaderCtx against live Postgres + RLS. The zone is Asia/Makassar (UTC+8, no DST): window Sep 1 .. Sep 30 2026 is
// [2026-08-31T16:00Z, 2026-09-30T16:00Z). `invoice_payments` is a core table, so there is no "module off" case; the HR calendar is
// read under the `hr` scope without the company needing the HR module.
//
// September 2026: Sep 2 is a Wednesday, Sep 4 a Friday, Sep 5 and 6 the weekend, and Monday Sep 7 is a COMPANY HOLIDAY on the
// default calendar. A payment created on Friday Sep 4 (or on the Saturday) therefore has until the end of Tuesday Sep 8.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { newId, withTenants } from "../../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createClient, createCompany } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import type { ReaderCtx } from "../types";
import { paymentsConfirmed1d } from "./payments-confirmed";

type Seed = {
  tenant?: string;
  created: Date;
  status: "pending" | "confirmed" | "rejected";
  confirmedAt?: Date | null;
  updatedAt?: Date;
  deleted?: boolean;
};

describe.skipIf(!TEST_URL)("DW-7j f9 payments confirmed within 1 working day (live PG + RLS)", () => {
  let co: string;
  let bare: string; // no HR calendar: Monday to Friday, no holidays
  let savedTz: string;
  const invoice: Record<string, string> = {};
  const client: Record<string, string> = {};

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-fin", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });

  async function setup(tenant: string, label: string): Promise<void> {
    client[tenant] = await createClient(tenant, `DW-7j f9 ${label}`);
    invoice[tenant] = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
         VALUES ($1, $2, $3, '2026-08-01', '2026-08-31', 'draft', 'IDR', '[{"description":"Work","amount":1000}]'::jsonb, 1000, $4)`,
        [invoice[tenant], tenant, client[tenant], config.originSite],
      ),
    );
  }

  async function pay(s: Seed): Promise<void> {
    const tenant = s.tenant ?? co;
    const confirmedAt = s.confirmedAt === undefined ? null : s.confirmedAt;
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, confirmed_at, created_at, updated_at,
                                       deleted_at, origin_site)
         VALUES ($1,$2,$3,$4,100,'IDR','2026-09-01',$5,$6,$7,$8,$9,$10)`,
        [
          newId(), tenant, invoice[tenant], client[tenant], s.status, confirmedAt, s.created, s.updatedAt ?? s.created,
          s.deleted ? new Date("2026-09-15T00:00:00Z") : null, config.originSite,
        ],
      ),
    );
  }

  /** `date` local + `h` hours. */
  const local = (date: string, hours: number, seconds = 0) => at(date, hours * 3600 + seconds);

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    co = await createCompany("DW-7j f9 Co");
    bare = await createCompany("DW-7j f9 Bare");
    await setup(co, "co");
    await setup(bare, "bare");

    // co's HR calendars: the default (Sat+Sun weekend, Mon Sep 7 a company holiday) and a NON-default one whose Sep 8 holiday must be ignored
    await withTenants(
      [co],
      async (c) => {
        const def = newId();
        const spare = newId();
        await c.query(
          `INSERT INTO hr_holiday_calendars (id, tenant_id, name, weekend_days, is_default, origin_site) VALUES ($1,$2,'Default',ARRAY[6,7],true,$3), ($4,$2,'Spare',ARRAY[6,7],false,$3)`,
          [def, co, config.originSite, spare],
        );
        await c.query(`INSERT INTO hr_holidays (id, tenant_id, calendar_id, day, name, kind) VALUES ($1,$2,$3,'2026-09-07','Founders day','company')`, [newId(), co, def]);
        await c.query(`INSERT INTO hr_holidays (id, tenant_id, calendar_id, day, name, kind) VALUES ($1,$2,$3,'2026-09-08','Spare holiday','public')`, [newId(), co, spare]);
      },
      { modules: ["hr"] },
    );

    // Created Wednesday Sep 2: the deadline is the end of Thursday Sep 3
    await pay({ created: await local("2026-09-02", 9), status: "confirmed", confirmedAt: await local("2026-09-02", 12) }); // a1: same day, on time
    await pay({ created: await local("2026-09-02", 9), status: "confirmed", confirmedAt: await local("2026-09-03", 0, 86399) }); // a2: Sep 3 23:59:59 local, on time
    await pay({ created: await local("2026-09-02", 9), status: "confirmed", confirmedAt: await local("2026-09-04", 0) }); // a3: Sep 4 00:00 local (UTC date Sep 3): LATE
    await pay({ created: await local("2026-09-02", 9), status: "rejected", updatedAt: await local("2026-09-03", 10) }); // a4: rejected Sep 3 (updated_at), on time
    await pay({ created: await local("2026-09-02", 9), status: "rejected", updatedAt: await local("2026-09-04", 12) }); // a5: rejected Sep 4, LATE
    await pay({ created: await local("2026-09-02", 9), status: "confirmed", confirmedAt: null, updatedAt: await local("2026-09-03", 10) }); // a6: confirmed with no confirmed_at falls back to updated_at, on time
    // Created Friday Sep 4: Sat, Sun and the Mon holiday are skipped, so the deadline is the end of Tuesday Sep 8
    await pay({ created: await local("2026-09-04", 9), status: "confirmed", confirmedAt: await local("2026-09-07", 12) }); // b1: Monday (the holiday), on time
    await pay({ created: await local("2026-09-04", 9), status: "confirmed", confirmedAt: await local("2026-09-08", 0, 86399) }); // b2: Tue Sep 8 23:59:59, on time
    await pay({ created: await local("2026-09-04", 9), status: "confirmed", confirmedAt: await local("2026-09-09", 0) }); // b3: Wed Sep 9 00:00, LATE
    // Created Saturday Sep 5: the same deadline, Tuesday Sep 8
    await pay({ created: await local("2026-09-05", 9), status: "confirmed", confirmedAt: await local("2026-09-08", 12) }); // c1: on time
    // Pending: Sep 2 (deadline Sep 3), Sep 29 (deadline Sep 30 = asOf), Sep 30 (deadline Oct 1, after asOf)
    await pay({ created: await local("2026-09-02", 9), status: "pending" }); // p1: past its deadline, counted, late
    await pay({ created: await local("2026-09-29", 9), status: "pending" }); // p2: due on asOf, counted, late
    await pay({ created: await local("2026-09-30", 0, 100), status: "pending" }); // p3: not due yet, left out
    // The window's edges: first instant in, 1 s before it out; last second in, first instant after out
    await pay({ created: await local("2026-09-01", 0), status: "confirmed", confirmedAt: await local("2026-09-01", 12) }); // w1: Sep 1 00:00 local, in, on time
    await pay({ created: await local("2026-09-01", 0, -1), status: "confirmed", confirmedAt: await local("2026-09-01", 0, 10) }); // w2: Aug 31 23:59:59 local, OUT
    await pay({ created: await local("2026-09-30", 0, 86399), status: "confirmed", confirmedAt: await local("2026-09-30", 0, 86399) }); // w3: Sep 30 23:59:59 local, in, on time
    await pay({ created: await local("2026-10-01", 0), status: "confirmed", confirmedAt: await local("2026-10-01", 10) }); // w4: Oct 1 00:00 local, OUT
    // never counted
    await pay({ created: await local("2026-09-02", 9), status: "confirmed", confirmedAt: await local("2026-09-02", 12), deleted: true }); // deleted
    // bare tenant (no calendar: Mon-Fri, no holidays): created Friday Sep 4, so the deadline is Monday Sep 7
    await pay({ tenant: bare, created: await local("2026-09-04", 9), status: "confirmed", confirmedAt: await local("2026-09-07", 12) }); // on time (Monday is a working day here)
    await pay({ tenant: bare, created: await local("2026-09-04", 9), status: "confirmed", confirmedAt: await local("2026-09-08", 12) }); // LATE
  }, 120_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("decided plus pending-past-deadline over decided by the end of the 1st working day after creation, in REPORTS_TZ", async () => {
    // counted: a1..a6, b1..b3, c1, p1, p2, w1, w3 = 14; on time: a1 a2 a4 a6, b1 b2, c1, w1 w3 = 9
    expect(await paymentsConfirmed1d(ctx())).toEqual({ value: 9 / 14, numerator: 9, denominator: 14 });
  });

  it("a weekend and a company holiday between creation and decision stretch the deadline (Fri -> Tue); the spare calendar's holiday is ignored", async () => {
    // Narrow to Sep 4 .. Sep 5: b1 b2 (on time, via the holiday Monday and Tuesday), b3 (late), c1 (created on the Saturday)
    expect(await paymentsConfirmed1d(ctx({ start: "2026-09-04", end: "2026-09-05" }))).toEqual({ value: 3 / 4, numerator: 3, denominator: 4 });
  });

  it("with no HR calendar the week is Monday to Friday with no holidays (the same Friday payment must be decided by Monday)", async () => {
    expect(await paymentsConfirmed1d(ctx({ tenantId: bare }))).toEqual({ value: 1 / 2, numerator: 1, denominator: 2 });
  });

  it("the deadline's end is 23:59:59 REPORTS_TZ of the deadline day, not the UTC date (a2 on time, a3 late)", async () => {
    // Sep 2 only: a1 a2 a3 a4 a5 a6 p1 -> 4 on time of 7 (a3, a5 and p1 are late)
    expect(await paymentsConfirmed1d(ctx({ start: "2026-09-02", end: "2026-09-02" }))).toEqual({ value: 4 / 7, numerator: 4, denominator: 7 });
  });

  it("a rejection is decided at updated_at (a4 on time, a5 late); a confirmed payment with no confirmed_at falls back to it (a6)", async () => {
    // already covered in the Sep 2 count above; pin it by the counts the two rejections and a6 contribute
    expect((await paymentsConfirmed1d(ctx({ start: "2026-09-02", end: "2026-09-02" })))?.numerator).toBe(4);
  });

  it("a pending payment counts, late, once its deadline is due on asOf, and is left out before that", async () => {
    // asOf Sep 2: p1 (deadline Sep 3) and p2 are not due: 12 counted, 9 on time
    expect(await paymentsConfirmed1d(ctx({ asOf: "2026-09-02" }))).toEqual({ value: 9 / 12, numerator: 9, denominator: 12 });
    // asOf Sep 3: p1 is due on asOf and counts as late; p2 is not due
    expect(await paymentsConfirmed1d(ctx({ asOf: "2026-09-03" }))).toEqual({ value: 9 / 13, numerator: 9, denominator: 13 });
    // asOf Sep 30: p2's deadline (Sep 30) is due on asOf; p3's (Oct 1) is not
    expect(await paymentsConfirmed1d(ctx({ asOf: "2026-09-30" }))).toEqual({ value: 9 / 14, numerator: 9, denominator: 14 });
  });

  it("the window's first and last instants are in, the instants just outside are out (created_at, half-open)", async () => {
    expect(await paymentsConfirmed1d(ctx({ start: "2026-09-01", end: "2026-09-01", asOf: "2026-09-01" }))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w1 only (w2 is Aug 31)
    expect(await paymentsConfirmed1d(ctx({ start: "2026-08-31", end: "2026-08-31", asOf: "2026-08-31" }))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w2 only
    expect(await paymentsConfirmed1d(ctx({ start: "2026-09-30", end: "2026-09-30", asOf: "2026-09-30" }))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w3 (p3 not due)
    expect(await paymentsConfirmed1d(ctx({ start: "2026-10-01", end: "2026-10-01", asOf: "2026-10-01" }))).toEqual({ value: 1, numerator: 1, denominator: 1 }); // w4 only
  });

  it("company grain: the unit makes no difference; another tenant's payments are never counted; a deleted one is not counted", async () => {
    expect(await paymentsConfirmed1d(ctx({ unitId: "d-any" }))).toEqual(await paymentsConfirmed1d(ctx()));
    // co's number above is 9 / 14 with bare's two payments and the deleted one excluded
    expect((await paymentsConfirmed1d(ctx()))?.denominator).toBe(14);
  });

  it("null when nothing is measurable: an empty window, or only a pending payment whose deadline has not come", async () => {
    expect(await paymentsConfirmed1d(ctx({ start: "2026-11-01", end: "2026-11-30", asOf: "2026-11-30" }))).toBeNull();
    expect(await paymentsConfirmed1d(ctx({ start: "2026-09-29", end: "2026-09-29", asOf: "2026-09-29" }))).toBeNull(); // p2 only, deadline Sep 30 > asOf
  });
});
