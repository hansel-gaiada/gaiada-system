// AIP-18 (FRONTEND-BFF-CONTRACT §66.11; PERMISSION-CONTRACT §58) — `POST /api/:t/ai-usage/budgets/units/:unitNodeId/lift`, driven end to end
// over HTTP against real Postgres (RLS on) and real Cerbos, with a fake agent runner. Claims:
//   MATRIX    the owner 200 (manage); the head of the unit 200 and the head of an enclosing unit 200 (lift_stop over unitAncestors); a sibling
//             unit's head, a company admin and a member 403 with nothing stored; an unknown unit is 404 `unit_not_found` for the owner (after
//             authorization) and 403 for a head (no ancestry, no grant matches); a `report`-mode unit and a unit with no budget are 404
//             `no_soft_stop` (after authorization).
//   WRITE     `stop_lifted_month` = the current UTC month on that one row, ONE activity row (`lifted`, ids and the month only); a second lift in
//             the same month answers `changed: false` and writes nothing.
//   RELEASE   right after the lift, the held hand-off of a person under the unit starts (posted to the runner once, under that person's own
//             envelope); a held hand-off of a person who is still stopped for another reason (their allowance) stays held.
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos with the current policies). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { resetModules } from "../registry";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { clearBudgetStateCacheForTests } from "./soft-stop";
import { clearUnitCacheForTests } from "./gateway-usage";

const svcAuth = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svcAuth, "x-user-id": id });

function startFakeRunner(): Promise<{ url: string; goals: Array<{ goal?: string; envelope?: { externalId?: string } }>; close: () => Promise<void> }> {
  const goals: Array<{ goal?: string; envelope?: { externalId?: string } }> = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/agents") {
      return json(200, { agents: [{ name: "status-reporter", tools: [], maxSteps: 4, maxToolCalls: 2, writeCapable: false, evaledProviders: [] }], supervisor: null });
    }
    if (req.method === "POST" && url.pathname === "/goals") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => { goals.push(JSON.parse(raw)); json(202, { id: randomUUID(), status: "queued" }); });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    goals,
    close: () => new Promise<void>((r) => server.close(() => r())),
  })));
}

const tree = {
  id: "d-corp", kind: "company", name: "Lift Co",
  children: [
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
    { id: "d-ops", kind: "department", name: "Operations", children: [] },
  ],
};

