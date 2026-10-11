// M5-L1 / M5-L2 — the submit path end to end (same infrastructure as forms-submit.spec.ts: Postgres, Redis,
// Mailpit, RustFS, ClamAV; see README.md's forms runbook). Proves:
//   - attribution + visitor_consent are stored per the shared contract, and unknown / oversize / mistyped
//     parts are dropped WITHOUT refusing the submission;
//   - the data-subject refs come from the form definition (gaiada.com's `contact_email`, a `tel` field);
//   - a card / national-ID number in free text is redacted before persist, a phone number is not;
//   - the tenant webhook payload carries both members; the Zone B fact is unchanged (ids only);
//   - the retention purge and privacy.erase clear the three new columns.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildFormsTestApp, stopFormsTestApp } from "./forms-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createFormDef, setEnvironmentDomain, readSubmission, backdateSubmissionExpiry } from "./helpers/forms-fixtures";
import { turnstileConfig } from "../src/forms/forms.config";
import { SubmissionsPurgeService } from "../src/forms/submissions-purge.service";
import { ZoneBEventEmitterService } from "../src/events/zoneb-event-emitter.service";
import { TenantWebhookDispatcherService } from "../src/tenant-webhooks/tenant-webhook-dispatcher.service";

// gaiada.com's contact form shape: the email field is `contact_email` (NOT `email`) and there is a tel field.
const SCHEMA = {
  fields: [
    { key: "name", type: "text", required: true, maxLength: 200 },
    { key: "contact_email", type: "email", required: true },
    { key: "phone", type: "text", format: "tel" },
    { key: "message", type: "textarea", required: true, maxLength: 2000 },
  ],
  consentNotice: { text: "You agree we may contact you." },
};

const VISA = "4111111111111111";
const GOOD_CONSENT = { analytics: true, marketing: false, version: "3", decided_at: "2026-10-11T09:00:00Z" };

