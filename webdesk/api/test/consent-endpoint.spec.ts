// M5-G6 — POST /v1/t/:tenantSlug/consent against the real app (Postgres, Redis, Mailpit, RustFS, ClamAV: the forms
// infrastructure; NOT run on the Windows dev box, it needs the Linux gate). Proves: the strict allow-list (unknown
// keys dropped, a bad uuid replaced by a minted one, wrong types refused, a size cap), the per-tenant Origin
// allowlist and CORS, the Redis rate limit failing closed, no cookie, nothing personal stored, the table being
// append-only for the runtime role, cross-tenant isolation with VALID bodies (so validation never pre-empts the
// authorisation outcome), and the consent id travelling onto a form submission.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asApp, asMigrator, buildConsentTestApp, readConsent } from "./consent-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createFormDef, readSubmission, setEnvironmentDomain } from "./helpers/forms-fixtures";
import { turnstileConfig } from "../src/forms/forms.config";
import { ConsentModule } from "../src/consent/consent.module";
import { FormRateLimitService } from "../src/forms/form-rate-limit.service";

const DOMAIN_A = "consent-a.example.test";
const DOMAIN_B = "consent-b.example.test";
const GOOD = { analytics: true, marketing: false, version: "3" };
const UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

describe("M5-G6 — the consent log endpoint", () => {
  let app: NestFastifyApplication;
  let A: FixtureTenant;
  let B: FixtureTenant;
  let n = 0;
  const ip = () => `10.5.${Math.floor(Math.random() * 250)}.${++n % 250}`; // a fresh bucket per call

  beforeAll(async () => {
    app = await buildConsentTestApp();
    A = await createFixtureTenant("consent-a");
    B = await createFixtureTenant("consent-b");
    await setEnvironmentDomain(A, A.productionEnvId, DOMAIN_A);
    await setEnvironmentDomain(B, B.productionEnvId, DOMAIN_B);
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  const post = (tenant: FixtureTenant, payload: unknown, opts: { origin?: string | null; ua?: string; remoteAddress?: string } = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/consent`,
      headers: {
        "content-type": "application/json",
        ...(opts.origin === null ? {} : { origin: opts.origin ?? `https://${DOMAIN_A}` }),
        ...(opts.ua ? { "user-agent": opts.ua } : {}),
      },
      remoteAddress: opts.remoteAddress ?? ip(),
      payload: payload as never,
    });

  it("a first decision without a consent id: 201, the server mints one, one row is stored for the right site", async () => {
    const res = await post(A, GOOD, { ua: UA_PHONE });
    expect(res.statusCode).toBe(201);
    const { consentId, ...rest } = res.json<{ consentId: string }>();
    expect(rest).toEqual({});
    expect(isUuid(consentId)).toBe(true);
    const rows = await readConsent(A.tenantId, consentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ analytics: true, marketing: false, notice_version: "3", action: "grant", user_agent_class: "mobile", site_id: A.siteId });
    expect(new Date(rows[0].recorded_at).getTime()).toBeGreaterThan(Date.now() - 60_000); // server clock
  });

  it("sets NO cookie and stores no IP / raw user agent anywhere in the row", async () => {
    const res = await post(A, GOOD, { ua: UA_PHONE, remoteAddress: "10.77.66.55" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    const rows = await readConsent(A.tenantId, res.json<{ consentId: string }>().consentId);
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain("10.77.66.55");
    expect(blob).not.toContain("iPhone");
    expect(blob).not.toContain("AppleWebKit");
    expect(Object.keys(rows[0]).sort()).toEqual(["action", "analytics", "consent_id", "id", "marketing", "notice_version", "recorded_at", "site_id", "tenant_id", "user_agent_class"]);
  });

  it("a supplied consent id is kept, and every later decision appends to its history", async () => {
    const consentId = randomUUID();
    const r1 = await post(A, { ...GOOD, consentId, action: "grant" });
    const r2 = await post(A, { consentId, analytics: false, marketing: true, version: "4", action: "update" });
    const r3 = await post(A, { consentId, analytics: true, marketing: true, version: "4", action: "withdraw" });
    for (const r of [r1, r2, r3]) expect(r.json().consentId).toBe(consentId);
    const rows = await readConsent(A.tenantId, consentId);
    expect(rows.map((r) => r.action)).toEqual(["grant", "update", "withdraw"]);
    expect(rows[1]).toMatchObject({ analytics: false, marketing: true, notice_version: "4" });
    // a withdraw withdraws everything whatever the body said
    expect(rows[2]).toMatchObject({ analytics: false, marketing: false });
  });

  it("unknown keys are dropped, never stored and never an error", async () => {
    const res = await post(A, { ...GOOD, ip: "9.9.9.9", email: "x@y.co", userAgent: "x", extra: { a: 1 } });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json())).toEqual(["consentId"]);
    const blob = JSON.stringify(await readConsent(A.tenantId, res.json().consentId));
    expect(blob).not.toContain("9.9.9.9");
    expect(blob).not.toContain("x@y.co");
  });

  it("a malformed consent id is replaced by a minted one (never an error, never stored as sent)", async () => {
    const res = await post(A, { ...GOOD, consentId: "not-a-uuid" });
    expect(res.statusCode).toBe(201);
    const id = res.json<{ consentId: string }>().consentId;
    expect(id).not.toBe("not-a-uuid");
    expect(isUuid(id)).toBe(true);
    expect(await readConsent(A.tenantId, id)).toHaveLength(1);
  });

  it("wrong types, a bad version and a bad action are 400; consent is never coerced", async () => {
    for (const body of [{ ...GOOD, analytics: "true" }, { ...GOOD, marketing: 1 }, { analytics: true, marketing: true }, { ...GOOD, version: "" }, { ...GOOD, version: "x".repeat(33) }, { ...GOOD, action: "delete" }]) {
      const res = await post(A, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("a body over the 2 KiB cap is 413", async () => {
    const res = await post(A, { ...GOOD, padding: "x".repeat(4000) });
    expect(res.statusCode).toBe(413);
  });

  it("a missing, unlisted or other-tenant Origin is 403 (with a VALID body), an unknown tenant 404", async () => {
    expect((await post(A, GOOD, { origin: null })).statusCode).toBe(403);
    expect((await post(A, GOOD, { origin: "https://evil.example.test" })).statusCode).toBe(403);
    expect((await post(A, GOOD, { origin: `https://${DOMAIN_B}` })).statusCode).toBe(403); // B's domain on A's URL
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/no-such-tenant-${randomUUID().slice(0, 8)}/consent`,
      headers: { origin: `https://${DOMAIN_A}`, "content-type": "application/json" },
      remoteAddress: ip(),
      payload: GOOD,
    });
    expect(res.statusCode).toBe(404);
  });

  it("the preflight answers 204 with CORS headers for an allowed origin and 403 otherwise", async () => {
    const ok = await app.inject({ method: "OPTIONS", url: `/v1/t/${A.slug}/consent`, headers: { origin: `https://${DOMAIN_A}`, "access-control-request-method": "POST" }, remoteAddress: ip() });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(`https://${DOMAIN_A}`);
    expect(ok.headers["access-control-allow-methods"]).toContain("POST");
    const no = await app.inject({ method: "OPTIONS", url: `/v1/t/${A.slug}/consent`, headers: { origin: "https://evil.example.test" }, remoteAddress: ip() });
    expect(no.statusCode).toBe(403);
  });

  it("cross-tenant: tenant B's post lands in B only; A cannot see it; B posting with A's origin is refused", async () => {
    const own = await post(B, GOOD, { origin: `https://${DOMAIN_B}` });
    expect(own.statusCode).toBe(201);
    const id = own.json<{ consentId: string }>().consentId;
    expect(await readConsent(B.tenantId, id)).toHaveLength(1); // positive control
    expect(await readConsent(A.tenantId, id)).toHaveLength(0); // invisible from A
    expect((await post(B, GOOD, { origin: `https://${DOMAIN_A}` })).statusCode).toBe(403);
    // and the same consent id posted to tenant A makes a SEPARATE history there (ids are not global)
    const sameIdOnA = await post(A, { ...GOOD, consentId: id });
    expect(sameIdOnA.statusCode).toBe(201);
    expect(await readConsent(A.tenantId, id)).toHaveLength(1);
    expect(await readConsent(B.tenantId, id)).toHaveLength(1);
  });

  it("rate limit: the per-IP window trips with 429", async () => {
    const saved = process.env.WEBDESK_CONSENT_RATE_LIMIT_IP_PER_WINDOW;
    process.env.WEBDESK_CONSENT_RATE_LIMIT_IP_PER_WINDOW = "3"; // live getter: no rebuild needed
    try {
      const address = `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // fresh window key
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await post(A, GOOD, { remoteAddress: address })).statusCode);
      expect(codes).toEqual([201, 201, 201, 429, 429]);
      // another client is unaffected
      expect((await post(A, GOOD)).statusCode).toBe(201);
    } finally {
      if (saved === undefined) delete process.env.WEBDESK_CONSENT_RATE_LIMIT_IP_PER_WINDOW;
      else process.env.WEBDESK_CONSENT_RATE_LIMIT_IP_PER_WINDOW = saved;
    }
  });

  it("rate limit fails CLOSED: an unreachable limiter is 503 and nothing is stored", async () => {
    const limiter = app.select(ConsentModule).get(FormRateLimitService, { strict: true });
    const spy = vi.spyOn(limiter, "consume").mockRejectedValue(new Error("redis down"));
    try {
      const consentId = randomUUID();
      const res = await post(A, { ...GOOD, consentId });
      expect(res.statusCode).toBe(503);
      expect(await readConsent(A.tenantId, consentId)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("append-only: the runtime role may not UPDATE a record, and may not touch another tenant's rows", async () => {
    const res = await post(A, GOOD);
    const id = res.json<{ consentId: string }>().consentId;
    await expect(asApp(A.tenantId, (c) => c.query(`UPDATE consent_records SET analytics = NOT analytics WHERE consent_id = $1::uuid`, [id]))).rejects.toMatchObject({ code: "42501" });
    // unchanged
    expect((await readConsent(A.tenantId, id))[0].analytics).toBe(true);
    // B's context cannot delete A's rows (0 rows matched), and A's row survives
    const deleted = await asApp(B.tenantId, (c) => c.query(`DELETE FROM consent_records WHERE consent_id = $1::uuid`, [id]));
    expect(deleted.rowCount).toBe(0);
    expect(await readConsent(A.tenantId, id)).toHaveLength(1);
  });

  describe("the consent id travels onto a form submission", () => {
    const SCHEMA = { fields: [{ key: "name", type: "text", required: true, maxLength: 200 }] };
    let formId: string;
    beforeAll(async () => {
      formId = (await createFormDef(A, { schema: SCHEMA })).id;
    });
    const submit = (visitorConsent: unknown) =>
      app.inject({
        method: "POST",
        url: `/v1/t/${A.slug}/forms/${formId}/submit`,
        headers: { origin: `https://${DOMAIN_A}`, "content-type": "application/json" },
        remoteAddress: ip(),
        payload: { fields: { name: "Jane" }, consent: true, turnstileToken: turnstileConfig.stubPassToken, visitor_consent: visitorConsent },
      });

    it("a uuid consentId inside visitor_consent is stored with the snapshot", async () => {
      const consentId = (await post(A, GOOD)).json<{ consentId: string }>().consentId;
      const res = await submit({ ...GOOD, decided_at: "2026-10-11T09:00:00Z", consentId });
      expect(res.statusCode).toBe(201);
      const row = (await readSubmission(A, res.json<{ id: string }>().id)) as { visitor_consent: Record<string, unknown> };
      expect(row.visitor_consent).toMatchObject({ analytics: true, marketing: false, version: "3", consentId });
    });

    it("a malformed consentId is dropped, the snapshot and the submission are kept", async () => {
      const res = await submit({ ...GOOD, decided_at: "2026-10-11T09:00:00Z", consentId: "nope", ip: "1.2.3.4" });
      expect(res.statusCode).toBe(201);
      const row = (await readSubmission(A, res.json<{ id: string }>().id)) as { visitor_consent: Record<string, unknown> };
      expect(row.visitor_consent).toMatchObject({ analytics: true, marketing: false });
      expect(row.visitor_consent).not.toHaveProperty("consentId");
      expect(row.visitor_consent).not.toHaveProperty("ip");
    });
  });
});
