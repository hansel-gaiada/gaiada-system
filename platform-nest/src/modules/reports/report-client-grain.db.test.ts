// PV7-01 — the client grain in reports (docs/FRONTEND-BFF-CONTRACT.md §53, PERMISSION-CONTRACT §45),
// against LIVE Postgres + real RLS + real Cerbos. Runs on the Linux CI gate only (no Docker on the laptop).
//
// Part A is the GOLDEN TABLE: two clients, five eligible and ineligible projects between them, hand-computed
// expectations. It proves:
//   * additive KPIs equal the sum of the client's projects;
//   * every ratio is Sum(numerator) / Sum(denominator), and the fixture is built so that this DIFFERS from the
//     mean of the per-project ratios (an average-of-averages cannot pass);
//   * flow.wip_open_avg keeps the range's day count (7), not 7 per project;
//   * discipline.overdue_open is a point-in-time count summed across projects;
//   * internal work is absent in all four shapes: an internal PROJECT under a real client, a project under the
//     sentinel INTERNAL client, a soft-deleted project, and non-project work;
//   * the routes (document, overview, metrics, export) and the access check around them.
// Part B is the MOVED PROJECT: a month is sealed, a project then moves to another client; the sealed document keeps
// the old attribution, a live range shows the new one; and the seal made no AI call for a client document (L2).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createClient, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { computeReportRangeRows } from "./document-builder";
import { ensureCalendarPeriodRows } from "./report-periods";
import { sealPeriod } from "./report-seal";
import type { ReportDocument, ReportKpi } from "./report-document";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface FactInput {
  tc?: number; // tasks_completed
  onTime?: number; // tasks_completed_on_time
  withDue?: number; // tasks_completed_with_due_date
  est?: number; // estimate_minutes_completed
  reopened?: number;
  logged?: number; // minutes_logged
}

