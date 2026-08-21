// ORG-3: ServiceAssignmentsController against live Postgres + Cerbos. Covers the endpoint
// lifecycle this ticket builds (propose/accept/revoke/suspend/resume/relink); the reconciler
// (ORG-6) is NOT built here, so these rows stay dormant metadata — no membership/grant is ever
// touched by these tests.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants, newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { registerModule, resetModules } from "../modules/registry";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const sampleOrg = (deptId: string) => ({
  root: {
    id: "root",
    name: "Provider Co",
    kind: "company",
    children: [{ id: deptId, name: "HR", kind: "department", children: [] }],
  },
});

describe.skipIf(!TEST_URL)("service-assignments API (ORG-3)", () => {
  let app: NestFastifyApplication;
  let A: string; // provider (holding root)
  let B: string; // target, same holding as A
  let Z: string; // unrelated company, no holding relationship to A
  let providerAdmin: string;
  let targetAdmin: string;
  let globalExec: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    // Register every module key these tests actually create assignments for (so the
    // registry-validation branch — active once ANY module is registered — passes them) plus 'hr'
    // for the base case; "not_a_real_module" is deliberately left unregistered for the negative test.
    for (const key of [
      "hr", "billing", "accept_test", "suspend_test", "relink_test", "relink_global_test",
      "orphan_repair_test", "relink_target_test", "event_test",
    ]) {
      registerModule({
        key, migrations: [], permissions: [], customFieldTargets: [], mcpTools: [], rollupProviders: [], uiManifest: [],
      });
    }

    A = await createCompany("Gaia Digital Agency", ["agency"]);
    B = await createCompany("Viceroy", [], A); // same holding as A
    Z = await createCompany("Totally Unrelated Co");

    providerAdmin = await createUser("provider-admin@a.test");
    targetAdmin = await createUser("target-admin@b.test");
    globalExec = await createUser("exec@holding.test");
    await addMembership(A, providerAdmin);
    await addMembership(B, targetAdmin);

    const companyAdminRole = await createRole("company_admin");
    const execRole = await createRole("group_executive");
    await grantRole(providerAdmin, companyAdminRole, "company", A);
    await grantRole(targetAdmin, companyAdminRole, "company", B);
    await grantRole(globalExec, execRole, "global", null);
    // MON-00c: group_executive's rules are gated on `variables.inRoot`, and a root resolves from
    // `users.home_company_id` or an active membership. This exec holds a GLOBAL grant and therefore
    // has no membership, so it resolved `rootCompanies: []` and every call below 403'd. Anchored to
    // A, this fixture's ROOT company, via home_company_id rather than a membership — a
    // membership would place the exec inside the very companies these assertions count.
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [A, globalExec]);

    app = await buildApp();

    // Give the provider an org structure with an "HR" department to link.
    await app.inject({
      method: "PUT",
      url: `/api/${A}/org-structure`,
      headers: asUser(providerAdmin),
      payload: sampleOrg("d-hr"),
    });
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    resetModules();
  });

  it("a non-global provider company_admin creates a 'proposed' assignment (not active)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(providerAdmin),
      payload: { targets: [B], module: "hr" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { assignments: Array<{ id: string; target: string; status: string }> };
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].target).toBe(B);
    expect(body.assignments[0].status).toBe("proposed");
  });

  it("a global actor (group_executive) creates an 'active' assignment directly", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(globalExec),
      payload: { targets: [B], module: "billing" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { assignments: Array<{ id: string; target: string; status: string }> };
    expect(body.assignments[0].status).toBe("active");
  });

  it("a target company_admin cannot create (propose) — provider-admin/global only", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(targetAdmin),
      payload: { targets: [B], module: "finance" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("cross-holding target is rejected 422", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(providerAdmin),
      payload: { targets: [Z], module: "hr" },
    });
    expect(r.statusCode).toBe(422);
  });

  it("unknown module key is rejected 422", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(providerAdmin),
      payload: { targets: [B], module: "not_a_real_module" },
    });
    expect(r.statusCode).toBe(422);
  });

  it("target-side accept flips proposed -> active, and revoke is an UPDATE (never a DELETE)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(providerAdmin),
      payload: { targets: [B], module: "accept_test" },
    });
    const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

    // Provider cannot accept its own proposal.
    const providerTriesAccept = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/assignments/${id}/accept`,
      headers: asUser(providerAdmin),
    });
    expect(providerTriesAccept.statusCode).toBe(403);

    const accept = await app.inject({
      method: "POST",
      url: `/api/${B}/org-structure/assignments/${id}/accept`,
      headers: asUser(targetAdmin),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toEqual({ ok: true, status: "active" });

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/${B}/org-structure/assignments/${id}`,
      headers: asUser(targetAdmin),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true, status: "revoked" });

    // Prove it's an UPDATE, not a DELETE: the row still exists with status='revoked'.
    const row = await withTenants([A], (c) =>
      c.query<{ status: string }>(`SELECT status FROM service_assignments WHERE id = $1`, [id]),
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].status).toBe("revoked");

    // Idempotent-safety: revoking again 409s rather than silently succeeding twice.
    const revokeAgain = await app.inject({
      method: "DELETE",
      url: `/api/${B}/org-structure/assignments/${id}`,
      headers: asUser(targetAdmin),
    });
    expect(revokeAgain.statusCode).toBe(409);
  });

  it("suspend then resume round-trips active -> suspended -> active", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(globalExec),
      payload: { targets: [B], module: "suspend_test" },
    });
    const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id; // already 'active' (global)

    const suspend = await app.inject({
      method: "PATCH",
      url: `/api/${A}/org-structure/assignments/${id}/suspend`,
      headers: asUser(providerAdmin),
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json()).toEqual({ ok: true, status: "suspended" });

    // Can't suspend twice.
    const suspendAgain = await app.inject({
      method: "PATCH",
      url: `/api/${A}/org-structure/assignments/${id}/suspend`,
      headers: asUser(providerAdmin),
    });
    expect(suspendAgain.statusCode).toBe(409);

    const resume = await app.inject({
      method: "PATCH",
      url: `/api/${B}/org-structure/assignments/${id}/resume`,
      headers: asUser(targetAdmin),
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toEqual({ ok: true, status: "active" });
  });

  it("relink by a non-global provider admin on a NON-orphaned assignment flips it back to 'proposed' (re-consent)", async () => {
    // Give the provider a second department to relink onto.
    await app.inject({
      method: "PUT",
      url: `/api/${A}/org-structure`,
      headers: asUser(providerAdmin),
      payload: {
        root: {
          id: "root", name: "Provider Co", kind: "company",
          children: [
            { id: "d-hr", name: "HR", kind: "department", children: [] },
            { id: "d-hr2", name: "HR (new)", kind: "department", children: [] },
          ],
        },
      },
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(globalExec), // active immediately
      payload: { targets: [B], module: "relink_test" },
    });
    const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

    // Sanity: it's active before relink.
    const before = await withTenants([A], (c) =>
      c.query<{ status: string }>(`SELECT status FROM service_assignments WHERE id=$1`, [id]),
    );
    expect(before.rows[0].status).toBe("active");

    const relink = await app.inject({
      method: "PATCH",
      url: `/api/${A}/org-structure/assignments/${id}`,
      headers: asUser(providerAdmin), // non-global actor
      payload: { nodeId: "d-hr2" },
    });
    expect(relink.statusCode).toBe(200);
    const body = relink.json() as { ok: boolean; status: string; reconsentRequired: boolean };
    expect(body.status).toBe("proposed");
    expect(body.reconsentRequired).toBe(true);

    const row = await withTenants([A], (c) =>
      c.query<{ status: string; accepted_by: string | null; unit_name: string }>(
        `SELECT status, accepted_by, unit_name FROM service_assignments WHERE id=$1`,
        [id],
      ),
    );
    expect(row.rows[0].status).toBe("proposed");
    expect(row.rows[0].accepted_by).toBeNull();
    expect(row.rows[0].unit_name).toBe("HR (new)");
  });

  it("relink by a global actor never forces re-consent", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(globalExec),
      payload: { targets: [B], module: "relink_global_test" },
    });
    const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

    const relink = await app.inject({
      method: "PATCH",
      url: `/api/${A}/org-structure/assignments/${id}`,
      headers: asUser(globalExec),
      payload: { nodeId: "d-hr2" },
    });
    expect(relink.statusCode).toBe(200);
    const body = relink.json() as { status: string; reconsentRequired: boolean };
    expect(body.status).toBe("active");
    expect(body.reconsentRequired).toBe(false);
  });

  it("orphan-repair relink (unit_status='orphaned') skips re-consent even for a non-global actor", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(globalExec),
      payload: { targets: [B], module: "orphan_repair_test" },
    });
    const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

    // Simulate the orphan state a chart edit would have produced (ORG-6's reconciler is what
    // would normally set this; this ticket doesn't build that, so the test sets it directly to
    // exercise the relink endpoint's orphan-repair branch).
    await withTenants([A], (c) =>
      c.query(`UPDATE service_assignments SET unit_status = 'orphaned' WHERE id = $1`, [id]),
    );

    const relink = await app.inject({
      method: "PATCH",
      url: `/api/${A}/org-structure/assignments/${id}`,
      headers: asUser(providerAdmin), // non-global
      payload: { nodeId: "d-hr2" },
    });
    expect(relink.statusCode).toBe(200);
    const body = relink.json() as { status: string; reconsentRequired: boolean };
    expect(body.status).toBe("active"); // unchanged — no forced re-proposal
    expect(body.reconsentRequired).toBe(false);
  });

  it("relink attempted from the target side is rejected (provider-only action)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(globalExec),
      payload: { targets: [B], module: "relink_target_test" },
    });
    const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

    const relink = await app.inject({
      method: "PATCH",
      url: `/api/${B}/org-structure/assignments/${id}`,
      headers: asUser(targetAdmin),
      payload: { nodeId: "d-hr2" },
    });
    expect(relink.statusCode).toBe(403);
  });

  it("propose rejects targeting itself and rejects an empty targets array", async () => {
    const self = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(providerAdmin),
      payload: { targets: [A], module: "hr" },
    });
    expect(self.statusCode).toBe(400);

    const empty = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(providerAdmin),
      payload: { targets: [], module: "hr" },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("an outbox event lands in BOTH tenants for a create + accept (dual emission, shared correlationId)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(providerAdmin),
      payload: { targets: [B], module: "event_test" },
    });
    const id = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;

    const providerEvents = await withTenants([A], (c) =>
      c.query<{ event_type: string; payload: { correlationId: string } }>(
        `SELECT event_type, payload FROM outbox_events WHERE entity_type='service_assignment' AND entity_id=$1 AND tenant_id=$2`,
        [id, A],
      ),
    );
    const targetEvents = await withTenants([B], (c) =>
      c.query<{ event_type: string; payload: { correlationId: string } }>(
        `SELECT event_type, payload FROM outbox_events WHERE entity_type='service_assignment' AND entity_id=$1 AND tenant_id=$2`,
        [id, B],
      ),
    );
    expect(providerEvents.rows.length).toBeGreaterThan(0);
    expect(targetEvents.rows.length).toBeGreaterThan(0);
    expect(providerEvents.rows[0].event_type).toBe("service_assignment.proposed");
    expect(targetEvents.rows[0].event_type).toBe("service_assignment.proposed");
    expect(providerEvents.rows[0].payload.correlationId).toBe(id);
    expect(targetEvents.rows[0].payload.correlationId).toBe(id);
  });
});
