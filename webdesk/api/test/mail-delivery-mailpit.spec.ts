// WSK-11 — end-to-end delivery against the real dev sink (Mailpit), per the Zone A mail
// doctrine's own A11 evidence-surface convention: scriptable assertions over Mailpit's HTTP API,
// not screenshots. Proves: real rendered messages arrive with correct identity headers for BOTH
// flows the ticket names — "notification + autoresponder flows" — and that per-tenant templates
// actually render (variable substitution, html vs text parts).
process.env.MAIL_PROVIDER = "smtp";
process.env.MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST || "localhost";
process.env.MAIL_SMTP_PORT = process.env.MAIL_SMTP_PORT || "55452";
process.env.MAIL_FROM_ADDRESS = "no-reply@forms.gaiada.invalid";
process.env.MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "Gaiada WebDesk Forms";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55451";
process.env.MAIL_QUEUE_NAME = `mail-delivery-${Date.now()}`;
process.env.MAIL_QUEUE_MAX_ATTEMPTS = "1";
process.env.MAIL_QUEUE_BACKOFF_DELAY_MS = "100";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startMailTestApp, stopMailTestApp } from "./helpers/mail-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createMailTemplate, readMailLogRow } from "./helpers/mail-fixtures";
import { mailpitGetMessage, mailpitReset, waitForMailpitMessage } from "./helpers/mailpit-client";
import { MailService } from "../src/mail/mail.service";

describe("WSK-11 delivery — real Mailpit, correct identity headers, both flows", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let mailService: MailService;

  beforeAll(async () => {
    app = await startMailTestApp();
    mailService = app.get(MailService);
    tenant = await createFixtureTenant("delivery");

    await createMailTemplate(tenant, {
      key: "notify.form-received",
      subject: "New submission on {{siteName}} from {{name}}",
      bodyHtml: "<p>{{name}} &lt;{{email}}&gt; wrote:</p><p>{{message}}</p>",
      bodyText: "{{name}} <{{email}}> wrote:\n{{message}}",
    });
    await createMailTemplate(tenant, {
      key: "autoresponder.form-received",
      subject: "Thanks for reaching out, {{name}}!",
      bodyHtml: "<p>Hi {{name}}, we got your message and will reply soon.</p>",
    });

    await mailpitReset();
  });

  afterAll(async () => {
    await stopMailTestApp(app);
  });

  it("notification flow: From = forms identity, Reply-To = the human submitter (D14)", async () => {
    const staffAddress = `staff-${Date.now()}@example.invalid`;
    const submitterEmail = "jane.doe@theirclient.invalid";

    const result = await mailService.sendNotification({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "notify.form-received",
      to: { email: staffAddress, name: "Staff" },
      submitter: { email: submitterEmail, name: "Jane Doe" },
      variables: { siteName: "Acme Co", name: "Jane Doe", email: submitterEmail, message: "Hello there!" },
    });
    expect(result.status).toBe("queued");

    const summary = await waitForMailpitMessage(`to:${staffAddress}`);
    const detail = await mailpitGetMessage(summary.ID);

    expect(detail.From.Address).toBe("no-reply@forms.gaiada.invalid");
    expect(detail.From.Name).toBe("Gaiada WebDesk Forms");
    expect(detail.ReplyTo).toHaveLength(1);
    expect(detail.ReplyTo[0].Address).toBe(submitterEmail);
    expect(detail.Subject).toBe("New submission on Acme Co from Jane Doe");
    expect(detail.HTML).toContain("Jane Doe &lt;jane.doe@theirclient.invalid&gt; wrote:");
    expect(detail.HTML).toContain("Hello there!");
    expect(detail.Text).toContain("Jane Doe <jane.doe@theirclient.invalid> wrote:");

    const row = await readMailLogRow(tenant, result.mailLogId);
    expect(row?.status).toBe("sent");
    expect(row?.to_address).toBe(staffAddress);
    expect(row?.provider_message_id).toBeTruthy();
    expect(row?.sent_at).toBeTruthy();
  });

  it("autoresponder flow: From = forms identity, NO Reply-To (Zone B hosts no inbound mailbox)", async () => {
    const submitterEmail = `submitter-${Date.now()}@theirclient.invalid`;

    const result = await mailService.sendAutoresponder({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "autoresponder.form-received",
      to: { email: submitterEmail, name: "Jane Doe" },
      variables: { name: "Jane Doe" },
    });
    expect(result.status).toBe("queued");

    const summary = await waitForMailpitMessage(`to:${submitterEmail}`);
    const detail = await mailpitGetMessage(summary.ID);

    expect(detail.From.Address).toBe("no-reply@forms.gaiada.invalid");
    expect(detail.ReplyTo).toHaveLength(0);
    expect(detail.Subject).toBe("Thanks for reaching out, Jane Doe!");
    expect(detail.HTML).toContain("Hi Jane Doe, we got your message");

    const row = await readMailLogRow(tenant, result.mailLogId);
    expect(row?.status).toBe("sent");
  });

  it("html body escapes variables (a hostile form field cannot inject markup)", async () => {
    const to = `escape-${Date.now()}@example.invalid`;
    const hostileMessage = `<img src=x onerror="alert(1)">`;

    await mailService.sendAutoresponder({
      tenantId: tenant.tenantId,
      siteId: tenant.siteId,
      templateKey: "autoresponder.form-received",
      to: { email: to },
      variables: { name: hostileMessage },
    });

    const summary = await waitForMailpitMessage(`to:${to}`);
    const detail = await mailpitGetMessage(summary.ID);

    expect(detail.HTML).not.toContain("<img src=x");
    expect(detail.HTML).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
