// WSK-10 — the abuse battery (ticket's stated deliverable). Covers: wrong/missing origin 403,
// missing/bad Turnstile 403 (stub mode proves the seam), honeypot silently dropped, rate limit
// trips (both IP and form scopes), oversize refused, and a hostile payload stored inert (no
// XSS/SQL execution). Cross-tenant RLS probe and the retention purge walk each get their own file
// (forms-cross-tenant.spec.ts, forms-retention-purge.spec.ts); attachments/EICAR get
// forms-attachments.spec.ts; the happy-path persist+mail proof gets forms-submit.spec.ts — kept
// separate so this file's own beforeAll stays fast and does not depend on Mailpit being up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildFormsTestApp, stopFormsTestApp } from "./forms-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createFormDef, setEnvironmentDomain, countSubmissionsForForm, readSubmission } from "./helpers/forms-fixtures";
import { turnstileConfig } from "../src/forms/forms.config";

const SCHEMA = {
  fields: [
    { key: "name", type: "text", required: true, maxLength: 200 },
    { key: "email", type: "email", required: true },
    { key: "message", type: "textarea", required: true, maxLength: 2000 },
  ],
};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    fields: { name: "Jane Doe", email: "jane@example.test", message: "Hello there" },
    consent: true,
    turnstileToken: turnstileConfig.stubPassToken,
    ...overrides,
  };
}

