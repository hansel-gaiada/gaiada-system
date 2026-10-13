// site.setDomain (M6-P6i): set, or clear, ONE environment's public domain, which is the CORS allow-list source of every
// browser-facing route. HIGH, always WS4. What this proves, against a real Postgres (0001-0019, webdesk_app NOBYPASSRLS),
// real Redis, the real AppModule and the REAL Layer-3/4 PolicyDecisionPoint (content-test-kit.ts), modelled on
// site-archive.spec.ts:
//   - the command refuses without a WS4 assertion, with one minted for different arguments, and without the promote scope;
//   - a non-canonical value (a scheme, a port, a path, a wildcard, upper case, a trailing dot, an IP, a Cyrillic look-alike,
//     `.invalid`) is a 400 and changes nothing; the body is closed (`{envId, domain}`);
//   - a valid assertion sets the domain: the answer, the row, one audit row carrying the approval, single-use afterwards;
//     a replay of the same Idempotency-Key answers from the stored record;
//   - CORS follows the column, on the real consent route (OPTIONS /v1/t/:slug/consent, which uses the same Origin -> site
//     rule as forms and draft preview): the new domain is answered, and a LOOKALIKE is refused (example.com.evil.test,
//     exampIe.com, evil-example.com, a sibling subdomain, a port, userinfo, a Cyrillic look-alike);
//   - refusals decided in the effect: an env that is not THIS site's (404), a no-op (409 domain-unchanged), a domain held by
//     another environment of the tenant (409 domain-in-use), an archived site (409); each leaves the approval unclaimed;
//   - the ROLLBACK, run on a test domain: set A, set B, set A back (the answer's previousDomain), then clear; after each step
//     the CORS answer is exactly the current domain's and no other.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, hdr, ws4For, type ContentFixture } from "./content-test-kit";
import { peekWs4Assertion } from "../src/control/auth/ws4-assertion";

const url = (fx: ContentFixture, siteId = fx.siteId) => `/control/v1/tenants/${fx.slug}/sites/${siteId}/domain`;

