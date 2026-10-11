// PV3-01 — the staff contract reads: `canCountersign` on every row, the strict `?clientId=` facet,
// and who may countersign. Drives the REAL routes (`GET /api/:t/contracts`, `GET .../:id`,
// `POST .../:id/countersign`) against real RLS and a live Cerbos.
//
// ── AUTHORIZATION BEFORE VALIDATION ─────────────────────────────────────────────────────────────
// Every denial below sends a request that is otherwise VALID (a real signer name, a well-formed
// query), so a 403 can only come from the authorization check. The countersign handler validates
// `signerName` before it authorizes; an empty body would 400 for everyone and the denial cases would
// silently stop testing authorization.
//
// The rule's own edges (global grant, low assurance, non-member) are pinned without a DB in
// src/rbac/contract-countersign-cerbos.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withGlobal } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const SIGN = { signerName: "Signer Name", signerTitle: "Director" };

type Row = { id: string; clientId: string; status: string; providerSigned: boolean; canCountersign: boolean };

describe.skipIf(!TEST_URL)("PV3-01 · contract reads: canCountersign + strict clientId (HTTP)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let otherCo: string;
  let admin: string; // company_admin @ tenant: drafts and sends, may NOT countersign
  let platformAdmin: string; // platform_admin @ global: the wildcard, may countersign
  let manager: string; // manager @ tenant: reads only
  let allKeys: string; // a custom role holding EVERY core.contract.* key @ tenant
  let owner: string; // `owner` @ tenant: the contract's company owner, may countersign
  let otherOwner: string; // member of tenant, but `owner` only of ANOTHER company
  let outsider: string; // member of tenant with no role: may not even read
  let clientA: string;
  let clientB: string;

  const get = (url: string, as: string) => app.inject({ method: "GET", url, headers: asUser(as) });
  const countersign = (id: string, as: string) =>
    app.inject({ method: "POST", url: `/api/${tenant}/contracts/${id}/countersign`, headers: asUser(as), payload: SIGN });

  async function draft(clientId: string, title: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/contracts`, headers: asUser(admin),
      payload: { clientId, title, bodyMd: "Terms." },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  async function sent(clientId: string, title: string): Promise<string> {
    const id = await draft(clientId, title);
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/contracts/${id}/send`, headers: asUser(admin) });
    expect(r.statusCode, r.body).toBe(200);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("PV301 Agency", ["agency", "clients"]);
    otherCo = await createCompany("PV301 Other", ["agency", "clients"]);

    admin = await createUser("admin@pv301.test");
    await addMembership(tenant, admin);
    await grantRole(admin, await createRole("company_admin"), "company", tenant);

    platformAdmin = await createUser("platform@pv301.test");
    await addMembership(tenant, platformAdmin);
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);

    manager = await createUser("manager@pv301.test");
    await addMembership(tenant, manager);
    await grantRole(manager, await createRole("manager"), "company", tenant);

    owner = await createUser("owner@pv301.test");
    await addMembership(tenant, owner);
    await grantRole(owner, await createRole("owner"), "company", tenant);

    otherOwner = await createUser("other-owner@pv301.test");
    await addMembership(tenant, otherOwner);
    await addMembership(otherCo, otherOwner);
    await grantRole(otherOwner, await createRole("owner"), "company", otherCo);

    outsider = await createUser("outsider@pv301.test");
    await addMembership(tenant, outsider);

    // A tenant-defined custom role holding every `core.contract.*` key the catalog has. No key for
    // countersign exists, and no permission-arm rule may ever reach it: this caller reads, drafts,
    // edits and sends, and still cannot countersign.
    allKeys = await createUser("all-keys@pv301.test");
    await addMembership(tenant, allKeys);
    const customRole = newId();
    await withGlobal(async (c) => {
      await c.query(`INSERT INTO roles (id, company_id, name) VALUES ($1, $2, 'pv301_contract_everything')`, [customRole, tenant]);
      const ins = await c.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE key LIKE 'core.contract.%'`,
        [customRole],
      );
      // Read, create, update, delete, send: the fixture is only meaningful if it holds them all.
      expect(ins.rowCount).toBeGreaterThanOrEqual(5);
    });
    await grantRole(allKeys, customRole, "company", tenant);

    // MON-00a: the permission arm is root-bounded (`variables.inRoot`), and rootCompanies comes from
    // home_company_id first. Anchor every tenant user on the tenant, the realistic shape.
    const pool = adminPool();
    for (const u of [admin, platformAdmin, manager, owner, otherOwner, outsider, allKeys]) {
      await pool.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [tenant, u]);
    }

    // Clients come from the fixture, not POST /clients: this suite is about contracts, and driving the
    // clients route would move the generated capability inventory's driver count for `clients`.
    clientA = await createClient(tenant, "PV301 Client A");
    clientB = await createClient(tenant, "PV301 Client B");
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("who may countersign a sent contract", () => {
    it("🔴 company_admin, manager, an all-core.contract.*-keys custom role and another company's owner all get 403", async () => {
      const id = await sent(clientA, "Deny matrix");
      for (const [who, as] of [["company_admin", admin], ["manager", manager], ["custom role, every core.contract.* key", allKeys], ["owner of another company", otherOwner]] as const) {
        const r = await countersign(id, as);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      }
      // Nothing was written by any of them.
      const d = (await get(`/api/${tenant}/contracts/${id}`, platformAdmin)).json();
      expect(d.providerSigned).toBe(false);
      expect(d.signatures).toEqual([]);
    });

    it("the owner of the contract's company countersigns (200), and the signature is theirs", async () => {
      const id = await sent(clientA, "Owner signs");
      const r = await countersign(id, owner);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, alreadySigned: false, complete: false });
      const d = (await get(`/api/${tenant}/contracts/${id}`, owner)).json();
      expect(d.providerSigned).toBe(true);
      expect(d.signatures).toEqual([expect.objectContaining({ party: "provider", signer: owner, signerName: SIGN.signerName })]);
    });

    it("platform_admin countersigns (200) and the provider signature is recorded", async () => {
      const id = await sent(clientA, "Platform signs");
      const r = await countersign(id, platformAdmin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, alreadySigned: false, complete: false });
      const d = (await get(`/api/${tenant}/contracts/${id}`, platformAdmin)).json();
      expect(d.providerSigned).toBe(true);
    });
  });

  describe("canCountersign", () => {
    it("is true for platform_admin on a sent, provider-unsigned contract, on the list AND the detail", async () => {
      const id = await sent(clientA, "Flag true");
      const list = (await get(`/api/${tenant}/contracts?clientId=${clientA}`, platformAdmin)).json() as Row[];
      expect(list.find((r) => r.id === id)?.canCountersign).toBe(true);
      const d = await get(`/api/${tenant}/contracts/${id}`, platformAdmin);
      expect(d.statusCode).toBe(200);
      expect(d.json().canCountersign).toBe(true);
    });

    it("is true for the company's owner, on the list AND the detail", async () => {
      const id = await sent(clientA, "Flag true for owner");
      const list = (await get(`/api/${tenant}/contracts?clientId=${clientA}`, owner)).json() as Row[];
      expect(list.find((r) => r.id === id)?.canCountersign).toBe(true);
      expect((await get(`/api/${tenant}/contracts/${id}`, owner)).json().canCountersign).toBe(true);
    });

    it("🔴 is false for company_admin on the same contract (list and detail): the flag follows Cerbos, not the read", async () => {
      const id = await sent(clientA, "Flag false for admin");
      const list = (await get(`/api/${tenant}/contracts?clientId=${clientA}`, admin)).json() as Row[];
      const row = list.find((r) => r.id === id);
      expect(row?.status).toBe("sent");
      expect(row?.canCountersign).toBe(false);
      expect((await get(`/api/${tenant}/contracts/${id}`, admin)).json().canCountersign).toBe(false);
    });

    it("🔴 is false on a draft, and false once the provider has signed, even for platform_admin", async () => {
      const draftId = await draft(clientA, "Flag false on draft");
      expect((await get(`/api/${tenant}/contracts/${draftId}`, platformAdmin)).json().canCountersign).toBe(false);

      const signedId = await sent(clientA, "Flag false after signing");
      expect((await countersign(signedId, platformAdmin)).statusCode).toBe(200);
      const d = (await get(`/api/${tenant}/contracts/${signedId}`, platformAdmin)).json();
      expect(d.status).toBe("sent"); // the client has not signed, so the contract is still `sent`
      expect(d.canCountersign).toBe(false);
    });

    it("every list row carries the field as a boolean", async () => {
      const rows = (await get(`/api/${tenant}/contracts`, admin)).json() as Row[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(typeof r.canCountersign).toBe("boolean");
    });
  });

  describe("GET /contracts?clientId=", () => {
    it("a uuid returns only that client's rows", async () => {
      const a = await draft(clientA, "Facet A");
      const b = await draft(clientB, "Facet B");
      const rows = (await get(`/api/${tenant}/contracts?clientId=${clientB}`, admin)).json() as Row[];
      expect(rows.map((r) => r.id)).toContain(b);
      expect(rows.map((r) => r.id)).not.toContain(a);
      expect(rows.every((r) => r.clientId === clientB)).toBe(true);
    });

    it("`internal` returns only clientless rows: none, since a contract always has a client (200, not 500)", async () => {
      await draft(clientA, "Facet internal");
      const r = await get(`/api/${tenant}/contracts?clientId=internal`, admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual([]);
    });

    it("🔴 garbage returns 400 (it used to reach a ::uuid cast and 500)", async () => {
      const r = await get(`/api/${tenant}/contracts?clientId=not-a-uuid`, admin);
      expect(r.statusCode, r.body).toBe(400);
    });

    it("🔴 authorization runs first: a caller who may not read gets 403 for the same garbage query", async () => {
      const r = await get(`/api/${tenant}/contracts?clientId=not-a-uuid`, outsider);
      expect(r.statusCode, r.body).toBe(403);
    });

    it("absent and `status` still behave as before", async () => {
      const d = await draft(clientA, "Facet status");
      const all = (await get(`/api/${tenant}/contracts`, admin)).json() as Row[];
      expect(all.map((r) => r.id)).toContain(d);
      const drafts = (await get(`/api/${tenant}/contracts?status=draft&clientId=${clientA}`, admin)).json() as Row[];
      expect(drafts.map((r) => r.id)).toContain(d);
      expect(drafts.every((r) => r.status === "draft" && r.clientId === clientA)).toBe(true);
    });
  });
});
