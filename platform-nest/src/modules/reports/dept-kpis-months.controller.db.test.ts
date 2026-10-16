// DW-10b — monthly targets against actuals over the REAL HTTP surface (buildApp + app.inject), against live Postgres + RLS +
// Cerbos (cerbos/policies/resource_dept_kpi_target.yaml). Covers docs/FRONTEND-BFF-CONTRACT.md §58.5's proof list:
//   * the series (GET /dept-kpis/months): two months with different approved targets read each month's own target and
//     condition; a month with no data is unavailable and never 0; the current month is partial; 13 months, from > to and a
//     future `to` are 400; the read gate equals GET /dept-kpis' (a matrix, caller by caller); a sealed month reads its stored
//     document and keeps its value after a later fact change that a live recompute would show;
//   * the batch propose (POST /dept-kpis/targets/batch): a non-head is 403 and never 400 even with an invalid body; an invalid
//     item names its index and nothing is inserted; a duplicate month is 400; 37 items is 400; a head of a sibling unit is 403;
//     all-or-nothing at the database (insertProposals rolled back by a failing item); one `proposed` activity row per id;
//   * the batch decide (POST /dept-kpis/targets/decide-batch): an own proposal in the set is 409 and nothing is decided; a
//     rejected or superseded id is 409; approving two months supersedes each month's earlier approved row only (the earlier
//     month's row stays approved); the activity rows are written per id; all-or-nothing at the database
//     (decideTargetsAtomically rolled back by a missing id).
// The single propose / approve / reject routes keep their own suite (dept-kpis.controller.db.test.ts), unchanged.
// The pure half (month window, series shape, batch validation, decision order) is dept-kpi-batch.test.ts.
//
// The org tree is written in the REAL stored shape (`{root: ...}`) and the closure is built with the PRODUCTION builder: without
// the closure every org_unit_lead rule denies. The milestone months (June, August, September 2026) are read live from
// pm_milestones, so only the sealed month needs a work event (and a seal) to have a stored department document.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { todayIsoInTz } from "./person-scope";
import { decideTargetsAtomically, insertProposals } from "./dept-kpi-targets";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Cell = {
  month: string; value: number | null; numerator?: number; denominator?: number; target: number | null; tolerance: number | null;
  targetSource: string; condition: string; reason?: string;
};
type SeriesKpi = { key: string; label: string; unit: string; direction: string; cells: Cell[] };
type Series = {
  unit: { id: string; name: string }; workspace: string;
  months: Array<{ month: string; start: string; end: string; partial: boolean; condition: string }>;
  kpis: SeriesKpi[];
};

const WEB_KPIS = ["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"];

