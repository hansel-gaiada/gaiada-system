// P2-09 — the expiry sweep. Design §3.4.
//
// The property under test is the one P2-08 could not promise on its own: a grant written with an
// expiry actually stops conferring access once that moment passes. Before this sweep existed,
// `expires_at` was decoration — `assemblePrincipal()` does not filter on it, so an "expired" grant
// resolved into the principal exactly like a permanent one. The first case below asserts that
// resolution difference directly (principal BEFORE the sweep still carries the role; AFTER it does
// not), because asserting only "the row was deleted" would not prove the thing anyone cares about.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, addMembership, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import { sweepExpiredGrants } from "./grant-expiry-sweep";

describe.skipIf(!TEST_URL)("P2-09 — the grant expiry sweep", () => {
  let T: string;
  let user: string;
  let viewerRole: string;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("Expiry Co", ["hr"]);
    user = await createUser("exp-user@a.test");
    await addMembership(T, user);
    viewerRole = await createRole("viewer");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  /** Grant, then move the expiry so the sweep has something due (or not) without waiting. */
  async function grantExpiring(roleId: string, offsetSql: string): Promise<void> {
    await grantRole(user, roleId, "company", T);
    await withGlobal((c) =>
      c.query(`UPDATE user_roles SET expires_at = now() ${offsetSql} WHERE user_id = $1 AND role_id = $2`, [
        user, roleId,
      ]),
    );
  }

  it("an EXPIRED grant is live until the sweep runs, and gone after it (the whole point)", async () => {
    await grantExpiring(viewerRole, "- interval '1 day'");

    const before = await assemblePrincipal(user, "high");
    expect(before!.roles.some((r) => r.role === "viewer")).toBe(true); // expiry alone changes nothing

    const result = await sweepExpiredGrants();
    expect(result.expired).toBeGreaterThan(0);
    expect(result.revoked).toBeGreaterThan(0);

    const after = await assemblePrincipal(user, "high");
    expect(after!.roles.some((r) => r.role === "viewer")).toBe(false);
  });

  it("cuts the session of every user it revoked (D11)", async () => {
    const managerRole = await createRole("manager");
    await grantExpiring(managerRole, "- interval '1 hour'");
    const before = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [user]),
    );
    const result = await sweepExpiredGrants();
    expect(result.usersBumped).toBe(1);
    const after = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [user]),
    );
    expect(after.rows[0].session_version).toBeGreaterThan(before.rows[0].session_version);
  });

  it("leaves a NOT-yet-expired grant and a permanent grant completely alone", async () => {
    const futureRole = await createRole("hr_staff");
    const permanentRole = await createRole("member");
    await grantExpiring(futureRole, "+ interval '30 days'");
    await grantRole(user, permanentRole, "company", T); // expires_at stays NULL

    const result = await sweepExpiredGrants();
    expect(result.revoked).toBe(0);

    const rows = await withGlobal((c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::uuid[])`,
        [user, [futureRole, permanentRole]],
      ),
    );
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it("files an audited role_grant.expired event in the owning tenant's outbox", async () => {
    const auditRole = await createRole("reports_staff");
    await grantExpiring(auditRole, "- interval '2 days'");
    await sweepExpiredGrants();
    const events = await withTenants([T], (c) =>
      c.query<{ event_type: string }>(
        `SELECT event_type FROM outbox_events WHERE tenant_id = $1 AND event_type = 'role_grant.expired'`,
        [T],
      ),
    );
    expect(events.rows.length).toBeGreaterThan(0);
  });

  it("REFUSES to touch a reconciler-managed grant even when it is expired", async () => {
    // A managed grant should never carry an expiry; if one does, that is a bug in some writer, and
    // deleting the row here would put the sweep in a fight with the reconciler that owns it.
    const managedRole = await createRole("search_staff");
    await grantExpiring(managedRole, "- interval '1 day'");
    // `managed_by_position` is a real FK into `position_assignments`, so the fake has to be a real
    // seat — a synthetic uuid is rejected by the constraint (which is itself the right behaviour).
    const assignmentId = await withTenants([T], async (c) => {
      const pos = await c.query<{ id: string }>(
        `INSERT INTO positions (tenant_id, unit_node_id, title) VALUES ($1,'d-x','Managed') RETURNING id`,
        [T],
      );
      const asg = await c.query<{ id: string }>(
        `INSERT INTO position_assignments (tenant_id, position_id, user_id) VALUES ($1,$2,$3) RETURNING id`,
        [T, pos.rows[0].id, user],
      );
      return asg.rows[0].id;
    });
    await withGlobal((c) =>
      c.query(`UPDATE user_roles SET managed_by_position = $3 WHERE user_id = $1 AND role_id = $2`, [
        user, managedRole, assignmentId,
      ]),
    );
    const result = await sweepExpiredGrants();
    expect(result.revoked).toBe(0);
    const still = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [user, managedRole]),
    );
    expect(still.rows).toHaveLength(1);
  });

  it("is idempotent: a second sweep finds nothing left to do", async () => {
    const r1 = await sweepExpiredGrants();
    const r2 = await sweepExpiredGrants();
    expect(r2.revoked).toBe(0);
    expect(r2.expired).toBe(r1.expired - r1.revoked); // only the untouchable managed rows remain due
  });
});
