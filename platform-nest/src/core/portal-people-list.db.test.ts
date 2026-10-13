// PV4-13 (owner ruling PV-D36, 2026-10-13) — the portal People list shows only SHARED reach, per client.
// Over HTTP against live Postgres + RLS + Cerbos (skips silently without DATABASE_URL_TEST; runs on the Linux gate).
//
// THE RULE: "A contact limited to some projects sees the client-wide contacts and the contacts on their own projects,
// never contacts on projects outside their reach (nor those contacts' project ids); a client-wide contact sees every
// contact of that client, as today." Built per client: for a client in `wideClientIds` every active/invited contact of
// it; otherwise the client-wide contacts (`project_id IS NULL`) plus the contacts whose project is in `projectIds`.
//
// The shared multi-client contact (src/testing/portal-fixtures.ts) is client-wide SIGNER on A and a VIEWER limited to B1
// on client B (which also has B2). This suite adds the contacts that populate each client's People list.
//
// Teeth (recorded in the hand-back, real red CI on a throwaway branch): in portal-visibility.ts make
// `clientContactInPortalScope` drop its project arm (back to `inCallerClients AND clientContactClientVisible`): the
// "never B2's contacts" tests fail.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { createMultiClientContact, type MultiClientContact } from "../testing/portal-fixtures";
import { newId, withGlobal, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface PersonRow { id: string; name: string; clientId: string; projectId: string | null; capability: string; status: string }

describe.skipIf(!TEST_URL)("portal People list (PV-D36) — shared reach only, per client", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let m: MultiClientContact;
  // Contacts that fill the lists. Client A: one more client-wide, one on A's only project. Client B: a client-wide
  // contact, one on B1 (the shared contact's project) and one on B2 (outside the shared contact's reach).
  let aWide: string;
  let aScoped: string;
  let bWide: string;
  let bOnB1: string;
  let bOnB2: string;

  const people = async (userId: string): Promise<PersonRow[]> => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(userId) });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    return r.json().contacts as PersonRow[];
  };
  const on = (rows: PersonRow[], clientId: string) => rows.filter((r) => r.clientId === clientId);
  const userIds = (rows: PersonRow[]) => rows.map((r) => r.id).sort();

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("People Co");
    admin = await createUser("admin@people.test", "Ada Admin");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    m = await createMultiClientContact(co, { tag: "people", staffUserId: admin });
    const clientRole = await createRole("client");

    const contact = async (email: string, clientId: string, projectId: string | null, capability: "signer" | "viewer") => {
      const u = await createUser(email, email.split("@")[0]);
      await addMembership(co, u);
      await grantRole(u, clientRole, "company", co);
      await withGlobal((c) => c.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [u]));
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), $7)`,
          [newId(), co, clientId, u, projectId, capability, config.originSite],
        ),
      );
      return u;
    };
    aWide = await contact("a-wide@people.test", m.clientA, null, "viewer");
    aScoped = await contact("a-scoped@people.test", m.clientA, m.projectA, "viewer");
    bWide = await contact("b-wide@people.test", m.clientB, null, "signer");
    bOnB1 = await contact("b-on-b1@people.test", m.clientB, m.projectB1, "viewer");
    bOnB2 = await contact("b-on-b2@people.test", m.clientB, m.projectB2, "viewer");
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("the multi-client contact sees EVERY contact of client A, where they are client-wide (as today)", async () => {
    const rows = on(await people(m.userId), m.clientA);
    expect(userIds(rows)).toEqual([aScoped, aWide, m.userId].sort());
    // A's project-scoped contact is listed WITH its project id: the caller reaches all of A.
    expect(rows.find((r) => r.id === aScoped)?.projectId).toBe(m.projectA);
  });

  it("on client B (limited to B1) the same contact sees B's client-wide contacts and B1's contacts, never B2's", async () => {
    const rows = on(await people(m.userId), m.clientB);
    expect(userIds(rows)).toEqual([bOnB1, bWide, m.userId].sort());
    expect(rows.map((r) => r.id)).not.toContain(bOnB2);
    expect(rows.find((r) => r.id === bWide)?.projectId).toBeNull();
    expect(rows.find((r) => r.id === bOnB1)?.projectId).toBe(m.projectB1);
  });

  it("never returns a projectId outside the caller's reach, on any client", async () => {
    const all = await people(m.userId);
    // Reach: every project of A (client-wide there) and B1 (the only project they hold on B).
    const reachable = new Set<string | null>([null, m.projectA, m.projectB1]);
    for (const r of all) expect(reachable.has(r.projectId), `leaked projectId ${String(r.projectId)} for ${r.id}`).toBe(true);
    expect(all.map((r) => r.projectId)).not.toContain(m.projectB2);
  });

  it("a client-wide contact of B sees B2's contacts too, and nothing of client A", async () => {
    const all = await people(bWide);
    expect(userIds(all)).toEqual([bOnB1, bOnB2, bWide, m.userId].sort());
    expect(all.find((r) => r.id === bOnB2)?.projectId).toBe(m.projectB2);
    expect(all.every((r) => r.clientId === m.clientB)).toBe(true);
  });

  it("a contact limited to B2 sees B's client-wide contacts and their own project's, not B1's", async () => {
    const all = await people(bOnB2);
    expect(userIds(all)).toEqual([bOnB2, bWide].sort());
    expect(all.map((r) => r.projectId)).not.toContain(m.projectB1);
    // The shared contact is a B1 contact on B, so it is outside this caller's reach.
    expect(all.map((r) => r.id)).not.toContain(m.userId);
  });
});
