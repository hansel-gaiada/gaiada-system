// PV1-06a — group reads for the owner of a root (PV-D19, PV-D20), through the REAL HTTP surface,
// against live Postgres + RLS + a live Cerbos. Three reads, four principals:
//
//   reads:      GET /api/rollups · GET /api/:t/reports/document?grain=company · GET /api/:t/reports/group
//   rootOwner   `owner` on the root AND on both children (the seed's shape, owner-grant.ts)
//   childOwner  `owner` on child A only — owns a company in the tree, but not the root
//   member      `member` on the root
//   admin       `platform_admin` (global)
//
// ⚠ POSITIVE CONTROLS FIRST. Every 403/404 below is paired with a principal that gets 200 on the
// same route, so no denial can pass because the route or the fixture is broken.
//
// ⚠ Needs DATABASE_URL_TEST *and* a live Cerbos running the policies from THIS tree. Cerbos does not
// hot-reload: restart it after a policy change, or every owner case reads as a 403 logic bug. It
// skips silently without DATABASE_URL_TEST — a skipped run proves nothing. Check the skip count.
//
// Fixture shape (tasks → work_activity → recomputeFactWindow) copied from document-builder.db.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { recomputeFactWindow } from "./fact-job";
import { syncMetricDefinitions } from "../../rollups/engine";
import type { ReportDocument } from "./report-document";
import type { GroupReport } from "./group-report";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MONTH = "periodKind=month&start=2026-07-16";

