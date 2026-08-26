// WSK-11 — "per-tenant templates rendered under RLS" (ticket brief). Two tenants each define a
// template with the SAME key but different content; sending under tenant A's context must render
// ONLY tenant A's template — proving mail_templates' FORCE RLS + tenant_isolation policy
// (0004_mail.sql) is actually in effect through the full MailService path, not just reachable in
// principle.
process.env.MAIL_PROVIDER = "smtp";
process.env.MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST || "localhost";
process.env.MAIL_SMTP_PORT = process.env.MAIL_SMTP_PORT || "55452";
process.env.MAIL_FROM_ADDRESS = "no-reply@forms.gaiada.invalid";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55451";
process.env.MAIL_QUEUE_NAME = `mail-template-rls-${Date.now()}`;
process.env.MAIL_QUEUE_MAX_ATTEMPTS = "1";
process.env.MAIL_QUEUE_BACKOFF_DELAY_MS = "100";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startMailTestApp, stopMailTestApp } from "./helpers/mail-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createMailTemplate } from "./helpers/mail-fixtures";
import { mailpitGetMessage, mailpitReset, waitForMailpitMessage } from "./helpers/mailpit-client";
import { MailService } from "../src/mail/mail.service";
import { MailTemplatesService } from "../src/mail/mail-templates.service";

describe("WSK-11 per-tenant templates render under RLS", () => {
  let app: NestFastifyApplication;
  let tenantA: FixtureTenant;
  let tenantB: FixtureTenant;
  let mailService: MailService;
  let templatesService: MailTemplatesService;

  const SHARED_KEY = "notify.same-key-both-tenants";

  beforeAll(async () => {
    app = await startMailTestApp();
    mailService = app.get(MailService);
    templatesService = app.get(MailTemplatesService);

    tenantA = await createFixtureTenant("rls-a");
    tenantB = await createFixtureTenant("rls-b");

    await createMailTemplate(tenantA, {
      key: SHARED_KEY,
      subject: "Tenant A subject for {{name}}",
      bodyHtml: "<p>TENANT A ONLY: {{name}}</p>",
    });
    await createMailTemplate(tenantB, {
      key: SHARED_KEY,
      subject: "Tenant B subject for {{name}}",
      bodyHtml: "<p>TENANT B ONLY: {{name}}</p>",
    });

    await mailpitReset();
  });

  afterAll(async () => {
    await stopMailTestApp(app);
  });

  it("sending under tenant A's context renders ONLY tenant A's template", async () => {
    const to = `rls-a-${Date.now()}@example.invalid`;
    await mailService.sendAutoresponder({
      tenantId: tenantA.tenantId,
      siteId: tenantA.siteId,
      templateKey: SHARED_KEY,
      to: { email: to },
      variables: { name: "Alice" },
    });

    const summary = await waitForMailpitMessage(`to:${to}`);
    const detail = await mailpitGetMessage(summary.ID);

    expect(detail.Subject).toBe("Tenant A subject for Alice");
    expect(detail.HTML).toContain("TENANT A ONLY");
    expect(detail.HTML).not.toContain("TENANT B ONLY");
  });

  it("sending under tenant B's context renders ONLY tenant B's template — never leaks tenant A's", async () => {
    const to = `rls-b-${Date.now()}@example.invalid`;
    await mailService.sendAutoresponder({
      tenantId: tenantB.tenantId,
      siteId: tenantB.siteId,
      templateKey: SHARED_KEY,
      to: { email: to },
      variables: { name: "Bob" },
    });

    const summary = await waitForMailpitMessage(`to:${to}`);
    const detail = await mailpitGetMessage(summary.ID);

    expect(detail.Subject).toBe("Tenant B subject for Bob");
    expect(detail.HTML).toContain("TENANT B ONLY");
    expect(detail.HTML).not.toContain("TENANT A ONLY");
  });

  it("a direct template lookup under tenant A's context cannot see tenant B's row even by matching site_id spoofing", async () => {
    // Even if a caller (bug or otherwise) supplied tenant B's site_id while tenant A's GUC is
    // active, RLS must still return nothing for a site_id that does not belong to the active
    // tenant — the app-layer site_id filter and RLS are independent layers (WSK-D16 doctrine).
    const { DbService } = await import("../src/db/db.service");
    const db = app.get(DbService);
    const found = await db.withTenant(tenantA.tenantId, () =>
      templatesService.findBySiteAndKey(tenantB.siteId, SHARED_KEY),
    );
    expect(found).toBeNull();
  });
});
