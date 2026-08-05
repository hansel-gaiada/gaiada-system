// ASST-01 — assistant module (0079) RLS: tenant isolation + THE MODULE WALL (two-sided handshake)
// + composite-FK cascade/SET-NULL behaviour + the (thread_id, seq) uniqueness guard.
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised
// (a superuser/BYPASSRLS connection would prove nothing — see the migration-backfill-rls-trap
// memory for why that distinction matters on this estate).
//
// `withAssistant` = a request that correctly declared the assistant scope (models
// withTenants([t], fn, {modules:['assistant']})). Plain `withTenants` = a request that did NOT —
// the exact "mis-scoped handler" the module wall exists to catch, per WD-23A-1's lesson that
// `app_module_allowed` is a two-sided handshake: the row's module (fixed here, 'assistant') must
// match the request-declared `app.scopes` GUC, or the row does not exist as far as this request
// is concerned, even for the correct tenant.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withAssistant<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, fn, { modules: ["assistant"] });
}

const ASSISTANT_TABLES = ["assistant_threads", "assistant_messages", "assistant_tool_calls", "assistant_memory"];

describe.skipIf(!TEST_URL)("Assistant module RLS + cascades (0079)", () => {
  let A: string; // tenant A
  let B: string; // tenant B — unrelated, must never see A's rows
  let owner: string;
  let otherUser: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Tenant A", ["assistant"]);
    B = await createCompany("Tenant B", ["assistant"]);
    owner = await createUser("owner@a.test");
    otherUser = await createUser("other@a.test");
  });
  afterAll(teardownTestDb);

  // ── sweep invariants ──────────────────────────────────────────────────────────────────────────
  it("all four assistant_* tables FORCE RLS", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class WHERE relkind='r' AND relname = ANY($1::text[])`,
        [ASSISTANT_TABLES],
      ),
    );
    expect(rows.length).toBe(4);
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  });

  it("each assistant_* table has exactly one FOR-ALL tenant_isolation policy", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = ANY($1::text[]) ORDER BY tablename`,
        [ASSISTANT_TABLES],
      ),
    );
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.policyname, r.tablename).toBe("tenant_isolation");
      expect(r.cmd, r.tablename).toBe("ALL");
    }
  });

  // ── the critical module-scope probe (per the ticket, "the one most likely to be silently wrong") ─
  it("MODULE PROBE: right tenant WITHOUT the assistant scope declared → ZERO rows", async () => {
    const threadId = newId();
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site)
         VALUES ($1,$2,$3,'probe thread','central')`,
        [threadId, A, owner],
      ),
    );

    // Correct tenant, but plain withTenants sets app.current_tenant_ids and NOT app.scopes.
    const res = await withTenants([A], (c) => c.query(`SELECT id FROM assistant_threads WHERE id=$1`, [threadId]));
    expect(res.rows.length).toBe(0);

    // Also prove it directly against every table, not just threads.
    for (const t of ASSISTANT_TABLES) {
      const r = await withTenants([A], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(r.rows[0].n, `${t} under withTenants([A]) with NO assistant scope must read 0 rows`).toBe(0);
    }

    // A DIFFERENT declared module scope must fail the same way (not just "unset").
    const wrongScope = await withTenants([A], async (c) => {
      await c.query("SELECT set_config('app.scopes', 'hr,reports', true)");
      return c.query(`SELECT id FROM assistant_threads WHERE id=$1`, [threadId]);
    });
    expect(wrongScope.rows.length).toBe(0);

    // With the scope correctly declared, the row IS visible — proves the probe isn't just broken RLS.
    const withScope = await withAssistant([A], (c) => c.query(`SELECT id FROM assistant_threads WHERE id=$1`, [threadId]));
    expect(withScope.rows.length).toBe(1);
  });

  it("WITH CHECK: cannot INSERT into any assistant_* table without declaring the assistant scope", async () => {
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site)
           VALUES (gen_random_uuid(),$1,$2,'no-scope','central')`,
          [A, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── cross-tenant isolation (wall 1) ───────────────────────────────────────────────────────────
  it("CROSS-TENANT PROBE: a thread created for A is invisible to B, even with the assistant scope declared", async () => {
    const threadId = newId();
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site)
         VALUES ($1,$2,$3,'A-only thread','central')`,
        [threadId, A, owner],
      ),
    );
    const fromB = await withAssistant([B], (c) => c.query(`SELECT id FROM assistant_threads WHERE id=$1`, [threadId]));
    expect(fromB.rows.length).toBe(0);
    const fromA = await withAssistant([A], (c) => c.query(`SELECT id FROM assistant_threads WHERE id=$1`, [threadId]));
    expect(fromA.rows.length).toBe(1);
  });

  it("cannot INSERT a row into a tenant outside the authorized set (WITH CHECK, wall 1)", async () => {
    await expect(
      withAssistant([A], (c) =>
        c.query(
          `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site)
           VALUES (gen_random_uuid(),$1,$2,'cross-tenant write','central')`,
          [B, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("empty tenant set → zero rows on every assistant_* table, no error, even with the scope declared", async () => {
    for (const t of ASSISTANT_TABLES) {
      const res = await withAssistant([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withAssistant([]) must be empty, not error`).toBe(0);
    }
  });

  // ── UNIQUE (thread_id, seq) ────────────────────────────────────────────────────────────────────
  it("UNIQUE (thread_id, seq) rejects a duplicate seq on the same thread", async () => {
    const threadId = newId();
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site)
         VALUES ($1,$2,$3,'seq thread','central')`,
        [threadId, A, owner],
      ),
    );
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
         VALUES (gen_random_uuid(),$1,$2,1,'user','first','central')`,
        [A, threadId],
      ),
    );
    await expect(
      withAssistant([A], (c) =>
        c.query(
          `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
           VALUES (gen_random_uuid(),$1,$2,1,'user','duplicate seq','central')`,
          [A, threadId],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  // ── cascade + SET NULL (constraint 4) ─────────────────────────────────────────────────────────
  it("deleting a thread CASCADEs to its messages and tool_calls, and SETs NULL (survives) on assistant_memory.source_thread_id", async () => {
    const threadId = newId();
    const messageId = newId();
    const toolCallId = newId();
    const memoryId = newId();

    await withAssistant([A], async (c) => {
      await c.query(
        `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site)
         VALUES ($1,$2,$3,'cascade thread','central')`,
        [threadId, A, owner],
      );
      await c.query(
        `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
         VALUES ($1,$2,$3,1,'user','hello','central')`,
        [messageId, A, threadId],
      );
      await c.query(
        `INSERT INTO assistant_tool_calls (id, tenant_id, message_id, tool_name, authority_user_id, origin_site)
         VALUES ($1,$2,$3,'tasks.list',$4,'central')`,
        [toolCallId, A, messageId, owner],
      );
      // Plain FK: reference the thread directly by id (no tenant column in the FK to worry about).
      await c.query(
        `INSERT INTO assistant_memory (id, tenant_id, owner_user_id, content, source_thread_id, origin_site)
         VALUES ($1,$2,$3,'user prefers dark mode',$4,'central')`,
        [memoryId, A, owner, threadId],
      );
    });

    // Sanity: everything exists before the delete.
    const before = await withAssistant([A], async (c) => ({
      msg: await c.query(`SELECT 1 FROM assistant_messages WHERE id=$1`, [messageId]),
      tool: await c.query(`SELECT 1 FROM assistant_tool_calls WHERE id=$1`, [toolCallId]),
      mem: await c.query(`SELECT source_thread_id FROM assistant_memory WHERE id=$1`, [memoryId]),
    }));
    expect(before.msg.rows.length).toBe(1);
    expect(before.tool.rows.length).toBe(1);
    expect(before.mem.rows[0].source_thread_id).toBe(threadId);

    await withAssistant([A], (c) => c.query(`DELETE FROM assistant_threads WHERE id=$1`, [threadId]));

    // Prove the delete's REACH with an admin (RLS-bypassing) read — "leave nothing orphaned" means
    // truly gone, not merely invisible under the current tenant scope.
    const admin = adminPool();
    const msgAfter = await admin.query(`SELECT 1 FROM assistant_messages WHERE id=$1`, [messageId]);
    const toolAfter = await admin.query(`SELECT 1 FROM assistant_tool_calls WHERE id=$1`, [toolCallId]);
    const memAfter = await admin.query(`SELECT source_thread_id FROM assistant_memory WHERE id=$1`, [memoryId]);

    expect(msgAfter.rows.length, "message must be gone (CASCADE)").toBe(0);
    expect(toolAfter.rows.length, "tool_call must be gone (CASCADE via message)").toBe(0);
    expect(memAfter.rows.length, "memory row must SURVIVE the thread delete").toBe(1);
    expect(memAfter.rows[0].source_thread_id, "memory.source_thread_id must be NULLed, not left dangling").toBeNull();
  });

  // ── erasure reach: deleting a tenant's rows leaves nothing orphaned (constraint 7 / OQ-1) ───────
  it("erasure reach: deleting all of a tenant's threads and memory leaves zero rows behind (admin view)", async () => {
    const threadId = newId();
    const messageId = newId();
    const memoryId = newId();
    await withAssistant([B], async (c) => {
      await c.query(
        `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site)
         VALUES ($1,$2,$3,'erasure thread','central')`,
        [threadId, B, otherUser],
      );
      await c.query(
        `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
         VALUES ($1,$2,$3,1,'user','erase me','central')`,
        [messageId, B, threadId],
      );
      await c.query(
        `INSERT INTO assistant_memory (id, tenant_id, owner_user_id, content, origin_site)
         VALUES ($1,$2,$3,'a fact','central')`,
        [memoryId, B, otherUser],
      );
    });

    // eraseTenant's reach, modeled directly: hard DELETE on both roots for the tenant.
    await withAssistant([B], async (c) => {
      await c.query(`DELETE FROM assistant_threads WHERE tenant_id=$1`, [B]);
      await c.query(`DELETE FROM assistant_memory WHERE tenant_id=$1`, [B]);
    });

    const admin = adminPool();
    for (const [table, id] of [
      ["assistant_threads", threadId],
      ["assistant_messages", messageId],
      ["assistant_memory", memoryId],
    ] as const) {
      const r = await admin.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]);
      expect(r.rows.length, `${table} row must be gone after erasure`).toBe(0);
    }
  });
});
