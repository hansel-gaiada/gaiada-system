// DW-7j f7 and f8 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): the finance department's close-on-time and overdue-receivables
// readers, called DIRECTLY (through their `gated` wrappers, as registered) with a ReaderCtx against live Postgres + RLS + the finance
// wall. The zone is Asia/Makassar (UTC+8, no DST), so a lock's local date differs from its UTC date around midnight.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { newId } from "../../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createUser } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import { seedFinanceCompany, turnModulesOff, withFinance, type FinanceWorld } from "../../../../testing/finance-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const closeOnTime = FUNCTIONAL_READERS["finance.close_on_time"];
const overdueShare = FUNCTIONAL_READERS["finance.overdue_receivables_share"];

describe.skipIf(!TEST_URL)("DW-7j f7 / f8 finance readers (live PG + RLS + finance wall)", () => {
  let savedTz: string;
  let signer: string;
  const ctxFor = (tenantId: string, over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId, unitId: "d-fin", periodKind: "month", start: "2026-03-31", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    signer = await createUser("signer@dw7jf.test");
  }, 60_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  // ── f7 · finance.close_on_time ───────────────────────────────────────────────────────────────────
  describe("f7 finance.close_on_time", () => {
    let world: FinanceWorld;
    let other: string;
    let off: string;
    let periodNo = 0;

    async function period(
      w: FinanceWorld,
      start: string,
      end: string,
      o: { soft?: Date; hard?: Date } = {},
    ): Promise<void> {
      periodNo += 1;
      const state = o.hard ? "HARD_LOCK" : o.soft ? "SOFT_LOCK" : "OPEN";
      await withFinance(w.tenant, (c) =>
        c.query(
          `INSERT INTO finance_fiscal_periods (id, tenant_id, fiscal_year_id, period_no, name, start_date, end_date, state,
                                               soft_locked_at, hard_locked_at, signed_off_by, signed_off_at)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12)`,
          [
            newId(), w.tenant, w.fiscalYear, periodNo, `P${periodNo} ${end}`, start, end, state,
            o.soft ?? null, o.hard ?? null, o.hard ? signer : null, o.hard ? o.hard : null,
          ],
        ),
      );
    }

    beforeAll(async () => {
      world = await seedFinanceCompany("DW-7j f7 Co", { periods: "none" });
      // before the window (ends Feb 28), on time, never counted
      await period(world, "2026-01-01", "2026-02-28", { soft: await at("2026-03-02", 100) });
      // A: ends Mar 31 (the window's first day), deadline Apr 10: soft-locked at 23:59:59 local on Apr 10, on time
      await period(world, "2026-03-01", "2026-03-31", { soft: await at("2026-04-10", 86399) });
      // B: ends Apr 30, deadline May 10: soft-locked at 00:00 local on May 11, LATE (its UTC date, May 10, would pass)
      await period(world, "2026-04-01", "2026-04-30", { soft: await at("2026-05-11", 0) });
      // C: ends May 31, deadline Jun 10: HARD-locked without a soft lock, on Jun 10: counts its hard lock, on time
      await period(world, "2026-05-01", "2026-05-31", { hard: await at("2026-06-10", 100) });
      // D: ends Jun 30, deadline Jul 10: soft-locked Jul 1 and hard-locked Jul 20: the SOFT lock counts, on time
      await period(world, "2026-06-01", "2026-06-30", { soft: await at("2026-07-01", 0), hard: await at("2026-07-20", 0) });
      // E: ends Jul 31, deadline Aug 10, never locked: late once the deadline is due
      await period(world, "2026-07-01", "2026-07-31");
      // F: ends Aug 31, deadline Sep 10, soft-locked Sep 5: on time
      await period(world, "2026-08-01", "2026-08-31", { soft: await at("2026-09-05", 0) });
      // G: ends Sep 20, deadline Sep 30, never locked: due on asOf (Sep 30), late
      await period(world, "2026-09-01", "2026-09-20");
      // H: ends Sep 30 (the window's last day), deadline Oct 10, soft-locked Sep 28: met early, on time
      await period(world, "2026-09-21", "2026-09-30", { soft: await at("2026-09-28", 0) });
      // after the window (ends Oct 31), soft-locked on time, never counted
      await period(world, "2026-10-01", "2026-10-31", { soft: await at("2026-11-02", 0) });

      // another tenant: one period ending Jun 30, soft-locked Jul 2 on time
      const o = await seedFinanceCompany("DW-7j f7 Other", { periods: "none" });
      other = o.tenant;
      await period(o, "2026-06-01", "2026-06-30", { soft: await at("2026-07-02", 0) });

      // a company that turned finance off after it closed a period
      const f = await seedFinanceCompany("DW-7j f7 Off", { periods: "none" });
      off = f.tenant;
      await period(f, "2026-06-01", "2026-06-30", { soft: await at("2026-07-02", 0) });
      await turnModulesOff(off);
    }, 120_000);

    it("counts due or locked periods ending in the window; on time = the soft lock's REPORTS_TZ date by end + 10 days", async () => {
      // A B C D E F G H = 8 counted; on time: A C D F H = 5
      expect(await closeOnTime(ctxFor(world.tenant))).toEqual({ value: 5 / 8, numerator: 5, denominator: 8 });
    });

    it("a period hard-locked without a soft lock counts its hard lock (C is on time, and is in the denominator)", async () => {
      // Narrow to May: only C
      expect(await closeOnTime(ctxFor(world.tenant, { start: "2026-05-31", end: "2026-05-31" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    });

    it("the soft lock wins over a later hard lock (D)", async () => {
      expect(await closeOnTime(ctxFor(world.tenant, { start: "2026-06-30", end: "2026-06-30" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    });

    it("the deadline boundary is the end of day 10 in REPORTS_TZ: 23:59:59 on time (A), 00:00 of day 11 late (B)", async () => {
      expect(await closeOnTime(ctxFor(world.tenant, { start: "2026-03-31", end: "2026-03-31" }))).toEqual({ value: 1, numerator: 1, denominator: 1 });
      expect(await closeOnTime(ctxFor(world.tenant, { start: "2026-04-30", end: "2026-04-30" }))).toEqual({ value: 0, numerator: 0, denominator: 1 });
    });

    it("the window's end_date edges are inclusive dates (Mar 31 and Sep 30 in; the day before Mar 31 and after Sep 30 out)", async () => {
      // Apr 1 .. Sep 30: A drops out, 7 counted, 4 on time
      expect(await closeOnTime(ctxFor(world.tenant, { start: "2026-04-01" }))).toEqual({ value: 4 / 7, numerator: 4, denominator: 7 });
      // Mar 31 .. Sep 29: H (ends Sep 30) drops out, 7 counted, 4 on time
      expect(await closeOnTime(ctxFor(world.tenant, { end: "2026-09-29" }))).toEqual({ value: 4 / 7, numerator: 4, denominator: 7 });
    });

    it("an unlocked period counts only once its deadline is due (asOf is the only clock); a locked one counts at once", async () => {
      // asOf Sep 29: G (deadline Sep 30) is not due yet and not locked: left out
      expect(await closeOnTime(ctxFor(world.tenant, { asOf: "2026-09-29" }))).toEqual({ value: 5 / 7, numerator: 5, denominator: 7 });
      // asOf Aug 9: E (deadline Aug 10) is not due: left out; G left out; F and H are locked so they count
      expect(await closeOnTime(ctxFor(world.tenant, { asOf: "2026-08-09" }))).toEqual({ value: 5 / 6, numerator: 5, denominator: 6 });
      // asOf Aug 10: E is due on asOf and counts as late
      expect(await closeOnTime(ctxFor(world.tenant, { asOf: "2026-08-10" }))).toEqual({ value: 5 / 7, numerator: 5, denominator: 7 });
    });

    it("company grain: the unit makes no difference; another tenant's periods are never counted", async () => {
      expect(await closeOnTime(ctxFor(world.tenant, { unitId: "d-any" }))).toEqual(await closeOnTime(ctxFor(world.tenant)));
      expect(await closeOnTime(ctxFor(other))).toEqual({ value: 1, numerator: 1, denominator: 1 });
    });

    it("null when no period is measurable, never 0 or 1", async () => {
      expect(await closeOnTime(ctxFor(world.tenant, { start: "2026-11-01", end: "2026-11-30", asOf: "2026-11-30" }))).toBeNull();
      // G ends Sep 20 and is unlocked with its deadline (Sep 30) after asOf (Sep 29): not measurable yet
      expect(await closeOnTime(ctxFor(world.tenant, { start: "2026-09-20", end: "2026-09-20", asOf: "2026-09-29" }))).toBeNull();
    });

    it("null, not an error, for a company that turned the finance module off", async () => {
      expect(await closeOnTime(ctxFor(off))).toBeNull();
    });
  });

  // ── f8 · finance.overdue_receivables_share ───────────────────────────────────────────────────────
  describe("f8 finance.overdue_receivables_share", () => {
    let co: string;
    let other: string;
    let off: string;
    let invNo = 0;

    /** An ISSUED AR invoice (the real issue path posts it to the ledger). */
    async function invoice(tenant: string, customer: string, revenue: string, date: string, due: string, amount: number): Promise<void> {
      invNo += 1;
      const id = newId();
      await withFinance(tenant, async (c) => {
        await c.query(
          `INSERT INTO finance_ar_invoices (id, tenant_id, customer_id, invoice_no, invoice_date, due_date, currency_code, subtotal, tax_total, total)
           VALUES ($1,$2,$3,$4,$5::date,$6::date,'IDR',$7,0,$7)`,
          [id, tenant, customer, `DW7J-INV-${invNo}`, date, due, amount],
        );
        await c.query(
          `INSERT INTO finance_ar_invoice_lines (tenant_id, invoice_id, line_no, description, quantity, unit_price, line_subtotal, revenue_account_id)
           VALUES ($1,$2,1,'Services',1,$3,$3,$4)`,
          [tenant, id, amount, revenue],
        );
        await c.query("SELECT finance_ar_issue_invoice($1)", [id]);
      });
    }

    async function arCompany(name: string): Promise<{ tenant: string; customer: string; revenue: string }> {
      const w = await seedFinanceCompany(name, { periods: "monthly" });
      const customer = newId();
      const revenue = await withFinance(w.tenant, async (c) => {
        await c.query(`INSERT INTO finance_ar_customers (id, tenant_id, code, name, payment_terms_days) VALUES ($1,$2,'CUST-1','Client One',30)`, [customer, w.tenant]);
        return (await c.query<{ id: string }>(`SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = '4100'`, [w.tenant])).rows[0].id;
      });
      return { tenant: w.tenant, customer, revenue };
    }

    beforeAll(async () => {
      const a = await arCompany("DW-7j f8 Co");
      co = a.tenant;
      // A: current at every asOf below (due Oct 15)
      await invoice(co, a.customer, a.revenue, "2026-09-01", "2026-10-15", 1_000_000);
      // B: due Sep 20: not overdue ON Sep 20, 1 day overdue on Sep 21
      await invoice(co, a.customer, a.revenue, "2026-09-01", "2026-09-20", 2_000_000);
      // C: due Aug 1: d1_30 on Aug 15, d31_60 on Sep 20 and Sep 30
      await invoice(co, a.customer, a.revenue, "2026-07-01", "2026-08-01", 3_000_000);
      // D: due Jun 1: d61_90 on Aug 15, d90_plus on Sep 20 and Sep 30
      await invoice(co, a.customer, a.revenue, "2026-05-01", "2026-06-01", 4_000_000);
      // E: dated Oct 5: not in the aging as of any September date
      await invoice(co, a.customer, a.revenue, "2026-10-05", "2026-11-05", 5_000_000);

      const o = await arCompany("DW-7j f8 Other");
      other = o.tenant;
      await invoice(other, o.customer, o.revenue, "2026-05-01", "2026-06-01", 8_000_000); // 100% overdue
      await invoice(other, o.customer, o.revenue, "2026-09-01", "2026-12-01", 2_000_000);

      const f = await arCompany("DW-7j f8 Off");
      off = f.tenant;
      await invoice(off, f.customer, f.revenue, "2026-05-01", "2026-06-01", 8_000_000);
      await turnModulesOff(off);
    }, 180_000);

    it("overdue (d1_30 + d31_60 + d61_90 + d90_plus) ÷ total outstanding, across customers, as of asOf", async () => {
      // Sep 30: A current; B 10d, C 60d, D 121d overdue; E not yet issued -> 9m / 10m
      expect(await overdueShare(ctxFor(co))).toEqual({ value: 9 / 10, numerator: 9_000_000, denominator: 10_000_000 });
    });

    it("an invoice is overdue the day AFTER its due date, not ON it (B)", async () => {
      expect(await overdueShare(ctxFor(co, { asOf: "2026-09-20" }))).toEqual({ value: 7 / 10, numerator: 7_000_000, denominator: 10_000_000 });
      expect(await overdueShare(ctxFor(co, { asOf: "2026-09-21" }))).toEqual({ value: 9 / 10, numerator: 9_000_000, denominator: 10_000_000 });
    });

    it("the aging's invoice-date cut-off applies: an invoice dated after asOf is not outstanding yet; every bucket counts as overdue", async () => {
      // Aug 15: only C (14 days, d1_30) and D (75 days, d61_90) exist -> all of it is overdue
      expect(await overdueShare(ctxFor(co, { asOf: "2026-08-15" }))).toEqual({ value: 1, numerator: 7_000_000, denominator: 7_000_000 });
      // Oct 5: E (dated that day) is outstanding and current; B, C and D are overdue
      expect(await overdueShare(ctxFor(co, { asOf: "2026-10-05" }))).toEqual({ value: 9 / 15, numerator: 9_000_000, denominator: 15_000_000 });
    });

    it("a point in time: the window's start and end play no part, only asOf", async () => {
      expect(await overdueShare(ctxFor(co, { start: "2026-01-01", end: "2026-01-31" }))).toEqual(await overdueShare(ctxFor(co)));
      expect(await overdueShare(ctxFor(co, { unitId: "d-any" }))).toEqual(await overdueShare(ctxFor(co)));
    });

    it("another tenant's receivables are never counted", async () => {
      expect(await overdueShare(ctxFor(other))).toEqual({ value: 8 / 10, numerator: 8_000_000, denominator: 10_000_000 });
    });

    it("null when nothing is outstanding (as of a date before any invoice), never 0", async () => {
      expect(await overdueShare(ctxFor(co, { asOf: "2026-04-01" }))).toBeNull();
    });

    it("null, not an error, for a company that turned the finance module off", async () => {
      expect(await overdueShare(ctxFor(off))).toBeNull();
    });
  });
});
