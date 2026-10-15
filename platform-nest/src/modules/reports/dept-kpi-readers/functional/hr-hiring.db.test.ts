// DW-7j f5 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.5): time to hire in MINUTES, called through its registered
// `gated("hr", ...)` wrapper with a ReaderCtx against live Postgres + RLS + the hr wall. The zone is Asia/Makassar (UTC+8, no DST):
// window Sep 1 .. Sep 30 2026 is [2026-08-31T16:00Z, 2026-09-30T16:00Z) on `converted_at`.
//
// Every hire's duration is a whole number of minutes so the mean is exact:
//   h1 600  h2 1200  h3 300 (approved_at: never opened)  h6 120 (opened_at wins over an earlier approved_at)  w1 720  w3 6
//   skipped: h4 (no usable start), h5 (start after the conversion); out of the window: w2 (Aug 31), w4 (Oct 1)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../../testing/setup";
import { createCompany, createUser } from "../../../../testing/fixtures";
import { at } from "../../../../testing/dept-kpi-seed";
import { turnModulesOff } from "../../../../testing/finance-kpi-seed";
import { seedHire, type HireSeed } from "../../../../testing/hr-kpi-seed";
import type { ReaderCtx } from "../types";
import { FUNCTIONAL_READERS } from "./index";

const timeToHire = FUNCTIONAL_READERS["hr.time_to_hire"];

describe.skipIf(!TEST_URL)("DW-7j f5 time to hire (live PG + RLS + hr wall)", () => {
  let co: string;
  let other: string;
  let off: string;
  let actor: string;
  let savedTz: string;

  const ctx = (over: Partial<ReaderCtx> = {}): ReaderCtx => ({
    tenantId: co, unitId: "d-hr", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: "2026-09-30", ...over,
  });
  const hire = (tenant: string, o: Omit<HireSeed, "tenant" | "actor">) => seedHire({ tenant, actor, ...o });
  const minutes = (r: Awaited<ReturnType<typeof timeToHire>>) => r?.value;

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar";
    actor = await createUser("actor@dw7jf5.test");
    co = await createCompany("DW-7j f5 Co", ["hr"]);
    other = await createCompany("DW-7j f5 Other", ["hr"]);
    off = await createCompany("DW-7j f5 Off", ["hr"]);

    await hire(co, { openedAt: await at("2026-09-01"), convertedAt: await at("2026-09-01", 36000) }); // h1: 600
    await hire(co, { openedAt: await at("2026-09-02"), convertedAt: await at("2026-09-02", 72000) }); // h2: 1200
    await hire(co, { openedAt: null, approvedAt: await at("2026-09-03"), convertedAt: await at("2026-09-03", 18000) }); // h3: approved_at fallback, 300
    await hire(co, { openedAt: null, approvedAt: null, convertedAt: await at("2026-09-04", 36000) }); // h4: no usable start, skipped
    await hire(co, { openedAt: await at("2026-09-10"), convertedAt: await at("2026-09-05") }); // h5: start AFTER the conversion, skipped
    await hire(co, { openedAt: await at("2026-09-06"), approvedAt: await at("2026-09-01"), convertedAt: await at("2026-09-06", 7200) }); // h6: opened_at wins, 120
    // The window's edges on converted_at: first instant in, 1 s before it out; last second in, first instant after out
    await hire(co, { openedAt: await at("2026-08-31", 43200), convertedAt: await at("2026-09-01") }); // w1: Sep 1 00:00 local, in, 720
    await hire(co, { openedAt: await at("2026-08-31", 86039), convertedAt: await at("2026-08-31", 86399) }); // w2: Aug 31 23:59:59 local, OUT, 6
    await hire(co, { openedAt: await at("2026-09-30", 86039), convertedAt: await at("2026-09-30", 86399) }); // w3: Sep 30 23:59:59 local, in, 6
    await hire(co, { openedAt: await at("2026-09-30"), convertedAt: await at("2026-10-01") }); // w4: Oct 1 00:00 local, OUT, 1440
    // an offer that never converted is not a hire
    await hire(co, { openedAt: await at("2026-09-01"), convertedAt: null });
    // another company's hire
    await hire(other, { openedAt: await at("2026-09-01"), convertedAt: await at("2026-09-01", 36000) }); // 600
    // off: HR turned off after its rows exist
    await hire(off, { openedAt: await at("2026-09-01"), convertedAt: await at("2026-09-01", 36000) });
    await turnModulesOff(off);
  }, 180_000);

  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  it("the mean of converted_at minus the requisition's opened_at, in minutes, over the hires converted in the window", async () => {
    // h1 h2 h3 h6 w1 w3 = 600 + 1200 + 300 + 120 + 720 + 6 = 2946 over 6 hires
    const r = await timeToHire(ctx());
    expect(minutes(r)).toBeCloseTo(491, 6);
    expect(r).not.toHaveProperty("numerator"); // an average has neither
    expect(r).not.toHaveProperty("denominator");
  });

  it("a requisition never opened measures from approved_at (h3); opened_at wins when both are set (h6)", async () => {
    expect(minutes(await timeToHire(ctx({ start: "2026-09-03", end: "2026-09-03" })))).toBeCloseTo(300, 6);
    expect(minutes(await timeToHire(ctx({ start: "2026-09-06", end: "2026-09-06" })))).toBeCloseTo(120, 6); // 3000 if approved_at had been used
  });

  it("a hire with no usable start (h4), or whose start is after its conversion (h5), is skipped, not counted as 0", async () => {
    expect(await timeToHire(ctx({ start: "2026-09-04", end: "2026-09-04" }))).toBeNull(); // h4 alone
    expect(await timeToHire(ctx({ start: "2026-09-05", end: "2026-09-05" }))).toBeNull(); // h5 alone
    // and they do not drag the mean down when others are present: Sep 1 .. Sep 6 is h1 h2 h3 h6 w1 = 2940 / 5
    expect(minutes(await timeToHire(ctx({ start: "2026-09-01", end: "2026-09-06" })))).toBeCloseTo(588, 6);
  });

  it("the window's first and last instants on converted_at are in, the instants just outside are out (half-open)", async () => {
    expect(minutes(await timeToHire(ctx({ start: "2026-09-01", end: "2026-09-01" })))).toBeCloseTo(660, 6); // w1 (720) and h1 (600)
    expect(minutes(await timeToHire(ctx({ start: "2026-08-31", end: "2026-08-31" })))).toBeCloseTo(6, 6); // w2 only
    expect(minutes(await timeToHire(ctx({ start: "2026-09-30", end: "2026-09-30" })))).toBeCloseTo(6, 6); // w3 only
    expect(minutes(await timeToHire(ctx({ start: "2026-10-01", end: "2026-10-01" })))).toBeCloseTo(1440, 6); // w4 only
  });

  it("an offer that never converted is not a hire; another company's hire is never counted; the unit and asOf make no difference", async () => {
    expect(minutes(await timeToHire(ctx({ unitId: "d-any", asOf: "2026-09-02" })))).toBeCloseTo(491, 6);
    expect(minutes(await timeToHire(ctx({ tenantId: other })))).toBeCloseTo(600, 6);
  });

  it("null when no hire is measurable: an empty window", async () => {
    expect(await timeToHire(ctx({ start: "2026-11-01", end: "2026-11-30", asOf: "2026-11-30" }))).toBeNull();
  });

  it("null, never an error, for a company that turned HR off", async () => {
    expect(await timeToHire(ctx({ tenantId: off }))).toBeNull();
  });
});
