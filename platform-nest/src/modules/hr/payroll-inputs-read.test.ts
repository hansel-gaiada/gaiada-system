// DW-7f-1c (BFF §50) — GET /api/:t/modules/hr/payroll-inputs, driven over REAL HTTP against live
// Postgres + live Cerbos (`buildApp()` + `app.inject()`), the way hr-full-acceptance.test.ts does.
//
// What this proves, and why each piece is here:
//   - the `runId` filter lists what ONE run consumed and nothing the other run took;
//   - the period filter is OVERLAP, checked one day outside AND one day inside both edges, because an
//     off-by-one on either edge is exactly the bug a mid-range fixture never shows;
//   - `consumed=false` is "waiting for the next calculate";
//   - another company's inputs are never listed, and a reader of company A is refused on company B;
//   - a member without `hr_payroll` `read` (and the hr_staff tier) is refused with 403 — and the
//     refusal comes BEFORE validation, so a bad uuid from a refused caller is still 403 and the
//     denial assertion cannot be pre-empted by a 400;
//   - a malformed filter is a 400 `{message, field}`, never a 500 at a uuid or date cast.
//
// Needs DATABASE_URL_TEST + REDIS_URL_TEST + a live Cerbos. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { hrModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { setRedis, closeRedis } from "../../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const RUN = !!(TEST_URL && REDIS_TEST_URL);

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!RUN)("DW-7f-1c — payroll inputs: the read, over HTTP", () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  let A: string;          // company A, hr enabled
  let B: string;          // company B, hr enabled — the other tenant
  let hrMgr: string;      // hr_manager of A — holds hr_payroll read
  let hrStaff: string;    // hr_staff of A — the READ tier that must NOT reach payroll
  let member: string;     // ordinary staff of A — no payroll read
  let hrMgrB: string;     // hr_manager of B

  let ayu: string;        // employee of A
  let budi: string;       // employee of A
  let runA: string;       // regular run, Oct 2026
  let runB: string;       // correction run, same period — consumed nothing
  const ids: Record<string, string> = {};
  let foreignInput: string; // an input of company B

  const base = (t: string) => `/api/${t}/modules/hr`;
  const get = (t: string, user: string, qs = "") =>
    app.inject({ method: "GET", url: `${base(t)}/payroll-inputs${qs}`, headers: asUser(user) });
  const idsOf = (res: { json: () => unknown }): string[] => (res.json() as { id: string }[]).map((r) => r.id);

  /** Seed one input by SQL: `consumed_by_run_id` and `created_at` cannot be set through the POST. */
  async function seed(
    key: string, tenant: string, employee: string, start: string, end: string, label: string,
    opts: { consumedBy?: string | null; createdAt: string; category?: string; amount?: number; quantity?: number; taxable?: boolean; note?: string },
  ) {
    const rows = await withTenants([tenant], (c) => c.query<{ id: string }>(
      `INSERT INTO hr_payroll_inputs
         (tenant_id, employee_id, period_start, period_end, category, label, quantity, amount, taxable, note, consumed_by_run_id, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [tenant, employee, start, end, opts.category ?? "bonus", label, opts.quantity ?? null,
       opts.amount ?? (opts.quantity === undefined ? 100 : null), opts.taxable ?? true, opts.note ?? null,
       opts.consumedBy ?? null, tenant === A ? hrMgr : hrMgrB, opts.createdAt],
    ), { modules: ["hr"] });
    ids[key] = rows.rows[0].id;
    return rows.rows[0].id;
  }

  async function employee(tenant: string, name: string): Promise<string> {
    const r = await withTenants([tenant], (c) => c.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, display_name, hire_date) VALUES ($1,$2,'2026-01-01') RETURNING id`,
      [tenant, name],
    ), { modules: ["hr"] });
    return r.rows[0].id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    resetModules();
    resetCoreRollupProviders();
    registerModule(hrModule);
    await syncMetricDefinitions();

    A = await createCompany("Payroll Inputs Co A", ["hr"]);
    B = await createCompany("Payroll Inputs Co B", ["hr"]);
    hrMgr = await createUser("pi-hrmgr@a.test", "HR Manager A");
    hrStaff = await createUser("pi-hrstaff@a.test", "HR Assistant A");
    member = await createUser("pi-member@a.test", "Ordinary Staff A");
    hrMgrB = await createUser("pi-hrmgr@b.test", "HR Manager B");
    for (const u of [hrMgr, hrStaff, member]) await addMembership(A, u);
    await addMembership(B, hrMgrB);
    await grantRole(hrMgr, await createRole("hr_manager"), "company", A);
    await grantRole(hrStaff, await createRole("hr_staff"), "company", A);
    await grantRole(member, await createRole("member"), "company", A);
    await grantRole(hrMgrB, await createRole("hr_manager"), "company", B);

    app = await buildApp();
    await app.init();

    ayu = await employee(A, "Ayu Lestari");
    budi = await employee(A, "Budi Santoso");
    const employeeB = await employee(B, "Citra Dewi");

    // Two runs for the SAME period (a correction may coexist with the regular run).
    const r1 = await app.inject({
      method: "POST", url: `${base(A)}/payroll-runs`, headers: asUser(hrMgr),
      payload: { reference: "PI-2026-10", kind: "regular", periodStart: "2026-10-01", periodEnd: "2026-10-31" },
    });
    expect(r1.statusCode).toBe(201);
    runA = r1.json().id;
    const r2 = await app.inject({
      method: "POST", url: `${base(A)}/payroll-runs`, headers: asUser(hrMgr),
      payload: { reference: "PI-2026-10-c", kind: "correction", periodStart: "2026-10-01", periodEnd: "2026-10-31" },
    });
    expect(r2.statusCode).toBe(201);
    runB = r2.json().id;

    // Report window under test: 2026-10-01 .. 2026-10-31. created_at ascends with the key order, so
    // the newest-first order is the REVERSE of this list.
    await seed("consumedWide", A, ayu, "2026-10-01", "2026-10-31", "Overtime October", {
      consumedBy: runA, createdAt: "2020-10-02T09:00:00Z", category: "overtime", quantity: 12.5, taxable: true, note: "Month-end close",
    });
    await seed("consumedDay", A, budi, "2026-10-15", "2026-10-15", "Spot bonus", {
      consumedBy: runA, createdAt: "2020-10-03T09:00:00Z", category: "bonus", amount: 250000, taxable: false,
    });
    await seed("endsBefore", A, ayu, "2026-09-01", "2026-09-30", "September claim", {
      createdAt: "2020-10-04T09:00:00Z", category: "reimbursement", amount: 75000,
    });   // ends the day BEFORE the window opens -> outside
    await seed("startsAfter", A, budi, "2026-11-01", "2026-11-30", "November advance", {
      createdAt: "2020-10-05T09:00:00Z", category: "advance", amount: 500000,
    });   // starts the day AFTER the window closes -> outside
    await seed("waitingMid", A, ayu, "2026-10-20", "2026-10-25", "Waiting commission", {
      createdAt: "2020-10-06T09:00:00Z", category: "commission", amount: 120000,
    });
    await seed("touchesStart", A, budi, "2026-09-25", "2026-10-01", "Straddles the opening day", {
      createdAt: "2020-10-07T09:00:00Z", category: "deduction", amount: 30000,
    });   // period_end == window start -> inside (one day)
    await seed("touchesEnd", A, ayu, "2026-10-31", "2026-11-05", "Straddles the closing day", {
      createdAt: "2020-10-08T09:00:00Z", category: "other", amount: 45000,
    });   // period_start == window end -> inside (one day)

    foreignInput = await seed("foreign", B, employeeB, "2026-10-01", "2026-10-31", "Company B bonus", {
      createdAt: "2020-10-09T09:00:00Z", amount: 999,
    });
  });

  afterAll(async () => {
    await app?.close();
    // `setRedis(redis)` handed ownership to the module-level client; closing it again double-closes.
    await closeRedis();
    await teardownTestDb();
  });

  it("lists what ONE run consumed by runId, and nothing for the run that consumed nothing", async () => {
    const a = await get(A, hrMgr, `?runId=${runA}`);
    expect(a.statusCode).toBe(200);
    // Newest first: consumedDay was created after consumedWide.
    expect(idsOf(a)).toEqual([ids.consumedDay, ids.consumedWide]);
    const b = await get(A, hrMgr, `?runId=${runB}`);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual([]);
  });

  it("returns the contract's row shape, with employeeName joined from employees", async () => {
    const res = await get(A, hrMgr, `?runId=${runA}`);
    const wide = (res.json() as Record<string, unknown>[]).find((r) => r.id === ids.consumedWide)!;
    expect(Object.keys(wide).sort()).toEqual([
      "amount", "category", "code", "consumedByRunId", "createdAt", "createdBy", "employeeId",
      "employeeName", "id", "label", "note", "periodEnd", "periodStart", "quantity", "taxable",
    ]);
    expect(wide.employeeName).toBe("Ayu Lestari");
    expect(wide.employeeId).toBe(ayu);
    expect(wide.periodStart).toBe("2026-10-01");
    expect(wide.periodEnd).toBe("2026-10-31");
    expect(wide.category).toBe("overtime");
    expect(Number(wide.quantity)).toBe(12.5);
    expect(wide.amount).toBeNull();
    expect(wide.taxable).toBe(true);
    expect(wide.note).toBe("Month-end close");
    expect(wide.consumedByRunId).toBe(runA);
    expect(wide.createdBy).toBe(hrMgr);
    const day = (res.json() as Record<string, unknown>[]).find((r) => r.id === ids.consumedDay)!;
    expect(day.employeeName).toBe("Budi Santoso");
    expect(day.taxable).toBe(false);
    expect(Number(day.amount)).toBe(250000);
  });

  it("period filter is OVERLAP: one day outside is out, one day inside each edge is in", async () => {
    const res = await get(A, hrMgr, "?periodStart=2026-10-01&periodEnd=2026-10-31");
    expect(res.statusCode).toBe(200);
    const got = new Set(idsOf(res));
    // inside: the two consumed ones, the mid one, and BOTH edge-touching ones
    for (const k of ["consumedWide", "consumedDay", "waitingMid", "touchesStart", "touchesEnd"]) {
      expect(got.has(ids[k]), `${k} should be listed`).toBe(true);
    }
    // outside: ends on 09-30 / starts on 11-01
    expect(got.has(ids.endsBefore), "endsBefore must not be listed").toBe(false);
    expect(got.has(ids.startsAfter), "startsAfter must not be listed").toBe(false);
    expect(got.size).toBe(5);
  });

  it("a single period bound is a half-open overlap", async () => {
    const from = new Set(idsOf(await get(A, hrMgr, "?periodStart=2026-10-31")));
    // everything whose period ends on/after 10-31: the Oct-wide one, the 10-31 straddler, November
    expect([...from].sort()).toEqual([ids.consumedWide, ids.touchesEnd, ids.startsAfter].sort());
    const until = new Set(idsOf(await get(A, hrMgr, "?periodEnd=2026-09-30")));
    // everything whose period starts on/before 09-30: September ones only
    expect([...until].sort()).toEqual([ids.endsBefore, ids.touchesStart].sort());
  });

  it("consumed=false lists what waits for the next calculate, with the run's period", async () => {
    const res = await get(A, hrMgr, "?periodStart=2026-10-01&periodEnd=2026-10-31&consumed=false");
    expect(res.statusCode).toBe(200);
    expect(new Set(idsOf(res))).toEqual(new Set([ids.waitingMid, ids.touchesStart, ids.touchesEnd]));
    for (const r of res.json() as { consumedByRunId: string | null }[]) expect(r.consumedByRunId).toBeNull();
    // newest first: touchesEnd (10-08) > touchesStart (10-07) > waitingMid (10-06)
    expect(idsOf(res)).toEqual([ids.touchesEnd, ids.touchesStart, ids.waitingMid]);
  });

  it("consumed=true lists only consumed rows; no filter lists both", async () => {
    const taken = await get(A, hrMgr, "?consumed=true");
    expect(new Set(idsOf(taken))).toEqual(new Set([ids.consumedWide, ids.consumedDay]));
    const all = await get(A, hrMgr);
    expect(all.statusCode).toBe(200);
    expect(idsOf(all)).toEqual([
      ids.touchesEnd, ids.touchesStart, ids.waitingMid, ids.startsAfter, ids.endsBefore, ids.consumedDay, ids.consumedWide,
    ]);
  });

  it("employeeId narrows, and combines with the other filters", async () => {
    const mine = await get(A, hrMgr, `?employeeId=${budi}`);
    expect(new Set(idsOf(mine))).toEqual(new Set([ids.consumedDay, ids.startsAfter, ids.touchesStart]));
    const both = await get(A, hrMgr, `?employeeId=${budi}&consumed=false&periodStart=2026-10-01&periodEnd=2026-10-31`);
    expect(idsOf(both)).toEqual([ids.touchesStart]);
  });

  it("an input added through the POST shows up in the read (the write and the read agree)", async () => {
    const added = await app.inject({
      method: "POST", url: `${base(A)}/payroll-inputs`, headers: asUser(hrMgr),
      payload: { employeeId: budi, periodStart: "2026-10-10", periodEnd: "2026-10-12", category: "overtime", label: "Weekend shift", quantity: 8 },
    });
    expect(added.statusCode).toBe(201);
    const res = await get(A, hrMgr, "?consumed=false&periodStart=2026-10-10&periodEnd=2026-10-12");
    const row = (res.json() as { id: string; label: string; employeeName: string; consumedByRunId: string | null }[])
      .find((r) => r.id === added.json().id);
    expect(row?.label).toBe("Weekend shift");
    expect(row?.employeeName).toBe("Budi Santoso");
    expect(row?.consumedByRunId).toBeNull();
    // Newest first: the one just added leads an unfiltered list.
    expect(idsOf(await get(A, hrMgr))[0]).toBe(added.json().id);
  });

  it("never lists another tenant's inputs, and a reader of A is refused on B", async () => {
    for (const qs of ["", "?consumed=false", "?periodStart=2026-10-01&periodEnd=2026-10-31", `?runId=${runA}`]) {
      expect(idsOf(await get(A, hrMgr, qs)), `A ${qs}`).not.toContain(foreignInput);
    }
    // B's own manager sees B's input and none of A's, even when asking for A's run id.
    const own = await get(B, hrMgrB);
    expect(own.statusCode).toBe(200);
    expect(idsOf(own)).toEqual([foreignInput]);
    const cross = await get(B, hrMgrB, `?runId=${runA}`);
    expect(cross.statusCode).toBe(200);
    expect(cross.json()).toEqual([]);
    // A's manager holds no grant on B at all.
    expect((await get(B, hrMgr)).statusCode).toBe(403);
  });

  it("refuses a member without hr_payroll read, and hr_staff, with 403 (before any validation)", async () => {
    expect((await get(A, member)).statusCode).toBe(403);
    expect((await get(A, hrStaff)).statusCode).toBe(403);
    // A refused caller with a malformed filter is still 403, not a 400 that leaks the filter shape.
    expect((await get(A, member, "?runId=not-a-uuid")).statusCode).toBe(403);
    expect((await get(A, hrStaff, "?periodStart=nope")).statusCode).toBe(403);
  });

  it("answers a malformed filter with 400 {message, field}, never a 500", async () => {
    const cases: [string, string][] = [
      ["?runId=not-a-uuid", "runId"],
      ["?employeeId=123", "employeeId"],
      ["?periodStart=2026-13-01", "periodStart"],
      ["?periodStart=01-10-2026", "periodStart"],
      ["?periodEnd=2026-02-30", "periodEnd"],
      ["?consumed=maybe", "consumed"],
    ];
    for (const [qs, field] of cases) {
      const res = await get(A, hrMgr, qs);
      expect(res.statusCode, qs).toBe(400);
      const body = res.json() as { message: string; field: string };
      expect(body.field, qs).toBe(field);
      expect(typeof body.message).toBe("string");
    }
  });
});
