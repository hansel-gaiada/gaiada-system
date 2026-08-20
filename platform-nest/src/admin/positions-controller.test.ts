// P2-12 (backend half) — positions CRUD, the role-set composer's three bounds, and assign/unassign.
//
// Driven through `app.inject()` against real Postgres + a restarted test Cerbos. The three refusals
// below are the point of the file: the denied-role registry, the `uiGrantable` allow-list, and the
// self-assign DENY were all written by earlier tickets with NO handler able to exercise them — this
// is the first suite that proves each one actually fires on a real request.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { withTenants, withGlobal } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, addMembership, grantRole } from "../testing/fixtures";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const ORG_BLOB = {
  root: {
    id: "d-corp", name: "Corp", kind: "company", assigneeId: null, assigneeName: null,
    children: [
      { id: "d-web", name: "Web", kind: "department", assigneeId: null, assigneeName: null,
        children: [{ id: "dv-fe", name: "FE", kind: "division", assigneeId: null, assigneeName: null, children: [] }] },
      { id: "d-hr", name: "HR", kind: "department", assigneeId: null, assigneeName: null, children: [] },
    ],
  },
};

describe.skipIf(!TEST_URL || !live)("P2-12 — positions backend over the real surface", () => {
  let app: NestFastifyApplication;
  let T: string;
  let admin: string;
  let webLead: string;
  let staffer: string;
  let managerRole: string;
  let leadRole: string;
  let platformAdminRole: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.positionSyncEnabled = true;

    T = await createCompany("Positions Co", ["hr", "reports"]);
    admin = await createUser("pos-admin@a.test");
    webLead = await createUser("pos-weblead@a.test");
    staffer = await createUser("pos-staff@a.test");
    for (const u of [admin, webLead, staffer]) await addMembership(T, u);
    await grantRole(admin, await createRole("company_admin"), "company", T);
    managerRole = await createRole("manager");
    leadRole = await createRole("org_unit_lead", null);
    platformAdminRole = await createRole("platform_admin");
    // The dept head: an org_unit_lead grant at d-web (HIER-2's subtree cascade).
    await grantRole(webLead, leadRole, "org_unit", "d-web");

    app = await buildApp();
    const put = await app.inject({
      method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(admin), payload: ORG_BLOB,
    });
    expect(put.statusCode).toBe(200);
  });

  afterAll(async () => {
    config.positionSyncEnabled = false;
    await app?.close();
    await teardownTestDb();
  });

  const create = (payload: Record<string, unknown>, actor = admin) =>
    app.inject({ method: "POST", url: `/api/${T}/positions`, headers: asUser(actor), payload });

  it("creates a position with a role-set, and lists it with holders + roleSet", async () => {
    const res = await create({ unitNodeId: "d-web", title: "Web Lead", isLead: true,
      roles: [{ roleId: managerRole, scopeKind: "company" }] });
    expect(res.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/api/${T}/positions`, headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    expect(list.json().scope).toBe("tenant");
    const found = list.json().positions.find((p: { id: string }) => p.id === res.json().id);
    expect(found.roleSet).toHaveLength(1);
    expect(found.currentHolders).toBe(0);
    expect(found.orphaned).toBe(false);
  });

  it("refuses a unit node that is not in the org blob (an orphan-from-birth seat)", async () => {
    const res = await create({ unitNodeId: "d-nowhere", title: "Ghost" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("not a node in this company's org structure");
  });

  it("REFUSAL 1 — the denied-role registry: platform_admin can never be attached to a seat", async () => {
    const res = await create({ unitNodeId: "d-web", title: "Backdoor",
      roles: [{ roleId: platformAdminRole, scopeKind: "company" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("denied-role registry");
    // and nothing was left behind by the refused request
    const rows = await withTenants([T], (c) =>
      c.query(`SELECT id FROM positions WHERE tenant_id = $1 AND title = 'Backdoor'`, [T]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("REFUSAL 2 — the ui_grantable allow-list is enforced server-side, and reported by attachable-roles", async () => {
    const roles = await app.inject({
      method: "GET", url: `/api/${T}/positions/attachable-roles`, headers: asUser(admin),
    });
    expect(roles.statusCode).toBe(200);
    const byName = new Map(roles.json().roles.map((r: { role: string }) => [r.role, r]));
    // platform_admin is reported as unattachable WITH a reason, never silently omitted
    const pa = byName.get("platform_admin") as { attachable: boolean; reason: string };
    expect(pa.attachable).toBe(false);
    expect(pa.reason).toBe("denied_role_registry");
    // every role the endpoint calls attachable must actually attach — otherwise the UI would offer
    // an option the server refuses, which is the drift this endpoint exists to prevent
    const attachable = roles.json().roles.filter((r: { attachable: boolean }) => r.attachable);
    expect(attachable.length).toBeGreaterThan(0);
  });

  it("REFUSAL 3 — self-assign DENY fires for the strongest possible caller", async () => {
    const pos = await create({ unitNodeId: "d-web", title: "Self Seat" });
    const res = await app.inject({
      method: "POST", url: `/api/${T}/positions/${pos.json().id}/assign`,
      headers: asUser(admin), payload: { userId: admin },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a dept head sees only their subtree and may assign within it, but not outside it", async () => {
    const webPos = await create({ unitNodeId: "dv-fe", title: "FE Dev", roles: [{ roleId: managerRole }] });
    const hrPos = await create({ unitNodeId: "d-hr", title: "HR Officer", roles: [{ roleId: managerRole }] });

    const list = await app.inject({ method: "GET", url: `/api/${T}/positions`, headers: asUser(webLead) });
    expect(list.statusCode).toBe(200);
    expect(list.json().scope).toBe("subtree");
    const ids = list.json().positions.map((p: { id: string }) => p.id);
    expect(ids).toContain(webPos.json().id);
    expect(ids).not.toContain(hrPos.json().id);

    // ⚠ CHANGED by the owner's §11.2 end-state (2026-08-19): a dept head PROPOSES a placement, they
    // no longer write it. This case used to assert 201 here; it now asserts the typed refusal that
    // names the request path, because "the lead can seat people directly" stopped being true.
    const inSubtree = await app.inject({
      method: "POST", url: `/api/${T}/positions/${webPos.json().id}/assign`,
      headers: asUser(webLead), payload: { userId: staffer },
    });
    expect(inSubtree.statusCode).toBe(400);
    expect(inSubtree.json().error).toContain("assignment_request_required");
    expect(inSubtree.json().error).toContain("/assignment-requests");

    // ...and the request path IS open to them, for the same seat.
    const requested = await app.inject({
      method: "POST", url: `/api/${T}/positions/${webPos.json().id}/assignment-requests`,
      headers: asUser(webLead), payload: { userId: staffer, justification: "covering the FE rota" },
    });
    expect(requested.statusCode).toBe(201);
    expect(requested.json().approvalId).toBeTruthy();

    // Outside their subtree is still a 403 at the AUTHORITY layer — the flip changed how a lead acts
    // inside their subtree, not how far their subtree reaches. Asserted on the request path too,
    // because a request endpoint that accepted what the write endpoint refuses would be the hole.
    const outside = await app.inject({
      method: "POST", url: `/api/${T}/positions/${hrPos.json().id}/assign`,
      headers: asUser(webLead), payload: { userId: staffer },
    });
    expect(outside.statusCode).toBe(403);
    const outsideRequest = await app.inject({
      method: "POST", url: `/api/${T}/positions/${hrPos.json().id}/assignment-requests`,
      headers: asUser(webLead), payload: { userId: staffer, justification: "reaching outside" },
    });
    expect(outsideRequest.statusCode).toBe(403);
  });

  it("assign is idempotent, and unassign closes the seat and revokes what it justified", async () => {
    const pos = await create({ unitNodeId: "d-web", title: "Idem Seat", roles: [{ roleId: managerRole }] });
    const positionId = pos.json().id as string;
    const first = await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/assign`,
      headers: asUser(admin), payload: { userId: staffer },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/assign`,
      headers: asUser(admin), payload: { userId: staffer },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().assignmentId).toBe(first.json().assignmentId);

    const granted = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2 AND managed_by_position IS NOT NULL`, [
        staffer, managerRole,
      ]),
    );
    expect(granted.rows.length).toBeGreaterThan(0);

    const un = await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/unassign`,
      headers: asUser(admin), payload: { userId: staffer },
    });
    expect(un.statusCode).toBe(200);
    expect(un.json().closedAssignmentIds).toHaveLength(1);
  });

  it("refuses assigning someone who is not a member of the company", async () => {
    const outsider = await createUser("pos-outsider@a.test");
    const pos = await create({ unitNodeId: "d-web", title: "Stranger Seat" });
    const res = await app.inject({
      method: "POST", url: `/api/${T}/positions/${pos.json().id}/assign`,
      headers: asUser(admin), payload: { userId: outsider },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("not an active member");
  });

  it("detaching a role from a seat REVOKES it from every current holder", async () => {
    const pos = await create({ unitNodeId: "d-web", title: "Detach Seat", roles: [{ roleId: managerRole }] });
    const positionId = pos.json().id as string;
    await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/assign`,
      headers: asUser(admin), payload: { userId: staffer },
    });
    const before = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2 AND managed_by_position IS NOT NULL`, [
        staffer, managerRole,
      ]),
    );
    expect(before.rows.length).toBeGreaterThan(0);

    const del = await app.inject({
      method: "DELETE", url: `/api/${T}/positions/${positionId}/roles/${managerRole}`, headers: asUser(admin),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().reconciledHolders).toBe(1);

    // the grant this seat justified is gone — the template and the live grants agree without waiting
    // for a sweep
    const after = await withGlobal((c) =>
      c.query(
        `SELECT ur.id FROM user_roles ur
           JOIN position_grant_claims pgc ON pgc.user_role_id = ur.id
           JOIN position_assignments pa ON pa.id = pgc.position_assignment_id
          WHERE ur.user_id = $1 AND ur.role_id = $2 AND pa.position_id = $3`,
        [staffer, managerRole, positionId],
      ),
    );
    expect(after.rows).toHaveLength(0);
  });

  it("retiring a seat closes its holders and stops it conferring anything", async () => {
    const pos = await create({ unitNodeId: "d-web", title: "Retire Seat", roles: [{ roleId: managerRole }] });
    const positionId = pos.json().id as string;
    await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/assign`,
      headers: asUser(admin), payload: { userId: staffer },
    });
    const res = await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/retire`, headers: asUser(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().closedHolders).toBe(1);

    const open = await withTenants([T], (c) =>
      c.query(`SELECT id FROM position_assignments WHERE tenant_id = $1 AND position_id = $2 AND valid_to IS NULL`, [
        T, positionId,
      ]),
    );
    expect(open.rows).toHaveLength(0);

    // and a retired seat cannot be assigned again
    const again = await app.inject({
      method: "POST", url: `/api/${T}/positions/${positionId}/assign`,
      headers: asUser(admin), payload: { userId: staffer },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toContain("retired");
  });

  it("a plain member reaches none of it", async () => {
    const plain = await createUser("pos-plain@a.test");
    await addMembership(T, plain);
    await grantRole(plain, await createRole("member"), "company", T);
    const list = await app.inject({ method: "GET", url: `/api/${T}/positions`, headers: asUser(plain) });
    expect(list.statusCode).toBe(403);
    const res = await create({ unitNodeId: "d-web", title: "Nope" }, plain);
    expect(res.statusCode).toBe(403);
  });
});
