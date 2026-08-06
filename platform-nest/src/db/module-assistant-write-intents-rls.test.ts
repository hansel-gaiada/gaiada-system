// T3b — `assistant_write_intents` (migration 0085) RLS: tenant isolation + THE MODULE WALL + the
// composite-FK cascade + the `UNIQUE (tool_call_id)` guard. Mirrors `module-assistant-rls.test.ts`'s
// own pattern byte-for-byte (same fixtures shape, same probes) for the ONE new table this ticket adds.
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

async function withAssistant<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, fn, { modules: ["assistant"] });
}

describe.skipIf(!TEST_URL)("assistant_write_intents RLS + cascade (0085, T3b)", () => {
  let A: string;
  let B: string;
  let owner: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Write-Intents Tenant A", ["assistant"]);
    B = await createCompany("Write-Intents Tenant B", ["assistant"]);
    owner = await createUser("owner@write-intents.test");
  });
  afterAll(teardownTestDb);

  /** A thread + message + tool_call fixture, the intent row's required parents, inserted under the
   *  assistant scope (mirrors the shape the broker's own persist transaction writes). */
  async function makeToolCall(c: PoolClient, tenantId: string): Promise<{ threadId: string; messageId: string; toolCallId: string }> {
    const threadId = newId();
    const messageId = newId();
    const toolCallId = newId();
    await c.query(
      `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, origin_site) VALUES ($1,$2,$3,'wi fixture','central')`,
      [threadId, tenantId, owner],
    );
    await c.query(
      `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site) VALUES ($1,$2,$3,1,'assistant',NULL,'central')`,
      [messageId, tenantId, threadId],
    );
    await c.query(
      `INSERT INTO assistant_tool_calls (id, tenant_id, message_id, tool_name, authority_user_id, origin_site) VALUES ($1,$2,$3,'pm.createTask',$4,'central')`,
      [toolCallId, tenantId, messageId, owner],
    );
    return { threadId, messageId, toolCallId };
  }

  it("FORCE RLS + exactly one FOR-ALL tenant_isolation policy", async () => {
    const forced = await withGlobal((c) =>
      c.query<{ relforcerowsecurity: boolean }>(`SELECT relforcerowsecurity FROM pg_class WHERE relname = 'assistant_write_intents'`),
    );
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
    const policies = await withGlobal((c) =>
      c.query<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'assistant_write_intents'`),
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({ policyname: "tenant_isolation", cmd: "ALL" });
  });

  it("MODULE PROBE: right tenant WITHOUT the assistant scope declared → ZERO rows", async () => {
    const { threadId, messageId, toolCallId } = await withAssistant([A], (c) => makeToolCall(c, A));
    const intentId = newId();
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_write_intents
           (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name, tool_args, impact, expires_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'task-filer','pm.createTask','{"title":"x"}'::jsonb,'high', now() + interval '1 hour', 'central')`,
        [intentId, A, threadId, messageId, toolCallId, owner],
      ),
    );

    const noScope = await withTenants([A], (c) => c.query(`SELECT id FROM assistant_write_intents WHERE id=$1`, [intentId]));
    expect(noScope.rows).toHaveLength(0);

    const withScope = await withAssistant([A], (c) => c.query(`SELECT id FROM assistant_write_intents WHERE id=$1`, [intentId]));
    expect(withScope.rows).toHaveLength(1);
  });

  it("CROSS-TENANT PROBE: an intent filed for A is invisible to B, even with the assistant scope declared", async () => {
    const { threadId, messageId, toolCallId } = await withAssistant([A], (c) => makeToolCall(c, A));
    const intentId = newId();
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_write_intents
           (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name, tool_args, impact, expires_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'task-filer','pm.createTask','{}'::jsonb,'high', now() + interval '1 hour', 'central')`,
        [intentId, A, threadId, messageId, toolCallId, owner],
      ),
    );
    const fromB = await withAssistant([B], (c) => c.query(`SELECT id FROM assistant_write_intents WHERE id=$1`, [intentId]));
    expect(fromB.rows).toHaveLength(0);
  });

  it("UNIQUE (tool_call_id): a second intent for the SAME tool call is rejected", async () => {
    const { threadId, messageId, toolCallId } = await withAssistant([A], (c) => makeToolCall(c, A));
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_write_intents
           (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name, tool_args, impact, expires_at, origin_site)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'task-filer','pm.createTask','{}'::jsonb,'high', now() + interval '1 hour', 'central')`,
        [A, threadId, messageId, toolCallId, owner],
      ),
    );
    await expect(
      withAssistant([A], (c) =>
        c.query(
          `INSERT INTO assistant_write_intents
             (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name, tool_args, impact, expires_at, origin_site)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'task-filer','pm.createTask','{}'::jsonb,'high', now() + interval '1 hour', 'central')`,
          [A, threadId, messageId, toolCallId, owner],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it("deleting the parent thread CASCADEs through messages -> tool_calls -> the write intent (nothing orphaned, admin-visible check)", async () => {
    const { threadId, messageId, toolCallId } = await withAssistant([A], (c) => makeToolCall(c, A));
    const intentId = newId();
    await withAssistant([A], (c) =>
      c.query(
        `INSERT INTO assistant_write_intents
           (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name, tool_args, impact, expires_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'task-filer','pm.createTask','{"title":"x"}'::jsonb,'high', now() + interval '1 hour', 'central')`,
        [intentId, A, threadId, messageId, toolCallId, owner],
      ),
    );
    await withAssistant([A], (c) => c.query(`DELETE FROM assistant_threads WHERE id=$1`, [threadId]));

    const admin = adminPool();
    const after = await admin.query(`SELECT 1 FROM assistant_write_intents WHERE id=$1`, [intentId]);
    expect(after.rows).toHaveLength(0);
  });

  it("CHECK: status only accepts draft|filed|dismissed|expired", async () => {
    const { threadId, messageId, toolCallId } = await withAssistant([A], (c) => makeToolCall(c, A));
    await expect(
      withAssistant([A], (c) =>
        c.query(
          `INSERT INTO assistant_write_intents
             (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name, tool_args, impact, status, expires_at, origin_site)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'task-filer','pm.createTask','{}'::jsonb,'high','proposed', now() + interval '1 hour', 'central')`,
          [A, threadId, messageId, toolCallId, owner],
        ),
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});
