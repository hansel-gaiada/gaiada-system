// SMM-02 — social module backend, end-to-end against live Postgres + Cerbos (skips without
// DATABASE_URL_TEST). These are the GOLDEN CASES the agentic-native bar requires (addendum D-19,
// criterion 7): every capability this ticket owns is driven through the REAL endpoint, by a real
// persona, with the real three walls in place — never through a service function with the
// authorization mocked out.
//
// What each block proves, and why it is worth a test rather than a comment:
//   (1) registration — the contract's shape, and specifically that setScope is impact-classified,
//       because that value is the ONLY thing standing between an automation principal and the
//       money-and-blast-radius dial (the D14 gate keys off it).
//   (2) the module gate is dark by default, and an ACTIVE service_assignment lights it up for a
//       served company that never put 'social' in its own enabled_modules — the shared-service
//       path is the NORMAL case for this department, not an edge case.
//   (3) the manager/staff split IS the publish line: social_staff may run the content desk but is
//       DENIED set_scope (403 — the Cerbos wall, not a 404 from the module gate).
//   (4) criterion 5: a denial is a 403, never an empty list. This is the bug the client portal
//       already shipped once ("your kickoff is being processed" to a staff member who was simply
//       refused), so it gets a direct assertion rather than trust.
//   (5) criterion 3: a retried create with the same caller-supplied id produces ONE engagement.
//   (6) the scope merge is one level deep, under a row lock — a partial patch must not erase its
//       siblings, which on this column would silently change what may be published.
//   (7) the two owner-decided defaults hold: networks.x FALSE, ai.imageGen FALSE-and-inert, each
//       answering with a NAMED warning when enabled rather than a silent acceptance.
//   (8) cross-tenant: a grant at company B reaches nothing at company C.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules, getModule } from "../registry";
import { socialModule, DEFAULT_USAGE_BUDGET_USD } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function createClient(tenantId: string, name: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,$3,'central')`, [id, tenantId, name]),
  );
  return id;
}

async function createUnit(provider: string, nodeId: string): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,$3,'department','Social Media')`,
      [id, provider, nodeId]),
  );
  return id;
}

async function createActiveAssignment(unitId: string, provider: string, target: string, createdBy: string): Promise<void> {
  await withTenants([provider], (c) =>
    c.query(
      `INSERT INTO service_assignments
         (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, unit_status, created_by, accepted_at)
       VALUES ($1,$2,$3,$4,'social','active','Social Media','department','active',$5, now())`,
      [newId(), unitId, provider, target, createdBy],
    ),
  );
}

