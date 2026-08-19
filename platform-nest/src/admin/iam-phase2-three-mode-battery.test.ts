// P2-16 — the adversarial + three-mode battery.
//
// Design §5.2 states the acceptance criterion this whole phase exists for, and binds it on P2-16 in
// ALL THREE OPERATING MODES. After a transfer commits and the reconciler has run:
//   (a) zero `user_roles` rows carry `managed_by_position` pointing at the CLOSED assignment;
//   (b) a live `authorize()` probe against a resource only the OLD department could reach ⇒ 403;
//   (c) the NEW department's probe ⇒ 200;
//   (d) the target's `session_version` moved.
//
// ⚠ (b) AND (c) ARE PROVEN AGAINST RUNNING CERBOS, never derived from a bundle. That is the
// [role-bundles-overstate-reach] lesson: `org_unit_lead`'s whole meaning is its CONDITION
// (`g.scopeId in resource.attr.unitAncestors`), so a bundle-based check cannot witness a mover at all —
// it would report the same reach before and after the transfer and pass while the estate was broken.
//
// ── WHAT "THREE MODES" MEANS AT THIS BOUNDARY, CONCRETELY ────────────────────────────────────────
// The agentic-native bar says a capability must work identically under a human, under n8n, and under an
// agent. At the platform's door those are three HEADER SHAPES, and nothing else differs:
//   1. UI PERSONA  — service token + `x-user-id` (the impersonation path the console uses).
//   2. MCP TOOL    — service token + an OBO envelope for the AGENT's own verified identity link.
//   3. N8N         — service token + an OBO envelope for a workflow's `wf:*` link.
// Driving all three through `app.inject()` against one real Postgres and one real Cerbos is what makes
// this a parity proof rather than three restatements of the same code path: same endpoint, same
// reconciler, three different principals, and the criterion asserted identically each time.
//
// Modes 2 and 3 deliberately do NOT go through the hub. The hub's own contribution (tool advertising,
// the impact gate, the D14 grant) is covered by `d14-jml-registry.test.ts` and the hub's suites; what is
// under test HERE is that the platform's transfer capability behaves the same for an OBO principal as
// for a human one. Routing through the hub would test the hub twice and this once.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { withTenants, withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../testing/fixtures";
import { check, type Resource } from "../rbac/cerbos";
import { assemblePrincipal } from "../rbac/principal";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const svc = { authorization: "Bearer svc-token" };
const HR = { modules: ["hr"] };

/** Ancestor chains exactly as `org_unit_closure` produces them: self-inclusive, nearest-first. */
const WEB = ["dv-frontend", "d-web", "d-corp"];
const HR_UNIT = ["dv-hr-ops", "d-hr", "d-corp"];

const ORG_BLOB = {
  root: {
    id: "d-corp", name: "Corp", kind: "company", assigneeId: null, assigneeName: null,
    children: [
      {
        id: "d-web", name: "Web Dev", kind: "department", assigneeId: null, assigneeName: null,
        children: [{ id: "dv-frontend", name: "Frontend", kind: "division", assigneeId: null, assigneeName: null, children: [] }],
      },
      {
        id: "d-hr", name: "HR", kind: "department", assigneeId: null, assigneeName: null,
        children: [{ id: "dv-hr-ops", name: "HR Ops", kind: "division", assigneeId: null, assigneeName: null, children: [] }],
      },
    ],
  },
};

