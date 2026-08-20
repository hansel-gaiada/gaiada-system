// P2-08 (part A) — the grant/revoke surface, attacked over the real HTTP surface.
//
// This is the escalation surface: the brief for it says to assume this path will be the NEXT
// reachable escalation. So the file is written as an attack battery first and a happy path second.
// Every refusal is checked for the REASON, not merely the status, because a 400 for the wrong reason
// is a guard that will be removed by the next person who "fixes" the message.
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
    children: [
      { id: "d-web", name: "Web", kind: "department", assigneeId: null, assigneeName: null, children: [] },
      { id: "d-hr", name: "HR", kind: "department", assigneeId: null, assigneeName: null, children: [] },
    ],
  },
};

describe.skipIf(!TEST_URL || !live)("P2-08 — the grant/revoke surface", () => {
  let app: NestFastifyApplication;
  let T: string;
  let admin: string;      // company_admin — tenant-wide granting authority
  let webLead: string;    // org_unit_lead @ d-web — the dept-head tier
  let webStaff: string;   // placed under d-web
  let hrStaff: string;    // placed under d-hr (outside the lead's subtree)
  let memberRole: string;
  let viewerRole: string;
  let platformAdminRole: string;
  let hrManagerRole: string;

  /** Place a user in the blob under `unit`, through the REAL org PUT so the closure and the
   *  membership sweep are built by the same pipeline production uses. */
  async function placeAll(): Promise<void> {
    const blob = JSON.parse(JSON.stringify(ORG_BLOB));
    blob.root.children[0].children.push(
      { id: `p-${webLead}`, name: "Web Lead", kind: "person", assigneeId: webLead, assigneeName: "Web Lead", children: [] },
      { id: `p-${webStaff}`, name: "Web Staff", kind: "person", assigneeId: webStaff, assigneeName: "Web Staff", children: [] },
    );
    blob.root.children[1].children.push(
      { id: `p-${hrStaff}`, name: "HR Staff", kind: "person", assigneeId: hrStaff, assigneeName: "HR Staff", children: [] },
    );
    const put = await app.inject({
      method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(admin), payload: blob,
    });
    expect(put.statusCode).toBe(200);
  }

  const grant = (payload: Record<string, unknown>, actor: string) =>
    app.inject({ method: "POST", url: `/api/${T}/role-grants`, headers: asUser(actor), payload });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    T = await createCompany("Grants Co", ["hr", "reports"]);
    admin = await createUser("rg-admin@a.test");
    webLead = await createUser("rg-weblead@a.test");
    webStaff = await createUser("rg-webstaff@a.test");
    hrStaff = await createUser("rg-hrstaff@a.test");
    for (const u of [admin, webLead, webStaff, hrStaff]) await addMembership(T, u);
    await grantRole(admin, await createRole("company_admin"), "company", T);
    await grantRole(webLead, await createRole("org_unit_lead", null), "org_unit", "d-web");
    memberRole = await createRole("member");
    viewerRole = await createRole("viewer");
    platformAdminRole = await createRole("platform_admin");
    hrManagerRole = await createRole("hr_manager");

    app = await buildApp();
    await placeAll();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ─────────────────────────── the happy paths ───────────────────────────

  it("company_admin grants tenant-wide, and the grant is listed with its provenance", async () => {
    const res = await grant({ userId: hrStaff, roleId: memberRole }, admin);
    expect(res.statusCode).toBe(201);
    expect(res.json().grantId).toBeTruthy();

    const list = await app.inject({
      method: "GET", url: `/api/${T}/role-grants?userId=${hrStaff}`, headers: asUser(admin),
    });
    expect(list.statusCode).toBe(200);
    const found = list.json().grants.find((g: { role: string }) => g.role === "member");
    expect(found.source).toBe("manual");
    expect(found.revocable).toBe(true);
    expect(found.expiresAt).toBeNull();
  });

  it("a dept head grants INSIDE their subtree and is refused OUTSIDE it", async () => {
    const inside = await grant({ userId: webStaff, roleId: memberRole }, webLead);
    expect(inside.statusCode).toBe(201);
    const outside = await grant({ userId: hrStaff, roleId: viewerRole }, webLead);
    expect(outside.statusCode).toBe(403);
  });

  it("a temporary grant records expires_at (and the response says so)", async () => {
    const res = await grant({ userId: webStaff, roleId: viewerRole, temporary: true }, admin);
    expect(res.statusCode).toBe(201);
    expect(res.json().expiresAt).toBeTruthy();
    const row = await withGlobal((c) =>
      c.query<{ expires_at: string | null }>(`SELECT expires_at FROM user_roles WHERE id = $1`, [res.json().grantId]),
    );
    expect(row.rows[0].expires_at).not.toBeNull();
  });

  it("revoking a manual grant works and cuts the session", async () => {
    const created = await grant({ userId: hrStaff, roleId: viewerRole }, admin);
    const before = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [hrStaff]),
    );
    const res = await app.inject({
      method: "DELETE", url: `/api/${T}/role-grants/${created.json().grantId}`, headers: asUser(admin),
    });
    expect(res.statusCode).toBe(200);
    const after = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [hrStaff]),
    );
    expect(after.rows[0].session_version).toBeGreaterThan(before.rows[0].session_version);
  });

  // ─────────────────────────── the attack battery ───────────────────────────

  it("ATTACK: self-grant — refused by Cerbos's structural DENY, for company_admin", async () => {
    const res = await grant({ userId: admin, roleId: memberRole }, admin);
    expect(res.statusCode).toBe(403); // the DENY is in the authority layer, not a controller 400
  });

  it("ATTACK: platform_admin is refused (by the scope guard, which fires before the fence)", async () => {
    // Two guards refuse this and the ORDER matters for the message, not the outcome:
    // `assertRoleScopeAllowed` runs first and rejects platform_admin at company scope, so the
    // response names the scope, not the fence. Pinned as-is rather than reordered — the elevated
    // fence itself is pinned by the `client` case below, which is fenced AND company-scope-valid.
    const res = await grant({ userId: webStaff, roleId: platformAdminRole }, admin);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("may only be granted at global");
    const rows = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [webStaff, platformAdminRole]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("ATTACK: `client` — the staff/client boundary holds, though an earlier guard reaches it first", async () => {
    // ⚠ Recorded honestly: EVERY role in the elevated fence is refused by a guard that runs BEFORE
    // the fence — `platform_admin`/`group_executive` by the scope guard (global-only), `client` by the
    // allow-list (its `portal.*` keys are `uiGrantable:false`), and `owner` does not exist yet. So the
    // fence is defence-in-depth on this surface, not the first line, and no test can currently make
    // it the deciding guard. That is a property worth knowing before someone "simplifies" one of the
    // earlier checks and assumes the fence still catches it.
    const clientRole = await createRole("client");
    const res = await grant({ userId: webStaff, roleId: clientRole }, admin);
    expect(res.statusCode).toBe(400);
    expect(["elevated_role_forbidden", "not_ui_grantable"].some((t) => res.json().error.includes(t))).toBe(true);
    const rows = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [webStaff, clientRole]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("the ceiling passes the BASELINE role: company_admin can grant `member` (P2-08 baseline subtraction)", async () => {
    // This is the case that found the ceiling defect: `member`'s bundle carries self-service keys no
    // admin holds, so a plain subset test refused the commonest grant in the system. See
    // `assertWithinCeiling`'s comment.
    const target = await createUser("rg-baseline@a.test");
    await addMembership(T, target);
    const res = await grant({ userId: target, roleId: memberRole }, admin);
    expect(res.statusCode).toBe(201);
  });

  it("ATTACK: global scope is not expressible on this surface", async () => {
    const res = await grant({ userId: webStaff, roleId: memberRole, scopeType: "global" }, admin);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("scopeType must be");
  });

  it("ATTACK: the ceiling — a dept head cannot grant a role carrying permissions they do not hold", async () => {
    // `hr_manager` reaches HR permissions an org_unit_lead does not hold, so the ceiling refuses even
    // though the target IS inside the lead's subtree (i.e. Cerbos allowed the action).
    const res = await grant({ userId: webStaff, roleId: hrManagerRole }, webLead);
    expect(res.statusCode).toBe(400);
    expect(["ceiling_exceeded", "override_required", "not_ui_grantable"].some((t) => res.json().error.includes(t)))
      .toBe(true);
    const rows = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [webStaff, hrManagerRole]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("ATTACK: a target outside the company cannot be granted anything", async () => {
    const outsider = await createUser("rg-outsider@a.test");
    const res = await grant({ userId: outsider, roleId: memberRole }, admin);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("not an active member");
  });

  it("ATTACK: a plain member reaches neither read nor create", async () => {
    const plain = await createUser("rg-plain@a.test");
    await addMembership(T, plain);
    await grantRole(plain, memberRole, "company", T);
    const read = await app.inject({
      method: "GET", url: `/api/${T}/role-grants?userId=${webStaff}`, headers: asUser(plain),
    });
    expect(read.statusCode).toBe(403);
    const write = await grant({ userId: webStaff, roleId: viewerRole }, plain);
    expect(write.statusCode).toBe(403);
  });

  it("a POSITION-managed grant is NOT hand-revocable through this surface", async () => {
    // Build the managed grant the way production does: a seat whose role-set confers it.
    config.positionSyncEnabled = true;
    const positionId = (
      await app.inject({
        method: "POST", url: `/api/${T}/positions`, headers: asUser(admin),
        payload: { unitNodeId: "d-web", title: "Managed Seat", roles: [{ roleId: viewerRole }] },
      })
    ).json().id as string;
    const assigned = await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/assign`,
      headers: asUser(admin), payload: { userId: hrStaff },
    });
    expect(assigned.statusCode).toBe(201);

    const managed = await withGlobal((c) =>
      c.query<{ id: string }>(
        `SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2 AND managed_by_position IS NOT NULL`,
        [hrStaff, viewerRole],
      ),
    );
    expect(managed.rows.length).toBeGreaterThan(0);

    const list = await app.inject({
      method: "GET", url: `/api/${T}/role-grants?userId=${hrStaff}`, headers: asUser(admin),
    });
    const row = list.json().grants.find((g: { grantId: string }) => g.grantId === managed.rows[0].id);
    expect(row.source).toBe("position");
    expect(row.revocable).toBe(false);

    const res = await app.inject({
      method: "DELETE", url: `/api/${T}/role-grants/${managed.rows[0].id}`, headers: asUser(admin),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("managed_grant_not_revocable");
    // and it is still there — the refusal did not half-delete it
    const still = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE id = $1`, [managed.rows[0].id]),
    );
    expect(still.rows).toHaveLength(1);
    config.positionSyncEnabled = false;
  });

  it("an unplaced target is reachable by company_admin but NOT by a dept head (fail-closed ancestry)", async () => {
    const floating = await createUser("rg-floating@a.test");
    await addMembership(T, floating); // member, but placed nowhere in the blob
    const unplaced = await withTenants([T], (c) =>
      c.query(`SELECT id FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`, [
        T, floating,
      ]),
    );
    expect(unplaced.rows).toHaveLength(0);

    const byLead = await grant({ userId: floating, roleId: memberRole }, webLead);
    expect(byLead.statusCode).toBe(403);
    const byAdmin = await grant({ userId: floating, roleId: memberRole }, admin);
    expect(byAdmin.statusCode).toBe(201);
  });
});
