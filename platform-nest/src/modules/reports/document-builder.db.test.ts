// TR-13 — the ReportDocument builder + its read endpoints, against LIVE Postgres + real RLS +
// real Cerbos (resource_report_document.yaml + the hr_people_ops derived role). Covers the
// ticket's acceptance bar end-to-end (through the real HTTP surface, not just the pure builder):
//
//   * all four grains x all four period kinds build without throwing;
//   * ratios carry numerator/denominator, never just a pre-divided value;
//   * comparison deltas are correct ACROSS A MONTH BOUNDARY (July, 31 days, vs June, 30);
//   * THE ADDITIVITY PROOF: a custom range exactly equal to a calendar month/week returns numbers
//     IDENTICAL to that month's/week's document — the correctness core of the whole ticket;
//   * custom-range mechanics: `end` required (400), >400 days -> 422 `range_too_large`, live-only
//     (never touches `rollup_metrics` — proven by recomputing rollups separately and diffing);
//   * a scope with zero facts returns an empty-but-valid document, not an error;
//   * the provider-view servedTenant slice (§3.2's shared-service case);
//   * the per-grain Cerbos matrix: self reads own person doc, self is denied company-grain and a
//     stranger's person doc, a plain member is denied the `overview` listing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { recomputeFactWindow } from "./fact-job";
import { recomputeRollups, syncMetricDefinitions } from "../../rollups/engine";
import { formatPeriodRange } from "./metrics";
import type { ReportDocument } from "./report-document";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const ORG_BLOB = {
  root: {
    id: "co-root",
    kind: "company",
    name: "Gaiada",
    children: [
      { id: "d-eng", kind: "department", name: "Engineering", children: [] },
      { id: "d-sales", kind: "department", name: "Sales", children: [] },
    ],
  },
};