describe.skipIf(!TEST_URL || !live)("P2-16 — the mover criterion in all three operating modes", () => {
  let app: NestFastifyApplication;
  let T: string;
  let leadRole: string;
  let hrManager: string;
  let agentUser: string;
  let webPosition: string;
  let hrPosition: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.positionSyncEnabled = true;
    T = await createCompany("P2-16 Battery Co");
    await withGlobal((c) =>
      c.query(
        `UPDATE companies SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{orgStructure}', $2::jsonb) WHERE id = $1`,
        [T, JSON.stringify(ORG_BLOB)],
      ),
    );

    leadRole = await createRole("org_unit_lead", null);
    // `hr_people_ops` is a DERIVED role (== hr_manager only, the ACTING HR tier), not a grantable role
    // name — granting a role literally called "hr_people_ops" satisfies nothing and every hire 403s.
    // The grantable role is `hr_manager`; derived_roles.yaml's own note explains the split from
    // `hr_people_reader`.
    const hrRole = await createRole("hr_manager", null);

    // The human who performs the transfer in mode 1 — and whose authority modes 2 and 3 borrow, because
    // an OBO principal is a REAL user, not a separate authorization tier.
    hrManager = await createUser("p216.hr@ex.com", "P2-16 HR");
    await addMembership(T, hrManager, "employee");
    await grantRole(hrManager, hrRole, "company", T);

    // The agent's own principal (mode 2) and the workflow's (mode 3) — both need the same authority to
    // perform a transfer, which is exactly the point: the capability is the same capability.
    agentUser = await createUser("p216.agent@ex.com", "P2-16 Agent");
    await addMembership(T, agentUser, "employee");
    await grantRole(agentUser, hrRole, "company", T);
    await linkIdentity(agentUser, "claude", "agent:p216", true);

    const wfUser = await createUser("p216.wf@gaiada.system", "P2-16 Workflow");
    await addMembership(T, wfUser, "service");
    await grantRole(wfUser, hrRole, "company", T);
    await linkIdentity(wfUser, "n8n", "wf:p216", true);

    webPosition = await positionWithLead("dv-frontend", "Web Seat");
    hrPosition = await positionWithLead("dv-hr-ops", "HR Seat");

    app = await buildApp();
    await app.init();
  });

  afterAll(async () => {
    config.positionSyncEnabled = false;
    await app?.close();
    await teardownTestDb();
  });

  /** A seat whose role-set confers `org_unit_lead` at the position's OWN unit — the only shape whose
   *  reach is OBSERVABLE through a Cerbos probe, since its condition IS its meaning. */
  async function positionWithLead(unitNode: string, title: string): Promise<string> {
    const id = newId();
    await withTenants([T], async (c) => {
      await c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,$3,$4)`, [id, T, unitNode, title]);
      await c.query(
        `INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,'own_unit')`,
        [T, id, leadRole],
      );
    });
    return id;
  }

  /** Probe RUNNING Cerbos with whatever the reconciler materialized for this user right now. */
  async function probe(userId: string, unitAncestors: string[]): Promise<number> {
    const p = await assemblePrincipal(userId, "high");
    if (!p) return 401;
    const resource: Resource = {
      kind: "report_document", id: "p216-doc", tenantId: T, module: "reports", unitAncestors,
    };
    return (await check(p, resource, "read_department")).allow ? 200 : 403;
  }

  async function sessionVersion(userId: string): Promise<number> {
    const { rows } = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId]),
    );
    return rows[0].session_version;
  }

  /** Grants still pointing at a CLOSED assignment — criterion (a). Must be zero. */
  async function grantsOnClosedAssignments(userId: string): Promise<number> {
    const { rows } = await withTenants([T], (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM user_roles ur
           JOIN position_assignments pa ON pa.id = ur.managed_by_position
          WHERE ur.user_id = $1 AND pa.valid_to IS NOT NULL`,
        [userId],
      ),
    );
    return Number(rows[0].n);
  }

  /** Hire one person into the Web seat and confirm the starting state, so each mode begins level. */
  async function hireIntoWeb(label: string, headers: Record<string, string>): Promise<{ employeeId: string; userId: string }> {
    const res = await app.inject({
      method: "POST",
      url: `/api/${T}/hr/employees`,
      headers,
      payload: { displayName: label, workEmail: `${label}@ex.com`, positionId: webPosition },
    });
    expect(res.statusCode, `hire (${label}): ${res.body}`).toBe(201);
    // The hire returns the SHAPED employee at the top level plus `reconciled` — not a nested
    // `{employee}` envelope. Read from the real response rather than an assumed shape.
    const body = res.json() as { id: string; userId: string; reconciled: { granted: number } | null };
    const employeeId = body.id;
    const userId = body.userId;
    // The seat's grants land during the hire, not on a timer — asserted so a later 403 cannot be
    // mistaken for "the reconciler had not run yet".
    expect(body.reconciled?.granted, `hire (${label}) should have granted the seat's role`).toBeGreaterThan(0);
    // Baseline: the Web seat reaches Web and NOT HR. Asserted per mode rather than once, because a mode
    // that started from a different state would make its post-transfer assertions meaningless.
    expect(await probe(userId, WEB)).toBe(200);
    expect(await probe(userId, HR_UNIT)).toBe(403);
    return { employeeId, userId };
  }

  /** The four-part criterion, asserted identically in every mode. */
  async function assertMoverCriterion(userId: string, versionBefore: number): Promise<void> {
    expect(await grantsOnClosedAssignments(userId), "(a) grants tagged to a closed assignment").toBe(0);
    expect(await probe(userId, WEB), "(b) OLD department probe must be 403").toBe(403);
    expect(await probe(userId, HR_UNIT), "(c) NEW department probe must be 200").toBe(200);
    expect(await sessionVersion(userId), "(d) session_version must move").toBeGreaterThan(versionBefore);
  }

  // ── mode 1: the UI persona ──────────────────────────────────────────────────────────────────────

  it("MODE 1 (UI persona, x-user-id): a transfer moves reach from Web to HR, proven against live Cerbos", async () => {
    const headers = { ...svc, "x-user-id": hrManager };
    const { employeeId, userId } = await hireIntoWeb("p216.mode1", headers);
    const before = await sessionVersion(userId);

    const res = await app.inject({
      method: "POST",
      url: `/api/${T}/hr/employees/${employeeId}/transfer`,
      headers,
      payload: { toPositionId: hrPosition, reason: "P2-16 mode 1" },
    });
    expect(res.statusCode, res.body).toBe(200);

    await assertMoverCriterion(userId, before);
  });

  // ── mode 2: an agent, on its own verified identity ──────────────────────────────────────────────

  it("MODE 2 (MCP/agent OBO envelope): the SAME transfer, the SAME criterion", async () => {
    // The OBO headers the hub sends. `assurance: linked` rather than `high` — and the transfer still
    // works, which is the parity claim: the capability is gated on AUTHORITY, not on how you arrived.
    const headers = { ...svc, "x-obo-provider": "claude", "x-obo-external-id": "agent:p216" };
    const { employeeId, userId } = await hireIntoWeb("p216.mode2", headers);
    const before = await sessionVersion(userId);

    const res = await app.inject({
      method: "POST",
      url: `/api/${T}/hr/employees/${employeeId}/transfer`,
      headers,
      payload: { toPositionId: hrPosition, reason: "P2-16 mode 2" },
    });
    expect(res.statusCode, res.body).toBe(200);

    await assertMoverCriterion(userId, before);
  });

  // ── mode 3: an n8n workflow ─────────────────────────────────────────────────────────────────────

  it("MODE 3 (n8n envelope): the SAME transfer, the SAME criterion", async () => {
    const headers = { ...svc, "x-obo-provider": "n8n", "x-obo-external-id": "wf:p216" };
    const { employeeId, userId } = await hireIntoWeb("p216.mode3", headers);
    const before = await sessionVersion(userId);

    const res = await app.inject({
      method: "POST",
      url: `/api/${T}/hr/employees/${employeeId}/transfer`,
      headers,
      payload: { toPositionId: hrPosition, reason: "P2-16 mode 3" },
    });
    expect(res.statusCode, res.body).toBe(200);

    await assertMoverCriterion(userId, before);
  });

  // ── the leaver criterion: denied on the NEXT mutation ───────────────────────────────────────────

  it("🔴 LEAVER: after terminate, the person's own reach is gone and their login is disabled", async () => {
    const headers = { ...svc, "x-user-id": hrManager };
    const { employeeId, userId } = await hireIntoWeb("p216.leaver", headers);

    const res = await app.inject({
      method: "POST",
      url: `/api/${T}/hr/employees/${employeeId}/terminate`,
      headers,
      payload: { reason: "P2-16 leaver" },
    });
    expect(res.statusCode, res.body).toBe(200);

    // Reach is gone from BOTH departments — and the refusal is STRONGER than a 403: `probe()` returns
    // 401 because `assemblePrincipal` yields null for a disabled user, so there is no principal left to
    // deny. That distinction is worth asserting precisely rather than accepting either: a 403 would mean
    // "still a principal, currently unauthorized", which is a state a leaver must not be in.
    expect(await probe(userId, WEB), "a terminated person has no assemblable principal at all").toBe(401);
    expect(await probe(userId, HR_UNIT)).toBe(401);
    expect(await grantsOnClosedAssignments(userId)).toBe(0);

    // And the principal itself is no longer assemblable: `assemblePrincipal` returns null for a
    // disabled user, which is what makes the NEXT request fail rather than merely the next authorize().
    const { rows } = await withGlobal((c) =>
      c.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId]),
    );
    expect(rows[0].status).toBe("disabled");
    expect(await assemblePrincipal(userId, "high")).toBeNull();
  });

  // ── adversarial: the refusals that must survive every mode ──────────────────────────────────────

  it("🔴 a plain member cannot transfer anyone, in ANY of the three modes", async () => {
    const member = await createUser("p216.member@ex.com", "P2-16 Member");
    await addMembership(T, member, "employee");
    await linkIdentity(member, "claude", "agent:p216-member", true);
    await linkIdentity(member, "n8n", "wf:p216-member", true);

    const victim = await hireIntoWeb("p216.victim", { ...svc, "x-user-id": hrManager });

    const modes: Array<[string, Record<string, string>]> = [
      ["ui", { ...svc, "x-user-id": member }],
      ["agent", { ...svc, "x-obo-provider": "claude", "x-obo-external-id": "agent:p216-member" }],
      ["n8n", { ...svc, "x-obo-provider": "n8n", "x-obo-external-id": "wf:p216-member" }],
    ];
    for (const [label, headers] of modes) {
      const res = await app.inject({
        method: "POST",
        url: `/api/${T}/hr/employees/${victim.employeeId}/transfer`,
        headers,
        payload: { toPositionId: hrPosition },
      });
      expect(res.statusCode, `${label} must be refused: ${res.body}`).toBe(403);
    }
    // The victim's reach is untouched by three failed attempts.
    expect(await probe(victim.userId, WEB)).toBe(200);
    expect(await probe(victim.userId, HR_UNIT)).toBe(403);
  });

  it("🔴 an UNVERIFIED OBO link gets an anonymous principal and is refused", async () => {
    // The guard's own rule: unverified/unknown ⇒ minimal principal. Asserted here because an agent whose
    // link was never verified reaching a JML write would be the whole assurance model failing quietly.
    const stranger = await createUser("p216.stranger@ex.com", "P2-16 Stranger");
    await addMembership(T, stranger, "employee");
    await linkIdentity(stranger, "claude", "agent:p216-unverified", false);
    const victim = await hireIntoWeb("p216.victim2", { ...svc, "x-user-id": hrManager });

    const res = await app.inject({
      method: "POST",
      url: `/api/${T}/hr/employees/${victim.employeeId}/transfer`,
      headers: { ...svc, "x-obo-provider": "claude", "x-obo-external-id": "agent:p216-unverified" },
      payload: { toPositionId: hrPosition },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("🔴 a transfer to a RETIRED position is refused, and changes nothing", async () => {
    const headers = { ...svc, "x-user-id": hrManager };
    const { employeeId, userId } = await hireIntoWeb("p216.retired", headers);
    const retired = await positionWithLead("dv-hr-ops", "Retired Seat");
    await withTenants([T], (c) => c.query(`UPDATE positions SET status='retired' WHERE id=$1`, [retired]));

    const res = await app.inject({
      method: "POST",
      url: `/api/${T}/hr/employees/${employeeId}/transfer`,
      headers,
      payload: { toPositionId: retired },
    });
    expect(res.statusCode).toBe(400);
    // Unchanged: still Web, still not HR. A refused transfer that half-applied would be worse than one
    // that failed loudly, so this is asserted rather than assumed from the status code.
    expect(await probe(userId, WEB)).toBe(200);
    expect(await probe(userId, HR_UNIT)).toBe(403);
    expect(await grantsOnClosedAssignments(userId)).toBe(0);
  });

  it("🔴 a transfer across COMPANIES is refused — the employee belongs to this tenant only", async () => {
    const other = await createCompany("P2-16 Other Co");
    const headers = { ...svc, "x-user-id": hrManager };
    const { employeeId } = await hireIntoWeb("p216.crosstenant", headers);

    const res = await app.inject({
      method: "POST",
      url: `/api/${other}/hr/employees/${employeeId}/transfer`,
      headers,
      payload: { toPositionId: hrPosition },
    });
    // 403 (no authority there) or 404 (not that tenant's employee) are both correct refusals; a 200 is
    // the cross-tenant write this asserts cannot happen.
    expect([403, 404]).toContain(res.statusCode);
  });
});