describe.skipIf(!TEST_URL)("AIP-18 lifting a department's soft stop (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let runner: Awaited<ReturnType<typeof startFakeRunner>>;
  let W: string;
  let owner: string;
  let admin: string;
  let member: string;
  let headFe: string; // lead of dv-fe (the stopped unit)
  let headWeb: string; // lead of d-web (encloses dv-fe)
  let headSeo: string; // lead of d-seo (a sibling)
  let headOps: string; // lead of d-ops (a report-mode budget)
  let feStaff: string; // home dv-fe, a held hand-off waiting on dv-fe's stop
  let feCapped: string; // home dv-fe, ALSO over their own allowance
  const q = () => adminPool();
  const MONTH = new Date().toISOString().slice(0, 7);

  const lift = (unit: string, as: string, tenant = () => W) =>
    app.inject({ method: "POST", url: `/api/${tenant()}/ai-usage/budgets/units/${encodeURIComponent(unit)}/lift`, headers: asUser(as) });
  const liftedMonth = async (unit: string) =>
    (await q().query(`SELECT stop_lifted_month FROM ai_budgets WHERE tenant_id = $1 AND scope = 'unit' AND unit_node_id = $2`, [W, unit])).rows[0]?.stop_lifted_month ?? null;
  const liftActivities = async () =>
    (await q().query(
      `SELECT actor_id, metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'ai_budget' AND verb = 'lifted' ORDER BY occurred_at, id`,
      [W],
    )).rows as Array<{ actor_id: string; metadata: Record<string, unknown> }>;
  const resetLift = () => q().query(`UPDATE ai_budgets SET stop_lifted_month = NULL WHERE tenant_id = $1`, [W]);

  async function heldHandoff(user: string, kind: "department" | "allowance", unit: string | null, goal: string): Promise<string> {
    const threadId = newId();
    await q().query(`INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site) VALUES ($1, $2, $3, 'lift', $4)`, [threadId, W, user, config.originSite]);
    const id = newId();
    await q().query(
      `INSERT INTO assistant_handoffs (id, tenant_id, thread_id, owner_user_id, agent, goal_text, goal_id, status, hold_kind, hold_unit_node_id, held_at, origin_site)
       VALUES ($1, $2, $3, $4, 'status-reporter', $5, NULL, 'held', $6, $7, now(), $8)`,
      [id, W, threadId, user, goal, kind, unit, config.originSite],
    );
    return id;
  }
  const status = async (id: string) => (await q().query(`SELECT status, goal_id FROM assistant_handoffs WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    runner = await startFakeRunner();
    config.services.agents = { url: runner.url, token: "runner-token" };

    W = await createCompany("Lift Co", ["assistant"]);
    await q().query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [W]);
    const mk = async (key: string) => {
      const id = await createUser(`${key}@aip18lift.test`, key);
      await addMembership(W, id);
      return id;
    };
    owner = await mk("owner");
    admin = await mk("admin");
    member = await mk("member");
    headFe = await mk("headfe");
    headWeb = await mk("headweb");
    headSeo = await mk("headseo");
    headOps = await mk("headops");
    feStaff = await mk("festaff");
    feCapped = await mk("fecapped");

    const role = { admin: await createRole("company_admin"), owner: await createRole("owner"), member: await createRole("member"), manager: await createRole("manager"), lead: await createRole("org_unit_lead") };
    for (const u of [member, feStaff, feCapped]) await grantRole(u, role.member, "company", W);
    for (const u of [headFe, headWeb, headSeo, headOps]) await grantRole(u, role.manager, "company", W);
    await grantRole(admin, role.admin, "company", W);
    await grantRole(owner, role.owner, "company", W);
    await q().query(`UPDATE users SET home_company_id = $2 WHERE id = $1`, [owner, W]);
    await grantRole(headFe, role.lead, "org_unit", "dv-fe");
    await grantRole(headWeb, role.lead, "org_unit", "d-web");
    await grantRole(headSeo, role.lead, "org_unit", "d-seo");
    await grantRole(headOps, role.lead, "org_unit", "d-ops");

    await withTenants([W], (c) => c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
      [W, JSON.stringify({ root: tree }), config.originSite],
    ));
    await withTenants([W], (c) => rebuildOrgUnitClosure(c, W, tree));
    for (const u of [feStaff, feCapped]) {
      await q().query(
        `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, origin_site) VALUES ($1, $2, 'dv-fe', true, current_date - 3, $3)`,
        [W, u, config.originSite],
      );
    }
    // dv-fe: soft_stop 1.00, spent 3.00 this month. d-ops: report mode, far over. d-seo: no budget.
    await q().query(
      `INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode) VALUES ($1, 'unit', 'dv-fe', 1, 'soft_stop'), ($1, 'unit', 'd-ops', 1, 'report')`,
      [W],
    );
    const usage = (user: string, unit: string, cost: string) => q().query(
      `INSERT INTO ai_usage_events (id, tenant_id, user_id, unit_node_id, surface, capability, tokens_source, outcome, occurred_at, cost_usd, cost_source)
       VALUES ($1, $2, $3, $4, 'assistant', 'chat', 'provider', 'ok', now(), $5, 'provider')`,
      [newId(), W, user, unit, cost],
    );
    await usage(feStaff, "dv-fe", "3.00");
    await usage(headOps, "d-ops", "9.00");
    // feCapped is also over their own allowance (1 reply a day, 1 made)
    await q().query(`INSERT INTO ai_person_allowances (tenant_id, user_id, daily_replies) VALUES ($1, $2, 1)`, [W, feCapped]);
    await usage(feCapped, "dv-fe", "0");

    app = await buildApp();
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await runner?.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    clearBudgetStateCacheForTests();
    clearUnitCacheForTests();
    await resetLift();
  });

  describe("who may lift", () => {
    it.each([
      ["a sibling unit's head", () => headSeo],
      ["a company admin", () => admin],
      ["a member", () => member],
      ["the head of a report-mode unit, on another unit", () => headOps],
    ])("%s is refused (403) and nothing is stored", async (_label, who) => {
      const r = await lift("dv-fe", who());
      expect(r.statusCode, r.body).toBe(403);
      expect(await liftedMonth("dv-fe")).toBeNull();
      expect(await liftActivities()).toEqual([]);
    });

    it.each([
      ["the owner (manage)", () => owner],
      ["the head of the unit (lift_stop)", () => headFe],
      ["the head of an enclosing unit (lift_stop)", () => headWeb],
    ])("%s lifts it (200) for the current UTC month", async (_label, who) => {
      const before = (await liftActivities()).length;
      const r = await lift("dv-fe", who());
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.month).toBe(MONTH);
      expect(body.changed).toBe(true);
      expect(body.budget).toMatchObject({ unitNodeId: "dv-fe", mode: "soft_stop", stopLifted: true });
      expect(await liftedMonth("dv-fe")).toBe(MONTH);
      const acts = await liftActivities();
      expect(acts.length).toBe(before + 1);
      expect(acts[acts.length - 1]).toMatchObject({ actor_id: who(), metadata: expect.objectContaining({ scope: "unit", unitNodeId: "dv-fe", month: MONTH }) });
    });
  });

  describe("what may be lifted", () => {
    it("an unknown unit: the owner gets 404 unit_not_found (after authorization), a head gets 403", async () => {
      const o = await lift("d-nowhere", owner);
      expect(o.statusCode, o.body).toBe(404);
      expect(o.json().message).toBe("unit_not_found");
      expect((await lift("d-nowhere", headWeb)).statusCode).toBe(403);
    });

    it("a report-mode unit is 404 no_soft_stop for the owner and for its own head; a unit with no budget too", async () => {
      for (const who of [owner, headOps]) {
        const r = await lift("d-ops", who);
        expect(r.statusCode, r.body).toBe(404);
        expect(r.json().message).toBe("no_soft_stop");
      }
      const seo = await lift("d-seo", headSeo);
      expect(seo.statusCode, seo.body).toBe(404);
      expect(seo.json().message).toBe("no_soft_stop");
      expect(await liftedMonth("d-ops")).toBeNull();
      expect(await liftActivities()).toEqual([]);
    });

    it("lifting twice in a month changes nothing the second time and writes one activity row", async () => {
      expect((await lift("dv-fe", owner)).json().changed).toBe(true);
      const r = await lift("dv-fe", headFe);
      expect(r.statusCode).toBe(200);
      expect(r.json().changed).toBe(false);
      expect((await liftActivities()).filter((a) => a.metadata.month === MONTH).length).toBeGreaterThanOrEqual(1);
      const n = (await liftActivities()).length;
      await lift("dv-fe", headWeb);
      expect((await liftActivities()).length).toBe(n);
    });

    it("another company's id for the same node is never touched", async () => {
      const B = await createCompany("Lift Co B", ["assistant"]);
      await q().query(`INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode) VALUES ($1, 'unit', 'dv-fe', 1, 'soft_stop')`, [B]);
      // headFe's lead grant is not B's, and B has no tree: no ancestry, no grant
      expect((await lift("dv-fe", headFe, () => B)).statusCode).toBe(403);
      const b = await q().query(`SELECT stop_lifted_month FROM ai_budgets WHERE tenant_id = $1`, [B]);
      expect(b.rows[0].stop_lifted_month).toBeNull();
    });
  });

  describe("release on lift", () => {
    it("starts the held hand-off of a person under the unit, once; a person still over their allowance stays held", async () => {
      const waiting = await heldHandoff(feStaff, "department", "dv-fe", "start after the lift");
      const capped = await heldHandoff(feCapped, "department", "dv-fe", "still capped");
      const before = runner.goals.length;
      const r = await lift("dv-fe", headFe);
      expect(r.statusCode, r.body).toBe(200);
      const posted = runner.goals.slice(before);
      expect(posted.filter((g) => g.goal === "start after the lift").length).toBe(1);
      expect(posted.find((g) => g.goal === "start after the lift")?.envelope?.externalId).toBe(feStaff);
      expect(posted.some((g) => g.goal === "still capped")).toBe(false);
      expect((await status(waiting)).status).toBe("queued");
      const c = await q().query(`SELECT status, hold_kind, hold_unit_node_id FROM assistant_handoffs WHERE id = $1`, [capped]);
      expect(c.rows[0]).toEqual({ status: "held", hold_kind: "allowance", hold_unit_node_id: null }); // the reason now true

      // a second lift (nothing changes) starts nothing more
      const again = runner.goals.length;
      await lift("dv-fe", owner);
      expect(runner.goals.length).toBe(again);
    });
  });
});
