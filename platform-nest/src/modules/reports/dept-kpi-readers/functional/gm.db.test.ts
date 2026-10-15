// DW-7j f2 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): the GM's margin, called DIRECTLY (through its `gated` wrapper, as it
// is registered) with a ReaderCtx against live Postgres + RLS + the finance wall. The window is inclusive dates, so a journal on
// the first and on the last day is in and one on the day before or after is out.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { postJournal, seedFinanceCompany, turnModulesOff } from "../../../../testing/finance-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const margin = FUNCTIONAL_READERS["gm.margin"];

describe.skipIf(!TEST_URL)("DW-7j f2 gm.margin (live PG + RLS + finance wall)", () => {
  let co: string;
  let other: string;
  let off: string;
  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-gm", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });

  beforeAll(async () => {
    await initTestDb();
    co = (await seedFinanceCompany("DW-7j f2 Co", { periods: "monthly" })).tenant;
    other = (await seedFinanceCompany("DW-7j f2 Other", { periods: "monthly" })).tenant;
    off = (await seedFinanceCompany("DW-7j f2 Off", { periods: "monthly" })).tenant;

    // September: revenue 100m + 50m, expense 30m -> net 120m on revenue 150m. The first and last day are inside.
    await postJournal(co, "2026-09-01", "co-rev-first", [["1120", "debit", 100_000_000], ["4100", "credit", 100_000_000]]);
    await postJournal(co, "2026-09-10", "co-exp", [["6100", "debit", 30_000_000], ["1120", "credit", 30_000_000]]);
    await postJournal(co, "2026-09-30", "co-rev-last", [["1120", "debit", 50_000_000], ["4100", "credit", 50_000_000]]);
    // Outside: the day before (an expense only: August has no revenue) and the day after (revenue only).
    await postJournal(co, "2026-08-31", "co-exp-before", [["6200", "debit", 7_000_000], ["1120", "credit", 7_000_000]]);
    await postJournal(co, "2026-10-01", "co-rev-after", [["1120", "debit", 999_000_000], ["4100", "credit", 999_000_000]]);
    // October 2: an expense with no revenue that day
    await postJournal(co, "2026-10-02", "co-exp-oct", [["6100", "debit", 40_000_000], ["1120", "credit", 40_000_000]]);

    // another tenant: its own books, never counted for `co`
    await postJournal(other, "2026-09-05", "other-rev", [["1120", "debit", 10_000_000], ["4100", "credit", 10_000_000]]);
    await postJournal(other, "2026-09-06", "other-exp", [["6100", "debit", 5_000_000], ["1120", "credit", 5_000_000]]);

    // a company whose finance module was turned off after it posted
    await postJournal(off, "2026-09-05", "off-rev", [["1120", "debit", 10_000_000], ["4100", "credit", 10_000_000]]);
    await turnModulesOff(off);
  }, 120_000);

  afterAll(teardownTestDb);

  it("net ÷ revenue over the window's inclusive dates, with the net and revenue as numerator and denominator", async () => {
    expect(await margin(ctx())).toEqual({ value: 120_000_000 / 150_000_000, numerator: 120_000_000, denominator: 150_000_000 });
  });

  it("the window's edges are inclusive dates: the first and last day alone, and the days just outside, are separate", async () => {
    expect(await margin(ctx({ start: "2026-09-01", end: "2026-09-01" }))).toEqual({ value: 1, numerator: 100_000_000, denominator: 100_000_000 });
    expect(await margin(ctx({ start: "2026-09-30", end: "2026-09-30" }))).toEqual({ value: 1, numerator: 50_000_000, denominator: 50_000_000 });
    expect(await margin(ctx({ start: "2026-10-01", end: "2026-10-01" }))).toEqual({ value: 1, numerator: 999_000_000, denominator: 999_000_000 });
  });

  it("a window spanning two months sums both months (revenue, expense and net)", async () => {
    // Sep 1 .. Oct 2: revenue 1_149m, expense 30m + 40m -> net 1_079m
    expect(await margin(ctx({ end: "2026-10-02" }))).toEqual({ value: 1_079_000_000 / 1_149_000_000, numerator: 1_079_000_000, denominator: 1_149_000_000 });
  });

  it("null when revenue is 0 (an expense-only window and an empty window), never 0 or an error", async () => {
    expect(await margin(ctx({ start: "2026-08-31", end: "2026-08-31" }))).toBeNull(); // expense only
    expect(await margin(ctx({ start: "2026-11-01", end: "2026-11-30" }))).toBeNull(); // nothing posted
    expect(await margin(ctx({ start: "2026-10-02", end: "2026-10-02" }))).toBeNull(); // expense only (a loss with no revenue)
  });

  it("company grain: the unit in the context makes no difference", async () => {
    expect(await margin(ctx({ unitId: "some-other-unit" }))).toEqual(await margin(ctx()));
  });

  it("another tenant's books are never counted, and read under their own tenant they are their own number", async () => {
    expect(await margin(ctx({ tenantId: other }))).toEqual({ value: 5_000_000 / 10_000_000, numerator: 5_000_000, denominator: 10_000_000 });
    // co's number above (120m / 150m) already excludes other's 10m / 5m
    expect((await margin(ctx()))?.denominator).toBe(150_000_000);
  });

  it("null, not an error, for a company that turned the finance module off (its old rows are not read)", async () => {
    expect(await margin(ctx({ tenantId: off }))).toBeNull();
  });
});
