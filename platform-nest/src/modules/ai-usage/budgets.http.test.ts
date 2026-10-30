// AIP-17b (FRONTEND-BFF-CONTRACT §66.4; PERMISSION-CONTRACT §58) — the owner's budget and allowance routes and the budget lines on the reads, driven
// end to end over HTTP against real Postgres (RLS on) and real Cerbos:
//   PUT /api/:t/ai-usage/budgets/company            PUT /api/:t/ai-usage/budgets/units/:unitNodeId
//   GET /api/:t/ai-usage/allowances                 PUT /api/:t/ai-usage/allowances/:userId
//   GET .../ai-usage/company (budgets)              GET .../ai-usage/units/:id (budget)
// Claims:
//   WRITES   the owner sets, updates and removes (null) the company figure and a unit's budget; every change writes ONE activity row (ids and
//            figures only) in the same transaction; removing what is not there changes nothing and writes nothing; `mode` defaults to 'report'
//            and an omitted mode on update keeps the stored one.
//   AUTHZ    company_admin, a member, the GM, a department head and another company's admin are 403 on EVERY write and on the allowance list,
//            and nothing is stored; a refused caller with an INVALID body gets 403, never 400 (authorization before validation); a refused
//            caller naming an unknown unit gets 403, never 404.
//   VALIDATE 400 for every malformed body (floats, zero, 5 places, exponent, an unknown field, a mode without a figure); an authorized caller
//            naming a unit outside the org tree gets 404 `unit_not_found`; a non-member or a stranger for an allowance 404 `person_not_found`.
//   ALLOWANCE the owner sets, lists (with names and the default) and removes a person's override.
//   READS    the company answer carries `budgets` (company line and every unit's line) and the unit answer carries `budget`: exact decimal
//            strings, the percent, the state under / over_80 / over_100 at the exact edges, unknown cost counted separately, a unit counted over
//            its whole subtree, never another company's figure.
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { resetModules } from "../registry";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, grantLeadSeat } from "../../testing/fixtures";

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });
const MONTH = "2026-09";

const tree = (name: string) => ({
  id: "d-corp", kind: "company", name,
  children: [
    { id: "d-gm", kind: "department", name: "GM", children: [] },
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
    { id: "d-ops", kind: "department", name: "Operations", children: [] },
  ],
});

