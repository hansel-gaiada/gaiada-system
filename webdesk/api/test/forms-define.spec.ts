// M5-L1d — forms.define / forms.def.list / forms.def.get over HTTP on the real AppModule with the real Layer-3/4 PDP
// (content-test-kit.ts). Real Postgres (migrations through 0018) and Redis: NEEDS the Linux gate
// (webdesk/qa/linux-gate.sh); it was not run on the Windows dev box that wrote it. The validator's own rules are
// test/form-definition-unit.spec.ts (pure).
//
// Doctrine (estate memory: "validation pre-empts authz"): every denial sends a body that is VALID for its command,
// and is paired with a positive control that sends the IDENTICAL request as an allowed principal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, hdr, type ContentFixture } from "./content-test-kit";
import { dumpAudit } from "./preview-test-kit";
import { turnstileConfig } from "../src/forms/forms.config";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const NOTICE = "We use this to reply to you. See /privacy-policy/";

const body = (over: Record<string, unknown> = {}) => ({
  schema: {
    fields: [
      { key: "name", type: "text", required: true, maxLength: 200 },
      { key: "email_address", type: "email", required: true },
      { key: "phone_number", type: "tel" },
      { key: "message", type: "textarea", required: true },
    ],
    honeypotField: "_hp",
    consentNotice: { text: NOTICE },
  },
  notify: {},
  retentionDays: 90,
  consentNoticeVersion: "v1",
  ...over,
});

