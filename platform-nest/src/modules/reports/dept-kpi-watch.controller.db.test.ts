// DW-4j-1 — the head is made aware, over live Postgres + RLS + Cerbos (docs/FRONTEND-BFF-CONTRACT.md §43; PERMISSION-CONTRACT
// §38b). The run is driven through the service with an injected `now` (the HTTP route takes none), so every month is pinned
// and the suite does not depend on the wall clock; the routes are driven through buildApp + app.inject. Covers §43's proof
// list, live half:
//   * the recipients are the exact-node `org_unit_lead` holders (not an enclosing unit's head, not a placed manager, not a
//     lapsed grant, not a non-member), pinned against the forward direction (`loadLedUnitScope`); a unit with no head is
//     listed in `unitsWithoutHead`;
//   * a first run stores and tells nothing, and opens alerts for KPIs already off track;
//   * an approved target that puts a KPI off track: one notification per head and one alert; the same run again tells nothing;
//   * the KPI back within tolerance tells "back" and resolves the alert;
//   * a new month with no data is silent; its first real reading is told;
//   * two concurrent runs tell once;
//   * no notification payload carries a person's name;
//   * the rows are really visible and written under the tenant AND the reports module wall;
//   * the alerts read: a head sees only their own units' open, unacknowledged alerts, a non-head gets []; the unit-scoped read
//     follows the unit gate;
//   * acknowledge: the head 200, another unit's head 403, twice 409, a resolved alert 409, unknown 404, a bad note 400;
//   * `watch` by a non-admin is 403 and by an admin 200 (and a second run in a row tells nothing).
// The change rule, the text and the open/resolve decision are pinned in dept-kpi-watch.test.ts (pure).
//
// The org tree is written in the REAL stored shape (`{root: ...}`) and the closure is built with the PRODUCTION builder.
// Values are September and October 2026 milestones, which the report reads live from pm_milestones, so no fact job is needed.
// Targets are written straight into dept_kpi_targets as approved rows (the 4e-1 suite proves the propose/approve flow).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withGlobal, withTenants } from "../../db";
import { adminPool, initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { assemblePrincipal } from "../../rbac/principal";
import { loadLedUnitScope, todayIsoInTz } from "./person-scope";
import { WATCH_NOTIFICATION_TYPE, loadUnitLeadUserIds, runDeptKpiWatch } from "./dept-kpi-watch";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const SEP = new Date("2026-09-15T12:00:00Z");
const OCT = new Date("2026-10-15T12:00:00Z");

describe.skipIf(!TEST_URL)("DW-4j-1 the KPI watch (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string; // a second company, for the RLS wall
  let admin: string; // company_admin: the run's gate, and the company-wide tier
  let webHead: string; // org_unit_lead @ d-web + manager + member, placed in d-web (the real head shape)
  let webHead2: string; // a second head of d-web
  let genHead: string; // org_unit_lead @ d-gen + manager + member
  let gmHead: string; // org_unit_lead @ d-corp (an ENCLOSING unit of every department) + manager
  let webMgr: string; // manager placed in d-web, no org_unit_lead
  let lapsedHead: string; // org_unit_lead @ d-web whose grant EXPIRED
  let ghostHead: string; // org_unit_lead @ d-gen, but not a member of the company
  let webStaff: string; // member, placed in d-web
  let seoStaff: string; // member, placed in d-seo
  let outsider: string; // no roles at all
  const NAMES: Record<string, string> = {};

  const place = (userId: string, unit: string) =>
    withTenants([co], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4,true,'2020-01-01','manual',$5)`,
        [newId(), co, userId, unit, config.originSite],
      ),
    );
  const user = async (email: string, name: string): Promise<string> => {
    const id = await createUser(email, name);
    NAMES[id] = name;
    return id;
  };
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
  const approvedTarget = async (unit: string, kpi: string, from: string, target: number, tolerance: number): Promise<string> => {
    const id = newId();
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO dept_kpi_targets (id, tenant_id, unit_node_id, kpi_key, effective_from, target, tolerance, status, proposed_by,
                                         decided_by, decided_at, origin_site)
           VALUES ($1,$2,$3,$4,$5::date,$6,$7,'approved',$8,$8,now(),$9)`,
          [id, co, unit, kpi, from, target, tolerance, admin, config.originSite],
        ),
      { modules: ["reports"] },
    );
    return id;
  };
  const setTarget = (id: string, target: number) =>
    withTenants([co], (c) => c.query(`UPDATE dept_kpi_targets SET target = $2 WHERE id = $1`, [id, target]), { modules: ["reports"] });

  // the memory and the alerts, as the tenant sees them under the module wall
  const memory = () =>
    withTenants(
      [co],
      async (c) =>
        (await c.query<{ unit_node_id: string; kpi_key: string; condition: string; reason: string | null }>(
          `SELECT unit_node_id, kpi_key, condition, reason FROM dept_kpi_conditions WHERE tenant_id = $1 ORDER BY unit_node_id, kpi_key`,
          [co],
        )).rows,
      { modules: ["reports"] },
    );
  const alertRows = () =>
    withTenants(
      [co],
      async (c) =>
        (await c.query<{ id: string; unit_node_id: string; kpi_key: string; acknowledged_at: Date | null; resolved_at: Date | null; resolved_condition: string | null }>(
          `SELECT id, unit_node_id, kpi_key, acknowledged_at, resolved_at, resolved_condition FROM dept_kpi_alerts WHERE tenant_id = $1 ORDER BY unit_node_id, kpi_key, opened_at`,
          [co],
        )).rows,
      { modules: ["reports"] },
    );
  const notes = async (): Promise<Array<{ user_id: string; payload: Record<string, unknown> }>> =>
    (await adminPool().query(`SELECT user_id, payload FROM notifications WHERE tenant_id = $1 AND type = $2 ORDER BY created_at, id`, [co, WATCH_NOTIFICATION_TYPE])).rows;
  const reset = async () => {
    await withTenants(
      [co],
      async (c) => {
        await c.query(`DELETE FROM dept_kpi_alerts WHERE tenant_id = $1`, [co]);
        await c.query(`DELETE FROM dept_kpi_conditions WHERE tenant_id = $1`, [co]);
      },
      { modules: ["reports"] },
    );
    await adminPool().query(`DELETE FROM notifications WHERE tenant_id = $1 AND type = $2`, [co, WATCH_NOTIFICATION_TYPE]);
  };
  const run = (now: Date) => runDeptKpiWatch(co, now);

  const watch = (as: string) => app.inject({ method: "POST", url: `/api/${co}/dept-kpis/watch`, headers: asUser(as) });
  const alerts = (as: string, unit?: string) =>
    app.inject({ method: "GET", url: `/api/${co}/dept-kpis/alerts${unit !== undefined ? `?unitNodeId=${unit}` : ""}`, headers: asUser(as) });
  const ack = (id: string, body: unknown, as: string) =>
    app.inject({ method: "POST", url: `/api/${co}/dept-kpis/alerts/${id}/acknowledge`, headers: asUser(as), payload: body as object });

  let w0: string; // d-web's approved target row from 2026-08-01 (0.8 +/- 0.05)
  let w1: string; // d-web's approved target row from 2026-09-01

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("DW-4j Co", ["reports", "pm", "hr"]);
    other = await createCompany("DW-4j Other", ["reports"]);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [co]));

    admin = await user("admin@dw4j.test", "Putu Admin");
    webHead = await user("web-head@dw4j.test", "Wayan Pratama");
    webHead2 = await user("web-head2@dw4j.test", "Komang Dewi");
    genHead = await user("gen-head@dw4j.test", "Gede Arya");
    gmHead = await user("gm-head@dw4j.test", "Made Surya");
    webMgr = await user("web-mgr@dw4j.test", "Nyoman Adi");
    lapsedHead = await user("lapsed-head@dw4j.test", "Ketut Sari");
    ghostHead = await user("ghost-head@dw4j.test", "Luh Ayu");
    webStaff = await user("web-staff@dw4j.test", "Bagus Wirawan");
    seoStaff = await user("seo-staff@dw4j.test", "Ni Rai");
    outsider = await user("outsider@dw4j.test", "Dewa Outsider");
    const members = [admin, webHead, webHead2, genHead, gmHead, webMgr, lapsedHead, webStaff, seoStaff];
    for (const u of members) await addMembership(co, u); // ghostHead and outsider are NOT members

    const member = await createRole("member");
    const manager = await createRole("manager");
    const lead = await createRole("org_unit_lead");
    for (const u of members) await grantRole(u, member, "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    for (const u of [webHead, webHead2, genHead, gmHead, webMgr]) await grantRole(u, manager, "company", co);
    await grantRole(webHead, lead, "org_unit", "d-web");
    await grantRole(webHead2, lead, "org_unit", "d-web");
    await grantRole(genHead, lead, "org_unit", "d-gen");
    await grantRole(gmHead, lead, "org_unit", "d-corp");
    await grantRole(ghostHead, lead, "org_unit", "d-gen");
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, expires_at) VALUES ($1, $2, $3, 'org_unit', 'd-web', now() - interval '1 day')`, [
        newId(), lapsedHead, lead,
      ]),
    );

    const root = {
      id: "d-corp",
      kind: "company",
      name: "DW-4j Co",
      children: [
        { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
        { id: "d-gen", kind: "department", name: "Delivery", children: [] },
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
    for (const u of [webHead, webHead2, webMgr, webStaff]) await place(u, "d-web");
    await place(genHead, "d-gen");
    await place(seoStaff, "d-seo");

    // September 2026: Web Dev 4 of 5 (0.8), Delivery 4 of 5 (0.8). Targets: Web Dev 0.8 (on track from August), Delivery 0.95
    // (off track from the start). October has NO milestones until a test adds them.
    await milestones("d-web", "2026-09-02", 5, 4);
    await milestones("d-gen", "2026-09-02", 5, 4);
    w0 = await approvedTarget("d-web", "projects-on-time", "2026-08-01", 0.8, 0.05);
    await approvedTarget("d-gen", "projects-on-time", "2026-08-01", 0.95, 0.05);

    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ recipients (§43.1) ═══════════════════════════════

  it("the recipients are the exact-node org_unit_lead holders: sorted, distinct, current, active members only", async () => {
    const web = await loadUnitLeadUserIds(co, "d-web");
    expect(web).toEqual([webHead, webHead2].sort());
    // not an enclosing unit's head, not a manager placed in the unit, not a lapsed grant, not plain staff
    for (const not of [gmHead, webMgr, lapsedHead, webStaff, admin]) expect(web).not.toContain(not);
    // a division of d-web is a different node: its department's head is not ITS exact head
    expect(await loadUnitLeadUserIds(co, "dv-fe")).toEqual([]);
    // a grant held by a user who is not a member of this company never reaches it (a node id two companies share)
    expect(await loadUnitLeadUserIds(co, "d-gen")).toEqual([genHead]);
    expect(await loadUnitLeadUserIds(co, "d-seo")).toEqual([]);
    expect(await loadUnitLeadUserIds(co, "d-corp")).toEqual([gmHead]);
  });

  it("pinned against the forward direction: every returned head has the unit in loadLedUnitScope; the exactness is deliberate", async () => {
    const asOf = todayIsoInTz(config.reportsTz);
    const scopeOf = async (userId: string) => {
      const principal = await assemblePrincipal(userId, "high");
      expect(principal).toBeTruthy();
      return withTenants([co], (c) => loadLedUnitScope(c, co, userId, asOf, principal!), { modules: ["reports", "pm", "hr"] });
    };
    for (const unit of ["d-web", "d-gen", "d-corp"]) {
      for (const u of await loadUnitLeadUserIds(co, unit)) expect((await scopeOf(u)).has(unit)).toBe(true);
    }
    // the forward direction is WIDER (an enclosing head and a placed manager lead d-web's subtree): they are not told
    expect((await scopeOf(gmHead)).has("d-web")).toBe(true);
    expect((await scopeOf(webMgr)).has("d-web")).toBe(true);
    expect(await loadUnitLeadUserIds(co, "d-web")).not.toContain(gmHead);
    expect(await loadUnitLeadUserIds(co, "d-web")).not.toContain(webMgr);
  });

  // ═══════════════════════════════ the run (§43.4, §43.6) ═══════════════════════════════

  it("the first run stores and tells nothing, and opens an alert for a KPI that is ALREADY off track", async () => {
    await reset();
    const r = await run(SEP);
    expect(r.period).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(r.evaluatedUnits).toBe(3);
    expect(r.told).toEqual([]);
    expect(r.alertsOpened).toBe(1);
    expect(r.alertsResolved).toBe(0);
    expect(r.unitsWithoutHead).toEqual(["d-seo"]); // d-web and d-gen have heads; d-seo has none
    expect(await notes()).toEqual([]);

    // The memory was written and is visible under the tenant + reports module wall: one row per (unit, KPI) and the unit's own.
    const rows = await memory();
    const cond = (unit: string, key: string) => rows.find((x) => x.unit_node_id === unit && x.kpi_key === key)?.condition;
    expect(cond("d-web", "projects-on-time")).toBe("on_track");
    expect(cond("d-web", "*")).toBe("on_track");
    expect(cond("d-gen", "projects-on-time")).toBe("off_track");
    expect(cond("d-gen", "*")).toBe("off_track");
    expect(cond("d-seo", "*")).toBe("unavailable");
    expect(rows.find((x) => x.unit_node_id === "d-web" && x.kpi_key === "reopened-work-rate")).toMatchObject({ condition: "unavailable", reason: "no_target" });

    const open = await alertRows();
    expect(open.map((a) => [a.unit_node_id, a.kpi_key, a.acknowledged_at, a.resolved_at])).toEqual([["d-gen", "projects-on-time", null, null]]);
  });

  it("the tables sit behind the tenant wall AND the reports module wall; their constraints hold", async () => {
    const withReports = await withTenants([co], async (c) => (await c.query(`SELECT 1 FROM dept_kpi_conditions`)).rows.length, { modules: ["reports"] });
    expect(withReports).toBeGreaterThan(0);
    const withoutModule = await withTenants([co], async (c) => (await c.query(`SELECT 1 FROM dept_kpi_conditions`)).rows.length);
    expect(withoutModule).toBe(0);
    const otherTenant = await withTenants([other], async (c) => (await c.query(`SELECT 1 FROM dept_kpi_conditions`)).rows.length, { modules: ["reports"] });
    expect(otherTenant).toBe(0);
    expect(await withTenants([co], async (c) => (await c.query(`SELECT 1 FROM dept_kpi_alerts`)).rows.length)).toBe(0);
    expect(await withTenants([other], async (c) => (await c.query(`SELECT 1 FROM dept_kpi_alerts`)).rows.length, { modules: ["reports"] })).toBe(0);

    const insertAlert = (key: string, noteLength?: number) =>
      adminPool().query(
        `INSERT INTO dept_kpi_alerts (id, tenant_id, unit_node_id, kpi_key, period_start, ack_note, origin_site)
         VALUES ($1, $2, 'd-gen', $3, '2026-09-01', $4, $5)`,
        [newId(), co, key, noteLength ? "x".repeat(noteLength) : null, config.originSite],
      );
    // one OPEN alert per (unit, KPI): d-gen/projects-on-time is already open
    await expect(insertAlert("projects-on-time")).rejects.toThrow(/ux_dept_kpi_alerts_open/);
    // the department sentinel is never an alert's KPI
    await expect(insertAlert("*")).rejects.toThrow();
    // a note over 1000 characters, and half an acknowledgement, are refused by the table
    await expect(insertAlert("overdue-tasks", 1001)).rejects.toThrow();
    await expect(
      adminPool().query(`UPDATE dept_kpi_alerts SET acknowledged_by = $2 WHERE tenant_id = $1`, [co, admin]),
    ).rejects.toThrow(/dept_kpi_alerts_ack_whole_ck/);
    // NULL cannot defeat the memory's unique key: kpi_key is NOT NULL
    await expect(
      adminPool().query(
        `INSERT INTO dept_kpi_conditions (tenant_id, unit_node_id, kpi_key, period_start, condition, origin_site) VALUES ($1,'d-web',NULL,'2026-09-01','on_track',$2)`,
        [co, config.originSite],
      ),
    ).rejects.toThrow();
  });

  it("the same run again tells nothing and opens no second alert", async () => {
    const r = await run(SEP);
    expect(r.told).toEqual([]);
    expect(r.alertsOpened).toBe(0);
    expect(r.alertsResolved).toBe(0);
    expect(await notes()).toEqual([]);
    expect(await alertRows()).toHaveLength(1);
  });

  it("an approved target that puts a KPI off track: ONE notification per head and one alert; the same run again tells nothing", async () => {
    w1 = await approvedTarget("d-web", "projects-on-time", "2026-09-01", 0.95, 0.05); // 0.8 against 0.95 +/- 0.05: off track
    const r = await run(SEP);
    expect(r.told).toEqual([{ unitNodeId: "d-web", recipients: 2, changes: 2 }]); // the KPI and the department
    expect(r.alertsOpened).toBe(1);
    expect(r.alertsResolved).toBe(0);

    const sent = await notes();
    expect(sent.map((n) => n.user_id).sort()).toEqual([webHead, webHead2].sort()); // each head once; nobody else
    for (const n of sent) {
      expect(n.payload).toMatchObject({
        title: "Web Dev: off track",
        body: "Projects on time: on track → off track (80% against 95%)\nDepartment: on track → off track",
        href: "/appraisals/department?unit=d-web",
        severity: "critical",
        actorId: null,
      });
      expect(n.payload).not.toHaveProperty("entityType");
      expect(n.payload).not.toHaveProperty("entityId");
    }
    expect((await alertRows()).filter((a) => a.unit_node_id === "d-web" && a.resolved_at === null)).toHaveLength(1);

    const again = await run(SEP);
    expect(again.told).toEqual([]);
    expect(again.alertsOpened).toBe(0);
    expect(await notes()).toHaveLength(2);
  });

  it("the KPI back within tolerance tells 'back' (info) and resolves the alert", async () => {
    await setTarget(w1, 0.7); // 0.8 against 0.7: on track again
    const r = await run(SEP);
    expect(r.told).toEqual([{ unitNodeId: "d-web", recipients: 2, changes: 2 }]);
    expect(r.alertsResolved).toBe(1);
    const sent = await notes();
    expect(sent).toHaveLength(4);
    const back = sent.slice(2);
    expect(back.map((n) => n.user_id).sort()).toEqual([webHead, webHead2].sort());
    for (const n of back) {
      expect(n.payload).toMatchObject({
        title: "Web Dev: on track",
        body: "Projects on time: off track → on track (80% against 70%)\nDepartment: off track → on track",
        severity: "info",
      });
    }
    const web = (await alertRows()).filter((a) => a.unit_node_id === "d-web");
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({ resolved_condition: "on_track" });
    expect(web[0].resolved_at).not.toBeNull();
    // Delivery's alert is untouched: still off track, still open
    expect((await alertRows()).find((a) => a.unit_node_id === "d-gen")?.resolved_at).toBeNull();
  });

  it("a new month with no data is silent (and resolves the alert as unavailable); its first real reading IS told", async () => {
    const before = (await notes()).length;
    const r = await run(OCT); // October: no milestones yet, so every KPI reads unavailable
    expect(r.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(r.told).toEqual([]);
    expect(r.alertsOpened).toBe(0);
    expect(r.alertsResolved).toBe(1); // Delivery's alert: no longer off track
    expect((await notes()).length).toBe(before);
    expect((await alertRows()).find((a) => a.unit_node_id === "d-gen")).toMatchObject({ resolved_condition: "unavailable" });
    expect((await memory()).find((m) => m.unit_node_id === "d-web" && m.kpi_key === "projects-on-time")?.condition).toBe("unavailable");

    // October's first data turns Web Dev off track (1 of 5 against 0.7): unavailable -> off track is told.
    await milestones("d-web", "2026-10-02", 5, 1);
    const real = await run(OCT);
    expect(real.told).toEqual([{ unitNodeId: "d-web", recipients: 2, changes: 2 }]);
    expect(real.alertsOpened).toBe(1);
    const last = (await notes()).slice(before);
    expect(last).toHaveLength(2);
    expect(last[0].payload).toMatchObject({
      title: "Web Dev: off track",
      body: "Projects on time: unavailable → off track (20% against 70%)\nDepartment: unavailable → off track",
      severity: "critical",
    });
  });

  it("two concurrent runs tell once", async () => {
    await reset();
    await run(SEP); // first run: stores
    await setTarget(w1, 0.95); // now 0.8 against 0.95: off track, for the two runs below
    const [a, b] = await Promise.all([run(SEP), run(SEP)]);
    expect([...a.told, ...b.told]).toEqual([{ unitNodeId: "d-web", recipients: 2, changes: 2 }]);
    expect(a.alertsOpened + b.alertsOpened).toBe(1);
    const sent = await notes();
    expect(sent).toHaveLength(2); // one per head, not four
    expect(sent.map((n) => n.user_id).sort()).toEqual([webHead, webHead2].sort());
    const third = await run(SEP);
    expect(third.told).toEqual([]);
    expect(await notes()).toHaveLength(2);
  });

  it("no notification payload carries a person's name", async () => {
    const all = JSON.stringify((await adminPool().query(`SELECT payload FROM notifications WHERE tenant_id = $1`, [co])).rows).toLowerCase();
    expect((await notes()).length).toBeGreaterThan(0);
    for (const name of Object.values(NAMES)) {
      expect(all).not.toContain(name.toLowerCase());
      for (const part of name.split(" ").filter((x) => x.length >= 4)) expect(all).not.toContain(part.toLowerCase());
    }
    for (const email of ["@dw4j.test"]) expect(all).not.toContain(email);
  });

  // ═══════════════════════════════ the route's gate (§43.6) ═══════════════════════════════

  it("watch: a non-admin is 403 (a manager, a head, plain staff); the company_admin is 200 and a second run tells nothing", async () => {
    for (const who of [webMgr, webHead, gmHead, webStaff, outsider]) expect((await watch(who)).statusCode).toBe(403);
    await reset();
    const first = await watch(admin);
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(Object.keys(body).sort()).toEqual(["alertsOpened", "alertsResolved", "evaluatedUnits", "period", "told", "unitsWithoutHead"]);
    expect(body.period.start).toBe(`${todayIsoInTz(config.reportsTz).slice(0, 7)}-01`);
    expect(body.evaluatedUnits).toBe(3);
    expect(body.told).toEqual([]); // a first run (after the reset) tells nothing, whatever the real month holds
    expect(body.unitsWithoutHead).toEqual(["d-seo"]);
    const second = await watch(admin);
    expect(second.statusCode).toBe(200);
    expect(second.json().told).toEqual([]);
    expect(second.json().alertsOpened).toBe(0);
    await reset();
  });

  // ═══════════════════════════════ the alerts read (§43.5) ═══════════════════════════════

  describe("alerts: read and acknowledge", () => {
    const ids: Record<string, string> = {};
    const insert = async (name: string, unit: string, kpi: string, openedAt: string, extra: Partial<{ ackBy: string; ackNote: string; resolved: string }> = {}) => {
      const id = newId();
      ids[name] = id;
      await withTenants(
        [co],
        (c) =>
          c.query(
            `INSERT INTO dept_kpi_alerts (id, tenant_id, unit_node_id, kpi_key, opened_at, period_start, value, target,
                                          acknowledged_by, acknowledged_at, ack_note, resolved_at, resolved_condition, origin_site)
             VALUES ($1,$2,$3,$4,$5::timestamptz,'2026-10-01',0.5,0.85,$6,$7,$8,$9,$10,$11)`,
            [
              id, co, unit, kpi, openedAt,
              extra.ackBy ?? null, extra.ackBy ? "2026-10-04T08:00:00Z" : null, extra.ackNote ?? null,
              extra.resolved ?? null, extra.resolved ? "on_track" : null, config.originSite,
            ],
          ),
        { modules: ["reports"] },
      );
    };

    beforeAll(async () => {
      await reset();
      await insert("web", "d-web", "projects-on-time", "2026-10-03T08:00:00Z");
      await insert("webAck", "d-web", "reopened-work-rate", "2026-10-02T08:00:00Z", { ackBy: webHead, ackNote: "on it" });
      await insert("webRes", "d-web", "projects-on-time", "2026-09-01T08:00:00Z", { resolved: "2026-09-20T08:00:00Z" });
      await insert("gen", "d-gen", "projects-on-time", "2026-10-03T09:00:00Z");
      await insert("gen2", "d-gen", "check-in-compliance", "2026-10-05T09:00:00Z");
    });

    const idsOf = (r: { json: () => { alerts: Array<{ id: string }> } }) => r.json().alerts.map((a) => a.id);

    it("a head reads only their own units' open, unacknowledged alerts (newest first)", async () => {
      const w = await alerts(webHead);
      expect(w.statusCode).toBe(200);
      expect(idsOf(w)).toEqual([ids.web]);
      expect(idsOf(await alerts(webHead2))).toEqual([ids.web]);
      expect(idsOf(await alerts(genHead))).toEqual([ids.gen2, ids.gen]);
    });

    it("the row is the contract's shape, with the KPI's label and unit and the unit's name", async () => {
      const [row] = (await alerts(webHead)).json().alerts;
      expect(Object.keys(row).sort()).toEqual([
        "ackNote", "acknowledgedAt", "acknowledgedBy", "acknowledgedByName", "id", "kpiKey", "kpiLabel", "kpiUnit", "openedAt",
        "periodStart", "resolvedAt", "resolvedCondition", "target", "unit", "value",
      ]);
      expect(row).toMatchObject({
        id: ids.web,
        unit: { id: "d-web", name: "Web Dev" },
        kpiKey: "projects-on-time",
        kpiLabel: "Projects on time",
        kpiUnit: "percent",
        periodStart: "2026-10-01",
        openedAt: "2026-10-03T08:00:00.000Z",
        value: 0.5,
        target: 0.85,
        acknowledgedBy: null,
        acknowledgedByName: null,
        acknowledgedAt: null,
        ackNote: null,
        resolvedAt: null,
        resolvedCondition: null,
      });
    });

    it("a caller who heads no unit gets 200 { alerts: [] }: staff, a placed manager, an enclosing head, the admin", async () => {
      for (const who of [webStaff, seoStaff, webMgr, gmHead, admin, lapsedHead]) {
        const r = await alerts(who);
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual({ alerts: [] });
      }
    });

    it("a caller outside the company (no role) is refused by Cerbos before anything is read", async () => {
      expect((await alerts(outsider)).statusCode).toBe(403);
      expect((await alerts(outsider, "d-web")).statusCode).toBe(403);
    });

    it("the unit-scoped read follows the unit gate: placed staff, a head and the admin read; another unit's staff and head do not", async () => {
      for (const who of [webStaff, webHead, webMgr, admin, gmHead]) {
        const r = await alerts(who, "d-web");
        expect(r.statusCode, `as ${NAMES[who]}`).toBe(200);
        expect(idsOf(r)).toEqual([ids.web, ids.webAck, ids.webRes]); // every state, newest first
      }
      expect((await alerts(seoStaff, "d-web")).statusCode).toBe(403);
      expect((await alerts(genHead, "d-web")).statusCode).toBe(403);
      expect((await alerts(admin, "d-nowhere")).statusCode).toBe(404);
      expect((await alerts(admin, "d-nowhere")).json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
      expect((await alerts(admin, "")).statusCode).toBe(400);
      const rows = (await alerts(webHead, "d-web")).json().alerts;
      expect(rows[1]).toMatchObject({ id: ids.webAck, acknowledgedBy: webHead, acknowledgedByName: "Wayan Pratama", ackNote: "on it" });
      expect(rows[2]).toMatchObject({ id: ids.webRes, resolvedCondition: "on_track" });
    });

    it("acknowledge: another unit's head, plain staff and a non-head are refused (403), whatever the alert's state", async () => {
      for (const who of [genHead, seoStaff, webStaff, webMgr, gmHead, lapsedHead]) {
        const r = await ack(ids.web, {}, who);
        expect(r.statusCode, `as ${NAMES[who]}`).toBe(403);
      }
      // a denial is about the caller, not the state: another unit's head is refused on a resolved alert too (never a 409)
      expect((await ack(ids.webRes, {}, genHead)).statusCode).toBe(403);
      expect((await ack(ids.web, {}, outsider)).statusCode).toBe(403);
      expect((await alerts(webHead)).json().alerts.map((a: { id: string }) => a.id)).toEqual([ids.web]); // nothing was acknowledged
    });

    it("acknowledge: an unknown or malformed id is 404 alert_not_found", async () => {
      const missing = await ack(newId(), {}, webHead);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: "alert_not_found" });
      expect((await ack("not-a-uuid", {}, webHead)).statusCode).toBe(404);
    });

    it("acknowledge: a resolved alert is 409 resolved; an acknowledged one is 409 already_acknowledged", async () => {
      const res = await ack(ids.webRes, {}, webHead);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "resolved" });
      const twice = await ack(ids.webAck, {}, webHead);
      expect(twice.statusCode).toBe(409);
      expect(twice.json()).toMatchObject({ error: "already_acknowledged" });
    });

    it("acknowledge: a bad note is 400 field note (after authz and state), and stores nothing", async () => {
      for (const note of ["x".repeat(1001), 123, { a: 1 }]) {
        const r = await ack(ids.web, { note }, webHead);
        expect(r.statusCode).toBe(400);
        expect(r.json()).toMatchObject({ field: "note" });
      }
      // validation never pre-empts authz: the same bad body from another unit's head is a 403
      expect((await ack(ids.web, { note: "x".repeat(1001) }, genHead)).statusCode).toBe(403);
      expect((await alertRows()).find((a) => a.id === ids.web)?.acknowledged_at).toBeNull();
    });

    it("acknowledge: a head of the unit gets 200 with the alert, an activity row without the note; twice is 409; it leaves Needs you but stays open", async () => {
      const r = await ack(ids.web, { note: "  looking into it  " }, webHead);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        id: ids.web,
        acknowledgedBy: webHead,
        acknowledgedByName: "Wayan Pratama",
        ackNote: "looking into it",
        resolvedAt: null,
      });
      expect(r.json().acknowledgedAt).toEqual(expect.any(String));

      const log = await adminPool().query(
        `SELECT verb, metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'dept_kpi_alert' AND target_entity_id = $2`,
        [co, ids.web],
      );
      expect(log.rows).toHaveLength(1);
      expect(log.rows[0].verb).toBe("acknowledged");
      expect(log.rows[0].metadata).toMatchObject({ unitNodeId: "d-web", kpiKey: "projects-on-time" });
      expect(JSON.stringify(log.rows[0].metadata)).not.toContain("looking into it");

      const again = await ack(ids.web, {}, webHead2); // a second head of the same unit
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "already_acknowledged" });

      expect(await alerts(webHead).then((x) => x.json())).toEqual({ alerts: [] }); // left Needs you
      const open = (await alertRows()).find((a) => a.id === ids.web);
      expect(open?.resolved_at).toBeNull(); // but stays open until the run resolves it
      expect(open?.acknowledged_at).not.toBeNull();
    });

    it("acknowledge: the company-wide tier may acknowledge any unit's alert; an empty note is stored as none", async () => {
      const r = await ack(ids.gen, { note: "   " }, admin);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id: ids.gen, acknowledgedBy: admin, ackNote: null });
      expect(idsOf(await alerts(genHead))).toEqual([ids.gen2]);
    });

    it("an acknowledged alert is resolved by the run when its KPI is no longer off track", async () => {
      // With the target back at 0.7, d-web's September 0.8 is on track, so a run resolves the open (and acknowledged) alert
      // on d-web/projects-on-time and keeps the acknowledgement on the row.
      await setTarget(w1, 0.7);
      await run(SEP);
      const row = (await alertRows()).find((a) => a.id === ids.web);
      expect(row?.resolved_at).not.toBeNull();
      expect(row?.acknowledged_at).not.toBeNull();
      expect((await ack(ids.web, {}, webHead)).json()).toMatchObject({ error: "resolved" });
    });
  });
});
