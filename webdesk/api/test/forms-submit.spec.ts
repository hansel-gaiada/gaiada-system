// WSK-10 — "a valid submit persists AND enqueues mail" (ticket AC) + the consent-record proof
// (WSK-D22c). Needs a REAL Mailpit (not just a mail_log row) so the assertion is "mail was
// actually delivered", the same evidence-surface discipline WSK-11's own mail-delivery-mailpit.spec.ts
// uses — see README.md's forms runbook for the exact container this file needs up.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildFormsTestApp, stopFormsTestApp } from "./forms-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createFormDef, createMailTemplateForForm, setEnvironmentDomain, readSubmission } from "./helpers/forms-fixtures";
import { waitForMailpitMessage } from "./helpers/mailpit-client";
import { turnstileConfig } from "../src/forms/forms.config";
import { ZoneBEventEmitterService } from "../src/events/zoneb-event-emitter.service";

const SCHEMA = {
  fields: [
    { key: "name", type: "text", required: true, maxLength: 200 },
    { key: "email", type: "email", required: true },
    { key: "message", type: "textarea", required: true, maxLength: 2000 },
  ],
  consentNotice: { text: "You agree we may contact you about your enquiry." },
};

describe("WSK-10 — a valid submission persists, records consent, and enqueues mail", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let formId: string;
  const ALLOWED_DOMAIN = "submit-happy.example.test";
  const STAFF_EMAIL = "staff-forms-happy@example.test";

  beforeAll(async () => {
    app = await buildFormsTestApp();
    tenant = await createFixtureTenant("forms-submit");
    await setEnvironmentDomain(tenant, tenant.productionEnvId, ALLOWED_DOMAIN);
    await createMailTemplateForForm(tenant, {
      key: "form-notification",
      subject: "New enquiry from {{name}}",
      bodyHtml: "<p>{{name}} ({{email}}) says: {{message}}</p>",
    });
    await createMailTemplateForForm(tenant, {
      key: "form-autoresponder",
      subject: "Thanks, {{name}}!",
      bodyHtml: "<p>We received your message and will reply soon.</p>",
    });
    const form = await createFormDef(tenant, {
      schema: SCHEMA,
      notify: {
        to: { email: STAFF_EMAIL, name: "Forms Inbox" },
        templateKey: "form-notification",
        autoresponder: true,
        autoresponderTemplateKey: "form-autoresponder",
      },
      consentNoticeVersion: "v3-2026-08-26",
    });
    formId = form.id;
  }, 30_000);

  afterAll(async () => {
    await stopFormsTestApp(app);
  });

  it("persists the submission, stamps the consent record, and enqueues BOTH the staff notification and the autoresponder", async () => {
    const submitterEmail = `submitter-${Date.now()}@example.test`;
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/${formId}/submit`,
      headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
      remoteAddress: "10.0.5.1",
      payload: {
        fields: { name: "Real Submitter", email: submitterEmail, message: "I would like a quote." },
        consent: true,
        turnstileToken: turnstileConfig.stubPassToken,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ ok: boolean; id: string }>();
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();

    const row = await readSubmission(tenant, body.id);
    expect(row).not.toBeNull();
    expect(row!).toMatchObject({
      status: "received",
      consent_notice_version: "v3-2026-08-26",
      consent_notice_text: "You agree we may contact you about your enquiry.",
    });
    expect(row!.expires_at).toBeTruthy();
    expect(new Date(row!.expires_at as string).getTime()).toBeGreaterThan(Date.now());
    expect((row!.data_subject_ref as string)).toBe(submitterEmail.toLowerCase());

    // D14: From: is ours, Reply-To: the human submitter — the staff notification.
    const staffMessage = await waitForMailpitMessage(`to:${STAFF_EMAIL}`, { timeoutMs: 15_000 });
    expect(staffMessage).toBeTruthy();

    // The autoresponder — TO the submitter, no Reply-To (mail.service.ts's own `sendAutoresponder`
    // never sets one).
    const autoMessage = await waitForMailpitMessage(`to:${submitterEmail}`, { timeoutMs: 15_000 });
    expect(autoMessage).toBeTruthy();
  }, 30_000);

  it("a form with no `notify.to` configured still persists the submission — mail is best-effort, not load-bearing for the HTTP response", async () => {
    const bareForm = await createFormDef(tenant, { schema: SCHEMA }); // notify: {} (default)
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/${bareForm.id}/submit`,
      headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
      remoteAddress: "10.0.5.2",
      payload: {
        fields: { name: "No Notify", email: "no-notify@example.test", message: "hello" },
        consent: true,
        turnstileToken: turnstileConfig.stubPassToken,
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("emits form.received with the tenant's Zone A company id (tenants.company_ref), never the internal tenants.id", async () => {
    // The ERP intake refuses an envelope whose tenantId is not its route's companies.id, so the internal
    // id made every form.received a dropped event (found 2026-10-11, M3).
    const migrator = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk" });
    await migrator.connect();
    let companyRef: string;
    try {
      await migrator.query("BEGIN");
      await migrator.query("SET LOCAL webdesk.platform_ctx = 'true'");
      companyRef = (await migrator.query<{ company_ref: string }>("SELECT company_ref FROM tenants WHERE id = $1", [tenant.tenantId])).rows[0].company_ref;
      await migrator.query("COMMIT");
    } finally {
      await migrator.end();
    }
    expect(companyRef).not.toBe(tenant.tenantId);

    const spy = vi.spyOn(app.get(ZoneBEventEmitterService), "emitFormReceived");
    try {
      const res = await app.inject({
        method: "POST",
        url: `/v1/t/${tenant.slug}/forms/${formId}/submit`,
        headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
        remoteAddress: "10.0.5.3",
        payload: {
          fields: { name: "Zone B Check", email: "zoneb-check@example.test", message: "company ref please" },
          consent: true,
          turnstileToken: turnstileConfig.stubPassToken,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(companyRef);
      expect(spy.mock.calls[0][0]).not.toBe(tenant.tenantId);
    } finally {
      spy.mockRestore();
    }
  });
});