describe.skipIf(!TEST_URL)("PV7-01 client grain (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;

  // ════════════════════════════ Part A — the golden table ════════════════════════════
  const START = "2026-07-13"; // Monday
  const END = "2026-07-19"; // Sunday, 7 inclusive days
  const FACT_DAY = "2026-07-14";

  let co: string;
  let admin: string; // company_admin
  let member: string; // company-scope member: reads the same documents as read_project
  let nobody: string; // a membership with no role: refused
  let acme: string;
  let birch: string;
  let hq: string; // the sentinel internal client
  let a1: string;
  let a2: string;
  let b1: string;
  let ai: string; // an INTERNAL project under a real client (acme)
  let a3: string; // a SOFT-DELETED project under acme
  let h1: string; // a normal project under the sentinel internal client

  async function addFact(projectId: string | null, f: FactInput): Promise<void> {
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO report_work_facts (id, tenant_id, fact_date, project_id, tasks_completed, tasks_completed_on_time, tasks_completed_with_due_date,
                                          estimate_minutes_completed, tasks_reopened, minutes_logged, origin_site)
           VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,'central')`,
          [newId(), co, FACT_DAY, projectId, f.tc ?? 0, f.onTime ?? 0, f.withDue ?? 0, f.est ?? 0, f.reopened ?? 0, f.logged ?? 0],
        ),
      { modules: ["reports"] },
    );
  }
  async function addMilestones(projectId: string, due: number, done: number): Promise<void> {
    for (let i = 0; i < due; i++) {
      await withTenants([co], (c) =>
        c.query(`INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site) VALUES ($1,$2,$3,$4,'2026-07-15'::date,$5,'central')`, [
          newId(),
          co,
          projectId,
          `m${i}`,
          i < done ? "done" : "open",
        ]),
      );
    }
  }
  async function addSnapshots(projectId: string, days: string[], open: number, progress: number): Promise<void> {
    for (const d of days) {
      await withTenants([co], (c) =>
        c.query(`INSERT INTO pm_progress_snapshots (tenant_id, project_id, snapshot_date, open_count, done_count, avg_progress, origin_site) VALUES ($1,$2,$3::date,$4,0,$5,'central')`, [
          co,
          projectId,
          d,
          open,
          progress,
        ]),
      );
    }
  }
  async function addOverdue(projectId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await withTenants([co], (c) =>
        c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, origin_site) VALUES ($1,$2,$3,'late','2026-07-01'::date,'central')`, [newId(), co, projectId]),
      );
    }
  }

  const docUrl = (tenant: string, params: Record<string, string>) => `/api/${tenant}/reports/document?${new URLSearchParams(params).toString()}`;
  const getDoc = (tenant: string, params: Record<string, string>, as: string) => app.inject({ method: "GET", url: docUrl(tenant, params), headers: asUser(as) });
  const kpi = (doc: ReportDocument, key: string): ReportKpi => {
    const k = doc.kpis.find((x) => x.metricKey === key);
    expect(k, `kpi ${key} present`).toBeTruthy();
    return k!;
  };
  const clientRow = (rows: Awaited<ReturnType<typeof computeReportRangeRows>>, key: string, clientId: string) =>
    rows.find((r) => r.metricKey === key && (r.dimensions ?? {}).clientId === clientId);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("PV7-01 Co", ["reports", "pm", "hr"]);
    admin = await createUser("admin@pv701.test");
    member = await createUser("member@pv701.test");
    nobody = await createUser("nobody@pv701.test");
    for (const u of [admin, member, nobody]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);

    acme = await createClient(co, "Acme Hospitality");
    birch = await createClient(co, "Birch Resorts");
    hq = await createClient(co, "Gaiada Internal");
    await withTenants([co], (c) => c.query(`UPDATE clients SET is_internal = true WHERE id = $1 AND tenant_id = $2`, [hq, co]));

    a1 = await createProject(co, "Acme site", undefined, acme);
    a2 = await createProject(co, "Acme app", undefined, acme);
    b1 = await createProject(co, "Birch site", undefined, birch);
    ai = await createProject(co, "Acme internal tooling", undefined, acme);
    a3 = await createProject(co, "Acme old", undefined, acme);
    h1 = await createProject(co, "HQ site", undefined, hq);
    await withTenants([co], async (c) => {
      await c.query(`UPDATE projects SET is_internal = true WHERE id = $1 AND tenant_id = $2`, [ai, co]);
      await c.query(`UPDATE projects SET deleted_at = now() WHERE id = $1 AND tenant_id = $2`, [a3, co]);
    });

    // Facts. The ratios are chosen so Sum/Sum differs from the mean of the per-project ratios:
    //   acme on-time  = (6+4)/(8+4) = 10/12 = 0.8333   vs mean(6/8, 4/4) = 0.875
    //   acme reopen   = (1+0)/(10+4) = 1/14 = 0.0714   vs mean(1/10, 0/4) = 0.05
    await addFact(a1, { tc: 10, onTime: 6, withDue: 8, est: 300, reopened: 1, logged: 100 });
    await addFact(a2, { tc: 4, onTime: 4, withDue: 4, est: 120, reopened: 0, logged: 50 });
    await addFact(b1, { tc: 6, onTime: 1, withDue: 2, est: 90, reopened: 3, logged: 70 });
    // Everything below must be ABSENT from every client figure.
    await addFact(ai, { tc: 100, onTime: 0, withDue: 50, est: 9999, reopened: 20, logged: 999 }); // internal project
    await addFact(a3, { tc: 55, onTime: 5, withDue: 55, est: 5555, reopened: 5, logged: 555 }); // deleted project
    await addFact(h1, { tc: 77, onTime: 7, withDue: 70, est: 7777, reopened: 5, logged: 777 }); // sentinel internal client
    await addFact(null, { tc: 33, est: 3333, logged: 333 }); // non-project work

    // Milestones due in range: acme 2/3 done (mean of rates would be 0.75), birch 0/1.
    await addMilestones(a1, 2, 1);
    await addMilestones(a2, 1, 1);
    await addMilestones(b1, 1, 0);
    await addMilestones(ai, 5, 5);
    await addMilestones(h1, 2, 2);

    // Flow snapshots. acme: a1 3 days x 4 open (avg progress 50), a2 2 days x 2 open (avg 80).
    //   wip_open_avg = 16 open-days over the 7-day range (NOT 16/14); avg_progress = (600+320)/16 = 57.5 (a mean of 50 and 80 is 65).
    await addSnapshots(a1, ["2026-07-13", "2026-07-14", "2026-07-15"], 4, 50);
    await addSnapshots(a2, ["2026-07-13", "2026-07-14"], 2, 80);
    await addSnapshots(b1, ["2026-07-13"], 5, 20);
    await addSnapshots(ai, ["2026-07-13", "2026-07-14"], 9, 10);

    // Overdue (open, due before the range end): acme 2 + 1, birch 1; the internal project's 3 must not count.
    await addOverdue(a1, 2);
    await addOverdue(a2, 1);
    await addOverdue(b1, 1);
    await addOverdue(ai, 3);

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  describe("the golden table: client rows are sums over eligible projects", () => {
    it("emits rows for exactly the two real clients, and none for the sentinel client or the internal-only shapes", async () => {
      const rows = await computeReportRangeRows(co, START, END);
      const clientIds = new Set(rows.filter((r) => "clientId" in (r.dimensions ?? {})).map((r) => String(r.dimensions!.clientId)));
      expect(clientIds).toEqual(new Set([acme, birch]));
    });

    it("additive KPIs equal the sum of the client's projects (internal, deleted, sentinel and project-less work excluded)", async () => {
      const rows = await computeReportRangeRows(co, START, END);
      expect(clientRow(rows, "delivery.tasks_completed", acme)!.numerator).toBe(14); // 10 + 4, not + 100 / + 55
      expect(clientRow(rows, "delivery.throughput_weighted", acme)!.numerator).toBe(420); // 300 + 120
      expect(clientRow(rows, "effort.minutes_logged", acme)!.numerator).toBe(150); // 100 + 50
      expect(clientRow(rows, "delivery.tasks_completed", birch)!.numerator).toBe(6);
      expect(clientRow(rows, "effort.minutes_logged", birch)!.numerator).toBe(70);
    });

    it("every ratio is Sum(numerator)/Sum(denominator), and differs from the mean of the per-project ratios", async () => {
      const rows = await computeReportRangeRows(co, START, END);
      const onTime = clientRow(rows, "delivery.on_time_rate", acme)!;
      expect([onTime.numerator, onTime.denominator]).toEqual([10, 12]);
      expect(onTime.numerator / onTime.denominator!).toBeCloseTo(0.8333, 3);
      expect(onTime.numerator / onTime.denominator!).not.toBeCloseTo((6 / 8 + 4 / 4) / 2, 3); // 0.875

      const reopen = clientRow(rows, "flow.reopen_rate", acme)!;
      expect([reopen.numerator, reopen.denominator]).toEqual([1, 14]);
      expect(reopen.numerator / reopen.denominator!).not.toBeCloseTo((1 / 10 + 0 / 4) / 2, 3); // 0.05

      const milestones = clientRow(rows, "delivery.milestone_hit_rate", acme)!;
      expect([milestones.numerator, milestones.denominator]).toEqual([2, 3]); // not the internal project's 5/5
      expect(milestones.numerator / milestones.denominator!).not.toBeCloseTo((1 / 2 + 1 / 1) / 2, 3); // 0.75
      expect([clientRow(rows, "delivery.milestone_hit_rate", birch)!.numerator, clientRow(rows, "delivery.milestone_hit_rate", birch)!.denominator]).toEqual([0, 1]);

      const progress = clientRow(rows, "flow.avg_progress", acme)!;
      expect([progress.numerator, progress.denominator]).toEqual([920, 16]); // (50*4*3 + 80*2*2) / (12 + 4)
    });

    it("flow.wip_open_avg keeps the range's day count (7) as its denominator, never 7 per project", async () => {
      const rows = await computeReportRangeRows(co, START, END);
      const wip = clientRow(rows, "flow.wip_open_avg", acme)!;
      expect(wip.numerator).toBe(16); // 12 + 4 open-days; the internal project's 18 is absent
      expect(wip.denominator).toBe(7);
      expect(clientRow(rows, "flow.wip_open_avg", birch)!.denominator).toBe(7);
      expect(clientRow(rows, "flow.blocked_share", acme)!.denominator).toBe(16);
    });

    it("discipline.overdue_open is a point-in-time count summed across the client's projects, excluding internal work", async () => {
      const rows = await computeReportRangeRows(co, START, END);
      const overdue = clientRow(rows, "discipline.overdue_open", acme)!;
      expect(overdue.numerator).toBe(3); // 2 + 1, not + the internal project's 3
      expect(overdue.denominator).toBeUndefined();
      expect(clientRow(rows, "discipline.overdue_open", birch)!.numerator).toBe(1);
      // a 1-day range ending on the same date reports the same count: it is never multiplied by the day count
      const oneDay = await computeReportRangeRows(co, END, END);
      expect(clientRow(oneDay, "discipline.overdue_open", acme)!.numerator).toBe(3);
    });

    it("the project grain is unchanged: the internal project keeps its own row", async () => {
      const rows = await computeReportRangeRows(co, START, END);
      const internal = rows.find((r) => r.metricKey === "delivery.tasks_completed" && (r.dimensions ?? {}).projectId === ai);
      expect(internal!.numerator).toBe(100);
    });
  });

  describe("GET /reports/document?grain=client", () => {
    const params = (clientId: string): Record<string, string> => ({ grain: "client", scopeRef: clientId, periodKind: "custom", start: START, end: END });

    it("returns the client's ReportDocument: header, the project grain's KPIs (never source_diversity), the sums, a Projects table", async () => {
      const r = await getDoc(co, params(acme), admin);
      expect(r.statusCode).toBe(200);
      const doc = r.json() as ReportDocument;
      expect(doc.header.grain).toBe("client");
      expect(doc.header.scopeRef).toBe(acme);
      expect(doc.header.scopeName).toBe("Acme Hospitality");
      expect(doc.header.sealed).toBe(false);
      expect(doc.kpis).toHaveLength(16);
      expect(doc.kpis.map((k) => k.metricKey)).not.toContain("evidence.source_diversity");

      expect(kpi(doc, "delivery.tasks_completed").value).toBe(14);
      const onTime = kpi(doc, "delivery.on_time_rate");
      expect([onTime.numerator, onTime.denominator]).toEqual([10, 12]);
      expect(onTime.value).toBeCloseTo(10 / 12, 6);
      const wip = kpi(doc, "flow.wip_open_avg");
      expect(wip.denominator).toBe(7);
      const overdue = kpi(doc, "discipline.overdue_open");
      expect(overdue.value).toBe(3);
      expect(overdue.pointInTime).toBe(true);

      const projects = doc.tables.find((t) => t.key === "client_projects");
      expect(projects, "client_projects table").toBeTruthy();
      expect(projects!.rows.map((row) => row.project).sort()).toEqual(["Acme app", "Acme site"]); // not the internal or deleted ones
      expect(projects!.totalRow).toMatchObject({ throughput: 420, tasksCompleted: 14 });
      expect(doc.narrative.source).toBe("deterministic");
    });

    it("PV7-05: a client with milestones but NO work facts still lists its eligible projects, with 0 figures (never an absent table)", async () => {
      // Built here and soft-deleted at the end, so the golden-table tests above and below never see this client.
      const cedar = await createClient(co, "Cedar Lodges");
      const c1 = await createProject(co, "Cedar site", undefined, cedar);
      const c2 = await createProject(co, "Cedar app", undefined, cedar);
      const cInternal = await createProject(co, "Cedar internal", undefined, cedar);
      await withTenants([co], (c) => c.query(`UPDATE projects SET is_internal = true WHERE id = $1 AND tenant_id = $2`, [cInternal, co]));
      await addMilestones(c1, 2, 1); // milestone rows, but no report_work_facts row for either project
      try {
        const r = await getDoc(co, params(cedar), admin);
        expect(r.statusCode).toBe(200);
        const doc = r.json() as ReportDocument;
        expect(kpi(doc, "delivery.tasks_completed").value).toBe(0);
        expect(kpi(doc, "delivery.milestone_hit_rate").denominator).toBe(2); // the client does have milestone figures
        const projects = doc.tables.find((t) => t.key === "client_projects");
        expect(projects, "client_projects table is present").toBeTruthy();
        expect(projects!.rows.map((row) => row.project).sort()).toEqual(["Cedar app", "Cedar site"]); // not the internal one
        expect(projects!.rows.every((row) => row.throughput === 0 && row.tasksCompleted === 0)).toBe(true);
        expect(projects!.totalRow).toMatchObject({ throughput: 0, tasksCompleted: 0 });
        // A project WITH facts in the same range keeps its figures, and the date range narrows the facts, not the projects.
        await addFact(c2, { tc: 3, est: 90 });
        const again = (await getDoc(co, params(cedar), admin)).json() as ReportDocument;
        const rows = again.tables.find((t) => t.key === "client_projects")!.rows;
        expect(rows.find((row) => row.project === "Cedar app")).toMatchObject({ throughput: 90, tasksCompleted: 3 });
        expect(rows.find((row) => row.project === "Cedar site")).toMatchObject({ throughput: 0, tasksCompleted: 0 });
      } finally {
        await withTenants([co], async (c) => {
          await c.query(`DELETE FROM report_work_facts WHERE tenant_id = $1 AND project_id = ANY($2::uuid[])`, [co, [c1, c2]]);
          await c.query(`UPDATE clients SET deleted_at = now() WHERE id = $1 AND tenant_id = $2`, [cedar, co]);
        }, { modules: ["reports"] });
      }
    });

    it("an internal (sentinel) client has no figures: an empty but valid document, never the internal work", async () => {
      const r = await getDoc(co, params(hq), admin);
      expect(r.statusCode).toBe(200);
      const doc = r.json() as ReportDocument;
      expect(kpi(doc, "delivery.tasks_completed").value).toBe(0);
      expect(kpi(doc, "effort.minutes_logged").value).toBe(0);
      expect(doc.tables.find((t) => t.key === "client_projects")).toBeUndefined();
    });

    it("a malformed scopeRef is 400 on scopeRef, and servedTenant is refused for a client", async () => {
      const bad = await getDoc(co, { ...params(acme), scopeRef: "not-a-uuid" }, admin);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().field).toBe("scopeRef");
      const served = await getDoc(co, { ...params(acme), servedTenant: co }, admin);
      expect(served.statusCode).toBe(400);
      const grain = await getDoc(co, { ...params(acme), grain: "account" }, admin);
      expect(grain.statusCode).toBe(400);
      expect(grain.json().error).toContain("client");
    });

    it("another company's client id yields no figures here (tenant isolation), not that company's numbers", async () => {
      const other = await createCompany("PV7-01 Other Co", ["reports", "pm", "hr"]);
      const foreign = await createClient(other, "Foreign Client");
      const r = await getDoc(co, params(foreign), admin);
      expect(r.statusCode).toBe(200);
      const doc = r.json() as ReportDocument;
      expect(doc.header.scopeName).toBe(foreign); // not resolvable here: the id itself, as for a project
      expect(kpi(doc, "delivery.tasks_completed").value).toBe(0);
    });
  });

  describe("access: read_client", () => {
    const q = (clientId: string) => ({ grain: "client", scopeRef: clientId, periodKind: "custom", start: START, end: END });

    it("company_admin and a company member read a client document (the read_project tiers); a bare membership is refused", async () => {
      expect((await getDoc(co, q(acme), admin)).statusCode).toBe(200);
      expect((await getDoc(co, q(acme), member)).statusCode).toBe(200);
      expect((await getDoc(co, q(acme), nobody)).statusCode).toBe(403);
    });

    it("the overview, metrics and export routes are gated by the same action", async () => {
      const overview = (as: string) => app.inject({ method: "GET", url: `/api/${co}/reports/overview?grain=client&periodKind=custom&start=${START}&end=${END}`, headers: asUser(as) });
      const metrics = (as: string) => app.inject({ method: "GET", url: `/api/${co}/reports/metrics?grain=client&metricKey=delivery.tasks_completed&from=${START}&to=${END}`, headers: asUser(as) });
      const exp = (as: string) => app.inject({ method: "POST", url: `/api/${co}/reports/export`, headers: asUser(as), payload: { grain: "client", scopeRef: acme, periodKind: "custom", start: START, end: END, format: "csv" } });
      for (const route of [overview, metrics, exp]) {
        expect((await route(nobody)).statusCode).toBe(403);
        expect((await route(admin)).statusCode).toBe(200);
      }
    });
  });

  describe("GET /reports/overview?grain=client and /metrics", () => {
    it("lists one headline row per client with work in range, named, the same three headline KPIs, no deltas", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/reports/overview?grain=client&periodKind=custom&start=${START}&end=${END}`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { scopes: { scopeRef: string; scopeName: string; kpis: ReportKpi[] }[] };
      expect(body.scopes.map((s) => s.scopeRef).sort()).toEqual([acme, birch].sort());
      const a = body.scopes.find((s) => s.scopeRef === acme)!;
      expect(a.scopeName).toBe("Acme Hospitality");
      expect(a.kpis.map((k) => k.metricKey)).toEqual(["delivery.throughput_weighted", "delivery.on_time_rate", "delivery.tasks_completed"]);
      const onTime = a.kpis.find((k) => k.metricKey === "delivery.on_time_rate")!;
      expect([onTime.numerator, onTime.denominator]).toEqual([10, 12]);
      expect(a.kpis.every((k) => k.delta === undefined)).toBe(true);
    });

    it("metrics?grain=client returns only {clientId}-dimensioned rows", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/reports/metrics?grain=client&metricKey=delivery.tasks_completed&from=${START}&to=${END}`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      const rows = r.json() as { numerator: number; dimensions: Record<string, unknown> }[];
      expect(rows.map((x) => x.dimensions.clientId).sort()).toEqual([acme, birch].sort());
      expect(rows.find((x) => x.dimensions.clientId === acme)!.numerator).toBe(14);
    });
  });

  describe("POST /reports/export with grain=client", () => {
    it("builds the export through the same fetch and names the file for the client", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/reports/export`,
        headers: asUser(admin),
        payload: { grain: "client", scopeRef: acme, periodKind: "custom", start: START, end: END, format: "csv" },
      });
      expect(r.statusCode).toBe(200);
      const { jobId } = r.json() as { jobId: string };
      const status = await app.inject({ method: "GET", url: `/api/${co}/reports/exports/${jobId}`, headers: asUser(admin) });
      expect(status.statusCode).toBe(200);
      expect(status.json().filename).toMatch(/^client-acme-hospitality-/);
      // the status and download re-authorize under the grain read from the stored key: a refused caller gets 403
      expect((await app.inject({ method: "GET", url: `/api/${co}/reports/exports/${jobId}`, headers: asUser(nobody) })).statusCode).toBe(403);
      const dl = await app.inject({ method: "GET", url: `/api/${co}/reports/exports/${jobId}/download`, headers: asUser(admin) });
      expect(dl.statusCode).toBe(200);
      expect(dl.body).toContain("Acme Hospitality");
    });
  });

  // ════════════════════════════ Part B — a moved project, sealed vs live ════════════════════════════
  describe("a project moved to another client after the month is sealed", () => {
    const ORG_BLOB = { root: { id: "co-root", kind: "company", name: "PV7-01 Seal Co", children: [{ id: "d-eng", kind: "department", name: "Engineering", children: [] }] } };
    let co2: string;
    let admin2: string;
    let alice: string;
    let clientX: string;
    let clientY: string;
    let px: string;
    let py: string;
    let periodId: string;
    let fetchCalls = 0;

    async function timeEntry(projectId: string, minutes: number, date: string): Promise<void> {
      await withTenants([co2], (c) =>
        c.query(
          `INSERT INTO time_entries (id, tenant_id, user_id, project_id, pm_task_id, minutes, billable, entry_date, origin_site) VALUES ($1,$2,$3,$4,NULL,$5,true,$6::date,'central')`,
          [newId(), co2, alice, projectId, minutes, date],
        ),
      );
    }
    const sealedDoc = async (scopeRef: string, as = admin2) =>
      (await getDoc(co2, { grain: "client", scopeRef, periodKind: "month", start: "2026-07-01" }, as)).json() as ReportDocument;
    const liveDoc = async (scopeRef: string, as = admin2) =>
      (await getDoc(co2, { grain: "client", scopeRef, periodKind: "custom", start: "2026-07-01", end: "2026-07-31" }, as)).json() as ReportDocument;

    beforeAll(async () => {
      co2 = await createCompany("PV7-01 Seal Co", ["reports", "pm", "hr"]);
      admin2 = await createUser("admin2@pv701.test");
      alice = await createUser("alice@pv701.test");
      await addMembership(co2, admin2);
      await addMembership(co2, alice);
      await grantRole(admin2, await createRole("company_admin"), "company", co2);
      await withTenants([co2], (c) => c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'central')`, [co2, JSON.stringify(ORG_BLOB)]));
      await withTenants([co2], (c) =>
        c.query(`INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site) VALUES ($1,$2,$3,'d-eng',true,'2026-01-01'::date,'manual','central')`, [
          newId(),
          co2,
          alice,
        ]),
      );
      clientX = await createClient(co2, "Client X");
      clientY = await createClient(co2, "Client Y");
      px = await createProject(co2, "Project PX", undefined, clientX);
      py = await createProject(co2, "Project PY", undefined, clientY);
      await timeEntry(px, 100, "2026-07-10");
      await timeEntry(py, 50, "2026-07-11");

      const [period] = await ensureCalendarPeriodRows(co2, "month", "2026-07-01", "2026-07-01");
      periodId = period.id;
      // A counting gateway: every AI narrative attempt is one fetch. The text carries no numerals, so it clears the guard.
      const fetchImpl = (async () => {
        fetchCalls += 1;
        return { ok: true, status: 200, json: async () => ({ text: "A steady month of delivery.", provider: "test-model" }) } as Response;
      }) as unknown as typeof fetch;
      const sealed = await sealPeriod(co2, periodId, null, { gatewayUrl: "http://fake-gateway.invalid", gatewayToken: "test-token", fetchImpl });
      expect(sealed.ok).toBe(true);
    }, 120_000);

    it("the seal stored a deterministic client document per client and made no gateway call for any of them (L2)", async () => {
      const { rows } = await withTenants([co2], (c) => c.query<{ grain: string; narrative_source: string }>(`SELECT grain, narrative_source FROM report_documents WHERE tenant_id = $1 AND period_id = $2`, [co2, periodId]), {
        modules: ["reports"],
      });
      const clientDocs = rows.filter((r) => r.grain === "client");
      expect(clientDocs).toHaveLength(2); // clientX and clientY, each with rollup rows
      expect(clientDocs.every((r) => r.narrative_source === "deterministic")).toBe(true);
      // one AI attempt per NON-client document, none for the two client documents
      expect(fetchCalls).toBe(rows.length - clientDocs.length);
      expect(fetchCalls).toBeGreaterThan(0);

      const x = await sealedDoc(clientX);
      expect(x.narrative.source).toBe("deterministic");
      expect(x.narrative.model).toBeUndefined();
    });

    it("the seal also persisted client rows to rollup_metrics (calendar periods persist, as for every grain)", async () => {
      const { rows } = await withTenants([co2], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM rollup_metrics WHERE tenant_id = $1 AND module = 'reports' AND dimensions ? 'clientId'`, [co2]));
      expect(Number(rows[0].n)).toBeGreaterThan(0);
    });

    it("before the move, sealed and live agree: X has PX's 100 minutes, Y has PY's 50", async () => {
      const sx = await sealedDoc(clientX);
      expect(sx.header.sealed).toBe(true);
      expect(kpi(sx, "effort.minutes_logged").value).toBe(100);
      expect(kpi(await sealedDoc(clientY), "effort.minutes_logged").value).toBe(50);
      expect(kpi(await liveDoc(clientX), "effort.minutes_logged").value).toBe(100);
    });

    it("after PX moves to client Y: the sealed document keeps the OLD attribution, a live range shows the NEW one", async () => {
      await withTenants([co2], (c) => c.query(`UPDATE projects SET client_id = $1 WHERE id = $2 AND tenant_id = $3`, [clientY, px, co2]));

      // sealed July: unchanged history
      const sx = await sealedDoc(clientX);
      const sy = await sealedDoc(clientY);
      expect(sx.header.sealed).toBe(true);
      expect(sy.header.sealed).toBe(true);
      expect(kpi(sx, "effort.minutes_logged").value).toBe(100);
      expect(kpi(sy, "effort.minutes_logged").value).toBe(50); // not 150

      // a live range over the same month follows the project's CURRENT client
      const lx = await liveDoc(clientX);
      const ly = await liveDoc(clientY);
      expect(lx.header.sealed).toBe(false);
      expect(kpi(lx, "effort.minutes_logged").value).toBe(0);
      expect(kpi(ly, "effort.minutes_logged").value).toBe(150);
    });
  });
});
