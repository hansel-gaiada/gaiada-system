// DW-4j-3 — the weekly digest and "behind the miss", over live Postgres + RLS + Cerbos (docs/FRONTEND-BFF-CONTRACT.md §43.8;
// PERMISSION-CONTRACT §38b). The digest is driven through the service with an injected `now` (the HTTP route takes none) and,
// for the route, with an explicit past `weekStart`, so the suite does not depend on the wall clock. Covers §43.8's proof list,
// live half:
//   * a digest is sent ONCE per head per department; a second run for the same week sends nothing (`alreadySent`); a different
//     week is a separate ledger row; two concurrent runs send once;
//   * a department with no head sends nothing, is listed, and is never claimed in the ledger;
//   * the payload agrees with `GET /dept-kpis?periodKind=week` for the week and the week before, and never carries a person's name;
//   * the ledger sits behind the tenant wall AND the reports module wall (rows are really visible and written), its constraints hold;
//   * `digest`: a non-admin is 403 (before the body), a bad `weekStart` is 400, the admin gets the contract's shape;
//   * the drivers read: the head 200, a placed member 403, another unit's head 403, a company-wide caller 200, an unknown unit 404
//     (403 first for a narrowed caller), a KPI outside the set 400, a module KPI with a reader `drivers: null, reason: "no_drivers"` (the pure test covers `no_reader`), projects on
//     time lists projects worst first with numerator and denominator, reopened work / overdue tasks / check-in compliance list the
//     unit's people worst first with the Team report's own numbers, a person with no miss is not listed, at most five; and the
//     gate answers exactly as the department appraisal's (the extracted function is the same).
// The text, the week arithmetic and the driver ordering are pinned in dept-kpi-digest.test.ts (pure).
//
// Seeded as dept-kpi-watch.controller.db.test.ts does (the real stored org shape, the production closure builder, milestones read
// live from pm_milestones, targets written as approved rows). Facts are written directly: one early row so no week in the test
// precedes the tenant's first fact date (a window before it reads "no data" for every report KPI), and the reopen rows of the
// roster. Weeks: 2026-09-28 to 2026-10-04 (the digest week) and 2026-09-21 to 2026-09-27 (the week before).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withGlobal, withTenants } from "../../db";
import { adminPool, initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { mondayOnOrBefore } from "./report-calendar";
import { todayIsoInTz } from "./person-scope";
import { DIGEST_NOTIFICATION_TYPE, buildDigestNotice, lastCompleteWeekStart, runDeptKpiDigest } from "./dept-kpi-digest";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const WEEK = "2026-09-28";
const WEEK_END = "2026-10-04";
const PREV_WEEK = "2026-09-21";
const NOW = new Date("2026-10-06T12:00:00Z"); // a Tuesday: the last complete week is WEEK

const DOWN = "▼";
const DOT = "·";

describe.skipIf(!TEST_URL)("DW-4j-3 the weekly digest and the drivers (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string; // a second company, for the RLS wall
  let admin: string; // company_admin: the digest's gate, and the company-wide tier
  let webHead: string; // org_unit_lead @ d-web + manager + member, placed in d-web
  let webHead2: string; // a second head of d-web
  let genHead: string; // org_unit_lead @ d-gen + manager + member, placed in d-gen
  let gmHead: string; // org_unit_lead @ d-corp (an ENCLOSING unit of every department)
  let webMgr: string; // manager placed in d-web, no org_unit_lead
  let webStaff: string; // member, placed in d-web (has reopen facts)
  let seoStaff: string; // member, placed in d-seo
  let outsider: string; // no roles at all, not a member
  const NAMES: Record<string, string> = {};
  const IDS: Record<string, string> = {}; // the roster people by first name

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
  /** A project of `unit` with `total` milestones due on `due`, `done` of them done. */
  const milestones = async (unit: string, projectName: string, due: string, total: number, done: number) => {
    const projectId = await createProject(co, projectName);
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
    return projectId;
  };
  const approvedTarget = async (unit: string, kpi: string, from: string, target: number, tolerance: number) =>
    withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO dept_kpi_targets (id, tenant_id, unit_node_id, kpi_key, effective_from, target, tolerance, status, proposed_by,
                                         decided_by, decided_at, origin_site)
           VALUES ($1,$2,$3,$4,$5::date,$6,$7,'approved',$8,$8,now(),$9)`,
          [newId(), co, unit, kpi, from, target, tolerance, admin, config.originSite],
        ),
      { modules: ["reports"] },
    );
  const fact = (userId: string, date: string, unit: string, completed: number, reopened: number) =>
    withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO report_work_facts (id, tenant_id, fact_date, user_id, unit_node_id, department_node_id, tasks_completed, tasks_reopened, origin_site)
           VALUES ($1,$2,$3::date,$4,$5,$5,$6,$7,$8)`,
          [newId(), co, date, userId, unit, completed, reopened, config.originSite],
        ),
      { modules: ["reports", "pm", "hr"] },
    );
  /** `n` open tasks due before the digest week, owned by `userId`, in a project of `unit`. */
  const overdueTasks = async (projectId: string, userId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const taskId = newId();
      await withTenants([co], async (c) => {
        await c.query(
          `INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, origin_site) VALUES ($1,$2,$3,'overdue','2026-09-15'::date,$4)`,
          [taskId, co, projectId, config.originSite],
        );
        await c.query(
          `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, valid_from, origin_site)
           VALUES ($1,$2,$3,'owner','person',$4,$5,'2026-01-01'::date,$6)`,
          [newId(), co, taskId, userId, userId, config.originSite],
        );
      });
    }
  };
  /** `n` submitted check-ins on the first `n` working days of the digest week. */
  const checkins = async (userId: string, n: number) => {
    const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].slice(0, n);
    for (const d of days) {
      await withTenants(
        [co],
        (c) =>
          c.query(
            `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, origin_site) VALUES ($1,$2,$3,$4::date,'submitted',$5)`,
            [newId(), co, userId, d, config.originSite],
          ),
        { modules: ["reports", "pm", "hr"] },
      );
    }
  };

  const ledger = () =>
    withTenants(
      [co],
      async (c) =>
        (await c.query<{ unit_node_id: string; week_start: string; recipients: number }>(
          `SELECT unit_node_id, week_start::text AS week_start, recipients FROM dept_kpi_digests WHERE tenant_id = $1 ORDER BY week_start, unit_node_id`,
          [co],
        )).rows,
      { modules: ["reports"] },
    );
  const notes = async (): Promise<Array<{ user_id: string; payload: Record<string, unknown> }>> =>
    (await adminPool().query(`SELECT user_id, payload FROM notifications WHERE tenant_id = $1 AND type = $2 ORDER BY created_at, id`, [co, DIGEST_NOTIFICATION_TYPE])).rows;
  const reset = async () => {
    await withTenants([co], (c) => c.query(`DELETE FROM dept_kpi_digests WHERE tenant_id = $1`, [co]), { modules: ["reports"] });
    await adminPool().query(`DELETE FROM notifications WHERE tenant_id = $1 AND type = $2`, [co, DIGEST_NOTIFICATION_TYPE]);
  };

  const digest = (as: string, body?: unknown) =>
    app.inject({ method: "POST", url: `/api/${co}/dept-kpis/digest`, headers: asUser(as), payload: (body ?? {}) as object });
  const drivers = (as: string, q: Record<string, string>) =>
    app.inject({ method: "GET", url: `/api/${co}/dept-kpis/drivers?${new URLSearchParams(q).toString()}`, headers: asUser(as) });
  const weekQ = (unit: string, kpi: string) => ({ unitNodeId: unit, kpiKey: kpi, periodKind: "week", start: WEEK });
  const kpisOf = (as: string, unit: string, start: string) =>
    app.inject({ method: "GET", url: `/api/${co}/dept-kpis?unitNodeId=${unit}&periodKind=week&start=${start}`, headers: asUser(as) });
  const personDoc = async (userId: string) => {
    const r = await app.inject({
      method: "GET",
      url: `/api/${co}/reports/document?grain=person&scopeRef=${userId}&periodKind=week&start=${WEEK}`,
      headers: asUser(admin),
    });
    expect(r.statusCode).toBe(200);
    return r.json() as { kpis: Array<{ metricKey: string; value: number; numerator?: number; denominator?: number }> };
  };
  const docKpi = (doc: Awaited<ReturnType<typeof personDoc>>, metricKey: string) => doc.kpis.find((k) => k.metricKey === metricKey)!;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("DW-4j-3 Co", ["reports", "pm", "hr"]);
    other = await createCompany("DW-4j-3 Other", ["reports"]);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [co]));

    admin = await user("admin@dw4j3.test", "Putu Admin");
    webHead = await user("web-head@dw4j3.test", "Wayan Pratama");
    webHead2 = await user("web-head2@dw4j3.test", "Komang Dewi");
    genHead = await user("gen-head@dw4j3.test", "Gede Arya");
    gmHead = await user("gm-head@dw4j3.test", "Made Surya");
    webMgr = await user("web-mgr@dw4j3.test", "Nyoman Adi");
    webStaff = await user("web-staff@dw4j3.test", "Bagus Wirawan");
    seoStaff = await user("seo-staff@dw4j3.test", "Ni Rai");
    outsider = await user("outsider@dw4j3.test", "Dewa Outsider");
    const roster: Array<[string, string, string]> = [
      ["ayu", "Ayu Lestari", "d-web"],
      ["budi", "Budi Santoso", "d-web"],
      ["cara", "Cara Wijaya", "d-web"],
      ["gita", "Gita Pratiwi", "d-gen"],
      ["hadi", "Hadi Kusuma", "d-gen"],
      ["indra", "Indra Gunawan", "d-gen"],
      ["joko", "Joko Susilo", "d-gen"],
      ["kiki", "Kiki Anggraini", "d-gen"],
      ["lala", "Lala Permata", "d-gen"],
      ["mira", "Mira Sari", "d-gen"],
    ];
    for (const [key, name] of roster) IDS[key] = await user(`${key}@dw4j3.test`, name);
    const members = [admin, webHead, webHead2, genHead, gmHead, webMgr, webStaff, seoStaff, ...Object.values(IDS)];
    for (const u of members) await addMembership(co, u); // outsider is NOT a member

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

    const root = {
      id: "d-corp",
      kind: "company",
      name: "DW-4j-3 Co",
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
    for (const u of [webHead, webHead2, webMgr, webStaff, IDS.ayu, IDS.budi, IDS.cara]) await place(u, "d-web");
    for (const u of [genHead, IDS.gita, IDS.hadi, IDS.indra, IDS.joko, IDS.kiki, IDS.lala, IDS.mira]) await place(u, "d-gen");
    await place(seoStaff, "d-seo");

    // Web Dev, the digest week: Alpha 1 of 3, Beta 3 of 3, Gamma 2 of 3 = 6 of 9 (67%); the week before: Delta 4 of 5 (80%).
    // Target 0.8 +/- 0.15: at risk. Delivery, the digest week: 1 of 4 (25%) against 0.9 +/- 0.05: off track; nothing the week before.
    IDS.alphaProject = await milestones("d-web", "Alpha", "2026-09-30", 3, 1);
    await milestones("d-web", "Beta", "2026-09-30", 3, 3);
    await milestones("d-web", "Gamma", "2026-09-30", 3, 2);
    await milestones("d-web", "Delta", "2026-09-23", 5, 4);
    const genProject = await milestones("d-gen", "Gen Project", "2026-09-30", 4, 1);
    await approvedTarget("d-web", "projects-on-time", "2026-08-01", 0.8, 0.15);
    await approvedTarget("d-gen", "projects-on-time", "2026-08-01", 0.9, 0.05);

    // Facts: ONE early row (so no window of the test precedes the first fact date), and the roster's reopen rows. Web Dev's
    // reopened-work-rate gets no target on purpose: its value exists and has none, which the digest sums up as "no target".
    await fact(seoStaff, "2026-09-01", "d-seo", 1, 0);
    await fact(seoStaff, "2026-09-30", "d-seo", 5, 5); // not in Web Dev's roster: never a driver there
    await fact(webStaff, "2026-09-30", "d-web", 4, 3);
    await fact(IDS.ayu, "2026-09-30", "d-web", 8, 2);
    await fact(IDS.budi, "2026-09-30", "d-web", 10, 1);
    await fact(IDS.cara, "2026-09-30", "d-web", 6, 0); // no reopen: no miss

    // Delivery's people: overdue open tasks (Gita 5 ... Lala 1, Mira none) and check-ins out of 5 expected days (Joko none).
    // Another unit's person (Ni Rai) has the most overdue tasks and is never listed under Delivery.
    for (const [key, n] of [["gita", 5], ["hadi", 4], ["indra", 3], ["joko", 2], ["kiki", 1], ["lala", 1]] as const) await overdueTasks(genProject, IDS[key], n);
    await overdueTasks(genProject, seoStaff, 9);
    for (const [key, n] of [["gita", 2], ["hadi", 4], ["indra", 5], ["joko", 0], ["kiki", 5], ["lala", 5], ["mira", 5]] as const) await checkins(IDS[key], n);
    await checkins(genHead, 5);

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ the route's gate and body (§43.8) ═══════════════════════════════

  it("digest: a non-admin is 403 (a manager, a head, the enclosing head, plain staff, a stranger), even with a bad body", async () => {
    for (const who of [webMgr, webHead, gmHead, webStaff, outsider]) {
      expect((await digest(who, { weekStart: WEEK })).statusCode, `as ${NAMES[who]}`).toBe(403);
      expect((await digest(who, { weekStart: "garbage" })).statusCode, `as ${NAMES[who]} with a bad body`).toBe(403); // authz before validation
    }
    expect(await ledger()).toEqual([]);
    expect(await notes()).toEqual([]);
  });

  it("digest: a bad weekStart is 400 field weekStart (not a Monday, a real date, a complete week) and nothing is written", async () => {
    const thisMonday = mondayOnOrBefore(todayIsoInTz(config.reportsTz));
    for (const weekStart of ["2026-09-29", "2026-09-27", "garbage", "2026-02-30", thisMonday, "2999-01-04", 20260928, ""]) {
      const r = await digest(admin, { weekStart });
      expect(r.statusCode, String(weekStart)).toBe(400);
      expect(r.json()).toMatchObject({ field: "weekStart" });
    }
    expect(await ledger()).toEqual([]);
    expect(await notes()).toEqual([]);
  });

  // ═══════════════════════════════ the run (§43.8) ═══════════════════════════════

  it("sends ONE notification per head per department for the last complete week, and says who has no head", async () => {
    await reset();
    const r = await runDeptKpiDigest(co, undefined, NOW); // the default week
    expect(r).toEqual({
      weekStart: WEEK,
      weekEnd: WEEK_END,
      evaluatedUnits: 3,
      sent: [
        { unitNodeId: "d-web", recipients: 2 },
        { unitNodeId: "d-gen", recipients: 1 },
      ],
      alreadySent: [],
      unitsWithoutHead: ["d-seo"],
    });

    const sent = await notes();
    expect(sent).toHaveLength(3); // d-web's two heads and d-gen's one: nobody else (no enclosing head, no manager, no staff)
    const to = (u: string) => sent.filter((n) => n.user_id === u);
    expect(to(webHead)).toHaveLength(1);
    expect(to(webHead2)).toHaveLength(1);
    expect(to(genHead)).toHaveLength(1);
    for (const u of [gmHead, webMgr, webStaff, admin, seoStaff]) expect(to(u)).toEqual([]);

    expect(to(webHead)[0].payload).toEqual({
      title: "Web Dev this week: at risk",
      body: [
        `Projects on time: 67% against 80% ${DOT} at risk (${DOWN} 13 pts from the week before)`,
        // DW-6n (on main since 06db3f0b) gave Web Dev's two module KPIs readers: with no rows here they read no_data.
        "1 KPI has no target; 2 KPIs have no data",
      ].join("\n"),
      href: `/appraisals/department?unit=d-web&periodKind=week&start=${WEEK}`,
      severity: "warning",
      actorId: null,
    });
    expect(to(webHead2)[0].payload).toEqual(to(webHead)[0].payload);
    expect(to(genHead)[0].payload).toEqual({
      title: "Delivery this week: off track",
      body: [`Projects on time: 25% against 90% ${DOT} off track (no data the week before)`, "2 KPIs have no target"].join("\n"),
      href: `/appraisals/department?unit=d-gen&periodKind=week&start=${WEEK}`,
      severity: "critical",
      actorId: null,
    });
    for (const n of sent) expect(n.payload).not.toHaveProperty("entityType");
  });

  it("the payload agrees with GET /dept-kpis for the week and the week before (the engine's own answer)", async () => {
    const sent = await notes();
    for (const [unit, head] of [["d-web", webHead], ["d-gen", genHead]] as const) {
      const week = (await kpisOf(admin, unit, WEEK)).json();
      const before = (await kpisOf(admin, unit, PREV_WEEK)).json();
      const { actorId, ...payload } = sent.find((n) => n.user_id === head)!.payload as Record<string, unknown>;
      expect(actorId).toBeNull();
      expect(payload).toEqual(buildDigestNotice(week, before, WEEK));
    }
  });

  it("the ledger rows are really visible and written under the tenant AND the reports module wall; constraints hold", async () => {
    expect(await ledger()).toEqual([
      { unit_node_id: "d-gen", week_start: WEEK, recipients: 1 },
      { unit_node_id: "d-web", week_start: WEEK, recipients: 2 },
    ]);
    expect(await withTenants([co], async (c) => (await c.query(`SELECT 1 FROM dept_kpi_digests`)).rows.length)).toBe(0); // no module scope: zero rows
    expect(await withTenants([other], async (c) => (await c.query(`SELECT 1 FROM dept_kpi_digests`)).rows.length, { modules: ["reports"] })).toBe(0);

    const insert = (unit: string, week: string, recipients: number) =>
      adminPool().query(
        `INSERT INTO dept_kpi_digests (tenant_id, unit_node_id, week_start, recipients, origin_site) VALUES ($1,$2,$3::date,$4,$5)`,
        [co, unit, week, recipients, config.originSite],
      );
    await expect(insert("d-web", WEEK, 1)).rejects.toThrow(/dept_kpi_digests_uq/); // one row per (unit, week)
    await expect(insert("d-seo", "2026-09-29", 1)).rejects.toThrow(); // a week starts on a Monday
    await expect(insert("d-seo", WEEK, 0)).rejects.toThrow(); // at least one head was told
    await expect(adminPool().query(`INSERT INTO dept_kpi_digests (tenant_id, unit_node_id, week_start, recipients) VALUES ($1,'d-seo',$2::date,1)`, [co, WEEK])).rejects.toThrow(); // origin_site has no default
    // a department with no head was never claimed
    expect((await ledger()).map((r) => r.unit_node_id)).not.toContain("d-seo");
  });

  it("a second run for the same week sends nothing and says so; another week is a separate row", async () => {
    const before = (await notes()).length;
    const again = await runDeptKpiDigest(co, WEEK, NOW);
    expect(again.sent).toEqual([]);
    expect(again.alreadySent).toEqual(["d-gen", "d-web"]);
    expect(again.unitsWithoutHead).toEqual(["d-seo"]);
    expect(await notes()).toHaveLength(before);
    expect(await ledger()).toHaveLength(2);

    // The week before is another week: it is sent, and the first week stays sent.
    const prev = await runDeptKpiDigest(co, PREV_WEEK, NOW);
    expect(prev.weekStart).toBe(PREV_WEEK);
    expect(prev.weekEnd).toBe("2026-09-27");
    expect(prev.sent).toEqual([
      { unitNodeId: "d-web", recipients: 2 },
      { unitNodeId: "d-gen", recipients: 1 },
    ]);
    expect(prev.alreadySent).toEqual([]);
    expect(await ledger()).toHaveLength(4);
    expect(await notes()).toHaveLength(before + 3);
    expect((await runDeptKpiDigest(co, WEEK, NOW)).sent).toEqual([]);
  });

  it("two concurrent runs send once", async () => {
    await reset();
    const [a, b] = await Promise.all([runDeptKpiDigest(co, WEEK, NOW), runDeptKpiDigest(co, WEEK, NOW)]);
    expect([...a.sent, ...b.sent].sort((x, y) => x.unitNodeId.localeCompare(y.unitNodeId))).toEqual([
      { unitNodeId: "d-gen", recipients: 1 },
      { unitNodeId: "d-web", recipients: 2 },
    ]);
    expect([...a.alreadySent, ...b.alreadySent].sort()).toEqual(["d-gen", "d-web"]); // each run saw the other's claim for the units it lost
    const sent = await notes();
    expect(sent).toHaveLength(3); // one per head, not six
    expect(sent.map((n) => n.user_id).sort()).toEqual([webHead, webHead2, genHead].sort());
    expect(await ledger()).toHaveLength(2);
    expect((await runDeptKpiDigest(co, WEEK, NOW)).sent).toEqual([]);
    expect(await notes()).toHaveLength(3);
  });

  it("no digest carries a person's name or a person-level number", async () => {
    const sent = await notes();
    expect(sent.length).toBeGreaterThan(0);
    const all = JSON.stringify(sent.map((n) => n.payload)).toLowerCase(); // the payloads: the recipient column is the head's own id, by design
    for (const name of Object.values(NAMES)) {
      expect(all).not.toContain(name.toLowerCase());
      for (const part of name.split(" ").filter((x) => x.length >= 4)) expect(all).not.toContain(part.toLowerCase());
    }
    expect(all).not.toContain("@dw4j3.test");
    for (const id of Object.keys(NAMES)) expect(all).not.toContain(id); // no user id either
  });

  it("digest by the admin: 200 with the contract's shape; a retry says alreadySent; an empty body is the default week", async () => {
    await reset();
    const first = await digest(admin, { weekStart: WEEK });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(Object.keys(body).sort()).toEqual(["alreadySent", "evaluatedUnits", "sent", "unitsWithoutHead", "weekEnd", "weekStart"]);
    expect(body).toMatchObject({ weekStart: WEEK, weekEnd: WEEK_END, evaluatedUnits: 3, alreadySent: [], unitsWithoutHead: ["d-seo"] });
    expect(body.sent).toEqual([
      { unitNodeId: "d-web", recipients: 2 },
      { unitNodeId: "d-gen", recipients: 1 },
    ]);
    const second = await digest(admin, { weekStart: WEEK });
    expect(second.statusCode).toBe(200);
    expect(second.json().sent).toEqual([]);
    expect(second.json().alreadySent).toEqual(["d-gen", "d-web"]);
    expect(await notes()).toHaveLength(3);

    // No body at all: the last complete week as of today. (Whatever it holds, it is a Monday to Sunday pair and it is not today's week.)
    const dflt = await app.inject({ method: "POST", url: `/api/${co}/dept-kpis/digest`, headers: asUser(admin) });
    expect(dflt.statusCode).toBe(200);
    expect(dflt.json().weekStart).toBe(lastCompleteWeekStart(todayIsoInTz(config.reportsTz)));
    await reset();
  });

  // ═══════════════════════════════ behind the miss: the gate (§43.8, PERMISSION §38b) ═══════════════════════════════

  describe("drivers: the gate and the parameters", () => {
    it("the head of the unit, a second head, the enclosing head and the company-wide tier read (200)", async () => {
      for (const who of [webHead, webHead2, gmHead, admin]) {
        const r = await drivers(who, weekQ("d-web", "projects-on-time"));
        expect(r.statusCode, `as ${NAMES[who]}`).toBe(200);
      }
    });

    it("a placed member, a placed staff member of another unit, another unit's head and a stranger are refused (403)", async () => {
      for (const who of [webStaff, seoStaff, genHead, outsider]) {
        const r = await drivers(who, weekQ("d-web", "projects-on-time"));
        expect(r.statusCode, `as ${NAMES[who]}`).toBe(403);
      }
      expect((await drivers(webStaff, weekQ("d-web", "projects-on-time"))).json()).toMatchObject({ error: "outside your reporting line" });
    });

    it("the gate answers exactly as the department appraisal's does (the extracted function is the same)", async () => {
      for (const who of [webHead, webHead2, webMgr, webStaff, seoStaff, genHead, gmHead, admin, outsider]) {
        const d = await drivers(who, weekQ("d-web", "projects-on-time"));
        // a bogus cycle id: whoever passes the gate reaches 404 cycle_not_found, everyone else is refused first
        const a = await app.inject({ method: "GET", url: `/api/${co}/dept-appraisals?cycleId=${newId()}&unitNodeId=d-web`, headers: asUser(who) });
        expect(d.statusCode === 403, `as ${NAMES[who]}`).toBe(a.statusCode === 403);
        if (a.statusCode !== 403) expect(a.statusCode).toBe(404);
      }
    });

    it("an unknown unit is 404 unit_not_found for the company-wide tier, and a 403 for a narrowed caller (who learns nothing)", async () => {
      const r = await drivers(admin, weekQ("d-nowhere", "projects-on-time"));
      expect(r.statusCode).toBe(404);
      expect(r.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
      expect((await drivers(webHead, weekQ("d-nowhere", "projects-on-time"))).statusCode).toBe(403);
    });

    it("missing parameters are 400 before anything is looked up (no unit to authorize yet); a bad period is 400", async () => {
      const none = await drivers(outsider, {});
      expect(none.statusCode).toBe(400);
      expect(none.json()).toMatchObject({ field: "unitNodeId" });
      const noKpi = await drivers(outsider, { unitNodeId: "d-web", periodKind: "week", start: WEEK });
      expect(noKpi.statusCode).toBe(400);
      expect(noKpi.json()).toMatchObject({ field: "kpiKey" });
      expect((await drivers(admin, { unitNodeId: "", kpiKey: "x" })).json()).toMatchObject({ field: "unitNodeId" });
      expect((await drivers(admin, { unitNodeId: "d-web", kpiKey: "projects-on-time", periodKind: "fortnight", start: WEEK })).json()).toMatchObject({ field: "periodKind" });
      expect((await drivers(admin, { unitNodeId: "d-web", kpiKey: "projects-on-time", periodKind: "week" })).json()).toMatchObject({ field: "start" });
    });

    it("a KPI outside the unit's workspace set is 400 field kpiKey, after the gate", async () => {
      const r = await drivers(webHead, weekQ("d-web", "overdue-tasks")); // a Delivery (generic) KPI, not Web Dev's
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ field: "kpiKey" });
      expect((await drivers(webHead, weekQ("d-web", "no-such-kpi"))).statusCode).toBe(400);
      // the gate comes first: another unit's head is refused, not told which KPIs exist
      expect((await drivers(genHead, weekQ("d-web", "no-such-kpi"))).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════ behind the miss: the drivers (§43.8) ═══════════════════════════════

  describe("drivers: which KPIs and which rows", () => {
    it("a module KPI with a reader of its own (DW-6n) has no drivers: 200, drivers null, reason no_drivers", async () => {
      const r = await drivers(webHead, weekQ("d-web", "client-site-uptime"));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        kpi: { key: "client-site-uptime", label: "Client site uptime", unit: "percent", direction: "up_good" },
        period: { periodKind: "week", start: WEEK, end: WEEK_END },
        drivers: null,
        reason: "no_drivers",
      });
    });

    it("projects on time lists the unit's projects with a missed milestone, worst first, with numerator and denominator", async () => {
      const r = await drivers(webHead, weekQ("d-web", "projects-on-time"));
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.kpi).toEqual({ key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good" });
      expect(body.period).toEqual({ periodKind: "week", start: WEEK, end: WEEK_END });
      expect(body).not.toHaveProperty("reason");
      // Alpha 1 of 3, Gamma 2 of 3; Beta hit all three (not behind the miss), Delta's milestone is in another week, Gen Project is Delivery's
      expect(body.drivers).toEqual([
        { kind: "project", id: IDS.alphaProject, name: "Alpha", value: 1 / 3, numerator: 1, denominator: 3 },
        { kind: "project", id: expect.any(String), name: "Gamma", value: 2 / 3, numerator: 2, denominator: 3 },
      ]);
      // the drivers do not change the department's value: 6 of 9 against the same engine
      const kpi = (await kpisOf(webHead, "d-web", WEEK)).json().kpis.find((k: { key: string }) => k.key === "projects-on-time");
      expect(kpi).toMatchObject({ value: 6 / 9, numerator: 6, denominator: 9, condition: "at_risk" });
      // another period: the week before has only Delta, which hit 4 of 5
      const before = (await drivers(webHead, { ...weekQ("d-web", "projects-on-time"), start: PREV_WEEK })).json();
      expect(before.drivers).toEqual([{ kind: "project", id: expect.any(String), name: "Delta", value: 0.8, numerator: 4, denominator: 5 }]);
      // an unrelated period has none: an empty list is a real answer
      expect((await drivers(webHead, { ...weekQ("d-web", "projects-on-time"), start: "2026-01-05" })).json().drivers).toEqual([]);
    });

    it("another unit's projects stay with that unit", async () => {
      const r = await drivers(genHead, weekQ("d-gen", "projects-on-time"));
      expect(r.statusCode).toBe(200);
      expect(r.json().drivers).toEqual([{ kind: "project", id: expect.any(String), name: "Gen Project", value: 0.25, numerator: 1, denominator: 4 }]);
    });

    it("reopened work lists the roster's people with a reopen, highest rate first, with the Team report's numbers", async () => {
      const r = await drivers(webHead, weekQ("d-web", "reopened-work-rate"));
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.kpi).toMatchObject({ key: "reopened-work-rate", direction: "down_good" });
      // Bagus 3 of 4, Ayu 2 of 8, Budi 1 of 10; Cara reopened none (no miss); Ni Rai (SEO) is not on the roster; the heads have no facts
      expect(body.drivers).toEqual([
        { kind: "person", id: webStaff, name: "Bagus Wirawan", value: 0.75, numerator: 3, denominator: 4 },
        { kind: "person", id: IDS.ayu, name: "Ayu Lestari", value: 0.25, numerator: 2, denominator: 8 },
        { kind: "person", id: IDS.budi, name: "Budi Santoso", value: 0.1, numerator: 1, denominator: 10 },
      ]);
      for (const d of body.drivers as Array<{ id: string; value: number; numerator: number; denominator: number }>) {
        expect(docKpi(await personDoc(d.id), "flow.reopen_rate")).toMatchObject({ value: d.value, numerator: d.numerator, denominator: d.denominator });
      }
      expect(JSON.stringify(body)).not.toContain("Ni Rai");
    });

    it("overdue tasks lists the roster's people, most first, at most five, ties by name; a person with none is not listed", async () => {
      const r = await drivers(genHead, weekQ("d-gen", "overdue-tasks"));
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.kpi).toMatchObject({ key: "overdue-tasks", unit: "count", direction: "down_good" });
      // Gita 5, Hadi 4, Indra 3, Joko 2, Kiki 1 and Lala 1 (cut by the cap: Kiki before Lala by name); Mira and the head have none
      expect(body.drivers).toEqual([
        { kind: "person", id: IDS.gita, name: "Gita Pratiwi", value: 5 },
        { kind: "person", id: IDS.hadi, name: "Hadi Kusuma", value: 4 },
        { kind: "person", id: IDS.indra, name: "Indra Gunawan", value: 3 },
        { kind: "person", id: IDS.joko, name: "Joko Susilo", value: 2 },
        { kind: "person", id: IDS.kiki, name: "Kiki Anggraini", value: 1 },
      ]);
      const text = JSON.stringify(body);
      for (const absent of [IDS.lala, IDS.mira, genHead, seoStaff]) expect(text).not.toContain(absent); // Ni Rai has 9 and is not on the roster
      // the numbers are the Team report's own
      for (const d of body.drivers as Array<{ id: string; value: number }>) {
        expect(docKpi(await personDoc(d.id), "discipline.overdue_open").value).toBe(d.value);
      }
    });

    it("check-in compliance lists the roster's people below full compliance, lowest first, with the Team report's numbers", async () => {
      const r = await drivers(genHead, weekQ("d-gen", "check-in-compliance"));
      expect(r.statusCode).toBe(200);
      const body = r.json();
      // Joko 0 of 5, Gita 2 of 5, Hadi 4 of 5; Indra, Kiki, Lala, Mira and the head submitted every expected day
      expect((body.drivers as Array<{ id: string }>).map((d) => d.id)).toEqual([IDS.joko, IDS.gita, IDS.hadi]);
      expect(body.drivers).toEqual([
        { kind: "person", id: IDS.joko, name: "Joko Susilo", value: 0, numerator: 0, denominator: expect.any(Number) },
        { kind: "person", id: IDS.gita, name: "Gita Pratiwi", value: expect.any(Number), numerator: 2, denominator: expect.any(Number) },
        { kind: "person", id: IDS.hadi, name: "Hadi Kusuma", value: expect.any(Number), numerator: 4, denominator: expect.any(Number) },
      ]);
      for (const d of body.drivers as Array<{ id: string; value: number; numerator: number; denominator: number }>) {
        expect(d.denominator).toBeGreaterThan(d.numerator);
        expect(docKpi(await personDoc(d.id), "discipline.checkin_compliance")).toMatchObject({ value: d.value, numerator: d.numerator, denominator: d.denominator });
      }
    });

    it("a head's roster is the unit's subtree: Web Dev's people never show under Delivery, and the other way round", async () => {
      const web = JSON.stringify((await drivers(admin, weekQ("d-web", "reopened-work-rate"))).json());
      for (const gen of [IDS.gita, IDS.hadi, IDS.joko]) expect(web).not.toContain(gen);
      const gen = JSON.stringify((await drivers(admin, weekQ("d-gen", "check-in-compliance"))).json());
      for (const w of [webStaff, IDS.ayu, IDS.budi]) expect(gen).not.toContain(w);
    });
  });
});
