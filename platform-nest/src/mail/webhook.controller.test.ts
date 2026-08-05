// MAIL-04 — POST /api/mail/webhooks/brevo. Token auth, idempotency, and 204-on-unknown.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";

const TOKEN = "webhook-test-token-value";
const WRONG_TOKEN = "wrong";

async function insertSentRow(providerMessageId: string): Promise<string> {
  const id = newId();
  await adminPool().query(
    `INSERT INTO mail_log (id, stream, to_email, template_key, subject, payload, status, provider, provider_message_id, origin_site)
     VALUES ($1, 'notify', $2, 'approval.actionable', 'placeholder', '{}'::jsonb, 'sent', 'smtp', $3, 'test')`,
    [id, `sent-${id}@dev.gaiada.invalid`, providerMessageId],
  );
  return id;
}

describe.skipIf(!TEST_URL)("mail webhook — POST /api/mail/webhooks/brevo", () => {
  let app: NestFastifyApplication;
  const savedToken = config.mail.webhookToken;

  beforeAll(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterAll(async () => {
    config.mail.webhookToken = savedToken;
    await app.close();
    await teardownTestDb();
  });
  afterEach(async () => {
    await adminPool().query(`DELETE FROM mail_log`);
    await adminPool().query(`DELETE FROM mail_suppressions`);
  });

  it("401s with no token header, and 401s with a wrong token — fail-closed even before any DB lookup", async () => {
    config.mail.webhookToken = TOKEN;
    const noToken = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", payload: { event: "delivered", "message-id": "x" },
    });
    const wrongToken = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": WRONG_TOKEN },
      payload: { event: "delivered", "message-id": "x" },
    });
    expect(noToken.statusCode).toBe(401);
    expect(wrongToken.statusCode).toBe(401);
  });

  it("FAIL-CLOSED when MAIL_WEBHOOK_TOKEN is unset — refuses even a caller presenting an empty token", async () => {
    config.mail.webhookToken = "";
    const res = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": "" },
      payload: { event: "delivered", "message-id": "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("204s on an unknown provider_message_id (no matching mail_log row) — never an error", async () => {
    config.mail.webhookToken = TOKEN;
    const res = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": TOKEN },
      payload: { event: "delivered", "message-id": "no-such-message-id" },
    });
    expect(res.statusCode).toBe(204);
  });

  it("204s and logs on an unknown event shape (missing event/message-id) — never a 5xx", async () => {
    config.mail.webhookToken = TOKEN;
    const res = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": TOKEN },
      payload: { foo: "bar" },
    });
    expect(res.statusCode).toBe(204);
  });

  it("marks a matched row delivered", async () => {
    config.mail.webhookToken = TOKEN;
    const id = await insertSentRow("msg-delivered-1");
    const res = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": TOKEN },
      payload: { event: "delivered", "message-id": "msg-delivered-1" },
    });
    expect(res.statusCode).toBe(204);
    const row = await adminPool().query(`SELECT status, delivered_at FROM mail_log WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("delivered");
    expect(row.rows[0].delivered_at).not.toBeNull();
  });

  it("is idempotent: the SAME delivered event posted twice leaves the row in the identical terminal state", async () => {
    config.mail.webhookToken = TOKEN;
    const id = await insertSentRow("msg-delivered-2");
    const first = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": TOKEN },
      payload: { event: "delivered", "message-id": "msg-delivered-2" },
    });
    const rowAfterFirst = await adminPool().query(`SELECT status, delivered_at FROM mail_log WHERE id = $1`, [id]);
    const second = await app.inject({
      method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": TOKEN },
      payload: { event: "delivered", "message-id": "msg-delivered-2" },
    });
    const rowAfterSecond = await adminPool().query(`SELECT status, delivered_at FROM mail_log WHERE id = $1`, [id]);
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect(rowAfterSecond.rows[0].status).toBe("delivered");
    // The second post is a true no-op — delivered_at is unchanged, not re-stamped with a later time.
    expect(rowAfterSecond.rows[0].delivered_at).toEqual(rowAfterFirst.rows[0].delivered_at);
  });

  it("hard_bounce marks the row bounced AND writes exactly one suppression row, even if replayed", async () => {
    config.mail.webhookToken = TOKEN;
    const id = await insertSentRow("msg-bounce-1");
    const toEmailRow = await adminPool().query(`SELECT to_email FROM mail_log WHERE id = $1`, [id]);
    const toEmail = toEmailRow.rows[0].to_email as string;

    for (let i = 0; i < 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({
        method: "POST", url: "/api/mail/webhooks/brevo", headers: { "x-gaiada-mail-webhook-token": TOKEN },
        payload: { event: "hard_bounce", "message-id": "msg-bounce-1" },
      });
      // eslint-disable-next-line no-await-in-loop
      expect(res.statusCode).toBe(204);
    }
    const row = await adminPool().query(`SELECT status FROM mail_log WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("bounced");
    const suppressions = await adminPool().query(`SELECT count(*) FROM mail_suppressions WHERE email = $1`, [toEmail.toLowerCase()]);
    expect(Number(suppressions.rows[0].count)).toBe(1);
  });
});
