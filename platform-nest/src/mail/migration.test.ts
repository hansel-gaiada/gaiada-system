// MAIL-04 — 0077_mail_core.sql applies on a fresh DB (initTestDb() runs the real migration
// runner against a throwaway database — if this file's migration failed to apply, EVERY suite in
// this directory would already be failing at beforeAll; this file additionally pins the DDL's
// constraints directly, since a CHECK/UNIQUE that silently didn't take would otherwise only show
// up as a much later, harder-to-diagnose failure).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withMailContext } from "../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";

describe.skipIf(!TEST_URL)("0077_mail_core.sql — constraints", () => {
  beforeAll(async () => {
    await initTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("mail_log.stream CHECK rejects anything outside {notify, auth}", async () => {
    await expect(
      adminPool().query(
        `INSERT INTO mail_log (id, stream, to_email, template_key, subject, status, origin_site)
         VALUES ($1, 'bogus', 'x@dev.gaiada.invalid', 'approval.actionable', 's', 'queued', 'test')`,
        [newId()],
      ),
    ).rejects.toThrow();
  });

  it("mail_log.status CHECK rejects anything outside the documented enum", async () => {
    await expect(
      adminPool().query(
        `INSERT INTO mail_log (id, stream, to_email, template_key, subject, status, origin_site)
         VALUES ($1, 'notify', 'x@dev.gaiada.invalid', 'approval.actionable', 's', 'bogus', 'test')`,
        [newId()],
      ),
    ).rejects.toThrow();
  });

  it("mail_log.reply_token is UNIQUE (two rows cannot share a VERP token)", async () => {
    const token = `tok-${newId()}`;
    await adminPool().query(
      `INSERT INTO mail_log (id, stream, to_email, template_key, subject, status, reply_token, origin_site)
       VALUES ($1, 'notify', 'a@dev.gaiada.invalid', 'approval.actionable', 's', 'queued', $2, 'test')`,
      [newId(), token],
    );
    await expect(
      adminPool().query(
        `INSERT INTO mail_log (id, stream, to_email, template_key, subject, status, reply_token, origin_site)
         VALUES ($1, 'notify', 'b@dev.gaiada.invalid', 'approval.actionable', 's', 'queued', $2, 'test')`,
        [newId(), token],
      ),
    ).rejects.toThrow();
  });

  it("mail_suppressions UNIQUE (email, stream) rejects a duplicate pair", async () => {
    await adminPool().query(
      `INSERT INTO mail_suppressions (id, email, stream, reason) VALUES ($1, 'dup@dev.gaiada.invalid', 'notify', 'manual')`,
      [newId()],
    );
    await expect(
      adminPool().query(
        `INSERT INTO mail_suppressions (id, email, stream, reason) VALUES ($1, 'dup@dev.gaiada.invalid', 'notify', 'manual')`,
        [newId()],
      ),
    ).rejects.toThrow();
  });

  // MAIL-22: mail_log/mail_suppressions/mail_messages are GLOBAL (no tenant partition — auth mail
  // has tenant_id NULL, design §6.1/F2) but, since MAIL-22, still carry FORCE RLS gated on the
  // dedicated `app.mail_context` GUC (mirrors 0015_site_subscriptions_rls.sql's `app.sync_context`
  // pattern for the sync engine). This replaces the earlier "NO RLS at all" assertion, which is now
  // the wrong invariant to test — src/db/rls.test.ts's estate-wide "every tenant-scoped table has
  // FORCE RLS" check is what this restores.
  it("all three mail tables have ENABLE + FORCE row level security (MAIL-22)", async () => {
    const res = await adminPool().query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('mail_log', 'mail_suppressions', 'mail_messages')`,
    );
    expect(res.rows).toHaveLength(3);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname} must ENABLE RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  // MAIL-22 defence-in-depth proof: a connection that never opts into mail context (i.e. the exact
  // mistake the invariant guards against — code that queries these tables through withGlobal/
  // withTenants/a bare connection instead of withMailContext) sees ZERO rows and cannot write any,
  // even though real rows exist (inserted by the superuser adminPool() below, which always bypasses
  // RLS). This is what "restores defence in depth" cashes out to, concretely.
  it("without app.mail_context set, a NOBYPASSRLS connection sees zero mail_log rows and cannot write", async () => {
    const id = newId();
    await adminPool().query(
      `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, status, origin_site)
       VALUES ($1, 'auth', NULL, 'noctx@dev.gaiada.invalid', 'approval.actionable', 's', 'queued', 'test')`,
      [id],
    );
    const seenWithoutContext = await withGlobal((c) => c.query(`SELECT id FROM mail_log WHERE id = $1`, [id]));
    expect(seenWithoutContext.rows).toHaveLength(0);

    await expect(
      withGlobal((c) =>
        c.query(
          `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, status, origin_site)
           VALUES ($1, 'auth', NULL, 'noctx2@dev.gaiada.invalid', 'approval.actionable', 's', 'queued', 'test')`,
          [newId()],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // MAIL-22's other binding requirement: auth mail (tenant_id NULL) must remain FULLY readable and
  // writable by the mail module itself once it opts into context — the whole point of gating on
  // "is this the mail module" rather than on tenant_id is that a NULL tenant_id is not treated
  // specially by the policy at all. Read AND write, through the real wrapper the app code now uses.
  it("with withMailContext, NULL-tenant (auth) mail_log rows are fully readable and writable", async () => {
    const id = newId();
    await withMailContext((c) =>
      c.query(
        `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, status, origin_site)
         VALUES ($1, 'auth', NULL, 'authmail@dev.gaiada.invalid', 'auth.magic_link', 's', 'queued', 'test')`,
        [id],
      ),
    );
    const read = await withMailContext((c) =>
      c.query<{ id: string; tenant_id: string | null; status: string }>(
        `SELECT id, tenant_id, status FROM mail_log WHERE id = $1`,
        [id],
      ),
    );
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0].tenant_id).toBeNull();

    await withMailContext((c) =>
      c.query(`UPDATE mail_log SET status = 'sent', updated_at = now() WHERE id = $1`, [id]),
    );
    const after = await withMailContext((c) => c.query<{ status: string }>(`SELECT status FROM mail_log WHERE id = $1`, [id]));
    expect(after.rows[0].status).toBe("sent");

    // adminPool() (superuser) always bypasses RLS regardless of context, confirming the row is
    // genuinely there and not an artifact of the mail-context connection's own view.
    const viaSuperuser = await adminPool().query(`SELECT status FROM mail_log WHERE id = $1`, [id]);
    expect(viaSuperuser.rows[0].status).toBe("sent");
  });

  it("mail_messages UNIQUE (provider, provider_message_id) rejects a replay", async () => {
    const logRow = await adminPool().query<{ id: string }>(
      `INSERT INTO mail_log (id, stream, to_email, template_key, subject, status, origin_site)
       VALUES ($1, 'notify', 'x@dev.gaiada.invalid', 'approval.actionable', 's', 'sent', 'test') RETURNING id`,
      [newId()],
    );
    const mailLogId = logRow.rows[0].id;
    await adminPool().query(
      `INSERT INTO mail_messages (id, mail_log_id, provider, provider_message_id, from_email, body_text, size_bytes, origin_site)
       VALUES ($1, $2, 'brevo-inbound', 'dup-msg-1', 'a@dev.gaiada.invalid', 'hi', 2, 'test')`,
      [newId(), mailLogId],
    );
    await expect(
      adminPool().query(
        `INSERT INTO mail_messages (id, mail_log_id, provider, provider_message_id, from_email, body_text, size_bytes, origin_site)
         VALUES ($1, $2, 'brevo-inbound', 'dup-msg-1', 'a@dev.gaiada.invalid', 'hi again', 8, 'test')`,
        [newId(), mailLogId],
      ),
    ).rejects.toThrow();
  });
});
