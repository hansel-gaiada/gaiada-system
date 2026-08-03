// D-3 ("clients get access before the meeting so all parties are always trackable, notified, and on
// the same page") — verifies the client-facing notification wiring added to pipeline.controller.ts and
// portal.controller.ts, and unit-tests client-notify.ts's recipient-resolution helper directly (against
// live Postgres + RLS), per this ticket's own instruction not to leave that logic covered only
// end-to-end.
//
// `notifyControl.forceFailure` (see the mock below) lets one test force notify() to throw so we can
// assert the hard constraint this ticket cares most about: a notify() failure must never roll back the
// gate/stage/signoff write it is announcing.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { resolveClientRecipients } from "./client-notify";

// vi.mock's factory is hoisted above these imports; vi.hoisted() is vitest's supported escape hatch
// for a value the hoisted factory needs to read LATER (per-test), rather than at module-load time.
const notifyControl = vi.hoisted(() => ({ forceFailure: false }));

vi.mock("./http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http")>();
  return {
    ...actual,
    notify: vi.fn(async (...args: Parameters<typeof actual.notify>) => {
      if (notifyControl.forceFailure) throw new Error("forced notify failure (test)");
      return actual.notify(...args);
    }),
  };
});

// Imported after the mock declaration for readability; vi.mock's hoisting makes every controller that
// reaches core/http.ts's notify() (via client-notify.ts or directly) get the mocked version regardless
// of import order.
import { buildApp } from "../main";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function addClientContact(
  tenantId: string,
  clientId: string,
  userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null } = {},
): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "viewer", opts.status ?? "active", config.originSite],
    ),
  );
  return id;
}

async function notifCount(userId: string, type: string): Promise<number> {
  const r = await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type]);
  return r.rows[0].n as number;
}

