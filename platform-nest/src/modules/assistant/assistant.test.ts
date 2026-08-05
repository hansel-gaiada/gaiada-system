// ASST-05 — Assistant module: contract registration + threads/messages CRUD, against live
// Postgres + Cerbos (skips without DATABASE_URL_TEST/CERBOS_URL). Exercises the controller through
// real HTTP (app.inject), not direct DB calls, so the wiring (guards, authorize(), the module-scope
// handshake) is what's under test, not just the SQL.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-05").
// ASST-01 (migration 0079) and ASST-02 (Cerbos owner-only policy, LIVE + verified) are prerequisites
// this file builds on without re-testing — module-assistant-rls.test.ts already proves the RLS
// module-scope handshake at the DB layer; this file proves the controller's use of it plus the
// owner-only authorization surface end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules, getModule } from "../registry";
import { assistantModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("Assistant module (ASST-05)", () => {
  let app: NestFastifyApplication;
  let A: string; // tenant with 'assistant' enabled
  let B: string; // a second tenant with 'assistant' enabled — for cross-tenant disjointness
  let C: string; // a tenant WITHOUT 'assistant' enabled — dark-by-default probe
  let owner: string; // member of A and B; owns threads in both
  let other: string; // a DIFFERENT member of A — the cross-user deny probe
  let admin: string; // A's company_admin — the no-admin-backdoor probe

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("Assistant Tenant A", ["assistant"]);
    B = await createCompany("Assistant Tenant B", ["assistant"]);
    C = await createCompany("Assistant Tenant C (no assistant)", []);

    owner = await createUser("owner@asst-a.test");
    other = await createUser("other@asst-a.test");
    admin = await createUser("admin@asst-a.test");

    await addMembership(A, owner);
    await addMembership(A, other);
    await addMembership(A, admin);
    await addMembership(B, owner);
    await addMembership(C, owner);

    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, companyAdminRole, "company", A);
    await grantRole(other, memberRole, "company", A);
    await grantRole(owner, memberRole, "company", A);
    await grantRole(owner, memberRole, "company", B);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("module registration: assistant's ModuleContract carries the ASST-05 shape", () => {
    expect(getModule("assistant")).toBe(assistantModule);
    expect(assistantModule.migrations).toEqual(["0079_module_assistant.sql", "0084_assistant_handoffs.sql"]);
    // Deliberately empty in phases 0-1 (see index.ts's header) — not a placeholder omission.
    expect(assistantModule.mcpTools).toEqual([]);
    expect(assistantModule.rollupProviders).toEqual([]);
  });

  it("dark by default: a tenant without 'assistant' enabled 404s, not 403", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${C}/assistant/threads`, headers: asUser(owner) });
    expect(r.statusCode).toBe(404);
  });

  it("request WITHOUT the module scope fails closed (zero rows), not a 500 — the two-sided handshake", async () => {
    // Every controller method passes {modules:['assistant']}; this proves what happens to a query
    // that (like a mis-written future handler) forgot to — the exact trap WD-23A-1 named. A
    // plain withTenants([A]) with no module scope must read ZERO rows, not throw, even though A
    // has 'assistant' enabled (module-enablement and the module-scope GUC are two different walls).
    const res = await withTenants([A], (c) => c.query(`SELECT id FROM assistant_threads WHERE tenant_id = $1`, [A]));
    expect(res.rows).toEqual([]);
  });

  let threadId: string;
  it("owner CRUD round-trip: create -> list -> get -> patch (rename/pin/archive/brain) -> delete", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner),
      payload: { title: "First thread", brainProvider: "ollama", brainModel: "llama3.2" },
    });
    expect(created.statusCode).toBe(201);
    threadId = created.json().id;
    expect(threadId).toBeTruthy();

    const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads`, headers: asUser(owner) });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { items: Array<{ id: string; title: string }>; total: number };
    expect(listBody.items.map((t) => t.id)).toContain(threadId);
    expect(listBody.total).toBeGreaterThanOrEqual(1);

    const got = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    expect(got.statusCode).toBe(200);
    const gotBody = got.json() as { thread: { id: string; title: string; ownerUserId: string }; messages: unknown[] };
    expect(gotBody.thread.title).toBe("First thread");
    expect(gotBody.thread.ownerUserId).toBe(owner);
    expect(gotBody.messages).toEqual([]);

    const patched = await app.inject({
      method: "PATCH", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner),
      payload: { title: "Renamed thread", pinned: true, status: "archived", brainProvider: "claude", brainModel: "opus" },
    });
    expect(patched.statusCode).toBe(200);

    const afterPatch = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(owner) });
    const afterPatchBody = afterPatch.json() as { thread: { title: string; pinned: boolean; status: string; brainProvider: string; brainModel: string } };
    expect(afterPatchBody.thread.title).toBe("Renamed thread");
    expect(afterPatchBody.thread.pinned).toBe(true);
    expect(afterPatchBody.thread.status).toBe("archived");
    expect(afterPatchBody.thread.brainProvider).toBe("claude");
    expect(afterPatchBody.thread.brainModel).toBe("opus");
  });

  it("pinned-first ordering: a pinned thread sorts before a more-recent unpinned one", async () => {
    // threadId (from the previous test) is now pinned+archived. A brand-new unpinned thread is
    // strictly more recently created/updated, but must still sort AFTER the pinned one.
    const fresh = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "Fresh unpinned" },
    });
    expect(fresh.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads`, headers: asUser(owner) });
    const items = (list.json() as { items: Array<{ id: string; pinned: boolean }> }).items;
    const pinnedIdx = items.findIndex((t) => t.id === threadId);
    const freshIdx = items.findIndex((t) => t.id === fresh.json().id);
    expect(pinnedIdx).toBeGreaterThanOrEqual(0);
    expect(freshIdx).toBeGreaterThanOrEqual(0);
    expect(pinnedIdx).toBeLessThan(freshIdx);
  });

  it("a DIFFERENT user in the same company is denied (403) on read/patch/delete — no owner match", async () => {
    const read = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(other) });
    expect(read.statusCode).toBe(403);
    const patch = await app.inject({
      method: "PATCH", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(other), payload: { pinned: false },
    });
    expect(patch.statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(other) });
    expect(del.statusCode).toBe(403);
    // other's OWN list must not contain owner's thread (their list is self-scoped by construction).
    const list = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads`, headers: asUser(other) });
    expect((list.json() as { items: Array<{ id: string }> }).items.map((t) => t.id)).not.toContain(threadId);
  });

  it("company_admin is ALSO denied (403) — deliberately NO admin backdoor on this resource", async () => {
    const read = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(admin) });
    expect(read.statusCode).toBe(403);
    const patch = await app.inject({
      method: "PATCH", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(admin), payload: { pinned: false },
    });
    expect(patch.statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url: `/api/${A}/assistant/threads/${threadId}`, headers: asUser(admin) });
    expect(del.statusCode).toBe(403);
  });

  it("a second company's thread list is disjoint for the SAME owning user", async () => {
    const inB = await app.inject({
      method: "POST", url: `/api/${B}/assistant/threads`, headers: asUser(owner), payload: { title: "B-only thread" },
    });
    expect(inB.statusCode).toBe(201);
    const bThreadId = inB.json().id;

    const listA = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads`, headers: asUser(owner) });
    expect((listA.json() as { items: Array<{ id: string }> }).items.map((t) => t.id)).not.toContain(bThreadId);

    const listB = await app.inject({ method: "GET", url: `/api/${B}/assistant/threads`, headers: asUser(owner) });
    const bIds = (listB.json() as { items: Array<{ id: string }> }).items.map((t) => t.id);
    expect(bIds).toContain(bThreadId);
    expect(bIds).not.toContain(threadId); // A's thread must not leak into B's list
  });

  it("delete removes messages + tool_calls (cascade) and NULLs assistant_memory.source_thread_id (row survives)", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "cascade probe" },
    });
    const cascadeThreadId = created.json().id as string;
    const messageId = newId();
    const toolCallId = newId();
    const memoryId = newId();

    await withTenants(
      [A],
      async (c) => {
        await c.query(
          `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
           VALUES ($1,$2,$3,1,'user','hello',$4)`,
          [messageId, A, cascadeThreadId, config.originSite],
        );
        await c.query(
          `INSERT INTO assistant_tool_calls (id, tenant_id, message_id, tool_name, authority_user_id, origin_site)
           VALUES ($1,$2,$3,'tasks.list',$4,$5)`,
          [toolCallId, A, messageId, owner, config.originSite],
        );
        await c.query(
          `INSERT INTO assistant_memory (id, tenant_id, owner_user_id, content, source_thread_id, origin_site)
           VALUES ($1,$2,$3,'user prefers dark mode',$4,$5)`,
          [memoryId, A, owner, cascadeThreadId, config.originSite],
        );
      },
      { modules: ["assistant"] },
    );

    const del = await app.inject({ method: "DELETE", url: `/api/${A}/assistant/threads/${cascadeThreadId}`, headers: asUser(owner) });
    expect(del.statusCode).toBe(200);

    // Admin (RLS-bypassing) reads prove the delete's REACH, not merely that it's invisible under
    // the current tenant scope.
    const adm = adminPool();
    const msgAfter = await adm.query(`SELECT 1 FROM assistant_messages WHERE id=$1`, [messageId]);
    const toolAfter = await adm.query(`SELECT 1 FROM assistant_tool_calls WHERE id=$1`, [toolCallId]);
    const memAfter = await adm.query(`SELECT source_thread_id FROM assistant_memory WHERE id=$1`, [memoryId]);
    expect(msgAfter.rows.length, "message must be gone (CASCADE)").toBe(0);
    expect(toolAfter.rows.length, "tool_call must be gone (CASCADE via message)").toBe(0);
    expect(memAfter.rows.length, "memory row must SURVIVE the thread delete").toBe(1);
    expect(memAfter.rows[0].source_thread_id, "memory.source_thread_id must be NULLed").toBeNull();

    const getAfterDelete = await app.inject({ method: "GET", url: `/api/${A}/assistant/threads/${cascadeThreadId}`, headers: asUser(owner) });
    expect(getAfterDelete.statusCode).toBe(404);
  });
});
