// DW-4e-3 — the department appraisal per cycle over the REAL HTTP surface (buildApp + app.inject), against live Postgres
// + RLS + Cerbos (cerbos/policies/resource_dept_kpi_target.yaml: `read`, `appraisal_comment`, `appraisal_assess`).
// Covers docs/FRONTEND-BFF-CONTRACT.md §41's proof list, live half:
//   * the history agrees month by month with GET /dept-kpis for each month;
//   * the result over the cycle uses the target in force for the cycle's LAST month;
//   * a head comments on their unit (and its divisions) and is refused another unit (403);
//   * a non-approver's assessment is refused (403), and a 403 is never pre-empted by a 400;
//   * writes on a closed cycle get 409 cycle_closed and store nothing;
//   * the distribution is withheld below 3 scored rows;
//   * a subject outside the unit's roster (another unit, or a membership that has ended) is not counted;
//   * a unit's staff get 403 (they read the KPI page, not the appraisal);
//   * an unknown cycle or unit gets 404 for a company-wide caller (and 403 for a caller who may not read the unit);
//   * the people block carries counts only, and every write records an activity row;
//   * the cycles list for the picker: no drafts, newest first by period end, for a head and the company-wide tiers, 403 for a
//     plain member and a unit's staff, and another company's cycles never in it.
// The month enumeration, the score bands and the withholding rule are pinned in dept-appraisals.test.ts (pure); the
// policy matrix in src/rbac/cerbos-dept-kpi-target.test.ts.
//
// The org tree is written in the REAL stored shape (`{root: ...}`) and the closure is built with the PRODUCTION builder:
// without the closure every org_unit_lead rule denies. All milestones are September and October 2026, which the report
// reads live from pm_milestones, so no fact job is needed. Targets are written straight into dept_kpi_targets as
// approved rows (the 4e-1 suite already proves the propose/approve flow); the appraisal rows straight into
// report_appraisals (the generate flow needs sealed periods and is TR-24's).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Kpi = {
  key: string; value: number | null; numerator?: number; denominator?: number; target: number | null; tolerance: number | null;
  targetSource: string; condition: string; reason?: string;
};
type Appraisal = {
  cycle: { id: string; name: string; periodStart: string; periodEnd: string; status: string };
  unit: { id: string; name: string };
  workspace: string;
  kpis: Kpi[];
  condition: string;
  history: Array<{ month: string; condition: string; kpis: Array<{ key: string; condition: string }> }>;
  people: {
    total: number;
    byStatus: Record<string, number>;
    distribution: Array<{ band: number; count: number }> | null;
    reason?: string;
  };
  hodCommentary: { text: string; by: string; byName: string | null; at: string } | null;
  gmAssessment: { text: string; condition: string; by: string; byName: string | null; at: string } | null;
};

const LONG = "A commentary long enough to satisfy the appraisal table's own constraint on non-draft rows (50+).";