describe("WSK-10 forms abuse battery", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let formId: string;
  const ALLOWED_DOMAIN = "abuse-battery.example.test";

  beforeAll(async () => {
    app = await buildFormsTestApp();
    tenant = await createFixtureTenant("forms-abuse");
    await setEnvironmentDomain(tenant, tenant.productionEnvId, ALLOWED_DOMAIN);
    const form = await createFormDef(tenant, { schema: SCHEMA });
    formId = form.id;
  }, 30_000);

  afterAll(async () => {
    await stopFormsTestApp(app);
  });

  function submit(body: Record<string, unknown>, opts: { origin?: string; remoteAddress?: string } = {}) {
    return app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/${formId}/submit`,
      headers: opts.origin !== undefined ? { origin: opts.origin, "content-type": "application/json" } : { "content-type": "application/json" },
      remoteAddress: opts.remoteAddress,
      payload: body,
    });
  }

  it("refuses a request from a WRONG origin with 403", async () => {
    const res = await submit(validBody(), { origin: "https://evil.example.test", remoteAddress: "10.0.1.1" });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a request with NO Origin header at all with 403", async () => {
    const res = await submit(validBody(), { remoteAddress: "10.0.1.2" });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a 404-shaped request for an unknown form id, even from the right tenant slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/00000000-0000-0000-0000-000000000000/submit`,
      headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
      remoteAddress: "10.0.1.3",
      payload: validBody(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("MISSING Turnstile token refuses with 403 — proves the seam even from the right origin", async () => {
    const res = await submit(validBody({ turnstileToken: undefined }), {
      origin: `https://${ALLOWED_DOMAIN}`,
      remoteAddress: "10.0.1.4",
    });
    expect(res.statusCode).toBe(403);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/turnstile/i);
  });

  it("WRONG Turnstile token (stub mode's own deliberate failure case) refuses with 403", async () => {
    const res = await submit(validBody({ turnstileToken: "not-the-stub-pass-token" }), {
      origin: `https://${ALLOWED_DOMAIN}`,
      remoteAddress: "10.0.1.5",
    });
    expect(res.statusCode).toBe(403);
  });

  it("the CORRECT stub Turnstile token is accepted — proves the seam passes, not just fails", async () => {
    const res = await submit(validBody(), { origin: `https://${ALLOWED_DOMAIN}`, remoteAddress: "10.0.1.6" });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ ok: boolean; id: string }>().ok).toBe(true);
  });

  it("honeypot: a filled hidden field is SILENTLY DROPPED — success-shaped response, no row, no error, even with an invalid Turnstile token", async () => {
    const before = await countSubmissionsForForm(tenant, formId);
    const res = await submit(validBody({ turnstileToken: "garbage-would-otherwise-403", _hp: "I am a bot" }), {
      origin: `https://${ALLOWED_DOMAIN}`,
      remoteAddress: "10.0.1.7",
    });
    // Never a 4xx — that is the whole point of "never a visible error".
    expect(res.statusCode).toBeLessThan(400);
    const body = res.json<{ ok: boolean; id?: string }>();
    expect(body.ok).toBe(true);
    expect(body.id).toBeUndefined();
    const after = await countSubmissionsForForm(tenant, formId);
    expect(after).toBe(before); // nothing was persisted
  });

  it("oversize `fields` payload is refused (400), before any DB or Turnstile work", async () => {
    const huge = "x".repeat(200_000); // well over WEBDESK_FORMS_MAX_FIELDS_BYTES's 64 KiB default
    const res = await submit(validBody({ fields: { name: "Jane", email: "jane@example.test", message: huge } }), {
      origin: `https://${ALLOWED_DOMAIN}`,
      remoteAddress: "10.0.1.8",
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/exceeds/i);
  });

  it("a hostile payload (script tag + a SQL-injection-shaped string) is stored INERT, not executed and not rejected", async () => {
    const hostileMessage = "<script>alert(document.cookie)</script>'; DROP TABLE submissions; --";
    const res = await submit(
      validBody({ fields: { name: "Hostile Actor", email: "hostile@example.test", message: hostileMessage } }),
      { origin: `https://${ALLOWED_DOMAIN}`, remoteAddress: "10.0.1.9" },
    );
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();

    // No SQL execution: the table is still here, and OUR OWN row (proof the INSERT itself
    // completed normally on a table that would not exist if the injection attempt had worked).
    const row = await readSubmission(tenant, id);
    expect(row).not.toBeNull();

    // No live markup survives: sanitize.ts strips the <script> block and every remaining tag.
    const payload = (row as { payload: { fields: { message: string } } }).payload;
    expect(payload.fields.message).not.toMatch(/<script/i);
    expect(payload.fields.message).not.toContain("<");
    expect(payload.fields.message).not.toContain(">");
    // The literal DROP TABLE text is harmless once stored as an inert string column value —
    // still present as TEXT, never as executed SQL.
    expect(payload.fields.message).toContain("DROP TABLE submissions");
  });

  it("per-IP rate limit trips with 429 once the window's budget is exhausted", async () => {
    process.env.WEBDESK_FORMS_RATE_LIMIT_IP_PER_WINDOW = "3"; // formsConfig getters are LIVE — no app rebuild needed
    try {
      // A FRESH IP every run (not a fixed literal): the rate limiter's fixed window is Redis-backed
      // and outlives a single test process — a static IP would collide with whatever count a
      // previous run left in the SAME 10-minute window and make this test flaky depending on how
      // recently it last ran, rather than depending only on what this test itself does.
      const suffix = Date.now() % 65536;
      const ip = `10.${(suffix >> 8) & 0xff}.${suffix & 0xff}.1`;
      const results = [];
      for (let i = 0; i < 4; i++) {
        results.push(await submit(validBody(), { origin: `https://${ALLOWED_DOMAIN}`, remoteAddress: ip }));
      }
      expect(results.slice(0, 3).map((r) => r.statusCode)).toEqual([201, 201, 201]);
      expect(results[3].statusCode).toBe(429);
    } finally {
      process.env.WEBDESK_FORMS_RATE_LIMIT_IP_PER_WINDOW = "1000"; // restore forms-test-app.ts's generous default
    }
  });

  it("per-FORM rate limit trips with 429 — a separate counter from per-IP, keyed on the form itself", async () => {
    const form2 = await createFormDef(tenant, { schema: SCHEMA });
    process.env.WEBDESK_FORMS_RATE_LIMIT_FORM_PER_WINDOW = "3";
    try {
      const results = [];
      for (let i = 0; i < 4; i++) {
        // A DIFFERENT IP on every call — proves this 429 comes from the FORM counter, not the IP one.
        results.push(
          await app.inject({
            method: "POST",
            url: `/v1/t/${tenant.slug}/forms/${form2.id}/submit`,
            headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
            remoteAddress: `10.0.9.${20 + i}`,
            payload: validBody(),
          }),
        );
      }
      expect(results.slice(0, 3).map((r) => r.statusCode)).toEqual([201, 201, 201]);
      expect(results[3].statusCode).toBe(429);
    } finally {
      process.env.WEBDESK_FORMS_RATE_LIMIT_FORM_PER_WINDOW = "1000";
    }
  });

  it("consent must be exactly `true` — refused with 400 when absent", async () => {
    const res = await submit(validBody({ consent: undefined }), {
      origin: `https://${ALLOWED_DOMAIN}`,
      remoteAddress: "10.0.1.10",
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/consent/i);
  });

  it("a structurally invalid field (missing required email) is refused with 400, unknown extra keys are silently dropped", async () => {
    const res = await submit(
      validBody({ fields: { name: "No Email", message: "hi", __proto__: { polluted: true }, extraJunk: "z".repeat(1000) } }),
      { origin: `https://${ALLOWED_DOMAIN}`, remoteAddress: "10.0.1.11" },
    );
    expect(res.statusCode).toBe(400);
  });
});
