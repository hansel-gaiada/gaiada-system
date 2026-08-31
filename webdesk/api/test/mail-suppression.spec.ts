// WSK-11 — "a suppressed address must never be delivered to, and that must be tested" (ticket
// brief). Proves BOTH checkpoints independently: the fast-fail at enqueue (mail_log row lands
// 'suppressed', no queue job created) and the authoritative one in the worker (a suppression
// added AFTER enqueue but before the job runs still blocks delivery) — see mail.service.ts /
// mail-sender.processor.ts headers for why there are two.
process.env.MAIL_PROVIDER = "smtp";
process.env.MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST || "localhost";
process.env.MAIL_SMTP_PORT = process.env.MAIL_SMTP_PORT || "55452";
process.env.MAIL_FROM_ADDRESS = "no-reply@forms.gaiada.invalid";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55451";
process.env.MAIL_QUEUE_NAME = `mail-suppression-${Date.now()}`;
process.env.MAIL_QUEUE_MAX_ATTEMPTS = "1";
process.env.MAIL_QUEUE_BACKOFF_DELAY_MS = "100";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startMailTestApp, stopMailTestApp } from "./helpers/mail-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createMailTemplate, insertSuppression, readMailLogRow } from "./helpers/mail-fixtures";
import { assertNoMailpitMessage, mailpitReset, waitForMailpitMessage } from "./helpers/mailpit-client";
import { MailService } from "../src/mail/mail.service";

describe("WSK-11 suppression — blocks delivery before every send", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let mailService: MailService;

  beforeAll(async () => {
    app = await startMailTestApp();
    mailService = app.get(MailService);
    tenant = await createFixtureTenant("suppression");
    await createMailTemplate(tenant, {
      key: "notify.suppression-test",
      subject: "New submission from {{name}}",
      bodyHtml: "<p>{{name}} says {{message}}</p>",
    });
    await mailpitReset();
  });

  afterAll(async () => {
    await stopMailTestApp(app);
  });

  it("checkpoint 1 (enqueue-time): a pre-existing suppression writes mail_log 'suppressed' and never queues a job", async () => {
    const suppressedAddress = `blocked-${Date.now()}@example.invalid`;
    await insertSuppression(tenant, suppressedAddress, "bounce");

    const result = await mailService.sendNotification({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "notify.suppression-test",
      to: { email: suppressedAddress },
      submitter: { email: "customer@example.invalid" },
      variables: { name: "Someone", message: "hi" },
    });

    expect(result.status).toBe("suppressed");
    const row = await readMailLogRow(tenant, result.mailLogId);
    expect(row?.status).toBe("suppressed");

    // The real proof: Mailpit (the real SMTP sink) never receives anything for this address.
    await assertNoMailpitMessage(`to:${suppressedAddress}`, 2_000);
  });

  it("a NON-suppressed address in the same run receives mail normally (the mechanism differentiates)", async () => {
    const okAddress = `allowed-${Date.now()}@example.invalid`;

    const result = await mailService.sendNotification({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "notify.suppression-test",
      to: { email: okAddress },
      submitter: { email: "customer@example.invalid" },
      variables: { name: "Someone", message: "hi" },
    });

    expect(result.status).toBe("queued");
    const summary = await waitForMailpitMessage(`to:${okAddress}`);
    expect(summary).toBeTruthy();

    const row = await readMailLogRow(tenant, result.mailLogId);
    expect(row?.status).toBe("sent");
  });

  it("checkpoint 2 (worker-time, authoritative): a suppression added AFTER enqueue still blocks the send", async () => {
    const raceAddress = `race-${Date.now()}@example.invalid`;

    // Pause the queue FIRST so there is a guaranteed (not merely probable) window between
    // "job enqueued" and "worker picks it up" to insert the suppression into — otherwise this
    // test would be racing BullMQ's own job-pickup latency, which is not something to depend on
    // for a security property. `queue` is MailService's own public field; pausing/resuming it is
    // ordinary BullMQ API, not a test-only hook added to production code.
    await mailService.queue.pause();

    const result = await mailService.sendNotification({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "notify.suppression-test",
      to: { email: raceAddress },
      submitter: { email: "customer@example.invalid" },
      variables: { name: "Someone", message: "hi" },
    });
    expect(result.status).toBe("queued"); // not suppressed YET at enqueue time — the queue is
    // paused, so this is provably true rather than a lucky timing window.

    // Insert the suppression while the queue is still paused — this is the exact window
    // checkpoint 1 (enqueue-time) cannot cover.
    await insertSuppression(tenant, raceAddress, "manual");

    await mailService.queue.resume();

    // Give the worker time to pick the job back up and process it (it re-checks suppression
    // immediately before send).
    await new Promise((r) => setTimeout(r, 2_000));

    const row = await readMailLogRow(tenant, result.mailLogId);
    expect(row?.status).toBe("suppressed");
    await assertNoMailpitMessage(`to:${raceAddress}`, 1_000);
  });
});
