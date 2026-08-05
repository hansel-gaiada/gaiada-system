// MAIL-04 — the sender worker. Covers every hard AC bullet: two-concurrent-worker claim sends
// exactly once (FOR UPDATE SKIP LOCKED), backoff math, the 5-attempt cap, auth-stream-first
// ordering, and the send-time suppression re-check. Uses a tiny local fake-SMTP server as the
// Mailpit sink stand-in (see provider.test.ts's header — no server access in this ticket).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { config } from "../config";
import { newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { resetSmtpTransporterCacheForTest } from "./provider";
import { addSuppression } from "./suppressions";
import { claimDueMail, processClaimedMail, sendDueMailOnce, backoffMinutes, MAIL_MAX_ATTEMPTS } from "./sender";
import type { ClaimedMail } from "./types";

interface FakeSmtp {
  port: number;
  rcptCount: number;
  close: () => Promise<void>;
}

function startFakeSmtp(): Promise<FakeSmtp> {
  const state = { rcptCount: 0 };
  return new Promise((resolve) => {
    const server: Server = createServer((socket: Socket) => {
      let buffer = "";
      let inData = false;
      socket.write("220 fake.smtp.test ESMTP\r\n");
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 2.0.0 OK queued\r\n");
            }
            continue;
          }
          const cmd = line.split(" ")[0]?.toUpperCase() ?? "";
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake.smtp.test\r\n250 8BITMIME\r\n");
          else if (cmd === "MAIL") socket.write("250 2.1.0 OK\r\n");
          else if (cmd === "RCPT") {
            state.rcptCount += 1;
            socket.write("250 2.1.5 OK\r\n");
          } else if (cmd === "DATA") {
            inData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (cmd === "QUIT") {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 2.0.0 OK\r\n");
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        get rcptCount() {
          return state.rcptCount;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function insertQueuedRow(overrides: Partial<{
  id: string;
  stream: "notify" | "auth";
  toEmail: string;
  attempts: number;
  nextAttemptAt: string; // SQL expression, e.g. "now()" or "now() - interval '10 seconds'"
}> = {}): Promise<string> {
  const id = overrides.id ?? newId();
  const stream = overrides.stream ?? "notify";
  const toEmail = overrides.toEmail ?? `row-${id}@dev.gaiada.invalid`;
  const attempts = overrides.attempts ?? 0;
  const nextAttemptAtExpr = overrides.nextAttemptAt ?? "now()";
  await adminPool().query(
    `INSERT INTO mail_log (id, stream, to_email, template_key, subject, payload, status, attempts, next_attempt_at, origin_site)
     VALUES ($1, $2, $3, 'approval.actionable', 'placeholder', $4::jsonb, 'queued', $5, ${nextAttemptAtExpr}, 'test')`,
    [id, stream, toEmail, JSON.stringify({ href: "https://erp.gaiada.invalid/x", subjectTitle: "thing" }), attempts],
  );
  return id;
}

async function rowStatus(id: string): Promise<{ status: string; attempts: number; last_error: string | null; provider: string | null }> {
  const { rows } = await adminPool().query(`SELECT status, attempts, last_error, provider FROM mail_log WHERE id = $1`, [id]);
  return rows[0];
}

describe.skipIf(!TEST_URL)("mail/sender", () => {
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
    resetSmtpTransporterCacheForTest();
  });

  it("backoffMinutes is min(2^attempts, 60)", () => {
    expect(backoffMinutes(1)).toBe(2);
    expect(backoffMinutes(2)).toBe(4);
    expect(backoffMinutes(3)).toBe(8);
    expect(backoffMinutes(4)).toBe(16);
    expect(backoffMinutes(5)).toBe(32);
    expect(backoffMinutes(6)).toBe(60); // 2^6=64, capped
    expect(backoffMinutes(10)).toBe(60);
  });

  it("FOR UPDATE SKIP LOCKED: two concurrent claims on one due row hand it to exactly one caller", async () => {
    const id = await insertQueuedRow();
    const [a, b] = await Promise.all([claimDueMail(20), claimDueMail(20)]);
    const claimedIds = [...a, ...b].map((r) => r.id);
    expect(claimedIds).toEqual([id]); // exactly one of the two calls got it, never both, never neither
  });

  it("two concurrent sender sweeps against the SAME due row send it exactly once end to end", async () => {
    const fake = await startFakeSmtp();
    config.mail.enabled = true;
    config.mail.streams.notify.relay.host = "127.0.0.1";
    config.mail.streams.notify.relay.port = fake.port;
    config.mail.streams.notify.relay.user = "";
    config.mail.streams.notify.relay.password = "";
    resetSmtpTransporterCacheForTest();
    try {
      const id = await insertQueuedRow();
      const [claimedA, claimedB] = await Promise.all([sendDueMailOnce(20), sendDueMailOnce(20)]);
      expect(claimedA + claimedB).toBe(1); // exactly one sweep claimed the row
      expect(fake.rcptCount).toBe(1); // exactly one SMTP transaction reached the wire
      const after = await rowStatus(id);
      expect(after.status).toBe("sent");
      expect(after.attempts).toBe(1); // not double-incremented
    } finally {
      await fake.close();
      resetSmtpTransporterCacheForTest();
    }
  });

  it("auth-stream rows sort before notify-stream rows even when the notify row is MORE overdue", async () => {
    const notifyId = await insertQueuedRow({ stream: "notify", nextAttemptAt: "now() - interval '10 seconds'" });
    const authId = await insertQueuedRow({ stream: "auth", nextAttemptAt: "now()" });
    const claimed = await claimDueMail(20);
    expect(claimed.map((r) => r.id)).toEqual([authId, notifyId]);
  });

  it("a failed send backs off: attempts increments, status returns to queued, next_attempt_at moves into the future, last_error is recorded", async () => {
    config.mail.enabled = true;
    // Nothing listens here — send fails fast with ECONNREFUSED, no real network dependency.
    config.mail.streams.notify.relay.host = "127.0.0.1";
    config.mail.streams.notify.relay.port = 1;
    config.mail.streams.notify.relay.user = "";
    config.mail.streams.notify.relay.password = "";
    resetSmtpTransporterCacheForTest();
    const id = await insertQueuedRow({ attempts: 0 });
    const claimed = (await claimDueMail(1))[0] as ClaimedMail;
    const outcome = await processClaimedMail(claimed);
    expect(outcome).toBe("retry");
    const after = await adminPool().query(
      `SELECT status, attempts, last_error, next_attempt_at > now() AS scheduled_future FROM mail_log WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("queued");
    expect(after.rows[0].attempts).toBe(1);
    expect(after.rows[0].last_error).toBeTruthy();
    expect(after.rows[0].scheduled_future).toBe(true);
  });

  it("caps at 5 attempts: the 5th failure moves the row to 'failed', not another retry", async () => {
    config.mail.enabled = true;
    config.mail.streams.notify.relay.host = "127.0.0.1";
    config.mail.streams.notify.relay.port = 1; // refused
    config.mail.streams.notify.relay.user = "";
    config.mail.streams.notify.relay.password = "";
    resetSmtpTransporterCacheForTest();
    const id = await insertQueuedRow({ attempts: MAIL_MAX_ATTEMPTS - 1 });
    const claimed = (await claimDueMail(1))[0] as ClaimedMail;
    expect(claimed.attempts).toBe(MAIL_MAX_ATTEMPTS - 1);
    const outcome = await processClaimedMail(claimed);
    expect(outcome).toBe("failed");
    const after = await rowStatus(id);
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(MAIL_MAX_ATTEMPTS);
  });

  it("send-time suppression re-check: a suppression added AFTER enqueue still blocks the send with zero adapter calls", async () => {
    const fake = await startFakeSmtp();
    config.mail.enabled = true;
    config.mail.streams.notify.relay.host = "127.0.0.1";
    config.mail.streams.notify.relay.port = fake.port;
    config.mail.streams.notify.relay.user = "";
    config.mail.streams.notify.relay.password = "";
    resetSmtpTransporterCacheForTest();
    try {
      const toEmail = "raced@dev.gaiada.invalid";
      const id = await insertQueuedRow({ toEmail });
      const client = await adminPool().connect();
      try {
        await addSuppression(client, toEmail, "*", "manual");
      } finally {
        client.release();
      }
      const claimed = (await claimDueMail(1))[0] as ClaimedMail;
      const outcome = await processClaimedMail(claimed);
      expect(outcome).toBe("suppressed");
      expect(fake.rcptCount).toBe(0); // zero adapter calls reached the wire
      const after = await rowStatus(id);
      expect(after.status).toBe("suppressed");
    } finally {
      await fake.close();
      resetSmtpTransporterCacheForTest();
    }
  });
});
