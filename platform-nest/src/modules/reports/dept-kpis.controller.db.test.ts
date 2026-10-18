// DW-4e-1 — department KPIs over the REAL HTTP surface (buildApp + app.inject), against live Postgres + RLS + Cerbos
// (cerbos/policies/resource_dept_kpi_target.yaml). Covers docs/FRONTEND-BFF-CONTRACT.md §40's proof list, live half:
//   * a head proposes for their unit (201) and is refused another unit (403);
//   * the head cannot approve their own proposal (409); a non-approver's approve is refused (403);
//   * an approved target is in force from its month, and the previous one before it; a pending proposal changes
//     nothing; approving supersedes the approved rows from its month on;
//   * unavailable for a module KPI, for a ratio with a 0 denominator and for no target;
//   * staff of the unit may read, staff of another unit may not (and a division's staff read their department, never
//     the reverse);
//   * the overview is for the company-wide tiers only, worst first, and the GM's departments-in-good-condition counts
//     the OTHER departments only;
//   * the numbers equal the Reports page's department document.
// The catalogue/registry parity, the slug golden table and the condition boundaries are pinned in dept-kpis.test.ts
// (pure); the policy matrix in src/rbac/cerbos-dept-kpi-target.test.ts.
//
// The org tree is written in the REAL stored shape (`{root: ...}`) and the closure is built with the PRODUCTION
// builder: without the closure every org_unit_lead rule denies. All values are September 2026 milestones, which the
// report reads live from pm_milestones, so no fact job is needed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withGlobal, withTenants } from "../../db";
import { adminPool, initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantLeadSeat, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const SEPT = "periodKind=month&start=2026-09-01";
const OCT = "periodKind=month&start=2026-10-01";
const JULY = "periodKind=month&start=2026-07-01";

type Kpi = {
  key: string; value: number | null; numerator?: number; denominator?: number; target: number | null; tolerance: number | null;
  targetSource: string; condition: string; reason?: string;
};

describe.skipIf(!TEST_URL)("DW-4e-1 department KPIs (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string; // a second company, for the RLS wall
  let admin: string; // company_admin: the approver
  let admin2: string; // a second approver
  let webHead: string; // org_unit_lead @ d-web + manager + member, placed in d-web (the real head shape)
  let webStaff: string; // member, placed in d-web
  let feStaff: string; // member, placed in dv-fe (a division of d-web)
  let seoStaff: string; // member, placed in d-seo
  let hr: string; // hr_staff + member: a company-wide reader
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

  const read = (qs: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/dept-kpis?${qs}`, headers: asUser(as) });
  const overview = (qs: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/dept-kpis/overview?${qs}`, headers: asUser(as) });
  const targets = (unit: string, as: string) => app.inject({ method: "GET", url: `/api/${co}/dept-kpis/targets?unitNodeId=${unit}`, headers: asUser(as) });
  const propose = (body: Record<string, unknown>, as: string) =>
    app.inject({ method: "POST", url: `/api/${co}/dept-kpis/targets`, headers: asUser(as), payload: body });
  const approve = (id: string, as: string) => app.inject({ method: "POST", url: `/api/${co}/dept-kpis/targets/${id}/approve`, headers: asUser(as), payload: {} });
  const reject = (id: string, as: string, note?: string) =>
    app.inject({ method: "POST", url: `/api/${co}/dept-kpis/targets/${id}/reject`, headers: asUser(as), payload: note ? { note } : {} });
  const kpiOf = (r: { json: () => { kpis: Kpi[] } }, key: string): Kpi => {
    const k = r.json().kpis.find((x) => x.key === key);
    if (!k) throw new Error(`no KPI ${key}`);
    return k;
  };
  const statusOf = async (id: string) =>
    withTenants([co], async (c) => (await c.query<{ status: string }>(`SELECT status FROM dept_kpi_targets WHERE id = $1`, [id])).rows[0]?.status, {
      modules: ["reports"],
    });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("DW-4e Co", ["reports", "pm", "hr"]);
    other = await createCompany("DW-4e Other", ["reports"]);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [co]));

    admin = await createUser("admin@dw4e.test");
    admin2 = await createUser("admin2@dw4e.test");
    webHead = await createUser("web-head@dw4e.test");
    webStaff = await createUser("web-staff@dw4e.test");
    feStaff = await createUser("fe-staff@dw4e.test");
    seoStaff = await createUser("seo-staff@dw4e.test");
    hr = await createUser("hr@dw4e.test");
    const everyone = [admin, admin2, webHead, webStaff, feStaff, seoStaff, hr];
    for (const u of everyone) await addMembership(co, u);

    const member = await createRole("member");
    for (const u of everyone) await grantRole(u, member, "company", co);
    const companyAdmin = await createRole("company_admin");
    await grantRole(admin, companyAdmin, "company", co);
    await grantRole(admin2, companyAdmin, "company", co);
    await grantRole(webHead, await createRole("org_unit_lead"), "org_unit", "d-web");
    await grantRole(webHead, await createRole("manager"), "company", co);
    await grantLeadSeat(co, "d-web", webHead); // DW-10g: the real head shape includes the company's own lead seat
    await grantRole(hr, await createRole("hr_staff"), "company", co);

    const root = {
      id: "d-corp",
      kind: "company",
      name: "DW-4e Co",
      children: [
        { id: "d-web", kind: "department", name: "Web Dev", children: [{ id: "dv-fe", kind: "division", name: "Frontend", children: [] }] },
        { id: "d-seo", kind: "department", name: "SEO", children: [] },
        { id: "d-gm", kind: "department", name: "GM", children: [] },
        { id: "d-ops", kind: "department", name: "Operations", children: [] },
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

    // September 2026: Web Dev hits 4 of 5 milestones (0.8), Operations 0 of 2 (0).
    await milestones("d-web", "2026-09-15", 5, 4);
    await milestones("d-ops", "2026-09-20", 2, 0);

    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ propose (§40.2) ═══════════════════════════════

  it("a head proposes a target for their unit (201 {id, status: proposed}) and is refused another unit (403)", async () => {
    const r = await propose({ unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-08-01", target: 0.85, tolerance: 0.05, note: "Q3" }, webHead);
    expect(r.statusCode).toBe(201);
    expect(Object.keys(r.json()).sort()).toEqual(["id", "status"]);
    expect(r.json().status).toBe("proposed");
    ids.A = r.json().id;

    const seo = await propose({ unitNodeId: "d-seo", kpiKey: "client-retention", effectiveFrom: "2026-08-01", target: 0.9, tolerance: 0.05 }, webHead);
    expect(seo.statusCode).toBe(403);
    // a division of their department is inside their line (the lead rule's ancestry)
    const fe = await propose({ unitNodeId: "dv-fe", kpiKey: "overdue-tasks", effectiveFrom: "2026-08-01", target: 0, tolerance: 3 }, webHead);
    expect(fe.statusCode).toBe(201);
  });

  it("plain staff and the HR tier cannot propose (403); the approver can", async () => {
    const body = { unitNodeId: "d-web", kpiKey: "reopened-work-rate", effectiveFrom: "2026-09-01", target: 0.05, tolerance: 0.03 };
    expect((await propose(body, webStaff)).statusCode).toBe(403);
    expect((await propose(body, hr)).statusCode).toBe(403);
    const r = await propose(body, admin);
    expect(r.statusCode).toBe(201);
    ids.reopen = r.json().id;
  });

  it("validation: a month that is not a month start, a KPI not in the unit's set, a percent outside 0..1 -> 400", async () => {
    const ok = { unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-08-01", target: 0.85, tolerance: 0.05 };
    const midMonth = await propose({ ...ok, effectiveFrom: "2026-08-15" }, webHead);
    expect(midMonth.statusCode).toBe(400);
    expect(midMonth.json().field).toBe("effectiveFrom");
    const notInSet = await propose({ ...ok, kpiKey: "overdue-tasks" }, webHead); // a generic KPI, not Web Dev's
    expect(notInSet.statusCode).toBe(400);
    expect(notInSet.json().field).toBe("kpiKey");
    expect((await propose({ ...ok, target: 85 }, webHead)).statusCode).toBe(400);
    expect((await propose({ ...ok, tolerance: -1 }, webHead)).statusCode).toBe(400);
  });

  it("an unknown unit: 404 unit_not_found for the approver, 403 for a head (no existence leak)", async () => {
    const body = { unitNodeId: "d-nope", kpiKey: "projects-on-time", effectiveFrom: "2026-08-01", target: 0.85, tolerance: 0.05 };
    const a = await propose(body, admin);
    expect(a.statusCode).toBe(404);
    expect(a.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
    expect((await propose(body, webHead)).statusCode).toBe(403);
  });

  // ═══════════════════════════════ approve / reject ═══════════════════════════════

  it("the head cannot approve their own proposal (409 cannot_approve_own_proposal); the row stays proposed", async () => {
    const r = await approve(ids.A, webHead);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("cannot_approve_own_proposal");
    expect(await statusOf(ids.A)).toBe("proposed");
  });

  it("an approver who proposed cannot approve their own proposal either (409)", async () => {
    expect((await approve(ids.reopen, admin)).statusCode).toBe(409);
  });

  it("a non-approver's approve is refused (403): a head on someone else's proposal, staff, the HR tier", async () => {
    expect((await approve(ids.reopen, webHead)).statusCode).toBe(403);
    expect((await approve(ids.reopen, webStaff)).statusCode).toBe(403);
    expect((await approve(ids.reopen, hr)).statusCode).toBe(403);
    expect((await reject(ids.reopen, webHead)).statusCode).toBe(403);
    expect(await statusOf(ids.reopen)).toBe("proposed");
  });

  it("an unknown or malformed id is 404", async () => {
    expect((await approve(newId(), admin)).statusCode).toBe(404);
    expect((await approve("not-a-uuid", admin)).statusCode).toBe(404);
  });

  it("the approver approves (200, the row in force) and the decision is recorded in the activity log", async () => {
    const r = await approve(ids.A, admin);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: ids.A, status: "approved", decidedBy: admin, unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-08-01", target: 0.85, tolerance: 0.05 });
    expect((await approve(ids.reopen, admin2)).statusCode).toBe(200);
    // a decided row cannot be decided again
    const again = await approve(ids.A, admin2);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("not_proposed");

    const verbs = await withTenants([co], async (c) =>
      (await c.query<{ verb: string }>(`SELECT verb FROM activities WHERE tenant_id = $1 AND target_entity_type = 'dept_kpi_target' AND target_entity_id = $2 AND verb IN ('proposed', 'approved', 'rejected') ORDER BY occurred_at`, [co, ids.A])).rows.map((x) => x.verb),
    );
    expect(verbs).toEqual(["proposed", "approved"]);
  });

  it("reject: the approver rejects (200); a rejected proposal can no longer be approved (409)", async () => {
    const p = await propose({ unitNodeId: "d-web", kpiKey: "client-site-uptime", effectiveFrom: "2026-09-01", target: 0.99, tolerance: 0.005 }, webHead);
    expect(p.statusCode).toBe(201);
    const r = await reject(p.json().id, admin, "too low");
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("rejected");
    expect((await approve(p.json().id, admin2)).statusCode).toBe(409);
  });

  // ═══════════════════════════════ in force (§40.2) ═══════════════════════════════

  it("an approved target is in force from its month; a pending proposal changes nothing; before it there is no target", async () => {
    // A (from August) is in force in September and October.
    expect(kpiOf(await read(`unitNodeId=d-web&${SEPT}`, webStaff), "projects-on-time")).toMatchObject({ target: 0.85, tolerance: 0.05, targetSource: "approved" });
    // B proposes 0.9 from October: until it is approved, October still reads A.
    const b = await propose({ unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-10-01", target: 0.9, tolerance: 0.05 }, webHead);
    expect(b.statusCode).toBe(201);
    ids.B = b.json().id;
    expect(kpiOf(await read(`unitNodeId=d-web&${OCT}`, webStaff), "projects-on-time").target).toBe(0.85);
    // July precedes every target.
    const july = kpiOf(await read(`unitNodeId=d-web&${JULY}`, webStaff), "projects-on-time");
    expect(july).toMatchObject({ target: null, tolerance: null, targetSource: "none", condition: "unavailable" });
  });

  it("once approved, the newer target is in force from ITS month and the previous one still governs the months before", async () => {
    expect((await approve(ids.B, admin)).statusCode).toBe(200);
    expect(kpiOf(await read(`unitNodeId=d-web&${OCT}`, webStaff), "projects-on-time").target).toBe(0.9);
    expect(kpiOf(await read(`unitNodeId=d-web&${SEPT}`, webStaff), "projects-on-time").target).toBe(0.85);
    expect(await statusOf(ids.A)).toBe("approved");
  });

  it("approving a target supersedes the approved rows from its month ON (the same month and later), never an earlier one", async () => {
    const c = await propose({ unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-08-01", target: 0.8, tolerance: 0.05 }, admin);
    expect(c.statusCode).toBe(201);
    ids.C = c.json().id;
    const r = await approve(ids.C, admin2);
    expect(r.statusCode).toBe(200);
    expect(r.json().superseded).toEqual([ids.A, ids.B].sort());
    expect(await statusOf(ids.A)).toBe("superseded");
    expect(await statusOf(ids.B)).toBe("superseded");
    expect(kpiOf(await read(`unitNodeId=d-web&${OCT}`, webStaff), "projects-on-time").target).toBe(0.8);
    expect(kpiOf(await read(`unitNodeId=d-web&${SEPT}`, webStaff), "projects-on-time").target).toBe(0.8);
    // one approved row per (unit, KPI, month): the database agrees
    const approved = await withTenants(
      [co],
      async (cl) =>
        (await cl.query<{ n: string }>(`SELECT count(*)::text AS n FROM dept_kpi_targets WHERE tenant_id = $1 AND unit_node_id = 'd-web' AND kpi_key = 'projects-on-time' AND status = 'approved'`, [co])).rows[0].n,
      { modules: ["reports"] },
    );
    expect(approved).toBe("1");
  });

  // ═══════════════════════════════ the unit read (§40.3) ═══════════════════════════════

  it("a unit's KPIs: Web Dev's set in order, the value is the Reports page's number, and the condition is computed at the boundary", async () => {
    const r = await read(`unitNodeId=d-web&${SEPT}`, webStaff);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.unit).toEqual({ id: "d-web", name: "Web Dev" });
    expect(body.workspace).toBe("web-dev");
    expect(body.period).toEqual({ periodKind: "month", start: "2026-09-01", end: "2026-09-30" });
    expect(body.kpis.map((k: Kpi) => k.key)).toEqual(["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"]);

    // 4 of 5 milestones = 0.8 against 0.8 (C) -> on track: equal to the target is on track
    const onTime = kpiOf(r, "projects-on-time");
    expect(onTime).toMatchObject({ value: 0.8, numerator: 4, denominator: 5, target: 0.8, condition: "on_track" });

    // the same number the Reports page shows for this department and month
    const doc = await app.inject({ method: "GET", url: `/api/${co}/reports/document?grain=department&scopeRef=d-web&${SEPT}`, headers: asUser(admin) });
    expect(doc.statusCode).toBe(200);
    const fact = doc.json().kpis.find((k: { metricKey: string }) => k.metricKey === "delivery.milestone_hit_rate");
    expect({ value: onTime.value, numerator: onTime.numerator, denominator: onTime.denominator }).toEqual({ value: fact.value, numerator: fact.numerator, denominator: fact.denominator });
  });

  it("unavailable: a module KPI with nothing to measure (no_data), a ratio with a 0 denominator (no_data, even with a target), and no target (no_target)", async () => {
    const r = await read(`unitNodeId=d-web&${SEPT}`, webStaff);
    // DW-6n1 gave requests-within-sla a reader; the unit has no requests due, so it reads no_data (no_reader stays pinned in
    // dept-kpis.test.ts and dept-kpi-readers.engine.db.test.ts, for a module KPI without a readerId).
    expect(kpiOf(r, "requests-within-sla")).toMatchObject({ value: null, condition: "unavailable", reason: "no_data", targetSource: "none" });
    // reopened-work-rate has an approved target from September, but no completed work: reopened / completed = 0 / 0
    expect(kpiOf(r, "reopened-work-rate")).toMatchObject({ value: null, target: 0.05, targetSource: "approved", condition: "unavailable", reason: "no_data" });
    // Operations (generic): 0 overdue tasks is a real 0 with no target
    const ops = await read(`unitNodeId=d-ops&${SEPT}`, admin);
    expect(ops.json().workspace).toBe("generic");
    expect(kpiOf(ops, "overdue-tasks")).toMatchObject({ value: 0, target: null, targetSource: "none", condition: "unavailable", reason: "no_target" });
  });

  it("the department's condition follows its KPIs: inside the tolerance is at risk, beyond it off track", async () => {
    // Operations hits 0 of 2 milestones against 0.85 / 0.05: off track
    const p = await propose({ unitNodeId: "d-ops", kpiKey: "projects-on-time", effectiveFrom: "2026-09-01", target: 0.85, tolerance: 0.05 }, admin);
    expect((await approve(p.json().id, admin2)).statusCode).toBe(200);
    const ops = await read(`unitNodeId=d-ops&${SEPT}`, admin);
    expect(kpiOf(ops, "projects-on-time")).toMatchObject({ value: 0, condition: "off_track" });
    expect(ops.json().condition).toBe("off_track");
    // Web Dev: 0.8 against 0.85 / 0.05 from September (C, from August, keeps governing August) is exactly at the
    // tolerance: at risk (no float miss)
    const w = await propose({ unitNodeId: "d-web", kpiKey: "projects-on-time", effectiveFrom: "2026-09-01", target: 0.85, tolerance: 0.05 }, webHead);
    expect((await approve(w.json().id, admin)).statusCode).toBe(200);
    const web = await read(`unitNodeId=d-web&${SEPT}`, webStaff);
    expect(kpiOf(web, "projects-on-time")).toMatchObject({ value: 0.8, target: 0.85, condition: "at_risk" });
    expect(web.json().condition).toBe("at_risk");
  });

  it("who may read: staff of the unit and of its divisions, its head, the company-wide tiers; never another unit's staff", async () => {
    expect((await read(`unitNodeId=d-web&${SEPT}`, webStaff)).statusCode).toBe(200);
    expect((await read(`unitNodeId=d-web&${SEPT}`, feStaff)).statusCode).toBe(200); // a division's staff see their department
    expect((await read(`unitNodeId=dv-fe&${SEPT}`, webStaff)).statusCode).toBe(403); // never the reverse
    expect((await read(`unitNodeId=d-web&${SEPT}`, seoStaff)).statusCode).toBe(403); // another department's staff
    expect((await read(`unitNodeId=d-seo&${SEPT}`, webStaff)).statusCode).toBe(403);
    expect((await read(`unitNodeId=dv-fe&${SEPT}`, webHead)).statusCode).toBe(200); // the head of the enclosing unit
    expect((await read(`unitNodeId=d-seo&${SEPT}`, webHead)).statusCode).toBe(403); // a head of another unit
    expect((await read(`unitNodeId=d-seo&${SEPT}`, hr)).statusCode).toBe(200);
    expect((await read(`unitNodeId=d-seo&${SEPT}`, admin)).statusCode).toBe(200);
  });

  it("DW-10g: the head of a same-id d-web in ANOTHER company (its org_unit_lead grant and its seat there) is no head of this company's d-web; a seat here makes one", async () => {
    const twoCo = await createUser("two-co-head@dw4e.test");
    try {
      for (const t of [co, other]) {
        await addMembership(t, twoCo);
        await grantRole(twoCo, await createRole("member"), "company", t);
      }
      await grantRole(twoCo, await createRole("org_unit_lead"), "org_unit", "d-web"); // a bare node id: names this company's d-web too
      await grantLeadSeat(other, "d-web", twoCo);
      expect((await read(`unitNodeId=d-web&${SEPT}`, twoCo)).statusCode).toBe(403);
      expect((await read(`unitNodeId=dv-fe&${SEPT}`, twoCo)).statusCode).toBe(403);
      expect((await targets("d-web", twoCo)).statusCode).toBe(403);
      // DW-10g-2: the department's report document. Cerbos's org_unit_lead `read_department` rule matches the bare node id; the
      // person-axis narrowing (`loadLedUnitScope`, company-anchored) does not, so it is a 403, as for a plain member.
      const docAs = (as: string) => app.inject({ method: "GET", url: `/api/${co}/reports/document?grain=department&scopeRef=d-web&${SEPT}`, headers: asUser(as) });
      expect((await docAs(twoCo)).statusCode).toBe(403);
      await grantLeadSeat(co, "d-web", twoCo);
      expect((await docAs(twoCo)).statusCode).toBe(200);
      expect((await read(`unitNodeId=d-web&${SEPT}`, twoCo)).statusCode).toBe(200);
      expect((await read(`unitNodeId=dv-fe&${SEPT}`, twoCo)).statusCode).toBe(200); // a seat covers the unit's divisions
      expect((await read(`unitNodeId=d-seo&${SEPT}`, twoCo)).statusCode).toBe(403);
    } finally {
      await adminPool().query(`UPDATE company_memberships SET status = 'ended' WHERE user_id = $1`, [twoCo]);
    }
  });

  it("an unknown unit: 404 unit_not_found for a company-wide caller, 403 for staff; no unitNodeId is 400", async () => {
    const hrRead = await read(`unitNodeId=d-nope&${SEPT}`, hr);
    expect(hrRead.statusCode).toBe(404);
    expect(hrRead.json()).toMatchObject({ error: "unit_not_found", field: "unitNodeId" });
    expect((await read(`unitNodeId=d-nope&${SEPT}`, webStaff)).statusCode).toBe(403);
    expect((await read(SEPT, admin)).statusCode).toBe(400);
    expect((await read(`unitNodeId=d-web&periodKind=month`, admin)).statusCode).toBe(400);
  });

  // ═══════════════════════════════ targets list ═══════════════════════════════

  it("the targets list: each KPI's in-force row, open proposals and history, read under the same unit gate", async () => {
    const p = await propose({ unitNodeId: "d-web", kpiKey: "reopened-work-rate", effectiveFrom: "2026-11-01", target: 0.04, tolerance: 0.02 }, webHead);
    expect(p.statusCode).toBe(201);
    const r = await targets("d-web", webStaff);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.unit).toEqual({ id: "d-web", name: "Web Dev" });
    expect(body.workspace).toBe("web-dev");
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-01$/);
    expect(body.kpis.map((k: { key: string }) => k.key)).toEqual(["projects-on-time", "requests-within-sla", "client-site-uptime", "reopened-work-rate"]);
    const onTime = body.kpis[0];
    expect(onTime).toMatchObject({ unit: "percent", direction: "up_good", suggestedTarget: 0.85, suggestedTolerance: 0.05, proposals: [] });
    expect(onTime.history.map((h: { id: string }) => h.id)).toEqual(expect.arrayContaining([ids.A, ids.B, ids.C]));
    const reopen = body.kpis[3];
    expect(reopen.proposals.map((x: { id: string }) => x.id)).toEqual([p.json().id]);
    expect(reopen.inForce?.id).toBe(ids.reopen);
    expect((await targets("d-web", seoStaff)).statusCode).toBe(403);
    expect((await targets("d-nope", admin)).statusCode).toBe(404);
  });

  // ═══════════════════════════════ the overview (standing) ═══════════════════════════════

  it("the overview is for the company-wide tiers only: a head (manager) and staff are refused", async () => {
    expect((await overview(SEPT, webHead)).statusCode).toBe(403);
    expect((await overview(SEPT, webStaff)).statusCode).toBe(403);
    expect((await overview(SEPT, hr)).statusCode).toBe(200);
  });

  it("every department, worst first then by name; the GM's departments-in-good-condition counts the OTHER departments only", async () => {
    // Before a GM target: GM's derived KPI has a value (0 of Web Dev at_risk + Operations off_track; SEO has no
    // condition and the GM itself is not counted) but no target, so the GM is unavailable and sorts last with SEO.
    const before = await overview(SEPT, admin);
    expect(before.statusCode).toBe(200);
    const rows = before.json().departments as Array<{ unit: { id: string }; condition: string; kpis: Kpi[] }>;
    expect(rows.map((d) => d.unit.id)).toEqual(["d-ops", "d-web", "d-gm", "d-seo"]);
    expect(rows.map((d) => d.condition)).toEqual(["off_track", "at_risk", "unavailable", "unavailable"]);
    const gm = rows.find((d) => d.unit.id === "d-gm")!;
    expect(gm.kpis.find((k) => k.key === "departments-in-good-condition")).toMatchObject({ value: 0, numerator: 0, denominator: 2, reason: "no_target" });

    // With a GM target of 0.5 +/- 0.5, 0 is exactly at the tolerance: the GM is at risk and sorts before Web Dev by name.
    const p = await propose({ unitNodeId: "d-gm", kpiKey: "departments-in-good-condition", effectiveFrom: "2026-09-01", target: 0.5, tolerance: 0.5 }, admin);
    expect((await approve(p.json().id, admin2)).statusCode).toBe(200);
    const after = (await overview(SEPT, admin)).json().departments as Array<{ unit: { id: string }; condition: string }>;
    expect(after.map((d) => d.unit.id)).toEqual(["d-ops", "d-gm", "d-web", "d-seo"]);
    expect(after.map((d) => d.condition)).toEqual(["off_track", "at_risk", "at_risk", "unavailable"]);
    // and the GM's own read agrees with its overview row
    const gmRead = await read(`unitNodeId=d-gm&${SEPT}`, admin);
    expect(gmRead.json()).toMatchObject({ workspace: "gm", condition: "at_risk" });
  });

  // ═══════════════════════════════ the walls ═══════════════════════════════

  it("dept_kpi_targets sits behind the tenant wall AND the reports module wall", async () => {
    const withReports = await withTenants([co], async (c) => (await c.query(`SELECT id FROM dept_kpi_targets`)).rows.length, { modules: ["reports"] });
    expect(withReports).toBeGreaterThan(0);
    const withoutModule = await withTenants([co], async (c) => (await c.query(`SELECT id FROM dept_kpi_targets`)).rows.length);
    expect(withoutModule).toBe(0);
    const otherTenant = await withTenants([other], async (c) => (await c.query(`SELECT id FROM dept_kpi_targets`)).rows.length, { modules: ["reports"] });
    expect(otherTenant).toBe(0);
  });
});