describe("M5-L1d forms.define", () => {
  let app: NestFastifyApplication;
  let a: ContentFixture;
  let b: ContentFixture;

  const url = (f: ContentFixture, key?: string) => `/control/v1/tenants/${f.slug}/sites/${f.siteId}/forms${key ? `/${key}` : ""}`;
  const opts = (scopes?: string[], idem?: string | null) => ({ scopes, editorial: null, idem } as const);
  const put = (f: ContentFixture, key: string, payload: unknown, o: { scopes?: string[]; idem?: string | null } = {}) =>
    app.inject({ method: "PUT", url: url(f, key), headers: hdr(opts(o.scopes, o.idem)), payload: payload as Record<string, unknown> });
  const read = (u: string, scopes?: string[]) => app.inject({ method: "GET", url: u, headers: hdr({ scopes, editorial: null, idem: null }) });
  const row = (f: ContentFixture, key: string) =>
    asTenant(f.tenantId, async (c) => (await c.query(`SELECT * FROM form_defs WHERE site_id = $1 AND key = $2`, [f.siteId, key])).rows[0]);

  beforeAll(async () => {
    app = await buildContentApp();
    a = await createContentFixture("fdef-a");
    b = await createContentFixture("fdef-b");
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  it("creates a definition: 200, a new id, the columns the submit path reads, and the control.forms.define audit row", async () => {
    const r = await put(a, "contact", body());
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ created: true, consentNoticeChanged: false, replayed: false });
    expect(j.form).toMatchObject({ key: "contact", siteId: a.siteId, retentionDays: 90, consentNoticeVersion: "v1" });
    expect(j.form.formId).toMatch(/^[0-9a-f-]{36}$/);
    const db = await row(a, "contact");
    expect(db.id).toBe(j.form.formId);
    expect(db.schema.consentNotice.text).toBe(NOTICE);
    expect(db.schema.honeypotField).toBe("_hp");
    expect(db.retention_days).toBe(90);
    expect(db.consent_notice_version).toBe("v1");
    const audit = (await dumpAudit(a)).filter((e) => e.action === "control.forms.define");
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe("erp-webdesk-control");
    expect(JSON.stringify(audit[0])).not.toContain("privacy-policy"); // the notice text is never in the audit row
  });

  it("redefining keeps the form id (the site posts to :formId), updates the row, and reports created:false", async () => {
    const first = (await put(a, "audit", body())).json();
    const next = body();
    next.schema.fields.push({ key: "website_url", type: "text" } as never);
    next.retentionDays = 120;
    const r = await put(a, "audit", next);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().created).toBe(false);
    expect(r.json().form.formId).toBe(first.form.formId);
    const db = await row(a, "audit");
    expect(db.id).toBe(first.form.formId);
    expect(db.schema.fields).toHaveLength(5);
    expect(db.retention_days).toBe(120);
    expect(new Date(db.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(db.created_at).getTime());
  });

  describe("the consent notice rule", () => {
    it("changing the text without changing the version is 409 consent-version-unchanged, and nothing changes", async () => {
      await put(a, "notice-a", body());
      const changed = body();
      changed.schema.consentNotice.text = "A different notice text.";
      const r = await put(a, "notice-a", changed);
      expect(r.statusCode).toBe(409);
      expect(r.json().type).toBe(`${PROBLEM}consent-version-unchanged`);
      expect((await row(a, "notice-a")).schema.consentNotice.text).toBe(NOTICE);
      // a refusal claims nothing: the same key can be used again for the corrected request
    });

    it("the same text change WITH a new version is accepted and says so; a new version with the same text is accepted too", async () => {
      await put(a, "notice-b", body());
      const changed = body({ consentNoticeVersion: "v2" });
      changed.schema.consentNotice.text = "A different notice text.";
      const r = await put(a, "notice-b", changed);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ created: false, consentNoticeChanged: true });
      expect((await row(a, "notice-b")).consent_notice_version).toBe("v2");
      const same = await put(a, "notice-b", { ...changed, consentNoticeVersion: "v3" });
      expect(same.statusCode, same.body).toBe(200);
      expect(same.json().consentNoticeChanged).toBe(false);
    });

    it("a form created by raw SQL with no notice is compared against the defaults it has been recording", async () => {
      await asTenant(a.tenantId, (c) =>
        c.query(`INSERT INTO form_defs (tenant_id, site_id, key) VALUES ($1, $2, 'rawsql')`, [a.tenantId, a.siteId]),
      );
      const sameVersionAsDefault = await put(a, "rawsql", body({ consentNoticeVersion: "unspecified-v0" }));
      expect(sameVersionAsDefault.statusCode).toBe(409);
      expect(sameVersionAsDefault.json().type).toBe(`${PROBLEM}consent-version-unchanged`);
      expect((await put(a, "rawsql", body({ consentNoticeVersion: "v1" }))).statusCode).toBe(200);
    });
  });

  it("an invalid definition is 422 form-definition-invalid with every issue, claims no idempotency key and writes no audit row", async () => {
    const bad = body({ retentionDays: 0 });
    (bad.schema.fields[1] as Record<string, unknown>).type = "text"; // email_address typed text
    const idem = `idem-${randomUUID()}`;
    const before = (await dumpAudit(a)).length;
    const r = await put(a, "bad-form", bad, { idem });
    expect(r.statusCode).toBe(422);
    expect(r.json().type).toBe(`${PROBLEM}form-definition-invalid`);
    expect(r.json().issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(["retentionDays", "schema.fields[1].type"]));
    expect(await row(a, "bad-form")).toBeUndefined();
    expect((await dumpAudit(a)).length).toBe(before);
    // the same key now carries the corrected request
    expect((await put(a, "bad-form", body(), { idem })).statusCode).toBe(200);
  });

  it("a body naming the form key (a route parameter) is 400; a missing Idempotency-Key is 400", async () => {
    expect((await put(a, "k1", { ...body(), key: "k1" })).statusCode).toBe(400);
    expect((await put(a, "k1", body(), { idem: null })).statusCode).toBe(400);
  });

  it("is idempotent: the same key and request replays (replayed:true, one effect row); the same key with another request is 409", async () => {
    const idem = `idem-${randomUUID()}`;
    const first = await put(a, "idem-form", body(), { idem });
    expect(first.json().replayed).toBe(false);
    const replay = await put(a, "idem-form", body(), { idem });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().form.formId).toBe(first.json().form.formId);
    const reused = await put(a, "idem-form", body({ retentionDays: 30 }), { idem });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().type).toBe(`${PROBLEM}idempotency-key-reused`);
    const audit = (await dumpAudit(a)).filter((e) => e.action === "control.forms.define" || e.action === "control.forms.define.replay");
    expect(audit.filter((e) => e.action === "control.forms.define.replay").length).toBeGreaterThanOrEqual(1);
  });

  describe("authorization and tenancy (valid bodies; each denial has a positive control)", () => {
    it("forms.define needs webdesk:operate: without it 403, the identical request with it 200", async () => {
      const denied = await put(a, "authz-form", body(), { scopes: ["webdesk:read", "webdesk:promote", "webdesk:keys"] });
      expect(denied.statusCode).toBe(403);
      expect(await row(a, "authz-form")).toBeUndefined();
      expect((await put(a, "authz-form", body(), { scopes: ["webdesk:operate"] })).statusCode).toBe(200);
    });

    it("the reads need webdesk:read: without it 403, with it 200", async () => {
      await put(a, "read-form", body());
      for (const u of [url(a), url(a, "read-form")]) {
        expect((await read(u, ["webdesk:operate", "webdesk:promote", "webdesk:keys"])).statusCode, u).toBe(403);
        expect((await read(u, ["webdesk:read"])).statusCode, u).toBe(200);
      }
    });

    it("CROSS-TENANT: tenant B's site id through tenant A's slug is the uniform 404 site-not-found on the write and both reads; through its own slug it works", async () => {
      const through = (f: ContentFixture, site: string, key?: string) => `/control/v1/tenants/${f.slug}/sites/${site}/forms${key ? `/${key}` : ""}`;
      const w = await app.inject({ method: "PUT", url: through(a, b.siteId, "contact"), headers: hdr(opts()), payload: body() });
      expect(w.statusCode).toBe(404);
      expect(w.json().type).toBe(`${PROBLEM}site-not-found`);
      expect((await read(through(a, b.siteId))).statusCode).toBe(404);
      expect((await read(through(a, b.siteId, "contact"))).statusCode).toBe(404);
      expect(await row(b, "contact")).toBeUndefined();
      const ok = await app.inject({ method: "PUT", url: through(b, b.siteId, "contact"), headers: hdr(opts()), payload: body() });
      expect(ok.statusCode, ok.body).toBe(200);
      // and tenant A's form of the same key is a different row with a different id
      expect((await row(a, "contact")).id).not.toBe((await row(b, "contact")).id);
    });

    it("an unknown form key is 404 form-not-found, never a 500", async () => {
      for (const k of ["no-such-form", "Not A Key!!"]) {
        const r = await read(url(a, encodeURIComponent(k)));
        expect(r.statusCode, k).toBe(404);
        expect(r.json().type).toBe(`${PROBLEM}form-not-found`);
      }
    });

    it("forms.define is not an editorial command: a client-editor assertion header changes nothing, the ERP's client guard is the wall (README, Client editors)", async () => {
      // The route carries no editorial guard (like schema.apply); the identical request with or without the
      // header behaves the same, so this is a pin on that fact, not an authorization claim.
      const withCe = await app.inject({
        method: "PUT",
        url: url(a, "ce-form"),
        headers: { ...hdr(opts()), "x-webdesk-editorial-principal": JSON.stringify({ sub: "client-1", ce: true }) },
        payload: body(),
      });
      expect(withCe.statusCode).toBe(200);
    });
  });

  describe("the list and get reads", () => {
    it("list returns this site's definitions ordered by key, with the stored shape; get returns one", async () => {
      await put(a, "zz-list", body());
      await put(a, "aa-list", body());
      const l = (await read(url(a))).json().forms as Array<{ key: string; formId: string; schema: { fields: unknown[] } }>;
      const keys = l.map((f) => f.key);
      expect(keys).toEqual([...keys].sort());
      expect(keys).toEqual(expect.arrayContaining(["aa-list", "zz-list"]));
      const g = (await read(url(a, "aa-list"))).json().form;
      expect(g.formId).toBe(l.find((f) => f.key === "aa-list")?.formId);
      expect(g.schema.fields).toHaveLength(4);
      // tenant B's forms never appear in tenant A's list
      expect((await read(url(b))).json().forms.every((f: { siteId: string }) => f.siteId === b.siteId)).toBe(true);
    });

    it("the reads write no audit row", async () => {
      const before = (await dumpAudit(a)).length;
      await read(url(a));
      await read(url(a, "contact"));
      expect((await dumpAudit(a)).length).toBe(before);
    });
  });

  it("END TO END: a form defined here is accepted by the PUBLIC submit route, snapshots the notice text and version, and derives the typed refs", async () => {
    const domain = `fdef-${randomUUID().slice(0, 8)}.example.test`;
    await asTenant(a.tenantId, (c) => c.query(`UPDATE environments SET domain = $1 WHERE id = $2`, [domain, a.productionEnvId]));
    const defined = (await put(a, "e2e-form", body({ consentNoticeVersion: "site-2026-10-11" }))).json();
    const submit = (fields: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/v1/t/${a.slug}/forms/${defined.form.formId}/submit`,
        headers: { origin: `https://${domain}`, "content-type": "application/json" },
        remoteAddress: "10.0.7.1",
        payload: { fields, consent: true, turnstileToken: turnstileConfig.stubPassToken },
      });
    const ok = await submit({ name: "Jane", email_address: "Jane@Example.com", phone_number: "+62 812-3456-7890", message: "Hello" });
    expect(ok.statusCode, ok.body).toBe(201);
    const sub = await asTenant(a.tenantId, async (c) => (await c.query(`SELECT * FROM submissions WHERE id = $1`, [ok.json().id])).rows[0]);
    expect(sub.consent_notice_text).toBe(NOTICE);
    expect(sub.consent_notice_version).toBe("site-2026-10-11");
    expect(sub.data_subject_ref).toBe("jane@example.com");
    expect(sub.data_subject_phone_ref).toBe("6281234567890");
    // the stored definition is what is enforced: a missing required field is refused
    expect((await submit({ name: "Jane", email_address: "jane@example.com" })).statusCode).toBe(400);
  });
});
