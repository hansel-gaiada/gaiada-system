// DW-7j-5 — the GM's revenue plan over the REAL HTTP surface (buildApp + app.inject), against live Postgres + RLS + Cerbos
// (docs/FRONTEND-BFF-CONTRACT.md §40.6.4 and §40.6.5; PERMISSION-CONTRACT §41). Covers:
//   * GET: every month of the range with `amountMinor: null` where none is set, the company's base currency, at most 36 months;
//   * PUT: an upsert (one row per month), the 400s with their field, the currency taken from the company never the client;
//   * DELETE: 204, idempotent, and a clear of nothing leaves no activity row;
//   * authorization as `dept_kpi_target`: read for the tenant's tiers, approve for `company_admin` only (a manager, a member and
//     an org_unit_lead are refused 403), and validation never pre-empts a 403;
//   * another tenant is isolated, a company without the finance module is 404, a company without finance settings is 409
//     `no_base_currency`, and each write leaves an activity row;
//   * the table's own wall: zero rows without the finance scope, and the CHECKs refuse a mid-month date and a negative amount.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createRole, createUser, grantRole, grantLeadSeat } from "../../testing/fixtures";
import { seedFinanceCompany } from "../../testing/finance-kpi-seed";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface MonthRow { month: string; amountMinor: number | null; note: string | null; setBy: string | null; setAt: string | null }

