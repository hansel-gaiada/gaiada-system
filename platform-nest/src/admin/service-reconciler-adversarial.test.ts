// ORG-6 QA GATE — ADVERSARIAL suite (author-independent). Goal: LEAK/TEARDOWN-GAP HUNTING, not
// confirming the author's happy paths. Runs against LIVE disposable Postgres (skips w/o
// DATABASE_URL_TEST). Vectors: cross-tenant leak under each target's own RLS session + a
// non-served company seeing nothing; teardown precision on manual/employee rows incl. a
// different-role manual grant; refcount concurrency (interleaved double-revoke of overlapping
// claims); re-link into a foreign provider (composite-FK) + re-link moving a person out; stale/
// replayed events (revoked/suspended convergence, no resurrection); flag-off no-op across all
// entry points; session_version invalidation on revoke.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "../db";
import { config } from "../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import {
  reconcileAssignment,
  reconcileProvider,
  sweepDriftAndOrphans,
} from "./service-reconciler";

interface Node {
  id: string;
  name: string;
  kind: string;
  assigneeId?: string | null;
  children?: Node[];
}

async function setBlob(tenant: string, root: Node): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, 'main')
       ON CONFLICT (tenant_id) DO UPDATE SET structure = $2, updated_at = now()`,
      [tenant, JSON.stringify({ root })],
    ),
  );
}

async function createUnit(provider: string, nodeId: string, name = "HR", kind = "department"): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,$3,$4,$5)`, [
      id, provider, nodeId, kind, name,
    ]),
  );
  return id;
}

async function createAssignment(
  unitId: string,
  provider: string,
  target: string,
  opts: { status?: string; lead?: string | null; module?: string; createdBy: string },
): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(
      `INSERT INTO service_assignments
         (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, lead_user_id,
          unit_name, unit_kind, unit_status, created_by, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'HR','department','active',$8, now())`,
      [id, unitId, provider, target, opts.module ?? "hr", opts.status ?? "active", opts.lead ?? null, opts.createdBy],
    ),
  );
  return id;
}

async function setStatus(provider: string, id: string, status: string): Promise<void> {
  await withTenants([provider], (c) =>
    c.query(`UPDATE service_assignments SET status = $2 WHERE id = $1`, [id, status]),
  );
}

async function grantsFor(userId: string, target: string): Promise<{ role: string; managed: boolean }[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ role: string; managed_by: string | null }>(
      `SELECT r.name AS role, ur.managed_by FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.scope_type = 'company' AND ur.scope_id = $2 ORDER BY r.name`,
      [userId, target],
    ),
  );
  return rows.map((r) => ({ role: r.role, managed: r.managed_by !== null }));
}

async function membershipFor(
  target: string,
  userId: string,
): Promise<{ kind: string; status: string; deleted: boolean; managed: boolean } | null> {
  const { rows } = await withTenants([target], (c) =>
    c.query<{ kind: string; status: string; deleted_at: string | null; managed_by: string | null }>(
      `SELECT kind, status, deleted_at, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [target, userId],
    ),
  );
  if (!rows[0]) return null;
  return { kind: rows[0].kind, status: rows[0].status, deleted: rows[0].deleted_at !== null, managed: rows[0].managed_by !== null };
}

async function claimCount(assignmentId: string, target: string): Promise<number> {
  const { rows } = await withTenants([target], (c) =>
    c.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_grant_claims WHERE assignment_id = $1`, [assignmentId]),
  );
  return rows[0].n;
}

async function sessionVersion(userId: string): Promise<number> {
  const { rows } = await withGlobal((c) =>
    c.query<{ v: number }>(`SELECT session_version AS v FROM users WHERE id = $1`, [userId]),
  );
  return rows[0].v;
}

