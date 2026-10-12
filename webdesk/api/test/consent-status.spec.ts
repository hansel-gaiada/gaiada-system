// M5-V3-a -- consent.status (POST /control/v1/tenants/:tenantSlug/consent/status), end to end on the real AppModule
// with the real Layer-3/4 PDP (content-test-kit.ts) over real Postgres: DB-backed, so it needs the Linux gate (CI),
// not a laptop. Doctrine ("validation pre-empts authz"): every refusal below sends a VALID body; the no-scope and
// cross-tenant cases each have a positive control that sends the same request and succeeds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, type ContentFixture } from "./content-test-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const rh = (scopes: string[] = ["webdesk:read"]) => ({ "x-webdesk-control-principal": "erp-webdesk-control", "x-webdesk-control-scopes": scopes.join(",") });

let app: NestFastifyApplication;
let a: ContentFixture;
let b: ContentFixture;

type Rec = { analytics: boolean; marketing: boolean; action: "grant" | "update" | "withdraw"; version?: string; at: string; rowId?: string };

/** Append consent_records rows (migrator, tenant context set: the table is RLS-forced). */
async function log(fx: ContentFixture, consentId: string, recs: Rec[]) {
  await asTenant(fx.tenantId, async (c) => {
    for (const r of recs) {
      await c.query(
        `INSERT INTO consent_records (id, consent_id, tenant_id, site_id, analytics, marketing, notice_version, action, recorded_at, user_agent_class)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, 'desktop')`,
        [r.rowId ?? null, consentId, fx.tenantId, fx.siteId, r.analytics, r.marketing, r.version ?? "3", r.action, r.at],
      );
    }
  });
}

const url = (fx: ContentFixture) => `/control/v1/tenants/${fx.slug}/consent/status`;
const post = (fx: ContentFixture, body: unknown, scopes?: string[]) => app.inject({ method: "POST", url: url(fx), headers: rh(scopes), payload: body as object });
const idsOf = (r: { json(): { statuses: { consentId: string }[] } }) => r.json().statuses.map((s) => s.consentId);

const grantedThenAnalyticsOff = randomUUID();
const stillGranted = randomUUID();
const withdrawn = randomUUID();
const tied = randomUUID();
const otherTenants = randomUUID();

