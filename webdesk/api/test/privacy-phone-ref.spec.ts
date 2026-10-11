// M5-L1 — privacy.find / export / erase match on the phone ref as well as the email ref, and erase clears the
// three M5 columns. Same infrastructure as privacy-find-export.spec.ts (throwaway Postgres + RustFS).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildPrivacyTestApp, privacyHeaders } from "./privacy-test-app";
import { createFixtureTenant, insertFormDef, insertSubmission, withTenantRaw } from "./privacy-fixtures";

describe("privacy.* with the phone correlator (M5-L1)", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await buildPrivacyTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  async function seedWithPhone(label: string) {
    const tenant = await createFixtureTenant(label);
    const form = await insertFormDef(tenant, "contact");
    // The field value is deliberately NOT what the identifier will be typed as: only the phone ref can match.
    const id = await insertSubmission(tenant, form, { fields: { name: "Budi", mobile: "0812 3456 7890" }, dataSubjectRef: null });
    await withTenantRaw(tenant.tenantId, (c) =>
      c.query(`UPDATE submissions SET data_subject_phone_ref = '6281234567890', attribution = '{"landing":"/a/"}'::jsonb, visitor_consent = '{"analytics":true,"marketing":false,"version":"3","decided_at":"2026-10-11T09:00:00.000Z"}'::jsonb WHERE id = $1`, [id]),
    );
    return { tenant, id };
  }
  const call = (slug: string, verb: string, identifier: string, scopes: string[], extra: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/privacy/${verb}`, headers: privacyHeaders({ scopes, ws4: randomUUID(), ...extra }), payload: { identifier } });

  it("find matches a phone typed with a plus and punctuation, through the phone ref", async () => {
    const { tenant, id } = await seedWithPhone("phone-find");
    const r = await call(tenant.slug, "find", "+62 812-3456-7890", ["webdesk:operate"]);
    expect(r.statusCode).toBe(201);
    expect(r.json().matches.map((m: { submissionId: string }) => m.submissionId)).toEqual([id]);
  });

  it("find does not cross tenants, and a different number matches nothing", async () => {
    const { tenant } = await seedWithPhone("phone-iso-a");
    const other = await createFixtureTenant("phone-iso-b");
    expect((await call(other.slug, "find", "+62 812-3456-7890", ["webdesk:operate"])).json().matches).toHaveLength(0);
    expect((await call(tenant.slug, "find", "+62 899-0000-0000", ["webdesk:operate"])).json().matches).toHaveLength(0);
  });

  it("export includes attribution and visitorConsent", async () => {
    const { tenant } = await seedWithPhone("phone-export");
    const r = await call(tenant.slug, "export", "+6281234567890", ["webdesk:operate"]);
    expect(r.statusCode).toBe(201);
    const s = r.json().submissions[0];
    expect(s.attribution).toEqual({ landing: "/a/" });
    expect(s.visitorConsent).toMatchObject({ analytics: true, marketing: false });
  });

  it("erase by phone scrubs the row and clears the phone ref, attribution and visitor_consent", async () => {
    const { tenant, id } = await seedWithPhone("phone-erase");
    const r = await call(tenant.slug, "erase", "+62 812-3456-7890", ["webdesk:promote"], { idempotencyKey: randomUUID() });
    expect(r.statusCode).toBe(201);
    expect(r.json().submissionCount).toBe(1);
    const row = await withTenantRaw(tenant.tenantId, async (c) => (await c.query(`SELECT status, payload, data_subject_phone_ref, attribution, visitor_consent FROM submissions WHERE id = $1`, [id])).rows[0]);
    expect(row).toMatchObject({ status: "erased", payload: {}, data_subject_phone_ref: null, attribution: null, visitor_consent: null });
    expect((await call(tenant.slug, "find", "+62 812-3456-7890", ["webdesk:operate"])).json().matches).toHaveLength(0);
  });
});
