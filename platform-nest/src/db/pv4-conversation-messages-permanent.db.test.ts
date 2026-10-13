// PV4-11 — migration 202610132145_pv4_conversation_messages_permanent.sql, proven against a REAL Postgres.
// Ruling PV-D34 (owner, 2026-10-13): a conversation message is permanent; a correction is a new message.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-11).
//
// The guard is a pair of row triggers: UPDATE is always refused, DELETE is refused unless the transaction set
// app.conversation_purge = 'on' (the operator escape hatch: erasure or test teardown, never application code).
// Both are exercised as the NOSUPERUSER NOBYPASSRLS app role (what the application really connects as) and, for the
// "even the owner" claim, through adminPool. Needs DATABASE_URL_TEST: the Linux gate. A skipped run proves nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient } from "../testing/fixtures";

const SQLSTATE = "PD034";
const MESSAGE = /conversation messages are permanent \(PV-D34\)/;

describe.skipIf(!TEST_URL)("PV4-11 — conversation messages are permanent (DB guard)", () => {
  let A: string;
  let user: string;
  let thread: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("PV4-11 Tenant");
    user = await createUser("pv4-11-user@schema.test");
    const client = await createClient(A, "PV4-11 Client");
    thread = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, created_by, created_side, origin_site)
         VALUES ($1, $2, $3, NULL, $4, 'staff', 'test')`,
        [thread, A, client, user],
      ),
    );
  }, 120_000);
  afterAll(teardownTestDb);

  async function message(body = `permanent ${++seq}`): Promise<string> {
    const id = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO conversation_messages (id, tenant_id, thread_id, author_id, author_side, body, origin_site)
         VALUES ($1, $2, $3, $4, 'staff', $5, 'test')`,
        [id, A, thread, user, body],
      ),
    );
    return id;
  }
  const row = async (id: string) =>
    (await adminPool().query(`SELECT body, edited_at, retracted_at FROM conversation_messages WHERE id = $1`, [id])).rows[0];

  /** Run `fn` and assert it fails with the guard's SQLSTATE and message. */
  async function refused(fn: () => Promise<unknown>): Promise<void> {
    let err: { code?: string; message?: string } | undefined;
    try { await fn(); } catch (e) { err = e as { code?: string; message?: string }; }
    expect(err, "the statement must be refused").toBeDefined();
    expect(err?.code).toBe(SQLSTATE);
    expect(err?.message).toMatch(MESSAGE);
  }

  it("both triggers exist, are enabled, and are row-level BEFORE UPDATE / BEFORE DELETE", async () => {
    const r = await adminPool().query<{ tgname: string; tgenabled: string; tgtype: number }>(
      `SELECT tgname, tgenabled, tgtype FROM pg_trigger
        WHERE tgrelid = 'conversation_messages'::regclass AND NOT tgisinternal AND tgname LIKE 'trg_conversation_messages_no_%'
        ORDER BY tgname`,
    );
    expect(r.rows).toEqual([
      { tgname: "trg_conversation_messages_no_delete", tgenabled: "O", tgtype: 1 + 2 + 8 },
      { tgname: "trg_conversation_messages_no_update", tgenabled: "O", tgtype: 1 + 2 + 16 },
    ]);
  });

  it("UPDATE of the body is refused (SQLSTATE PD034), as the app role and as the owner, and the row is unchanged", async () => {
    const id = await message("original words");
    await refused(() => withTenants([A], (c) => c.query(`UPDATE conversation_messages SET body = 'rewritten' WHERE id = $1`, [id])));
    await refused(() => adminPool().query(`UPDATE conversation_messages SET body = 'rewritten by owner' WHERE id = $1`, [id]));
    expect(await row(id)).toMatchObject({ body: "original words", edited_at: null, retracted_at: null });
  });

  it("UPDATE of ANY column is refused, including the retired edited_at / retracted_at and a no-op update", async () => {
    const id = await message("fixed");
    await refused(() => withTenants([A], (c) => c.query(`UPDATE conversation_messages SET edited_at = now() WHERE id = $1`, [id])));
    await refused(() => withTenants([A], (c) => c.query(`UPDATE conversation_messages SET retracted_at = now() WHERE id = $1`, [id])));
    await refused(() => withTenants([A], (c) => c.query(`UPDATE conversation_messages SET body = body WHERE id = $1`, [id])));
    expect(await row(id)).toMatchObject({ body: "fixed", edited_at: null, retracted_at: null });
  });

  it("DELETE is refused (SQLSTATE PD034), as the app role and as the owner, and the row survives", async () => {
    const id = await message();
    await refused(() => withTenants([A], (c) => c.query(`DELETE FROM conversation_messages WHERE id = $1`, [id])));
    await refused(() => adminPool().query(`DELETE FROM conversation_messages WHERE id = $1`, [id]));
    expect(await row(id)).toBeDefined();
  });

  it("DELETE with SET LOCAL app.conversation_purge = 'on' succeeds (the operator escape hatch)", async () => {
    const id = await message();
    await withTenants([A], async (c) => {
      await c.query(`SET LOCAL app.conversation_purge = 'on'`);
      const r = await c.query(`DELETE FROM conversation_messages WHERE id = $1`, [id]);
      expect(r.rowCount).toBe(1);
    });
    expect(await row(id)).toBeUndefined();
  });

  it("the hatch is transaction-local, opens DELETE only, and any value other than 'on' keeps the guard shut", async () => {
    const a = await message();
    const b = await message();
    // The hatch from the previous transaction is gone: a fresh transaction is refused again.
    await refused(() => withTenants([A], (c) => c.query(`DELETE FROM conversation_messages WHERE id = $1`, [a])));
    // 'off', 'true', '' and '1' are not 'on'.
    for (const v of ["off", "true", "", "1"]) {
      await refused(() => withTenants([A], async (c) => {
        await c.query(`SELECT set_config('app.conversation_purge', $1, true)`, [v]);
        await c.query(`DELETE FROM conversation_messages WHERE id = $1`, [a]);
      }));
    }
    // UPDATE has no hatch: the purge flag does not let a message be rewritten.
    await refused(() => withTenants([A], async (c) => {
      await c.query(`SET LOCAL app.conversation_purge = 'on'`);
      await c.query(`UPDATE conversation_messages SET body = 'rewritten under the hatch' WHERE id = $1`, [b]);
    }));
    expect(await row(a)).toMatchObject({ edited_at: null });
    expect((await row(b)).body).not.toBe("rewritten under the hatch");
  });

  it("posting (INSERT) is unaffected, and so is touching the thread a message sits in", async () => {
    const id = await message("a new message");
    expect(await row(id)).toMatchObject({ body: "a new message" });
    await withTenants([A], (c) => c.query(`UPDATE conversation_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`, [thread]));
  });
});
