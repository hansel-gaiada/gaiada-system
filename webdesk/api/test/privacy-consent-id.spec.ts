// M5-G6 — privacy.find / export / erase by CONSENT ID. A consent id identifies a browser, not a person, but a
// submission can link it to one, so the data subject's rights reach it: find counts the records, export returns
// them, erase deletes them (and nothing else belongs to another tenant). Same infrastructure as
// privacy-phone-ref.spec.ts (throwaway Postgres + RustFS); not run on the Windows dev box, it needs the Linux gate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildPrivacyTestApp, privacyHeaders } from "./privacy-test-app";
import { createFixtureTenant, insertFormDef, insertSubmission, withTenantRaw, type FixtureTenant } from "./privacy-fixtures";

describe("privacy.* by consent id (M5-G6)", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await buildPrivacyTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (slug: string, verb: string, identifier: string, scopes: string[], extra: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/privacy/${verb}`, headers: privacyHeaders({ scopes, ws4: randomUUID(), ...extra }), payload: { identifier } });

  async function seedConsent(t: FixtureTenant, consentId: string, actions: [string, boolean, boolean][]) {
    await withTenantRaw(t.tenantId, async (c) => {
      for (const [action, analytics, marketing] of actions) {
        await c.query(
          `INSERT INTO consent_records (consent_id, tenant_id, site_id, analytics, marketing, notice_version, action, user_agent_class)
           VALUES ($1, $2, $3, $4, $5, '3', $6, 'mobile')`,
          [consentId, t.tenantId, t.siteId, analytics, marketing, action],
        );
      }
    });
  }
  const count = (t: FixtureTenant, consentId: string) =>
    withTenantRaw(t.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM consent_records WHERE consent_id = $1::uuid`, [consentId])).rows[0].n as number);

  const HISTORY: [string, boolean, boolean][] = [["grant", true, true], ["update", true, false], ["withdraw", false, false]];

  it("find reports how many consent records the id has", async () => {
    const t = await createFixtureTenant("cid-find");
    const id = randomUUID();
    await seedConsent(t, id, HISTORY);
    const r = await call(t.slug, "find", id.toUpperCase(), ["webdesk:operate"]);
    expect(r.statusCode).toBe(201);
    expect(r.json().consentRecordCount).toBe(3);
    expect(r.json().matches).toEqual([]);
  });

  it("export returns the whole history, oldest first, with no IP or user agent to return", async () => {
    const t = await createFixtureTenant("cid-export");
    const id = randomUUID();
    await seedConsent(t, id, HISTORY);
    const r = await call(t.slug, "export", id, ["webdesk:operate"]);
    expect(r.statusCode).toBe(201);
    const records = r.json().consentRecords as Record<string, unknown>[];
    expect(records.map((x) => x.action)).toEqual(["grant", "update", "withdraw"]);
    expect(records[0]).toMatchObject({ consentId: id, siteId: t.siteId, analytics: true, marketing: true, noticeVersion: "3", userAgentClass: "mobile" });
    expect(Object.keys(records[0]).sort()).toEqual(["action", "analytics", "consentId", "marketing", "noticeVersion", "recordedAt", "siteId", "userAgentClass"]);
  });

  it("erase deletes the records, reports the count, and a second erase deletes none", async () => {
    const t = await createFixtureTenant("cid-erase");
    const id = randomUUID();
    await seedConsent(t, id, HISTORY);
    const r = await call(t.slug, "erase", id, ["webdesk:promote"], { idempotencyKey: randomUUID() });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ consentRecordCount: 3, submissionCount: 0 });
    expect(await count(t, id)).toBe(0);
    expect((await call(t.slug, "find", id, ["webdesk:operate"])).json().consentRecordCount).toBe(0);
    const again = await call(t.slug, "erase", id, ["webdesk:promote"], { idempotencyKey: randomUUID() });
    expect(again.json().consentRecordCount).toBe(0);
  });

  it("is tenant-scoped: the same consent id under another tenant finds nothing, and its erase leaves the first tenant's records alone", async () => {
    const a = await createFixtureTenant("cid-iso-a");
    const b = await createFixtureTenant("cid-iso-b");
    const id = randomUUID();
    await seedConsent(a, id, HISTORY);
    expect((await call(b.slug, "find", id, ["webdesk:operate"])).json().consentRecordCount).toBe(0); // valid body, valid scope
    expect((await call(b.slug, "export", id, ["webdesk:operate"])).json().consentRecords).toEqual([]);
    const er = await call(b.slug, "erase", id, ["webdesk:promote"], { idempotencyKey: randomUUID() });
    expect(er.statusCode).toBe(201);
    expect(er.json().consentRecordCount).toBe(0);
    expect(await count(a, id)).toBe(3); // untouched
    expect((await call(a.slug, "find", id, ["webdesk:operate"])).json().consentRecordCount).toBe(3); // positive control
  });

  it("an identifier that is not a uuid is exactly as before: no consent keys in any response", async () => {
    const t = await createFixtureTenant("cid-plain");
    const form = await insertFormDef(t, "contact");
    await insertSubmission(t, form, { fields: { name: "Budi" }, dataSubjectRef: "budi@example.com" });
    const f = (await call(t.slug, "find", "budi@example.com", ["webdesk:operate"])).json();
    expect(f.matches).toHaveLength(1);
    expect("consentRecordCount" in f).toBe(false);
    expect("consentRecords" in (await call(t.slug, "export", "budi@example.com", ["webdesk:operate"])).json()).toBe(false);
    const e = (await call(t.slug, "erase", "budi@example.com", ["webdesk:promote"], { idempotencyKey: randomUUID() })).json();
    expect("consentRecordCount" in e).toBe(false);
  });

  it("a consent id that also appears in a submission's visitor_consent: erase by id deletes the records; the submission is reached by its own identifier", async () => {
    const t = await createFixtureTenant("cid-link");
    const id = randomUUID();
    const form = await insertFormDef(t, "contact");
    const sub = await insertSubmission(t, form, { fields: { name: "Jane" }, dataSubjectRef: "jane@example.com" });
    await withTenantRaw(t.tenantId, (c) =>
      c.query(`UPDATE submissions SET visitor_consent = $2::jsonb WHERE id = $1`, [sub, JSON.stringify({ analytics: true, marketing: false, version: "3", decided_at: "2026-10-11T09:00:00.000Z", consentId: id })]),
    );
    await seedConsent(t, id, HISTORY);
    await call(t.slug, "erase", id, ["webdesk:promote"], { idempotencyKey: randomUUID() });
    expect(await count(t, id)).toBe(0);
    // the email erase still clears the submission's snapshot (including the stored consent id)
    await call(t.slug, "erase", "jane@example.com", ["webdesk:promote"], { idempotencyKey: randomUUID() });
    const row = await withTenantRaw(t.tenantId, async (c) => (await c.query(`SELECT visitor_consent FROM submissions WHERE id = $1`, [sub])).rows[0]);
    expect(row.visitor_consent).toBeNull();
  });
});
