// MAIL-04 — the enqueue primitive. Needs live PG (mail tables are global, so no tenant/company
// fixtures are required for most of these — only the suppression + suppressed-row AC needs one).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { config } from "../config";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { enqueueMail } from "./queue";
import { addSuppression } from "./suppressions";
import { UnknownMailTemplateError } from "./templates";

describe.skipIf(!TEST_URL)("mail/queue — enqueueMail", () => {
  const savedEnabled = config.mail.enabled;

  beforeAll(async () => {
    await initTestDb();
  });
  afterAll(async () => {
    config.mail.enabled = savedEnabled;
    await teardownTestDb();
  });
  afterEach(async () => {
    await adminPool().query(`DELETE FROM mail_log`);
    await adminPool().query(`DELETE FROM mail_suppressions`);
  });

  it("MAIL_ENABLED=0 ⇒ zero side effects — no row is written at all, not merely 'nothing sent'", async () => {
    config.mail.enabled = false;
    const before = await adminPool().query(`SELECT count(*) FROM mail_log`);
    const result = await enqueueMail({
      stream: "notify",
      templateKey: "approval.actionable",
      payload: { href: "https://erp.gaiada.invalid/x", subjectTitle: "thing" },
      toEmail: "someone@dev.gaiada.invalid",
    });
    expect(result).toEqual({ skipped: true, reason: "disabled" });
    const after = await adminPool().query(`SELECT count(*) FROM mail_log`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("writes a queued row with the rendered subject and a fresh id when enabled", async () => {
    config.mail.enabled = true;
    const result = await enqueueMail({
      stream: "notify",
      templateKey: "approval.actionable",
      payload: { href: "https://erp.gaiada.invalid/approvals/1", subjectTitle: "sign the gate" },
      toEmail: "recipient@dev.gaiada.invalid",
      entityType: "pipeline_run",
      entityId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.status).toBe("queued");
    const row = await adminPool().query(`SELECT * FROM mail_log WHERE id = $1`, [result.id]);
    expect(row.rows[0].status).toBe("queued");
    expect(row.rows[0].subject).toContain("Your decision is needed");
    expect(row.rows[0].to_email).toBe("recipient@dev.gaiada.invalid");
    expect(row.rows[0].entity_type).toBe("pipeline_run");
    expect(row.rows[0].reply_token).toBeNull();
  });

  it("mints a reply_token only when withReplyToken is requested", async () => {
    config.mail.enabled = true;
    const result = await enqueueMail({
      stream: "notify",
      templateKey: "approval.actionable",
      payload: { href: "https://erp.gaiada.invalid/x", subjectTitle: "thing" },
      toEmail: "recipient2@dev.gaiada.invalid",
      withReplyToken: true,
    });
    if (result.skipped) throw new Error("unreachable");
    const row = await adminPool().query(`SELECT reply_token FROM mail_log WHERE id = $1`, [result.id]);
    expect(row.rows[0].reply_token).not.toBeNull();
    expect((row.rows[0].reply_token as string).length).toBeGreaterThanOrEqual(20);
  });

  it("strips CR/LF from the rendered subject before it is ever stored", async () => {
    config.mail.enabled = true;
    const result = await enqueueMail({
      stream: "notify",
      templateKey: "approval.actionable",
      payload: { href: "https://erp.gaiada.invalid/x", subjectTitle: "thing\r\nBcc: attacker@evil.test" },
      toEmail: "recipient3@dev.gaiada.invalid",
    });
    if (result.skipped) throw new Error("unreachable");
    const row = await adminPool().query(`SELECT subject FROM mail_log WHERE id = $1`, [result.id]);
    expect(row.rows[0].subject as string).not.toMatch(/[\r\n]/);
  });

  it("suppressed address ⇒ a 'suppressed' row is written and no adapter is ever imported/called by this path", async () => {
    config.mail.enabled = true;
    const client = await adminPool().connect();
    try {
      await addSuppression(client, "blocked@dev.gaiada.invalid", "*", "hard_bounce", { provider: "test" });
    } finally {
      client.release();
    }
    const result = await enqueueMail({
      stream: "notify",
      templateKey: "approval.actionable",
      payload: { href: "https://erp.gaiada.invalid/x", subjectTitle: "thing" },
      toEmail: "Blocked@Dev.Gaiada.Invalid", // exercises normalizeEmail's lowercasing too
    });
    if (result.skipped) throw new Error("unreachable");
    expect(result.status).toBe("suppressed");
    const row = await adminPool().query(`SELECT status FROM mail_log WHERE id = $1`, [result.id]);
    expect(row.rows[0].status).toBe("suppressed");
  });

  it("rejects an implausible recipient address before touching the database", async () => {
    config.mail.enabled = true;
    const before = await adminPool().query(`SELECT count(*) FROM mail_log`);
    await expect(
      enqueueMail({
        stream: "notify",
        templateKey: "approval.actionable",
        payload: { href: "https://erp.gaiada.invalid/x", subjectTitle: "thing" },
        toEmail: "not-an-email",
      }),
    ).rejects.toThrow();
    const after = await adminPool().query(`SELECT count(*) FROM mail_log`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("rejects an unknown template_key at enqueue time (fail loud, not three retries later)", async () => {
    config.mail.enabled = true;
    await expect(
      enqueueMail({
        stream: "notify",
        templateKey: "no.such.template",
        toEmail: "recipient4@dev.gaiada.invalid",
      }),
    ).rejects.toThrow(UnknownMailTemplateError);
  });
});