describe("site.setDomain (WS4-gated; the CORS allow-list source)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildContentApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  // The NODE_ENV=test control channel is the dev-mode stub: it fills ControlContext.ws4ApprovalId ONLY from this header (the real
  // authenticator peeks it out of x-ws4-assertion). The envelope refuses a HIGH command without one. The PDP still verifies the
  // assertion itself; this header is only the claim id (the same arrangement as site-archive.spec.ts).
  const promoteHdr = (ws4?: string, idem: string | null = `idem-${randomUUID()}`) => {
    const h = hdr({ scopes: ["webdesk:promote"], ws4, idem, editorial: null });
    const approvalId = ws4 ? peekWs4Assertion(ws4)?.approvalId : undefined;
    if (approvalId) h["x-webdesk-ws4-approval-id"] = approvalId;
    return h;
  };
  const ws4 = (fx: ContentFixture, body: Record<string, unknown>, siteId = fx.siteId, approvalId = `apr-${randomUUID()}`) =>
    ws4For("site.setDomain", { tenantSlug: fx.slug, siteId }, body, approvalId);

  const post = (fx: ContentFixture, body: Record<string, unknown>, opts: { ws4?: string | null; idem?: string | null; siteId?: string } = {}) =>
    app.inject({
      method: "POST",
      url: url(fx, opts.siteId),
      headers: promoteHdr(opts.ws4 === null ? undefined : (opts.ws4 ?? ws4(fx, body, opts.siteId)), opts.idem),
      payload: body,
    });

  const envDomain = (fx: ContentFixture, envId: string) =>
    asTenant(fx.tenantId, async (c) => (await c.query(`SELECT domain FROM environments WHERE id = $1`, [envId])).rows[0]?.domain as string | null | undefined);

  const auditActions = (fx: ContentFixture, approvalId: string) =>
    asTenant(fx.tenantId, async (c) =>
      (await c.query(`SELECT action FROM audit_entries WHERE tenant_id = $1 AND ws4_approval_id = $2 ORDER BY action`, [fx.tenantId, approvalId])).rows.map((r) => r.action as string),
    );

  let n = 0;
  /** The real consent preflight: the same Origin -> site rule forms and draft preview use, answered 204 or 403. */
  const preflight = async (fx: ContentFixture, origin: string) => {
    const res = await app.inject({
      method: "OPTIONS",
      url: `/v1/t/${fx.slug}/consent`,
      headers: { origin, "access-control-request-method": "POST" },
      remoteAddress: `10.9.${Math.floor(Math.random() * 250)}.${++n % 250}`,
    });
    return { status: res.statusCode, allowOrigin: res.headers["access-control-allow-origin"] as string | undefined };
  };
  const allowed = async (fx: ContentFixture, origin: string) => {
    const r = await preflight(fx, origin);
    return r.status === 204 && r.allowOrigin === origin;
  };
  const refused = async (fx: ContentFixture, origin: string) => {
    const r = await preflight(fx, origin);
    return r.status === 403 && r.allowOrigin === undefined;
  };

  // ----------------------------------------------------------------------------------------------
  // The gate
  // ----------------------------------------------------------------------------------------------
  it("REFUSES without a WS4 assertion (403) and changes nothing", async () => {
    const fx = await createContentFixture("sd-nows4");
    const res = await post(fx, { envId: fx.productionEnvId, domain: "shop.example.test" }, { ws4: null });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toMatch(/HIGH-impact and always requires a WS4 assertion/);
    expect(await envDomain(fx, fx.productionEnvId)).toBeNull();
  });

  it("REFUSES a WS4 assertion minted for a DIFFERENT domain (commandHash mismatch, 403): an approval for one domain cannot set another", async () => {
    const fx = await createContentFixture("sd-badhash");
    const approved = ws4(fx, { envId: fx.productionEnvId, domain: "approved.example.test" });
    const res = await post(fx, { envId: fx.productionEnvId, domain: "evil.example.test" }, { ws4: approved });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toMatch(/commandHash does not match/);
    // ...and the same assertion for a different ENVIRONMENT.
    const wrongEnv = await post(fx, { envId: fx.stagingEnvId, domain: "approved.example.test" }, { ws4: approved });
    expect(wrongEnv.statusCode, wrongEnv.body).toBe(403);
    expect(await envDomain(fx, fx.productionEnvId)).toBeNull();
    expect(await envDomain(fx, fx.stagingEnvId)).toBeNull();
  });

  it("REFUSES a caller without the webdesk:promote scope (403) and a token minted for another command (403)", async () => {
    const fx = await createContentFixture("sd-scope");
    const body = { envId: fx.productionEnvId, domain: "scope.example.test" };
    const res = await app.inject({ method: "POST", url: url(fx), headers: hdr({ scopes: ["webdesk:read", "webdesk:operate"], ws4: ws4(fx, body), editorial: null }), payload: body });
    expect(res.statusCode, res.body).toBe(403);
    const other = ws4For("site.archive", { tenantSlug: fx.slug, siteId: fx.siteId }, body);
    expect((await post(fx, body, { ws4: other })).statusCode).toBe(403);
    expect(await envDomain(fx, fx.productionEnvId)).toBeNull();
  });

  it("REFUSES a missing Idempotency-Key (400)", async () => {
    const fx = await createContentFixture("sd-nokey");
    const body = { envId: fx.productionEnvId, domain: "nokey.example.test" };
    const res = await post(fx, body, { idem: null });
    expect(res.statusCode, res.body).toBe(400);
    expect(await envDomain(fx, fx.productionEnvId)).toBeNull();
  });

  // ----------------------------------------------------------------------------------------------
  // The value: canonical or refused
  // ----------------------------------------------------------------------------------------------
  it("a non-canonical domain is a 400 and changes nothing (the assertion is for exactly what was sent, so it is the VALUE that is refused)", async () => {
    const fx = await createContentFixture("sd-canon");
    const bad = [
      "Shop.Example.test", // upper case
      "https://shop.example.test", // scheme
      "shop.example.test:8443", // port
      "shop.example.test/", // path
      "shop.example.test/path",
      "*.example.test", // wildcard
      " shop.example.test", // whitespace
      "shop.example.test.", // trailing root dot
      "user@shop.example.test", // userinfo
      "localhost",
      "10.0.0.1", // an IP is not a domain
      "shop.example.local",
      "shop.provisioned.invalid", // the registry's placeholder namespace
      "-shop.example.test",
      "sh_op.example.test",
      "exаmple.test", // a Cyrillic "а": must be punycode to be stored
      "a",
      "",
    ];
    for (const domain of bad) {
      const res = await post(fx, { envId: fx.productionEnvId, domain });
      expect(res.statusCode, `${JSON.stringify(domain)} -> ${res.body}`).toBe(400);
    }
    expect(await envDomain(fx, fx.productionEnvId)).toBeNull();
  });

  it("the body is closed and typed: unknown key, missing domain, missing / malformed envId and a non-string domain are all 400", async () => {
    const fx = await createContentFixture("sd-body");
    for (const body of [
      { envId: fx.productionEnvId, domain: "x.example.test", extra: 1 },
      { envId: fx.productionEnvId },
      { domain: "x.example.test" },
      { envId: "not-a-uuid", domain: "x.example.test" },
      { envId: fx.productionEnvId, domain: 42 },
      { envId: fx.productionEnvId, domain: ["x.example.test"] },
    ]) {
      const res = await post(fx, body as Record<string, unknown>);
      expect(res.statusCode, `${JSON.stringify(body)} -> ${res.body}`).toBe(400);
    }
    // A malformed site id in the route is a 400 as well.
    const bad = await app.inject({ method: "POST", url: `/control/v1/tenants/${fx.slug}/sites/not-a-uuid/domain`, headers: promoteHdr(ws4For("site.setDomain", { tenantSlug: fx.slug, siteId: "not-a-uuid" }, { envId: fx.productionEnvId, domain: "x.example.test" })), payload: { envId: fx.productionEnvId, domain: "x.example.test" } });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(await envDomain(fx, fx.productionEnvId)).toBeNull();
  });

  // ----------------------------------------------------------------------------------------------
  // The command, and CORS following the column
  // ----------------------------------------------------------------------------------------------
  it("sets the domain with a valid assertion: the answer, the row, one audit row carrying the approval, single-use afterwards", async () => {
    const fx = await createContentFixture("sd-ok");
    const body = { envId: fx.productionEnvId, domain: "shop.example.test" };
    const approvalId = `apr-${randomUUID()}`;
    const res = await post(fx, body, { ws4: ws4(fx, body, fx.siteId, approvalId) });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ environment: { id: fx.productionEnvId, name: "production", domain: "shop.example.test", previousDomain: null }, replayed: false });
    expect(await envDomain(fx, fx.productionEnvId)).toBe("shop.example.test");
    expect(await envDomain(fx, fx.stagingEnvId)).toBeNull(); // the sibling environment is untouched
    expect(await auditActions(fx, approvalId)).toEqual(["control.site.setDomain"]);

    // The same approval cannot set anything again (single use), even for the same arguments.
    const reuse = await post(fx, { envId: fx.stagingEnvId, domain: "stage.example.test" }, { ws4: ws4(fx, { envId: fx.stagingEnvId, domain: "stage.example.test" }, fx.siteId, approvalId) });
    expect(reuse.statusCode, reuse.body).toBe(403);
    expect(await envDomain(fx, fx.stagingEnvId)).toBeNull();
  });

  it("a retry of the SAME Idempotency-Key is answered from the stored record: one effect, one audit row", async () => {
    const fx = await createContentFixture("sd-replay");
    const body = { envId: fx.productionEnvId, domain: "replay.example.test" };
    const idem = `idem-${randomUUID()}`;
    const first = await post(fx, body, { idem });
    expect(first.statusCode, first.body).toBe(201);
    const replay = await post(fx, body, { idem }); // a fresh assertion for the same arguments: the real PDP refuses a re-used approval id
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().replayed).toBe(true);
    const { replayed: _a, ...a } = first.json();
    const { replayed: _b, ...b } = replay.json();
    expect(b).toEqual(a);
  });

  it("CORS answers for the new domain and REFUSES every lookalike of it", async () => {
    const fx = await createContentFixture("sd-cors");
    // Before: nothing is allowed, not even the domain we are about to set.
    expect(await refused(fx, "https://shop.example.test")).toBe(true);

    const body = { envId: fx.productionEnvId, domain: "shop.example.test" };
    expect((await post(fx, body)).statusCode).toBe(201);

    expect(await allowed(fx, "https://shop.example.test")).toBe(true);
    expect(await allowed(fx, "http://shop.example.test")).toBe(true); // both schemes, as the forms route has always done

    const lookalikes = [
      "https://shop.example.test.evil.test", // the domain as a PREFIX of another host
      "https://evil.shop.example.test", // a sub-domain of it
      "https://evilshop.example.test", // the domain as a suffix of another label
      "https://shop-example.test", // a hyphen for the dot
      "https://shop.example.test.", // the root-dot spelling
      "https://shop.example.test:8443", // another port
      "https://shop.example.test@evil.test", // userinfo that hides the real host
      "https://evil.test/shop.example.test", // an Origin never has a path; the host is evil.test
      "https://shop.examp1e.test", // a digit for a letter
      "https://shop.exampIe.test", // a capital I for the l (lower-cased by the comparison, so it is "exampie")
      "https://shop.xn--exmple-4nf.test", // a Cyrillic "а" for the Latin one, as a browser sends it (punycode)
      "https://example.test", // the parent domain
      "null", // a sandboxed document's opaque Origin
      "",
    ];
    for (const origin of lookalikes) {
      expect(await refused(fx, origin), `${JSON.stringify(origin)} must be refused`).toBe(true);
    }
    // ...and another tenant's Origin is its own matter: this tenant's domain is not allowed on a slug it does not own.
    const other = await createContentFixture("sd-cors-other");
    expect(await refused(other, "https://shop.example.test")).toBe(true);
  });

  // ----------------------------------------------------------------------------------------------
  // Refusals decided in the effect (the approval stays unclaimed)
  // ----------------------------------------------------------------------------------------------
  it("an env that is not THIS site's is a 404 (a sibling site's, and another tenant's), and the approval stays unclaimed", async () => {
    const a = await createContentFixture("sd-xa");
    const b = await createContentFixture("sd-xb");
    const approvalId = `apr-${randomUUID()}`;
    const body = { envId: b.productionEnvId, domain: "cross.example.test" };
    // a's tenant + a's site, but b's environment id.
    const res = await post(a, body, { ws4: ws4(a, body, a.siteId, approvalId) });
    expect(res.statusCode, res.body).toBe(404);
    expect(await envDomain(b, b.productionEnvId)).toBeNull();
    expect(await auditActions(a, approvalId)).toEqual([]);
    // b's slug + a's site id: the site is not b's.
    const crossSite = await app.inject({
      method: "POST",
      url: url(b, a.siteId),
      headers: promoteHdr(ws4(b, { envId: a.productionEnvId, domain: "cross.example.test" }, a.siteId)),
      payload: { envId: a.productionEnvId, domain: "cross.example.test" },
    });
    expect(crossSite.statusCode, crossSite.body).toBe(404);
    expect(await envDomain(a, a.productionEnvId)).toBeNull();
  });

  it("an unknown tenant slug is a 404; a no-op is a 409 domain-unchanged; a domain held by another environment of the tenant is a 409 domain-in-use", async () => {
    const fx = await createContentFixture("sd-409");
    const ghost = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/no-such-tenant-${randomUUID().slice(0, 8)}/sites/${fx.siteId}/domain`,
      headers: promoteHdr(ws4For("site.setDomain", { tenantSlug: "x", siteId: fx.siteId }, { envId: fx.productionEnvId, domain: "ghost.example.test" })),
      payload: { envId: fx.productionEnvId, domain: "ghost.example.test" },
    });
    expect([403, 404]).toContain(ghost.statusCode); // the hash is for another slug, or the tenant does not exist: nothing is set either way

    const first = { envId: fx.productionEnvId, domain: "held.example.test" };
    expect((await post(fx, first)).statusCode).toBe(201);

    const approvalSame = `apr-${randomUUID()}`;
    const same = await post(fx, first, { ws4: ws4(fx, first, fx.siteId, approvalSame) });
    expect(same.statusCode, same.body).toBe(409);
    expect(await auditActions(fx, approvalSame)).toEqual([]);

    const approvalClash = `apr-${randomUUID()}`;
    const clash = { envId: fx.stagingEnvId, domain: "held.example.test" };
    const res = await post(fx, clash, { ws4: ws4(fx, clash, fx.siteId, approvalClash) });
    expect(res.statusCode, res.body).toBe(409);
    expect(await envDomain(fx, fx.stagingEnvId)).toBeNull();
    expect(await auditActions(fx, approvalClash)).toEqual([]);

    // Clearing an environment that has no domain is the same no-op.
    const clearEmpty = { envId: fx.stagingEnvId, domain: null };
    expect((await post(fx, clearEmpty)).statusCode).toBe(409);
  });

  it("an archived site accepts no domain change (409) and keeps the domain it had", async () => {
    const fx = await createContentFixture("sd-archived");
    const first = { envId: fx.productionEnvId, domain: "before-archive.example.test" };
    expect((await post(fx, first)).statusCode).toBe(201);
    await asTenant(fx.tenantId, (c) => c.query(`UPDATE sites SET status = 'archived' WHERE id = $1`, [fx.siteId]));
    const next = { envId: fx.productionEnvId, domain: null };
    const res = await post(fx, next);
    expect(res.statusCode, res.body).toBe(409);
    expect(await envDomain(fx, fx.productionEnvId)).toBe("before-archive.example.test");
  });

  // ----------------------------------------------------------------------------------------------
  // The rollback, run on a test domain
  // ----------------------------------------------------------------------------------------------
  it("ROLLBACK: set A, set B, set A back from previousDomain, then clear: after each step CORS answers for the current domain only", async () => {
    const fx = await createContentFixture("sd-rollback");
    const A = "old.example.test";
    const B = "new.example.test";

    const setA = await post(fx, { envId: fx.productionEnvId, domain: A });
    expect(setA.statusCode, setA.body).toBe(201);
    expect(await allowed(fx, `https://${A}`)).toBe(true);

    const setB = await post(fx, { envId: fx.productionEnvId, domain: B });
    expect(setB.statusCode, setB.body).toBe(201);
    const previous = setB.json().environment.previousDomain as string;
    expect(previous).toBe(A);
    expect(await allowed(fx, `https://${B}`)).toBe(true);
    expect(await refused(fx, `https://${A}`)).toBe(true); // the old domain stops being answered the moment it is replaced

    // The rollback is an ordinary HIGH command: a NEW assertion, with domain = the previous value.
    const back = await post(fx, { envId: fx.productionEnvId, domain: previous });
    expect(back.statusCode, back.body).toBe(201);
    expect(back.json().environment).toMatchObject({ domain: A, previousDomain: B });
    expect(await allowed(fx, `https://${A}`)).toBe(true);
    expect(await refused(fx, `https://${B}`)).toBe(true);
    expect(await envDomain(fx, fx.productionEnvId)).toBe(A);

    // ...or a clear (`domain: null`): no browser origin is answered afterwards.
    const clear = await post(fx, { envId: fx.productionEnvId, domain: null });
    expect(clear.statusCode, clear.body).toBe(201);
    expect(clear.json().environment).toMatchObject({ domain: null, previousDomain: A });
    expect(await envDomain(fx, fx.productionEnvId)).toBeNull();
    expect(await refused(fx, `https://${A}`)).toBe(true);
    expect(await refused(fx, `https://${B}`)).toBe(true);
  });
});
