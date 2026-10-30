// AIP-15 (FRONTEND-BFF-CONTRACT §66; PERMISSION-CONTRACT §58; owner rulings AIP-D6 and AIP-D18) — the three AI usage reads, driven end to end
// over HTTP against real Postgres (RLS on) and real Cerbos:
//   GET /api/:t/ai-usage/me
//   GET /api/:t/ai-usage/units/:unitNodeId
//   GET /api/:t/ai-usage/company
// Claims:
//   OWN        a member sees only their own rows (another person's never), by surface and by UTC day; a member with no rows sees 0 calls and
//              null sums; unknown cost stays null and is counted in noCostCalls.
//   UNIT       a head (of the unit, or of an enclosing unit) sees the unit's WHOLE SUBTREE (a division's rows add to its department) and
//              `people[]`; old rows count through org_units.node_id when unit_node_id is NULL; company_admin and the GM see the same totals
//              with NO `people` key; the owner sees people; a sibling's head, a member and another company's admin get 403; a head gets 403
//              (never 404) for a unit that does not exist, a company admin 404.
//   COMPANY    company_admin, the GM and the owner see totals by department (names from the tree), the "No department recorded" bucket, the
//              "no person" rows by surface, by model, by surface and by day, and never a person; a head, a member and another company's admin
//              get 403.
//   TENANTS    company B's rows (the SAME node ids) never appear in A's answers.
//   MONTH      UTC calendar month: a row one second before it and the first instant of the next month are outside; `?month=2026-13` is 400 for
//              an authorized caller and 403 for a refused one (authorization first); no month is the current UTC month.
//   NO TEXT    the `task` label and thread ids never appear in any answer.
//   CAPS       `capabilities` says what the caller may do: people, manage, lift a stop.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the resource_ai_usage.yaml edit).
// It SKIPS without a database; a skip is not a pass.
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
const SECRET_TASK = "aip15.secret-task-label";
const MONTH = "2026-09";

// The same org shape in BOTH companies, node ids included. `d-gm` is the GM workspace for the `agency` vertical.
const tree = (name: string) => ({
  id: "d-corp", kind: "company", name,
  children: [
    { id: "d-gm", kind: "department", name: "GM", children: [] },
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
  ],
});

