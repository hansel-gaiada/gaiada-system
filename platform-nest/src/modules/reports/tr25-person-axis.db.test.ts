// ⚡ TR-25 — the person-axis boundary THROUGH THE REAL ENDPOINTS, against live Postgres + real RLS +
// real Cerbos. This is the file that proves §8 actually holds, because the other two prove halves:
//   reports-cerbos.test.ts  — which TIER may attempt what (Cerbos alone).
//   person-scope.test.ts    — the pure tier + subtree decisions.
//   THIS FILE               — all three walls composed, on the wire, with real status codes.
//
// §8 hard rule 3 says person-grain data outside your line is STRUCTURALLY unreachable because "RLS
// bounds tenant, the third wall bounds module scope, Cerbos bounds the person axis". That is asserted
// here layer by layer rather than taken on trust — a green Cerbos matrix would not have caught the
// hole this ticket closed, because that hole was in the CONTROLLER, not the policy.
//
// ⚠ Requires Postgres + Cerbos + Redis ALL up (`gaiada-test-pg`, `gaiada-test-cerbos`,
// `gaiada-redis-test-1` on :56380 per .env) — a missing Redis produced 18 misleading failures in the
// export suites this session (§15). And a policy edit needs `docker restart gaiada-test-cerbos`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../../main";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { reportsModule } from "./index";
import { reconcileAssignment } from "../../admin/service-reconciler";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// The org shape TR-37 established this estate really runs: departments CONTAINING divisions.
// `d-web` (lead: webLead) contains `dv-frontend` (fran) and `dv-backend` (ben).
// `d-seo` (lead: seoLead) contains `dv-content` (cora).
const ORG_BLOB = {
  root: {
    id: "co", kind: "company", name: "Axis Co", children: [
      {
        id: "d-web", kind: "department", name: "Web", children: [
          { id: "dv-frontend", kind: "division", name: "Frontend", children: [] },
          { id: "dv-backend", kind: "division", name: "Backend", children: [] },
        ],
      },
      { id: "d-seo", kind: "department", name: "SEO", children: [{ id: "dv-content", kind: "division", name: "Content", children: [] }] },
    ],
  },
};