/** `YYYY-MM` of the first of the month `delta` months from `month`. Written out here so the test does not lean on the code it checks. */
function monthPlus(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

describe.skipIf(!TEST_URL)("DW-10b monthly targets against actuals (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string; // company_admin: the approver
  let admin2: string; // a second approver
  let webHead: string; // org_unit_lead @ d-web + manager + member, placed in d-web (the real head shape)
  let webStaff: string; // member, placed in d-web
  let feStaff: string; // member, placed in dv-fe (a division of d-web)
  let seoStaff: string; // member, placed in d-seo
  let seoHead: string; // org_unit_lead @ d-seo + manager, placed in d-seo: a head of a SIBLING unit
  let hr: string; // hr_staff + member: a company-wide reader
  let junePeriodId: string;
  const ids: Record<string, string> = {};

  const place = (userId: string, unit: string) =>
    withTenants([co], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4,true,'2020-01-01','manual',$5)`,
        [newId(), co, userId, unit, config.originSite],
      ),
    );
  const milestones = async (unit: string, due: string, total: number, done: number) => {
    const projectId = await createProject(co, `Project ${unit} ${due}`);
    await withTenants([co], async (c) => {
      await c.query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [projectId, unit]);
      for (let i = 0; i < total; i++) {
        await c.query(
          `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7)`,
          [newId(), co, projectId, `M${i}`, due, i < done ? "done" : "open", config.originSite],
        );
      }
    });
  };
  /** One completed task by `userId` on `day`: the work-activity event that puts the user's unit into a period's rollup rows. */
  const completedTask = async (userId: string, day: string) => {
    const projectId = await createProject(co, `Work ${day}`);
    const taskId = newId();
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site) VALUES ($1,$2,$3,'task',$4::date,60,$5)`,
        [taskId, co, projectId, day, config.originSite],
      );
      await c.query(
        `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from)
         VALUES ($1,$2,$3,'owner','person',$4,$5,$6,'2026-01-01'::date)`,
        [newId(), co, taskId, userId, userId, config.originSite],
      );
      await c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
         VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,$6::timestamptz,$7)`,
        [newId(), co, `ev-${newId()}`, userId, taskId, `${day}T10:00:00Z`, config.originSite],
      );
    });
  };

  const months = (qs: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/dept-kpis/months?${qs}`, headers: asUser(as) });
  const single = (qs: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/dept-kpis?${qs}`, headers: asUser(as) });
  const propose = (body: Record<string, unknown>, as: string) =>
    app.inject({ method: "POST", url: `/api/${co}/dept-kpis/targets`, headers: asUser(as), payload: body });
  const approve = (id: string, as: string) => app.inject({ method: "POST", url: `/api/${co}/dept-kpis/targets/${id}/approve`, headers: asUser(as), payload: {} });
  const proposeBatch = (body: unknown, as: string) =>
    app.inject({ method: "POST", url: `/api/${co}/dept-kpis/targets/batch`, headers: asUser(as), payload: body as Record<string, unknown> });
  const decideBatch = (body: unknown, as: string) =>
    app.inject({ method: "POST", url: `/api/${co}/dept-kpis/targets/decide-batch`, headers: asUser(as), payload: body as Record<string, unknown> });
  const item = (kpiKey: string, effectiveFrom: string, target = 0.9, tolerance = 0.05, note?: string) => ({
    kpiKey, effectiveFrom, target, tolerance, ...(note ? { note } : {}),
  });
  const statusOf = async (id: string) =>
    withTenants([co], async (c) => (await c.query<{ status: string }>(`SELECT status FROM dept_kpi_targets WHERE id = $1`, [id])).rows[0]?.status, {
      modules: ["reports"],
    });
  const rowOf = async (id: string) =>
    withTenants(
      [co],
      async (c) =>
        (await c.query<{ unit_node_id: string; kpi_key: string; effective_from: string; status: string; proposed_by: string; decided_by: string | null }>(
          `SELECT unit_node_id, kpi_key, effective_from::text AS effective_from, status, proposed_by, decided_by FROM dept_kpi_targets WHERE id = $1`, [id])).rows[0],
      { modules: ["reports"] },
    );
  const countRows = async (where: string, params: unknown[] = []) =>
    withTenants(
      [co],
      async (c) => Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM dept_kpi_targets WHERE tenant_id = $1 AND ${where}`, [co, ...params])).rows[0].n),
      { modules: ["reports"] },
    );
  const verbsOf = async (id: string) =>
    withTenants([co], async (c) =>
      (await c.query<{ verb: string }>(
        `SELECT verb FROM activities WHERE tenant_id = $1 AND target_entity_type = 'dept_kpi_target' AND target_entity_id = $2
            AND verb IN ('proposed', 'approved', 'rejected') ORDER BY occurred_at`, [co, id])).rows.map((x) => x.verb),
    );
  const kpiCells = (s: Series, key: string): Cell[] => {
    const k = s.kpis.find((x) => x.key === key);
    if (!k) throw new Error(`no KPI ${key} in the series`);
    return k.cells;
  };
  const cellOf = (s: Series, key: string, month: string): Cell => {
    const c = kpiCells(s, key).find((x) => x.month === month);
    if (!c) throw new Error(`no cell ${key} ${month}`);
    return c;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("DW-10b Co", ["reports", "pm", "hr"]);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [co]));

    admin = await createUser("admin@dw10b.test");
    admin2 = await createUser("admin2@dw10b.test");
    webHead = await createUser("web-head@dw10b.test");
    webStaff = await createUser("web-staff@dw10b.test");
    feStaff = await createUser("fe-staff@dw10b.test");
    seoStaff = await createUser("seo-staff@dw10b.test");
    seoHead = await createUser("seo-head@dw10b.test");
    hr = await createUser("hr@dw10b.test");
    const everyone = [admin, admin2, webHead, webStaff, feStaff, seoStaff, seoHead, hr];
    for (const u of everyone) await addMembership(co, u);

    const member = await createRole("member");
    for (const u of everyone) await grantRole(u, member, "company", co);
    const companyAdmin = await createRole("company_admin");
    await grantRole(admin, companyAdmin, "company", co);
    await grantRole(admin2, companyAdmin, "company", co);
    const lead = await createRole("org_unit_lead");
    const manager = await createRole("manager");
    await grantRole(webHead, lead, "org_unit", "d-web");
    await grantRole(webHead, manager, "company", co);
    await grantRole(seoHead, lead, "org_unit", "d-seo");
    await grantRole(seoHead, manager, "company", co);
    await grantRole(hr, await createRole("hr_staff"), "company", co);

    const root = {
      id: "d-corp",
      kind: "company",
      name: "DW-10b Co",
      children: [
        { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
        { id: "d-seo", kind: "department", name: "SEO", children: [] },
      ],
    };
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
        [co, JSON.stringify({ root }), config.originSite],
      ),
    );
    await withTenants([co], (c) => rebuildOrgUnitClosure(c, co, root));
    await place(webHead, "d-web");
    await place(webStaff, "d-web");
    await place(feStaff, "dv-fe");
    await place(seoStaff, "d-seo");
    await place(seoHead, "d-seo");

    // Web Dev's milestones: June 3 of 4 (the sealed month), August 2 of 4, September 4 of 5. July and every other month: none.
    await milestones("d-web", "2026-06-15", 4, 3);
    await milestones("d-web", "2026-08-15", 4, 2);
    await milestones("d-web", "2026-09-15", 5, 4);
    // June also carries one completed task by a Web Dev person, so Web Dev has rollup rows and a stored document when sealed.
    await completedTask(webStaff, "2026-06-10");

    app = await buildApp();
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ the series (§58.1) ═══════════════════════════════

  it("setup: two approved targets for Projects on time, 0.6 from June and 0.8 from September", async () => {
    const a = await propose({ unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-06-01", target: 0.6, tolerance: 0.05 }, webHead);
    expect(a.statusCode).toBe(201);
    const b = await propose({ unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-09-01", target: 0.8, tolerance: 0.05 }, webHead);
    expect(b.statusCode).toBe(201);
    expect((await approve(a.json().id, admin)).statusCode).toBe(200);
    expect((await approve(b.json().id, admin)).statusCode).toBe(200);
  });

  it("two months with different approved targets: each cell carries its own month's target and condition", async () => {
    const r = await months("unitNodeId=d-web&from=2026-08&to=2026-09", webStaff);
    expect(r.statusCode).toBe(200);
    const body = r.json() as Series;
    expect(body.unit).toEqual({ id: "d-web", name: "Web Dev" });
    expect(body.workspace).toBe("web-dev");
    // the months, oldest first, with their real ends; neither is the current month
    expect(body.months).toEqual([
      { month: "2026-08", start: "2026-08-01", end: "2026-08-31", partial: false, condition: "off_track" },
      { month: "2026-09", start: "2026-09-01", end: "2026-09-30", partial: false, condition: "on_track" },
    ]);
    // the KPIs in catalogue order, one cell per month
    expect(body.kpis.map((k) => k.key)).toEqual(WEB_KPIS);
    expect(body.kpis[0]).toMatchObject({ key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good" });
    for (const k of body.kpis) expect(k.cells.map((c) => c.month)).toEqual(["2026-08", "2026-09"]);
    // August: 2 of 4 = 0.5 against the June target 0.6 +/- 0.05 -> off track
    expect(cellOf(body, "projects-on-time", "2026-08")).toMatchObject({
      value: 0.5, numerator: 2, denominator: 4, target: 0.6, tolerance: 0.05, targetSource: "approved", condition: "off_track",
    });
    // September: 4 of 5 = 0.8 against the September target 0.8 -> on track (the August target no longer governs)
    expect(cellOf(body, "projects-on-time", "2026-09")).toMatchObject({
      value: 0.8, numerator: 4, denominator: 5, target: 0.8, tolerance: 0.05, targetSource: "approved", condition: "on_track",
    });
  });

  it("a cell is exactly that month's single read (GET /dept-kpis), so the two surfaces cannot disagree", async () => {
    const series = (await months("unitNodeId=d-web&from=2026-08&to=2026-09", admin)).json() as Series;
    for (const [month, start] of [["2026-08", "2026-08-01"], ["2026-09", "2026-09-01"]] as const) {
      const one = await single(`unitNodeId=d-web&periodKind=month&start=${start}`, admin);
      expect(one.statusCode).toBe(200);
      for (const k of one.json().kpis as Array<Omit<Cell, "month"> & { key: string; label: string; unit: string; direction: string }>) {
        const { key, label: _label, unit: _unit, direction: _direction, ...read } = k;
        expect(cellOf(series, key, month)).toEqual({ month, ...read });
      }
    }
  });

  it("a month with no data is unavailable, never 0 and never another month's number (the target in force still shows)", async () => {
    const r = await months("unitNodeId=d-web&from=2026-07&to=2026-07", webStaff);
    expect(r.statusCode).toBe(200);
    // July has no milestones; June's target (0.6) is in force for it
    expect(cellOf(r.json(), "projects-on-time", "2026-07")).toEqual({
      month: "2026-07", value: null, target: 0.6, tolerance: 0.05, targetSource: "approved", condition: "unavailable", reason: "no_data",
    });
    // a month before the company's fact history (and before every target) reads no_data too
    const early = await months("unitNodeId=d-web&from=2025-12&to=2025-12", webStaff);
    expect(cellOf(early.json(), "projects-on-time", "2025-12")).toMatchObject({
      value: null, target: null, targetSource: "none", condition: "unavailable", reason: "no_data",
    });
    // a module KPI with nothing to measure is unavailable as well, with a reason
    const sla = cellOf(r.json(), "requests-within-sla", "2026-07");
    expect(sla.value).toBeNull();
    expect(sla.condition).toBe("unavailable");
    expect(sla.reason).toBeTruthy();
  });

  it("the current month is partial; without from and to the window is the 12 months ending with it", async () => {
    const current = todayIsoInTz(config.reportsTz).slice(0, 7);
    const one = await months(`unitNodeId=d-web&from=${current}&to=${current}`, webStaff);
    expect(one.statusCode).toBe(200);
    expect((one.json() as Series).months).toHaveLength(1);
    expect((one.json() as Series).months[0]).toMatchObject({ month: current, partial: true });

    const dflt = await months("unitNodeId=d-web", webStaff);
    expect(dflt.statusCode).toBe(200);
    const s = dflt.json() as Series;
    expect(s.months).toHaveLength(12);
    expect(s.months[0].month).toBe(monthPlus(current, -11));
    expect(s.months[11]).toMatchObject({ month: current, partial: true });
    expect(s.months.slice(0, 11).every((m) => !m.partial)).toBe(true);
    for (const k of s.kpis) expect(k.cells.map((c) => c.month)).toEqual(s.months.map((m) => m.month));
    // 12 months exactly is allowed
    expect((await months(`unitNodeId=d-web&from=${monthPlus(current, -11)}&to=${current}`, webStaff)).statusCode).toBe(200);
  });

  it("13 months, from after to, a future to and a malformed month are 400, naming the field", async () => {
    const current = todayIsoInTz(config.reportsTz).slice(0, 7);
    const thirteen = await months(`unitNodeId=d-web&from=${monthPlus(current, -12)}&to=${current}`, admin);
    expect(thirteen.statusCode).toBe(400);
    expect(thirteen.json().field).toBe("from");
    const backwards = await months("unitNodeId=d-web&from=2026-09&to=2026-08", admin);
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().field).toBe("from");
    const future = await months(`unitNodeId=d-web&from=${current}&to=${monthPlus(current, 1)}`, admin);
    expect(future.statusCode).toBe(400);
    expect(future.json().field).toBe("to");
    const bad = await months("unitNodeId=d-web&from=2026-9&to=2026-10", admin);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().field).toBe("from");
    expect((await months("unitNodeId=d-web&from=2026-08&to=October", admin)).json().field).toBe("to");
    // no unit is 400 too
    const noUnit = await months("from=2026-08&to=2026-09", admin);
    expect(noUnit.statusCode).toBe(400);
    expect(noUnit.json().field).toBe("unitNodeId");
  });

  it("the read gate equals GET /dept-kpis' for every caller and unit: staff of the unit and its divisions, the enclosing head, the company-wide tiers pass; others get 403", async () => {
    const callers: Array<[string, string]> = [
      ["admin", admin], ["hr", hr], ["webHead", webHead], ["webStaff", webStaff], ["feStaff", feStaff], ["seoStaff", seoStaff], ["seoHead", seoHead],
    ];
    const expected: Record<string, Record<string, number>> = {
      "d-web": { admin: 200, hr: 200, webHead: 200, webStaff: 200, feStaff: 200, seoStaff: 403, seoHead: 403 },
      "dv-fe": { admin: 200, hr: 200, webHead: 200, webStaff: 403, feStaff: 200, seoStaff: 403, seoHead: 403 }, // the head of the enclosing unit passes; staff of the department never see a division
      "d-seo": { admin: 200, hr: 200, webHead: 403, webStaff: 403, feStaff: 403, seoStaff: 200, seoHead: 200 },
    };
    for (const [unit, row] of Object.entries(expected)) {
      for (const [name, user] of callers) {
        const m = await months(`unitNodeId=${unit}&from=2026-09&to=2026-09`, user);
        const s = await single(`unitNodeId=${unit}&periodKind=month&start=2026-09-01`, user);
        expect([unit, name, m.statusCode]).toEqual([unit, name, row[name]]);
        expect([unit, name, s.statusCode]).toEqual([unit, name, row[name]]); // and the months read agrees with the single read
      }
    }
  });

  it("a caller who may not read the unit gets 403 whatever the window says; an unknown unit is 404 for a company-wide caller and 403 for staff", async () => {
    expect((await months("unitNodeId=d-seo&from=2020-01&to=2030-12", webStaff)).statusCode).toBe(403);
    expect((await months("unitNodeId=d-seo&from=garbage", webHead)).statusCode).toBe(403);
    const unknown = await months("unitNodeId=d-nope&from=2026-09&to=2026-09", hr);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
    expect((await months("unitNodeId=d-nope&from=2026-09&to=2026-09", webStaff)).statusCode).toBe(403);
  });

  it("a sealed month reads its stored document: the value stays after a later fact change that a live recompute shows", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/reports/periods?kind=month&from=2026-06-01&to=2026-06-01`, headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    junePeriodId = (list.json().periods as Array<{ id: string }>)[0].id;
    const sealed = await app.inject({ method: "POST", url: `/api/${co}/reports/periods/${junePeriodId}/seal`, headers: asUser(admin) });
    expect(sealed.statusCode).toBe(200);
    expect(sealed.json().status).toBe("sealed");

    // precondition: Web Dev's June document is stored, so the report path serves it
    const stored = await app.inject({ method: "GET", url: `/api/${co}/reports/document?grain=department&scopeRef=d-web&periodKind=month&start=2026-06-01`, headers: asUser(admin) });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().header.sealed).toBe(true);

    const before = (await months("unitNodeId=d-web&from=2026-06&to=2026-06", admin)).json() as Series;
    expect(cellOf(before, "projects-on-time", "2026-06")).toMatchObject({ value: 0.75, numerator: 3, denominator: 4, target: 0.6, condition: "on_track" });

    // a later fact change: the open June milestone is completed after the seal
    await withTenants([co], (c) => c.query(`UPDATE pm_milestones SET status = 'done' WHERE tenant_id = $1 AND due_date = '2026-06-15' AND status = 'open'`, [co]));
    // a live recompute (a custom range is always live) now differs: 4 of 4
    const live = await app.inject({
      method: "GET",
      url: `/api/${co}/reports/document?grain=department&scopeRef=d-web&periodKind=custom&start=2026-06-01&end=2026-06-30`,
      headers: asUser(admin),
    });
    expect(live.statusCode).toBe(200);
    const liveKpi = live.json().kpis.find((k: { metricKey: string }) => k.metricKey === "delivery.milestone_hit_rate");
    expect({ value: liveKpi.value, numerator: liveKpi.numerator, denominator: liveKpi.denominator }).toEqual({ value: 1, numerator: 4, denominator: 4 });

    // the series still serves the stored document
    const after = (await months("unitNodeId=d-web&from=2026-06&to=2026-06", admin)).json() as Series;
    expect(cellOf(after, "projects-on-time", "2026-06")).toEqual(cellOf(before, "projects-on-time", "2026-06"));
  });

  // ═══════════════════════════════ the batch propose (§58.2) ═══════════════════════════════

  it("a head proposes several months at once: 201 {ids} in item order, each row a proposal of the head, one `proposed` activity per id", async () => {
    const r = await proposeBatch(
      {
        unitNodeId: "d-web",
        items: [item("projects-on-time", "2026-11-01", 0.85, 0.05, "Q4"), item("projects-on-time", "2026-12-01", 0.9), item("client-site-uptime", "2026-11-01", 0.99, 0.005)],
      },
      webHead,
    );
    expect(r.statusCode).toBe(201);
    expect(Object.keys(r.json())).toEqual(["ids"]);
    const got = r.json().ids as string[];
    expect(got).toHaveLength(3);
    const rows = await Promise.all(got.map((id) => rowOf(id)));
    expect(rows.map((x) => [x.unit_node_id, x.kpi_key, x.effective_from, x.status, x.proposed_by])).toEqual([
      ["d-web", "projects-on-time", "2026-11-01", "proposed", webHead],
      ["d-web", "projects-on-time", "2026-12-01", "proposed", webHead],
      ["d-web", "client-site-uptime", "2026-11-01", "proposed", webHead],
    ]);
    for (const id of got) expect(await verbsOf(id)).toEqual(["proposed"]);
    const note = await withTenants([co], async (c) => (await c.query<{ note: string | null }>(`SELECT note FROM dept_kpi_targets WHERE id = $1`, [got[0]])).rows[0].note, { modules: ["reports"] });
    expect(note).toBe("Q4");
    [ids.bP1, ids.bP2, ids.bP3] = got;
  });

  it("a non-head gets 403, never 400, even with an invalid body: staff, the HR tier, the head of a sibling unit", async () => {
    const valid = { unitNodeId: "d-web", items: [item("projects-on-time", "2027-01-01")] };
    const invalidBodies: unknown[] = [
      { unitNodeId: "d-web", items: "nope" },
      { unitNodeId: "d-web", items: [] },
      { unitNodeId: "d-web", items: [{}] },
      { unitNodeId: "d-web", items: [item("projects-on-time", "2027-01-15")] },
      { items: [item("projects-on-time", "2027-01-01")] }, // no unit at all
      {},
    ];
    for (const who of [webStaff, hr, seoStaff, feStaff, seoHead]) {
      expect((await proposeBatch(valid, who)).statusCode).toBe(403);
      for (const body of invalidBodies) expect((await proposeBatch(body, who)).statusCode).toBe(403);
    }
    // a head of a sibling unit may propose for their own unit, not for this one
    expect((await proposeBatch({ unitNodeId: "d-seo", items: [item("client-retention", "2027-01-01")] }, seoHead)).statusCode).toBe(201);
    // nothing was written for the refused calls
    expect(await countRows(`unit_node_id = 'd-web' AND effective_from = '2027-01-01'`)).toBe(0);
  });

  it("an invalid item names its index and nothing is inserted", async () => {
    const before = await countRows(`unit_node_id = 'd-web' AND effective_from >= '2027-02-01' AND effective_from < '2027-06-01'`);
    const badTarget = await proposeBatch(
      { unitNodeId: "d-web", items: [item("projects-on-time", "2027-02-01"), item("projects-on-time", "2027-03-01"), { ...item("projects-on-time", "2027-04-01"), target: "high" }] },
      webHead,
    );
    expect(badTarget.statusCode).toBe(400);
    expect(badTarget.json().field).toBe("items[2].target");
    const badKpi = await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2027-02-01"), item("overdue-tasks", "2027-03-01", 0, 3)] }, webHead);
    expect(badKpi.statusCode).toBe(400);
    expect(badKpi.json().field).toBe("items[1].kpiKey"); // a generic KPI, not Web Dev's
    const badMonth = await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2027-02-15")] }, webHead);
    expect(badMonth.json().field).toBe("items[0].effectiveFrom");
    const badPercent = await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2027-02-01"), item("projects-on-time", "2027-03-01", 85)] }, webHead);
    expect(badPercent.json().field).toBe("items[1].target");
    const notAnObject = await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2027-02-01"), null] }, webHead);
    expect(notAnObject.json().field).toBe("items[1]");
    expect(await countRows(`unit_node_id = 'd-web' AND effective_from >= '2027-02-01' AND effective_from < '2027-06-01'`)).toBe(before);
  });

  it("a duplicate (KPI, month) is 400 on items[i].effectiveFrom; the same month for another KPI is fine", async () => {
    const dup = await proposeBatch(
      { unitNodeId: "d-web", items: [item("projects-on-time", "2027-02-01"), item("projects-on-time", "2027-03-01"), item("projects-on-time", "2027-02-01", 0.8)] },
      webHead,
    );
    expect(dup.statusCode).toBe(400);
    expect(dup.json().field).toBe("items[2].effectiveFrom");
    expect(await countRows(`unit_node_id = 'd-web' AND effective_from = '2027-02-01'`)).toBe(0);
  });

  it("a missing or oversized list is 400 on items: none, empty, 37; 36 is the most and is accepted", async () => {
    expect((await proposeBatch({ unitNodeId: "d-web" }, webHead)).json().field).toBe("items");
    expect((await proposeBatch({ unitNodeId: "d-web", items: [] }, webHead)).json().field).toBe("items");
    expect((await proposeBatch({ items: [item("projects-on-time", "2027-02-01")] }, admin)).json().field).toBe("unitNodeId");
    const month = (i: number) => `${2030 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
    const many = (n: number) => Array.from({ length: n }, (_, i) => item("reopened-work-rate", month(i), 0.05, 0.03));
    const tooMany = await proposeBatch({ unitNodeId: "d-web", items: many(37) }, webHead);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().field).toBe("items");
    expect(await countRows(`kpi_key = 'reopened-work-rate' AND effective_from >= '2030-01-01'`)).toBe(0);
    const max = await proposeBatch({ unitNodeId: "d-web", items: many(36) }, webHead);
    expect(max.statusCode).toBe(201);
    expect(max.json().ids).toHaveLength(36);
    expect(await countRows(`kpi_key = 'reopened-work-rate' AND effective_from >= '2030-01-01'`)).toBe(36);
  });

  it("an unknown unit is 404 unit_not_found for the approver and 403 for a head (no existence leak)", async () => {
    const body = { unitNodeId: "d-nope", items: [item("projects-on-time", "2027-02-01")] };
    const a = await proposeBatch(body, admin);
    expect(a.statusCode).toBe(404);
    expect(a.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
    expect((await proposeBatch(body, webHead)).statusCode).toBe(403);
  });

  it("all or nothing at the database: a failing item rolls the earlier inserts back (insertProposals)", async () => {
    const before = await countRows(`unit_node_id = 'd-web' AND effective_from = '2027-07-01'`);
    const good = { unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2027-07-01", target: 0.8, tolerance: 0.05, note: null };
    // a tolerance below 0 violates the table's CHECK: validation would have refused it, so this reaches the database directly
    await expect(insertProposals(co, [good, { ...good, kpiKey: "client-site-uptime", tolerance: -1 }], webHead)).rejects.toThrow();
    expect(await countRows(`unit_node_id = 'd-web' AND effective_from = '2027-07-01'`)).toBe(before);
    const ok = await insertProposals(co, [good, { ...good, kpiKey: "client-site-uptime" }], webHead);
    expect(ok).toHaveLength(2);
    expect(await countRows(`unit_node_id = 'd-web' AND effective_from = '2027-07-01'`)).toBe(before + 2);
  });

  // ═══════════════════════════════ the batch decide (§58.3) ═══════════════════════════════

  it("an own proposal in the set is 409 cannot_approve_own_proposal with its id, and nothing is decided", async () => {
    const own = await proposeBatch({ unitNodeId: "d-web", items: [item("client-site-uptime", "2027-08-01", 0.99, 0.005)] }, admin);
    expect(own.statusCode).toBe(201);
    const ownId = own.json().ids[0] as string;
    const r = await decideBatch({ decision: "approve", ids: [ids.bP1, ownId, ids.bP2] }, admin);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "cannot_approve_own_proposal", failedId: ownId });
    for (const id of [ids.bP1, ids.bP2, ownId]) expect(await statusOf(id)).toBe("proposed");
    // rejecting one's own proposal harms nothing: no self-check on reject, as the single route
    const rej = await decideBatch({ decision: "reject", ids: [ownId] }, admin);
    expect(rej.statusCode).toBe(200);
    expect(await statusOf(ownId)).toBe("rejected");
  });

  it("a non-approver is 403 with the id that stopped it and nothing is decided: a head on another's proposals, staff, the HR tier", async () => {
    // proposals of the second approver, so the head's own-proposal check (409) does not answer first
    const theirs = (await proposeBatch({ unitNodeId: "d-web", items: [item("client-site-uptime", "2027-11-01"), item("client-site-uptime", "2027-12-01")] }, admin2)).json().ids as string[];
    for (const who of [webHead, webStaff, hr, seoHead]) {
      for (const decision of ["approve", "reject"]) {
        const r = await decideBatch({ decision, ids: theirs }, who);
        expect(r.statusCode).toBe(403);
        expect(r.json().failedId).toBe(theirs[0]);
      }
    }
    for (const id of theirs) expect(await statusOf(id)).toBe("proposed");
    // the head cannot approve the batch they proposed either: the self-check answers first, as the single route
    const own = await decideBatch({ decision: "approve", ids: [ids.bP1] }, webHead);
    expect(own.statusCode).toBe(409);
    expect(own.json()).toMatchObject({ error: "cannot_approve_own_proposal", failedId: ids.bP1 });
    for (const id of [ids.bP1, ids.bP2]) expect(await statusOf(id)).toBe("proposed");
  });

  it("an unknown or malformed id is 404 with failedId, after the earlier ids passed; a bad body is 400", async () => {
    const ghost = newId();
    const r = await decideBatch({ decision: "approve", ids: [ids.bP1, ghost] }, admin);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "target not found", failedId: ghost });
    const malformed = await decideBatch({ decision: "approve", ids: ["not-a-uuid"] }, admin);
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json().failedId).toBe("not-a-uuid");
    expect(await statusOf(ids.bP1)).toBe("proposed");

    expect((await decideBatch({ decision: "decide", ids: [ids.bP1] }, admin)).json().field).toBe("decision");
    expect((await decideBatch({ decision: "approve" }, admin)).json().field).toBe("ids");
    expect((await decideBatch({ decision: "approve", ids: [] }, admin)).json().field).toBe("ids");
    expect((await decideBatch({ decision: "approve", ids: [ids.bP1, ids.bP1] }, admin)).json().field).toBe("ids");
    const ids37 = Array.from({ length: 37 }, () => newId());
    const tooMany = await decideBatch({ decision: "approve", ids: ids37 }, admin);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().field).toBe("ids");
    expect((await decideBatch({ decision: "approve", ids: [ids.bP1], note: 5 }, admin)).json().field).toBe("note");
  });

  it("a rejected id and a superseded id are each 409 not_proposed with failedId", async () => {
    // a rejected one
    const rejected = await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2027-09-01", 0.7)] }, webHead);
    const rejectedId = rejected.json().ids[0] as string;
    expect((await decideBatch({ decision: "reject", ids: [rejectedId], note: "too low" }, admin)).statusCode).toBe(200);
    // a superseded one: approve a proposal, then approve another for the same month
    const first = (await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2027-10-01", 0.7)] }, webHead)).json().ids[0] as string;
    expect((await decideBatch({ decision: "approve", ids: [first] }, admin)).statusCode).toBe(200);
    const second = (await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2027-10-01", 0.75)] }, webHead)).json().ids[0] as string;
    expect((await decideBatch({ decision: "approve", ids: [second] }, admin2)).statusCode).toBe(200);
    expect(await statusOf(first)).toBe("superseded");

    for (const bad of [rejectedId, first]) {
      for (const decision of ["approve", "reject"]) {
        const r = await decideBatch({ decision, ids: [ids.bP2, bad] }, admin);
        expect(r.statusCode).toBe(409);
        expect(r.json()).toMatchObject({ error: "not_proposed", failedId: bad });
      }
    }
    expect(await statusOf(ids.bP2)).toBe("proposed"); // the good one in the set was not decided
  });

  it("approving two months supersedes each month's earlier approved row only; the earlier month stays approved; ids may come in any order", async () => {
    // existing approved rows for one KPI: December (earlier), January and February
    const olds = (
      await proposeBatch(
        { unitNodeId: "d-web", items: [item("client-site-uptime", "2026-12-01", 0.9, 0.05), item("client-site-uptime", "2027-01-01", 0.9, 0.05), item("client-site-uptime", "2027-02-01", 0.9, 0.05)] },
        webHead,
      )
    ).json().ids as string[];
    const approvedOlds = await decideBatch({ decision: "approve", ids: olds }, admin);
    expect(approvedOlds.statusCode).toBe(200);
    expect(approvedOlds.json().decided.map((d: { status: string }) => d.status)).toEqual(["approved", "approved", "approved"]);
    const [oDec, oJan, oFeb] = olds;

    // new proposals for January and February, approved in ONE decision with February first
    const news = (
      await proposeBatch({ unitNodeId: "d-web", items: [item("client-site-uptime", "2027-01-01", 0.95, 0.05), item("client-site-uptime", "2027-02-01", 0.96, 0.05)] }, webHead)
    ).json().ids as string[];
    const [nJan, nFeb] = news;
    const r = await decideBatch({ decision: "approve", ids: [nFeb, nJan], note: "plan" }, admin2);
    expect(r.statusCode).toBe(200);
    const decided = r.json().decided as Array<{ id: string; status: string; superseded: string[] }>;
    // the answer is in the order given
    expect(decided.map((d) => [d.id, d.status])).toEqual([[nFeb, "approved"], [nJan, "approved"]]);
    // January is decided before February whatever the order given, so February's approval cannot supersede January's new row;
    // January's approval supersedes the approved rows from January ON (the old January and the old February)
    expect(decided.find((d) => d.id === nJan)!.superseded).toEqual([oJan, oFeb].sort());
    expect(decided.find((d) => d.id === nFeb)!.superseded).toEqual([]);

    expect(await statusOf(nJan)).toBe("approved");
    expect(await statusOf(nFeb)).toBe("approved");
    expect(await statusOf(oJan)).toBe("superseded");
    expect(await statusOf(oFeb)).toBe("superseded");
    expect(await statusOf(oDec)).toBe("approved"); // the earlier month is untouched
    // one approved row per (unit, KPI, month): the database agrees (December, new January, new February)
    expect(await countRows(`unit_node_id = 'd-web' AND kpi_key = 'client-site-uptime' AND status = 'approved' AND effective_from >= '2026-12-01' AND effective_from < '2027-03-01'`)).toBe(3);
    const row = await rowOf(nJan);
    expect(row).toMatchObject({ status: "approved", decided_by: admin2 });

    // the activity rows are written per id
    for (const id of [nJan, nFeb]) expect(await verbsOf(id)).toEqual(["proposed", "approved"]);
    const meta = await withTenants([co], async (c) =>
      (await c.query<{ metadata: { superseded?: string[]; note?: string } }>(
        `SELECT metadata FROM activities WHERE tenant_id = $1 AND target_entity_id = $2 AND verb = 'approved'`, [co, nJan])).rows[0].metadata);
    expect(meta.superseded).toEqual([oJan, oFeb].sort());
    expect(meta.note).toBe("plan");
    for (const id of olds) expect(await verbsOf(id)).toEqual(["proposed", "approved"]);
  });

  it("a batch reject decides every row, writes a `rejected` activity per id, and supersedes nothing", async () => {
    const two = (await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2028-01-01", 0.8), item("projects-on-time", "2028-02-01", 0.8)] }, webHead)).json().ids as string[];
    const r = await decideBatch({ decision: "reject", ids: two, note: "not this year" }, admin);
    expect(r.statusCode).toBe(200);
    expect(r.json().decided).toEqual(two.map((id) => ({ id, status: "rejected", superseded: [] })));
    for (const id of two) {
      expect(await statusOf(id)).toBe("rejected");
      expect(await verbsOf(id)).toEqual(["proposed", "rejected"]);
    }
  });

  it("all or nothing at the database: an id that cannot be decided rolls every earlier decision and supersession back (decideTargetsAtomically)", async () => {
    const two = (await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2028-03-01", 0.8), item("projects-on-time", "2028-04-01", 0.8)] }, webHead)).json().ids as string[];
    const ghost = newId();
    const failed = await decideTargetsAtomically(co, [two[0], two[1], ghost], "approve", admin);
    expect(failed).toEqual({ ok: false, failedId: ghost, reason: "not_found" });
    for (const id of two) expect(await statusOf(id)).toBe("proposed");

    // a row that is no longer proposed (a race lost after the controller's check) aborts the same way
    const done = (await proposeBatch({ unitNodeId: "d-web", items: [item("projects-on-time", "2028-05-01", 0.8)] }, webHead)).json().ids[0] as string;
    expect((await decideBatch({ decision: "reject", ids: [done] }, admin)).statusCode).toBe(200);
    const lost = await decideTargetsAtomically(co, [two[0], done], "approve", admin);
    expect(lost).toEqual({ ok: false, failedId: done, reason: "not_proposed" });
    expect(await statusOf(two[0])).toBe("proposed");

    const ok = await decideTargetsAtomically(co, two, "approve", admin);
    expect(ok.ok).toBe(true);
    for (const id of two) expect(await statusOf(id)).toBe("approved");
  });

  // ═══════════════════════════════ no regression ═══════════════════════════════

  it("the single routes keep their shape next to the batch: a single propose answers {id, status} and the single approve its row", async () => {
    const p = await propose({ unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2028-06-01", target: 0.8, tolerance: 0.05 }, webHead);
    expect(p.statusCode).toBe(201);
    expect(Object.keys(p.json()).sort()).toEqual(["id", "status"]);
    const a = await approve(p.json().id, admin);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ id: p.json().id, status: "approved", superseded: [] });
    // and the single approve of a row already decided is still 409 not_proposed, with no failedId (that is the batch's)
    const again = await approve(p.json().id, admin2);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "not_proposed" });
  });
});