describe.skipIf(!TEST_URL)("PV1-06a · group reads for the owner of a root (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let root: string;
  let childA: string;
  let childB: string;
  let rootOwner: string;
  let childOwner: string;
  let member: string;
  let admin: string;

  /** One worker per company completing `n` on-time tasks in July 2026, then the fact fabric rebuilt. */
  async function seedWork(tenantId: string, label: string, n: number): Promise<void> {
    const worker = await createUser(`worker-${label}@pv106a.test`);
    await addMembership(tenantId, worker);
    await grantRole(worker, await createRole("member"), "company", tenantId);
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'central')`, [
        tenantId,
        JSON.stringify({ root: { id: "co-root", kind: "company", name: label, children: [{ id: "d-ops", kind: "department", name: "Ops", children: [] }] } }),
      ]),
    );
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,'d-ops',true,'2026-01-01'::date,'manual','central')`,
        [newId(), tenantId, worker],
      ),
    );
    const projectId = await createProject(tenantId, `${label} project`);
    for (let i = 0; i < n; i++) {
      const day = `2026-07-0${i + 1}`;
      const taskId = newId();
      await withTenants([tenantId], async (c) => {
        await c.query(
          `INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site)
           VALUES ($1,$2,$3,'task',$4::date,60,'central')`,
          [taskId, tenantId, projectId, day],
        );
        await c.query(
          `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from)
           VALUES ($1,$2,$3,'owner','person',$4,$5,'central','2026-01-01'::date)`,
          [newId(), tenantId, taskId, worker, worker],
        );
        await c.query(
          `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
           VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,$6::timestamptz,'central')`,
          [newId(), tenantId, `ev-${newId()}`, worker, taskId, `${day}T10:00:00Z`],
        );
      });
    }
    await recomputeFactWindow(tenantId, "2026-07-01", "2026-07-31");
  }

  const get = async (url: string, as: string) => {
    const r = await app.inject({ method: "GET", url, headers: asUser(as) });
    return { status: r.statusCode, body: r.body, json: () => r.json() };
  };
  const companyReport = (tenantId: string, as: string) => get(`/api/${tenantId}/reports/document?grain=company&${MONTH}`, as);
  const groupReport = (tenantId: string, as: string) => get(`/api/${tenantId}/reports/group?${MONTH}`, as);
  const rollups = (as: string) => get(`/api/rollups?period=2026-07-16`, as);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    root = await createCompany("PV106a Holding", ["reports", "pm", "hr"]);
    childA = await createCompany("PV106a Agency", ["reports", "pm", "hr"], root);
    childB = await createCompany("PV106a Resort", ["reports", "pm", "hr"], root);

    const ownerRole = await createRole("owner");
    rootOwner = await createUser("root-owner@pv106a.test");
    for (const co of [root, childA, childB]) {
      await addMembership(co, rootOwner);
      await grantRole(rootOwner, ownerRole, "company", co);
    }
    childOwner = await createUser("child-owner@pv106a.test");
    await addMembership(childA, childOwner);
    await grantRole(childOwner, ownerRole, "company", childA);
    member = await createUser("member@pv106a.test");
    await addMembership(root, member);
    await grantRole(member, await createRole("member"), "company", root);
    admin = await createUser("admin@pv106a.test");
    await grantRole(admin, await createRole("platform_admin"), "global", null);

    // MON-00a anchors: rootCompanies comes from home_company_id first, and GET /api/rollups resolves
    // its tenant from it. The child-only owner is anchored on ITS company, the realistic shape.
    const pool = adminPool();
    for (const [u, co] of [[rootOwner, root], [childOwner, childA], [member, root], [admin, root]] as const) {
      await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);
    }

    await seedWork(root, "holding", 1);
    await seedWork(childA, "agency", 2);
    await seedWork(childB, "resort", 3);

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ positive controls ═══════════════════════════════

  describe("the root owner", () => {
    it("reads the group rollups of its own root", async () => {
      const r = await rollups(rootOwner);
      expect(r.status, r.body).toBe(200);
      expect(Array.isArray(r.json())).toBe(true);
    });

    it("reads each company's Company Report", async () => {
      for (const co of [root, childA, childB]) {
        const r = await companyReport(co, rootOwner);
        expect(r.status, `${co}: ${r.body}`).toBe(200);
      }
    });

    it("reads the group report: three cards, root first, figures equal to each Company Report, correct sums", async () => {
      const r = await groupReport(root, rootOwner);
      expect(r.status, r.body).toBe(200);
      const g = r.json() as GroupReport;

      expect(g.rootCompanyId).toBe(root);
      expect(g).toMatchObject({ periodKind: "month", start: "2026-07-01", end: "2026-07-31" });
      // Root first, then by name ("Agency" < "Resort").
      expect(g.companies.map((c) => c.companyId)).toEqual([root, childA, childB]);
      expect(g.companies.map((c) => c.name)).toEqual(["PV106a Holding", "PV106a Agency", "PV106a Resort"]);
      for (const c of g.companies) expect(c.vertical).toBe("general");

      // Each card is the company's own report, not a re-computation.
      const completedOf = (figs: { metricKey: string; value: number }[] | null) => figs!.find((f) => f.metricKey === "delivery.tasks_completed")!.value;
      expect(g.companies.map((c) => completedOf(c.figures))).toEqual([1, 2, 3]);
      for (const c of g.companies) {
        const own = (await companyReport(c.companyId, rootOwner)).json() as ReportDocument;
        const ownValue = own.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!.value;
        expect(completedOf(c.figures), c.name).toBe(ownValue);
      }

      // Sum of companies: counts add up...
      const sum = (key: string) => g.sumOfCompanies.find((s) => s.metricKey === key);
      expect(sum("delivery.tasks_completed")).toMatchObject({ value: 6, companyCount: 3 });
      const throughput = g.companies.reduce((n, c) => n + c.figures!.find((f) => f.metricKey === "delivery.throughput_weighted")!.value, 0);
      expect(throughput).toBeGreaterThan(0);
      expect(sum("delivery.throughput_weighted")?.value).toBe(throughput);
      // ...and a ratio is never added: three 100% on-time rates must not become a 300% "sum".
      const onTime = g.companies.map((c) => c.figures!.find((f) => f.metricKey === "delivery.on_time_rate")!);
      for (const f of onTime) expect(f).toMatchObject({ additive: false, value: 1 });
      expect(sum("delivery.on_time_rate")).toBeUndefined();
      expect(sum("evidence.source_diversity")).toBeUndefined();
      for (const s of g.sumOfCompanies) {
        const card = g.companies[0].figures!.find((f) => f.metricKey === s.metricKey)!;
        expect(card.additive, s.metricKey).toBe(true);
        expect(card.unit, s.metricKey).not.toBe("percent");
      }

      expect(g.consolidated).toBeNull();
      expect(g.consolidatedReason).toBe("needs F9 eliminations");
    });

    it("gets 404 when the id is a child, not a root (Cerbos allows it; the root check stops it)", async () => {
      const r = await groupReport(childA, rootOwner);
      expect(r.status, r.body).toBe(404);
    });

    it("authorizes before validating: a missing periodKind is a 400 for the owner", async () => {
      const r = await get(`/api/${root}/reports/group`, rootOwner);
      expect(r.status).toBe(400);
    });
  });

  describe("platform_admin", () => {
    it("reads the group report and the rollups", async () => {
      const g = await groupReport(root, admin);
      expect(g.status, g.body).toBe(200);
      expect((g.json() as GroupReport).companies).toHaveLength(3);
      expect((await rollups(admin)).status).toBe(200);
    });

    it("gets 404 for a child id and for an id that is not a company at all", async () => {
      expect((await groupReport(childB, admin)).status).toBe(404);
      expect((await groupReport("not-a-uuid", admin)).status).toBe(404);
      expect((await groupReport(newId(), admin)).status).toBe(404);
    });
  });

  // ═══════════════════════════════ denials ═══════════════════════════════

  describe("the owner of a CHILD only (owns a company in the tree, not the root)", () => {
    it("🔴 is refused the group report of the root (403)", async () => {
      const r = await groupReport(root, childOwner);
      expect(r.status, r.body).toBe(403);
      expect(r.body).not.toContain("PV106a Resort");
    });

    it("🔴 is refused the group rollups", async () => {
      const r = await rollups(childOwner);
      expect(r.status, r.body).toBe(403);
    });

    it("reads its own company's Company Report but not the root's", async () => {
      expect((await companyReport(childA, childOwner)).status).toBe(200);
      expect((await companyReport(root, childOwner)).status).toBe(403);
    });

    it("gets 404, not a group report, when it names its own child as the root", async () => {
      expect((await groupReport(childA, childOwner)).status).toBe(404);
    });
  });

  describe("a plain member", () => {
    it("🔴 is refused all three reads", async () => {
      expect((await rollups(member)).status).toBe(403);
      expect((await companyReport(root, member)).status).toBe(403);
      expect((await groupReport(root, member)).status).toBe(403);
    });

    it("gets 403, not 400, on a malformed group request — authz comes first", async () => {
      expect((await get(`/api/${root}/reports/group`, member)).status).toBe(403);
    });
  });
});