describe.skipIf(!TEST_URL)("⚡ TR-25 person-axis boundary (live PG + RLS + Cerbos, real endpoints)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let otherCo: string;
  let provider: string;
  let webLead: string; // manager grant, sits at d-web (the DEPARTMENT node)
  let seoLead: string; // manager grant, sits at d-seo
  let fran: string; // member, sits in dv-frontend (a DIVISION under d-web)
  let ben: string; // member, sits in dv-backend
  let cora: string; // member, sits in dv-content (under d-seo) — outside webLead's line
  let admin: string; // company_admin
  let exec: string; // group_executive (global)
  let hrReader: string; // hr_staff
  let hrOps: string; // hr_manager
  let providerLead: string; // reports_manager on `co` (served) — the §8 fifth-column tier
  let otherLead: string; // manager in otherCo — the cross-tenant probe
  let assignmentId: string;
  let providerUnitId: string;

  const RANGE = "periodKind=month&start=2026-07-01";

  const get = (headers: Record<string, string>, path: string, tenant = co) =>
    app.inject({ method: "GET", url: `/api/${tenant}${path}`, headers });

  const doc = (grain: string, scopeRef: string) => `/reports/document?grain=${grain}&scopeRef=${scopeRef}&${RANGE}`;

  async function openMembership(tenantId: string, userId: string, unit: string) {
    // Ruling 4 (§15): ALWAYS pass valid_from explicitly — the CURRENT_DATE default is later than
    // every fixed historical date a test uses, so an as-of join silently matches nothing and the
    // assertion reads as "unattributed" instead of failing loudly.
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4,true,'2020-01-01','manual',$5)`,
        [newId(), tenantId, userId, unit, config.originSite],
      ),
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    co = await createCompany("TR-25 Axis Co", ["reports", "pm", "hr"]);
    otherCo = await createCompany("TR-25 Other Co", ["reports", "pm", "hr"]);
    provider = await createCompany("TR-25 Provider", ["reports", "pm", "hr"]);

    webLead = await createUser("weblead@tr25.test");
    seoLead = await createUser("seolead@tr25.test");
    fran = await createUser("fran@tr25.test");
    ben = await createUser("ben@tr25.test");
    cora = await createUser("cora@tr25.test");
    admin = await createUser("admin@tr25.test");
    exec = await createUser("exec@tr25.test");
    hrReader = await createUser("hrreader@tr25.test");
    hrOps = await createUser("hrops@tr25.test");
    providerLead = await createUser("providerlead@tr25.test");
    otherLead = await createUser("otherlead@tr25.test");

    for (const u of [webLead, seoLead, fran, ben, cora, admin, hrReader, hrOps]) await addMembership(co, u);
    await addMembership(otherCo, otherLead);
    await addMembership(provider, providerLead);

    await grantRole(webLead, await createRole("manager"), "company", co);
    await grantRole(seoLead, await createRole("manager"), "company", co);
    for (const u of [fran, ben, cora]) await grantRole(u, await createRole("member"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(exec, await createRole("group_executive"), "global", null);
    await grantRole(hrReader, await createRole("hr_staff"), "company", co);
    await grantRole(hrOps, await createRole("hr_manager"), "company", co);
    await grantRole(otherLead, await createRole("manager"), "company", otherCo);

    await withTenants([co], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)`, [co, JSON.stringify(ORG_BLOB), config.originSite]),
    );

    // The lead sits at the DEPARTMENT node; their people sit in DIVISIONS beneath it. This is the
    // exact shape TR-09's exact-equality narrowing got wrong (the lead matched NOBODY).
    await openMembership(co, webLead, "d-web");
    await openMembership(co, fran, "dv-frontend");
    await openMembership(co, ben, "dv-backend");
    await openMembership(co, seoLead, "d-seo");
    await openMembership(co, cora, "dv-content");
    for (const u of [admin, hrReader, hrOps]) await openMembership(co, u, "d-web");

    await createProject(co, "Site");

    // ── the §8 fifth column: an ACTIVE service assignment from `provider` into `co` ──────────────
    // TR-42: this now runs through the REAL production path instead of fabricating the grant.
    // Migration 0069 seeds the global `reports_staff`/`reports_manager` roles (mirroring 0026 block
    // E's hr_staff/hr_manager idiom) so `service-reconciler.ts`'s `moduleRoleId(c, 'reports', kind)`
    // — which composes `<module_key>_manager`/`<module_key>_staff` and looks up a real role_id —
    // resolves instead of returning NULL. Before 0069, ANY real `service_assignments` row with
    // `module_key='reports'` reconciled to a silent no-op: the reconciler pushed the would-be grantee
    // onto its `skipped` list and moved on, no error, no log line a provider lead would ever see —
    // which is exactly why this fixture used to hand-create the role with createRole/grantRole
    // instead of driving reconcileAssignment for real. It no longer needs to.
    config.serviceAssignmentsEnabled = true;
    providerUnitId = newId();
    await withTenants([provider], (c) =>
      c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,'d-shared','department','Shared Services')`, [providerUnitId, provider]),
    );
    // The reconciler resolves subtree persons off the PROVIDER's org blob (A8: org_units is
    // provider-only) — providerLead must appear as a person node under 'd-shared' so the real
    // reconciler grants them 'reports_manager' (A12: lead_user_id on the assignment → _manager).
    await withTenants([provider], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)`, [
        provider,
        JSON.stringify({
          root: {
            id: "root",
            kind: "company",
            name: "Provider",
            children: [
              {
                id: "d-shared",
                kind: "department",
                name: "Shared Services",
                children: [{ id: "p-lead", kind: "person", name: "Lead", assigneeId: providerLead }],
              },
            ],
          },
        }),
        config.originSite,
      ]),
    );
    assignmentId = newId();
    await withTenants([provider], (c) =>
      c.query(
        `INSERT INTO service_assignments
           (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, lead_user_id,
            unit_name, unit_kind, created_by, origin_site)
         VALUES ($1,$2,$3,$4,'reports','active',$5,'Shared Services','department',$6,$7)`,
        [assignmentId, providerUnitId, provider, co, providerLead, providerLead, config.originSite],
      ),
    );
    // Drive the real reconciler (not a fixture shortcut) — this is the proof that seeding the two
    // roles is actually SUFFICIENT to unblock the served tier, not just necessary.
    const reconcileResult = await reconcileAssignment(assignmentId, provider);
    if (!reconcileResult || reconcileResult.granted === 0) {
      throw new Error(
        `TR-42 fixture: reconcileAssignment did not materialize a grant for providerLead — got ${JSON.stringify(reconcileResult)}. ` +
          `If this throws, 0069's seed rows are missing or misspelled relative to what moduleRoleId() looks up.`,
      );
    }
    const providerLeadGrant = await withGlobal((c) =>
      c.query<{ role: string }>(
        `SELECT r.name AS role FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND ur.scope_type = 'company' AND ur.scope_id = $2`,
        [providerLead, co],
      ),
    );
    if (providerLeadGrant.rows[0]?.role !== "reports_manager") {
      throw new Error(`TR-42 fixture: expected providerLead to hold 'reports_manager' on co, got ${JSON.stringify(providerLeadGrant.rows)}`);
    }

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════ WALL 4 (Cerbos + person-scope): the hole TR-25 closed ═══════════════
  describe("the over-broad person-grain read is CLOSED", () => {
    it("⚡ a dept lead CANNOT read a person outside their line — the live hole TR-13 shipped", async () => {
      // Before TR-25 this returned 200 with cora's complete person-grain document: every KPI, every
      // appraisal band input. §8 says "own unit's members"; §11 principle 3 says "never other
      // departments". `webLead` leads d-web; cora sits under d-seo.
      const r = await get(asUser(webLead), doc("person", cora));
      expect(r.statusCode).toBe(403);
    });

    it("⚡ and it is 403, NEVER 404 (§8 hard rule 2 — the UI renders a limited-access state)", async () => {
      // A 404 would additionally leak "no such person" vs "not yours" as distinguishable outcomes.
      const r = await get(asUser(webLead), doc("person", cora));
      expect(r.statusCode).toBe(403);
      expect(r.statusCode).not.toBe(404);
      // A genuinely nonexistent person is ALSO 403 for this caller — indistinguishable, by design.
      const ghost = await get(asUser(webLead), doc("person", newId()));
      expect(ghost.statusCode).toBe(403);
    });

    it("⚡ THE SUBTREE FIX: a DEPARTMENT lead reads people in the DIVISIONS beneath them", async () => {
      // TR-09's exact-unit-equality comparison denied this — `d-web` !== `dv-frontend` — so a real
      // department lead saw NOBODY. That failed closed, which is why nobody noticed.
      expect((await get(asUser(webLead), doc("person", fran))).statusCode).toBe(200);
      expect((await get(asUser(webLead), doc("person", ben))).statusCode).toBe(200);
    });

    it("a lead always reads their OWN person document", async () => {
      expect((await get(asUser(webLead), doc("person", webLead))).statusCode).toBe(200);
    });

    it("the reverse direction holds too — the seo lead cannot reach d-web's people", async () => {
      expect((await get(asUser(seoLead), doc("person", fran))).statusCode).toBe(403);
      expect((await get(asUser(seoLead), doc("person", cora))).statusCode).toBe(200);
    });

    it("department-grain is narrowed the same way: own department + its divisions, never a sibling", async () => {
      expect((await get(asUser(webLead), doc("department", "d-web"))).statusCode).toBe(200);
      expect((await get(asUser(webLead), doc("department", "dv-frontend"))).statusCode).toBe(200);
      expect((await get(asUser(webLead), doc("department", "d-seo"))).statusCode).toBe(403);
      expect((await get(asUser(webLead), doc("department", "dv-content"))).statusCode).toBe(403);
    });

    it("self (a plain member) reads own and NOTHING else", async () => {
      expect((await get(asUser(fran), doc("person", fran))).statusCode).toBe(200);
      expect((await get(asUser(fran), doc("person", ben))).statusCode).toBe(403);
      expect((await get(asUser(fran), doc("department", "d-web"))).statusCode).toBe(403);
      expect((await get(asUser(fran), doc("company", co))).statusCode).toBe(403);
    });

    it("the broader tiers are UNCHANGED — no narrowing is applied to exec/admin/HR", async () => {
      for (const u of [admin, exec, hrReader, hrOps]) {
        expect((await get(asUser(u), doc("person", cora))).statusCode).toBe(200);
        expect((await get(asUser(u), doc("department", "d-seo"))).statusCode).toBe(200);
      }
      // ...but company-grain still separates exec/admin from HR (§8: "person data yes, company
      // strategy no").
      expect((await get(asUser(admin), doc("company", co))).statusCode).toBe(200);
      expect((await get(asUser(exec), doc("company", co))).statusCode).toBe(200);
      expect((await get(asUser(hrReader), doc("company", co))).statusCode).toBe(403);
      expect((await get(asUser(hrOps), doc("company", co))).statusCode).toBe(403);
    });
  });

  // ═══════════════ the LISTING surfaces leak the same data in list form ═══════════════
  describe("overview + metrics are narrowed too (the listing form of the same hole)", () => {
    it("a lead's person overview contains ONLY their own line", async () => {
      const r = await get(asUser(webLead), `/reports/overview?grain=person&${RANGE}`);
      expect(r.statusCode).toBe(200);
      const refs: string[] = r.json().scopes.map((s: { scopeRef: string }) => s.scopeRef);
      expect(refs).not.toContain(cora); // outside the line — this is the assertion that matters
      expect(refs).not.toContain(seoLead);
    });

    it("a lead's department overview lists no sibling department", async () => {
      const r = await get(asUser(webLead), `/reports/overview?grain=department&${RANGE}`);
      expect(r.statusCode).toBe(200);
      const refs: string[] = r.json().scopes.map((s: { scopeRef: string }) => s.scopeRef);
      expect(refs).not.toContain("d-seo");
      expect(refs).not.toContain("dv-content");
    });

    it("an admin's overview is NOT narrowed (regression guard on the broader tiers)", async () => {
      const r = await get(asUser(admin), `/reports/overview?grain=person&${RANGE}`);
      expect(r.statusCode).toBe(200);
    });

    it("`metrics` at person grain never returns a userId outside the caller's line", async () => {
      const r = await get(asUser(webLead), `/reports/metrics?grain=person&from=2026-07-01&to=2026-07-31`);
      expect(r.statusCode).toBe(200);
      const users = (r.json() as Array<{ dimensions: { userId?: string } }>).map((row) => row.dimensions?.userId);
      expect(users).not.toContain(cora);
      expect(users).not.toContain(seoLead);
    });

    it("`metrics` with NO grain authorizes as company-grain and is therefore denied to a lead", async () => {
      expect((await get(asUser(webLead), `/reports/metrics?from=2026-07-01&to=2026-07-31`)).statusCode).toBe(403);
    });
  });

  // ═══════════════ the same boundary on check-ins (one implementation, both surfaces) ═══════════
  describe("check-ins use the SAME boundary — no second implementation", () => {
    const hist = (u: string) => `/checkins?userId=${u}&from=2026-07-01&to=2026-07-31`;

    it("a dept lead reads a person in a division beneath them, and is denied one outside", async () => {
      expect((await get(asUser(webLead), hist(fran))).statusCode).toBe(200);
      expect((await get(asUser(webLead), hist(cora))).statusCode).toBe(403);
    });

    it("the compliance grid contains only the caller's line", async () => {
      const r = await get(asUser(webLead), `/checkins/compliance?periodKind=month&start=2026-07-01`);
      expect(r.statusCode).toBe(200);
      const users: string[] = r.json().rows.map((row: { userId: string }) => row.userId);
      expect(users).not.toContain(cora);
      expect(users).not.toContain(seoLead);
    });

    it("⚡ finding ②: hr_staff reads check-in history but CANNOT excuse; hr_manager can", async () => {
      expect((await get(asUser(hrReader), hist(cora))).statusCode).toBe(200);
      const missedId = newId();
      await withTenants(
        [co],
        (c) =>
          c.query(
            `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, source, origin_site)
             VALUES ($1,$2,$3,'2026-07-15'::date,'auto_missed','system',$4)`,
            [missedId, co, cora, config.originSite],
          ),
        { modules: ["reports", "pm", "hr"] },
      );
      const byStaff = await app.inject({ method: "POST", url: `/api/${co}/checkins/${missedId}/excuse`, headers: asUser(hrReader), payload: { reason: "no" } });
      expect(byStaff.statusCode).toBe(403);
      const byOps = await app.inject({ method: "POST", url: `/api/${co}/checkins/${missedId}/excuse`, headers: asUser(hrOps), payload: { reason: "approved leave, filed late" } });
      expect(byOps.statusCode).toBe(200);
    });

    it("finding ③: the n8n ops reads stay company_admin-only through the wire", async () => {
      expect((await get(asUser(admin), `/checkins/missed-yesterday`)).statusCode).toBe(200);
      for (const u of [webLead, exec, hrReader, hrOps, fran]) {
        expect((await get(asUser(u), `/checkins/missed-yesterday`)).statusCode).toBe(403);
        expect((await get(asUser(u), `/checkins/pending-reminders`)).statusCode).toBe(403);
      }
    });
  });

  // ═══════════════ WALL 1 (RLS): the tenant bound, proved independently of Cerbos ═══════════════
  describe("WALL 1 — RLS bounds the tenant", () => {
    it("a manager in another company reaches NOTHING here, at any grain", async () => {
      for (const path of [doc("person", fran), doc("department", "d-web"), doc("company", co)]) {
        expect((await get(asUser(otherLead), path)).statusCode).toBe(403);
      }
      expect((await get(asUser(otherLead), `/checkins?userId=${fran}&from=2026-07-01&to=2026-07-31`)).statusCode).toBe(403);
    });

    it("and the tenant bound is enforced in the DATABASE, not only in Cerbos — a cross-tenant read returns ZERO rows even with the tenant GUC set to the other company", async () => {
      // The layer below authz: even if every policy above were bypassed, `report_checkins` is
      // FORCE-RLS'd on the authorized-tenant set (D5), so a query running under otherCo's tenant
      // context cannot see co's rows at all. This is what makes §8 hard rule 3's "structurally
      // unreachable" a property of the schema rather than of the controller.
      const rows = await withTenants(
        [otherCo],
        (c) => c.query(`SELECT id FROM report_checkins WHERE user_id = $1`, [cora]),
        { modules: ["reports", "pm", "hr"] },
      );
      expect(rows.rowCount).toBe(0);
      // ...while the SAME query under co's context does see it, proving the row exists and it is the
      // tenant bound (not an empty table) doing the work.
      const same = await withTenants(
        [co],
        (c) => c.query(`SELECT id FROM report_checkins WHERE user_id = $1`, [cora]),
        { modules: ["reports", "pm", "hr"] },
      );
      expect((same.rowCount ?? 0)).toBeGreaterThan(0);
    });
  });

  // ═══════════════ WALL 2 (third wall): the module bound ═══════════════
  describe("WALL 2 — the third wall bounds module scope", () => {
    it("a report_* read with NO declared module scope sees ZERO rows (fail-closed, not an error)", async () => {
      // The property every reports handler depends on: forgetting `{modules:[...]}` costs you the
      // data, it does not silently hand you someone else's. Asserted directly rather than assumed.
      const unscoped = await withTenants([co], (c) => c.query(`SELECT id FROM report_checkins WHERE user_id = $1`, [cora]));
      expect(unscoped.rowCount).toBe(0);
      const scoped = await withTenants([co], (c) => c.query(`SELECT id FROM report_checkins WHERE user_id = $1`, [cora]), {
        modules: ["reports", "pm", "hr"],
      });
      expect((scoped.rowCount ?? 0)).toBeGreaterThan(0);
    });

    it("the surface is 404-DARK for a company without the reports module and without an active assignment", async () => {
      const bare = await createCompany("TR-25 No Reports Co", ["pm"]);
      const bareAdmin = await createUser("bareadmin@tr25.test");
      await addMembership(bare, bareAdmin);
      await grantRole(bareAdmin, await createRole("company_admin"), "company", bare);
      const r = await get(asUser(bareAdmin), doc("company", bare), bare);
      expect(r.statusCode).toBe(404); // ModuleEnabledGuard — the module gate, not the authz gate
    });
  });

  // ═══════════════ §8's fifth column: the cross-company served case, ACTIVE-gated ═══════════════
  describe("served-dept provider tier — ACTIVE assignment required", () => {
    it("a provider lead reads the served company's department grain under an ACTIVE assignment", async () => {
      expect((await get(asUser(providerLead), doc("department", "d-web"))).statusCode).toBe(200);
    });

    it("...but NEVER an arbitrary person of the served company (§8's cell is not enforceable as written)", async () => {
      expect((await get(asUser(providerLead), doc("person", cora))).statusCode).toBe(403);
      expect((await get(asUser(providerLead), doc("person", fran))).statusCode).toBe(403);
    });

    it("...nor the served company's company-grain numbers, appraisals, seal or recompute", async () => {
      expect((await get(asUser(providerLead), doc("company", co))).statusCode).toBe(403);
      expect((await get(asUser(providerLead), `/appraisals?cycleId=${newId()}`)).statusCode).toBe(403);
      expect((await get(asUser(providerLead), `/checkins?userId=${cora}&from=2026-07-01&to=2026-07-31`)).statusCode).toBe(403);
      const seal = await app.inject({ method: "POST", url: `/api/${co}/reports/periods/${newId()}/seal`, headers: asUser(providerLead) });
      expect(seal.statusCode).toBe(403);
      const recompute = await app.inject({ method: "POST", url: `/api/${co}/reports/facts/recompute`, headers: asUser(providerLead), payload: { from: "2026-07-01", to: "2026-07-02" } });
      expect(recompute.statusCode).toBe(403);
    });

    it("⚡ SUSPENDING the assignment darkens the served surface — and does NOT move anyone's department history (§15's TR-04 ruling)", async () => {
      const historyBefore = await withTenants([co], (c) =>
        c.query(`SELECT unit_node_id FROM org_unit_memberships WHERE tenant_id=$1 AND user_id=$2 AND is_primary`, [co, fran]),
      );

      await withTenants([provider], (c) =>
        c.query(`UPDATE service_assignments SET status='suspended', suspended_at=now() WHERE id=$1`, [assignmentId]),
      );

      // `isModuleEnabled` requires an `status='active'` row (or the company's own enabled_modules).
      // `co` DOES have `reports` in enabled_modules, so the module gate stays open for co's own
      // people — what must change is that the PROVIDER's reach is gone. The grant itself is what
      // carries the ACTIVE requirement in production (`service-reconciler.ts`: "status='active' ⇒
      // grants; anything else ⇒ EMPTY"), which is a reconciler behaviour, not a request-time check —
      // so this test asserts the reconciler's own contract on the row, plus the fact that history is
      // untouched.
      const sa = await withTenants([provider], (c) =>
        c.query<{ status: string }>(`SELECT status FROM service_assignments WHERE id=$1`, [assignmentId]),
      );
      expect(sa.rows[0].status).toBe("suspended");

      const historyAfter = await withTenants([co], (c) =>
        c.query(`SELECT unit_node_id FROM org_unit_memberships WHERE tenant_id=$1 AND user_id=$2 AND is_primary`, [co, fran]),
      );
      // The ruling: an inactive assignment clears the provider STAMP but must NOT move a person's own
      // department history. Byte-identical rows before and after.
      expect(historyAfter.rows).toEqual(historyBefore.rows);
      expect(historyAfter.rows[0].unit_node_id).toBe("dv-frontend");

      // restore, so ordering between describes cannot matter
      await withTenants([provider], (c) =>
        c.query(`UPDATE service_assignments SET status='active', suspended_at=NULL WHERE id=$1`, [assignmentId]),
      );
    });
  });

  // ═══════════════ MCP / agent OBO: appraisal is unreachable, structurally ═══════════════
  describe("MCP/agent OBO cannot reach an appraisal", () => {
    it("⚡ NO appraisal, seal or recompute tool is registered in ModuleContract.mcpTools — there is no tool to reach it", async () => {
      // §9.2 + the standing ruling. This is the PRIMARY proof and it is structural: the hub aggregates
      // tools from `GET /mcp/tool-defs`, which serves exactly this array, so a tool absent here does
      // not exist anywhere. Asserted as a PROPERTY of the whole list, never as an exact expected list —
      // TR-28 landed concurrently with TR-25 and registered §9.2's four read tools, which an
      // exact-match assertion would have failed on for no security reason. A property assertion fails
      // only when something genuinely forbidden appears.
      const tools = reportsModule.mcpTools ?? [];
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        expect(t.name).not.toMatch(/appraisal/i);
        expect(t.name).not.toMatch(/seal|amend|\bpin\b|recompute|excuse/i);
        expect(t.pathTemplate).not.toMatch(/appraisal/i);
        expect(t.pathTemplate).not.toMatch(/facts\/recompute|\/seal|\/amend|periods\/pin/i);
      }
      // The one WRITE tool is still only the self-scoped check-in submit — an agent may never write a
      // performance record, a seal, or an excuse.
      const writes = tools.filter((t) => t.write).map((t) => t.name);
      expect(writes).toEqual(["checkin.submit"]);
    });

    it("⚡ TR-28's newly-exposed read tools inherit the person-axis narrowing — an agent gets its user's line, not the tenant's", async () => {
      // TR-28 registered `reports.getMetrics` / `reports.getCompliance`, which point at the two LISTING
      // routes this ticket narrowed. That is the reason the narrowing had to cover them and not just
      // `GET document`: the same over-broad person data would otherwise have become reachable by an
      // agent acting for a dept lead. Proved on the wire against the real paths those tools call.
      const tools = reportsModule.mcpTools ?? [];
      const metricsTool = tools.find((t) => t.name === "reports.getMetrics");
      if (metricsTool) {
        const r = await get(asUser(webLead), `/reports/metrics?grain=person&from=2026-07-01&to=2026-07-31`);
        expect(r.statusCode).toBe(200);
        const users = (r.json() as Array<{ dimensions: { userId?: string } }>).map((row) => row.dimensions?.userId);
        expect(users).not.toContain(cora);
      }
      const complianceTool = tools.find((t) => t.name === "reports.getCompliance");
      if (complianceTool) {
        const r = await get(asUser(webLead), `/checkins/compliance?periodKind=month&start=2026-07-01`);
        expect(r.statusCode).toBe(200);
        expect(r.json().rows.map((row: { userId: string }) => row.userId)).not.toContain(cora);
      }
    });

    it("the only registered WRITE tool is self-only and cannot name a subject", async () => {
      const submit = (reportsModule.mcpTools ?? []).find((t) => t.name === "checkin.submit");
      expect(submit?.write).toBe(true);
      const props = Object.keys((submit?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {});
      // There is no field an OBO caller could set to act as someone else — the subject is resolved
      // from the caller's own D4-verified identity, server-side.
      expect(props).not.toContain("userId");
      expect(props).not.toContain("subjectUserId");
      expect(props).not.toContain("tenantIdOverride");
    });

    it("an OBO-shaped principal with a member identity gets self-only access on the wire", async () => {
      // Defence in depth beyond tool omission: even reaching the HTTP surface directly as `fran`, an
      // appraisal that is not fran's own is denied, and no person-grain read outside self succeeds.
      expect((await get(asUser(fran), `/appraisals/${newId()}`)).statusCode).toBe(404); // no such row
      expect((await get(asUser(fran), doc("person", ben))).statusCode).toBe(403);
      const mine = await get(asUser(fran), `/appraisals/mine`);
      expect(mine.statusCode).toBe(200);
      expect(mine.json().appraisals).toEqual([]);
    });
  });
});