describe.skipIf(!TEST_URL)("social module (SMM-02)", () => {
  let app: NestFastifyApplication;
  let A: string;       // the agency: 'social' in its OWN enabled_modules
  let B: string;       // served company — social ONLY via an active service_assignment
  let C: string;       // social enabled, but our staffer holds no grant there
  let manager: string; // social_manager at company B
  let staff: string;   // social_staff at company B
  let clientA: string;
  let clientB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Gaia Agency", ["social"]);
    B = await createCompany("Served Client Co", [], A);
    C = await createCompany("Other Co (social enabled)", ["social"]);

    manager = await createUser("smm-manager@a.test");
    staff = await createUser("smm-staff@a.test");
    await addMembership(B, manager);
    await addMembership(B, staff);
    await addMembership(C, manager); // a member of C, but with no social grant there

    // The names are NOT free-form: module_staff/module_manager compose them from
    // resource.attr.module ("social"), which is why 0106 seeds exactly these two.
    const managerRole = await createRole("social_manager");
    const staffRole = await createRole("social_staff");
    await grantRole(manager, managerRole, "company", B);
    await grantRole(staff, staffRole, "company", B);

    clientA = await createClient(A, "Brand A");
    clientB = await createClient(B, "Brand B");

    const unit = await createUnit(A, "d-social");
    await createActiveAssignment(unit, A, B, manager);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── (1) registration ──────────────────────────────────────────────────────────────────────────
  it("registers with the shape the design requires, and impact-classifies the scope dial", () => {
    expect(getModule("social")).toBe(socialModule);
    const setScope = socialModule.mcpTools.find((t) => t.name === "social.setEngagementScope");
    // This is the assertion that matters: `write` + a non-low impact is what makes the hub SUSPEND
    // an automation principal into WS4 instead of applying the call. Drop either field and the
    // money dial becomes unattended — the D14 lesson, in the one place it would hurt most here.
    expect(setScope?.write).toBe(true);
    expect(setScope?.impact).toBe("medium");
    // Every declared permission must be a dotted catalog key; the colon form the design used
    // predates IAM Phase 1 and would refuse boot.
    for (const p of socialModule.permissions) expect(p.key).toMatch(/^social\.[a-z_]+\.[a-z_]+$/);
    // SMM-10: the publish surface IS now declared — its dispatch endpoint exists — and it must be
    // declared from the pinned classification constant, never retyped: those two literals ARE the
    // D14 gate (write && impact !== 'low' is what suspends an automation/agent call into WS4).
    const publish = socialModule.mcpTools.find((t) => t.name === "social.publishPost");
    expect(publish?.write).toBe(true);
    expect(publish?.impact).toBe("high");
    expect(publish?.pathTemplate).toBe("/api/:tenantId/modules/social/variants/:variantId/publish");
  });

  // ── (2) the module gate ───────────────────────────────────────────────────────────────────────
  it("is dark for a company with neither enabled_modules nor an assignment, and lit by the assignment", async () => {
    const dark = await createCompany("No social here", []);
    await addMembership(dark, manager);
    const off = await app.inject({ method: "GET", url: `/api/${dark}/modules/social/engagements`, headers: asUser(manager) });
    expect(off.statusCode).toBe(404); // the module gate, before any Cerbos question

    // B never put 'social' in its own enabled_modules — the ACTIVE service_assignment is the whole
    // reason this answers at all.
    const on = await app.inject({ method: "GET", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager) });
    expect(on.statusCode).toBe(200);
  });

  // ── (3)+(5) create, and the idempotency an at-least-once caller needs ─────────────────────────
  it("creates an engagement, and a retry with the same id creates exactly one", async () => {
    const id = newId();
    const first = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: clientB, name: "Brand B — always-on social" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ id, created: true });

    const retry = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: clientB, name: "Brand B — always-on social" },
    });
    // 201 with created:false, NOT a 409: the retry is the point of the idempotency key, not an
    // error the caller has to special-case.
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toMatchObject({ id, created: false });

    const { rows } = await withTenants([B], (c) =>
      c.query(`SELECT count(*)::int AS n FROM social_engagements WHERE id = $1`, [id]), { modules: ["social"] });
    expect(rows[0].n).toBe(1);
  });

  it("refuses a create with a missing field, with a typed reason an agent can branch on", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { name: "no client" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_field"); // criterion 2: a token, not only prose
  });

  // ── (6)+(7) the scope dial ────────────────────────────────────────────────────────────────────
  it("starts on the locked defaults: X off, imageGen off", async () => {
    const id = newId();
    await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: clientB, name: "defaults probe" },
    });
    const res = await app.inject({
      method: "GET", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(manager),
    });
    expect(res.statusCode).toBe(200);
    const { toolScope, usageBudgetUsd } = res.json();
    expect(toolScope.networks.x).toBe(false);      // D-14: keeps the publish path $0
    expect(toolScope.ai.imageGen).toBe(false);     // D-17: no backend exists
    // Every network starts off. A new engagement must not be able to publish anywhere until a
    // human turns something on — the default is "connected to nothing", not "ready to post".
    expect(Object.values(toolScope.networks).every((v) => v === false)).toBe(true);
    expect(toolScope).toMatchObject({ posting: { requiresClientOk: false }, inbox: { enabled: false } });
    // The budget cap is real and small, not absent: an engagement with no cap is an engagement the
    // stop-loss cannot protect.
    expect(usageBudgetUsd).toBe(DEFAULT_USAGE_BUDGET_USD);
    expect(usageBudgetUsd).toBeGreaterThan(0);
  });

  it("merges a scope patch one level deep instead of erasing its siblings", async () => {
    const id = newId();
    await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: clientB, name: "merge probe" },
    });
    await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(manager),
      payload: { toolScope: { networks: { instagram: true, linkedin: true } } },
    });
    // A second patch naming ONE network must not turn the other two off.
    const res = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(manager),
      payload: { toolScope: { networks: { facebook: true } }, usageBudgetUsd: 25 },
    });
    expect(res.statusCode).toBe(200);
    const { toolScope } = res.json();
    expect(toolScope.networks).toMatchObject({ instagram: true, linkedin: true, facebook: true });
    expect(toolScope.inbox.slaMinutes).toBe(240); // an untouched group survives too
  });

  it("names the inert and the metered toggles instead of silently accepting them", async () => {
    const id = newId();
    await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: clientB, name: "warnings probe" },
    });
    const res = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(manager),
      payload: { toolScope: { networks: { x: true }, ai: { imageGen: true } } },
    });
    expect(res.statusCode).toBe(200);
    const warnings: string[] = res.json().warnings;
    expect(warnings.some((w) => w.includes("pay-per-post"))).toBe(true);
    expect(warnings.some((w) => w.includes("image_generation_unavailable"))).toBe(true);
    // Stored, not refused: the operator asked for it, and the capability layer is what enforces it.
    const check = await app.inject({
      method: "GET", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(manager),
    });
    expect(check.json().toolScope.networks.x).toBe(true);
  });

  it("refuses an unknown network and a bad budget with typed reasons", async () => {
    const id = newId();
    await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: clientB, name: "validation probe" },
    });
    const bad = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(manager),
      payload: { toolScope: { networks: { myspace: true } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("unknown_network");

    const badBudget = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(manager),
      payload: { usageBudgetUsd: -5 },
    });
    expect(badBudget.statusCode).toBe(400);
    expect(badBudget.json().error).toBe("invalid_budget");
  });

  // ── (3) the manager/staff split ───────────────────────────────────────────────────────────────
  it("social_staff runs the desk but is DENIED the scope dial — 403, the Cerbos wall", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${B}/modules/social/engagements`, headers: asUser(staff) });
    expect(list.statusCode).toBe(200); // staff read the department's work

    const id = newId();
    await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: clientB, name: "staff denial probe" },
    });
    const denied = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/engagements/${id}/scope`, headers: asUser(staff),
      payload: { toolScope: { networks: { instagram: true } } },
    });
    // 403 and not 404: the module IS lit for this caller, and the refusal is authorization. A 404
    // here would tell a staff member the engagement does not exist, which is a different lie.
    expect(denied.statusCode).toBe(403);
  });

  // ── (4)+(8) refusal is explicit, and grants do not travel between tenants ────────────────────
  it("refuses across tenants instead of answering with an empty list", async () => {
    // The manager holds social_manager at B only. C has social enabled, so the module gate opens —
    // which makes this exactly the case where a reader that folded 403 into [] would report
    // "this company has no social work" to someone who is simply not allowed to look.
    const res = await app.inject({ method: "GET", url: `/api/${C}/modules/social/engagements`, headers: asUser(manager) });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toBe("[]");
  });

  it("does not leak another tenant's engagements into a listing", async () => {
    const idA = newId();
    // Company A's own engagement, created by a platform-level path (A has social enabled and the
    // manager is not a member there) — inserted directly so the listing below is the assertion.
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, tool_scope, origin_site)
         VALUES ($1,$2,$3,'A-only engagement','{}'::jsonb,'central')`,
        [idA, A, clientA],
      ), { modules: ["social"] });

    const res = await app.inject({ method: "GET", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager) });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(idA);
  });

  // ── brand profile: config only, upsert-shaped ────────────────────────────────────────────────
  it("upserts a brand profile idempotently and never stores corpus text", async () => {
    const first = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/brand-profiles/${clientB}`, headers: asUser(manager),
      payload: { tone: { traits: ["warm", "concise"] }, knowledgeSourceIds: ["ks-1"] },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/brand-profiles/${clientB}`, headers: asUser(manager),
      payload: { hashtagStrategy: { max: 5 } },
    });
    expect(second.statusCode).toBe(200);

    const got = await app.inject({
      method: "GET", url: `/api/${B}/modules/social/brand-profiles/${clientB}`, headers: asUser(manager),
    });
    const body = got.json();
    // The partial second patch must not have erased the first's tone — and the corpus itself lives
    // in WS8, so all this table ever holds is config plus POINTERS (D-13).
    expect(body.tone).toMatchObject({ traits: ["warm", "concise"] });
    expect(body.hashtagStrategy).toMatchObject({ max: 5 });
    expect(body.knowledgeSourceIds).toEqual(["ks-1"]);

    const { rows } = await withTenants([B], (c) =>
      c.query(`SELECT count(*)::int AS n FROM social_brand_profiles WHERE client_id = $1`, [clientB]), { modules: ["social"] });
    expect(rows[0].n).toBe(1);
  });

  // ── campaigns + KPI targets ──────────────────────────────────────────────────────────────────
  it("creates a campaign as 'organic' — paid is a reserved seam, not a parameter", async () => {
    const eng = newId();
    await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id: eng, clientId: clientB, name: "campaign parent" },
    });
    const res = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/campaigns`, headers: asUser(manager),
      payload: { engagementId: eng, name: "Ramadan 2026", goal: "reach" },
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await withTenants([B], (c) =>
      c.query<{ kind: string }>(`SELECT kind FROM social_campaigns WHERE id = $1`, [res.json().id]), { modules: ["social"] });
    expect(rows[0].kind).toBe("organic");
  });

  it("records a KPI target against an engagement", async () => {
    const eng = newId();
    await app.inject({
      method: "POST", url: `/api/${B}/modules/social/engagements`, headers: asUser(manager),
      payload: { id: eng, clientId: clientB, name: "kpi parent" },
    });
    const res = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/kpi-targets`, headers: asUser(manager),
      payload: { engagementId: eng, metricKey: "followers_total", targetValue: 10000, direction: "up" },
    });
    expect(res.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET", url: `/api/${B}/modules/social/kpi-targets?engagementId=${eng}`, headers: asUser(manager),
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].metricKey).toBe("followers_total");
  });

  // =============================================================================================
  // SMM-08 - the composer. The claims worth proving here are the STATE LAW ones: an edit to
  // approved content invalidates its approval mechanically (not by anyone remembering), a native
  // import can never masquerade as a dispatched post, and nothing already public can be edited or
  // deleted through the composer.
  // =============================================================================================
  async function makeAccount(tenant: string, client: string, network = "instagram", quota: unknown = { igPosts24h: { used: 1, cap: 25 } }): Promise<string> {
    const accId = newId();
    await withTenants([tenant], async (c) => {
      // ONE publisher org per (tenant, client) - 0105's UNIQUE is the D-2 guarantee that a Postiz
      // org can never serve two clients, so the helper REUSES the client's org rather than making
      // a second one. (Written the naive way first; the constraint caught it, which is the point
      // of putting the rule in the schema instead of in a convention.)
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
         VALUES ($1,$2,$3,$4,'env:KEY','central') ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [newId(), tenant, client, `org-${tenant}-${client}`],
      );
      const { rows: orgRows } = await c.query<{ id: string }>(
        `SELECT id FROM social_publisher_orgs WHERE tenant_id = $1 AND client_id = $2`, [tenant, client]);
      const orgId = orgRows[0].id;
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'connected',$7,'central')`,
        [accId, tenant, client, orgId, network, `@h-${accId}`, JSON.stringify(quota)],
      );
    }, { modules: ["social"] });
    return accId;
  }

  async function makeEngagement(tenant: string, client: string): Promise<string> {
    const id = newId();
    await app.inject({
      method: "POST", url: `/api/${tenant}/modules/social/engagements`, headers: asUser(manager),
      payload: { id, clientId: client, name: "composer engagement" },
    });
    return id;
  }

  async function makePost(tenant: string, engagementId: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/social/posts`, headers: asUser(manager),
      payload: { engagementId, title: "composer probe" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it("creates a variant, validating it against the network from the REGISTRY (not the caller)", async () => {
    const eng = await makeEngagement(B, clientB);
    const postId = await makePost(B, eng);
    const accountId = await makeAccount(B, clientB, "instagram");
    const res = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/posts/${postId}/variants`, headers: asUser(manager),
      payload: { accountId, body: "text only, no media" },
    });
    expect(res.statusCode).toBe(201);
    const { validation, argsSha256 } = res.json();
    // Instagram requires media - the caller never said "instagram", the registry did.
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((e: { rule: string }) => e.rule)).toContain("media_required");
    expect(argsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("EDIT INVALIDATES APPROVAL - the state law, proven end to end", async () => {
    const eng = await makeEngagement(B, clientB);
    const postId = await makePost(B, eng);
    const accountId = await makeAccount(B, clientB, "linkedin");
    const created = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/posts/${postId}/variants`, headers: asUser(manager),
      payload: { accountId, body: "the approved copy" },
    });
    const variantId = created.json().id;
    const hashBefore = created.json().argsSha256;

    // Simulate the state SMM-09 will produce: approved, carrying an approval.
    const approvalId = newId();
    await withTenants([B], async (c) => {
      await c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, origin, requested_by, origin_site)
         VALUES ($1,$2,'smm08-fixture','social.publishPost','{}'::jsonb,'high','approved','automation',$3,'central')`,
        [approvalId, B, manager],
      );
      await c.query(`UPDATE social_post_variants SET status='approved', approval_id=$1 WHERE id=$2`, [approvalId, variantId]);
    }, { modules: ["social"] });

    const edited = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/variants/${variantId}`, headers: asUser(manager),
      payload: { body: "the copy someone changed afterwards" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().approvalInvalidated).toBe(true);
    expect(edited.json().argsSha256).not.toBe(hashBefore);

    const { rows } = await withTenants([B], (c) =>
      c.query<{ status: string; approval_id: string | null }>(
        `SELECT status, approval_id FROM social_post_variants WHERE id = $1`, [variantId]),
      { modules: ["social"] });
    // Back to draft, approval dropped - in the SAME statement that changed the content, so there is
    // no window where an approval points at content nobody approved.
    expect(rows[0].status).toBe("draft");
    expect(rows[0].approval_id).toBeNull();
  });

  it("refuses to edit or delete anything already live", async () => {
    const eng = await makeEngagement(B, clientB);
    const postId = await makePost(B, eng);
    const accountId = await makeAccount(B, clientB, "linkedin");
    const created = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/posts/${postId}/variants`, headers: asUser(manager),
      payload: { accountId, body: "going out" },
    });
    const variantId = created.json().id;
    await withTenants([B], (c) =>
      c.query(`UPDATE social_post_variants SET status='published', approval_id=NULL, native_import=true WHERE id=$1`, [variantId]),
      { modules: ["social"] });

    const edit = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/social/variants/${variantId}`, headers: asUser(manager),
      payload: { body: "rewriting history" },
    });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error).toBe("variant_native_import_immutable");

    const del = await app.inject({
      method: "DELETE", url: `/api/${B}/modules/social/variants/${variantId}`, headers: asUser(manager),
    });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toBe("variant_is_live");
  });

  it("records a native import as bookkeeping - published, no approval, no provider id", async () => {
    const eng = await makeEngagement(B, clientB);
    const accountId = await makeAccount(B, clientB, "instagram");
    const res = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/posts/import-native`, headers: asUser(manager),
      payload: { engagementId: eng, accountId, title: "posted by hand", body: "from the phone", publishedUrl: "https://instagram.com/p/x" },
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await withTenants([B], (c) =>
      c.query<{ status: string; native_import: boolean; approval_id: string | null; provider_post_id: string | null }>(
        `SELECT status, native_import, approval_id, provider_post_id FROM social_post_variants WHERE post_id = $1`,
        [res.json().id]),
      { modules: ["social"] });
    // 0105's CHECK makes this structural, but the endpoint has to actually honour it.
    expect(rows[0]).toMatchObject({ status: "published", native_import: true, approval_id: null, provider_post_id: null });
  });

  it("refuses a post delete while a variant is live, rather than orphaning something public", async () => {
    const eng = await makeEngagement(B, clientB);
    const postId = await makePost(B, eng);
    const accountId = await makeAccount(B, clientB, "linkedin");
    const created = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/posts/${postId}/variants`, headers: asUser(manager),
      payload: { accountId, body: "live one" },
    });
    await withTenants([B], (c) =>
      c.query(`UPDATE social_post_variants SET status='published', native_import=true WHERE id=$1`, [created.json().id]),
      { modules: ["social"] });
    const del = await app.inject({ method: "DELETE", url: `/api/${B}/modules/social/posts/${postId}`, headers: asUser(manager) });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toBe("post_has_live_variants");
  });

  it("refuses a variant targeting another tenant's account", async () => {
    const engB = await makeEngagement(B, clientB);
    const postId = await makePost(B, engB);
    const foreignAccount = await makeAccount(A, clientA, "instagram");
    const res = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/posts/${postId}/variants`, headers: asUser(manager),
      payload: { accountId: foreignAccount, body: "wrong tenant" },
    });
    // 404, not 500: from B's side that account does not exist, and the composite FK is the
    // structural backstop underneath.
    expect(res.statusCode).toBe(404);
  });

  it("answers validation FRESH - a quota that moved since the last save changes the verdict", async () => {
    const eng = await makeEngagement(B, clientB);
    const postId = await makePost(B, eng);
    const accountId = await makeAccount(B, clientB, "instagram", { igPosts24h: { used: 1, cap: 25 } });
    const created = await app.inject({
      method: "POST", url: `/api/${B}/modules/social/posts/${postId}/variants`, headers: asUser(manager),
      payload: { accountId, body: "ok now", media: [{ fileId: "f1", kind: "image", alt: "a" }] },
    });
    expect(created.json().validation.ok).toBe(true);

    // The account hits its cap after the variant was saved.
    await withTenants([B], (c) =>
      c.query(`UPDATE social_accounts SET quota = $1 WHERE id = $2`, [JSON.stringify({ igPosts24h: { used: 25, cap: 25 } }), accountId]),
      { modules: ["social"] });

    const fresh = await app.inject({
      method: "GET", url: `/api/${B}/modules/social/variants/${created.json().id}/validation`, headers: asUser(manager),
    });
    expect(fresh.json().validation.ok).toBe(false);
    expect(fresh.json().validation.errors.map((e: { rule: string }) => e.rule)).toContain("quota_exhausted");
  });

});
