// UI-01a / UI-02a — the cap-table and settings BFF surface, against live Postgres, RLS and Cerbos.
//
// The assertion this file exists for is the TIER SPLIT: `finance_manager` may READ the cap table and
// may NOT write it. That is the whole reason `finance_ownership` is its own Cerbos kind rather than
// part of `finance_config` — an ownership edge is an authorization fact, and a controller who could
// write one could widen their own visibility across the group by naming themselves in it.
//
// Only a live PDP can confirm that. A unit test over the policy YAML would assert what the file
// says, not what Cerbos decides.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("Finance ownership + settings BFF", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;      // company_admin — may write the cap table
  let controller: string; // finance_manager — may READ it only
  let clerk: string;      // finance_staff — may not see it at all
  let holder: string;

  const get = (path: string, who: string) =>
    app.inject({ method: "GET", url: `/api/${tenant}${path}`, headers: asUser(who) });
  const post = (path: string, who: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/${tenant}${path}`, headers: asUser(who), payload });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Cap Table Co", ["finance"]);
    admin = await createUser("admin@cap.test");
    controller = await createUser("controller@cap.test");
    clerk = await createUser("clerk@cap.test");
    holder = await createUser("holder@cap.test");
    for (const u of [admin, controller, clerk, holder]) await addMembership(tenant, u);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);
    await grantRole(controller, await createRole("finance_manager"), "company", tenant);
    await grantRole(clerk, await createRole("finance_staff"), "company", tenant);

    await withTenants([tenant], async (c) => {
      await c.query("SELECT set_config('app.scopes','finance',true)");
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id,functional_currency,presentation_currency,fiscal_year_start_month,is_pkp)
         VALUES ($1,'IDR','IDR',1,true) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant],
      );
      await c.query(`SELECT finance_instantiate_coa($1,'id_psak_general_v1')`, [tenant]);
    });

    app = await buildApp();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── The tier split ──────────────────────────────────────────────────────────────────────────
  it("★★ finance_manager may READ the cap table but NOT write it", async () => {
    const read = await get("/finance/ownership", controller);
    expect(read.statusCode).toBe(200);

    const write = await post("/finance/ownership", controller, {
      holderUserId: holder, kind: "shareholder", stakePct: 50, effectiveFrom: "2026-01-01",
    });
    // The escalation this kind exists to prevent: a controller naming themselves a holder.
    expect(write.statusCode).toBe(403);
  });

  it("finance_staff cannot see the shareholder register at all", async () => {
    const r = await get("/finance/ownership", clerk);
    expect(r.statusCode).toBe(403);
  });

  it("company_admin may write it", async () => {
    const r = await post("/finance/ownership", admin, {
      holderUserId: holder, kind: "shareholder", stakePct: 60, effectiveFrom: "2026-01-01",
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBeTruthy();
  });

  // ── The list, and the problems carried with it ──────────────────────────────────────────────
  it("★ the list carries its PROBLEMS, not just its rows", async () => {
    // A cap table totalling 60% must say so on the surface that renders it, rather than leaving
    // the reader to assume the other 40% is unowned.
    const r = await get("/finance/ownership?asOf=2026-06-30", admin);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].holderKind).toBe("person");
    expect(body.edges[0].holderName).toBeTruthy();
    expect(body.problems.some((p: { problem: string }) => p.problem === "STAKE_INCOMPLETE")).toBe(true);
  });

  it("an edge needs exactly one holder — a person or a company, never both or neither", async () => {
    const neither = await post("/finance/ownership", admin, {
      kind: "shareholder", stakePct: 10, effectiveFrom: "2026-01-01",
    });
    expect(neither.statusCode).toBe(400);
    const both = await post("/finance/ownership", admin, {
      holderUserId: holder, holderCompanyId: tenant, kind: "shareholder", effectiveFrom: "2026-01-01",
    });
    expect(both.statusCode).toBe(400);
  });

  it("★ removing a holder END-DATES the edge; history stays true", async () => {
    const list = await get("/finance/ownership", admin);
    const edgeId = list.json().edges[0].id;
    const r = await post(`/finance/ownership/${edgeId}/end`, admin, { effectiveTo: "2026-07-01" });
    expect(r.statusCode).toBe(201);

    // Gone from today's cap table...
    const now = await get("/finance/ownership?asOf=2026-12-31", admin);
    expect(now.json().edges).toHaveLength(0);
    // ...and still true as at June, which is what makes June's statements explainable.
    const june = await get("/finance/ownership?asOf=2026-06-30", admin);
    expect(june.json().edges).toHaveLength(1);
  });

  it("ending an already-ended edge is a 404, not a silent success", async () => {
    const june = await get("/finance/ownership?asOf=2026-06-30", admin);
    const edgeId = june.json().edges[0].id;
    const r = await post(`/finance/ownership/${edgeId}/end`, admin, { effectiveTo: "2026-08-01" });
    expect(r.statusCode).toBe(404);
  });

  // ── Settings ────────────────────────────────────────────────────────────────────────────────
  it("settings read is the finance_config tier — the controller owns the vocabulary", async () => {
    const r = await get("/finance/settings", controller);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ functionalCurrency: "IDR", isPkp: true, fiscalYearStartMonth: 1 });
  });

  it("a clerk may READ settings — an account code and a currency are not money", async () => {
    const r = await get("/finance/settings", clerk);
    expect(r.statusCode).toBe(200);
  });

  it("a clerk may NOT write them", async () => {
    const r = await post("/finance/settings", clerk, { isPkp: false });
    expect(r.statusCode).toBe(403);
  });

  it("★ the NPWP round-trips normalised, and a bad one is refused by the database", async () => {
    const ok = await post("/finance/settings", controller, { npwp: "01.234.567.8-901.000" });
    expect(ok.statusCode).toBe(201);
    expect((await get("/finance/settings", controller)).json().npwp).toBe("012345678901000");

    const bad = await post("/finance/settings", controller, { npwp: "123" });
    // Mapped by FinanceErrorFilter from the database refusal — the rule lives in one place.
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toMatch(/15 or 16 digits/);
  });

  it("★ turning PKP off with PPN posted is refused through the surface too", async () => {
    await withTenants([tenant], async (c) => {
      await c.query("SELECT set_config('app.scopes','finance',true)");
      const fy = await c.query<{ id: string }>(
        `INSERT INTO finance_fiscal_years (tenant_id,code,start_date,end_date)
         VALUES ($1,'FY2026','2026-01-01','2027-01-01') RETURNING id`,
        [tenant],
      );
      await c.query(`SELECT finance_generate_periods($1,'monthly')`, [fy.rows[0].id]);
      await c.query(`SELECT finance_post_journal($1,'2026-03-31','vat','sale',$2::jsonb)`, [
        tenant,
        JSON.stringify([
          { account_code: "1120", side: "debit", amount: 111_000_000, memo: "bank" },
          { account_code: "4100", side: "credit", amount: 100_000_000, memo: "rev" },
          { account_code: "2140", side: "credit", amount: 11_000_000, memo: "PPN" },
        ]),
      ]);
    });
    const r = await post("/finance/settings", controller, { isPkp: false });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/orphan tax/);
  });
});
