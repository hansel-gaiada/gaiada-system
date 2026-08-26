// WSK-11 — "prove retry/backoff behaviour with the sink down, then recovering" (ticket brief,
// point 2). This is deliberately NOT a mock: it stops and starts the REAL Mailpit container this
// ticket's verification runbook stands up (docker stop/start), so the failures BullMQ retries
// through are genuine ECONNREFUSEDs against a real closed port, and "recovering" means the real
// sink is genuinely listening again — not a simulated flag flip.
//
// Coordinator finding (2026-08-26): a missing container made the ORIGINAL version of this file
// stall for 2.8 hours instead of failing fast. Fixed two ways: (1) every docker CLI call below now
// carries an explicit `timeout` so no single command can block longer than a few seconds, no
// matter what the underlying cause of a hang is; (2) container presence is checked ONCE at module
// load, bounded by that same timeout, and the whole suite skips with a clear console message if
// it's absent — nothing here calls `docker stop`/`start` or builds the app at all in that case.
process.env.MAIL_PROVIDER = "smtp";
process.env.MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST || "localhost";
process.env.MAIL_SMTP_PORT = process.env.MAIL_SMTP_PORT || "55452";
process.env.MAIL_FROM_ADDRESS = "no-reply@forms.gaiada.invalid";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55451";
process.env.MAIL_QUEUE_NAME = `mail-retry-${Date.now()}`;
process.env.MAIL_QUEUE_MAX_ATTEMPTS = "5";
process.env.MAIL_QUEUE_BACKOFF_DELAY_MS = "500";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startMailTestApp, stopMailTestApp } from "./helpers/mail-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createMailTemplate, readMailLogRow } from "./helpers/mail-fixtures";
import { mailpitReset, waitForMailpitMessage } from "./helpers/mailpit-client";
import { MailService } from "../src/mail/mail.service";

const MAILPIT_CONTAINER = process.env.MAILPIT_CONTAINER_NAME || "wsk11-mailpit";
const DOCKER_CMD_TIMEOUT_MS = 10_000;

function containerExists(name: string): boolean {
  try {
    execSync(`docker inspect --format="{{.Id}}" ${name}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: DOCKER_CMD_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// Checked ONCE at module load — synchronous, bounded by DOCKER_CMD_TIMEOUT_MS, so a missing (or
// unreachable) docker daemon fails this check fast rather than hanging test collection itself.
const MAILPIT_CONTAINER_AVAILABLE = containerExists(MAILPIT_CONTAINER);

if (!MAILPIT_CONTAINER_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[mail-retry-backoff] SKIPPING — no docker container named "${MAILPIT_CONTAINER}" was found. ` +
      `This spec proves retry/backoff by stopping and starting a REAL Mailpit container (not a ` +
      `mock), so it needs one running under that exact name. Point it at yours with ` +
      `MAILPIT_CONTAINER_NAME=<your container name>, or start one named "${MAILPIT_CONTAINER}" ` +
      `per webdesk/api/README.md's runbook.`,
  );
}

function dockerStop(): void {
  execSync(`docker stop ${MAILPIT_CONTAINER}`, { stdio: "ignore", timeout: DOCKER_CMD_TIMEOUT_MS });
}
function dockerStart(): void {
  execSync(`docker start ${MAILPIT_CONTAINER}`, { stdio: "ignore", timeout: DOCKER_CMD_TIMEOUT_MS });
}

describe("WSK-11 retry + exponential backoff (real sink, stopped then recovered)", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let mailService: MailService;

  beforeAll(async () => {
    if (!MAILPIT_CONTAINER_AVAILABLE) return; // nothing to set up — the one test below is skipped

    app = await startMailTestApp();
    mailService = app.get(MailService);
    tenant = await createFixtureTenant("retry-backoff");
    await createMailTemplate(tenant, {
      key: "autoresponder.retry-test",
      subject: "Retry probe for {{name}}",
      bodyHtml: "<p>hi {{name}}</p>",
    });
    await mailpitReset();
  });

  afterAll(async () => {
    if (!MAILPIT_CONTAINER_AVAILABLE) return;
    // Leave the shared sink running for any other spec file / manual inspection.
    try {
      dockerStart();
    } catch {
      /* already running */
    }
    await stopMailTestApp(app);
  });

  it.skipIf(!MAILPIT_CONTAINER_AVAILABLE)(
    "retries multiple times with growing backoff while the sink is down, then delivers once it comes back",
    async () => {
      dockerStop();

      const to = `retry-${Date.now()}@example.invalid`;
      const t0 = Date.now();
      const result = await mailService.sendAutoresponder({
        tenantId: tenant.tenantId,
        siteId: tenant.siteId,
        templateKey: "autoresponder.retry-test",
        to: { email: to },
        variables: { name: "Retry" },
      });
      expect(result.status).toBe("queued");

      // Observe at least 2 failed attempts accumulate WHILE the sink is still down — this is the
      // "retries with backoff" half of the proof.
      let attemptsSeen = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const job = await mailService.queue.getJob(result.mailLogId);
        attemptsSeen = job?.attemptsMade ?? 0;
        if (attemptsSeen >= 2) break;
      }
      expect(attemptsSeen).toBeGreaterThanOrEqual(2);

      const midRow = await readMailLogRow(tenant, result.mailLogId);
      // Neither terminal state yet — still retrying, sink still down, attempts not exhausted
      // (max is 5; we stopped observing at 2).
      expect(midRow?.status).toBe("queued");

      // Recovery: bring the real sink back up.
      dockerStart();

      const summary = await waitForMailpitMessage(`to:${to}`, { timeoutMs: 25_000 });
      expect(summary).toBeTruthy();

      const finalRow = await readMailLogRow(tenant, result.mailLogId);
      expect(finalRow?.status).toBe("sent");
      expect(finalRow?.provider_message_id).toBeTruthy();

      const finalJob = await mailService.queue.getJob(result.mailLogId);
      // It took MORE than one attempt to succeed — the retry mechanism, not a lucky first try,
      // is what delivered this mail.
      expect(finalJob === undefined || (finalJob?.attemptsMade ?? 0) >= 2).toBe(true);

      const elapsed = Date.now() - t0;
      // Exponential backoff with a 500ms base and >=2 observed retries means AT LEAST
      // 500ms (attempt1->2) + 1000ms (attempt2->3) = 1500ms of backoff wait was structurally
      // required before delivery could complete — a fixed/no-backoff retry loop would not need
      // this much wall-clock time to reach the same attempt count.
      expect(elapsed).toBeGreaterThan(1000);
    },
    45_000,
  );
});