describe.skipIf(!TEST_URL)("ORG-6 ADVERSARIAL — leak & teardown hunting", () => {
  let H: string;
  let actor: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceAssignmentsEnabled = true;
    H = await createCompany("AdvHolding");
    actor = await createUser("adv-exec@holding.test");
  });
  afterAll(teardownTestDb);

  async function scenario(prefix: string, targetCount = 1) {
    const A = await createCompany(`${prefix}-provider`, [], H);
    const targets: string[] = [];
    for (let i = 0; i < targetCount; i++) targets.push(await createCompany(`${prefix}-target-${i}`, [], H));
    const u1 = await createUser(`${prefix}-u1@x.test`);
    const u2 = await createUser(`${prefix}-u2@x.test`);
    const u3 = await createUser(`${prefix}-u3@x.test`);
    await addMembership(A, u1);
    await addMembership(A, u2);
    await addMembership(A, u3);
    await setBlob(A, {
      id: "root", name: prefix, kind: "company",
      children: [
        {
          id: "d-hr", name: "HR", kind: "department",
          children: [
            { id: "r-lead", name: "Lead", kind: "role", children: [{ id: "p1", name: "U1", kind: "person", assigneeId: u1 }] },
            { id: "p2", name: "U2", kind: "person", assigneeId: u2 },
            { id: "p3", name: "U3", kind: "person", assigneeId: u3 },
          ],
        },
      ],
    });
    const unitId = await createUnit(A, "d-hr");
    return { A, targets, u1, u2, u3, unitId };
  }

  // ── VECTOR 1: no cross-tenant leak. Read as EACH target under its OWN RLS session; a
  //    non-served company E sees NOTHING; nothing lands in the provider tenant. ──────────────
  it("V1 no cross-tenant leak: each target's RLS session sees only its own claims; non-served E sees nothing; provider unpolluted", async () => {
    const s = await scenario("v1", 2);
    const [B, C] = s.targets;
    const E = await createCompany("v1-nonserved-E", [], H); // same holding, NEVER a target
    const aB = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    const aC = await createAssignment(s.unitId, s.A, C, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(aB, s.A);
    await reconcileAssignment(aC, s.A);

    // (a) service_grant_claims RLS: B's session sees ONLY tenant_id=B claims; symmetric for C.
    const claimsAsB = await withTenants([B], (c) =>
      c.query<{ tenant_id: string; assignment_id: string }>(`SELECT tenant_id, assignment_id FROM service_grant_claims`),
    );
    expect(claimsAsB.rows.length).toBeGreaterThan(0);
    for (const r of claimsAsB.rows) {
      expect(r.tenant_id).toBe(B);       // never a C-tenant claim
      expect(r.assignment_id).toBe(aB);  // never aC
    }
    const claimsAsC = await withTenants([C], (c) =>
      c.query<{ tenant_id: string }>(`SELECT tenant_id FROM service_grant_claims`),
    );
    for (const r of claimsAsC.rows) expect(r.tenant_id).toBe(C);

    // (b) NON-served company E: zero claims, zero memberships for the service users, zero grants.
    const claimsAsE = await withTenants([E], (c) => c.query(`SELECT 1 FROM service_grant_claims`));
    expect(claimsAsE.rows.length).toBe(0);
    for (const u of [s.u1, s.u2, s.u3]) {
      expect(await membershipFor(E, u)).toBeNull();
      expect(await grantsFor(u, E)).toEqual([]);
    }

    // (c) memberships RLS: B's session cannot see C's service memberships (would be a leak).
    const memAsB = await withTenants([B], (c) =>
      c.query<{ tenant_id: string }>(`SELECT tenant_id FROM company_memberships`),
    );
    for (const r of memAsB.rows) expect(r.tenant_id).toBe(B);

    // (d) provider tenant A is never polluted: users get NO company-scoped grant on A, and A's
    //     own memberships are never flipped to kind='service'/managed.
    for (const u of [s.u1, s.u2, s.u3]) {
      expect(await grantsFor(u, s.A)).toEqual([]);
      const mA = await membershipFor(s.A, u);
      expect(mA).toMatchObject({ kind: "employee", managed: false }); // untouched provider membership
    }

    // (e) grants are scoped per-target — u2 has exactly {B, C}, never E or A.
    const scopes = await withGlobal((c) =>
      c.query<{ scope_id: string }>(`SELECT scope_id FROM user_roles WHERE user_id=$1 AND scope_type='company'`, [s.u2]),
    );
    expect(new Set(scopes.rows.map((r) => r.scope_id))).toEqual(new Set([B, C]));
  });

  // ── VECTOR 2: teardown precision. Employee membership + a MANUAL same-role grant + a MANUAL
  //    DIFFERENT-role grant must ALL survive revoke; managed artifacts gone; no orphan claims. ──
  it("V2 teardown spares employee membership + manual same-role grant + manual different-role grant; no orphan claims", async () => {
    const s = await scenario("v2");
    const B = s.targets[0];
    // u2 is a pre-existing EMPLOYEE of B and ALSO placed in the served unit.
    await addMembership(B, s.u2);
    // u2 has a MANUAL hr_staff grant (same role the reconciler would grant) — managed_by NULL.
    const hrStaff = (
      await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name='hr_staff'`))
    ).rows[0].id;
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'company',$4)`,
        [newId(), s.u2, hrStaff, B]),
    );
    // u2 ALSO has a MANUAL grant of a DIFFERENT role scoped to B (must be 100% untouched).
    const otherRole = await createRole("finance_viewer", null);
    await grantRole(s.u2, otherRole, "company", B);

    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);
    // Reconciler recorded NO grant claim on the manual hr_staff row (A2) → u2 keeps exactly the two manual rows.
    expect(await grantsFor(s.u2, B)).toEqual([
      { role: "finance_viewer", managed: false },
      { role: "hr_staff", managed: false },
    ]);

    await setStatus(s.A, asg, "revoked");
    await reconcileAssignment(asg, s.A);

    // GUARD: employee membership survives (never flipped/deleted).
    expect(await membershipFor(B, s.u2)).toMatchObject({ kind: "employee", status: "active", deleted: false, managed: false });
    // GUARD: BOTH manual grants survive, unchanged.
    expect(await grantsFor(s.u2, B)).toEqual([
      { role: "finance_viewer", managed: false },
      { role: "hr_staff", managed: false },
    ]);
    // Managed artifacts for u1/u3 are gone.
    expect(await grantsFor(s.u1, B)).toEqual([]);
    expect(await membershipFor(B, s.u1)).toMatchObject({ kind: "service", status: "inactive", deleted: true });
    // No orphan claims left behind on this assignment.
    expect(await claimCount(asg, B)).toBe(0);
  });

  // ── VECTOR 3: refcount concurrency. Two assignments in the SAME provider both claim the same
  //    grant for the same user. Revoke BOTH, then reconcile them CONCURRENTLY. The shared grant
  //    must converge to DELETED with no orphan claim — a count-after-delete race would leave the
  //    grant standing with zero claims (a cross-tenant access LEAK after both revocations). ────
  it("V3 concurrent double-revoke of overlapping claims converges (no orphaned grant leak)", async () => {
    let leaks = 0;
    const ITER = 12;
    for (let i = 0; i < ITER; i++) {
      const A = await createCompany(`v3-${i}-prov`, [], H);
      const B = await createCompany(`v3-${i}-tgt`, [], H);
      const u = await createUser(`v3-${i}-u@x.test`);
      await addMembership(A, u);
      await setBlob(A, {
        id: "root", name: "v3", kind: "company",
        children: [
          { id: "d-hr", name: "HR", kind: "department", children: [{ id: "p", name: "U", kind: "person", assigneeId: u }] },
          { id: "d-hr2", name: "HR2", kind: "department", children: [{ id: "p2", name: "U", kind: "person", assigneeId: u }] },
        ],
      });
      const unit1 = await createUnit(A, "d-hr");
      const unit2 = await createUnit(A, "d-hr2", "HR2");
      const a1 = await createAssignment(unit1, A, B, { createdBy: actor });
      const a2 = await createAssignment(unit2, A, B, { createdBy: actor });
      await reconcileAssignment(a1, A);
      await reconcileAssignment(a2, A);
      expect(await grantsFor(u, B)).toEqual([{ role: "hr_staff", managed: true }]); // 1 grant, 2 claims

      await setStatus(A, a1, "revoked");
      await setStatus(A, a2, "revoked");
      // Fire both reconciles concurrently — the adversarial interleave.
      await Promise.all([reconcileAssignment(a1, A), reconcileAssignment(a2, A)]);

      const g = await grantsFor(u, B);
      const orphanClaims = await withTenants([B], (c) =>
        c.query<{ n: number }>(`SELECT count(*)::int n FROM service_grant_claims WHERE assignment_id IN ($1,$2)`, [a1, a2]),
      );
      // Expected: grant gone AND no claims. A leak = grant present with zero claims (unreachable to revoke).
      if (g.length !== 0 || orphanClaims.rows[0].n !== 0) leaks++;
    }
    // Report the observed leak count in the failure message if any.
    expect(leaks, `${leaks}/${ITER} concurrent double-revokes left an orphaned grant (count-after-delete race)`).toBe(0);
  });

  // ── VECTOR 4a: composite-FK (0027) blocks re-linking an assignment to a FOREIGN provider's
  //    unit — the reconciler can never be handed a foreign subtree to fan. ──────────────────────
  it("V4a re-link to a foreign-provider unit is rejected by the composite FK (no foreign-subtree fan)", async () => {
    const s = await scenario("v4a");
    const B = s.targets[0];
    // A DIFFERENT provider F (same holding) owns its own unit + blob with a distinct user.
    const F = await createCompany("v4a-foreign-provider", [], H);
    const fUser = await createUser("v4a-foreign-user@x.test");
    await addMembership(F, fUser);
    await setBlob(F, {
      id: "root", name: "F", kind: "company",
      children: [{ id: "d-fin", name: "Fin", kind: "department", children: [{ id: "pf", name: "F", kind: "person", assigneeId: fUser }] }],
    });
    const fUnit = await createUnit(F, "d-fin", "Fin");

    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);

    // Attempt to re-point asg (provider A) at F's unit — DB must refuse (unit_id,provider) FK.
    await expect(
      withTenants([s.A], (c) => c.query(`UPDATE service_assignments SET unit_id=$2 WHERE id=$1`, [asg, fUnit])),
    ).rejects.toThrow(/foreign key|violates/i);

    // Re-reconcile: still only A's subtree materialized; F's user NEVER granted in B.
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(fUser, B)).toEqual([]);
    expect(await membershipFor(B, fUser)).toBeNull();
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);
  });

  // ── VECTOR 4b: re-link within the SAME provider that moves people out → their grants torn down;
  //    the newly-pointed unit's people granted. ─────────────────────────────────────────────────
  it("V4b re-link to a different same-provider unit tears down the old subtree and materializes the new one", async () => {
    const s = await scenario("v4b");
    const B = s.targets[0];
    // Add a second unit (d-eng) with a fresh user u-eng in the same provider blob.
    const uEng = await createUser("v4b-eng@x.test");
    await addMembership(s.A, uEng);
    await setBlob(s.A, {
      id: "root", name: "v4b", kind: "company",
      children: [
        { id: "d-hr", name: "HR", kind: "department", children: [
          { id: "r-lead", name: "Lead", kind: "role", children: [{ id: "p1", name: "U1", kind: "person", assigneeId: s.u1 }] },
          { id: "p2", name: "U2", kind: "person", assigneeId: s.u2 },
          { id: "p3", name: "U3", kind: "person", assigneeId: s.u3 },
        ] },
        { id: "d-eng", name: "Eng", kind: "department", children: [{ id: "pe", name: "E", kind: "person", assigneeId: uEng }] },
      ],
    });
    const engUnit = await createUnit(s.A, "d-eng", "Eng");
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: true }]);
    expect(await grantsFor(uEng, B)).toEqual([]);

    // Re-link asg from d-hr → d-eng (same provider, allowed by composite FK), then reconcile.
    await withTenants([s.A], (c) => c.query(`UPDATE service_assignments SET unit_id=$2 WHERE id=$1`, [asg, engUnit]));
    await reconcileAssignment(asg, s.A);

    // Old HR people torn down; the engineer now materialized.
    expect(await grantsFor(s.u1, B)).toEqual([]);
    expect(await grantsFor(s.u2, B)).toEqual([]);
    expect(await grantsFor(s.u3, B)).toEqual([]);
    expect(await membershipFor(B, s.u2)).toMatchObject({ status: "inactive", deleted: true });
    expect(await grantsFor(uEng, B)).toEqual([{ role: "hr_staff", managed: true }]);
  });

  // ── VECTOR 5: stale / replayed events. A revoked (and a suspended) assignment reconciled
  //    repeatedly must converge to EMPTY with no resurrection — even though the reconciler is
  //    driven by lifecycle events whose *type* (e.g. activated) is ignored in favour of the live
  //    DB status re-read. ────────────────────────────────────────────────────────────────────
  it("V5 replaying reconcile on a revoked/suspended assignment never resurrects grants", async () => {
    const s = await scenario("v5");
    const B = s.targets[0];
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);

    await setStatus(s.A, asg, "revoked");
    const r1 = await reconcileAssignment(asg, s.A);
    expect(r1?.revoked).toBe(3);
    expect(await grantsFor(s.u1, B)).toEqual([]);

    // Replay the SAME trigger several times (simulating an at-least-once outbox redelivery). The
    // DB status is 'revoked' so desired is empty regardless of the event type that fired.
    for (let i = 0; i < 3; i++) {
      const r = await reconcileAssignment(asg, s.A);
      expect(r?.granted).toBe(0);
      expect(r?.revoked).toBe(0);
    }
    expect(await grantsFor(s.u1, B)).toEqual([]);
    expect(await grantsFor(s.u2, B)).toEqual([]);
    expect(await grantsFor(s.u3, B)).toEqual([]);
    expect(await claimCount(asg, B)).toBe(0);
    // No membership resurrected.
    for (const u of [s.u1, s.u2, s.u3]) {
      const m = await membershipFor(B, u);
      if (m) expect(m).toMatchObject({ status: "inactive", deleted: true });
    }
  });

  // ── VECTOR 6: flag OFF ⇒ every entry point is a no-op even when the row is live and would
  //    otherwise materialize; already-materialized grants are left frozen (never torn down). ────
  it("V6 flag OFF is a hard no-op across reconcileAssignment/reconcileProvider/sweep", async () => {
    const s = await scenario("v6");
    const B = s.targets[0];
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    // Materialize WHILE ON, then flip OFF and prove nothing tears down or re-materializes.
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);

    config.serviceAssignmentsEnabled = false;
    try {
      expect(await reconcileAssignment(asg, s.A)).toBeNull();
      expect(await reconcileProvider(s.A)).toEqual([]);
      expect(await sweepDriftAndOrphans()).toEqual({ reconciled: 0, drift: 0, autoSuspended: 0 });
      // Existing grants untouched (frozen), and a brand-new revoke does NOT get applied while dark.
      await setStatus(s.A, asg, "revoked");
      expect(await reconcileAssignment(asg, s.A)).toBeNull();
      expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]); // still standing
    } finally {
      config.serviceAssignmentsEnabled = true;
    }
  });

  // ── VECTOR 7: session_version invalidation. Materialize bumps once/affected user; revoke bumps
  //    once more so cached principals cannot retain the torn-down access. ───────────────────────
  it("V7 revoke bumps session_version exactly once per affected user (cached-principal invalidation)", async () => {
    const s = await scenario("v7");
    const B = s.targets[0];
    const before = await sessionVersion(s.u1);
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });

    await reconcileAssignment(asg, s.A);
    const afterGrant = await sessionVersion(s.u1);
    expect(afterGrant).toBe(before + 1); // exactly one bump on grant

    // No-op pass: no bump.
    await reconcileAssignment(asg, s.A);
    expect(await sessionVersion(s.u1)).toBe(afterGrant);

    await setStatus(s.A, asg, "revoked");
    await reconcileAssignment(asg, s.A);
    expect(await sessionVersion(s.u1)).toBe(afterGrant + 1); // one bump on revoke → cache invalidated
  });
});
