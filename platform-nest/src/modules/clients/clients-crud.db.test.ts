// CC-D10 — real-DB + live-Cerbos proofs for the client edit surface: owner, contact merge, status on
// create, notes and history. Same app.inject() harness as centre/clients-centre.db.test.ts. Needs
// DATABASE_URL_TEST + a live Cerbos (skips silently otherwise — check the skip count).
//
// What is under test is the part a mock would happily agree with: the jsonb merge SQL, the tenancy
// check on the owner id (an FK alone would accept another tenant's user), and the member/manager line
// Cerbos draws between editing a client and deleting somebody else's note.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { withTenants } from "../../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("CC-D10 · client edit, owner, notes, history (clients.controller.ts)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let member: string;    // ordinary staff: create + update, NOT delete
  let manager: string;   // manager: create + update + delete
  let viewer: string;    // read only
  let outsider: string;  // staff of a DIFFERENT tenant
  let client: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    co = await createCompany("Edit Co", ["clients"]);
    other = await createCompany("Other Co", ["clients"]);
    member = await createUser("edit-member@a.test");
    manager = await createUser("edit-manager@a.test");
    viewer = await createUser("edit-viewer@a.test");
    outsider = await createUser("edit-outsider@b.test");
    for (const u of [member, manager, viewer]) await addMembership(co, u);
    await addMembership(other, outsider);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    await grantRole(outsider, await createRole("company_admin"), "company", other);

    client = await createClient(co, "Harbour Hotel");
    await withTenants([co], (c) =>
      c.query(`UPDATE clients SET contact = $2 WHERE id = $1`, [client, JSON.stringify({ email: "old@harbour.test", fax: "keep-me" })]),
    );

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const patch = (who: string, payload: unknown) =>
    app.inject({ method: "PATCH", url: `/api/${co}/clients/${client}`, headers: asUser(who), payload: payload as object });
  const get = async () => (await app.inject({ method: "GET", url: `/api/${co}/clients/${client}`, headers: asUser(member) })).json();

  // ── staff can edit ─────────────────────────────────────────────────────────────────────────────
  it("an ordinary staff member (member role) can create a client, and the chosen status is kept", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/clients`, headers: asUser(member),
      payload: { name: "Prospect Villa", status: "prospect", contact: { phone: "+62 361 1" } },
    });
    expect(r.statusCode).toBe(201);
    const row = (await app.inject({ method: "GET", url: `/api/${co}/clients/${r.json().id}`, headers: asUser(member) })).json();
    // The pre-CC-D10 create dropped `status`, so this read "active".
    expect(row).toMatchObject({ name: "Prospect Villa", status: "prospect", contact: { phone: "+62 361 1" } });
  });

  it("a member can rename and edit contact; contact is MERGED, not replaced", async () => {
    const r = await patch(member, { name: "Harbour Hotel & Spa", contact: { email: "new@harbour.test", phone: "+62 1", address: "" } });
    expect(r.statusCode).toBe(200);
    const row = await get();
    expect(row.name).toBe("Harbour Hotel & Spa");
    // `fax` was never mentioned in the patch and must survive; replacing the object would erase it.
    expect(row.contact).toEqual({ email: "new@harbour.test", phone: "+62 1", fax: "keep-me" });
  });

  it("null deletes one contact key and nothing else", async () => {
    expect((await patch(member, { contact: { phone: null } })).statusCode).toBe(200);
    expect((await get()).contact).toEqual({ email: "new@harbour.test", fax: "keep-me" });
  });

  it("a viewer cannot edit", async () => {
    expect((await patch(viewer, { name: "Nope" })).statusCode).toBe(403);
  });

  it("refuses a blank name, a bad email and a malformed status with 400", async () => {
    expect((await patch(member, { name: "   " })).statusCode).toBe(400);
    expect((await patch(member, { contact: { billingEmail: "not-an-email" } })).statusCode).toBe(400);
    expect((await patch(member, { status: "Active " })).statusCode).toBe(400);
    expect((await get()).name).toBe("Harbour Hotel & Spa");
  });

  // ── owner ──────────────────────────────────────────────────────────────────────────────────────
  it("owner can be set to active staff of this tenant, and reads back with the owner's name", async () => {
    expect((await patch(member, { ownerUserId: manager })).statusCode).toBe(200);
    const row = await get();
    expect(row.owner_user_id).toBe(manager);
    expect(typeof row.owner_name).toBe("string");
  });

  it("🔴 another tenant's user is refused as owner — the FK alone would have accepted it", async () => {
    const r = await patch(member, { ownerUserId: outsider });
    expect(r.statusCode).toBe(400);
    expect((await get()).owner_user_id).toBe(manager);
  });

  it("null clears the owner", async () => {
    expect((await patch(member, { ownerUserId: null })).statusCode).toBe(200);
    expect((await get()).owner_user_id).toBeNull();
  });

  // ── history ────────────────────────────────────────────────────────────────────────────────────
  it("history records what changed, before and after", async () => {
    await patch(member, { status: "archived" });
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${client}/history`, headers: asUser(viewer) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ verb: string; metadata: { changes?: { field: string; before: string | null; after: string | null }[] } }>;
    const statusChange = rows.flatMap((x) => x.metadata.changes ?? []).find((ch) => ch.field === "status");
    expect(statusChange).toEqual({ field: "status", before: "active", after: "archived" });
    const rename = rows.flatMap((x) => x.metadata.changes ?? []).find((ch) => ch.field === "name");
    expect(rename).toEqual({ field: "name", before: "Harbour Hotel", after: "Harbour Hotel & Spa" });
  });

  it("another tenant cannot read this client's history", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${client}/history`, headers: asUser(outsider) });
    expect(r.statusCode).toBe(403);
  });

  // ── notes ──────────────────────────────────────────────────────────────────────────────────────
  it("a member can add a note; a viewer can read but not add", async () => {
    const add = await app.inject({ method: "POST", url: `/api/${co}/clients/${client}/notes`, headers: asUser(member), payload: { body: "  Prefers WhatsApp.  " } });
    expect(add.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/api/${co}/clients/${client}/notes`, headers: asUser(viewer) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: add.json().id, body: "Prefers WhatsApp.", authorId: member })]);
    const denied = await app.inject({ method: "POST", url: `/api/${co}/clients/${client}/notes`, headers: asUser(viewer), payload: { body: "x" } });
    expect(denied.statusCode).toBe(403);
    const blank = await app.inject({ method: "POST", url: `/api/${co}/clients/${client}/notes`, headers: asUser(member), payload: { body: "   " } });
    expect(blank.statusCode).toBe(400);
  });

  it("deleting a note: your own with update; someone else's needs delete (manager), not member", async () => {
    const mine = (await app.inject({ method: "POST", url: `/api/${co}/clients/${client}/notes`, headers: asUser(member), payload: { body: "mine" } })).json().id;
    const theirs = (await app.inject({ method: "POST", url: `/api/${co}/clients/${client}/notes`, headers: asUser(manager), payload: { body: "theirs" } })).json().id;
    const del = (who: string, id: string) =>
      app.inject({ method: "DELETE", url: `/api/${co}/clients/${client}/notes/${id}`, headers: asUser(who) });
    expect((await del(member, mine)).statusCode).toBe(200);
    expect((await del(member, theirs)).statusCode).toBe(403);
    expect((await del(manager, theirs)).statusCode).toBe(200);
    expect((await del(manager, theirs)).statusCode).toBe(404);
    const left = (await app.inject({ method: "GET", url: `/api/${co}/clients/${client}/notes`, headers: asUser(member) })).json() as { body: string }[];
    expect(left.map((n) => n.body)).toEqual(["Prefers WhatsApp."]);
  });

  it("the history shows notes being added", async () => {
    const rows = (await app.inject({ method: "GET", url: `/api/${co}/clients/${client}/history`, headers: asUser(member) })).json() as { verb: string }[];
    expect(rows.map((r) => r.verb)).toEqual(expect.arrayContaining(["noted", "note_deleted", "updated"]));
    expect(rows.some((r) => r.verb.startsWith("authz."))).toBe(false);
  });
});
