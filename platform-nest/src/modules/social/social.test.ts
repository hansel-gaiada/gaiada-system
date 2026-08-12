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
    // The publish surface must NOT be declared yet — its endpoint does not exist, and a tool the
    // hub publishes to every agent without a handler behind it is the frontend-first drift bug
    // pointed at automation.
    expect(socialModule.mcpTools.find((t) => t.name === "social.publishPost")).toBeUndefined();
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
});