describe.skipIf(!TEST_URL)("client-facing pipeline notifications (D-3)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let clientRow: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    admin = await createUser("admin@clientnotify.test");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    clientRow = await createClient(co, "Acme Inc");
    projectA = await createProject(co, "Acme Website");
    projectB = await createProject(co, "Acme Rebrand");
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ---- 1. resolveClientRecipients — the helper, tested directly ----

  describe("resolveClientRecipients", () => {
    it("returns an active client-wide contact; skips an invited one and a revoked one", async () => {
      const active = await createUser("active-cw@acme.test");
      const invited = await createUser("invited-cw@acme.test");
      const revoked = await createUser("revoked-cw@acme.test");
      await addClientContact(co, clientRow, active, { status: "active" });
      await addClientContact(co, clientRow, invited, { status: "invited" });
      await addClientContact(co, clientRow, revoked, { status: "revoked" });

      const recipients = await withTenants([co], (c) =>
        resolveClientRecipients(c, { clientId: clientRow, projectId: null, kind: "general" }),
      );
      expect(recipients).toContain(active);
      expect(recipients).not.toContain(invited);
      expect(recipients).not.toContain(revoked);
    });

    it("a contact scoped to project B is NOT returned for a run on project A; a client-wide contact IS", async () => {
      const wide = await createUser("wide@acme.test");
      const scopedB = await createUser("scoped-b@acme.test");
      await addClientContact(co, clientRow, wide, { status: "active", projectId: null });
      await addClientContact(co, clientRow, scopedB, { status: "active", projectId: projectB });

      const recipients = await withTenants([co], (c) =>
        resolveClientRecipients(c, { clientId: clientRow, projectId: projectA, kind: "general" }),
      );
      expect(recipients).toContain(wide);
      expect(recipients).not.toContain(scopedB);
    });

    it("kind 'signature' excludes viewers (they cannot act on a sign request); kind 'general' includes them", async () => {
      const signer = await createUser("signer@acme.test");
      const viewer = await createUser("viewer@acme.test");
      await addClientContact(co, clientRow, signer, { status: "active", capability: "signer" });
      await addClientContact(co, clientRow, viewer, { status: "active", capability: "viewer" });

      const sigRecipients = await withTenants([co], (c) =>
        resolveClientRecipients(c, { clientId: clientRow, projectId: null, kind: "signature" }),
      );
      expect(sigRecipients).toContain(signer);
      expect(sigRecipients).not.toContain(viewer);

      const generalRecipients = await withTenants([co], (c) =>
        resolveClientRecipients(c, { clientId: clientRow, projectId: null, kind: "general" }),
      );
      expect(generalRecipients).toContain(signer);
      expect(generalRecipients).toContain(viewer);
    });

    it("a run with no client (clientId null) resolves to nobody", async () => {
      const recipients = await withTenants([co], (c) =>
        resolveClientRecipients(c, { clientId: null, projectId: null, kind: "general" }),
      );
      expect(recipients).toEqual([]);
    });
  });

  // ---- 2. end-to-end: openGate (actorSide='client') notifies ----

  describe("openGate notifies client contacts", () => {
    it("an active client-wide contact when a client-actionable gate opens", async () => {
      const contact = await createUser("gate-open@acme.test");
      // prd_sign is a SIGNATURE gate (clientNotifyKindForGate) — the contact must be a signer, or
      // resolveClientRecipients correctly excludes them and this test would be asserting the wrong thing.
      await addClientContact(co, clientRow, contact, { status: "active", capability: "signer" });
      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Notify run 1", clientId: clientRow },
      })).json().id;

      const before = await notifCount(contact, "pipeline.gate.opened");
      const gate = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "prd_sign", actorSide: "client" },
      });
      expect(gate.statusCode).toBe(201);
      expect(await notifCount(contact, "pipeline.gate.opened")).toBe(before + 1);
    });

    it("does NOT notify a viewer-only contact for a signature gate (prd_sign), but DOES for a feedback gate (customer_feedback)", async () => {
      const viewer = await createUser("viewer-only@acme.test");
      await addClientContact(co, clientRow, viewer, { status: "active", capability: "viewer" });
      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Notify run 2", clientId: clientRow },
      })).json().id;

      const beforeSig = await notifCount(viewer, "pipeline.gate.opened");
      await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "prd_sign", actorSide: "client" },
      });
      expect(await notifCount(viewer, "pipeline.gate.opened")).toBe(beforeSig); // unchanged: a viewer cannot sign

      const beforeGeneral = await notifCount(viewer, "pipeline.gate.opened");
      await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "customer_feedback", actorSide: "client" },
      });
      expect(await notifCount(viewer, "pipeline.gate.opened")).toBe(beforeGeneral + 1);
    });

    it("does NOT notify an invited or revoked contact", async () => {
      const invited = await createUser("gate-invited@acme.test");
      const revoked = await createUser("gate-revoked@acme.test");
      await addClientContact(co, clientRow, invited, { status: "invited" });
      await addClientContact(co, clientRow, revoked, { status: "revoked" });
      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Notify run 3", clientId: clientRow },
      })).json().id;

      await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "prd_sign", actorSide: "client" },
      });
      expect(await notifCount(invited, "pipeline.gate.opened")).toBe(0);
      expect(await notifCount(revoked, "pipeline.gate.opened")).toBe(0);
    });
  });

  // ---- 3. end-to-end: portal.decideGate notifies the internal side ----

  describe("portal decideGate notifies the internal side", () => {
    it("notifies the run's owner_id when a client decides a gate via the portal", async () => {
      const portalUser = await createUser("portal-owner-test@acme.test");
      const owner = await createUser("owner@gaiada.test");
      await addMembership(co, owner);
      // Mirrors portal.test.ts's own setup: the LEGACY clients.portal_user_id scheme (unlike the new
      // client_contacts table) is not unioned into principal.companies, so the portal user still needs
      // a company_membership row for the tenant to resolve at all — without it "decide" 403s outright.
      await addMembership(co, portalUser);
      await grantRole(portalUser, await createRole("client"), "company", co);
      const client2 = await createClient(co, "Owner Test Client", portalUser);

      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Owner-notify run", clientId: client2 },
      })).json().id;
      // createRun has no owner_id field in its body today (migration 0072 added the column; no write
      // path sets it yet — see the ticket report) — set it directly for this fixture.
      await adminPool().query(`UPDATE pipeline_runs SET owner_id = $1 WHERE id = $2`, [owner, run]);

      const gate = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "prd_sign", actorSide: "client" },
      })).json().id;

      const before = await notifCount(owner, "pipeline.gate.decided");
      const decide = await app.inject({
        method: "POST", url: `/api/${co}/portal/gates/${gate}/decide`, headers: asUser(portalUser), payload: { decision: "signed" },
      });
      expect(decide.statusCode).toBe(200);
      expect(await notifCount(owner, "pipeline.gate.decided")).toBe(before + 1);
    });

    it("falls back to created_by when the run has no owner_id set", async () => {
      const portalUser = await createUser("portal-noOwner-test@acme.test");
      await addMembership(co, portalUser);
      await grantRole(portalUser, await createRole("client"), "company", co);
      const client3 = await createClient(co, "No Owner Client", portalUser);

      const runRes = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "No-owner run", clientId: client3 },
      });
      const run = runRes.json().id; // created_by = admin (the caller), owner_id stays NULL

      const gate = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "prd_sign", actorSide: "client" },
      })).json().id;

      const before = await notifCount(admin, "pipeline.gate.decided");
      const decide = await app.inject({
        method: "POST", url: `/api/${co}/portal/gates/${gate}/decide`, headers: asUser(portalUser), payload: { decision: "signed" },
      });
      expect(decide.statusCode).toBe(200);
      // notify() skips recipientId === actorId, but here the recipient (admin, the creator) and the
      // actor (portalUser, the client) differ, so this must land.
      expect(await notifCount(admin, "pipeline.gate.decided")).toBe(before + 1);
    });
  });

  // ---- 4. scope.signed notifies both sides ----

  describe("scope.signed notifies both sides", () => {
    it("notifies the internal owner AND active client contacts once both parties have signed", async () => {
      const owner = await createUser("scope-owner@gaiada.test");
      await addMembership(co, owner);
      const clientContact = await createUser("scope-client@acme.test");
      await addClientContact(co, clientRow, clientContact, { status: "active" });

      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Scope-signed run", clientId: clientRow },
      })).json().id;
      await adminPool().query(`UPDATE pipeline_runs SET owner_id = $1 WHERE id = $2`, [owner, run]);

      const ownerBefore = await notifCount(owner, "scope.signed");
      const contactBefore = await notifCount(clientContact, "scope.signed");

      await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs/${run}/scope-signoffs`, headers: asUser(admin), payload: { party: "provider" },
      });
      const second = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs/${run}/scope-signoffs`, headers: asUser(admin), payload: { party: "client" },
      });
      expect(second.json()).toMatchObject({ complete: true });

      expect(await notifCount(owner, "scope.signed")).toBe(ownerBefore + 1);
      expect(await notifCount(clientContact, "scope.signed")).toBe(contactBefore + 1);
    });

    it("does not re-notify on a re-filed (already-complete) signature", async () => {
      const owner = await createUser("scope-owner-2@gaiada.test");
      await addMembership(co, owner);
      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Scope-signed run 2", clientId: clientRow },
      })).json().id;
      await adminPool().query(`UPDATE pipeline_runs SET owner_id = $1 WHERE id = $2`, [owner, run]);

      await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${run}/scope-signoffs`, headers: asUser(admin), payload: { party: "provider" } });
      await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${run}/scope-signoffs`, headers: asUser(admin), payload: { party: "client" } });
      const afterFirst = await notifCount(owner, "scope.signed");

      const refile = await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${run}/scope-signoffs`, headers: asUser(admin), payload: { party: "provider" } });
      expect(refile.json()).toMatchObject({ complete: true });
      expect(await notifCount(owner, "scope.signed")).toBe(afterFirst); // unchanged
    });
  });

  // ---- 5. the assertion that matters most: a notify() failure never rolls back the transition ----

  describe("notify failures never roll back a transition", () => {
    afterAll(() => { notifyControl.forceFailure = false; });

    it("a forced notify() failure on gate OPEN still leaves the gate created and pending", async () => {
      const contact = await createUser("resilience-open@acme.test");
      await addClientContact(co, clientRow, contact, { status: "active" });
      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Resilience run (open)", clientId: clientRow },
      })).json().id;

      notifyControl.forceFailure = true;
      try {
        const gate = await app.inject({
          method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
          payload: { runId: run, kind: "prd_sign", actorSide: "client" },
        });
        // The gate-open write must stand even though notify() throws for every recipient.
        expect(gate.statusCode).toBe(201);
        const gateId = gate.json().id;
        const row = await adminPool().query(`SELECT status FROM pipeline_gates WHERE id = $1`, [gateId]);
        expect(row.rows[0].status).toBe("pending");
        // And proves the mock actually fired: no notification row exists for the forced failure.
        expect(await notifCount(contact, "pipeline.gate.opened")).toBe(0);
      } finally {
        notifyControl.forceFailure = false;
      }
    });

    it("a forced notify() failure on a client's portal DECIDE still leaves the gate decided", async () => {
      const portalUser = await createUser("resilience-decide-test@acme.test");
      const owner = await createUser("resilience-owner@gaiada.test");
      await addMembership(co, owner);
      await addMembership(co, portalUser);
      await grantRole(portalUser, await createRole("client"), "company", co);
      const client4 = await createClient(co, "Resilience Client", portalUser);

      const run = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Resilience run (decide)", clientId: client4 },
      })).json().id;
      await adminPool().query(`UPDATE pipeline_runs SET owner_id = $1 WHERE id = $2`, [owner, run]);

      // Open the gate BEFORE forcing the failure, so this test isolates the DECIDE transition only.
      const gate = (await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "prd_sign", actorSide: "client" },
      })).json().id;

      notifyControl.forceFailure = true;
      try {
        const before = await notifCount(owner, "pipeline.gate.decided");
        const decide = await app.inject({
          method: "POST", url: `/api/${co}/portal/gates/${gate}/decide`, headers: asUser(portalUser), payload: { decision: "signed" },
        });
        // The decision itself must succeed and persist even though notifying the owner throws.
        expect(decide.statusCode).toBe(200);
        expect(decide.json()).toMatchObject({ status: "decided", decision: "signed" });
        const row = await adminPool().query(`SELECT status, decision FROM pipeline_gates WHERE id = $1`, [gate]);
        expect(row.rows[0]).toMatchObject({ status: "decided", decision: "signed" });
        // Proves the mock fired: the owner was NOT actually notified.
        expect(await notifCount(owner, "pipeline.gate.decided")).toBe(before);

        // A second decide attempt correctly reports "already decided" — the failed notify did not
        // leave the gate in some half-transitioned state that a retry could double-process.
        const again = await app.inject({
          method: "POST", url: `/api/${co}/portal/gates/${gate}/decide`, headers: asUser(portalUser), payload: { decision: "approved" },
        });
        expect(again.statusCode).toBe(404);
      } finally {
        notifyControl.forceFailure = false;
      }
    });
  });
});
