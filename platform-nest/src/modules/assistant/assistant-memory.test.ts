// ASST-19 — the memory panel's backend surface: `GET/POST/DELETE /api/:t/assistant/memory` +
// `POST /api/:t/assistant/memory/:id/confirm`, against live Postgres + Cerbos (skips without
// DATABASE_URL_TEST/CERBOS_URL). Exercises the controller through real HTTP (app.inject), same
// pattern as assistant.test.ts.
//
// The QUARANTINE invariant itself (confirmed_at IS NOT NULL gating what reaches an assembled
// prompt) is proven at the context-assembly level in context-memory.test.ts, per the ticket's own
// instruction to assert on the assembled context, not the UI/API shape. This file covers the CRUD
// surface: propose vs confirm as distinct operations, owner-only enforcement, pin/edit, scope, and
// the thread-delete-survives-memory cascade behaviour.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-19").
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface MemoryItem {
  id: string;
  ownerUserId: string;
  scope: string;
  content: string;
  provenance: string;
  trust: string;
  pinned: boolean;
  confirmedAt: string | null;
  sourceThreadId: string | null;
}

describe.skipIf(!TEST_URL)("Assistant memory panel (ASST-19)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let owner: string;
  let other: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("Assistant Memory Tenant A", ["assistant"]);
    owner = await createUser("owner@asst-memory.test");
    other = await createUser("other@asst-memory.test");
    admin = await createUser("admin@asst-memory.test");
    await addMembership(A, owner);
    await addMembership(A, other);
    await addMembership(A, admin);
    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, companyAdminRole, "company", A);
    await grantRole(other, memberRole, "company", A);
    await grantRole(owner, memberRole, "company", A);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  async function propose(content: string, extra: Record<string, unknown> = {}) {
    const r = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory`, headers: asUser(owner), payload: { content, ...extra },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  it("propose creates an UNCONFIRMED row (trust='untrusted', confirmed_at=null), invisible to the confirmed-only filter", async () => {
    const id = await propose("proposes: user's timezone is Asia/Jakarta");

    const admin_ = adminPool();
    const raw = await admin_.query(`SELECT trust, confirmed_at, provenance FROM assistant_memory WHERE id = $1`, [id]);
    expect(raw.rows[0]).toMatchObject({ trust: "untrusted", confirmed_at: null, provenance: "user" });

    const unconfirmedList = await app.inject({
      method: "GET", url: `/api/${A}/assistant/memory?confirmed=false`, headers: asUser(owner),
    });
    expect((unconfirmedList.json() as { items: MemoryItem[] }).items.map((m) => m.id)).toContain(id);

    const confirmedList = await app.inject({
      method: "GET", url: `/api/${A}/assistant/memory?confirmed=true`, headers: asUser(owner),
    });
    expect((confirmedList.json() as { items: MemoryItem[] }).items.map((m) => m.id)).not.toContain(id);
  });

  it("propose -> confirm round-trip: confirm sets confirmed_at + trust='trusted', and the row now appears in the confirmed filter", async () => {
    const id = await propose("proposes: prefers async standups");

    const confirmed = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory/${id}/confirm`, headers: asUser(owner), payload: {},
    });
    expect(confirmed.statusCode).toBe(200);

    const admin_ = adminPool();
    const raw = await admin_.query(`SELECT trust, confirmed_at IS NOT NULL AS is_confirmed FROM assistant_memory WHERE id = $1`, [id]);
    expect(raw.rows[0]).toMatchObject({ trust: "trusted", is_confirmed: true });

    const confirmedList = await app.inject({
      method: "GET", url: `/api/${A}/assistant/memory?confirmed=true`, headers: asUser(owner),
    });
    expect((confirmedList.json() as { items: MemoryItem[] }).items.map((m) => m.id)).toContain(id);
  });

  it("pin/edit round-trip on an already-confirmed row: content + pinned update, the ORIGINAL confirmation timestamp is preserved", async () => {
    const id = await propose("proposes: likes short meetings");
    await app.inject({ method: "POST", url: `/api/${A}/assistant/memory/${id}/confirm`, headers: asUser(owner), payload: {} });

    const afterFirstConfirm = await adminPool().query(`SELECT confirmed_at FROM assistant_memory WHERE id = $1`, [id]);
    const firstConfirmedAt = afterFirstConfirm.rows[0].confirmed_at as string;

    // A second call to the SAME endpoint, now used as the pin/edit affordance (Cerbos has no
    // separate "update" action — see the controller's memory-section header).
    const edited = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory/${id}/confirm`, headers: asUser(owner),
      payload: { content: "edited: likes VERY short meetings", pinned: true },
    });
    expect(edited.statusCode).toBe(200);

    const row = await adminPool().query(`SELECT content, pinned, confirmed_at FROM assistant_memory WHERE id = $1`, [id]);
    expect(row.rows[0].content).toBe("edited: likes VERY short meetings");
    expect(row.rows[0].pinned).toBe(true);
    expect(new Date(row.rows[0].confirmed_at).getTime()).toBe(new Date(firstConfirmedAt).getTime());
  });

  it("delete removes the row for the owner's own list", async () => {
    const id = await propose("proposes: to be deleted");
    const del = await app.inject({ method: "DELETE", url: `/api/${A}/assistant/memory/${id}`, headers: asUser(owner) });
    expect(del.statusCode).toBe(200);

    const admin_ = adminPool();
    const raw = await admin_.query(`SELECT 1 FROM assistant_memory WHERE id = $1`, [id]);
    expect(raw.rows).toHaveLength(0);

    const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/memory`, headers: asUser(owner) });
    expect((list.json() as { items: MemoryItem[] }).items.map((m) => m.id)).not.toContain(id);
  });

  it("owner-only end to end: a different same-company user AND a company_admin are denied on list/propose/confirm/delete", async () => {
    const id = await propose("proposes: a fact only the owner may touch");

    // list: `other`'s own list simply never contains the owner's row (self-scoped) — the DENY
    // surface for list is exercised on a resource id it does not own would be nonsensical (list
    // has no :id); the deny is instead proven by disjointness, matching assistant.test.ts's own
    // "a second company's thread list is disjoint" pattern.
    for (const intruder of [other, admin]) {
      const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/memory`, headers: asUser(intruder) });
      expect((list.json() as { items: MemoryItem[] }).items.map((m) => m.id)).not.toContain(id);

      const confirm = await app.inject({
        method: "POST", url: `/api/${A}/assistant/memory/${id}/confirm`, headers: asUser(intruder), payload: {},
      });
      expect(confirm.statusCode).toBe(403);

      const del = await app.inject({ method: "DELETE", url: `/api/${A}/assistant/memory/${id}`, headers: asUser(intruder) });
      expect(del.statusCode).toBe(403);
    }

    // propose itself has no :id to deny against (every principal proposes as themselves) — its
    // owner-only property is that `other`/`admin` proposing lands THEIR OWN row, never the
    // owner's, and can never be used to write into someone else's memory.
    const otherProposed = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory`, headers: asUser(other), payload: { content: "other's own memory" },
    });
    expect(otherProposed.statusCode).toBe(201);
    const otherOwnerCheck = await adminPool().query(`SELECT owner_user_id FROM assistant_memory WHERE id = $1`, [otherProposed.json().id]);
    expect(otherOwnerCheck.rows[0].owner_user_id).toBe(other);

    // The real owner can still touch it — the 403s above consumed nothing.
    const ownerConfirm = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory/${id}/confirm`, headers: asUser(owner), payload: {},
    });
    expect(ownerConfirm.statusCode).toBe(200);
  });

  it("scope: 'company' is accepted and stored, but does NOT widen visibility past the owner — same 403s as 'user' scope", async () => {
    const id = await propose("proposes: the company's fiscal year starts in April", { scope: "company" });
    const raw = await adminPool().query(`SELECT scope FROM assistant_memory WHERE id = $1`, [id]);
    expect(raw.rows[0].scope).toBe("company");

    // Still owner-private: neither a same-company member nor company_admin gets it, exactly as
    // the default 'user' scope — resource_assistant_memory.yaml does not branch on `scope`.
    const otherList = await app.inject({ method: "GET", url: `/api/${A}/assistant/memory`, headers: asUser(other) });
    expect((otherList.json() as { items: MemoryItem[] }).items.map((m) => m.id)).not.toContain(id);
    const adminConfirm = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory/${id}/confirm`, headers: asUser(admin), payload: {},
    });
    expect(adminConfirm.statusCode).toBe(403);
  });

  it("deleting a thread leaves its cited memory row ALIVE with source_thread_id NULLed (composite FK, ON DELETE SET NULL)", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "memory-source thread" },
    });
    expect(created.statusCode).toBe(201);
    const threadId = created.json().id as string;

    const memoryId = await propose("proposes: fact mined from this thread", { sourceThreadId: threadId });
    const beforeDelete = await app.inject({ method: "GET", url: `/api/${A}/assistant/memory`, headers: asUser(owner) });
    expect((beforeDelete.json() as { items: MemoryItem[] }).items.find((m) => m.id === memoryId)?.sourceThreadId).toBe(threadId);

    const del = await app.inject({ method: "DELETE", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    expect(del.statusCode).toBe(200);

    const afterDelete = await app.inject({ method: "GET", url: `/api/${A}/assistant/memory`, headers: asUser(owner) });
    const survived = (afterDelete.json() as { items: MemoryItem[] }).items.find((m) => m.id === memoryId);
    expect(survived, "the memory row must SURVIVE the thread delete").toBeTruthy();
    expect(survived!.sourceThreadId).toBeNull();
  });
});