describe.skipIf(!TEST_URL)("DW-4e-3 department appraisal per cycle (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string; // a second company, for the RLS wall
  let admin: string; // company_admin: the GM tier (comments and assesses)
  let webHead: string; // org_unit_lead @ d-web + manager + member, placed in d-web (the real head shape)
  let webStaff: string; // member, placed in d-web
  let feStaff: string; // member, placed in dv-fe (a division of d-web)
  let seoStaff: string; // member, placed in d-seo
  let hr: string; // hr_staff + member: a company-wide reader
  let webS1: string, webS2: string, webS3: string, feS: string, seoS: string, formerS: string; // appraisal subjects
  let openCycle: string; // 2026-09-01 .. 2026-10-31, open
  let closedCycle: string; // 2026-07-01 .. 2026-08-31, closed
  let longCycle: string; // 2025-01-01 .. 2026-12-31 (730 days), open
  let draftCycle: string; // 2027-01-01 .. 2027-06-30, draft: HR's preparation, never in the picker
  let otherCycle: string; // another company's cycle
  let periodId: string;

  const place = (userId: string, unit: string, validTo: string | null = null) =>
    withTenants([co], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1,$2,$3,$4,true,'2020-01-01',$5,'manual',$6)`,
        [newId(), co, userId, unit, validTo, config.originSite],
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
  const insertCycle = (name: string, start: string, end: string, status: string): Promise<string> => {
    const id = newId();
    return withTenants(
      [co],
      async (c) => {
        await c.query(
          `INSERT INTO report_appraisal_cycles (id, tenant_id, name, period_start, period_end, status, created_by, origin_site)
           VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8)`,
          [id, co, name, start, end, status, admin, config.originSite],
        );
        return id;
      },
      { modules: ["reports"] },
    );
  };
  const approvedTarget = (unit: string, kpi: string, from: string, target: number, tolerance: number) =>
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
  const appraisal = (cycleId: string, subject: string, status: string, composite: number | null) =>
    withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO report_appraisals (id, tenant_id, cycle_id, subject_user_id, manager_user_id, weights, composite, commentary,
                                          period_id, revision, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8,0,$9,$10)`,
          [newId(), co, cycleId, subject, admin, composite, status === "draft" ? null : LONG, periodId, status, config.originSite],
        ),
      { modules: ["reports"] },
    );

  const read = (cycleId: string | undefined, unit: string | undefined, as: string) => {
    const qs = [cycleId !== undefined ? `cycleId=${cycleId}` : "", unit !== undefined ? `unitNodeId=${unit}` : ""].filter(Boolean).join("&");
    return app.inject({ method: "GET", url: `/api/${co}/dept-appraisals?${qs}`, headers: asUser(as) });
  };
  const kpiRead = (unit: string, month: string, as: string) =>
    app.inject({ method: "GET", url: `/api/${co}/dept-kpis?unitNodeId=${unit}&periodKind=month&start=${month}`, headers: asUser(as) });
  const comment = (cycleId: string, unit: string, body: unknown, as: string) =>
    app.inject({ method: "PUT", url: `/api/${co}/dept-appraisals/${cycleId}/${unit}/commentary`, headers: asUser(as), payload: body as object });
  const assess = (cycleId: string, unit: string, body: unknown, as: string) =>
    app.inject({ method: "PUT", url: `/api/${co}/dept-appraisals/${cycleId}/${unit}/assessment`, headers: asUser(as), payload: body as object });
  const storedRows = async (cycleId: string, unit: string) =>
    withTenants(
      [co],
      async (c) =>
        (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM dept_appraisals WHERE tenant_id = $1 AND cycle_id = $2 AND unit_node_id = $3`, [co, cycleId, unit])).rows[0].n,
      { modules: ["reports"] },
    );
  const kpiOf = (a: Appraisal, key: string): Kpi => {
    const k = a.kpis.find((x) => x.key === key);
    if (!k) throw new Error(`no KPI ${key}`);
    return k;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("DW-4e3 Co", ["reports", "pm", "hr"]);
    other = await createCompany("DW-4e3 Other", ["reports"]);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [co]));

    admin = await createUser("admin@dw4e3.test");
    webHead = await createUser("web-head@dw4e3.test");
    webStaff = await createUser("web-staff@dw4e3.test");
    feStaff = await createUser("fe-staff@dw4e3.test");
    seoStaff = await createUser("seo-staff@dw4e3.test");
    hr = await createUser("hr@dw4e3.test");
    webS1 = await createUser("web-s1@dw4e3.test");
    webS2 = await createUser("web-s2@dw4e3.test");
    webS3 = await createUser("web-s3@dw4e3.test");
    feS = await createUser("fe-s@dw4e3.test");
    seoS = await createUser("seo-s@dw4e3.test");
    formerS = await createUser("former-s@dw4e3.test");
    const everyone = [admin, webHead, webStaff, feStaff, seoStaff, hr, webS1, webS2, webS3, feS, seoS, formerS];
    for (const u of everyone) await addMembership(co, u);

    const member = await createRole("member");
    for (const u of everyone) await grantRole(u, member, "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(webHead, await createRole("org_unit_lead"), "org_unit", "d-web");
    await grantRole(webHead, await createRole("manager"), "company", co);
    await grantRole(hr, await createRole("hr_staff"), "company", co);

    const root = {
      id: "d-corp",
      kind: "company",
      name: "DW-4e3 Co",
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
    for (const u of [webHead, webStaff, webS1, webS2, webS3]) await place(u, "d-web");
    for (const u of [feStaff, feS]) await place(u, "dv-fe");
    for (const u of [seoStaff, seoS]) await place(u, "d-seo");
    await place(formerS, "d-web", "2026-01-31"); // left the department: not on today's roster

    // September: Web Dev hits 4 of 5 milestones (0.8). October: 1 of 2 (0.5). Over the cycle: 5 of 7 (0.714).
    await milestones("d-web", "2026-09-15", 5, 4);
    await milestones("d-web", "2026-10-10", 2, 1);
    // Targets: 0.85 +/- 0.05 from September, 0.75 +/- 0.05 from October. The cycle is judged against OCTOBER's.
    await approvedTarget("d-web", "projects-on-time", "2026-09-01", 0.85, 0.05);
    await approvedTarget("d-web", "projects-on-time", "2026-10-01", 0.75, 0.05);

    openCycle = await insertCycle("H2 2026 review", "2026-09-01", "2026-10-31", "open");
    closedCycle = await insertCycle("Mid 2026 review", "2026-07-01", "2026-08-31", "closed");
    longCycle = await insertCycle("Two-year review", "2025-01-01", "2026-12-31", "open");
    draftCycle = await insertCycle("Next year review", "2027-01-01", "2027-06-30", "draft");
    otherCycle = newId();
    await withTenants(
      [other],
      (c) =>
        c.query(
          `INSERT INTO report_appraisal_cycles (id, tenant_id, name, period_start, period_end, status, created_by, origin_site)
           VALUES ($1,$2,'Other company review','2027-01-01','2027-12-31','open',$3,$4)`,
          [otherCycle, other, admin, config.originSite],
        ),
      { modules: ["reports"] },
    );

    periodId = newId();
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO report_periods (id, tenant_id, period_kind, period_start, period_end, status, origin_site)
           VALUES ($1,$2,'month','2026-09-01','2026-09-30','open',$3)`,
          [periodId, co, config.originSite],
        ),
      { modules: ["reports"] },
    );
    // The open cycle, d-web's subtree: 3 scored (3.0 -> band 3, 4.0 and 4.4 -> band 4), one draft; a d-seo subject and a
    // subject whose membership ended are on the cycle but NOT on the roster.
    await appraisal(openCycle, webS1, "submitted", 3.0);
    await appraisal(openCycle, webS2, "acknowledged", 4.0);
    await appraisal(openCycle, feS, "finalized", 4.4); // a division of d-web: inside the subtree
    await appraisal(openCycle, webS3, "draft", null);
    await appraisal(openCycle, seoS, "finalized", 5.0);
    await appraisal(openCycle, formerS, "submitted", 1.0);
    // The closed cycle: only two scored rows inside d-web (so withheld), plus the outside subject that would make it three.
    await appraisal(closedCycle, webS1, "submitted", 3.0);
    await appraisal(closedCycle, webS2, "submitted", 4.0);
    await appraisal(closedCycle, seoS, "submitted", 5.0);

    app = await buildApp();
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ the cycles list (§41.4) ═══════════════════════════════

  const cycles = (as: string) => app.inject({ method: "GET", url: `/api/${co}/dept-appraisals/cycles`, headers: asUser(as) });
  type Pick = { id: string; name: string; periodStart: string; periodEnd: string; status: string };

  it("a head gets the company's cycles without drafts, newest first by period end, with only the picker's fields", async () => {
    const r = await cycles(webHead);
    expect(r.statusCode).toBe(200);
    const list: Pick[] = r.json().cycles;
    expect(list.map((c) => c.id)).toEqual([longCycle, openCycle, closedCycle]);
    expect(list.map((c) => c.id)).not.toContain(draftCycle);
    expect(list[1]).toEqual({ id: openCycle, name: "H2 2026 review", periodStart: "2026-09-01", periodEnd: "2026-10-31", status: "open" });
    expect(Object.keys(r.json())).toEqual(["cycles"]);
  });

  it("the company-wide tiers get the same list: company_admin and HR's people-reader tier", async () => {
    for (const who of [admin, hr]) {
      const r = await cycles(who);
      expect(r.statusCode).toBe(200);
      expect((r.json().cycles as Pick[]).map((c) => c.id)).toEqual([longCycle, openCycle, closedCycle]);
    }
  });

  it("a plain member and a unit's staff get 403: the list is for those who can read an appraisal", async () => {
    for (const who of [webStaff, feStaff, seoStaff]) expect((await cycles(who)).statusCode, who).toBe(403);
  });

  it("RLS keeps another company's cycles out, and this company's out of theirs", async () => {
    const mine = (await cycles(admin)).json().cycles as Pick[];
    expect(mine.map((c) => c.id)).not.toContain(otherCycle);
    expect(mine.map((c) => c.name)).not.toContain("Other company review");
    const theirs = await withTenants([other], async (c) => (await c.query<{ id: string }>(`SELECT id FROM report_appraisal_cycles`)).rows.map((r) => r.id), { modules: ["reports"] });
    expect(theirs).toEqual([otherCycle]);
  });

  it("a draft cycle is not in the list, and becomes pickable once HR opens it", async () => {
    await withTenants([co], (c) => c.query(`UPDATE report_appraisal_cycles SET status = 'open' WHERE id = $1`, [draftCycle]), { modules: ["reports"] });
    const opened = (await cycles(admin)).json().cycles as Pick[];
    expect(opened.map((c) => c.id)).toEqual([draftCycle, longCycle, openCycle, closedCycle]);
    await withTenants([co], (c) => c.query(`UPDATE report_appraisal_cycles SET status = 'draft' WHERE id = $1`, [draftCycle]), { modules: ["reports"] });
  });

  // ═══════════════════════════════ the read (§41.1, §41.4) ═══════════════════════════════

  it("the shape: the cycle, the unit, the workspace, the §40 KPIs over the cycle, the condition, the history, the people, and null commentary and assessment before any write", async () => {
    const r = await read(openCycle, "d-web", admin);
    expect(r.statusCode).toBe(200);
    const body: Appraisal = r.json();
    expect(Object.keys(body).sort()).toEqual(["condition", "cycle", "gmAssessment", "history", "hodCommentary", "kpis", "people", "unit", "workspace"]);
    expect(body.cycle).toEqual({ id: openCycle, name: "H2 2026 review", periodStart: "2026-09-01", periodEnd: "2026-10-31", status: "open" });
    expect(body.unit).toEqual({ id: "d-web", name: "Web Dev" });
    expect(body.workspace).toBe("web-dev");
    expect(body.kpis.map((k) => k.key)).toEqual(["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"]);
    expect(body.hodCommentary).toBeNull();
    expect(body.gmAssessment).toBeNull();
  });

  it("the result uses the target in force for the cycle's LAST month (0.75 from October), not the first month's (0.85)", async () => {
    const a: Appraisal = (await read(openCycle, "d-web", admin)).json();
    // 4 + 1 of 5 + 2 milestones = 5 of 7 over the cycle
    const k = kpiOf(a, "projects-on-time");
    expect(k).toMatchObject({ numerator: 5, denominator: 7, target: 0.75, tolerance: 0.05, targetSource: "approved" });
    expect(k.value).toBeCloseTo(5 / 7, 10);
    // 0.714 against 0.75 +/- 0.05 is at risk; against September's 0.85 it would be off track
    expect(k.condition).toBe("at_risk");
    expect(a.condition).toBe("at_risk");
    // the engine's other KPIs keep their §40 reasons
    expect(kpiOf(a, "requests-within-sla")).toMatchObject({ value: null, condition: "unavailable", reason: "no_reader" });
  });

  it("the history agrees month by month with GET /dept-kpis for each month (each judged against its OWN month's target)", async () => {
    const a: Appraisal = (await read(openCycle, "d-web", admin)).json();
    expect(a.history.map((h) => h.month)).toEqual(["2026-09-01", "2026-10-01"]);
    for (const h of a.history) {
      const month = (await kpiRead("d-web", h.month, admin)).json() as { condition: string; kpis: Kpi[] };
      expect(h.condition, `condition of ${h.month}`).toBe(month.condition);
      expect(h.kpis, `KPIs of ${h.month}`).toEqual(month.kpis.map((k) => ({ key: k.key, condition: k.condition })));
    }
    // September 0.8 against 0.85 is at risk, October 0.5 against 0.75 is off track
    expect(a.history.map((h) => h.condition)).toEqual(["at_risk", "off_track"]);
    expect(a.history[0].kpis.find((k) => k.key === "projects-on-time")!.condition).toBe("at_risk");
    expect(a.history[1].kpis.find((k) => k.key === "projects-on-time")!.condition).toBe("off_track");
  });

  it("a month before the tenant's first fact reads unavailable: the history of a cycle with no data is all unavailable", async () => {
    const a: Appraisal = (await read(closedCycle, "d-web", admin)).json();
    expect(a.history.map((h) => h.month)).toEqual(["2026-07-01", "2026-08-01"]);
    expect(a.history.map((h) => h.condition)).toEqual(["unavailable", "unavailable"]);
    expect(a.condition).toBe("unavailable");
  });

  it("the people block: the unit's roster only (a division's subject counted; another unit's and a former member's not), counts and the distribution", async () => {
    const a: Appraisal = (await read(openCycle, "d-web", admin)).json();
    // webS1, webS2, feS, webS3 = 4; seoS and formerS are not on d-web's roster today
    expect(a.people.total).toBe(4);
    expect(a.people.byStatus).toEqual({ draft: 1, submitted: 1, acknowledged: 1, disputed: 0, finalized: 1 });
    expect(a.people.reason).toBeUndefined();
    expect(a.people.distribution).toEqual([
      { band: 1, count: 0 }, { band: 2, count: 0 }, { band: 3, count: 1 }, { band: 4, count: 2 }, { band: 5, count: 0 },
    ]);
    // the outside subjects' 5.0 and 1.0 appear in no band
    // d-seo's own appraisal block sees only its subject (and withholds)
    const seo: Appraisal = (await read(openCycle, "d-seo", admin)).json();
    expect(seo.people.total).toBe(1);
    expect(seo.people.byStatus.finalized).toBe(1);
    expect(seo.people.distribution).toBeNull();
  });

  it("the distribution is withheld below 3 scored rows: reason too_few, and no band anywhere in the payload", async () => {
    // closed cycle, d-web: two scored rows (seoS's third is outside the roster)
    const r = await read(closedCycle, "d-web", admin);
    expect(r.statusCode).toBe(200);
    const a: Appraisal = r.json();
    expect(a.people.total).toBe(2);
    expect(a.people.byStatus.submitted).toBe(2);
    expect(a.people.distribution).toBeNull();
    expect(a.people.reason).toBe("too_few");
    expect(JSON.stringify(a.people)).not.toContain("band");
  });

  it("the people block is counts only: no subject id, no name and no individual score leaves the endpoint", async () => {
    const r = await read(openCycle, "d-web", webHead);
    expect(r.statusCode).toBe(200);
    const text = r.body;
    for (const subject of [webS1, webS2, webS3, feS, seoS, formerS]) expect(text).not.toContain(subject);
    expect(text).not.toContain("web-s1");
    expect(text).not.toContain("composite");
    expect(Object.keys(r.json().people).sort()).toEqual(["byStatus", "distribution", "total"]);
  });

  it("a cycle longer than the 400-day cap is 422 range_too_large (the report-range rule)", async () => {
    const r = await read(longCycle, "d-web", admin);
    expect(r.statusCode).toBe(422);
  });

  // ═══════════════════════════════ who may read (§41.3) ═══════════════════════════════

  it("who may read: the unit's head (led scope, a division included) and the company-wide tiers incl. HR; never the unit's staff or another unit's people", async () => {
    expect((await read(openCycle, "d-web", webHead)).statusCode).toBe(200);
    expect((await read(openCycle, "dv-fe", webHead)).statusCode).toBe(200); // a division of the head's department
    expect((await read(openCycle, "d-seo", webHead)).statusCode).toBe(403); // a head of another unit
    expect((await read(openCycle, "d-web", hr)).statusCode).toBe(200); // HR's people-reader tier
    expect((await read(openCycle, "d-seo", hr)).statusCode).toBe(200);
    expect((await read(openCycle, "d-web", admin)).statusCode).toBe(200);
  });

  it("a unit's staff get 403 (they read the KPI page, not the appraisal), a division's staff and another unit's staff too", async () => {
    expect((await read(openCycle, "d-web", webStaff)).statusCode).toBe(403);
    expect((await read(openCycle, "d-web", feStaff)).statusCode).toBe(403);
    expect((await read(openCycle, "dv-fe", feStaff)).statusCode).toBe(403);
    expect((await read(openCycle, "d-web", seoStaff)).statusCode).toBe(403);
    // while the KPI page stays open to them (§40.3)
    expect((await kpiRead("d-web", "2026-09-01", webStaff)).statusCode).toBe(200);
  });

  it("an unknown cycle or unit is 404 for a company-wide caller; a caller who may not read the unit gets 403 first (no existence leak)", async () => {
    const noCycle = await read(newId(), "d-web", admin);
    expect(noCycle.statusCode).toBe(404);
    expect(noCycle.json()).toMatchObject({ error: "cycle_not_found", field: "cycleId" });
    expect((await read("not-a-uuid", "d-web", admin)).statusCode).toBe(404);
    const noUnit = await read(openCycle, "d-nope", hr);
    expect(noUnit.statusCode).toBe(404);
    expect(noUnit.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
    // staff and a head of another unit: 403 whether or not the unit or the cycle exists
    expect((await read(newId(), "d-web", webStaff)).statusCode).toBe(403);
    expect((await read(openCycle, "d-nope", webStaff)).statusCode).toBe(403);
    expect((await read(openCycle, "d-nope", webHead)).statusCode).toBe(403);
    expect((await read(newId(), "d-seo", webHead)).statusCode).toBe(403);
    // a head reading their OWN unit with an unknown cycle: 404 (they may read the unit)
    expect((await read(newId(), "d-web", webHead)).statusCode).toBe(404);
  });

  it("missing cycleId or unitNodeId is 400", async () => {
    expect((await read(undefined, "d-web", admin)).statusCode).toBe(400);
    expect((await read(openCycle, undefined, admin)).statusCode).toBe(400);
  });

  // ═══════════════════════════════ the commentary (§41.4) ═══════════════════════════════

  it("a head comments on their unit (200) and is refused another unit (403); a division of theirs is inside their line", async () => {
    const r = await comment(openCycle, "d-web", { text: "  Frontend carried the quarter; two milestones slipped on a vendor delay.  " }, webHead);
    expect(r.statusCode).toBe(200);
    expect(r.json().hodCommentary).toMatchObject({ text: "Frontend carried the quarter; two milestones slipped on a vendor delay.", by: webHead, byName: "web-head" });
    expect(new Date(r.json().hodCommentary.at).toISOString()).toBe(r.json().hodCommentary.at);

    expect((await comment(openCycle, "d-seo", { text: "not mine" }, webHead)).statusCode).toBe(403);
    expect((await comment(openCycle, "dv-fe", { text: "A division comment." }, webHead)).statusCode).toBe(200);

    const a: Appraisal = (await read(openCycle, "d-web", admin)).json();
    expect(a.hodCommentary).toMatchObject({ text: "Frontend carried the quarter; two milestones slipped on a vendor delay.", by: webHead });
    expect(a.gmAssessment).toBeNull();
    expect(await storedRows(openCycle, "d-seo")).toBe("0"); // the refused write left nothing behind
  });

  it("the commentary is replaced, not duplicated: one row per (cycle, unit), the same row id in the activity log", async () => {
    const again = await comment(openCycle, "d-web", { text: "Revised: the vendor delay is resolved." }, webHead);
    expect(again.statusCode).toBe(200);
    expect(await storedRows(openCycle, "d-web")).toBe("1");
    const a: Appraisal = (await read(openCycle, "d-web", webHead)).json();
    expect(a.hodCommentary!.text).toBe("Revised: the vendor delay is resolved.");

    const acts = await withTenants([co], async (c) =>
      (await c.query<{ verb: string; target_entity_id: string }>(
        `SELECT verb, target_entity_id FROM activities WHERE tenant_id = $1 AND target_entity_type = 'dept_appraisal' AND verb = 'commented' AND actor_id = $2`,
        [co, webHead],
      )).rows,
    );
    expect(acts.length).toBe(3); // d-web twice, dv-fe once
    expect(new Set(acts.map((x) => x.target_entity_id)).size).toBe(2);
  });

  it("who may comment: the head and company_admin; plain staff and the HR tier are refused (403)", async () => {
    expect((await comment(openCycle, "d-web", { text: "x" }, webStaff)).statusCode).toBe(403);
    expect((await comment(openCycle, "d-web", { text: "x" }, hr)).statusCode).toBe(403);
    expect((await comment(openCycle, "d-web", { text: "x" }, seoStaff)).statusCode).toBe(403);
    expect((await comment(openCycle, "d-seo", { text: "The GM tier may comment on any unit." }, admin)).statusCode).toBe(200);
  });

  it("commentary validation: 1 to 4000 characters, a string; a 403 is never pre-empted by a 400", async () => {
    for (const bad of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: "x".repeat(4001) }]) {
      const r = await comment(openCycle, "d-web", bad, webHead);
      expect(r.statusCode, JSON.stringify(bad).slice(0, 40)).toBe(400);
      expect(r.json().field).toBe("text");
    }
    expect((await comment(openCycle, "d-web", { text: "x".repeat(4000) }, webHead)).statusCode).toBe(200);
    // an invalid body from someone who may not write is still a 403
    expect((await comment(openCycle, "d-web", { text: "" }, webStaff)).statusCode).toBe(403);
    expect((await comment(openCycle, "d-seo", {}, webHead)).statusCode).toBe(403);
  });

  // ═══════════════════════════════ the assessment (§41.4) ═══════════════════════════════

  it("a non-approver's assessment is refused (403): the head (even of their own unit), staff, the HR tier", async () => {
    const body = { text: "Solid half.", condition: "on_track" };
    expect((await assess(openCycle, "d-web", body, webHead)).statusCode).toBe(403);
    expect((await assess(openCycle, "d-web", body, webStaff)).statusCode).toBe(403);
    expect((await assess(openCycle, "d-web", body, hr)).statusCode).toBe(403);
    // a bad body from a non-approver is still a 403
    expect((await assess(openCycle, "d-web", { text: "", condition: "bogus" }, webHead)).statusCode).toBe(403);
    expect((await read(openCycle, "d-web", admin)).json().gmAssessment).toBeNull();
  });

  it("the approver assesses (200): text, the GM's own condition, by and at; shown beside the computed condition, never replacing it", async () => {
    const r = await assess(openCycle, "d-web", { text: " Recovered well in October despite the slip. ", condition: "on_track" }, admin);
    expect(r.statusCode).toBe(200);
    expect(r.json().gmAssessment).toMatchObject({ text: "Recovered well in October despite the slip.", condition: "on_track", by: admin, byName: "admin" });

    const a: Appraisal = (await read(openCycle, "d-web", webHead)).json();
    expect(a.gmAssessment).toMatchObject({ condition: "on_track", by: admin });
    expect(a.condition).toBe("at_risk"); // the computed condition is untouched
    expect(a.hodCommentary!.text).toBe("x".repeat(4000)); // and the head's half is untouched
    expect(await storedRows(openCycle, "d-web")).toBe("1");
  });

  it("assessment validation: text 1 to 4000, condition one of on_track | at_risk | off_track (400)", async () => {
    const bad: Array<[unknown, string]> = [
      [{ condition: "on_track" }, "text"],
      [{ text: "", condition: "on_track" }, "text"],
      [{ text: "x".repeat(4001), condition: "on_track" }, "text"],
      [{ text: "Fine." }, "condition"],
      [{ text: "Fine.", condition: "unavailable" }, "condition"],
      [{ text: "Fine.", condition: "great" }, "condition"],
      [{ text: "Fine.", condition: 3 }, "condition"],
    ];
    for (const [body, field] of bad) {
      const r = await assess(openCycle, "d-web", body, admin);
      expect(r.statusCode, JSON.stringify(body).slice(0, 50)).toBe(400);
      expect(r.json().field).toBe(field);
    }
    for (const condition of ["on_track", "at_risk", "off_track"]) {
      expect((await assess(openCycle, "d-seo", { text: "Judged.", condition }, admin)).statusCode).toBe(200);
    }
  });

  it("an unknown unit or cycle on a write: 404 for the approver; a head gets 403 for a unit that is not theirs", async () => {
    const noUnit = await assess(openCycle, "d-nope", { text: "x", condition: "on_track" }, admin);
    expect(noUnit.statusCode).toBe(404);
    expect(noUnit.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
    const noCycle = await assess(newId(), "d-web", { text: "x", condition: "on_track" }, admin);
    expect(noCycle.statusCode).toBe(404);
    expect(noCycle.json()).toMatchObject({ error: "cycle_not_found", field: "cycleId" });
    expect((await comment("not-a-uuid", "d-web", { text: "x" }, admin)).statusCode).toBe(404);
    expect((await comment(openCycle, "d-nope", { text: "x" }, webHead)).statusCode).toBe(403);
    expect((await comment(newId(), "d-web", { text: "x" }, webHead)).statusCode).toBe(404); // theirs, but no such cycle
  });

  it("every write is recorded in the activity log (the verb and the unit, never the text)", async () => {
    const acts = await withTenants([co], async (c) =>
      (await c.query<{ verb: string; metadata: Record<string, unknown> }>(
        `SELECT verb, metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'dept_appraisal' AND actor_id = $2 AND verb = 'assessed'`,
        [co, admin],
      )).rows,
    );
    expect(acts.length).toBe(4); // d-web once, d-seo three times
    for (const a of acts) {
      expect(Object.keys(a.metadata)).not.toContain("text");
      expect(a.metadata).toMatchObject({ cycleId: openCycle });
    }
    expect(acts.map((a) => a.metadata.unitNodeId).sort()).toEqual(["d-seo", "d-seo", "d-seo", "d-web"]);
  });

  // ═══════════════════════════════ a closed cycle (§41.2) ═══════════════════════════════

  it("writes on a closed cycle get 409 cycle_closed for both halves, and store nothing; the closed cycle still reads", async () => {
    const c = await comment(closedCycle, "d-web", { text: "Too late." }, webHead);
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toBe("cycle_closed");
    const g = await assess(closedCycle, "d-web", { text: "Too late.", condition: "on_track" }, admin);
    expect(g.statusCode).toBe(409);
    expect(g.json().error).toBe("cycle_closed");
    expect(await storedRows(closedCycle, "d-web")).toBe("0");
    const a = await read(closedCycle, "d-web", admin);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ cycle: { status: "closed" }, hodCommentary: null, gmAssessment: null });
  });

  it("closing the cycle ends the writes; the record stays: a row written while open is kept and still read after the close", async () => {
    expect((await comment(openCycle, "d-seo", { text: "Written while open." }, admin)).statusCode).toBe(200);
    await withTenants([co], (c) => c.query(`UPDATE report_appraisal_cycles SET status = 'closed' WHERE id = $1`, [openCycle]), { modules: ["reports"] });
    const late = await comment(openCycle, "d-seo", { text: "Edited after close." }, admin);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("cycle_closed");
    const a: Appraisal = (await read(openCycle, "d-seo", admin)).json();
    expect(a.cycle.status).toBe("closed");
    expect(a.hodCommentary!.text).toBe("Written while open.");
    await withTenants([co], (c) => c.query(`UPDATE report_appraisal_cycles SET status = 'open' WHERE id = $1`, [openCycle]), { modules: ["reports"] });
  });

  // ═══════════════════════════════ the walls ═══════════════════════════════

  it("dept_appraisals sits behind the tenant wall AND the reports module wall, and its CHECKs hold each half whole", async () => {
    const withReports = await withTenants([co], async (c) => (await c.query(`SELECT id FROM dept_appraisals`)).rows.length, { modules: ["reports"] });
    expect(withReports).toBeGreaterThan(0);
    const withoutModule = await withTenants([co], async (c) => (await c.query(`SELECT id FROM dept_appraisals`)).rows.length);
    expect(withoutModule).toBe(0);
    const otherTenant = await withTenants([other], async (c) => (await c.query(`SELECT id FROM dept_appraisals`)).rows.length, { modules: ["reports"] });
    expect(otherTenant).toBe(0);
    // a half with text but no author is refused by the database, and so is a condition outside the three
    await expect(
      withTenants(
        [co],
        (c) =>
          c.query(`INSERT INTO dept_appraisals (id, tenant_id, cycle_id, unit_node_id, hod_commentary, origin_site) VALUES ($1,$2,$3,'d-x','text',$4)`, [newId(), co, openCycle, config.originSite]),
        { modules: ["reports"] },
      ),
    ).rejects.toThrow();
    await expect(
      withTenants(
        [co],
        (c) =>
          c.query(
            `INSERT INTO dept_appraisals (id, tenant_id, cycle_id, unit_node_id, gm_assessment, gm_condition, gm_by, gm_at, origin_site)
             VALUES ($1,$2,$3,'d-y','text','great',$4,now(),$5)`,
            [newId(), co, openCycle, admin, config.originSite],
          ),
        { modules: ["reports"] },
      ),
    ).rejects.toThrow();
  });

  it("the composite FK is tenant-scoped: a row cannot carry another company's cycle", async () => {
    await expect(
      withTenants(
        [other],
        (c) =>
          c.query(`INSERT INTO dept_appraisals (id, tenant_id, cycle_id, unit_node_id, hod_commentary, hod_by, hod_at, origin_site)
                   VALUES ($1,$2,$3,'d-web','cross',$4,now(),$5)`, [newId(), other, openCycle, admin, config.originSite]),
        { modules: ["reports"] },
      ),
    ).rejects.toThrow();
  });
});