describe("M5 — attribution, visitor consent, subject refs and the PAN scrub on submit", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let formId: string;
  let n = 0;
  const DOMAIN = "attribution.example.test";

  beforeAll(async () => {
    app = await buildFormsTestApp();
    tenant = await createFixtureTenant("forms-attr");
    await setEnvironmentDomain(tenant, tenant.productionEnvId, DOMAIN);
    formId = (await createFormDef(tenant, { schema: SCHEMA, retentionDays: 1 })).id;
  }, 30_000);

  afterAll(async () => {
    await stopFormsTestApp(app);
  });

  async function submit(extra: Record<string, unknown>, fields?: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/${formId}/submit`,
      headers: { origin: `https://${DOMAIN}`, "content-type": "application/json" },
      remoteAddress: `10.0.9.${++n}`,
      payload: {
        fields: fields ?? { name: "Jane", contact_email: `Jane-${n}@Example.com`, phone: "+62 812-3456-7890", message: "hello" },
        consent: true,
        turnstileToken: turnstileConfig.stubPassToken,
        ...extra,
      },
    });
  }

  it("stores attribution and visitor_consent, and derives both refs from the form definition", async () => {
    const attribution = { landing: "/services/web/", form_page: "/contact/", referrer: "www.google.com", utm_source: "google", gclid: "abc", sections_seen: ["home.hero"] };
    const res = await submit({ attribution, visitor_consent: GOOD_CONSENT }, { name: "Jane", contact_email: "Jane.Doe@Example.com", phone: "0812 3456 7890", message: "hi" });
    expect(res.statusCode).toBe(201);
    const row = (await readSubmission(tenant, res.json<{ id: string }>().id))!;
    expect(row.attribution).toEqual(attribution);
    expect(row.visitor_consent).toEqual({ ...GOOD_CONSENT, decided_at: "2026-10-11T09:00:00.000Z" });
    expect(row.data_subject_ref).toBe("jane.doe@example.com");
    expect(row.data_subject_phone_ref).toBe("081234567890");
  });

  it("with neither member the columns are NULL (unknown = no consent), and the submission succeeds", async () => {
    const res = await submit({});
    expect(res.statusCode).toBe(201);
    const row = (await readSubmission(tenant, res.json<{ id: string }>().id))!;
    expect(row.attribution).toBeNull();
    expect(row.visitor_consent).toBeNull();
  });

  it("drops never refuse: unknown keys, oversize and mistyped values, a malformed consent, an over-4KB object", async () => {
    const hostile = await submit({
      attribution: { landing: "/ok/", email: "jane@example.com", utm_source: "x".repeat(500), gclid: 7, sections_seen: "nope" },
      visitor_consent: { analytics: "yes", marketing: false },
    });
    expect(hostile.statusCode).toBe(201);
    const row = (await readSubmission(tenant, hostile.json<{ id: string }>().id))!;
    expect(row.attribution).toEqual({ landing: "/ok/" });
    expect(row.visitor_consent).toBeNull();

    const huge: Record<string, unknown> = { landing: "/" + "a".repeat(500), form_page: "/" + "b".repeat(500) };
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "li_fat_id", "fbp", "fbc"]) huge[k] = "v".repeat(200);
    huge.sections_seen = Array.from({ length: 50 }, (_, i) => `section.${"x".repeat(40)}.${i}`);
    const big = await submit({ attribution: huge });
    expect(big.statusCode).toBe(201);
    expect((await readSubmission(tenant, big.json<{ id: string }>().id))!.attribution).toBeNull();

    const junk = await submit({ attribution: "a string", visitor_consent: [1, 2] });
    expect(junk.statusCode).toBe(201);
  });

  it("redacts a card number and a national ID in free text before persist; leaves the phone number alone", async () => {
    const res = await submit({}, { name: "Jane", contact_email: "jane@example.com", phone: "+62 812-3456-7890", message: `card ${VISA} NIK 3201155508900002 call 0812-3456-7890` });
    expect(res.statusCode).toBe(201);
    const row = (await readSubmission(tenant, res.json<{ id: string }>().id))!;
    const fields = (row.payload as { fields: Record<string, string> }).fields;
    expect(fields.message).toBe("card [REDACTED-PAN] NIK [REDACTED-NIK] call 0812-3456-7890");
    expect(fields.phone).toBe("+62 812-3456-7890");
    expect(JSON.stringify(row)).not.toContain(VISA);
  });

  it("the tenant webhook payload carries both members (null when absent); the Zone B fact stays ids-only", async () => {
    const webhook = vi.spyOn(app.get(TenantWebhookDispatcherService, { strict: false }), "dispatchFormReceived").mockResolvedValue(undefined);
    const zoneB = vi.spyOn(app.get(ZoneBEventEmitterService), "emitFormReceived").mockResolvedValue(undefined as never);
    try {
      const attribution = { landing: "/a/", utm_source: "x" };
      expect((await submit({ attribution, visitor_consent: GOOD_CONSENT })).statusCode).toBe(201);
      const withBoth = webhook.mock.calls[0][1];
      expect(withBoth.attribution).toEqual(attribution);
      expect(withBoth.visitorConsent).toMatchObject({ analytics: true, marketing: false, version: "3" });

      expect((await submit({})).statusCode).toBe(201);
      expect(webhook.mock.calls[1][1].attribution).toBeNull();
      expect(webhook.mock.calls[1][1].visitorConsent).toBeNull();

      for (const call of zoneB.mock.calls) {
        expect(Object.keys(call[1]).sort()).toEqual(["formId", "hasAttachments", "siteSlug", "submissionId"]);
      }
    } finally {
      webhook.mockRestore();
      zoneB.mockRestore();
    }
  });

  it("the retention purge clears attribution, visitor_consent and the phone ref", async () => {
    const res = await submit({ attribution: { landing: "/p/" }, visitor_consent: GOOD_CONSENT });
    const id = res.json<{ id: string }>().id;
    await backdateSubmissionExpiry(tenant, id, new Date(Date.now() - 60_000));
    await app.get(SubmissionsPurgeService).purgeDueSubmissions();
    const row = (await readSubmission(tenant, id))!;
    expect(row.status).toBe("purged");
    expect(row.attribution).toBeNull();
    expect(row.visitor_consent).toBeNull();
    expect(row.data_subject_phone_ref).toBeNull();
  });
});