describe.skipIf(!TEST_URL)("AIP-15 AI usage reads (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let admin: string; // company_admin
  let owner: string; // owner (permission-native)
  let gm: string; // member + the lead seat of d-gm
  let webHead: string; // member + manager + org_unit_lead d-web (+ seat)
  let corpHead: string; // member + org_unit_lead d-corp (+ seat): a head ABOVE every unit
  let seoHead: string; // member + manager + org_unit_lead d-seo (+ seat): a sibling's head
  let staff1: string; // member, home d-web
  let staff2: string; // member, home dv-fe (a division under d-web)
  let seoStaff: string; // member, home d-seo
  let idle: string; // member, no rows at all
  let bAdmin: string;
  let bStaff: string;

  const q = adminPool;
  const get = (path: string, as: string, tenant = A) => app.inject({ method: "GET", url: `/api/${tenant}/ai-usage/${path}`, headers: asUser(as) });
  const m = (path: string) => `${path}${path.includes("?") ? "&" : "?"}month=${MONTH}`;

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

  /** One usage row through the superuser pool. */
  async function row(over: Record<string, unknown> & { tenant_id: string; occurred_at: string }) {
    const r: Record<string, unknown> = { surface: "assistant", capability: "chat", tokens_source: "provider", outcome: "ok", task: SECRET_TASK, thread_id: newId(), ...over };
    const cols = Object.keys(r);
    await q().query(
      `INSERT INTO ai_usage_events (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
      [newId(), ...cols.map((c) => r[c])],
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    A = await createCompany("Usage Co A");
    B = await createCompany("Usage Co B");
    await q().query(`UPDATE companies SET vertical = 'agency' WHERE id = ANY($1::uuid[])`, [[A, B]]);
    const mkUser = async (key: string, name: string, tenants: string[] = [A]) => {
      const id = await createUser(`${key}@aiusage.test`, name);
      for (const t of tenants) await addMembership(t, id);
      return id;
    };
    admin = await mkUser("admin", "Ada Admin");
    owner = await mkUser("owner", "Olga Owner");
    gm = await mkUser("gm", "Gus GM");
    webHead = await mkUser("webhead", "Wes Head");
    corpHead = await mkUser("corphead", "Cory Head");
    seoHead = await mkUser("seohead", "Sia Head");
    staff1 = await mkUser("staff1", "Stan One");
    staff2 = await mkUser("staff2", "Sue Two");
    seoStaff = await mkUser("seostaff", "Sam Seo");
    idle = await mkUser("idle", "Ida Idle");
    bAdmin = await mkUser("badmin", "Bea Admin", [B]);
    bStaff = await mkUser("bstaff", "Bo Staff", [B]);

    const role = {
      admin: await createRole("company_admin"), owner: await createRole("owner"), manager: await createRole("manager"),
      member: await createRole("member"), lead: await createRole("org_unit_lead"),
    };
    for (const u of [gm, webHead, corpHead, seoHead, staff1, staff2, seoStaff, idle]) await grantRole(u, role.member, "company", A);
    for (const u of [webHead, seoHead]) await grantRole(u, role.manager, "company", A);
    await grantRole(admin, role.admin, "company", A);
    await grantRole(owner, role.owner, "company", A);
    await q().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [owner, A]);
    await grantRole(webHead, role.lead, "org_unit", "d-web");
    await grantRole(corpHead, role.lead, "org_unit", "d-corp");
    await grantRole(seoHead, role.lead, "org_unit", "d-seo");
    await grantLeadSeat(A, "d-web", webHead);
    await grantLeadSeat(A, "d-corp", corpHead);
    await grantLeadSeat(A, "d-seo", seoHead);
    await grantLeadSeat(A, "d-gm", gm); // the GM: a seat, no grant
    await grantRole(bAdmin, role.admin, "company", B);
    await grantRole(bStaff, role.member, "company", B);

    await seedTree(A, "Usage Co A");
    await seedTree(B, "Usage Co B");

    // An OLD row's department: an org_units anchor for d-web (the only way a row written before AIP-15a carries a department).
    const anchor = newId();
    await q().query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1, $2, 'd-web', 'department', 'Web Dev')`, [anchor, A]);

    // ── company A, September 2026 (UTC) ──
    await row({ tenant_id: A, user_id: staff1, unit_node_id: "d-web", occurred_at: "2026-09-03T08:00:00Z", provider: "openai", model: "m1", prompt_tokens: 100, completion_tokens: 20, cost_usd: "0.01", cost_source: "provider" });
    await row({ tenant_id: A, user_id: staff2, unit_node_id: "dv-fe", occurred_at: "2026-09-03T09:00:00Z", provider: "openai", model: "m1", prompt_tokens: 10, completion_tokens: 5, tokens_source: "estimate" });
    await row({ tenant_id: A, user_id: seoStaff, unit_node_id: "d-seo", occurred_at: "2026-09-10T10:00:00Z", surface: "agent", capability: "llm", provider: "openai", model: "m2", prompt_tokens: 50, completion_tokens: 50, cost_usd: "0.02", cost_source: "table" });
    await row({ tenant_id: A, user_id: staff1, occurred_at: "2026-09-11T10:00:00Z", provider: "openai", model: "m1", prompt_tokens: 1, completion_tokens: 1, cost_usd: "0.005", cost_source: "provider" }); // no department recorded
    await row({ tenant_id: A, occurred_at: "2026-09-12T10:00:00Z", surface: "knowledge", capability: "embed", tokens_source: "none", provider: "openai", model: "embed-1" }); // no person
    await row({ tenant_id: A, user_id: staff1, org_unit_id: anchor, occurred_at: "2026-09-15T23:59:59Z", tokens_source: "none", provider: "openai", model: "m1" }); // an old row: d-web through org_units
    await row({ tenant_id: A, user_id: webHead, unit_node_id: "d-web", occurred_at: "2026-09-20T12:00:00Z", provider: "openai", model: "m1", prompt_tokens: 2, completion_tokens: 3, cost_usd: "0.001", cost_source: "provider" });
    // outside the month, on both edges
    await row({ tenant_id: A, user_id: staff1, unit_node_id: "d-web", occurred_at: "2026-08-31T23:59:59Z", cost_usd: "9", cost_source: "provider" });
    await row({ tenant_id: A, user_id: staff1, unit_node_id: "d-web", occurred_at: "2026-10-01T00:00:00Z", cost_usd: "9", cost_source: "provider" });
    // ── company B: the SAME node id, a big cost that must never show in A ──
    await row({ tenant_id: B, user_id: bStaff, unit_node_id: "d-web", occurred_at: "2026-09-03T08:00:00Z", provider: "openai", model: "m1", prompt_tokens: 7, completion_tokens: 7, cost_usd: "0.5", cost_source: "provider" });

    app = await buildApp();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const NO_TEXT = (body: string) => {
    expect(body).not.toContain(SECRET_TASK);
    expect(body).not.toContain("thread");
  };

  // ═══════════════════════════════════════════ OWN ═══════════════════════════════════════════
  describe("GET me", () => {
    it("a member sees only their OWN rows: totals, by surface, by UTC day; never another person's", async () => {
      const r = await get(m("me"), staff1);
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json();
      expect(b.month).toBe(MONTH);
      expect(b.totals).toEqual({
        calls: 3, promptTokens: 101, completionTokens: 21, costUsd: "0.01500000", estimatedTokenCalls: 0, noTokenCalls: 1, noCostCalls: 1,
        providerCostCalls: 2, tableCostCalls: 0,
      });
      expect(b.bySurface.map((s: { surface: string; calls: number }) => [s.surface, s.calls])).toEqual([["assistant", 3]]);
      expect(b.byDay.map((d: { day: string; calls: number }) => [d.day, d.calls])).toEqual([["2026-09-03", 1], ["2026-09-11", 1], ["2026-09-15", 1]]);
      expect(b).not.toHaveProperty("people");
      expect(b.capabilities).toEqual({ canSeePeople: false, canManage: false, canLiftStop: false });
      expect(r.body).not.toContain(staff2);
      NO_TEXT(r.body);
    });

    it("unknown cost stays null and is counted: a member whose only row has no cost", async () => {
      const b = (await get(m("me"), staff2)).json();
      expect(b.totals).toMatchObject({ calls: 1, costUsd: null, noCostCalls: 1, estimatedTokenCalls: 1, promptTokens: 10 });
    });

    it("a member with no rows: 0 calls and null sums (unknown, never 0)", async () => {
      const b = (await get(m("me"), idle)).json();
      expect(b.totals).toMatchObject({ calls: 0, promptTokens: null, completionTokens: null, costUsd: null });
      expect(b.bySurface).toEqual([]);
      expect(b.byDay).toEqual([]);
    });

    it("a head's own line is their own, even though they may read their unit", async () => {
      const b = (await get(m("me"), webHead)).json();
      expect(b.totals).toMatchObject({ calls: 1, costUsd: "0.00100000" });
      expect(b.capabilities).toEqual({ canSeePeople: false, canManage: false, canLiftStop: false });
    });

    it("the owner's capabilities: people, manage, and lifting any stop", async () => {
      const r = await get(m("me"), owner);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().capabilities).toEqual({ canSeePeople: true, canManage: true, canLiftStop: true });
    });

    it("another company's member is refused here; their own company answers only their rows", async () => {
      expect((await get(m("me"), bStaff)).statusCode).toBe(403);
      const b = (await get(m("me"), bStaff, B)).json();
      expect(b.totals).toMatchObject({ calls: 1, costUsd: "0.50000000" });
    });

    it("no month is the current UTC month", async () => {
      const now = new Date();
      const want = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const r = await get("me", staff1);
      expect(r.statusCode, r.body).toBe(200);
      const after = new Date();
      const wantAfter = `${after.getUTCFullYear()}-${String(after.getUTCMonth() + 1).padStart(2, "0")}`;
      expect([want, wantAfter]).toContain(r.json().month); // a request that straddles a month's last instant may answer either
    });
  });

  // ═══════════════════════════════════════════ UNIT ═══════════════════════════════════════════
  describe("GET units/:unitNodeId", () => {
    const WEB_TOTALS = {
      calls: 4, promptTokens: 112, completionTokens: 28, costUsd: "0.01100000", estimatedTokenCalls: 1, noTokenCalls: 1, noCostCalls: 2,
      providerCostCalls: 2, tableCostCalls: 0,
    };

    it("the head of d-web: the WHOLE subtree (dv-fe adds in; the old org_units row counts), and people", async () => {
      const r = await get(m("units/d-web"), webHead);
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json();
      expect(b.unit).toEqual({ unitNodeId: "d-web", name: "Web Dev" });
      expect(b.totals).toEqual(WEB_TOTALS);
      const people = b.people.map((p: { userId: string; name: string; calls: number }) => [p.userId, p.name, p.calls]);
      expect(people).toEqual([[staff1, "Stan One", 2], [staff2, "Sue Two", 1], [webHead, "Wes Head", 1]]);
      expect(b.byModel.map((x: { provider: string; model: string; calls: number }) => [x.provider, x.model, x.calls])).toEqual([["openai", "m1", 4]]);
      expect(b.capabilities).toEqual({ canSeePeople: true, canManage: false, canLiftStop: true });
      expect(r.body).not.toContain(seoStaff);
      expect(r.body).not.toContain(bStaff);
      NO_TEXT(r.body);
    });

    it("the head of the enclosing d-corp reads d-web the same way, with people", async () => {
      const b = (await get(m("units/d-web"), corpHead)).json();
      expect(b.totals).toEqual(WEB_TOTALS);
      expect(b.people).toHaveLength(3);
    });

    it("company_admin and the GM: the same totals and NO `people` key at all", async () => {
      for (const who of [admin, gm]) {
        const r = await get(m("units/d-web"), who);
        expect(r.statusCode, r.body).toBe(200);
        const b = r.json();
        expect(b.totals).toEqual(WEB_TOTALS);
        expect(b).not.toHaveProperty("people");
        expect(b.capabilities).toEqual({ canSeePeople: false, canManage: false, canLiftStop: false });
        expect(r.body).not.toContain(staff1);
        expect(r.body).not.toContain("Stan One");
      }
    });

    it("the owner: totals AND people, and may manage", async () => {
      const r = await get(m("units/d-web"), owner);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().people).toHaveLength(3);
      expect(r.json().capabilities).toEqual({ canSeePeople: true, canManage: true, canLiftStop: true });
    });

    it("a division's head is refused its parent; a sibling's head, a member and another company's admin are refused", async () => {
      expect((await get(m("units/d-web"), seoHead)).statusCode).toBe(403);
      expect((await get(m("units/d-seo"), webHead)).statusCode).toBe(403);
      expect((await get(m("units/d-web"), staff1)).statusCode).toBe(403);
      expect((await get(m("units/d-web"), bAdmin)).statusCode).toBe(403);
    });

    it("company B's d-web (the SAME node id) answers only B's rows, and A's head is refused it", async () => {
      expect((await get(m("units/d-web"), webHead, B)).statusCode).toBe(403);
      const b = (await get(m("units/d-web"), bAdmin, B)).json();
      expect(b.totals).toMatchObject({ calls: 1, costUsd: "0.50000000" });
    });

    it("an unknown unit: a head gets 403 (nothing says whether it exists); a company admin gets 404", async () => {
      expect((await get(m("units/d-nope"), webHead)).statusCode).toBe(403);
      const r = await get(m("units/d-nope"), admin);
      expect(r.statusCode).toBe(404);
      expect(r.body).toContain("unit_not_found");
    });

    it("the month is validated AFTER authorization: 400 for the head, 403 for a member", async () => {
      expect((await get("units/d-web?month=2026-13", webHead)).statusCode).toBe(400);
      expect((await get("units/d-web?month=2026-13", staff1)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════ COMPANY ═══════════════════════════════════════════
  describe("GET company", () => {
    it("company_admin: totals by department (names), the 'No department recorded' bucket, 'no person' by surface; no person anywhere", async () => {
      const r = await get(m("company"), admin);
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json();
      expect(b.totals).toMatchObject({ calls: 7, costUsd: "0.03600000", noCostCalls: 3, estimatedTokenCalls: 1, tableCostCalls: 1, providerCostCalls: 3 });
      const depts = b.byDepartment.map((d: { unitNodeId: string | null; name: string | null; calls: number }) => [d.unitNodeId, d.name, d.calls]);
      expect(depts).toEqual([["d-seo", "SEO", 1], ["d-web", "Web Dev", 3], ["dv-fe", "Frontend", 1], [null, null, 1]]);
      expect(b.noPerson.map((s: { surface: string; calls: number }) => [s.surface, s.calls])).toEqual([["knowledge", 1]]);
      expect(b.bySurface.map((s: { surface: string; calls: number }) => [s.surface, s.calls])).toEqual([["agent", 1], ["assistant", 5], ["knowledge", 1]]);
      expect(b.byModel.map((x: { model: string; calls: number }) => [x.model, x.calls])).toEqual([["embed-1", 1], ["m1", 5], ["m2", 1]]);
      expect(b.byDay[0]).toMatchObject({ day: "2026-09-03", calls: 2 });
      expect(b).not.toHaveProperty("people");
      expect(b.capabilities).toEqual({ canSeePeople: false, canManage: false, canLiftStop: false });
      for (const id of [staff1, staff2, seoStaff, webHead, bStaff]) expect(r.body).not.toContain(id);
      expect(r.body).not.toContain("Stan One");
      NO_TEXT(r.body);
    });

    it("the GM reads it (a seat, not a grant); the owner reads it and may see people and manage", async () => {
      const g = await get(m("company"), gm);
      expect(g.statusCode, g.body).toBe(200);
      expect(g.json().totals.calls).toBe(7);
      const o = await get(m("company"), owner);
      expect(o.statusCode, o.body).toBe(200);
      expect(o.json().capabilities).toEqual({ canSeePeople: true, canManage: true, canLiftStop: true });
      expect(o.json()).not.toHaveProperty("people");
    });

    it("a head, a member and another company's admin are refused; B's admin reads only B", async () => {
      for (const who of [webHead, staff1, bAdmin]) expect((await get(m("company"), who)).statusCode, who).toBe(403);
      const b = (await get(m("company"), bAdmin, B)).json();
      expect(b.totals).toMatchObject({ calls: 1, costUsd: "0.50000000" });
    });

    it("the month: 400 for an authorized caller, 403 for a refused one; a repeated parameter is 400", async () => {
      expect((await get("company?month=2026-13", admin)).statusCode).toBe(400);
      expect((await get("company?month=", admin)).statusCode).toBe(400);
      expect((await get("company?month=2026-09&month=2026-10", admin)).statusCode).toBe(400);
      expect((await get("company?month=2026-13", staff1)).statusCode).toBe(403);
      expect((await get("company?month=2026-08", admin)).json().totals.calls).toBe(1); // the row one second before September
      expect((await get("company?month=2026-10", admin)).json().totals.calls).toBeGreaterThanOrEqual(1); // the first instant of October
    });
  });
});
