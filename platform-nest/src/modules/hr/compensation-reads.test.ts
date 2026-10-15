// DW-7f-3b (BFF §51) — GET employees/:id/allowances, /benefits and /tax-profile, driven over REAL HTTP against
// live Postgres + live Cerbos (`buildApp()` + `app.inject()`), the way payroll-inputs-read.test.ts does.
//
// What this proves, and why each piece is here:
//   - rows in force against closed ones, with the type / plan label joined from its own table;
//   - `current=true` at BOTH edges: a row that ENDS today is still in force, a row that ended YESTERDAY is not,
//     a row that STARTS today is in force, one that starts TOMORROW is not. "Today" is today in REPORTS_TZ,
//     computed here with the same helper the handler uses, so the two cannot disagree;
//   - the tax profile: the row in force, the full history newest first, `current: null` when none is in force
//     (only a future profile, or none at all), and a profile saved through the POST reads back;
//   - another company's employee, an employee that does not exist and a soft-deleted one are all 404, and a
//     reader of company A is refused (403) on company B's URL;
//   - the NPWP is returned to a payroll reader and ONLY to one: `hr_staff` and an ordinary member get 403 on all
//     three routes, and the refusal comes BEFORE validation, so a bad id from a refused caller is still 403;
//   - a malformed id (or `current`) is a 400 `{message, field}`, never a 500 at the uuid cast.
//
// Needs DATABASE_URL_TEST + REDIS_URL_TEST + a live Cerbos. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { hrModule } from "./index";
import { todayIsoInTz } from "../reports/person-scope";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { setRedis, closeRedis } from "../../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const RUN = !!(TEST_URL && REDIS_TEST_URL);

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const NPWP = "09.254.294.3-407.000";

