// AIP-17b + AIP-19 — the AI usage job (usage-alerts-job.ts) against LIVE Postgres. Needs DATABASE_URL_TEST; it SKIPS without one (and no Cerbos is
// involved: the job reads rows and seats, it authorizes nothing). A skip is not a pass.
//
// Claims:
//   BUDGETS   80 percent and 100 percent each notify ONCE per month, even when the job runs twice or three times AT ONCE (the ledger's primary
//             key decides); a unit's notice goes to exactly its head(s) and the owner(s); the company figure's to exactly the owner(s) and the GM;
//             a unit counts its whole subtree and never another company's rows; unknown cost never crosses a budget; the next month notifies
//             again; report mode changes nothing else (the budget rows are untouched, a `soft_stop` unit is only notified).
//   RUNAWAY   a person at >= 5x their own average over the previous 14 UTC days' ACTIVE days, with >= 7 active days and >= 20 calls today; the
//             exact edges (5x yes, just under no; 6 active days no; 19 calls no); the notice NAMES the person with today's calls and the usual
//             figure and carries no cost; it goes to exactly the owner(s) and the IT seat; once per subject per day; an agent the same, by `task`.
//   SWEEP     one company's failure is logged and never stops the next; a sweep that cannot take the lock does nothing; a failed notice does not
//             stop the others.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, grantLeadSeat } from "../../testing/fixtures";
import {
  NOTICE_BUDGET_100, NOTICE_BUDGET_80, NOTICE_RUNAWAY_AGENT, NOTICE_RUNAWAY_PERSON, USAGE_ALERTS_LOCK_KEY, USAGE_ALERTS_LOCK_NS,
  runCompanyAlerts, runUsageAlertsSweep,
} from "./usage-alerts-job";

