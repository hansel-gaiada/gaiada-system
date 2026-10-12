// WSK-49f, owner ruling 2026-10-11: the client-contact capability `admin` IMPLIES SIGNER. The capability column
// is single-valued, so without this, promoting a signer to admin would silently strip their ability to sign.
// Every place that tests for a signer must accept an admin; a viewer still cannot sign.
//
// Sites covered (each asserted below): portal-scope `canSign` (contract signing, gate decisions, the portal
// `canSign`/`viewOnly` flags), client-notify's signature recipients (and the real gate-open notification), and
// portal-centre's `canEditCentre`. Plus the staff admin endpoints' new semantics: promoting a signer needs no
// confirmation, and removing admin takes an explicit `{to}` (default viewer).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { FIXTURE_TERMS, FIXTURE_TERMS_SHA256 } from "../testing/contract-fixtures";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { resolveClientRecipients } from "./client-notify";
import { canEditCentre } from "./portal-centre.controller";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("WSK-49f: admin implies signer", () => {
  let app: NestFastifyApplication;
  let co: string;
  let staff: string;
  let clientA: string;
  let signer: string;
  let adminU: string;
  let viewer: string;
  let promoted: string; // starts as a signer, is promoted over HTTP
  const cid: Record<string, string> = {};

  const addContact = async (email: string, capability: string) => {
    const u = await createUser(email);
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,'active',$6)`,
        [id, co, clientA, u, capability, config.originSite],
      ),
    );
    await grantRole(u, await createRole("client"), "company", co);
    cid[email] = id;
    return u;
  };
  const newContract = async () => {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO contracts (id, tenant_id, client_id, title, status, currency, sent_at, body_md, content_sha256,
                                content_fixed_at, signature_tier, created_by, origin_site)
         VALUES ($1,$2,$3,'MSA','sent','IDR',now(),$6,$7,now(),'attested',$4,$5)`,
        [id, co, clientA, staff, config.originSite, FIXTURE_TERMS, FIXTURE_TERMS_SHA256],
      ),
    );
    return id;
  };
  const sign = (contractId: string, who: string) =>
    app.inject({
      method: "POST", url: `/api/${co}/portal/contracts/${contractId}/sign`, headers: asUser(who),
      payload: { signerName: "Some Signer", agree: true, contentSha256: FIXTURE_TERMS_SHA256 },
    });
  const openGate = async () => {
    const run = (await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(staff), payload: { title: "Run", clientId: clientA } })).json().id;
    const g = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(staff), payload: { runId: run, kind: "prd_sign", actorSide: "client" } });
    return g.json().id as string;
  };
  const decide = (gateId: string, who: string) =>
    app.inject({ method: "POST", url: `/api/${co}/portal/gates/${gateId}/decide`, headers: asUser(who), payload: { decision: "signed" } });
  const notifCount = async (userId: string, type: string) =>
    (await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rows[0].n as number;
  const capabilityOf = async (email: string) =>
    (await adminPool().query(`SELECT capability FROM client_contacts WHERE id = $1`, [cid[email]])).rows[0].capability as string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    staff = await createUser("staff@w49f-sign.test");
    await addMembership(co, staff);
    await grantRole(staff, await createRole("company_admin"), "company", co);
    clientA = await createClient(co, "Acme Inc");
    signer = await addContact("signer@w49f-sign.test", "signer");
    adminU = await addContact("admin@w49f-sign.test", "admin");
    viewer = await addContact("viewer@w49f-sign.test", "viewer");
    promoted = await addContact("promoted@w49f-sign.test", "signer");
    app = await buildApp();
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("contract signing", () => {
    it("an ADMIN can sign a contract exactly where a signer can; a VIEWER still cannot", async () => {
      const k1 = await newContract();
      const k2 = await newContract();
      const k3 = await newContract();
      const v = await sign(k1, viewer);
      expect(v.statusCode).toBe(403);
      expect(JSON.stringify(v.json())).toMatch(/view-only/i);
      const a = await sign(k1, adminU);
      expect(a.statusCode).toBe(200);
      expect(a.json()).toMatchObject({ alreadySigned: false });
      const s = await sign(k2, signer); // positive control: the signer on another contract
      expect(s.statusCode).toBe(200);
      const v2 = await sign(k3, viewer);
      expect(v2.statusCode).toBe(403);
    });

    it("the portal's own canSign / viewOnly flags agree for an admin, and for a viewer", async () => {
      const k = await newContract();
      const a = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${k}`, headers: asUser(adminU) });
      expect(a.json()).toMatchObject({ canSign: true, viewOnly: false });
      const v = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${k}`, headers: asUser(viewer) });
      expect(v.json()).toMatchObject({ canSign: false, viewOnly: true });
      const p = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(adminU) });
      expect(p.json().access).toMatchObject({ canSign: true });
    });
  });

  describe("gate decisions", () => {
    it("an ADMIN decides a signature gate; a VIEWER is refused (403) on the same kind of gate; a signer still can", async () => {
      const g1 = await openGate();
      const g2 = await openGate();
      const g3 = await openGate();
      expect((await decide(g1, viewer)).statusCode).toBe(403);
      expect((await decide(g1, adminU)).statusCode).toBe(200);
      expect((await decide(g2, signer)).statusCode).toBe(200);
      expect((await decide(g3, viewer)).statusCode).toBe(403);
    });
  });

  describe("signature notifications", () => {
    it("resolveClientRecipients(signature) includes the admin and the signer, excludes the viewer; general includes all", async () => {
      const sig = await withTenants([co], (c) => resolveClientRecipients(c, { clientId: clientA, projectId: null, kind: "signature" }));
      expect(sig).toEqual(expect.arrayContaining([adminU, signer]));
      expect(sig).not.toContain(viewer);
      const gen = await withTenants([co], (c) => resolveClientRecipients(c, { clientId: clientA, projectId: null, kind: "general" }));
      expect(gen).toEqual(expect.arrayContaining([adminU, signer, viewer]));
    });

    it("opening a signature gate really notifies the admin and not the viewer", async () => {
      const [a0, v0] = [await notifCount(adminU, "pipeline.gate.opened"), await notifCount(viewer, "pipeline.gate.opened")];
      await openGate();
      expect(await notifCount(adminU, "pipeline.gate.opened")).toBe(a0 + 1);
      expect(await notifCount(viewer, "pipeline.gate.opened")).toBe(v0);
    });
  });

  describe("Client Centre editing (canEditCentre)", () => {
    it("an active client-wide admin may edit, like a signer; a viewer may not", async () => {
      const can = (u: string) => withTenants([co], (c) => canEditCentre(c, u, clientA));
      expect(await can(adminU)).toBe(true);
      expect(await can(signer)).toBe(true);
      expect(await can(viewer)).toBe(false);
    });
  });

  describe("staff admin endpoints: promoting and removing", () => {
    const put = (email: string, payload?: object) =>
      app.inject({ method: "PUT", url: `/api/${co}/clients/${clientA}/contacts/${cid[email]}/admin`, headers: asUser(staff), ...(payload ? { payload } : {}) });
    const del = (email: string, payload?: object) =>
      app.inject({ method: "DELETE", url: `/api/${co}/clients/${clientA}/contacts/${cid[email]}/admin`, headers: asUser(staff), ...(payload ? { payload } : {}) });

    it("promoting a SIGNER to admin needs no confirmation (no 409) and they KEEP signing", async () => {
      const r = await put("promoted@w49f-sign.test");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ capability: "admin", changed: true });
      expect(await capabilityOf("promoted@w49f-sign.test")).toBe("admin");
      const audit = await adminPool().query(
        `SELECT metadata FROM activities WHERE target_entity_id = $1 AND verb = 'client_contact.admin_granted'`, [cid["promoted@w49f-sign.test"]],
      );
      expect(audit.rows[0].metadata).toMatchObject({ previousCapability: "signer" });
      expect((await sign(await newContract(), promoted)).statusCode).toBe(200);
    });

    it("removing admin with the DEFAULT gives viewer (least privilege): they can no longer sign", async () => {
      const r = await del("promoted@w49f-sign.test");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ capability: "viewer", changed: true });
      expect(await capabilityOf("promoted@w49f-sign.test")).toBe("viewer");
      expect((await sign(await newContract(), promoted)).statusCode).toBe(403);
    });

    it("removing admin with { to: 'signer' } restores signer and signing", async () => {
      await put("promoted@w49f-sign.test");
      const r = await del("promoted@w49f-sign.test", { to: "signer" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ capability: "signer", changed: true });
      expect(await capabilityOf("promoted@w49f-sign.test")).toBe("signer");
      expect((await sign(await newContract(), promoted)).statusCode).toBe(200);
      const audit = await adminPool().query(
        `SELECT metadata FROM activities WHERE target_entity_id = $1 AND verb = 'client_contact.admin_revoked' ORDER BY occurred_at DESC LIMIT 1`, [cid["promoted@w49f-sign.test"]],
      );
      expect(audit.rows[0].metadata).toMatchObject({ restoredCapability: "signer" });
    });

    it("an invalid target is a 400 and changes nothing; removing from a non-admin is a no-op that reports the real capability", async () => {
      await put("promoted@w49f-sign.test");
      const bad = await del("promoted@w49f-sign.test", { to: "admin" });
      expect(bad.statusCode).toBe(400);
      expect(await capabilityOf("promoted@w49f-sign.test")).toBe("admin");
      await del("promoted@w49f-sign.test", { to: "signer" });
      const noop = await del("promoted@w49f-sign.test", { to: "viewer" });
      expect(noop.json()).toMatchObject({ changed: false, capability: "signer" });
      expect(await capabilityOf("promoted@w49f-sign.test")).toBe("signer");
    });
  });
});
