// WSK-40 — done-when (1): the adversarial matrix, each row asserting its exact problem slug, over
// HTTP against the real AppModule: real Postgres, real Redis (the jti replay store on REDIS_URL), the
// REAL Layer-3/4 PolicyDecisionPoint (content-test-kit.ts) and the REAL editorial resolver
// (RealEditorialPrincipalResolver) in place of the NODE_ENV=test header stub. Layers 1/2 stay the
// test stubs (they are WSK-22's, proven by control-auth-layers.spec.ts).
//
// Doctrine ("validation pre-empts authz"): every refused row sends a body that is VALID for its
// command, and the happy-path rows send the same shape and succeed. Every refused create also proves
// nothing was written (its unique slug has zero rows).
//
// The verifier's clock is injected (`clock`), so the ±10 s skew rows are exact, not timing-dependent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, base, buildContentApp, createContentFixture, hdr, serviceFields, ws4For, type ContentFixture } from "./content-test-kit";
import { EDITORIAL_PRINCIPAL_RESOLVER } from "../src/control/auth/editorial-principal";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { RedisJtiReplayStore, type JtiReplayStore } from "../src/control/auth/jti-replay-store";
import { EDITORIAL_JWKS_FILE_ENV } from "../src/control/auth/editorial-jwks";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import {
  freshKey,
  jwksJson,
  keySetOf,
  mintEditorial,
  mintHs256,
  mintRaw,
  unsigned,
  wireHeader,
  wirePayload,
  type ClaimInput,
} from "./editorial-assertion-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const HEADER = "x-webdesk-editorial-assertion";

/** Delegates to a swappable target, so one row can take the store down and the next bring it back. */
class SwitchableStore implements JtiReplayStore {
  constructor(public target: JtiReplayStore) {}
  consume(jti: string, ttlMs: number) {
    return this.target.consume(jti, ttlMs);
  }
  async close() {
    await this.target.close();
  }
}

