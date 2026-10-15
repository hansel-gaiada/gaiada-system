// DW-7j f1 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): the GM's revenue against plan, called DIRECTLY (through its `gated`
// wrapper, as it is registered) with a ReaderCtx against live Postgres + RLS + the finance wall. The plan is stored in the
// currency's minor unit and the P&L is in major units; the base currency here is IDR (0 decimals), so the two coincide, and the
// minor-unit conversion is pinned in finance/revenue-plan.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { postJournal, seedFinanceCompany, seedRevenuePlan, turnModulesOff } from "../../../../testing/finance-kpi-seed";
import { createCompany, createUser } from "../../../../testing/fixtures";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const revenueVsPlan = FUNCTIONAL_READERS["gm.revenue_vs_plan"];

describe.skipIf(!TEST_URL)("DW-7j f1 gm.revenue_vs_plan (live PG + RLS + finance wall)", () => {
  let co: string;
  let other: string;
  let off: string;
  let noSettings: string;
  let otherCurrency: string;
  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-gm", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });

  beforeAll(async () => {
    await initTestDb();
    const by = await createUser("gm-f1@dw7j.test");
    co = (await seedFinanceCompany("DW-7j f1 Co", { periods: "monthly" })).tenant;
    other = (await seedFinanceCompany("DW-7j f1 Other", { periods: "monthly" })).tenant;
    off = (await seedFinanceCompany("DW-7j f1 Off", { periods: "monthly" })).tenant;
    otherCurrency = (await seedFinanceCompany("DW-7j f1 Currency", { periods: "monthly" })).tenant;
    noSettings = await createCompany("DW-7j f1 No settings", ["finance"]);

    // Revenue (IDR, major units): September 100m on the 5th and 50m on the 25th; October 31m on the 10th.
    await postJournal(co, "2026-09-05", "f1-sep-a", [["1120", "debit", 100_000_000], ["4100", "credit", 100_000_000]]);
    await postJournal(co, "2026-09-25", "f1-sep-b", [["1120", "debit", 50_000_000], ["4100", "credit", 50_000_000]]);
    await postJournal(co, "2026-10-10", "f1-oct", [["1120", "debit", 31_000_000], ["4100", "credit", 31_000_000]]);
    // Plans (IDR has 0 decimals, so minor = major): September 200m, October 310m, November none, December 0.
    await seedRevenuePlan(co, "2026-09", 200_000_000, by);
    await seedRevenuePlan(co, "2026-10", 310_000_000, by);
    await seedRevenuePlan(co, "2026-12", 0, by);
    // July: planned at 100m, with an expense and no revenue
    await postJournal(co, "2026-07-20", "f1-jul-exp", [["6100", "debit", 1_000_000], ["1120", "credit", 1_000_000]]);
    await seedRevenuePlan(co, "2026-07", 100_000_000, by);

    // another tenant: its own plan and books (never counted for `co`)
    await postJournal(other, "2026-09-05", "f1-other-rev", [["1120", "debit", 500], ["4100", "credit", 500]]);
    await seedRevenuePlan(other, "2026-09", 1_000, by);

    // a company whose finance module was turned off after it planned
    await postJournal(off, "2026-09-05", "f1-off-rev", [["1120", "debit", 500], ["4100", "credit", 500]]);
    await seedRevenuePlan(off, "2026-09", 1_000, by);
    await turnModulesOff(off);

    // a company whose plan is in a currency other than its base (IDR): it cannot be compared with the P&L
    await postJournal(otherCurrency, "2026-09-05", "f1-usd-rev", [["1120", "debit", 500], ["4100", "credit", 500]]);
    await seedRevenuePlan(otherCurrency, "2026-09", 100_000, by, "USD");
  }, 120_000);

  afterAll(teardownTestDb);

  it("a full month: the month's revenue ÷ its plan, the revenue as numerator and the plan as denominator", async () => {
    expect(await revenueVsPlan(ctx())).toEqual({ value: 150_000_000 / 200_000_000, numerator: 150_000_000, denominator: 200_000_000 });
  });

  it("a partial month is pro-rated: the plan's share of the days inside the window (15 of September's 30 days)", async () => {
    // 16..30 September is half the plan (100m); the revenue in it is the 25th's 50m
    expect(await revenueVsPlan(ctx({ start: "2026-09-16" }))).toEqual({ value: 0.5, numerator: 50_000_000, denominator: 100_000_000 });
  });

  it("a window over a month end sums each month's share (Sep 16 to Oct 15: 15/30 of 200m and 15/31 of 310m)", async () => {
    const plan = 100_000_000 + (310_000_000 * 15) / 31; // 250m
    const r = await revenueVsPlan(ctx({ start: "2026-09-16", end: "2026-10-15", asOf: "2026-10-15" }));
    expect(r?.numerator).toBe(81_000_000); // 50m + 31m
    expect(r?.denominator).toBeCloseTo(plan, 4);
    expect(r?.value).toBeCloseTo(81_000_000 / plan, 9);
  });

  it("null when ANY overlapping month has no plan, even if the other has one", async () => {
    expect(await revenueVsPlan(ctx({ start: "2026-11-01", end: "2026-11-30" }))).toBeNull(); // November: no plan
    expect(await revenueVsPlan(ctx({ start: "2026-10-16", end: "2026-11-15" }))).toBeNull(); // October planned, November not
    expect(await revenueVsPlan(ctx({ start: "2026-08-01", end: "2026-09-30" }))).toBeNull(); // August: no plan
  });

  it("null when the plan sums to 0 (December is planned at 0), never a division by zero", async () => {
    expect(await revenueVsPlan(ctx({ start: "2026-12-01", end: "2026-12-31" }))).toBeNull();
  });

  it("a planned month with no revenue is a real 0, not null", async () => {
    expect(await revenueVsPlan(ctx({ start: "2026-07-01", end: "2026-07-31", asOf: "2026-07-31" }))).toEqual({ value: 0, numerator: 0, denominator: 100_000_000 });
  });

  it("company grain: the unit in the context makes no difference", async () => {
    expect(await revenueVsPlan(ctx({ unitId: "some-other-unit" }))).toEqual(await revenueVsPlan(ctx()));
  });

  it("another tenant's plan and books are never counted, and read under their own tenant they are their own number", async () => {
    expect(await revenueVsPlan(ctx({ tenantId: other }))).toEqual({ value: 0.5, numerator: 500, denominator: 1_000 });
    expect((await revenueVsPlan(ctx()))?.denominator).toBe(200_000_000);
  });

  it("null for a company with no finance settings (no base currency), and for a plan in another currency than the base", async () => {
    expect(await revenueVsPlan(ctx({ tenantId: noSettings }))).toBeNull();
    expect(await revenueVsPlan(ctx({ tenantId: otherCurrency }))).toBeNull();
  });

  it("null, not an error, for a company that turned the finance module off (its old rows are not read)", async () => {
    expect(await revenueVsPlan(ctx({ tenantId: off }))).toBeNull();
  });
});