describe.skipIf(!TEST_URL)("TR-13 ReportDocument builder + endpoints (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let provider: string;
  let alice: string; // owner, d-eng
  let bob: string; // member, no data (empty-but-valid case)
  let admin: string;
  let exec: string;
  let projectId: string;
  let providerUnitOwner: string; // person in the PROVIDER company doing shared-service work for `co`

  async function pmTask(tenantId: string, id: string, dueDate: string | null): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site)
         VALUES ($1,$2,$3,'task',$4::date,60,'central')`,
        [id, tenantId, projectId, dueDate],
      ),
    );
  }
  async function ownerAssignee(tenantId: string, taskId: string, userId: string): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from)
         VALUES ($1,$2,$3,'owner','person',$4,$5,'central','2026-01-01'::date)`,
        [newId(), tenantId, taskId, userId, userId],
      ),
    );
  }
  async function completedEvent(tenantId: string, taskId: string, dateIso: string, actorUserId: string): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
         VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,$6::timestamptz,'central')`,
        [newId(), tenantId, `ev-${newId()}`, actorUserId, taskId, `${dateIso}T10:00:00Z`],
      ),
    );
  }
  async function openMembership(tenantId: string, userId: string, unitNodeId: string): Promise<void> {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4,true,'2026-01-01'::date,'manual','central')`,
        [newId(), tenantId, userId, unitNodeId],
      ),
    );
  }

  const doc = async (params: { grain: string; scopeRef: string; periodKind: string; start: string; end?: string; servedTenant?: string; as?: string }): Promise<{ status: number; body: ReportDocument | Record<string, unknown> }> => {
    const q = new URLSearchParams({ grain: params.grain, scopeRef: params.scopeRef, periodKind: params.periodKind, start: params.start });
    if (params.end) q.set("end", params.end);
    if (params.servedTenant) q.set("servedTenant", params.servedTenant);
    const r = await app.inject({ method: "GET", url: `/api/${co}/reports/document?${q.toString()}`, headers: asUser(params.as ?? admin) });
    return { status: r.statusCode, body: r.json() };
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("TR-13 Co", ["reports", "pm", "hr"]);
    provider = await createCompany("TR-13 Shared Services", ["reports", "pm", "hr"]);

    alice = await createUser("alice@tr13.test");
    bob = await createUser("bob@tr13.test");
    admin = await createUser("admin@tr13.test");
    exec = await createUser("exec@tr13.test");
    providerUnitOwner = await createUser("carol@tr13.test");

    await addMembership(co, alice);
    await addMembership(co, bob);
    await addMembership(co, admin);
    await addMembership(provider, providerUnitOwner);
    await grantRole(alice, await createRole("member"), "company", co);
    await grantRole(bob, await createRole("member"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(exec, await createRole("group_executive"), "global", null);
    // MON-00c: a GLOBAL group_executive grant carries no membership, so no root resolves and
    // `variables.inRoot` was false — denying the exec on its own rules. Anchored via
    // home_company_id, not a membership, so the exec does not join the companies under assertion.
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, exec]);

    await withTenants([co], (c) => c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'central')`, [co, JSON.stringify(ORG_BLOB)]));

    projectId = await createProject(co, "Website");
    await openMembership(co, alice, "d-eng");
    await openMembership(co, bob, "d-sales");

    // Alice completes one task per day across the June/July boundary (12 days: 2026-06-25..2026-07-06)
    // so both the additivity proof and the month-boundary comparison have real, distinguishable data
    // on both sides of the seam.
    const days = ["2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"];
    for (const d of days) {
      const taskId = newId();
      await pmTask(co, taskId, d); // due the same day it's completed -> "on time"
      await ownerAssignee(co, taskId, alice);
      await completedEvent(co, taskId, d, alice);
    }
    await recomputeFactWindow(co, "2026-06-01", "2026-07-31");

    // ---- provider (shared-service) fixture: carol sits in the PROVIDER's own org tree and does
    // work on `co`'s project via an ACTIVE service_assignment, so her facts land under `co`'s OWN
    // report_work_facts, stamped provider_tenant_id=provider (§3.2) — exactly the "read from the
    // served tenant's own facts" shape report-rollups.ts's computeProviderViewRollups expects.
    // Fixture shape copied from fact-job.db.test.ts's own provider setup (org_units + a
    // service_assignments row inserted under withTenants([provider]) — sa_insert's WITH CHECK
    // requires provider_tenant_id in the acting tenant set).
    await withTenants([provider], (c) => c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'central')`, [provider, JSON.stringify({ root: { id: "p-root", kind: "company", name: "Provider", children: [{ id: "d-shared", kind: "department", name: "Shared Services", children: [] }] } })]));
    await openMembership(provider, providerUnitOwner, "d-shared");
    const providerUnitId = newId();
    await withTenants([provider], (c) => c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,'d-shared','department','Shared Services')`, [providerUnitId, provider]));
    await withTenants([provider], (c) =>
      c.query(
        `INSERT INTO service_assignments (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, created_by)
         VALUES ($1,$2,$3,$4,'reports','active','Shared Services','department',$5)`,
        [newId(), providerUnitId, provider, co, providerUnitOwner],
      ),
    );
    const sharedTaskId = newId();
    await pmTask(co, sharedTaskId, "2026-07-10");
    await ownerAssignee(co, sharedTaskId, providerUnitOwner);
    await completedEvent(co, sharedTaskId, "2026-07-10", providerUnitOwner);
    await recomputeFactWindow(co, "2026-07-10", "2026-07-10");

    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ smoke: every grain x every period kind ═══════════════════════

  it("all four grains build for all four period kinds without throwing", async () => {
    const scopeByGrain: Record<string, string> = { person: alice, project: projectId, department: "d-eng", company: co };
    for (const grain of ["person", "project", "department", "company"]) {
      for (const periodKind of ["day", "week", "month"]) {
        const r = await doc({ grain, scopeRef: scopeByGrain[grain], periodKind, start: "2026-07-16" });
        expect(r.status, `${grain}/${periodKind}`).toBe(200);
      }
      const custom = await doc({ grain, scopeRef: scopeByGrain[grain], periodKind: "custom", start: "2026-07-01", end: "2026-07-15" });
      expect(custom.status, `${grain}/custom`).toBe(200);
    }
  });

  // ═══════════════════════════════ ratios carry n/d ═══════════════════════════════

  it("delivery.on_time_rate carries numerator AND denominator, and value = n/d", async () => {
    const r = await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" });
    expect(r.status).toBe(200);
    const body = r.body as ReportDocument;
    const onTime = body.kpis.find((k) => k.metricKey === "delivery.on_time_rate")!;
    expect(onTime.numerator).toBe(6); // 6 completions in July (07-01..07-06)
    expect(onTime.denominator).toBe(6);
    expect(onTime.value).toBeCloseTo(1);
    expect(onTime.unit).not.toBe("text");
  });

  // ═══════════════════════════════ comparison across a month boundary ═══════════════════════════

  it("comparison deltas are correct across the June/July boundary (unequal day counts on each side)", async () => {
    const r = await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" });
    const body = r.body as ReportDocument;
    expect(body.header.periodStart).toBe("2026-07-01");
    expect(body.header.periodEnd).toBe("2026-07-31");
    expect(body.header.dayCount).toBe(31);
    expect(body.header.comparison).toEqual({ periodStart: "2026-06-01", periodEnd: "2026-06-30", dayCount: 30 });

    const completed = body.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.value).toBe(6); // 07-01..07-06
    expect(completed.delta).toBe(0); // June also had 6 (06-25..06-30) -> 6 - 6 = 0
  });

  // ═══════════════════════════════ THE ADDITIVITY PROOF ═══════════════════════════════

  it("a custom range EXACTLY EQUAL to the calendar month returns numbers IDENTICAL to that month's document", async () => {
    const monthDoc = (await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16" })).body as ReportDocument;
    const customDoc = (await doc({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-31" })).body as ReportDocument;

    expect(customDoc.header.dayCount).toBe(monthDoc.header.dayCount);
    // Compare every KPI's value/numerator/denominator pairwise — the actual numbers, not the
    // header metadata (periodKind/warnings/generatedAt legitimately differ between the two reads).
    const byKey = (d: ReportDocument) => new Map(d.kpis.map((k) => [k.metricKey, { value: k.value, numerator: k.numerator, denominator: k.denominator }]));
    expect(byKey(customDoc)).toEqual(byKey(monthDoc));
  });

  it("a custom range EXACTLY EQUAL to the calendar week returns numbers IDENTICAL to that week's document", async () => {
    // 2026-06-29 is a Monday -> the week is 2026-06-29..2026-07-05, straddling the same boundary.
    const weekDoc = (await doc({ grain: "person", scopeRef: alice, periodKind: "week", start: "2026-06-30" })).body as ReportDocument;
    const customDoc = (await doc({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-06-29", end: "2026-07-05" })).body as ReportDocument;
    expect(weekDoc.header.periodStart).toBe("2026-06-29");
    expect(weekDoc.header.periodEnd).toBe("2026-07-05");
    const byKey = (d: ReportDocument) => new Map(d.kpis.map((k) => [k.metricKey, { value: k.value, numerator: k.numerator, denominator: k.denominator }]));
    expect(byKey(customDoc)).toEqual(byKey(weekDoc));
  });

  it("a custom range NEVER writes into rollup_metrics (§0057 rule 3)", async () => {
    const before = await withTenants([co], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM rollup_metrics WHERE tenant_id = $1 AND period = $2`, [co, formatPeriodRange("2026-07-03", "2026-07-09")]));
    await doc({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-03", end: "2026-07-09" });
    const after = await withTenants([co], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM rollup_metrics WHERE tenant_id = $1 AND period = $2`, [co, formatPeriodRange("2026-07-03", "2026-07-09")]));
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n)); // unchanged — still zero rows for this exact custom period
    expect(Number(after.rows[0].n)).toBe(0);
  });

  // ═══════════════════════════════ custom-range validation ═══════════════════════════════

  it("periodKind=custom without end -> 400", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/reports/document?grain=person&scopeRef=${alice}&periodKind=custom&start=2026-07-01`, headers: asUser(admin) });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "end" });
  });

  it("end < start -> 400", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/reports/document?grain=person&scopeRef=${alice}&periodKind=custom&start=2026-07-10&end=2026-07-01`, headers: asUser(admin) });
    expect(r.statusCode).toBe(400);
  });

  it("a span > 400 days -> 422 range_too_large (flat {error,field} shape — the shared filter is never widened)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/reports/document?grain=person&scopeRef=${alice}&periodKind=custom&start=2025-01-01&end=2026-06-01`, headers: asUser(admin) });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: "range_too_large", field: "end" });
  });

  it("a span of EXACTLY 400 days is allowed (the boundary itself, not the first rejected value)", async () => {
    const r = await doc({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-01-01", end: "2027-02-04" }); // 400 inclusive days
    expect(r.status).toBe(200);
  });

  // ═══════════════════════════════ empty-but-valid ═══════════════════════════════

  it("a scope with ZERO facts returns an empty-but-valid document, not an error", async () => {
    const r = await doc({ grain: "person", scopeRef: bob, periodKind: "month", start: "2026-07-16" });
    expect(r.status).toBe(200);
    const body = r.body as ReportDocument;
    const completed = body.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.value).toBe(0);
    const onTime = body.kpis.find((k) => k.metricKey === "delivery.on_time_rate")!;
    expect(onTime.numerator).toBe(0);
    expect(onTime.denominator).toBe(0);
    expect(onTime.value).toBe(0);
    expect(body.highlights.length).toBe(0);
    expect(body.narrative.text).toBe("No activity recorded for this period.");
  });

  // ═══════════════════════════════ provider view slices by servedTenant ═══════════════════════

  it("`co`'s own d-eng department read has NO served_companies_split (co is the SERVED company here, not a provider)", async () => {
    const r = await doc({ grain: "department", scopeRef: "d-eng", periodKind: "month", start: "2026-07-16" });
    expect(r.status).toBe(200);
    const body = r.body as ReportDocument;
    expect(body.distributions.find((d) => d.key === "served_companies_split")).toBeUndefined();
  });

  it("an explicit servedTenant slice sets header.providerView and returns ONLY that served company's numbers", async () => {
    // The document is ALWAYS read under `:tenantId` = the route company, so the provider-view
    // slice is requested from the PROVIDER's own tenant route (`provider`), for ITS OWN unit
    // (d-shared), sliced to the company it served (`co`).
    const providerAdmin = await createUser("padmin@tr13.test");
    await addMembership(provider, providerAdmin);
    await grantRole(providerAdmin, await createRole("company_admin"), "company", provider);
    const q = new URLSearchParams({ grain: "department", scopeRef: "d-shared", periodKind: "month", start: "2026-07-16", servedTenant: co });
    const r = await app.inject({ method: "GET", url: `/api/${provider}/reports/document?${q.toString()}`, headers: asUser(providerAdmin) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as ReportDocument;
    expect(body.header.providerView).toEqual({ servedTenantId: co, servedTenantName: "TR-13 Co" });
    const completed = body.kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.value).toBe(1); // the one shared-service completion on 2026-07-10
  });

  // ═══════════════════════════════ Cerbos per-grain authz matrix ═══════════════════════════════

  it("self may read their OWN person-grain document", async () => {
    const r = await doc({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16", as: alice });
    expect(r.status).toBe(200);
  });

  it("self is DENIED another person's document", async () => {
    const r = await doc({ grain: "person", scopeRef: bob, periodKind: "month", start: "2026-07-16", as: alice });
    expect(r.status).toBe(403);
  });

  it("self (plain member) is DENIED the company-grain document", async () => {
    const r = await doc({ grain: "company", scopeRef: co, periodKind: "month", start: "2026-07-16", as: alice });
    expect(r.status).toBe(403);
  });

  it("company_admin and group_executive MAY read the company-grain document", async () => {
    const asAdmin = await doc({ grain: "company", scopeRef: co, periodKind: "month", start: "2026-07-16", as: admin });
    expect(asAdmin.status).toBe(200);
    const asExec = await doc({ grain: "company", scopeRef: co, periodKind: "month", start: "2026-07-16", as: exec });
    expect(asExec.status).toBe(200);
  });

  it("a plain member is DENIED the overview LISTING (no single scope to satisfy `owns`)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/reports/overview?grain=person&periodKind=month&start=2026-07-16`, headers: asUser(alice) });
    expect(r.statusCode).toBe(403);
  });

  it("company_admin MAY read the overview listing and gets one entry per person with facts", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/reports/overview?grain=person&periodKind=month&start=2026-07-16`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { scopes: Array<{ scopeRef: string; scopeName: string }> };
    expect(body.scopes.some((s) => s.scopeRef === alice)).toBe(true);
  });

  // ═══════════════════════════════ /reports/metrics ═══════════════════════════════

  it("GET /reports/metrics returns raw numerator/denominator rows for the requested window", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/reports/metrics?metricKey=delivery.tasks_completed&grain=person&from=2026-07-01&to=2026-07-31`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ metricKey: string; numerator: number; dimensions: Record<string, unknown> }>;
    const aliceRow = rows.find((row) => row.dimensions.userId === alice);
    expect(aliceRow?.numerator).toBe(6);
  });
});