describe("consent.status", () => {
  beforeAll(async () => {
    app = await buildContentApp();
    a = await createContentFixture("cst-a");
    b = await createContentFixture("cst-b");
    // A grant, then an ANALYTICS-ONLY withdrawal, which the site records as action "update" with analytics:false.
    await log(a, grantedThenAnalyticsOff, [
      { analytics: true, marketing: true, action: "grant", version: "3", at: "2026-10-01T09:00:00Z" },
      { analytics: false, marketing: true, action: "update", version: "4", at: "2026-10-02T09:00:00Z" },
    ]);
    await log(a, stillGranted, [{ analytics: true, marketing: false, action: "grant", version: "3", at: "2026-10-01T09:00:00Z" }]);
    // A full withdrawal inserted BEFORE the earlier grant in row order: recorded_at decides, not insertion order.
    await log(a, withdrawn, [
      { analytics: false, marketing: false, action: "withdraw", at: "2026-10-03T09:00:00Z" },
      { analytics: true, marketing: true, action: "grant", at: "2026-10-01T09:00:00Z" },
    ]);
    // Two rows with the SAME recorded_at: the larger row id wins (recorded_at DESC, id DESC).
    await log(a, tied, [
      { analytics: true, marketing: false, action: "grant", at: "2026-10-04T09:00:00Z", rowId: "00000000-0000-4000-8000-000000000001" },
      { analytics: false, marketing: false, action: "update", at: "2026-10-04T09:00:00Z", rowId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    ]);
    await log(b, otherTenants, [{ analytics: true, marketing: true, action: "grant", at: "2026-10-01T09:00:00Z" }]);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it("returns the LATEST record per id: a grant followed by an update analytics:false reads analytics:false", async () => {
    const r = await post(a, { consentIds: [grantedThenAnalyticsOff] });
    expect(r.statusCode).toBe(200);
    expect(r.json().statuses).toEqual([
      { consentId: grantedThenAnalyticsOff, analytics: false, marketing: true, action: "update", noticeVersion: "4", recordedAt: "2026-10-02T09:00:00.000Z" },
    ]);
  });

  it("recorded_at decides, not insertion order; a tie on recorded_at is broken by the larger row id", async () => {
    const byId = new Map((await post(a, { consentIds: [withdrawn, tied, stillGranted] })).json().statuses.map((s: { consentId: string }) => [s.consentId, s]));
    expect(byId.get(withdrawn)).toMatchObject({ analytics: false, marketing: false, action: "withdraw" });
    expect(byId.get(tied)).toMatchObject({ analytics: false, action: "update" });
    expect(byId.get(stillGranted)).toMatchObject({ analytics: true, marketing: false, action: "grant", noticeVersion: "3" });
  });

  it("answers many ids in one call: one row per id that has a record, none for an id without one", async () => {
    const r = await post(a, { consentIds: [grantedThenAnalyticsOff, stillGranted, randomUUID(), stillGranted.toUpperCase()] });
    expect(r.statusCode).toBe(200);
    expect(idsOf(r).sort()).toEqual([grantedThenAnalyticsOff, stillGranted].sort());
  });

  it("returns only the documented members: no user_agent_class, no row id, no site or tenant id", async () => {
    const s = (await post(a, { consentIds: [stillGranted] })).json().statuses[0];
    expect(Object.keys(s).sort()).toEqual(["action", "analytics", "consentId", "marketing", "noticeVersion", "recordedAt"]);
    expect(JSON.stringify(s)).not.toMatch(/desktop|user_agent|userAgent/i);
  });

  it("CROSS-TENANT: tenant B's consent id asked through tenant A is OMITTED (200, empty), the same as an id that never existed; the positive control through B's own slug returns it", async () => {
    const cross = await post(a, { consentIds: [otherTenants] });
    expect(cross.statusCode).toBe(200);
    expect(cross.json()).toEqual({ statuses: [] });
    expect((await post(a, { consentIds: [randomUUID()] })).json()).toEqual(cross.json());
    const own = await post(b, { consentIds: [otherTenants] });
    expect(own.statusCode).toBe(200);
    expect(own.json().statuses).toMatchObject([{ consentId: otherTenants, analytics: true }]);
    // a mixed call through A returns A's id only
    expect(idsOf(await post(a, { consentIds: [otherTenants, stillGranted] }))).toEqual([stillGranted]);
  });

  it("an unknown tenant slug is a 404", async () => {
    const r = await app.inject({ method: "POST", url: "/control/v1/tenants/no-such-tenant/consent/status", headers: rh(), payload: { consentIds: [stillGranted] } });
    expect(r.statusCode).toBe(404);
  });

  it("siteSlug: the tenant's own slug is accepted, any other is a 404 (no site of this tenant has that name)", async () => {
    expect((await post(a, { siteSlug: a.slug, consentIds: [stillGranted] })).statusCode).toBe(200);
    const bad = await post(a, { siteSlug: b.slug, consentIds: [stillGranted] });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().type).toBe(`${PROBLEM}site-not-found`);
  });

  it("100 ids is fine, 101 is a 400 invalid-request (the 100-id call is the positive control)", async () => {
    const hundred = Array.from({ length: 100 }, () => randomUUID());
    expect((await post(a, { consentIds: hundred })).statusCode).toBe(200);
    const r = await post(a, { consentIds: [...hundred, randomUUID()] });
    expect(r.statusCode).toBe(400);
    expect(r.json().type).toBe(`${PROBLEM}invalid-request`);
  });

  it("refuses a non-uuid id, an empty list, a missing list and an unknown member with 400", async () => {
    for (const body of [{ consentIds: ["nope"] }, { consentIds: [] }, {}, { consentIds: [randomUUID()], extra: 1 }]) {
      expect((await post(a, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("needs webdesk:read: a VALID body without it is 403, the identical body with it is 200; authz runs before validation", async () => {
    const body = { consentIds: [stillGranted] };
    for (const scopes of [["webdesk:operate", "webdesk:promote", "webdesk:keys"], []]) {
      expect((await post(a, body, scopes)).statusCode).toBe(403);
    }
    expect((await post(a, body, ["webdesk:read"])).statusCode).toBe(200);
    // an INVALID body from a scopeless caller is also 403, never a 400 that confirms the shape
    expect((await post(a, { consentIds: Array.from({ length: 101 }, () => randomUUID()) }, [])).statusCode).toBe(403);
  });

  it("writes no audit row and changes no consent rows", async () => {
    const count = (fx: ContentFixture, sql: string) => asTenant(fx.tenantId, async (c) => (await c.query<{ n: number }>(sql)).rows[0].n);
    const before = await count(a, `SELECT count(*)::int AS n FROM consent_records`);
    await post(a, { consentIds: [stillGranted] });
    expect(await count(a, `SELECT count(*)::int AS n FROM consent_records`)).toBe(before);
    expect(await count(a, `SELECT count(*)::int AS n FROM audit_entries WHERE action LIKE '%consent.status%'`)).toBe(0);
  });
});