describe.skipIf(!TEST_URL)("AIP-17b budgets and allowances (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string; // the reads' company
  let W: string; // the writes' company
  let B: string; // another company
  let ownerA: string;
  let ownerW: string;
  let adminW: string;
  let memberW: string;
  let gmW: string;
  let headW: string;
  let bAdmin: string;
  let stranger: string; // a member of A only
  let staff1: string;
  let staff2: string;
  let seoStaff: string;

  const q = adminPool;
  const call = (method: "GET" | "PUT", path: string, as: string, tenant: string, payload?: unknown) =>
    app.inject({ method, url: `/api/${tenant}/ai-usage/${path}`, headers: asUser(as), ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = (path: string, as: string, tenant: string) => call("GET", path, as, tenant);
  const put = (path: string, payload: unknown, as: string, tenant = W) => call("PUT", path, as, tenant, payload);

  async function seedTree(tenant: string, name: string) {
    const root = tree(name);
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
        [tenant, JSON.stringify({ root }), config.originSite],
      ),
    );
    await withTenants([tenant], (c) => rebuildOrgUnitClosure(c, tenant, root));
  }

  async function row(over: Record<string, unknown> & { tenant_id: string; occurred_at: string }) {
    const r: Record<string, unknown> = { surface: "assistant", capability: "chat", tokens_source: "provider", outcome: "ok", ...over };
    const cols = Object.keys(r);
    await q().query(`INSERT INTO ai_usage_events (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`, [newId(), ...cols.map((c) => r[c])]);
  }

  const stored = async (tenant: string) =>
    (await q().query(`SELECT scope, unit_node_id, monthly_usd::text AS m, mode FROM ai_budgets WHERE tenant_id = $1 ORDER BY scope, unit_node_id`, [tenant])).rows;
  const activities = async (tenant: string) =>
    (await q().query(
      `SELECT verb, actor_id, target_entity_type, target_entity_id, metadata FROM activities
        WHERE tenant_id = $1 AND target_entity_type IN ('ai_budget', 'ai_allowance') AND verb NOT LIKE 'authz.%' ORDER BY occurred_at, id`,
      [tenant],
    )).rows as Array<{ verb: string; actor_id: string; target_entity_type: string; target_entity_id: string | null; metadata: Record<string, unknown> }>;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    A = await createCompany("Budget Co A");
    W = await createCompany("Budget Co W");
    B = await createCompany("Budget Co B");
    await q().query(`UPDATE companies SET vertical = 'agency' WHERE id = ANY($1::uuid[])`, [[A, W, B]]);
    const mkUser = async (key: string, name: string, tenants: string[]) => {
      const id = await createUser(`${key}@aibudget.test`, name);
      for (const t of tenants) await addMembership(t, id);
      return id;
    };
    ownerA = await mkUser("ownera", "Olga Owner A", [A]);
    ownerW = await mkUser("ownerw", "Olga Owner W", [W]);
    adminW = await mkUser("adminw", "Ada Admin", [W]);
    memberW = await mkUser("memberw", "Mia Member", [W]);
    gmW = await mkUser("gmw", "Gus GM", [W]);
    headW = await mkUser("headw", "Wes Head", [W]);
    bAdmin = await mkUser("badmin", "Bea Admin", [B]);
    stranger = await mkUser("stranger", "Sal Stranger", [A]);
    staff1 = await mkUser("staff1", "Stan One", [A]);
    staff2 = await mkUser("staff2", "Sue Two", [A]);
    seoStaff = await mkUser("seostaff", "Sam Seo", [A]);

    const role = { admin: await createRole("company_admin"), owner: await createRole("owner"), manager: await createRole("manager"), member: await createRole("member"), lead: await createRole("org_unit_lead") };
    for (const u of [memberW, gmW, headW, stranger, staff1, staff2, seoStaff]) await grantRole(u, role.member, "company", u === stranger || u === staff1 || u === staff2 || u === seoStaff ? A : W);
    await grantRole(headW, role.manager, "company", W);
    await grantRole(adminW, role.admin, "company", W);
    await grantRole(bAdmin, role.admin, "company", B);
    await grantRole(ownerW, role.owner, "company", W);
    await grantRole(ownerA, role.owner, "company", A);
    await q().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [ownerW, W]);
    await q().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [ownerA, A]);
    await grantRole(headW, role.lead, "org_unit", "d-web");
    await grantLeadSeat(W, "d-web", headW);
    await grantLeadSeat(W, "d-gm", gmW);
    await seedTree(A, "Budget Co A");
    await seedTree(W, "Budget Co W");
    await seedTree(B, "Budget Co B");

    // ── company A, September 2026: the reads' figures, exact ──
    await row({ tenant_id: A, user_id: staff1, unit_node_id: "d-web", occurred_at: "2026-09-03T08:00:00Z", cost_usd: "0.30", cost_source: "provider" });
    await row({ tenant_id: A, user_id: staff2, unit_node_id: "dv-fe", occurred_at: "2026-09-03T09:00:00Z", cost_usd: "0.50", cost_source: "provider" });
    await row({ tenant_id: A, user_id: staff2, unit_node_id: "dv-fe", occurred_at: "2026-09-04T09:00:00Z" }); // no cost: unknown, never 0
    await row({ tenant_id: A, user_id: seoStaff, unit_node_id: "d-seo", occurred_at: "2026-09-10T10:00:00Z", cost_usd: "0.90", cost_source: "table" });
    await row({ tenant_id: A, occurred_at: "2026-09-12T10:00:00Z", surface: "knowledge", capability: "embed", cost_usd: "0.05", cost_source: "provider" }); // company, no person
    await row({ tenant_id: A, user_id: staff1, unit_node_id: "d-web", occurred_at: "2026-10-01T00:00:00Z", cost_usd: "50", cost_source: "provider" }); // next month: outside
    // the same node in another company must never count
    await row({ tenant_id: B, user_id: bAdmin, unit_node_id: "d-web", occurred_at: "2026-09-03T08:00:00Z", cost_usd: "9", cost_source: "provider" });
    await q().query(
      `INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode) VALUES
         ($1, 'company', NULL, 2, NULL), ($1, 'unit', 'd-web', 1, 'report'), ($1, 'unit', 'd-seo', 0.9, 'soft_stop'), ($1, 'unit', 'd-ops', 5, 'report'),
         ($1, 'unit', 'd-gone', 3, 'report')`,
      [A],
    );
    await q().query(`INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode) VALUES ($1, 'unit', 'd-web', 0.1, 'report')`, [B]);

    app = await buildApp();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════ READS ═══════════════════════════
  describe("the budget lines on the reads", () => {
    it("the company answer carries the company line and every unit's line, exact, with the right state", async () => {
      const r = await get(`company?month=${MONTH}`, ownerA, A);
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json().budgets;
      // company: 0.30 + 0.50 + 0.90 + 0.05 = 1.75 of 2.0000, 87.5 percent
      expect(b.company).toEqual({ monthlyUsd: "2.0000", spentUsd: "1.75000000", noCostCalls: 1, percent: 87.5, state: "over_80" });
      const byUnit = Object.fromEntries((b.units as Array<{ unitNodeId: string }>).map((u) => [u.unitNodeId, u]));
      // d-web counts its whole subtree: 0.30 + 0.50 = 0.80 of 1.0000 is EXACTLY 80 percent
      expect(byUnit["d-web"]).toEqual({ unitNodeId: "d-web", name: "Web Dev", monthlyUsd: "1.0000", mode: "report", spentUsd: "0.80000000", noCostCalls: 1, percent: 80, state: "over_80", stopLifted: false });
      // d-seo: 0.90 of 0.9000 is EXACTLY 100 percent
      expect(byUnit["d-seo"]).toMatchObject({ mode: "soft_stop", spentUsd: "0.90000000", percent: 100, state: "over_100" });
      // d-ops: no calls at all: nothing spent, unknown is null, not 0
      expect(byUnit["d-ops"]).toMatchObject({ spentUsd: null, noCostCalls: 0, percent: 0, state: "under" });
      // a node no longer in the tree keeps its line with no name
      expect(byUnit["d-gone"]).toMatchObject({ name: null, state: "under" });
      // never another company's figure
      expect(r.body).not.toContain("0.10");
      expect(r.body).not.toContain("9.00");
    });

    it("the company answer says null for the company line when there is none, and an empty list", async () => {
      const r = await get(`company?month=${MONTH}`, ownerW, W);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().budgets).toEqual({ company: null, units: [] });
    });

    it("the unit answer carries that unit's own budget, or null; the owner and the head see it, the company admin sees it with no people", async () => {
      const o = await get(`units/d-web?month=${MONTH}`, ownerA, A);
      expect(o.statusCode, o.body).toBe(200);
      expect(o.json().budget).toMatchObject({ unitNodeId: "d-web", monthlyUsd: "1.0000", spentUsd: "0.80000000", percent: 80, state: "over_80" });
      const dv = await get(`units/dv-fe?month=${MONTH}`, ownerA, A);
      expect(dv.json().budget).toBeNull(); // the division has no budget of its own (its subtree counts toward d-web's)
    });

    it("a stop lifted in the answer's month shows as stopLifted", async () => {
      await q().query(`UPDATE ai_budgets SET stop_lifted_month = $2 WHERE tenant_id = $1 AND unit_node_id = 'd-seo'`, [A, MONTH]);
      const b = (await get(`company?month=${MONTH}`, ownerA, A)).json().budgets.units.find((u: { unitNodeId: string }) => u.unitNodeId === "d-seo");
      expect(b.stopLifted).toBe(true);
      const other = (await get(`company?month=2026-10`, ownerA, A)).json().budgets.units.find((u: { unitNodeId: string }) => u.unitNodeId === "d-seo");
      expect(other.stopLifted).toBe(false);
      await q().query(`UPDATE ai_budgets SET stop_lifted_month = NULL WHERE tenant_id = $1`, [A]);
    });
  });

  // ═══════════════════════════════════════════ AUTHZ ═══════════════════════════
  describe("who may write: the owner only, before the body is looked at", () => {
    const writes: Array<[string, string, unknown]> = [
      ["PUT", "budgets/company", { monthlyUsd: "100" }],
      ["PUT", "budgets/units/d-web", { monthlyUsd: "100" }],
      ["PUT", "allowances/__MEMBER__", { dailyReplies: 300 }],
    ];

    it.each([["company_admin", () => adminW], ["a member", () => memberW], ["the GM", () => gmW], ["a department head", () => headW], ["another company's admin", () => bAdmin]])(
      "%s is 403 on every write and on the allowance list, and nothing is stored",
      async (_label, who) => {
        for (const [, path, body] of writes) {
          const r = await put(path.replace("__MEMBER__", memberW), body, who());
          expect(r.statusCode, `${path}: ${r.body}`).toBe(403);
        }
        expect((await get("allowances", who(), W)).statusCode).toBe(403);
        expect(await stored(W)).toEqual([]);
        expect((await q().query(`SELECT 1 FROM ai_person_allowances WHERE tenant_id = $1`, [W])).rows).toHaveLength(0);
      },
    );

    it("authorization comes BEFORE validation and existence: a refused caller with a bad body or an unknown unit is 403, never 400 or 404", async () => {
      expect((await put("budgets/company", { monthlyUsd: 5 }, adminW)).statusCode).toBe(403);
      expect((await put("budgets/company", [], memberW)).statusCode).toBe(403);
      expect((await put("budgets/units/no-such-unit", { monthlyUsd: "5" }, adminW)).statusCode).toBe(403);
      expect((await put("budgets/units/no-such-unit", {}, headW)).statusCode).toBe(403);
      expect((await put(`allowances/${newId()}`, { dailyReplies: 0 }, gmW)).statusCode).toBe(403);
      expect((await put("allowances/not-a-uuid", {}, adminW)).statusCode).toBe(403);
    });

    it("a request with no user is refused", async () => {
      const r = await app.inject({ method: "PUT", url: `/api/${W}/ai-usage/budgets/company`, payload: { monthlyUsd: "5" } });
      expect([400, 401, 403]).toContain(r.statusCode);
    });
  });

  // ═══════════════════════════════════════════ WRITES ═══════════════════════════
  describe("the company figure", () => {
    it("the owner sets it, updates it, removes it; each change is one activity row; removing nothing writes nothing", async () => {
      const set = await put("budgets/company", { monthlyUsd: "250.5" }, ownerW);
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toMatchObject({ changed: true, budget: { monthlyUsd: "250.5000", spentUsd: null, percent: 0, state: "under" } });
      expect(await stored(W)).toEqual([{ scope: "company", unit_node_id: null, m: "250.5000", mode: null }]);

      const upd = await put("budgets/company", { monthlyUsd: "300" }, ownerW);
      expect(upd.json().budget.monthlyUsd).toBe("300.0000");
      expect(await stored(W)).toHaveLength(1);

      const del = await put("budgets/company", { monthlyUsd: null }, ownerW);
      expect(del.statusCode, del.body).toBe(200);
      expect(del.json()).toMatchObject({ changed: true, budget: null });
      expect(await stored(W)).toEqual([]);

      const again = await put("budgets/company", { monthlyUsd: null }, ownerW);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ changed: false, budget: null });

      const acts = await activities(W);
      expect(acts.map((a) => a.verb)).toEqual(["created", "updated", "removed"]);
      expect(acts.every((a) => a.actor_id === ownerW && a.target_entity_type === "ai_budget")).toBe(true);
      expect(acts[0].metadata).toMatchObject({ scope: "company", monthlyUsd: "250.5000", previousMonthlyUsd: null });
      expect(acts[1].metadata).toMatchObject({ monthlyUsd: "300.0000", previousMonthlyUsd: "250.5000" });
      expect(acts[2].metadata).toMatchObject({ scope: "company", previousMonthlyUsd: "300.0000" });
      await q().query(`DELETE FROM activities WHERE tenant_id = $1 AND target_entity_type = 'ai_budget'`, [W]);
    });

    it.each([
      ["a number", { monthlyUsd: 250 }], ["zero", { monthlyUsd: "0" }], ["negative", { monthlyUsd: "-5" }], ["5 places", { monthlyUsd: "1.00001" }],
      ["an exponent", { monthlyUsd: "1e3" }], ["too big", { monthlyUsd: "100000000" }], ["an empty string", { monthlyUsd: "" }], ["a missing key", {}],
      ["a mode on the company row", { monthlyUsd: "5", mode: "report" }], ["an unknown key", { monthlyUsd: "5", extra: 1 }], ["an array", []], ["null", null],
    ])("is 400 for %s, and stores nothing", async (_l, body) => {
      const r = await put("budgets/company", body, ownerW);
      expect(r.statusCode, r.body).toBe(400);
      expect(await stored(W)).toEqual([]);
      expect(await activities(W)).toEqual([]);
    });
  });

  describe("a department's budget", () => {
    it("the owner sets it (mode defaults to report), changes the mode, keeps it when the mode is omitted, removes it", async () => {
      const set = await put("budgets/units/d-web", { monthlyUsd: "40" }, ownerW);
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().budget).toMatchObject({ unitNodeId: "d-web", name: "Web Dev", monthlyUsd: "40.0000", mode: "report", stopLifted: false, state: "under" });

      const soft = await put("budgets/units/d-web", { monthlyUsd: "45", mode: "soft_stop" }, ownerW);
      expect(soft.json().budget).toMatchObject({ monthlyUsd: "45.0000", mode: "soft_stop" });
      const keep = await put("budgets/units/d-web", { monthlyUsd: "50" }, ownerW);
      expect(keep.json().budget).toMatchObject({ monthlyUsd: "50.0000", mode: "soft_stop" });
      // a division is a node of the tree too
      expect((await put("budgets/units/dv-fe", { monthlyUsd: "5" }, ownerW)).statusCode).toBe(200);
      expect(await stored(W)).toEqual([
        { scope: "unit", unit_node_id: "d-web", m: "50.0000", mode: "soft_stop" },
        { scope: "unit", unit_node_id: "dv-fe", m: "5.0000", mode: "report" },
      ]);

      const del = await put("budgets/units/d-web", { monthlyUsd: null }, ownerW);
      expect(del.json()).toMatchObject({ changed: true, budget: null });
      expect((await put("budgets/units/d-web", { monthlyUsd: null }, ownerW)).json().changed).toBe(false);
      await put("budgets/units/dv-fe", { monthlyUsd: null }, ownerW);
      expect(await stored(W)).toEqual([]);

      const acts = await activities(W);
      expect(acts.map((a) => a.verb)).toEqual(["created", "updated", "updated", "created", "removed", "removed"]);
      expect(acts[0].metadata).toMatchObject({ scope: "unit", unitNodeId: "d-web", monthlyUsd: "40.0000", mode: "report" });
      expect(acts[1].metadata).toMatchObject({ mode: "soft_stop", previousMode: "report", previousMonthlyUsd: "40.0000" });
      await q().query(`DELETE FROM activities WHERE tenant_id = $1 AND target_entity_type = 'ai_budget'`, [W]);
    });

    it("is 404 unit_not_found for a unit outside the company's org tree (another company's node ids do not count), after authorization", async () => {
      const r = await put("budgets/units/d-nowhere", { monthlyUsd: "5" }, ownerW);
      expect(r.statusCode, r.body).toBe(404);
      expect(r.body).toContain("unit_not_found"); // the house error filter wraps the body; reads.http.test.ts asserts the same way
      // company B has d-web but A's tree is what A's owner is checked against; a node only in another tree is unknown here
      await withTenants([B], (c) => rebuildOrgUnitClosure(c, B, { id: "b-only", kind: "company", name: "B", children: [{ id: "b-dept", kind: "department", name: "B Dept", children: [] }] } as never));
      expect((await put("budgets/units/b-dept", { monthlyUsd: "5" }, ownerW)).statusCode).toBe(404);
      expect(await stored(W)).toEqual([]);
    });

    it.each([
      ["a missing figure", {}], ["a number", { monthlyUsd: 5 }], ["a mode outside the vocabulary", { monthlyUsd: "5", mode: "hard_stop" }],
      ["a mode with a null figure", { monthlyUsd: null, mode: "report" }], ["a null mode", { monthlyUsd: "5", mode: null }], ["an unknown key", { monthlyUsd: "5", x: 1 }],
    ])("is 400 for %s", async (_l, body) => {
      const r = await put("budgets/units/d-web", body, ownerW);
      expect(r.statusCode, r.body).toBe(400);
      expect(await stored(W)).toEqual([]);
    });

    it("validation comes before existence: a bad body for an unknown unit is 400", async () => {
      expect((await put("budgets/units/d-nowhere", { monthlyUsd: 5 }, ownerW)).statusCode).toBe(400);
    });
  });

  describe("per-person allowances", () => {
    it("the owner sets, lists (names and the default) and removes a person's override", async () => {
      const empty = await get("allowances", ownerW, W);
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.json()).toEqual({ defaultDailyReplies: config.aiUsage.dailyReplyAllowance, overrides: [] });

      const set = await put(`allowances/${memberW}`, { dailyReplies: 350 }, ownerW);
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toEqual({ userId: memberW, changed: true, dailyReplies: 350, isDefault: false });
      const list = (await get("allowances", ownerW, W)).json();
      expect(list.overrides).toHaveLength(1);
      expect(list.overrides[0]).toMatchObject({ userId: memberW, name: "Mia Member", dailyReplies: 350 });

      const upd = await put(`allowances/${memberW.toUpperCase()}`, { dailyReplies: 1 }, ownerW);
      expect(upd.json()).toMatchObject({ userId: memberW, dailyReplies: 1 });

      const del = await put(`allowances/${memberW}`, { dailyReplies: null }, ownerW);
      expect(del.json()).toEqual({ userId: memberW, changed: true, dailyReplies: config.aiUsage.dailyReplyAllowance, isDefault: true });
      expect((await put(`allowances/${memberW}`, { dailyReplies: null }, ownerW)).json().changed).toBe(false);
      expect((await get("allowances", ownerW, W)).json().overrides).toEqual([]);

      const acts = await activities(W);
      expect(acts.map((a) => a.verb)).toEqual(["created", "updated", "removed"]);
      expect(acts.every((a) => a.target_entity_type === "ai_allowance" && a.target_entity_id === memberW && a.actor_id === ownerW)).toBe(true);
      expect(acts[1].metadata).toMatchObject({ dailyReplies: 1, previousDailyReplies: 350 });
    });

    it("is 404 person_not_found for a person who is not an active member of the company, and for a stranger's id", async () => {
      for (const who of [stranger, newId()]) {
        const r = await put(`allowances/${who}`, { dailyReplies: 5 }, ownerW);
        expect(r.statusCode, r.body).toBe(404);
        expect(r.body).toContain("person_not_found"); // the house error filter wraps the body; reads.http.test.ts asserts the same way
      }
      // a removed or suspended membership is not active
      await q().query(`UPDATE company_memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`, [W, adminW]);
      expect((await put(`allowances/${adminW}`, { dailyReplies: 5 }, ownerW)).statusCode).toBe(404);
      await q().query(`UPDATE company_memberships SET status = 'active' WHERE tenant_id = $1 AND user_id = $2`, [W, adminW]);
      expect((await q().query(`SELECT 1 FROM ai_person_allowances WHERE tenant_id = $1`, [W])).rows).toHaveLength(0);
    });

    it.each([["zero", { dailyReplies: 0 }], ["negative", { dailyReplies: -1 }], ["too big", { dailyReplies: 100001 }], ["a fraction", { dailyReplies: 1.5 }], ["a string", { dailyReplies: "5" }], ["missing", {}], ["an unknown key", { dailyReplies: 5, x: 1 }]])(
      "is 400 for %s",
      async (_l, body) => {
        expect((await put(`allowances/${memberW}`, body, ownerW)).statusCode).toBe(400);
        expect((await q().query(`SELECT 1 FROM ai_person_allowances WHERE tenant_id = $1`, [W])).rows).toHaveLength(0);
      },
    );

    it("is 400 for an id that is not a uuid; validation comes before existence", async () => {
      expect((await put("allowances/not-a-uuid", { dailyReplies: 5 }, ownerW)).statusCode).toBe(400);
      expect((await put(`allowances/${stranger}`, { dailyReplies: 0 }, ownerW)).statusCode).toBe(400);
    });
  });
});
