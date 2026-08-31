// WSK-11 — "Delivery status written to mail_log (append-only for DELETE; UPDATE is permitted for
// status transitions — check what 0004_mail.sql actually grants and respect it)". 0004_mail.sql
// runs `REVOKE DELETE ON mail_log FROM webdesk_app` while leaving UPDATE granted (the DEFAULT
// PRIVILEGES rule from postgres/init-roles.sh hands webdesk_app SELECT/INSERT/UPDATE/DELETE on
// every new table; this migration claws back only DELETE). This file proves BOTH halves: the real
// send pipeline uses UPDATE for status transitions (queued -> sent, already covered by the
// delivery spec's own mail_log assertions), and a DELETE against mail_log fails at the GRANT
// level for the app role, independent of whether MailLogRepository itself ever issues one.
process.env.MAIL_PROVIDER = "smtp";
process.env.MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST || "localhost";
process.env.MAIL_SMTP_PORT = process.env.MAIL_SMTP_PORT || "55452";
process.env.MAIL_FROM_ADDRESS = "no-reply@forms.gaiada.invalid";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55451";
process.env.MAIL_QUEUE_NAME = `mail-log-immutability-${Date.now()}`;
process.env.MAIL_QUEUE_MAX_ATTEMPTS = "1";
process.env.MAIL_QUEUE_BACKOFF_DELAY_MS = "100";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startMailTestApp, stopMailTestApp } from "./helpers/mail-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { attemptDeleteMailLogAsAppRole, createMailTemplate, readMailLogRow } from "./helpers/mail-fixtures";
import { mailpitReset, waitForMailpitMessage } from "./helpers/mailpit-client";
import { MailService } from "../src/mail/mail.service";

describe("WSK-11 mail_log — UPDATE for status transitions, DELETE refused", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let mailService: MailService;

  beforeAll(async () => {
    app = await startMailTestApp();
    mailService = app.get(MailService);
    tenant = await createFixtureTenant("log-immutability");
    await createMailTemplate(tenant, {
      key: "autoresponder.log-test",
      subject: "Log test for {{name}}",
      bodyHtml: "<p>hi {{name}}</p>",
    });
    await mailpitReset();
  });

  afterAll(async () => {
    await stopMailTestApp(app);
  });

  it("a real send transitions mail_log via UPDATE: queued -> sent (never a second INSERT)", async () => {
    const to = `log-${Date.now()}@example.invalid`;
    const result = await mailService.sendAutoresponder({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "autoresponder.log-test",
      to: { email: to },
      variables: { name: "Logger" },
    });

    const queuedRow = await readMailLogRow(tenant, result.mailLogId);
    expect(queuedRow?.status).toBe("queued");

    await waitForMailpitMessage(`to:${to}`);

    const sentRow = await readMailLogRow(tenant, result.mailLogId);
    expect(sentRow?.status).toBe("sent");
    // Same row id throughout — UPDATE in place, not a new row.
    expect(sentRow?.id).toBe(queuedRow?.id);
  });

  it("DELETE against mail_log is refused for the runtime (app) role — the grant-level claw-back", async () => {
    const to = `log-delete-${Date.now()}@example.invalid`;
    const result = await mailService.sendAutoresponder({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "autoresponder.log-test",
      to: { email: to },
      variables: { name: "Undeletable" },
    });

    // Wait for the job to actually finish (reach Mailpit) BEFORE the delete attempt — this file's
    // afterAll closes the DbService pool immediately after the last test, and an in-flight
    // BullMQ job that hasn't finished yet would otherwise try to touch a closed pool during
    // teardown. Deterministic ordering here, not a race against the worker.
    await waitForMailpitMessage(`to:${to}`);

    const outcome = await attemptDeleteMailLogAsAppRole(tenant, result.mailLogId);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/permission denied/i);

    // The row must still exist afterward — the refusal was real, not a silent no-op DELETE.
    const stillThere = await readMailLogRow(tenant, result.mailLogId);
    expect(stillThere).not.toBeNull();
  });

  it("MailLogRepository itself never issues a DELETE statement (source-level check, belt + suspenders)", () => {
    const contents = readFileSync(
      join(__dirname, "..", "src", "mail", "mail-log.repository.ts"),
      "utf8",
    );
    expect(/DELETE\s+FROM\s+mail_log/i.test(contents)).toBe(false);
  });
});
