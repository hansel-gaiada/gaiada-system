// M5-L1/L2 — forms.submission.get (GET /control/v1/tenants/:tenantSlug/forms/submissions/:submissionId), end to
// end on the real AppModule with the real Layer-3/4 PDP (content-test-kit.ts). Doctrine ("validation
// pre-empts authz"): every refusal below is a VALID request; the cross-tenant and no-scope cases each have a
// positive control that sends the same request and succeeds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, type ContentFixture } from "./content-test-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const rh = (scopes: string[] = ["webdesk:read"]) => ({ "x-webdesk-control-principal": "erp-webdesk-control", "x-webdesk-control-scopes": scopes.join(",") });

let app: NestFastifyApplication;
let a: ContentFixture;
let b: ContentFixture;
let formA: string;
let subA: string;
let subB: string;

async function seed(fx: ContentFixture, key: string, opts: { status?: string; attribution?: unknown; consent?: unknown } = {}) {
  return asTenant(fx.tenantId, async (c) => {
    const form = (await c.query<{ id: string }>(`SELECT id FROM form_defs WHERE site_id = $1 AND key = $2`, [fx.siteId, key])).rows[0]?.id
      ?? (await c.query<{ id: string }>(`INSERT INTO form_defs (tenant_id, site_id, key) VALUES ($1, $2, $3) RETURNING id`, [fx.tenantId, fx.siteId, key])).rows[0].id;
    const id = randomUUID();
    await c.query(
      `INSERT INTO submissions (id, tenant_id, site_id, form_def_id, payload, status, consent_notice_text, consent_notice_version, expires_at, attribution, visitor_consent)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'You agree.', 'v3', now() + interval '1 day', $7::jsonb, $8::jsonb)`,
      [id, fx.tenantId, fx.siteId, form, JSON.stringify({ fields: { name: "Jane", contact_email: "jane@example.com" }, attachments: [] }), opts.status ?? "received",
       opts.attribution === undefined ? null : JSON.stringify(opts.attribution), opts.consent === undefined ? null : JSON.stringify(opts.consent)],
    );
    return { id, form };
  });
}

const url = (fx: ContentFixture, id: string) => `/control/v1/tenants/${fx.slug}/forms/submissions/${id}`;
const get = (fx: ContentFixture, id: string, scopes?: string[]) => app.inject({ method: "GET", url: url(fx, id), headers: rh(scopes) });

describe("forms.submission.get", () => {
  beforeAll(async () => {
    app = await buildContentApp();
    a = await createContentFixture("fsg-a");
    b = await createContentFixture("fsg-b");
    const attribution = { landing: "/services/web/", utm_source: "google" };
    const consent = { analytics: true, marketing: false, version: "3", decided_at: "2026-10-11T09:00:00.000Z" };
    const sa = await seed(a, "contact", { attribution, consent });
    subA = sa.id;
    formA = sa.form;
    subB = (await seed(b, "contact")).id;
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it("returns the contract's members at the top level, with the stable form KEY", async () => {
    const r = await get(a, subA);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      submissionId: subA,
      formId: formA,
      formKey: "contact",
      siteSlug: a.slug,
      status: "received",
      fields: { name: "Jane", contact_email: "jane@example.com" },
      consent: { text: "You agree.", version: "v3" },
      attribution: { landing: "/services/web/", utm_source: "google" },
      visitorConsent: { analytics: true, marketing: false, version: "3" },
    });
    expect(body.consent.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a submission stored without attribution / banner choice reads null (unknown = no consent)", async () => {
    const { id } = await seed(a, "audit");
    const body = (await get(a, id)).json();
    expect(body.formKey).toBe("audit");
    expect(body.attribution).toBeNull();
    expect(body.visitorConsent).toBeNull();
  });

  it("CROSS-TENANT: tenant B's submission through tenant A's slug is a uniform 404 (a valid id, a valid request); positive control through its own slug is 200", async () => {
    const cross = await get(a, subB);
    expect(cross.statusCode).toBe(404);
    expect(cross.json().type).toBe(`${PROBLEM}submission-not-found`);
    expect((await get(b, subB)).statusCode).toBe(200);
    // and the reverse, plus an unknown tenant slug: the same 404, so no existence oracle
    expect((await get(b, subA)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/control/v1/tenants/no-such-tenant/forms/submissions/${subA}`, headers: rh() })).statusCode).toBe(404);
  });

  it("an unknown or malformed submission id is 404, never a 500", async () => {
    expect((await get(a, randomUUID())).statusCode).toBe(404);
    expect((await get(a, "not-a-uuid")).statusCode).toBe(404);
  });

  it("purged and erased submissions are 410 submission-gone", async () => {
    for (const status of ["purged", "erased"]) {
      const { id } = await seed(a, "contact", { status });
      const r = await get(a, id);
      expect(r.statusCode).toBe(410);
      expect(r.json().type).toBe(`${PROBLEM}submission-gone`);
      expect(r.json().fields).toBeUndefined();
    }
  });

  it("needs webdesk:read: a valid request without it is 403, the identical request with it is 200", async () => {
    expect((await get(a, subA, ["webdesk:operate", "webdesk:promote", "webdesk:keys"])).statusCode).toBe(403);
    expect((await get(a, subA, ["webdesk:read"])).statusCode).toBe(200);
  });

  it("refuses an unknown query parameter, and writes no audit row", async () => {
    const r = await app.inject({ method: "GET", url: `${url(a, subA)}?includeErased=true`, headers: rh() });
    expect(r.statusCode).toBe(400);
    const n = await asTenant(a.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM audit_entries WHERE action LIKE '%forms.submission%'`)).rows[0].n);
    expect(n).toBe(0);
  });
});