describe.skipIf(!TEST_URL)("DW-7j-5 revenue plan routes (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string; // a second finance company, for the isolation tests
  let noFin: string; // a company without the finance module
  let noSettings: string; // finance on, no finance_company_settings row
  let admin: string; // company_admin: the approver
  let admin2: string; // a company_admin of the other company
  let manager: string;
  let member: string;
  let lead: string; // org_unit_lead + manager
  let outsider: string; // no grant in co

  const url = (t: string, suffix = "") => `/api/${t}/revenue-plan${suffix}`;
  const list = (t: string, qs: string, as: string) => app.inject({ method: "GET", url: url(t, `?${qs}`), headers: asUser(as) });
  const put = (t: string, month: string, body: unknown, as: string) =>
    app.inject({ method: "PUT", url: url(t, `/${month}`), headers: asUser(as), payload: body as Record<string, unknown> });
  const del = (t: string, month: string, as: string) => app.inject({ method: "DELETE", url: url(t, `/${month}`), headers: asUser(as) });
  const months = (r: { json: () => { months: MonthRow[] } }) => r.json().months;
  const activityRows = (t: string, verb: string) =>
    withTenants([t], async (c) =>
      (await c.query<{ metadata: Record<string, unknown>; actor_id: string }>(
        `SELECT metadata, actor_id FROM activities WHERE tenant_id = $1 AND target_entity_type = 'revenue_plan' AND verb = $2 ORDER BY occurred_at`,
        [t, verb],
      )).rows,
    );
  const planRows = (t: string, modules?: string[]) =>
    withTenants([t], async (c) => (await c.query<{ month: string; amount_minor: string; currency: string }>(
      `SELECT to_char(month, 'YYYY-MM') AS month, amount_minor::text AS amount_minor, currency FROM finance_revenue_plans WHERE tenant_id = $1 ORDER BY month`, [t],
    )).rows, modules ? { modules } : undefined);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    co = (await seedFinanceCompany("DW-7j-5 Co", { periods: "none" })).tenant;
    other = (await seedFinanceCompany("DW-7j-5 Other", { periods: "none" })).tenant;
    noFin = await createCompany("DW-7j-5 No finance", ["reports"]);
    noSettings = await createCompany("DW-7j-5 No settings", ["finance"]);

    admin = await createUser("admin@dw7j5.test");
    admin2 = await createUser("admin2@dw7j5.test");
    manager = await createUser("manager@dw7j5.test");
    member = await createUser("member@dw7j5.test");
    lead = await createUser("lead@dw7j5.test");
    outsider = await createUser("outsider@dw7j5.test");
    for (const t of [co, noFin, noSettings]) {
      for (const u of [admin, manager, member, lead]) await addMembership(t, u);
    }
    await addMembership(other, admin2);

    const companyAdmin = await createRole("company_admin");
    const mgr = await createRole("manager");
    const mem = await createRole("member");
    const unitLead = await createRole("org_unit_lead");
    for (const t of [co, noFin, noSettings]) {
      await grantRole(admin, companyAdmin, "company", t);
      await grantRole(manager, mgr, "company", t);
      await grantRole(member, mem, "company", t);
      await grantRole(lead, mgr, "company", t);
    }
    await grantRole(lead, unitLead, "org_unit", "d-gm");
    // DW-10g-2 Part B: a head acts through Cerbos's org_unit_lead rule only in a company whose own lead seat backs the grant.
    await grantLeadSeat(co, "d-gm", lead);
    await grantRole(admin2, companyAdmin, "company", other);

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ read ═══════════════════════════════

  it("GET: every month of the range with amountMinor null where none is set, and the company's base currency", async () => {
    const r = await list(co, "from=2026-09&to=2026-11", admin);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ currency: "IDR", minorUnit: 0 });
    expect(months(r)).toEqual([
      { month: "2026-09", amountMinor: null, note: null, setBy: null, setAt: null },
      { month: "2026-10", amountMinor: null, note: null, setBy: null, setAt: null },
      { month: "2026-11", amountMinor: null, note: null, setBy: null, setAt: null },
    ]);
  });

  it("GET: a range across a year end lists the months in order; one month is a range of 1; 36 months is the limit", async () => {
    expect(months(await list(co, "from=2026-11&to=2027-02", admin)).map((m) => m.month)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(months(await list(co, "from=2026-09&to=2026-09", admin))).toHaveLength(1);
    expect(months(await list(co, "from=2026-01&to=2028-12", admin))).toHaveLength(36);
  });

  it("GET 400s with their field: a missing or malformed from/to, a range backwards, a range over 36 months", async () => {
    const cases: Array<[string, string]> = [
      ["to=2026-09", "from"], ["from=2026-09", "to"], ["from=2026-9&to=2026-10", "from"], ["from=2026-09&to=2026-13", "to"],
      ["from=2026-09-01&to=2026-10", "from"], ["from=2026-10&to=2026-09", "to"], ["from=2026-01&to=2029-01", "to"],
    ];
    for (const [qs, field] of cases) {
      const r = await list(co, qs, admin);
      expect(r.statusCode, qs).toBe(400);
      expect(r.json().field, qs).toBe(field);
    }
  });

  // ═══════════════════════════════ set (PUT) ═══════════════════════════════

  it("PUT sets a month (200 {month, amountMinor}); GET then shows it with who and when; the client sends no currency", async () => {
    const r = await put(co, "2026-09", { amountMinor: 200_000_000, note: "Q3 plan" }, admin);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ month: "2026-09", amountMinor: 200_000_000 });
    const g = await list(co, "from=2026-08&to=2026-10", admin);
    const sep = months(g).find((m) => m.month === "2026-09")!;
    expect(sep).toMatchObject({ amountMinor: 200_000_000, note: "Q3 plan", setBy: admin });
    expect(new Date(sep.setAt!).getTime()).toBeGreaterThan(0);
    expect(months(g).filter((m) => m.amountMinor !== null)).toHaveLength(1);
    // the row carries the company's base currency, taken by the server
    expect(await planRows(co, ["finance"])).toEqual([{ month: "2026-09", amount_minor: "200000000", currency: "IDR" }]);
  });

  it("PUT again is an upsert: one row per month, the amount, note and setter replaced", async () => {
    expect((await put(co, "2026-09", { amountMinor: 250_000_000 }, admin)).statusCode).toBe(200);
    const rows = await planRows(co, ["finance"]);
    expect(rows).toEqual([{ month: "2026-09", amount_minor: "250000000", currency: "IDR" }]);
    const sep = months(await list(co, "from=2026-09&to=2026-09", admin))[0];
    expect(sep).toMatchObject({ amountMinor: 250_000_000, note: null });
  });

  it("PUT accepts 0 (a month planned at nothing) and a plan beyond 32 bits", async () => {
    expect((await put(co, "2026-10", { amountMinor: 0 }, admin)).json()).toEqual({ month: "2026-10", amountMinor: 0 });
    expect((await put(co, "2026-11", { amountMinor: 9_000_000_000_000 }, admin)).json()).toEqual({ month: "2026-11", amountMinor: 9_000_000_000_000 });
    const g = months(await list(co, "from=2026-10&to=2026-11", admin));
    expect(g.map((m) => m.amountMinor)).toEqual([0, 9_000_000_000_000]);
  });

  it("PUT 400s name their field: amountMinor not a whole number of at least 0, a note too long, a month that is not a month", async () => {
    const bad: unknown[] = [{}, { amountMinor: -1 }, { amountMinor: 1.5 }, { amountMinor: "100" }, { amountMinor: null }, { amountMinor: 1e30 }, { amountMinor: Number.MAX_SAFE_INTEGER + 2 }];
    for (const body of bad) {
      const r = await put(co, "2026-09", body, admin);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().field, JSON.stringify(body)).toBe("amountMinor");
    }
    const longNote = await put(co, "2026-09", { amountMinor: 1, note: "x".repeat(2001) }, admin);
    expect(longNote.statusCode).toBe(400);
    expect(longNote.json().field).toBe("note");
    for (const month of ["2026-13", "2026-9", "2026-00", "2026-09-01", "abcd-ef"]) {
      const r = await put(co, month, { amountMinor: 1 }, admin);
      expect(r.statusCode, month).toBe(400);
      expect(r.json().field, month).toBe("month");
    }
    // none of those changed the plan
    expect(months(await list(co, "from=2026-09&to=2026-09", admin))[0].amountMinor).toBe(250_000_000);
  });

  it("a company with no finance settings has no base currency: PUT is 409 no_base_currency, GET answers a null currency", async () => {
    const r = await put(noSettings, "2026-09", { amountMinor: 100 }, admin);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("no_base_currency");
    const g = await list(noSettings, "from=2026-09&to=2026-09", admin);
    expect(g.statusCode).toBe(200);
    expect(g.json()).toMatchObject({ currency: null, minorUnit: null, months: [{ month: "2026-09", amountMinor: null }] });
    expect(await planRows(noSettings, ["finance"])).toEqual([]);
  });

  // ═══════════════════════════════ clear (DELETE) ═══════════════════════════════

  it("DELETE clears a month (204, empty body); the month then reads null; clearing again is 204 and changes nothing", async () => {
    await put(co, "2026-12", { amountMinor: 123 }, admin);
    const r = await del(co, "2026-12", admin);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe("");
    expect(months(await list(co, "from=2026-12&to=2026-12", admin))[0].amountMinor).toBeNull();
    const clearedBefore = (await activityRows(co, "cleared")).length;
    expect((await del(co, "2026-12", admin)).statusCode).toBe(204);
    expect((await activityRows(co, "cleared")).length).toBe(clearedBefore); // clearing nothing is not an event
  });

  it("DELETE 400 on a month that is not a month", async () => {
    const r = await del(co, "2026-13", admin);
    expect(r.statusCode).toBe(400);
    expect(r.json().field).toBe("month");
  });

  // ═══════════════════════════════ who may ═══════════════════════════════

  it("reading is the tenant's tiers: company_admin, manager, member and a lead read (200); a user with no grant in the company is refused (403)", async () => {
    for (const u of [admin, manager, member, lead]) expect((await list(co, "from=2026-09&to=2026-09", u)).statusCode).toBe(200);
    expect((await list(co, "from=2026-09&to=2026-09", outsider)).statusCode).toBe(403);
  });

  it("setting and clearing are company_admin only: a manager, a member and an org_unit_lead are refused (403) and nothing changes", async () => {
    const before = await planRows(co, ["finance"]);
    for (const u of [manager, member, lead, outsider]) {
      expect((await put(co, "2026-09", { amountMinor: 1 }, u)).statusCode).toBe(403);
      expect((await del(co, "2026-09", u)).statusCode).toBe(403);
    }
    expect(await planRows(co, ["finance"])).toEqual(before);
  });

  it("validation never pre-empts authorization: a non-approver with an invalid body or month gets 403, not 400", async () => {
    expect((await put(co, "2026-09", { amountMinor: -5 }, manager)).statusCode).toBe(403);
    expect((await put(co, "not-a-month", {}, member)).statusCode).toBe(403);
    expect((await del(co, "not-a-month", manager)).statusCode).toBe(403);
    expect((await list(co, "from=bad", outsider)).statusCode).toBe(403);
  });

  // ═══════════════════════════════ tenancy and the module wall ═══════════════════════════════

  it("another tenant is isolated: its approver cannot read or write this company's plan, and its own plan never shows here", async () => {
    expect((await list(co, "from=2026-09&to=2026-09", admin2)).statusCode).toBe(403);
    expect((await put(co, "2026-09", { amountMinor: 1 }, admin2)).statusCode).toBe(403);
    expect((await put(other, "2026-09", { amountMinor: 5_000 }, admin2)).statusCode).toBe(200);
    expect(months(await list(other, "from=2026-09&to=2026-09", admin2))[0].amountMinor).toBe(5_000);
    expect(months(await list(co, "from=2026-09&to=2026-09", admin))[0].amountMinor).toBe(250_000_000);
    // ... and the company's approver is no approver of the other company
    expect((await put(other, "2026-09", { amountMinor: 1 }, admin)).statusCode).toBe(403);
    expect(await planRows(other, ["finance"])).toEqual([{ month: "2026-09", amount_minor: "5000", currency: "IDR" }]);
  });

  it("a company without the finance module is 404 on all three routes, whoever asks", async () => {
    expect((await list(noFin, "from=2026-09&to=2026-09", admin)).statusCode).toBe(404);
    expect((await put(noFin, "2026-09", { amountMinor: 1 }, admin)).statusCode).toBe(404);
    expect((await del(noFin, "2026-09", admin)).statusCode).toBe(404);
  });

  it("the table's own wall: no row is visible without the finance scope, and the CHECKs refuse a mid-month date and a negative amount", async () => {
    expect(await planRows(co)).toEqual([]); // the tenant wall alone is not enough
    expect((await planRows(co, ["finance"])).length).toBeGreaterThan(0);
    const insert = (month: string, amount: string) =>
      withTenants([co], (c) =>
        c.query(`INSERT INTO finance_revenue_plans (tenant_id, month, amount_minor, currency, set_by) VALUES ($1, $2::date, $3, 'IDR', $4)`, [co, month, amount, admin]),
      { modules: ["finance"] });
    await expect(insert("2026-09-15", "1")).rejects.toThrow(/check|violates/i);
    await expect(insert("2026-08-01", "-1")).rejects.toThrow(/check|violates/i);
    // a second row for a month already planned violates the unique key
    await expect(insert("2026-09-01", "1")).rejects.toThrow(/unique|duplicate/i);
  });

  // ═══════════════════════════════ activity ═══════════════════════════════

  it("each write leaves an activity row: `set` with the previous amount, `cleared` with what it removed", async () => {
    const t = (await seedFinanceCompany("DW-7j-5 Activity", { periods: "none" })).tenant;
    const approver = await createUser("act-admin@dw7j5.test");
    await addMembership(t, approver);
    await grantRole(approver, await createRole("company_admin"), "company", t);

    expect((await put(t, "2026-09", { amountMinor: 100, note: "first" }, approver)).statusCode).toBe(200);
    expect((await put(t, "2026-09", { amountMinor: 150 }, approver)).statusCode).toBe(200);
    expect((await del(t, "2026-09", approver)).statusCode).toBe(204);

    const sets = await activityRows(t, "set");
    expect(sets).toHaveLength(2);
    expect(sets[0]).toMatchObject({ actor_id: approver, metadata: { month: "2026-09", amountMinor: 100, currency: "IDR", previousAmountMinor: null, note: "first" } });
    expect(sets[1].metadata).toMatchObject({ month: "2026-09", amountMinor: 150, previousAmountMinor: 100 });
    const cleared = await activityRows(t, "cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ actor_id: approver, metadata: { month: "2026-09", previousAmountMinor: 150, currency: "IDR" } });
  });
});
