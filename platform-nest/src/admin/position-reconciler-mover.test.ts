// P2-05 — THE BINDING ACCEPTANCE CRITERION: the mover.
//
// After a transfer: zero grants tagged to the closed assignment remain, a live authorization probe
// on an OLD-department resource DENIES, the NEW department ALLOWS, and `session_version` moved.
//
// ⚠ WHY THIS PROBES THE ENGINE AND NOT A ROLE BUNDLE. `role_permission_bundles.json` treats every
// derived-role CONDITION as satisfied — `org_unit_lead`'s entire meaning is its condition (does the
// grant's scopeId appear in the resource's `unitAncestors`?), so a bundle-based check reports
// "org_unit_lead can read_department" both before AND after the transfer and is structurally
// incapable of witnessing this criterion. The probe below therefore goes to the REAL Cerbos
// process over HTTP, through `check()` — the same client every controller uses — with the
// principal assembled by `assemblePrincipal()` from the `user_roles` rows THIS RECONCILER wrote.
// Reconciler → user_roles → assemblePrincipal → Cerbos. Nothing is hand-fed.
//
// ⚠ STALENESS: Cerbos does NOT hot-reload policy and a HEALTHY container can serve days-stale
// policy. `gaiada-test-cerbos` was restarted immediately before this suite was run
// (`docker restart gaiada-test-cerbos`; StartedAt 2026-08-14T04:50:53Z, /_cerbos/health -> 200).
// Skips without CERBOS_URL, same convention as cerbos-org-unit-lead-cascade.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "../db";
import { config } from "../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, addMembership } from "../testing/fixtures";
import { check, type Resource } from "../rbac/cerbos";
import { assemblePrincipal } from "../rbac/principal";
import { reconcileUser } from "./position-reconciler";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;

/** The platform's own mapping: a Cerbos DENY on a guarded route is a 403; an ALLOW proceeds (200).
 *  Expressed as a function so the assertions below read in the HTTP terms the criterion is
 *  written in, rather than in Cerbos effect strings. */
const httpStatus = (allowed: boolean): number => (allowed ? 200 : 403);

// Ancestor chains as `org_unit_closure` produces them: self-inclusive at depth 0, nearest-first.
const OLD_DEPT = ["dv-frontend", "d-web", "d-corp"]; // the department the mover LEAVES
const NEW_DEPT = ["dv-hr-ops", "d-hr", "d-corp"]; // the department the mover JOINS

describe.skipIf(!TEST_URL || !live)("P2-05 — the mover criterion, live against running Cerbos", () => {
  let T: string;
  let leadRole: string;
  let mover: string;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("Mover Tenant");
    leadRole = await createRole("org_unit_lead", null);
    mover = await createUser("mover@a.test");
    await addMembership(T, mover);
    config.positionSyncEnabled = true;
  });
  afterAll(async () => {
    config.positionSyncEnabled = false;
    await teardownTestDb();
  });

  const reportDoc = (unitAncestors: string[]): Resource => ({
    kind: "report_document",
    id: "doc-1",
    tenantId: T,
    module: "reports",
    unitAncestors,
  });

  /** Probe the LIVE engine with whatever the reconciler has actually materialized right now. */
  async function probe(unitAncestors: string[]): Promise<number> {
    const p = await assemblePrincipal(mover, "high");
    expect(p, "assemblePrincipal must resolve the mover").not.toBeNull();
    const decision = await check(p!, reportDoc(unitAncestors), "read_department");
    return httpStatus(decision.allow);
  }

  async function positionWithLead(unitNode: string, title: string): Promise<string> {
    const id = newId();
    await withTenants([T], async (c) => {
      await c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,$3,$4)`, [
        id,
        T,
        unitNode,
        title,
      ]);
      await c.query(
        `INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,'own_unit')`,
        [T, id, leadRole],
      );
    });
    return id;
  }

  async function assign(positionId: string): Promise<string> {
    const id = newId();
    await withTenants([T], (c) =>
      c.query(`INSERT INTO position_assignments (id, tenant_id, position_id, user_id) VALUES ($1,$2,$3,$4)`, [
        id,
        T,
        positionId,
        mover,
      ]),
    );
    return id;
  }

  it("a transfer moves authorization: OLD department 403, NEW department 200, closed assignment holds zero grants", async () => {
    // ── ACT 1: the mover leads d-web ──────────────────────────────────────────────────────────
    const oldPos = await positionWithLead("d-web", "Head of Web");
    const oldAssignment = await assign(oldPos);
    const built = await reconcileUser(T, mover);
    expect(built!.granted).toBe(1);

    const grantsBefore = (
      await withGlobal((c) =>
        c.query<{ scope_type: string; scope_id: string }>(
          `SELECT scope_type, scope_id FROM user_roles WHERE user_id = $1`,
          [mover],
        ),
      )
    ).rows;
    expect(grantsBefore).toEqual([{ scope_type: "org_unit", scope_id: "d-web" }]);

    // LIVE PROBE, pre-transfer.
    expect(await probe(OLD_DEPT), "leads d-web -> OLD department allows").toBe(200);
    expect(await probe(NEW_DEPT), "does not lead d-hr yet -> NEW department denies").toBe(403);

    const versionBefore = (
      await withGlobal((c) =>
        c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [mover]),
      )
    ).rows[0].session_version;

    // ── ACT 2: THE TRANSFER. Exactly what P2-06 will do: close the old seat, open the new one.
    await withTenants([T], (c) =>
      c.query(`UPDATE position_assignments SET valid_to = current_date WHERE id = $1`, [oldAssignment]),
    );
    const newPos = await positionWithLead("d-hr", "Head of HR");
    const newAssignment = await assign(newPos);

    const moved = await reconcileUser(T, mover);
    expect(moved!.granted, "the new department's lead grant is minted").toBe(1);
    expect(moved!.revoked, "the old department's lead grant is torn down").toBe(1);

    // ── CRITERION (a): zero grants tagged to the CLOSED assignment remain ─────────────────────
    const orphanClaims = (
      await withTenants([T], (c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM position_grant_claims WHERE position_assignment_id = $1`,
          [oldAssignment],
        ),
      )
    ).rows[0].n;
    expect(orphanClaims, "the closed assignment justifies nothing any more").toBe(0);

    const grantsAfter = (
      await withGlobal((c) =>
        c.query<{ scope_type: string; scope_id: string }>(
          `SELECT scope_type, scope_id FROM user_roles WHERE user_id = $1`,
          [mover],
        ),
      )
    ).rows;
    expect(grantsAfter, "exactly the new department, and nothing left of the old one").toEqual([
      { scope_type: "org_unit", scope_id: "d-hr" },
    ]);

    // ── CRITERION (b): the LIVE engine now decides the other way round ────────────────────────
    expect(await probe(OLD_DEPT), "OLD department must now be FORBIDDEN").toBe(403);
    expect(await probe(NEW_DEPT), "NEW department must now be ALLOWED").toBe(200);

    // ── CRITERION (c): session_version moved, so the revocation bites on the next write ───────
    const versionAfter = (
      await withGlobal((c) =>
        c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [mover]),
      )
    ).rows[0].session_version;
    expect(versionAfter).toBeGreaterThan(versionBefore);

    // and the new seat is properly claimed (so a later close of IT tears down cleanly too)
    const newClaims = (
      await withTenants([T], (c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM position_grant_claims WHERE position_assignment_id = $1`,
          [newAssignment],
        ),
      )
    ).rows[0].n;
    expect(newClaims).toBe(1);
  });
});
