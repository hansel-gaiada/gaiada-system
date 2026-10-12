// PV3-04 — real-DB + live-Cerbos proofs for the two new client write fields.
//   * `businessType` (PV-D1): required on create, written as the client's Client Centre profile row in
//     the SAME transaction; PATCH changes it, emits `client.centre_updated`, and History records it.
//   * `groupCompanyId` (PV-D2, PV3-Q1): a client may BE one of our own companies. Setting or changing it
//     needs a platform operator (platform_admin, or the owner of the ROOT), checked BEFORE the target is
//     validated; the target must be live and share the client tenant's root (`companies` is global with
//     no RLS, so the FK alone proves nothing about that).
//
// HOW THIS FILE BITES (each break was applied and watched fail; see the hand-back):
//   * drop the same-root condition in group-company.ts                 -> the "another group" case fails;
//   * drop `required: true` in the create path of the controller       -> the 400 cases fail;
//   * drop assertMayTouchGroupCompany from PATCH                       -> every "403 and unchanged" case fails;
//   * move the operator check below the target validation              -> the "403 before 400" cases fail.
//
// Needs DATABASE_URL_TEST + a live Cerbos (skips silently otherwise: check the skip count).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { withGlobal, withTenants } from "../../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const RANDOM_UUID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

describe.skipIf(!TEST_URL)("PV3-04 · client business type + group-company link", () => {
  let app: NestFastifyApplication;
  let root: string;       // the group's root company
  let co: string;         // the tenant the clients live in (a child of root)
  let sibling: string;    // another company under the SAME root
  let sibling2: string;   // a second one, to move a link between companies
  let retired: string;    // a same-root sibling that has been soft-deleted
  let foreignRoot: string;       // a company of ANOTHER group
  let member: string;
  let viewer: string;
  let companyAdmin: string;
  let childOwner: string;  // owns `co` only, not the root: NOT an operator
  let rootOwner: string;   // owner of the root: an operator
  let platformAdmin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    root = await createCompany("PV304 Root Holding");
    co = await createCompany("PV304 Agency", ["clients"], root);
    sibling = await createCompany("PV304 Sibling", [], root);
    sibling2 = await createCompany("PV304 Sibling Two", [], root);
    retired = await createCompany("PV304 Retired", [], root);
    foreignRoot = await createCompany("PV304 Foreign Root");
    await withGlobal((c) => c.query(`UPDATE companies SET deleted_at = now() WHERE id = $1`, [retired]));

    member = await createUser("pv304-member@a.test");
    viewer = await createUser("pv304-viewer@a.test");
    companyAdmin = await createUser("pv304-cadmin@a.test");
    childOwner = await createUser("pv304-child-owner@a.test");
    rootOwner = await createUser("pv304-root-owner@a.test");
    platformAdmin = await createUser("pv304-padmin@a.test");
    for (const u of [member, viewer, companyAdmin, childOwner, rootOwner, platformAdmin]) await addMembership(co, u);
    await addMembership(root, rootOwner);

    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    await grantRole(companyAdmin, await createRole("company_admin"), "company", co);
    const ownerRole = await createRole("owner");
    await grantRole(childOwner, ownerRole, "company", co);
    // The root owner: an owner grant on the ROOT (what isPlatformOperator checks) and on the tenant (what
    // lets Cerbos authorise the client write there), anchored through home_company_id on the root.
    await grantRole(rootOwner, ownerRole, "company", root);
    await grantRole(rootOwner, ownerRole, "company", co);
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);
    await withGlobal(async (c) => {
      await c.query(`UPDATE users SET home_company_id = $1 WHERE id = ANY($2::uuid[])`, [
        root, [rootOwner, platformAdmin, member, viewer, companyAdmin],
      ]);
      await c.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, childOwner]);
    });

    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  const post = (who: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${co}/clients`, headers: asUser(who), payload });
  const patch = (who: string, id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/${co}/clients/${id}`, headers: asUser(who), payload });
  const get = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/${co}/clients/${id}`, headers: asUser(member) })).json();
  const history = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/${co}/clients/${id}/history`, headers: asUser(member) })).json() as Array<{
      verb: string; metadata: { changes?: { field: string; before: string | null; after: string | null }[] };
    }>;
  const changesOf = async (id: string) => (await history(id)).flatMap((h) => h.metadata.changes ?? []);
  const profileRow = async (id: string) =>
    (await withTenants([co], (c) =>
      c.query<{ business_type: string; revision: number }>(
        `SELECT business_type, revision FROM client_centre_profiles WHERE client_id = $1`, [id],
      ))).rows[0];
  const dbGroup = async (id: string) =>
    (await withTenants([co], (c) => c.query<{ g: string | null }>(`SELECT group_company_id AS g FROM clients WHERE id = $1`, [id]))).rows[0].g;
  const countByName = async (name: string) =>
    Number((await withTenants([co], (c) => c.query<{ n: string }>(`SELECT count(*)::text n FROM clients WHERE name = $1`, [name]))).rows[0].n);
  const eventCount = async (id: string, type: string) =>
    Number((await withTenants([co], (c) =>
      c.query<{ n: string }>(`SELECT count(*)::text n FROM outbox_events WHERE entity_id = $1 AND event_type = $2`, [id, type]))).rows[0].n);

  // ── business type: create ──────────────────────────────────────────────────────────────────────
  it("a create WITHOUT businessType is a 400 business_type_required, and no client is written", async () => {
    const r = await post(member, { name: "No Type Ltd" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "business_type_required", field: "businessType" });
    expect(await countByName("No Type Ltd")).toBe(0);
  });

  it("a blank or non-registry businessType is a 400 business_type_invalid / required", async () => {
    const bad = await post(member, { name: "Bad Type Ltd", businessType: "pirate-ship" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "business_type_invalid" });
    const blank = await post(member, { name: "Blank Type Ltd", businessType: "" });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ error: "business_type_required" });
    expect(await countByName("Bad Type Ltd")).toBe(0);
    expect(await countByName("Blank Type Ltd")).toBe(0);
  });

  it("a create WITH a type writes the client AND a profile row of that type, revision 1, in one go", async () => {
    const r = await post(member, { name: "Typed Hotel", businessType: "hotel", contact: { email: "x@typed.test" } });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    expect(await profileRow(id)).toEqual({ business_type: "hotel", revision: 1 });
    // The Client Centre read agrees, so the list/hub/portal never see "other" for it.
    const centre = await app.inject({ method: "GET", url: `/api/${co}/clients/${id}/centre`, headers: asUser(member) });
    expect(centre.json()).toMatchObject({ businessType: "hotel", revision: 1 });
    // The outbox event carries the type (additive).
    const ev = await withTenants([co], (c) =>
      c.query<{ payload: { businessType?: string } }>(`SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'client.created'`, [id]));
    expect(ev.rows[0].payload.businessType).toBe("hotel");
    expect(await get(id)).toMatchObject({ name: "Typed Hotel", groupCompany: null });
  });

  it("'other' is a valid EXPLICIT choice on create", async () => {
    const r = await post(member, { name: "Explicit Other", businessType: "other" });
    expect(r.statusCode).toBe(201);
    expect(await profileRow(r.json().id)).toEqual({ business_type: "other", revision: 1 });
  });

  it("authorization comes first: a viewer sending no type gets 403, not 400", async () => {
    const r = await post(viewer, { name: "Nope Ltd" });
    expect(r.statusCode).toBe(403);
    expect(await countByName("Nope Ltd")).toBe(0);
  });

  // ── business type: patch ───────────────────────────────────────────────────────────────────────
  it("a PATCH changes the type, bumps the profile revision, emits client.centre_updated and writes History", async () => {
    const id = (await post(member, { name: "Switcher", businessType: "hotel" })).json().id as string;
    const before = await eventCount(id, "client.centre_updated");
    const r = await patch(member, id, { businessType: "spa" });
    expect(r.statusCode).toBe(200);
    expect(await profileRow(id)).toEqual({ business_type: "spa", revision: 2 });
    expect(await eventCount(id, "client.centre_updated")).toBe(before + 1);
    expect(await changesOf(id)).toContainEqual({ field: "businessType", before: "hotel", after: "spa" });
  });

  it("a PATCH with the SAME type changes nothing: no revision bump, no event, no History entry", async () => {
    const id = (await post(member, { name: "Steady", businessType: "retail" })).json().id as string;
    const events = await eventCount(id, "client.centre_updated");
    expect((await patch(member, id, { businessType: "retail" })).statusCode).toBe(200);
    expect(await profileRow(id)).toEqual({ business_type: "retail", revision: 1 });
    expect(await eventCount(id, "client.centre_updated")).toBe(events);
    expect((await changesOf(id)).some((c) => c.field === "businessType")).toBe(false);
  });

  it("a client with NO profile row stays 'not set' through an edit that omits the type, and gets one when it is chosen", async () => {
    const id = await createClient(co, "Legacy Untyped"); // seeded straight into the table, as a converted lead is
    expect(await profileRow(id)).toBeUndefined();
    expect((await patch(member, id, { name: "Legacy Untyped Renamed" })).statusCode).toBe(200);
    expect(await profileRow(id)).toBeUndefined();
    // Choosing "other" is a real change from "not set": a row appears, and History says it was set from nothing.
    expect((await patch(member, id, { businessType: "other" })).statusCode).toBe(200);
    expect(await profileRow(id)).toEqual({ business_type: "other", revision: 1 });
    expect(await changesOf(id)).toContainEqual({ field: "businessType", before: null, after: "other" });
  });

  it("an invalid or null businessType on PATCH is a 400 and the profile is untouched", async () => {
    const id = (await post(member, { name: "Guarded", businessType: "saas" })).json().id as string;
    const bad = await patch(member, id, { businessType: "pirate-ship" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "business_type_invalid" });
    expect((await patch(member, id, { businessType: null })).statusCode).toBe(400);
    expect(await profileRow(id)).toEqual({ business_type: "saas", revision: 1 });
  });

  it("a viewer cannot change the type", async () => {
    const id = (await post(member, { name: "Viewer Target", businessType: "agency" })).json().id as string;
    expect((await patch(viewer, id, { businessType: "retail" })).statusCode).toBe(403);
    expect(await profileRow(id)).toEqual({ business_type: "agency", revision: 1 });
  });

  // ── group company: who may touch it ────────────────────────────────────────────────────────────
  it("🔴 a member or company_admin setting groupCompanyId on PATCH gets 403 and the row is unchanged", async () => {
    const id = (await post(member, { name: "Link Target", businessType: "hotel" })).json().id as string;
    for (const who of [member, companyAdmin, childOwner]) {
      const r = await patch(who, id, { groupCompanyId: sibling });
      expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      expect(await dbGroup(id)).toBeNull();
    }
  });

  it("🔴 the 403 comes BEFORE validation of the target: a foreign company, a malformed id and null all read 403 for a non-operator", async () => {
    const id = (await post(member, { name: "Link Target Two", businessType: "hotel" })).json().id as string;
    for (const value of [foreignRoot, "not-a-uuid", RANDOM_UUID, co, null]) {
      const r = await patch(companyAdmin, id, { groupCompanyId: value });
      expect(r.statusCode, `value ${String(value)}: ${r.body}`).toBe(403);
    }
    expect(await dbGroup(id)).toBeNull();
  });

  it("🔴 a member creating a client WITH groupCompanyId (or null) gets 403 and no client is written", async () => {
    expect((await post(member, { name: "Sneaky Group", businessType: "hotel", groupCompanyId: sibling })).statusCode).toBe(403);
    expect((await post(member, { name: "Sneaky Group", businessType: "hotel", groupCompanyId: null })).statusCode).toBe(403);
    expect(await countByName("Sneaky Group")).toBe(0);
  });

  it("an ordinary edit that does not mention groupCompanyId leaves an existing link alone", async () => {
    const id = (await post(platformAdmin, { name: "Linked Stays", businessType: "hotel", groupCompanyId: sibling })).json().id as string;
    expect((await patch(member, id, { name: "Linked Stays Renamed", status: "prospect" })).statusCode).toBe(200);
    expect(await dbGroup(id)).toBe(sibling);
  });

  // ── group company: operators ───────────────────────────────────────────────────────────────────
  it("platform_admin links a same-root sibling; every read returns groupCompany {id,name}; History records it", async () => {
    const id = (await post(member, { name: "Sibling Client", businessType: "hotel" })).json().id as string;
    const r = await patch(platformAdmin, id, { groupCompanyId: sibling });
    expect(r.statusCode, r.body).toBe(200);
    expect(await dbGroup(id)).toBe(sibling);
    const expected = { id: sibling, name: "PV304 Sibling" };
    expect((await get(id)).groupCompany).toEqual(expected);
    const list = (await app.inject({ method: "GET", url: `/api/${co}/clients`, headers: asUser(member) })).json() as Array<{ id: string; groupCompany: unknown }>;
    expect(list.find((c) => c.id === id)?.groupCompany).toEqual(expected);
    const hub = (await app.inject({ method: "GET", url: `/api/${co}/clients/${id}/overview`, headers: asUser(member) })).json();
    expect(hub.client.groupCompany).toEqual(expected);
    expect(await changesOf(id)).toContainEqual({ field: "groupCompany", before: null, after: "PV304 Sibling" });
  });

  it("the owner of the ROOT can move a link to another sibling and clear it with null", async () => {
    const id = (await post(rootOwner, { name: "Root Owner Link", businessType: "hotel", groupCompanyId: sibling })).json().id as string;
    expect(await dbGroup(id)).toBe(sibling);
    expect((await patch(rootOwner, id, { groupCompanyId: sibling2 })).statusCode).toBe(200);
    expect((await get(id)).groupCompany).toEqual({ id: sibling2, name: "PV304 Sibling Two" });
    expect((await patch(rootOwner, id, { groupCompanyId: null })).statusCode).toBe(200);
    expect(await dbGroup(id)).toBeNull();
    expect((await get(id)).groupCompany).toBeNull();
    const ch = await changesOf(id);
    expect(ch).toContainEqual({ field: "groupCompany", before: "PV304 Sibling", after: "PV304 Sibling Two" });
    expect(ch).toContainEqual({ field: "groupCompany", before: "PV304 Sibling Two", after: null });
  });

  it("🔴 an operator is still refused a company of ANOTHER group (400 group_company_other_root) and the row is unchanged", async () => {
    const id = (await post(platformAdmin, { name: "Foreign Link", businessType: "hotel" })).json().id as string;
    const r = await patch(platformAdmin, id, { groupCompanyId: foreignRoot });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "group_company_other_root", field: "groupCompanyId" });
    expect(await dbGroup(id)).toBeNull();
    const c = await post(rootOwner, { name: "Foreign Create", businessType: "hotel", groupCompanyId: foreignRoot });
    expect(c.statusCode).toBe(400);
    expect(await countByName("Foreign Create")).toBe(0);
  });

  it("🔴 the client's own company is refused (400 group_company_self)", async () => {
    const id = (await post(platformAdmin, { name: "Self Link", businessType: "hotel" })).json().id as string;
    const r = await patch(platformAdmin, id, { groupCompanyId: co });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "group_company_self" });
    expect(await dbGroup(id)).toBeNull();
  });

  it("a nonexistent company, a soft-deleted sibling and a malformed id are each a typed 400", async () => {
    const id = (await post(platformAdmin, { name: "Missing Link", businessType: "hotel" })).json().id as string;
    const missing = await patch(platformAdmin, id, { groupCompanyId: RANDOM_UUID });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "group_company_not_found" });
    const gone = await patch(platformAdmin, id, { groupCompanyId: retired });
    expect(gone.statusCode).toBe(400);
    expect(gone.json()).toMatchObject({ error: "group_company_not_found" });
    const malformed = await patch(platformAdmin, id, { groupCompanyId: "not-a-uuid" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: "group_company_invalid" });
    expect(await dbGroup(id)).toBeNull();
  });

  it("a client linked to a company that is later deleted reads groupCompany: null (the link is dead)", async () => {
    const doomed = await createCompany("PV304 Doomed", [], root);
    const id = (await post(platformAdmin, { name: "Dead Link", businessType: "hotel", groupCompanyId: doomed })).json().id as string;
    expect((await get(id)).groupCompany).toEqual({ id: doomed, name: "PV304 Doomed" });
    await withGlobal((c) => c.query(`UPDATE companies SET deleted_at = now() WHERE id = $1`, [doomed]));
    expect((await get(id)).groupCompany).toBeNull();
  });

  // ── the database's own part ────────────────────────────────────────────────────────────────────
  it("the CHECK refuses a client linked to its own tenant, even around the API; the FK refuses a missing company", async () => {
    const id = (await post(member, { name: "Backstop", businessType: "hotel" })).json().id as string;
    await expect(adminPool().query(`UPDATE clients SET group_company_id = tenant_id WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
    await expect(adminPool().query(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [id, RANDOM_UUID])).rejects.toMatchObject({ code: "23503" });
    expect(await dbGroup(id)).toBeNull();
  });

  it("the partial index exists, and only over linked rows", async () => {
    const r = await adminPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_clients_group_company'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].indexdef).toMatch(/\(tenant_id, group_company_id\)/);
    expect(r.rows[0].indexdef).toMatch(/WHERE \(group_company_id IS NOT NULL\)/);
  });
});
