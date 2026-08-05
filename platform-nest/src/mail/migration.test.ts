// MAIL-04 — 0077_mail_core.sql applies on a fresh DB (initTestDb() runs the real migration
// runner against a throwaway database — if this file's migration failed to apply, EVERY suite in
// this directory would already be failing at beforeAll; this file additionally pins the DDL's
// constraints directly, since a CHECK/UNIQUE that silently didn't take would otherwise only show
// up as a much later, harder-to-diagnose failure).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
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

  it("mail_log has NO row-level security enabled (global table per §6.1)", async () => {
    const res = await adminPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'mail_log'`,
    );
    expect(res.rows[0].relrowsecurity).toBe(false);
    expect(res.rows[0].relforcerowsecurity).toBe(false);
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