/** `iso` shifted by `n` days, in UTC date arithmetic (the string has no zone). */
const shift = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!RUN)("DW-7f-3b — an employee's allowances, benefits and tax profile: the reads, over HTTP", () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  let A: string;          // company A, hr enabled
  let B: string;          // company B, hr enabled — the other tenant
  let hrMgr: string;      // hr_manager of A — holds hr_payroll read
  let hrStaff: string;    // hr_staff of A — the READ tier that must NOT reach payroll
  let member: string;     // ordinary staff of A — no payroll read
  let hrMgrB: string;     // hr_manager of B

  let ayu: string;        // employee of A with rows on every route
  let budi: string;       // employee of A with a few rows
  let dewi: string;       // employee of A with only a FUTURE tax profile
  let eka: string;        // employee of A with nothing on file
  let gone: string;       // soft-deleted employee of A
  let citra: string;      // employee of B

  const T = todayIsoInTz(config.reportsTz);   // today in REPORTS_TZ, as the handler computes it
  const ids: Record<string, string> = {};
  const types: Record<string, string> = {};
  const plans: Record<string, string> = {};

  const base = (t: string) => `/api/${t}/modules/hr`;
  const get = (t: string, user: string, emp: string, leaf: string, qs = "") =>
    app.inject({ method: "GET", url: `${base(t)}/employees/${emp}/${leaf}${qs}`, headers: asUser(user) });
  const idsOf = (res: { json: () => unknown }): string[] => (res.json() as { id: string }[]).map((r) => r.id);

  async function employee(tenant: string, name: string): Promise<string> {
    const r = await withTenants([tenant], (c) => c.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, display_name, hire_date) VALUES ($1,$2,'2026-01-01') RETURNING id`,
      [tenant, name],
    ), { modules: ["hr"] });
    return r.rows[0].id;
  }

  async function allowanceType(user: string, tenant: string, code: string, label: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `${base(tenant)}/allowance-types`, headers: asUser(user), payload: { code, label },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function benefitPlan(user: string, tenant: string, code: string, name: string, kind: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `${base(tenant)}/benefit-plans`, headers: asUser(user), payload: { code, name, kind },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  /** Seed by SQL: an effective range that ends in the past cannot be set through the POST. `createdAt` fixes the order of ties. */
  async function seedAllowance(
    key: string, tenant: string, employeeId: string, typeId: string, from: string, to: string | null,
    opts: { amount?: number; percent?: number; note?: string } = {},
  ) {
    const r = await withTenants([tenant], (c) => c.query<{ id: string }>(
      `INSERT INTO hr_employee_allowances (tenant_id, employee_id, allowance_type_id, amount, percent, effective_from, effective_to, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tenant, employeeId, typeId, opts.amount ?? (opts.percent === undefined ? 100000 : null), opts.percent ?? null, from, to, opts.note ?? null],
    ), { modules: ["hr"] });
    ids[key] = r.rows[0].id;
  }

  async function seedBenefit(
    key: string, tenant: string, employeeId: string, planId: string, from: string, to: string | null,
    opts: { status?: string; memberNumber?: string; dependants?: number; note?: string } = {},
  ) {
    const r = await withTenants([tenant], (c) => c.query<{ id: string }>(
      `INSERT INTO hr_benefit_enrollments (tenant_id, employee_id, plan_id, member_number, dependants, status, effective_from, effective_to, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tenant, employeeId, planId, opts.memberNumber ?? null, opts.dependants ?? 0, opts.status ?? "active", from, to, opts.note ?? null],
    ), { modules: ["hr"] });
    ids[key] = r.rows[0].id;
  }

  async function seedTax(
    key: string, tenant: string, employeeId: string, from: string, to: string | null,
    opts: { npwp?: string; ptkp?: string; ter?: string; resident?: boolean },
  ) {
    const r = await withTenants([tenant], (c) => c.query<{ id: string }>(
      `INSERT INTO hr_tax_profiles (tenant_id, employee_id, npwp, has_npwp, ptkp_status, ter_category, tax_resident, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tenant, employeeId, opts.npwp ?? null, opts.npwp !== undefined, opts.ptkp ?? "TK/0", opts.ter ?? "A", opts.resident ?? true, from, to],
    ), { modules: ["hr"] });
    ids[key] = r.rows[0].id;
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

    A = await createCompany("Comp Reads Co A", ["hr"]);
    B = await createCompany("Comp Reads Co B", ["hr"]);
    hrMgr = await createUser("cr-hrmgr@a.test", "HR Manager A");
    hrStaff = await createUser("cr-hrstaff@a.test", "HR Assistant A");
    member = await createUser("cr-member@a.test", "Ordinary Staff A");
    hrMgrB = await createUser("cr-hrmgr@b.test", "HR Manager B");
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
    dewi = await employee(A, "Dewi Anggraini");
    eka = await employee(A, "Eka Putri");
    gone = await employee(A, "Gone Person");
    citra = await employee(B, "Citra Dewi");
    await withTenants([A], (c) => c.query(`UPDATE employees SET deleted_at = now() WHERE id = $1`, [gone]), { modules: ["hr"] });

    for (const [code, label] of [["TRANSPORT", "Transport"], ["MEAL", "Meal"], ["POSITION", "Position"], ["HOUSING", "Housing"]]) {
      types[code] = await allowanceType(hrMgr, A, code, label);
    }
    types.B_TRANSPORT = await allowanceType(hrMgrB, B, "TRANSPORT", "Transport (B)");
    for (const [code, name, kind] of [
      ["BPJS-KES", "BPJS Kesehatan", "statutory"], ["PRIV-INS", "Private insurance", "insurance"], ["WELL", "Wellness", "wellness"],
      ["PENS", "Pension", "pension"],
    ]) {
      plans[code] = await benefitPlan(hrMgr, A, code, name, kind);
    }
    plans.B_KES = await benefitPlan(hrMgrB, B, "BPJS-KES", "BPJS Kesehatan (B)", "statutory");

    // ── Allowances. T = today. The same type may be held twice only over NON-overlapping ranges.
    await seedAllowance("trOld", A, ayu, types.TRANSPORT, shift(T, -60), shift(T, -31), { amount: 400000 });    // closed
    await seedAllowance("trNow", A, ayu, types.TRANSPORT, shift(T, -30), null, { amount: 500000, note: "Jakarta commute" }); // open
    await seedAllowance("mealEndsToday", A, ayu, types.MEAL, shift(T, -10), T, { percent: 2.5 });               // ends TODAY: in force
    await seedAllowance("posEndedYesterday", A, ayu, types.POSITION, shift(T, -20), shift(T, -1), { amount: 750000 }); // ended YESTERDAY: out
    await seedAllowance("housingTomorrow", A, ayu, types.HOUSING, shift(T, 1), null, { amount: 1000000 });      // starts TOMORROW: out
    await seedAllowance("budiTransport", A, budi, types.TRANSPORT, shift(T, -5), null, { amount: 300000 });
    await seedAllowance("foreignTransport", B, citra, types.B_TRANSPORT, shift(T, -5), null, { amount: 999 });

    // ── Benefits.
    await seedBenefit("kes", A, ayu, plans["BPJS-KES"], shift(T, -100), null, { memberNumber: "0001234567890", dependants: 2 });
    await seedBenefit("insEndedYesterday", A, ayu, plans["PRIV-INS"], shift(T, -50), shift(T, -1), { status: "terminated", note: "Policy lapsed" });
    await seedBenefit("wellStartsToday", A, ayu, plans.WELL, T, null, { status: "active" });
    await seedBenefit("budiKes", A, budi, plans["BPJS-KES"], shift(T, -5), null);
    // Budi's other enrolments have an OPEN range but are not active: they are not in force.
    await seedBenefit("budiTerminated", A, budi, plans["PRIV-INS"], shift(T, -5), null, { status: "terminated" });
    await seedBenefit("budiSuspended", A, budi, plans.WELL, shift(T, -5), null, { status: "suspended" });
    await seedBenefit("budiPending", A, budi, plans.PENS, shift(T, -5), null, { status: "pending" });
    await seedBenefit("foreignKes", B, citra, plans.B_KES, shift(T, -5), null);

    // ── Tax profiles. Ayu: a closed one then the open one. Dewi: only one that starts in the future.
    await seedTax("ayuOld", A, ayu, shift(T, -400), shift(T, -201), { ptkp: "TK/0", ter: "A" });
    await seedTax("ayuNow", A, ayu, shift(T, -200), null, { npwp: NPWP, ptkp: "K/1", ter: "B", resident: true });
    await seedTax("dewiFuture", A, dewi, shift(T, 5), null, { ptkp: "TK/1", ter: "A" });
    await seedTax("foreignTax", B, citra, shift(T, -5), null, { npwp: "99.999.999.9-999.999" });
  });

  afterAll(async () => {
    await app?.close();
    // `setRedis(redis)` handed ownership to the module-level client; closing it again double-closes.
    await closeRedis();
    await teardownTestDb();
  });

  // ─────────────────────────────────────────────────────────────────────────── allowances
  it("allowances: lists every row newest first, with the type's code and label joined", async () => {
    const res = await get(A, hrMgr, ayu, "allowances");
    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([
      ids.housingTomorrow, ids.mealEndsToday, ids.posEndedYesterday, ids.trNow, ids.trOld,
    ]);
    const rows = res.json() as Record<string, unknown>[];
    const tr = rows.find((r) => r.id === ids.trNow)!;
    expect(Object.keys(tr).sort()).toEqual([
      "allowanceCode", "allowanceLabel", "allowanceTypeId", "amount", "createdAt", "direction",
      "effectiveFrom", "effectiveTo", "employeeId", "id", "note", "percent",
    ]);
    expect(tr.allowanceCode).toBe("TRANSPORT");
    expect(tr.allowanceLabel).toBe("Transport");
    expect(tr.allowanceTypeId).toBe(types.TRANSPORT);
    expect(tr.direction).toBe("allowance");
    expect(tr.employeeId).toBe(ayu);
    expect(Number(tr.amount)).toBe(500000);
    expect(tr.percent).toBeNull();
    expect(tr.effectiveFrom).toBe(shift(T, -30));
    expect(tr.effectiveTo).toBeNull();
    expect(tr.note).toBe("Jakarta commute");
    const meal = rows.find((r) => r.id === ids.mealEndsToday)!;
    expect(meal.allowanceLabel).toBe("Meal");
    expect(Number(meal.percent)).toBe(2.5);
    expect(meal.amount).toBeNull();
    expect(meal.effectiveTo).toBe(T);
  });

  it("allowances: current=true keeps what is in force today; ends-today is in, ended-yesterday and starts-tomorrow are out", async () => {
    const res = await get(A, hrMgr, ayu, "allowances", "?current=true");
    expect(res.statusCode).toBe(200);
    // newest effective_from first: the meal row (T-10) before the open transport row (T-30)
    expect(idsOf(res)).toEqual([ids.mealEndsToday, ids.trNow]);
    const all = await get(A, hrMgr, ayu, "allowances", "?current=false");
    expect(idsOf(all)).toHaveLength(5);
    expect(idsOf(all)).toEqual(idsOf(await get(A, hrMgr, ayu, "allowances")));
  });

  it("allowances: only that employee's rows, and a closed row is listed in the history but never as current", async () => {
    expect(idsOf(await get(A, hrMgr, budi, "allowances"))).toEqual([ids.budiTransport]);
    expect(idsOf(await get(A, hrMgr, budi, "allowances", "?current=true"))).toEqual([ids.budiTransport]);
    expect(await (await get(A, hrMgr, eka, "allowances")).json()).toEqual([]);
    expect(idsOf(await get(A, hrMgr, ayu, "allowances", "?current=true"))).not.toContain(ids.trOld);
  });

  it("allowances: an allowance assigned through the POST reads back", async () => {
    const added = await app.inject({
      method: "POST", url: `${base(A)}/employees/${eka}/allowances`, headers: asUser(hrMgr),
      payload: { allowanceTypeId: types.TRANSPORT, amount: 250000, effectiveFrom: T, note: "added by test" },
    });
    expect(added.statusCode).toBe(201);
    const res = await get(A, hrMgr, eka, "allowances", "?current=true");
    expect(idsOf(res)).toEqual([added.json().id]);
    expect((res.json() as { note: string }[])[0].note).toBe("added by test");
  });

  // ──────────────────────────────────────────────────────────────────────────── benefits
  it("benefits: lists every row newest first, with the plan's code and name joined, status and dependants", async () => {
    const res = await get(A, hrMgr, ayu, "benefits");
    expect(res.statusCode).toBe(200);
    // newest effective_from first: wellness (T), private insurance (T-50), BPJS (T-100)
    expect(idsOf(res)).toEqual([ids.wellStartsToday, ids.insEndedYesterday, ids.kes]);
    const rows = res.json() as Record<string, unknown>[];
    const kes = rows.find((r) => r.id === ids.kes)!;
    expect(Object.keys(kes).sort()).toEqual([
      "createdAt", "dependants", "effectiveFrom", "effectiveTo", "employeeId", "id", "memberNumber",
      "note", "planCode", "planId", "planKind", "planName", "status",
    ]);
    expect(kes.planCode).toBe("BPJS-KES");
    expect(kes.planName).toBe("BPJS Kesehatan");
    expect(kes.planKind).toBe("statutory");
    expect(kes.planId).toBe(plans["BPJS-KES"]);
    expect(kes.memberNumber).toBe("0001234567890");
    expect(kes.dependants).toBe(2);
    expect(kes.status).toBe("active");
    expect(kes.effectiveFrom).toBe(shift(T, -100));
    expect(kes.effectiveTo).toBeNull();
    const ins = rows.find((r) => r.id === ids.insEndedYesterday)!;
    expect(ins.status).toBe("terminated");
    expect(ins.effectiveTo).toBe(shift(T, -1));
    expect(ins.note).toBe("Policy lapsed");
  });

  it("benefits: current=true at the edges — starts-today is in, ended-yesterday is out", async () => {
    const res = await get(A, hrMgr, ayu, "benefits", "?current=true");
    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([ids.wellStartsToday, ids.kes]);
    expect(await (await get(A, hrMgr, eka, "benefits")).json()).toEqual([]);
  });

  it("benefits: in force means active AND in date — a terminated, suspended or pending enrolment with an open range is not current, but is in the history", async () => {
    const current = await get(A, hrMgr, budi, "benefits", "?current=true");
    expect(current.statusCode).toBe(200);
    expect(idsOf(current)).toEqual([ids.budiKes]);
    for (const qs of ["", "?current=false"]) {
      const all = await get(A, hrMgr, budi, "benefits", qs);
      expect(new Set(idsOf(all)), qs).toEqual(new Set([ids.budiKes, ids.budiTerminated, ids.budiSuspended, ids.budiPending]));
      const byId = new Map((all.json() as { id: string; status: string; effectiveTo: string | null }[]).map((r) => [r.id, r]));
      expect(byId.get(ids.budiTerminated)).toMatchObject({ status: "terminated", effectiveTo: null });
      expect(byId.get(ids.budiSuspended)?.status).toBe("suspended");
      expect(byId.get(ids.budiPending)?.status).toBe("pending");
    }
    // A terminated enrolment whose range has also ended stays out of current and in the history (ayu's lapsed insurance).
    expect(idsOf(await get(A, hrMgr, ayu, "benefits", "?current=true"))).not.toContain(ids.insEndedYesterday);
    expect(idsOf(await get(A, hrMgr, ayu, "benefits"))).toContain(ids.insEndedYesterday);
  });

  it("benefits: an enrolment made through the POST reads back", async () => {
    const added = await app.inject({
      method: "POST", url: `${base(A)}/employees/${eka}/benefits`, headers: asUser(hrMgr),
      payload: { planId: plans["PRIV-INS"], memberNumber: "PI-77", dependants: 1, effectiveFrom: T },
    });
    expect(added.statusCode).toBe(201);
    const res = await get(A, hrMgr, eka, "benefits", "?current=true");
    expect(idsOf(res)).toEqual([added.json().id]);
    const row = (res.json() as { planName: string; memberNumber: string; dependants: number }[])[0];
    expect(row.planName).toBe("Private insurance");
    expect(row.memberNumber).toBe("PI-77");
    expect(row.dependants).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────── tax profile
  it("tax-profile: a payroll reader sees the profile in force, the NPWP and the history newest first", async () => {
    const res = await get(A, hrMgr, ayu, "tax-profile");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { current: Record<string, unknown> | null; history: Record<string, unknown>[] };
    expect(body.current?.id).toBe(ids.ayuNow);
    expect(Object.keys(body.current!).sort()).toEqual([
      "createdAt", "effectiveFrom", "effectiveTo", "employeeId", "hasNpwp", "id", "npwp", "ptkpStatus", "taxResident", "terCategory",
    ]);
    expect(body.current).toMatchObject({
      employeeId: ayu, hasNpwp: true, npwp: NPWP, ptkpStatus: "K/1", terCategory: "B", taxResident: true,
      effectiveFrom: shift(T, -200), effectiveTo: null,
    });
    expect(body.history.map((r) => r.id)).toEqual([ids.ayuNow, ids.ayuOld]);
    expect(body.history[1]).toMatchObject({
      hasNpwp: false, npwp: null, ptkpStatus: "TK/0", terCategory: "A",
      effectiveFrom: shift(T, -400), effectiveTo: shift(T, -201),
    });
  });

  it("tax-profile: current is null when none is in force (a future profile only, or nothing on file)", async () => {
    const future = (await get(A, hrMgr, dewi, "tax-profile")).json() as { current: unknown; history: { id: string }[] };
    expect(future.current).toBeNull();
    expect(future.history.map((r) => r.id)).toEqual([ids.dewiFuture]);
    const none = await get(A, hrMgr, eka, "tax-profile");
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ current: null, history: [] });
  });

  it("tax-profile: a profile set through the POST closes the incumbent and reads back as current", async () => {
    for (const [from, npwp, ptkp] of [[shift(T, -10), undefined, "TK/0"], [T, NPWP, "K/0"]] as const) {
      const set = await app.inject({
        method: "POST", url: `${base(A)}/employees/${budi}/tax-profile`, headers: asUser(hrMgr),
        payload: { effectiveFrom: from, ptkpStatus: ptkp, ...(npwp ? { npwp } : {}) },
      });
      expect(set.statusCode).toBe(201);
    }
    const body = (await get(A, hrMgr, budi, "tax-profile")).json() as {
      current: { ptkpStatus: string; hasNpwp: boolean; npwp: string | null; effectiveFrom: string } | null;
      history: { ptkpStatus: string; effectiveFrom: string; effectiveTo: string | null }[];
    };
    expect(body.current).toMatchObject({ ptkpStatus: "K/0", hasNpwp: true, npwp: NPWP, effectiveFrom: T });
    expect(body.history).toHaveLength(2);
    expect(body.history[1]).toMatchObject({ ptkpStatus: "TK/0", effectiveFrom: shift(T, -10), effectiveTo: shift(T, -1) });
  });

  // ───────────────────────────────────────────────────────────────────────────── tenancy
  it("another company's employee is 404 on all three routes; a reader of A is refused (403) on B's URL", async () => {
    for (const leaf of ["allowances", "benefits", "tax-profile"]) {
      const res = await get(A, hrMgr, citra, leaf);
      expect(res.statusCode, `${leaf} for B's employee`).toBe(404);
      expect(JSON.stringify(res.json())).not.toContain("99.999");
      expect((await get(B, hrMgr, citra, leaf)).statusCode, `${leaf} on B's URL`).toBe(403);
    }
    // B's own manager reads B's rows and none of A's.
    expect(idsOf(await get(B, hrMgrB, citra, "allowances"))).toEqual([ids.foreignTransport]);
    expect(idsOf(await get(B, hrMgrB, citra, "benefits"))).toEqual([ids.foreignKes]);
    expect(((await get(B, hrMgrB, citra, "tax-profile")).json() as { current: { id: string } }).current.id).toBe(ids.foreignTax);
    expect((await get(B, hrMgrB, ayu, "allowances")).statusCode).toBe(404);
  });

  it("an employee that does not exist, and a soft-deleted one, are 404", async () => {
    for (const leaf of ["allowances", "benefits", "tax-profile"]) {
      expect((await get(A, hrMgr, randomUUID(), leaf)).statusCode, `${leaf} unknown`).toBe(404);
      expect((await get(A, hrMgr, gone, leaf)).statusCode, `${leaf} soft-deleted`).toBe(404);
    }
  });

  // ────────────────────────────────────────────────────────────────────────── authorization
  it("hr_staff and an ordinary member get 403 on all three routes, and never see the NPWP", async () => {
    for (const user of [hrStaff, member]) {
      for (const leaf of ["allowances", "benefits", "tax-profile"]) {
        const res = await get(A, user, ayu, leaf);
        expect(res.statusCode, `${leaf} as ${user}`).toBe(403);
        expect(res.body).not.toContain(NPWP);
      }
    }
    // The refusal comes BEFORE validation: a refused caller with a bad id or flag is still 403, not a 400.
    expect((await get(A, hrStaff, "not-a-uuid", "tax-profile")).statusCode).toBe(403);
    expect((await get(A, member, "123", "allowances")).statusCode).toBe(403);
    expect((await get(A, hrStaff, ayu, "benefits", "?current=maybe")).statusCode).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────────── validation
  it("a malformed id is a 400 {message, field}, never a 500 at the uuid cast; so is a bad current flag", async () => {
    for (const leaf of ["allowances", "benefits", "tax-profile"]) {
      for (const bad of ["not-a-uuid", "123"]) {
        const res = await get(A, hrMgr, bad, leaf);
        expect(res.statusCode, `${leaf} ${bad}`).toBe(400);
        // The error filter puts a thrown `{message, field}` on the wire as `{error, field}`.
        const body = res.json() as { error?: string; message?: string; field: string };
        expect(body.field, `${leaf} ${bad}`).toBe("id");
        expect(typeof (body.error ?? body.message)).toBe("string");
      }
    }
    for (const leaf of ["allowances", "benefits"]) {
      const res = await get(A, hrMgr, ayu, leaf, "?current=maybe");
      expect(res.statusCode, leaf).toBe(400);
      expect((res.json() as { field: string }).field).toBe("current");
    }
  });
});