describe("WSK-40 editorial assertion — adversarial matrix (real verifier, real replay store)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let clock = Math.floor(Date.now() / 1000);
  const keyA = freshKey("wde-test-a");
  const keyB = freshKey("wde-test-b");
  /** Same kid as keyA, different key: a forger who knows the kid. */
  const forger = freshKey("wde-test-a");
  const liveStore = new RedisJtiReplayStore();
  const store = new SwitchableStore(liveStore);
  let deadStore: RedisJtiReplayStore;

  beforeAll(async () => {
    const resolver = new RealEditorialPrincipalResolver({ keys: keySetOf(keyA, keyB), store, now: () => clock });
    app = await buildContentApp((b) => b.overrideProvider(EDITORIAL_PRINCIPAL_RESOLVER).useValue(resolver));
    fx = await createContentFixture("ed40");
    // A Redis client that can never connect (port 1): the store-down row.
    deadStore = new RedisJtiReplayStore(
      new Redis({ host: "127.0.0.1", port: 1, maxRetriesPerRequest: 1, commandTimeout: 1_500, connectTimeout: 1_000, lazyConnect: false }),
    );
  });
  afterAll(async () => {
    await app?.close();
    await liveStore.close();
    await deadStore?.close();
  });

  // ── request builders ──────────────────────────────────────────────────────────────────────────
  const params = () => ({ tenantSlug: fx.slug, siteId: fx.siteId });
  const createBody = (slug = `service.ed40-${randomUUID().slice(0, 8)}`) => ({ collectionKey: "service", locale: "en", slug, fields: serviceFields() });

  function claims(cmd: string, body: Record<string, unknown>, over: Partial<ClaimInput> = {}): ClaimInput {
    return {
      sub: "erp-user-editor-7",
      pk: "human",
      ten: fx.slug,
      site: fx.siteId,
      cmd,
      cmh: computeCommandHash(cmd, { ...params(), ...body }),
      iat: clock,
      exp: clock + 60,
      jti: randomUUID(),
      ...over,
    };
  }

  async function postCreate(body: Record<string, unknown>, assertion: string | undefined, scopes?: string[]) {
    const headers: Record<string, string> = hdr({ editorial: null, scopes });
    if (assertion !== undefined) headers[HEADER] = assertion;
    return app.inject({ method: "POST", url: `${base(fx)}/items`, headers, payload: body });
  }

  async function rowsWithSlug(slug: string): Promise<number> {
    return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM content_items WHERE slug = $1`, [slug])).rows[0].n);
  }

  type Inject = Awaited<ReturnType<typeof postCreate>>;
  function expectProblem(r: Inject, status: number, slug: string) {
    expect(r.statusCode, r.body).toBe(status);
    expect(r.headers["content-type"]).toContain("application/problem+json");
    expect(r.json().type).toBe(`${PROBLEM}${slug}`);
  }

  /** Sends a VALID create body with `assertion`, expects the refusal, and proves nothing was written. */
  async function refusedCreate(assertionFor: (body: Record<string, unknown>) => string | undefined, status: number, slug: string) {
    const body = createBody();
    const r = await postCreate(body, assertionFor(body));
    expectProblem(r, status, slug);
    expect(await rowsWithSlug(body.slug as string)).toBe(0);
    return r;
  }

  async function acceptedCreate(assertionFor: (body: Record<string, unknown>) => string) {
    const body = createBody();
    const r = await postCreate(body, assertionFor(body));
    expect(r.statusCode, r.body).toBe(201);
    expect(await rowsWithSlug(body.slug as string)).toBe(1);
    return r;
  }

  const good = (body: Record<string, unknown>, over: Partial<ClaimInput> = {}) => mintEditorial(keyA, claims("content.create", body, over));

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rows 1–2: presence and shape
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 1  missing header → 401 editorial-assertion-missing", async () => {
    await refusedCreate(() => undefined, 401, "editorial-assertion-missing");
  });

  it("row 2  malformed (not a compact JWS) → 401 editorial-assertion-malformed", async () => {
    await refusedCreate(() => "not-a-jws", 401, "editorial-assertion-malformed");
  });

  it("row 2b malformed (three segments, header not JSON) → 401 editorial-assertion-malformed", async () => {
    await refusedCreate(() => "aGVsbG8.d29ybGQ.c2ln", 401, "editorial-assertion-malformed");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rows 3–8: algorithm, key, signature
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 3  alg:none (unsigned) → 401 editorial-assertion-invalid-signature", async () => {
    await refusedCreate((b) => unsigned({ alg: "none", typ: "wd-editorial+jwt", kid: keyA.kid }, wirePayload(claims("content.create", b))), 401, "editorial-assertion-invalid-signature");
  });

  it("row 4  HS256 signed with the PUBLIC key's bytes (raw x, JWK JSON, SPKI PEM) → 401 editorial-assertion-invalid-signature", async () => {
    const secrets: Array<Buffer | string> = [
      Buffer.from(keyA.x, "base64url"),
      JSON.stringify({ kty: "OKP", crv: "Ed25519", kid: keyA.kid, x: keyA.x }),
      keyA.publicKey.export({ type: "spki", format: "pem" }) as string,
      keyA.x,
    ];
    for (const secret of secrets) {
      await refusedCreate(
        (b) => mintHs256({ alg: "HS256", typ: "wd-editorial+jwt", kid: keyA.kid }, wirePayload(claims("content.create", b)), secret),
        401,
        "editorial-assertion-invalid-signature",
      );
    }
  });

  it("row 4b RS256 header over an Ed25519 signature → 401 editorial-assertion-invalid-signature", async () => {
    await refusedCreate((b) => mintRaw({ alg: "RS256", typ: "wd-editorial+jwt", kid: keyA.kid }, wirePayload(claims("content.create", b)), keyA.privateKey), 401, "editorial-assertion-invalid-signature");
  });

  it("row 5  unknown kid → 401 editorial-assertion-unknown-key (and a missing kid too)", async () => {
    const stranger = freshKey("wde-not-pinned");
    await refusedCreate((b) => mintEditorial(stranger, claims("content.create", b)), 401, "editorial-assertion-unknown-key");
    await refusedCreate((b) => mintRaw({ alg: "EdDSA", typ: "wd-editorial+jwt" }, wirePayload(claims("content.create", b)), keyA.privateKey), 401, "editorial-assertion-unknown-key");
  });

  it("row 6  tampered payload (sub changed, signature kept) → 401 editorial-assertion-invalid-signature", async () => {
    await refusedCreate((b) => {
      const [h, , s] = good(b).split(".");
      const forged = Buffer.from(JSON.stringify(wirePayload(claims("content.create", b, { sub: "erp-user-admin-1" })))).toString("base64url");
      return `${h}.${forged}.${s}`;
    }, 401, "editorial-assertion-invalid-signature");
  });

  it("row 7  tampered signature (one byte flipped) → 401 editorial-assertion-invalid-signature", async () => {
    await refusedCreate((b) => {
      const [h, p, s] = good(b).split(".");
      const sig = Buffer.from(s, "base64url");
      sig[10] ^= 0x01;
      return `${h}.${p}.${sig.toString("base64url")}`;
    }, 401, "editorial-assertion-invalid-signature");
  });

  it("row 8  a pinned kid signed by a different Ed25519 key → 401 editorial-assertion-invalid-signature", async () => {
    await refusedCreate((b) => mintEditorial(forger, claims("content.create", b)), 401, "editorial-assertion-invalid-signature");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rows 9–11: typ / iss / aud
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 9  wrong iss → 401 editorial-assertion-claims", async () => {
    await refusedCreate((b) => mintRaw(wireHeader(keyA.kid), { ...wirePayload(claims("content.create", b)), iss: "urn:gaiada:erp:other" }, keyA.privateKey), 401, "editorial-assertion-claims");
  });

  it("row 10 wrong aud (another value, and an array) → 401 editorial-assertion-claims", async () => {
    await refusedCreate((b) => mintRaw(wireHeader(keyA.kid), { ...wirePayload(claims("content.create", b)), aud: "urn:gaiada:webdesk:delivery" }, keyA.privateKey), 401, "editorial-assertion-claims");
    await refusedCreate((b) => mintRaw(wireHeader(keyA.kid), { ...wirePayload(claims("content.create", b)), aud: ["urn:gaiada:webdesk:control"] }, keyA.privateKey), 401, "editorial-assertion-claims");
  });

  it("row 11 wrong typ (JWT) → 401 editorial-assertion-claims", async () => {
    await refusedCreate((b) => mintRaw({ alg: "EdDSA", typ: "JWT", kid: keyA.kid }, wirePayload(claims("content.create", b)), keyA.privateKey), 401, "editorial-assertion-claims");
  });

  it("row 11b claim shapes: agt without pk=agent, a non-UUID jti, a non-hex cmh → 401 editorial-assertion-claims", async () => {
    await refusedCreate((b) => good(b, { agt: "webdev-writer" }), 401, "editorial-assertion-claims");
    await refusedCreate((b) => good(b, { jti: "not-a-uuid" }), 401, "editorial-assertion-claims");
    await refusedCreate((b) => good(b, { cmh: "Z".repeat(64) }), 401, "editorial-assertion-claims");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rows 12–15: time (clock injected; tolerance 10 s, max lifetime 120 s)
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 12 expired (exp = now − 11) → 401 editorial-assertion-expired; exp = now − 9 is inside the tolerance and accepted", async () => {
    await refusedCreate((b) => good(b, { iat: clock - 71, exp: clock - 11 }), 401, "editorial-assertion-expired");
    await acceptedCreate((b) => good(b, { iat: clock - 69, exp: clock - 9 }));
  });

  it("row 13 iat = now + 11 → 401 editorial-assertion-expired", async () => {
    await refusedCreate((b) => good(b, { iat: clock + 11, exp: clock + 71 }), 401, "editorial-assertion-expired");
  });

  it("row 14 iat = now + 9 → accepted (201)", async () => {
    await acceptedCreate((b) => good(b, { iat: clock + 9, exp: clock + 69 }));
  });

  it("row 15 lifetime 121 s → 401 editorial-assertion-expired; 120 s is accepted", async () => {
    await refusedCreate((b) => good(b, { iat: clock, exp: clock + 121 }), 401, "editorial-assertion-expired");
    await acceptedCreate((b) => good(b, { iat: clock, exp: clock + 120 }));
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rows 16–20: binding to the route, the arguments and the approval
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 16 ten ≠ route tenant → 403 editorial-assertion-scope-mismatch", async () => {
    await refusedCreate((b) => good(b, { ten: "another-tenant" }), 403, "editorial-assertion-scope-mismatch");
  });

  it("row 17 site ≠ route site → 403 editorial-assertion-scope-mismatch", async () => {
    await refusedCreate((b) => good(b, { site: randomUUID() }), 403, "editorial-assertion-scope-mismatch");
  });

  it("row 18 cmd ≠ route command (an update assertion on the create route) → 403 editorial-assertion-command-mismatch", async () => {
    await refusedCreate((b) => mintEditorial(keyA, claims("content.update", b)), 403, "editorial-assertion-command-mismatch");
  });

  it("row 19 cmh mismatch after a ONE-BYTE body change → 403 editorial-assertion-command-mismatch; neither slug is written", async () => {
    const signed = createBody(`service.onebyte-${randomUUID().slice(0, 6)}a`);
    const sent = { ...signed, slug: `${(signed.slug as string).slice(0, -1)}b` };
    expect(Buffer.from(JSON.stringify(sent)).length).toBe(Buffer.from(JSON.stringify(signed)).length);
    const r = await postCreate(sent, good(signed));
    expectProblem(r, 403, "editorial-assertion-command-mismatch");
    expect(await rowsWithSlug(signed.slug as string)).toBe(0);
    expect(await rowsWithSlug(sent.slug as string)).toBe(0);
  });

  // HIGH command: publish. WS4 (Layer 4, real HMAC) + the editorial apr cross-binding.
  async function draftItem(): Promise<string> {
    const r = await acceptedCreate((b) => good(b));
    return r.json().item.itemId as string;
  }
  async function publish(itemId: string, apr: string | undefined, ws4Approval: string) {
    const body = { items: [{ itemId, version: 1 }] };
    const headers: Record<string, string> = hdr({ editorial: null, ws4: ws4For("content.publish", params(), body, ws4Approval) });
    headers[HEADER] = mintEditorial(keyA, claims("content.publish", body, { req: "erp-user-requester-3", ...(apr !== undefined ? { apr } : {}) }));
    return app.inject({ method: "POST", url: `${base(fx)}/publish`, headers, payload: body });
  }
  async function publishedVersion(itemId: string): Promise<number | null> {
    return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT published_version FROM content_items WHERE id = $1`, [itemId])).rows[0].published_version);
  }

  it("row 20 apr ≠ the WS4 approval (and apr absent) on publish → 403 editorial-assertion-command-mismatch; nothing published", async () => {
    const id = await draftItem();
    expectProblem(await publish(id, `apr-${randomUUID()}`, `apr-${randomUUID()}`), 403, "editorial-assertion-command-mismatch");
    expectProblem(await publish(id, undefined, `apr-${randomUUID()}`), 403, "editorial-assertion-command-mismatch");
    expect(await publishedVersion(id)).toBeNull();
  });

  it("row 20b apr on a non-HIGH command → 403 editorial-assertion-command-mismatch", async () => {
    await refusedCreate((b) => good(b, { apr: `apr-${randomUUID()}` }), 403, "editorial-assertion-command-mismatch");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rows 21–22: single use, and the store failing closed
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 21 replay: the same assertion twice → 201, then 401 editorial-assertion-replayed (one row only)", async () => {
    const body = createBody();
    const assertion = good(body);
    const first = await postCreate(body, assertion);
    expect(first.statusCode, first.body).toBe(201);
    const second = await postCreate(body, assertion);
    expectProblem(second, 401, "editorial-assertion-replayed");
    expect(await rowsWithSlug(body.slug as string)).toBe(1);
  });

  it("row 22 replay store down → 503 editorial-assertion-store-unavailable (fail CLOSED); nothing written; recovers when it is back", async () => {
    store.target = deadStore;
    try {
      const t0 = Date.now();
      await refusedCreate((b) => good(b), 503, "editorial-assertion-store-unavailable");
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      store.target = liveStore;
    }
    await acceptedCreate((b) => good(b));
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Rows 23–24: the happy paths
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 23 happy path (agent) → 201; the version is attributed to the asserted sub, pk and agt", async () => {
    const body = createBody();
    const r = await postCreate(body, mintEditorial(keyA, claims("content.create", body, { sub: "erp-user-agent-owner-9", pk: "agent", agt: "webdev-writer" })));
    expect(r.statusCode, r.body).toBe(201);
    const v = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT cv.created_by, cv.attribution FROM content_versions cv JOIN content_items ci ON ci.id = cv.content_item_id WHERE ci.slug = $1`, [body.slug])).rows,
    );
    expect(v).toEqual([{ created_by: "erp-user-agent-owner-9", attribution: { pk: "agent", agt: "webdev-writer" } }]);
  });

  it("row 24 happy path (HIGH publish): WS4 + editorial with apr = the approval → 200, published, last_published_by = the asserted decider", async () => {
    const id = await draftItem();
    const approvalId = `apr-${randomUUID()}`;
    const r = await publish(id, approvalId, approvalId);
    expect(r.statusCode, r.body).toBe(200);
    expect(await publishedVersion(id)).toBe(1);
    const by = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT last_published_by FROM content_items WHERE id = $1`, [id])).rows[0].last_published_by);
    expect(by).toBe("erp-user-editor-7");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Gate order: Layer 2e runs AFTER L3/L4, so a cheaper refusal never consumes a jti
  // ════════════════════════════════════════════════════════════════════════════════════════════
  it("row 25 an L3 scope refusal does NOT burn the jti: the identical assertion then succeeds", async () => {
    const body = createBody();
    const assertion = good(body);
    const denied = await postCreate(body, assertion, ["webdesk:read"]);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().type).toBeUndefined(); // L3's ForbiddenException, not an editorial problem
    const ok = await postCreate(body, assertion);
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("row 26 the dev-mode header is ignored by the real resolver: x-webdesk-editorial-principal alone → 401 editorial-assertion-missing", async () => {
    const body = createBody();
    const r = await app.inject({ method: "POST", url: `${base(fx)}/items`, headers: hdr({ editorial: "user-editor-1" }), payload: body });
    expectProblem(r, 401, "editorial-assertion-missing");
    expect(await rowsWithSlug(body.slug as string)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The production binding: JWKS FILE absent → 503; the rotation overlap through the FILE loader
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("WSK-40 production binding (RealEditorialPrincipalResolver via useClass + WEBDESK_EDITORIAL_JWKS_FILE)", () => {
  let fx: ContentFixture;
  let dir: string;
  const saved = process.env[EDITORIAL_JWKS_FILE_ENV];
  const oldKid = freshKey("wde-2026-10");
  const newKid = freshKey("wde-2026-11");

  beforeAll(async () => {
    fx = await createContentFixture("ed40p");
    dir = mkdtempSync(join(tmpdir(), "wsk40-rot-"));
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[EDITORIAL_JWKS_FILE_ENV];
    else process.env[EDITORIAL_JWKS_FILE_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A "restart" of the api with whatever the JWKS file holds now. */
  async function boot(): Promise<NestFastifyApplication> {
    return buildContentApp((b) => b.overrideProvider(EDITORIAL_PRINCIPAL_RESOLVER).useClass(RealEditorialPrincipalResolver));
  }
  async function create(app: NestFastifyApplication, key: { kid: string; privateKey: import("node:crypto").KeyObject } | null) {
    const p = { tenantSlug: fx.slug, siteId: fx.siteId };
    const body = { collectionKey: "service", locale: "en", slug: `service.rot-${randomUUID().slice(0, 8)}`, fields: serviceFields() };
    const headers: Record<string, string> = hdr({ editorial: null });
    if (key) {
      const now = Math.floor(Date.now() / 1000);
      headers[HEADER] = mintEditorial(key, {
        sub: "erp-user-rot", pk: "human", ten: p.tenantSlug, site: p.siteId, cmd: "content.create",
        cmh: computeCommandHash("content.create", { ...p, ...body }), iat: now, exp: now + 60, jti: randomUUID(),
      });
    }
    return app.inject({ method: "POST", url: `${base(fx)}/items`, headers, payload: body });
  }

  it("no JWKS file configured → 503 editorial-keys-not-configured (and nothing written), even with a validly signed assertion", async () => {
    delete process.env[EDITORIAL_JWKS_FILE_ENV];
    const app = await boot();
    try {
      const r = await create(app, oldKid);
      expect(r.statusCode).toBe(503);
      expect(r.json().type).toBe(`${PROBLEM}editorial-keys-not-configured`);
    } finally {
      await app.close();
    }
    process.env[EDITORIAL_JWKS_FILE_ENV] = join(dir, "missing.json");
    const app2 = await boot();
    try {
      expect((await create(app2, oldKid)).json().type).toBe(`${PROBLEM}editorial-keys-not-configured`);
    } finally {
      await app2.close();
    }
  });

  it("rotation (runbook steps 1–4): old only → old ok; overlap → BOTH kids accepted; old removed → old refused unknown-key, new ok", async () => {
    const file = join(dir, "editorial.jwks.json");
    process.env[EDITORIAL_JWKS_FILE_ENV] = file;

    writeFileSync(file, jwksJson([oldKid]));
    let app = await boot();
    try {
      expect((await create(app, oldKid)).statusCode).toBe(201);
      expect((await create(app, newKid)).json().type).toBe(`${PROBLEM}editorial-assertion-unknown-key`);
    } finally {
      await app.close();
    }

    // Step 2: append kid N+1, restart api. Step 3 (ERP switches) happens in between: both must verify.
    writeFileSync(file, jwksJson([oldKid, newKid]));
    app = await boot();
    try {
      expect((await create(app, oldKid)).statusCode).toBe(201);
      expect((await create(app, newKid)).statusCode).toBe(201);
    } finally {
      await app.close();
    }

    // Step 4: remove kid N, restart api.
    writeFileSync(file, jwksJson([newKid]));
    app = await boot();
    try {
      const r = await create(app, oldKid);
      expect(r.statusCode).toBe(401);
      expect(r.json().type).toBe(`${PROBLEM}editorial-assertion-unknown-key`);
      expect((await create(app, newKid)).statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});