const NOW = new Date("2026-09-20T12:00:00Z");
const root = (name: string) => ({
  id: "d-corp", kind: "company", name,
  children: [
    { id: "d-gm", kind: "department", name: "GM", children: [] },
    { id: "d-it", kind: "department", name: "IT", children: [] },
    { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
    { id: "d-seo", kind: "department", name: "SEO", children: [] },
  ],
});

interface Sent { tenant: string; to: string | null; actor: string | null; type: string; payload: Record<string, unknown> }

describe.skipIf(!TEST_URL)("AIP-17b / AIP-19 the AI usage job (real Postgres)", () => {
  const q = adminPool;
  let roles: { owner: string; lead: string; member: string };

  interface World { id: string; owner: string; owner2: string; head: string; head2: string; gm: string; it: string; bystander: string; person: string; sent: Sent[]; notify: ReturnType<typeof makeNotify> }

  function makeNotify(sent: Sent[]) {
    return vi.fn(async (tenant: string, to: string | null, actor: string | null, type: string, payload: Record<string, unknown> = {}) => {
      sent.push({ tenant, to, actor, type, payload });
    });
  }

  let counter = 0;
  /** A fresh company with its own tree, owners, heads, GM seat, IT seat and a bystander (a company admin who must never be told). */
  async function world(): Promise<World> {
    const key = `w${++counter}`;
    const id = await createCompany(`Alerts Co ${key}`);
    await q().query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [id]);
    const mk = async (k: string, name: string) => {
      const u = await createUser(`${k}-${key}@aialerts.test`, name);
      await addMembership(id, u);
      await grantRole(u, roles.member, "company", id);
      return u;
    };
    const w: World = {
      id, sent: [], notify: undefined as never,
      owner: await mk("owner", "Olga Owner"), owner2: await mk("owner2", "Owen Owner"), head: await mk("head", "Wes Head"), head2: await mk("head2", "Hana Head"),
      gm: await mk("gm", "Gus GM"), it: await mk("it", "Ivy IT"), bystander: await mk("bystander", "Bo Bystander"), person: await mk("person", "Pia Person"),
    };
    w.notify = makeNotify(w.sent);
    await grantRole(w.owner, roles.owner, "company", id);
    await grantRole(w.owner2, roles.owner, "company", id);
    await grantLeadSeat(id, "d-web", w.head);
    await grantLeadSeat(id, "d-web", w.head2);
    await grantLeadSeat(id, "d-gm", w.gm);
    await grantLeadSeat(id, "d-it", w.it);
    await withTenants([id], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`, [id, JSON.stringify({ root: root(`Alerts ${key}`) }), config.originSite]),
    );
    await withTenants([id], (c) => rebuildOrgUnitClosure(c, id, root(`Alerts ${key}`)));
    return w;
  }

  async function row(tenant: string, over: Record<string, unknown> & { occurred_at: string }) {
    const r: Record<string, unknown> = { tenant_id: tenant, surface: "assistant", capability: "chat", tokens_source: "provider", outcome: "ok", ...over };
    const cols = Object.keys(r);
    await q().query(`INSERT INTO ai_usage_events (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`, [newId(), ...cols.map((c) => r[c])]);
  }
  const cost = (tenant: string, usd: string, over: Record<string, unknown> = {}) =>
    row(tenant, { occurred_at: "2026-09-03T08:00:00Z", cost_usd: usd, cost_source: "provider", ...over });
  const budget = (tenant: string, scope: "company" | "unit", unit: string | null, usd: string, mode: string | null = scope === "unit" ? "report" : null) =>
    q().query(`INSERT INTO ai_budgets (tenant_id, scope, unit_node_id, monthly_usd, mode) VALUES ($1, $2, $3, $4, $5)`, [tenant, scope, unit, usd, mode]);
  const ledger = async (tenant: string) =>
    (await q().query(`SELECT kind, subject, period, threshold FROM ai_usage_alerts WHERE tenant_id = $1 ORDER BY kind, subject, period, threshold`, [tenant])).rows;
  const toSet = (sent: Sent[], type?: string) => [...new Set(sent.filter((s) => !type || s.type === type).map((s) => s.to))].sort();
  const ids = (...u: string[]) => [...u].sort();

  /** `n` calls on a UTC day, for a person (all on the assistant surface unless said). */
  async function calls(tenant: string, user: string | null, day: string, n: number, over: Record<string, unknown> = {}) {
    for (let i = 0; i < n; i++) await row(tenant, { user_id: user, occurred_at: `${day}T${String(8 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`, ...over });
  }
  /** `days` previous active UTC days before 2026-09-20 (each `perDay` calls), skipping gaps by stepping 1 day. */
  async function history(tenant: string, user: string | null, days: number, perDay: number, over: Record<string, unknown> = {}) {
    for (let d = 1; d <= days; d++) {
      const day = new Date(Date.UTC(2026, 8, 20 - d)).toISOString().slice(0, 10);
      await calls(tenant, user, day, perDay, over);
    }
  }

  beforeAll(async () => {
    await initTestDb();
    roles = { owner: await createRole("owner"), lead: await createRole("org_unit_lead"), member: await createRole("member") };
  }, 120_000);
  afterAll(async () => { await teardownTestDb(); });

  // ═══════════════════════════════════════════ BUDGETS ═══════════════════════════
  describe("budgets", () => {
    it("80 percent of a unit's budget notifies exactly its heads and the owners, once, however often or concurrently it runs", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "10");
      await cost(w.id, "8.5", { user_id: w.person, unit_node_id: "d-web" });

      const r = await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(r).toEqual({ budgetNotices: 1, runawayNotices: 0 });
      expect(toSet(w.sent)).toEqual(ids(w.head, w.head2, w.owner, w.owner2));
      expect(w.sent.every((s) => s.type === NOTICE_BUDGET_80 && s.tenant === w.id && s.actor === null)).toBe(true);
      expect(w.sent[0].payload).toMatchObject({ href: "/analytics/ai-usage/department?unit=d-web", severity: "warning", scope: "unit", unitNodeId: "d-web", month: "2026-09", threshold: 80 });
      expect(String(w.sent[0].payload.body)).toContain("85%");
      expect(await ledger(w.id)).toEqual([{ kind: "unit_budget", subject: "d-web", period: "2026-09", threshold: 80 }]);

      const before = w.sent.length;
      expect(await runCompanyAlerts(w.id, NOW, { notify: w.notify })).toEqual({ budgetNotices: 0, runawayNotices: 0 });
      await Promise.all([runCompanyAlerts(w.id, NOW, { notify: w.notify }), runCompanyAlerts(w.id, NOW, { notify: w.notify }), runCompanyAlerts(w.id, NOW, { notify: w.notify })]);
      expect(w.sent.length).toBe(before);
    });

    it("three runners at once on a FRESH threshold send exactly one set of notices", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-seo", "10");
      await cost(w.id, "9", { user_id: w.person, unit_node_id: "d-seo" });
      const results = await Promise.all([1, 2, 3].map(() => runCompanyAlerts(w.id, NOW, { notify: w.notify })));
      expect(results.reduce((n, r) => n + r.budgetNotices, 0)).toBe(1);
      // d-seo has no head seat: the owners alone
      expect(toSet(w.sent)).toEqual(ids(w.owner, w.owner2));
      expect(w.sent).toHaveLength(2);
      expect(await ledger(w.id)).toHaveLength(1);
    });

    it("100 percent notifies once more; reaching it later keeps the 80 notice's ledger row; the exact edge counts", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "10");
      await cost(w.id, "8", { user_id: w.person, unit_node_id: "d-web" }); // exactly 80
      await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(w.sent.map((s) => s.type)).toEqual(Array(4).fill(NOTICE_BUDGET_80));
      w.sent.length = 0;
      await cost(w.id, "2", { user_id: w.person, unit_node_id: "d-web" }); // now exactly 100
      const r = await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(r.budgetNotices).toBe(1);
      expect(w.sent.every((s) => s.type === NOTICE_BUDGET_100)).toBe(true);
      expect(w.sent[0].payload).toMatchObject({ severity: "critical", threshold: 100 });
      expect((await ledger(w.id)).map((l) => l.threshold)).toEqual([80, 100]);
      expect(await runCompanyAlerts(w.id, NOW, { notify: w.notify })).toEqual({ budgetNotices: 0, runawayNotices: 0 });
    });

    it("a unit that jumps straight past 100 percent is told at each threshold it crossed, once each", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "1");
      await cost(w.id, "5", { user_id: w.person, unit_node_id: "d-web" });
      const r = await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(r.budgetNotices).toBe(2);
      expect([...new Set(w.sent.map((s) => s.type))].sort()).toEqual([NOTICE_BUDGET_100, NOTICE_BUDGET_80].sort());
      expect((await ledger(w.id)).map((l) => l.threshold)).toEqual([80, 100]);
    });

    it("under 80 percent sends nothing and writes no ledger row; just under 80 is under", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "10");
      await cost(w.id, "7.99999999", { user_id: w.person, unit_node_id: "d-web" });
      expect(await runCompanyAlerts(w.id, NOW, { notify: w.notify })).toEqual({ budgetNotices: 0, runawayNotices: 0 });
      expect(w.sent).toEqual([]);
      expect(await ledger(w.id)).toEqual([]);
    });

    it("the company figure notifies exactly the owners and the GM, not the heads", async () => {
      const w = await world();
      await budget(w.id, "company", null, "10");
      await cost(w.id, "9", { user_id: w.person, unit_node_id: "d-web" });
      await cost(w.id, "0.5"); // no person, no unit: it still counts toward the company
      const r = await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(r.budgetNotices).toBe(1);
      expect(toSet(w.sent)).toEqual(ids(w.owner, w.owner2, w.gm));
      expect(w.sent.every((s) => s.type === NOTICE_BUDGET_80 && s.payload.href === "/ai-usage" && s.payload.scope === "company")).toBe(true);
      expect(await ledger(w.id)).toEqual([{ kind: "company_budget", subject: "", period: "2026-09", threshold: 80 }]);
      await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(w.sent).toHaveLength(3);
    });

    it("a unit counts its whole subtree, and never another company's rows with the same node id", async () => {
      const w = await world();
      const other = await world();
      await budget(w.id, "unit", "d-web", "10");
      await cost(w.id, "4", { user_id: w.person, unit_node_id: "d-web" });
      await cost(w.id, "4", { user_id: w.person, unit_node_id: "dv-fe" }); // the division adds to its department
      await cost(other.id, "50", { user_id: other.person, unit_node_id: "d-web" });
      expect((await runCompanyAlerts(w.id, NOW, { notify: w.notify })).budgetNotices).toBe(1); // 8 of 10
      await budget(other.id, "unit", "d-seo", "1000");
      expect(await runCompanyAlerts(other.id, NOW, { notify: other.notify })).toEqual({ budgetNotices: 0, runawayNotices: 0 });
    });

    it("unknown cost never crosses a budget; a row outside the month does not count", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "1");
      await row(w.id, { user_id: w.person, unit_node_id: "d-web", occurred_at: "2026-09-03T08:00:00Z" }); // no cost
      await row(w.id, { user_id: w.person, unit_node_id: "d-web", occurred_at: "2026-08-31T23:59:59Z", cost_usd: "99", cost_source: "provider" });
      expect(await runCompanyAlerts(w.id, NOW, { notify: w.notify })).toEqual({ budgetNotices: 0, runawayNotices: 0 });
    });

    it("the next month notifies again (the ledger is keyed by month)", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "1");
      await cost(w.id, "0.9", { user_id: w.person, unit_node_id: "d-web" });
      await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      const first = w.sent.length;
      expect(first).toBe(4);
      await row(w.id, { user_id: w.person, unit_node_id: "d-web", occurred_at: "2026-10-02T08:00:00Z", cost_usd: "0.9", cost_source: "provider" });
      await runCompanyAlerts(w.id, new Date("2026-10-03T12:00:00Z"), { notify: w.notify });
      expect(w.sent.length).toBe(first * 2);
      expect((await ledger(w.id)).map((l) => l.period)).toEqual(["2026-09", "2026-10"]);
    });

    it("report mode changes nothing else: the budget rows are untouched, and a soft_stop unit is only notified", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "1", "soft_stop");
      await budget(w.id, "company", null, "2");
      await cost(w.id, "5", { user_id: w.person, unit_node_id: "d-web" });
      const snap = async () => (await q().query(`SELECT scope, unit_node_id, monthly_usd::text, mode, stop_lifted_month, updated_by, updated_at FROM ai_budgets WHERE tenant_id = $1 ORDER BY scope`, [w.id])).rows;
      const before = await snap();
      const acts = async () => (await q().query(`SELECT count(*)::int AS n FROM activities WHERE tenant_id = $1`, [w.id])).rows[0].n;
      const a0 = await acts();
      await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(await snap()).toEqual(before);
      expect(await acts()).toBe(a0);
      expect(w.sent.length).toBeGreaterThan(0);
    });

    it("a company with no budget and no runaway sends nothing and writes nothing", async () => {
      const w = await world();
      await cost(w.id, "1000", { user_id: w.person, unit_node_id: "d-web" });
      expect(await runCompanyAlerts(w.id, NOW, { notify: w.notify })).toEqual({ budgetNotices: 0, runawayNotices: 0 });
      expect(w.sent).toEqual([]);
      expect(await ledger(w.id)).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════ RUNAWAY ═══════════════════════════
  describe("runaway", () => {
    it("names the person with today's calls and the usual figure, to exactly the owners and the IT seat, once per day", async () => {
      const w = await world();
      await history(w.id, w.person, 7, 10);
      await calls(w.id, w.person, "2026-09-20", 60);
      const r = await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(r).toEqual({ budgetNotices: 0, runawayNotices: 1 });
      expect(toSet(w.sent)).toEqual(ids(w.owner, w.owner2, w.it));
      expect(w.sent.every((s) => s.type === NOTICE_RUNAWAY_PERSON)).toBe(true);
      const p = w.sent[0].payload;
      expect(p.title).toContain("Pia Person");
      expect(p.body).toBe("Pia Person made 60 AI calls today; the usual is about 10 a day.");
      expect(p).toMatchObject({ day: "2026-09-20", calls: 60, usualDaily: 10, entityType: "ai_usage_person", entityId: w.person });
      expect(JSON.stringify(p)).not.toMatch(/cost|\$|usd/i);
      expect(await ledger(w.id)).toEqual([{ kind: "runaway_person", subject: w.person, period: "2026-09-20", threshold: 500 }]);
      await Promise.all([runCompanyAlerts(w.id, NOW, { notify: w.notify }), runCompanyAlerts(w.id, NOW, { notify: w.notify })]);
      expect(w.sent).toHaveLength(3);
      // the next UTC day is a new day: another runaway notifies again
      await calls(w.id, w.person, "2026-09-21", 100);
      await runCompanyAlerts(w.id, new Date("2026-09-21T12:00:00Z"), { notify: w.notify });
      expect(w.sent).toHaveLength(6);
    });

    it("sums every surface for a person", async () => {
      const w = await world();
      await history(w.id, w.person, 7, 4, { surface: "knowledge", capability: "embed" });
      await calls(w.id, w.person, "2026-09-20", 12, { surface: "knowledge", capability: "embed" });
      await calls(w.id, w.person, "2026-09-20", 12, { surface: "assistant" });
      expect((await runCompanyAlerts(w.id, NOW, { notify: w.notify })).runawayNotices).toBe(1); // 24 today vs a usual of 4
    });

    it("the exact edges: 5x yes, just under no; 6 active days no; 19 calls no; days with no calls do not dilute the average", async () => {
      const w = await world();
      const exact = await createUser(`exact-${counter}@aialerts.test`, "Exa Ct");
      const under = await createUser(`under-${counter}@aialerts.test`, "Und Er");
      const sixDays = await createUser(`six-${counter}@aialerts.test`, "Six Days");
      const nineteen = await createUser(`nineteen-${counter}@aialerts.test`, "Nine Teen");
      const sparse = await createUser(`sparse-${counter}@aialerts.test`, "Spa Rse");
      for (const u of [exact, under, sixDays, nineteen, sparse]) await addMembership(w.id, u);
      await history(w.id, exact, 8, 10); await calls(w.id, exact, "2026-09-20", 50); // exactly 5x
      await history(w.id, under, 8, 10); await calls(w.id, under, "2026-09-20", 49); // just under
      await history(w.id, sixDays, 6, 1); await calls(w.id, sixDays, "2026-09-20", 500); // 6 active days
      await history(w.id, nineteen, 14, 1); await calls(w.id, nineteen, "2026-09-20", 19); // 19x but under 20 calls
      // 7 active days of 10 calls spread over the 14 (every second day): over ACTIVE days the usual is 10, over all 14 days it would be 5
      for (const d of [1, 3, 5, 7, 9, 11, 13]) await calls(w.id, sparse, new Date(Date.UTC(2026, 8, 20 - d)).toISOString().slice(0, 10), 10);
      await calls(w.id, sparse, "2026-09-20", 25); // 2.5x of 10, 5x of 5
      await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      const named = [...new Set(w.sent.filter((s) => s.type === NOTICE_RUNAWAY_PERSON).map((s) => s.payload.entityId))];
      expect(named).toEqual([exact]);
    });

    it("history older than 14 days, and today's own calls, are not the baseline", async () => {
      const w = await world();
      await history(w.id, w.person, 6, 10); // 6 active days in the window
      await calls(w.id, w.person, "2026-09-05", 10); // 15 days ago: outside the window, does not make a 7th active day
      await calls(w.id, w.person, "2026-09-20", 200);
      expect((await runCompanyAlerts(w.id, NOW, { notify: w.notify })).runawayNotices).toBe(0);
    });

    it("an agent is judged the same way, by `task`, and named; the IT seat and the owners are told", async () => {
      const w = await world();
      await history(w.id, null, 7, 4, { surface: "agent", capability: "llm", task: "seo-writer" });
      await calls(w.id, null, "2026-09-20", 25, { surface: "agent", capability: "llm", task: "seo-writer" });
      await history(w.id, null, 7, 4, { surface: "agent", capability: "llm", task: "calm-agent" });
      await calls(w.id, null, "2026-09-20", 8, { surface: "agent", capability: "llm", task: "calm-agent" });
      const r = await runCompanyAlerts(w.id, NOW, { notify: w.notify });
      expect(r.runawayNotices).toBe(1);
      expect(w.sent.every((s) => s.type === NOTICE_RUNAWAY_AGENT)).toBe(true);
      expect(toSet(w.sent)).toEqual(ids(w.owner, w.owner2, w.it));
      expect(w.sent[0].payload).toMatchObject({ agent: "seo-writer", calls: 25, usualDaily: 4 });
      expect(w.sent[0].payload.body).toBe("The agent seo-writer ran 25 times today; the usual is about 4 a day.");
      expect(await ledger(w.id)).toEqual([{ kind: "runaway_agent", subject: "seo-writer", period: "2026-09-20", threshold: 500 }]);
    });

    it("another company's calls never count toward a person's baseline", async () => {
      const w = await world();
      const other = await world();
      await history(other.id, w.person, 7, 100); // the SAME user's heavy history in another company
      await calls(w.id, w.person, "2026-09-20", 60);
      await history(w.id, w.person, 7, 10);
      expect((await runCompanyAlerts(w.id, NOW, { notify: w.notify })).runawayNotices).toBe(1);
    });
  });

  // ═══════════════════════════════════════════ SWEEP ═══════════════════════════
  describe("the sweep", () => {
    it("one company's failure is logged and never stops the next; the job never throws", async () => {
      const bad = await world();
      const good = await world();
      await budget(bad.id, "unit", "d-web", "1");
      await cost(bad.id, "5", { user_id: bad.person, unit_node_id: "d-web" });
      await budget(good.id, "unit", "d-web", "1");
      await cost(good.id, "5", { user_id: good.person, unit_node_id: "d-web" });
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const sent: Sent[] = [];
      const notify = makeNotify(sent);
      const r = await runUsageAlertsSweep(NOW, {
        notify,
        runCompany: (tenantId, now, deps) => {
          if (tenantId === bad.id) throw new Error("boom");
          return runCompanyAlerts(tenantId, now, deps);
        },
      });
      expect(r.errors).toBe(1);
      expect(r.skippedLocked).toBe(false);
      expect(sent.filter((s) => s.tenant === good.id).length).toBeGreaterThan(0);
      expect(sent.filter((s) => s.tenant === bad.id)).toEqual([]);
      expect(err.mock.calls.some((c) => String(c[0]).includes(bad.id))).toBe(true);
      err.mockRestore();
    });

    it("a sweep that cannot take the advisory lock does nothing", async () => {
      const holder = await q().connect();
      try {
        const got = await holder.query(`SELECT pg_try_advisory_lock($1, $2) AS ok`, [USAGE_ALERTS_LOCK_NS, USAGE_ALERTS_LOCK_KEY]);
        expect(got.rows[0].ok).toBe(true);
        const run = vi.fn();
        const r = await runUsageAlertsSweep(NOW, { runCompany: run });
        expect(r.skippedLocked).toBe(true);
        expect(r.companies).toBe(0);
        expect(run).not.toHaveBeenCalled();
      } finally {
        await holder.query(`SELECT pg_advisory_unlock($1, $2)`, [USAGE_ALERTS_LOCK_NS, USAGE_ALERTS_LOCK_KEY]);
        holder.release();
      }
      // and it runs again once the lock is free
      expect((await runUsageAlertsSweep(NOW, { runCompany: async () => ({ budgetNotices: 0, runawayNotices: 0 }) })).skippedLocked).toBe(false);
    });

    it("a failed notice is logged and the other recipients are still told", async () => {
      const w = await world();
      await budget(w.id, "unit", "d-web", "1");
      await cost(w.id, "5", { user_id: w.person, unit_node_id: "d-web" });
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const sent: Sent[] = [];
      const flaky = vi.fn(async (tenant: string, to: string | null, actor: string | null, type: string, payload: Record<string, unknown> = {}) => {
        if (to === w.head) throw new Error("mail down");
        sent.push({ tenant, to, actor, type, payload });
      });
      await expect(runCompanyAlerts(w.id, NOW, { notify: flaky })).resolves.toBeDefined();
      expect(toSet(sent)).toEqual(ids(w.head2, w.owner, w.owner2));
      err.mockRestore();
    });
  });
});
