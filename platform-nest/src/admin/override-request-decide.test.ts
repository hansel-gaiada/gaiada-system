// P2-08 part B — the routed override: request → routed approval → in-band grant with an expiry.
//
// This is the path that turns a REFUSAL into authority, so it is written as an attack battery first.
// Every case goes through `app.inject()` against real Postgres and a restarted Cerbos: the requester
// ≠ decider rule is a structural Cerbos DENY, and asserting it any other way would be asserting the
// mirror instead of the authority.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, addMembership, grantRole } from "../testing/fixtures";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const ORG_BLOB = {
  root: {
    id: "d-corp", name: "Corp", kind: "company", assigneeId: null, assigneeName: null,
    children: [{ id: "d-web", name: "Web", kind: "department", assigneeId: null, assigneeName: null, children: [] }],
  },
};

describe.skipIf(!TEST_URL || !live)("P2-08b — the routed override", () => {
  let app: NestFastifyApplication;
  let T: string;
  let admin: string;     // company_admin — the routable approver for non-hr overrides
  let hrMgr: string;     // hr_manager — the routed approver for hr-sensitive overrides
  let webLead: string;   // org_unit_lead @ d-web — the requester
  let staff: string;     // the target, placed under d-web
  let hrManagerRole: string;
  let memberRole: string;

  const request = (payload: Record<string, unknown>, actor: string) =>
    app.inject({ method: "POST", url: `/api/${T}/role-grants/overrides`, headers: asUser(actor), payload });

  const decide = (approvalId: string, actor: string, decision = "approved") =>
    app.inject({
      method: "POST", url: `/api/${T}/automation-approvals/${approvalId}/decide`,
      headers: asUser(actor), payload: { decision },
    });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    T = await createCompany("Override Co", ["hr", "reports"]);
    admin = await createUser("ov-admin@a.test");
    webLead = await createUser("ov-lead@a.test");
    staff = await createUser("ov-staff@a.test");
    hrMgr = await createUser("ov-hrmgr@a.test");
    for (const u of [admin, webLead, staff, hrMgr]) await addMembership(T, u);
    await grantRole(admin, await createRole("company_admin"), "company", T);
    await grantRole(webLead, await createRole("org_unit_lead", null), "org_unit", "d-web");
    hrManagerRole = await createRole("hr_manager");
    memberRole = await createRole("member");
    await grantRole(hrMgr, hrManagerRole, "company", T);

    app = await buildApp();
    const blob = JSON.parse(JSON.stringify(ORG_BLOB));
    blob.root.children[0].children.push(
      { id: `p-${webLead}`, name: "Lead", kind: "person", assigneeId: webLead, assigneeName: "Lead", children: [] },
      { id: `p-${staff}`, name: "Staff", kind: "person", assigneeId: staff, assigneeName: "Staff", children: [] },
    );
    expect((await app.inject({ method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(admin), payload: blob })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ─────────────────────────── the path exists at all ───────────────────────────

  it("the direct refusal now NAMES the override route instead of dead-ending", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${T}/role-grants`,
      headers: asUser(webLead), payload: { userId: staff, roleId: hrManagerRole },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("override_required");
    expect(res.json().error).toContain("/role-grants/overrides");
  });

  it("a dept head files an override, and it routes to hr_manager for an hr-sensitive role", async () => {
    const res = await request({ userId: staff, roleId: hrManagerRole, justification: "covering HR while Ana is on leave" }, webLead);
    expect(res.statusCode).toBe(201);
    expect(res.json().routedTo).toBe("hr_manager"); // §6.5's routing map: hr.*-sensitive -> HR tier
    expect(res.json().expiresInDays).toBe(90);      // §12 Q4's default

    const row = await withTenants([T], (c) =>
      c.query<{ origin: string; workflow_id: string; status: string; requested_by: string }>(
        `SELECT origin, workflow_id, status, requested_by FROM automation_approvals WHERE id = $1`,
        [res.json().approvalId],
      ),
    );
    expect(row.rows[0]).toMatchObject({ origin: "iam", workflow_id: "iam:override", status: "pending", requested_by: webLead });
  });

  it("a non-hr role routes to company_admin", async () => {
    const res = await request({ userId: staff, roleId: memberRole, justification: "temporary cover" }, webLead);
    expect(res.statusCode).toBe(201);
    expect(res.json().routedTo).toBe("company_admin");
  });

  it("refuses a request with no justification — the reason IS the audit trail", async () => {
    const res = await request({ userId: staff, roleId: hrManagerRole }, webLead);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("justification required");
  });

  // ─────────────────────────── approval grants, with an expiry ───────────────────────────

  it("an approving decision EXECUTES the grant in-band, time-boxed and traceable to the approval", async () => {
    const filed = await request({ userId: staff, roleId: hrManagerRole, expiresInDays: 30, justification: "maternity cover" }, webLead);
    const approvalId = filed.json().approvalId as string;

    // Decided by the ROUTED approver (hr_manager), not by company_admin. That distinction is the
    // whole reason routing exists: a company_admin does NOT hold hr_manager's appraisal keys
    // (reports.appraisal.confirm_evidence/cycle_admin/finalize are hr_people_ops-only), so the
    // ceiling correctly refuses them this grant. The router sends it to the tier that can back it.
    const res = await decide(approvalId, hrMgr);
    expect(res.statusCode).toBe(200);
    expect(res.json().iam.grantId).toBeTruthy();
    expect(res.json().iam.expiresAt).toBeTruthy();

    const grant = await withGlobal((c) =>
      c.query<{ expires_at: string | null; origin_approval_id: string | null }>(
        `SELECT expires_at, origin_approval_id FROM user_roles WHERE id = $1`,
        [res.json().iam.grantId],
      ),
    );
    expect(grant.rows[0].expires_at).not.toBeNull();
    expect(grant.rows[0].origin_approval_id).toBe(approvalId); // provenance, not just a grant
  });

  it("cuts the target's session so the new authority is picked up", async () => {
    const before = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [staff]),
    );
    const filed = await request({ userId: staff, roleId: memberRole, justification: "cover" }, webLead);
    await decide(filed.json().approvalId as string, admin);
    const after = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [staff]),
    );
    expect(after.rows[0].session_version).toBeGreaterThan(before.rows[0].session_version);
  });

  it("a REJECTED override grants nothing", async () => {
    const filed = await request({ userId: staff, roleId: hrManagerRole, justification: "not needed after all" }, webLead);
    const res = await decide(filed.json().approvalId as string, hrMgr, "rejected");
    expect(res.statusCode).toBe(200);
    expect(res.json().iam).toBeUndefined();
  });

  // ─────────────────────────── the attack battery ───────────────────────────

  it("🔴 REQUESTER ≠ DECIDER: the dept head cannot approve their own request", async () => {
    // Structural Cerbos DENY (deny-overrides), not a controller check — so it holds even if a future
    // writer forgets it. The requester here otherwise HAS create reach on this target.
    const filed = await request({ userId: staff, roleId: memberRole, justification: "self approve attempt" }, webLead);
    const res = await decide(filed.json().approvalId as string, webLead);
    expect(res.statusCode).toBe(403);

    const row = await withTenants([T], (c) =>
      c.query<{ status: string }>(`SELECT status FROM automation_approvals WHERE id = $1`, [filed.json().approvalId]),
    );
    expect(row.rows[0].status).toBe("pending"); // refused, not silently decided
  });

  it("🔴 even a company_admin cannot approve an override THEY requested", async () => {
    const filed = await request({ userId: staff, roleId: memberRole, justification: "admin self-route" }, admin);
    expect(filed.statusCode).toBe(201);
    const res = await decide(filed.json().approvalId as string, admin);
    expect(res.statusCode).toBe(403);
  });

  it("a plain member can neither request nor decide", async () => {
    const plain = await createUser("ov-plain@a.test");
    await addMembership(T, plain);
    await grantRole(plain, memberRole, "company", T);
    expect((await request({ userId: staff, roleId: memberRole, justification: "nope" }, plain)).statusCode).toBe(403);

    const filed = await request({ userId: staff, roleId: memberRole, justification: "legit" }, webLead);
    expect((await decide(filed.json().approvalId as string, plain)).statusCode).toBe(403);
  });

  it("the override routes past SENSITIVITY only — never past the elevated fence", async () => {
    const clientRole = await createRole("client");
    const res = await request({ userId: staff, roleId: clientRole, justification: "trying the fence" }, webLead);
    expect(res.statusCode).toBe(400);
    expect(["elevated_role_forbidden", "not_ui_grantable"].some((t) => res.json().error.includes(t))).toBe(true);
  });

  it("the override routes past SENSITIVITY only — never past the SUBTREE bound", async () => {
    // A target outside the requester's subtree is refused at request time by Cerbos, exactly as the
    // direct path refuses it. An approval queue is not a way around the org chart.
    const outsider = await createUser("ov-outsider@a.test");
    await addMembership(T, outsider); // member of the tenant, but placed nowhere in d-web
    const res = await request({ userId: outsider, roleId: memberRole, justification: "reaching outside" }, webLead);
    expect(res.statusCode).toBe(403);
  });

  it("a target outside the company cannot be the subject of an override", async () => {
    const stranger = await createUser("ov-stranger@a.test");
    const res = await request({ userId: stranger, roleId: memberRole, justification: "cross tenant" }, webLead);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("not an active member");
  });

  it("global scope is not expressible through the override path either", async () => {
    const res = await request({ userId: staff, roleId: memberRole, scopeType: "global", justification: "escalate" }, webLead);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("scopeType must be");
  });

  it("an absurd expiry is refused rather than clamped", async () => {
    const res = await request({ userId: staff, roleId: memberRole, expiresInDays: 4000, justification: "forever" }, webLead);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("expiresInDays");
  });

  it("ordinary approvals are BYTE-UNCHANGED by all of this", async () => {
    // The decide route now picks one of three Cerbos actions. A non-IAM row must still take the
    // generic `decide` path and must NOT acquire an `override` key in its response.
    const approvalId = (await withTenants([T], async (c) => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, origin_site)
         VALUES (gen_random_uuid(), $1, 'wf:ordinary', 'some.tool', '{}', 'medium', 'ordinary row', $2, 'automation', 'central')
         RETURNING id`,
        [T, webLead],
      )).rows[0].id;
      return id;
    })) as string;

    const res = await decide(approvalId, admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: approvalId, status: "approved" });
  });
  // ─────────────── §11.2 the dept head's assignment request, end to end ───────────────

  it("an approved ASSIGNMENT request opens the seat and moves access", async () => {
    // The payoff of the flip: the lead proposes, HR/company_admin agrees, and the seat + its grants
    // appear. Same inbox, same decide_override action, same execution seam as an override.
    config.positionSyncEnabled = true;
    try {
      const pos = await app.inject({
        method: "POST", url: `/api/${T}/positions`, headers: asUser(admin),
        payload: { unitNodeId: "d-web", title: "FE Rota", roles: [{ roleId: memberRole }] },
      });
      expect(pos.statusCode).toBe(201);
      const positionId = pos.json().id as string;

      const requested = await app.inject({
        method: "POST", url: `/api/${T}/positions/${positionId}/assignment-requests`,
        headers: asUser(webLead), payload: { userId: staff, justification: "rota cover" },
      });
      expect(requested.statusCode).toBe(201);

      const decided = await decide(requested.json().approvalId as string, admin);
      expect(decided.statusCode).toBe(200);
      expect(decided.json().iam.kind).toBe("position_assign");
      expect(decided.json().iam.assignmentId).toBeTruthy();

      const seats = await withTenants([T], (c) =>
        c.query(`SELECT id FROM position_assignments WHERE tenant_id = $1 AND position_id = $2 AND valid_to IS NULL`, [
          T, positionId,
        ]),
      );
      expect(seats.rows).toHaveLength(1);
    } finally {
      config.positionSyncEnabled = false;
    }
  });

  it("🔴 a dept head cannot approve their OWN assignment request either", async () => {
    const pos = await app.inject({
      method: "POST", url: `/api/${T}/positions`, headers: asUser(admin),
      payload: { unitNodeId: "d-web", title: "Self Approve Seat", roles: [{ roleId: memberRole }] },
    });
    const requested = await app.inject({
      method: "POST", url: `/api/${T}/positions/${pos.json().id}/assignment-requests`,
      headers: asUser(webLead), payload: { userId: staff, justification: "trying to self-approve" },
    });
    expect(requested.statusCode).toBe(201);
    // Same structural DENY as an override — the flip did not create a second, weaker door.
    expect((await decide(requested.json().approvalId as string, webLead)).statusCode).toBe(403);
  });

  it("a stale request against a RETIRED position is refused at execution, not applied blindly", async () => {
    // An approval can sit in the inbox for days. The seat is re-read at execution time precisely so a
    // decision made against a position that has since been retired does not fill it.
    const pos = await app.inject({
      method: "POST", url: `/api/${T}/positions`, headers: asUser(admin),
      payload: { unitNodeId: "d-web", title: "Doomed Seat", roles: [{ roleId: memberRole }] },
    });
    const positionId = pos.json().id as string;
    const requested = await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/assignment-requests`,
      headers: asUser(webLead), payload: { userId: staff, justification: "will go stale" },
    });
    expect((await app.inject({ method: "POST", url: `/api/${T}/positions/${positionId}/retire`, headers: asUser(admin) })).statusCode).toBe(200);

    const decided = await decide(requested.json().approvalId as string, admin);
    expect(decided.statusCode).toBe(400);
    expect(decided.json().error).toContain("stale");
  });

});
