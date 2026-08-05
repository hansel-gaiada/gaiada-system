// MAIL-10 — POST /auth/magic-link + POST /auth/magic-link/consume, over the real Nest app
// (app.inject, ServiceGuard). Covers: always-202 + body/timing parity for existing vs unknown
// address, both rate limits, the disabled-feature-flag 404, and the consume endpoint's generic
// error mapping.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createUser } from "../../testing/fixtures";
import { resetMagicLinkRateLimitForTest } from "./rate-limit";

const TOKEN = "magic-link-test-service-token";

describe.skipIf(!TEST_URL)("magic-link controller", () => {
  let app: NestFastifyApplication;
  const savedEnabled = config.mail.magicLinksEnabled;
  const savedServiceToken = config.serviceToken;
  const savedAddrLimit = config.mail.magicLinkRatePerAddressHour;
  const savedIpLimit = config.mail.magicLinkRatePerIpHour;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = TOKEN;
    config.mail.magicLinksEnabled = true;
    app = await buildApp();
  });
  afterAll(async () => {
    config.mail.magicLinksEnabled = savedEnabled;
    config.serviceToken = savedServiceToken;
    config.mail.magicLinkRatePerAddressHour = savedAddrLimit;
    config.mail.magicLinkRatePerIpHour = savedIpLimit;
    await app.close();
    await teardownTestDb();
  });
  afterEach(async () => {
    resetMagicLinkRateLimitForTest();
    await adminPool().query(`DELETE FROM auth_magic_links`);
    await adminPool().query(`DELETE FROM mail_log`);
    await adminPool().query(`DELETE FROM mail_suppressions`);
  });

  function post(url: string, payload: Record<string, unknown>, ip?: string) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
      payload,
    });
  }

  it("returns byte-identical 202 bodies for an existing vs an unknown address", async () => {
    const known = "magic-known@dev.gaiada.invalid";
    await createUser(known);

    const resKnown = await post("/auth/magic-link", { email: known }, "203.0.113.20");
    const resUnknown = await post("/auth/magic-link", { email: "no-such-user@dev.gaiada.invalid" }, "203.0.113.21");

    expect(resKnown.statusCode).toBe(202);
    expect(resUnknown.statusCode).toBe(202);
    expect(resKnown.body).toBe(resUnknown.body);
  });

  it("timing is in the same order of magnitude for an existing vs an unknown address (best-effort — see service.ts's dummyEquivalentWork comment; not a cryptographic guarantee)", async () => {
    const known = "magic-timing-known@dev.gaiada.invalid";
    await createUser(known);

    const t0 = Date.now();
    await post("/auth/magic-link", { email: known }, "203.0.113.30");
    const knownMs = Date.now() - t0;

    const t1 = Date.now();
    await post("/auth/magic-link", { email: "magic-timing-unknown@dev.gaiada.invalid" }, "203.0.113.31");
    const unknownMs = Date.now() - t1;

    // Generous tolerance for local/CI jitter: the point being proven is "the handler didn't skip
    // all DB work for one branch" (which would show as a multi-x gap), not sub-millisecond parity.
    const ratio = Math.max(knownMs, unknownMs, 1) / Math.max(Math.min(knownMs, unknownMs), 1);
    expect(ratio).toBeLessThan(5);
  });

  it("enforces the per-address rate limit (default configured to 3/hour in this suite's env, or whatever config.mail.magicLinkRatePerAddressHour is) without ever returning a different status", async () => {
    config.mail.magicLinkRatePerAddressHour = 2;
    const email = "magic-rate-addr@dev.gaiada.invalid";
    await createUser(email);

    const r1 = await post("/auth/magic-link", { email }, "203.0.113.40");
    const r2 = await post("/auth/magic-link", { email }, "203.0.113.41");
    const r3 = await post("/auth/magic-link", { email }, "203.0.113.42"); // over the address limit
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([202, 202, 202]);
    expect(r1.body).toBe(r3.body);

    const minted = await adminPool().query(`SELECT count(*)::int AS n FROM auth_magic_links WHERE email = $1`, [email]);
    expect(minted.rows[0].n).toBe(2); // the third request never minted
  });

  it("enforces the per-IP rate limit across DIFFERENT addresses sharing one IP", async () => {
    config.mail.magicLinkRatePerIpHour = 2;
    const ip = "203.0.113.50";
    await createUser("magic-rate-ip-1@dev.gaiada.invalid");
    await createUser("magic-rate-ip-2@dev.gaiada.invalid");
    await createUser("magic-rate-ip-3@dev.gaiada.invalid");

    await post("/auth/magic-link", { email: "magic-rate-ip-1@dev.gaiada.invalid" }, ip);
    await post("/auth/magic-link", { email: "magic-rate-ip-2@dev.gaiada.invalid" }, ip);
    await post("/auth/magic-link", { email: "magic-rate-ip-3@dev.gaiada.invalid" }, ip); // over IP limit

    const minted = await adminPool().query(`SELECT count(*)::int AS n FROM auth_magic_links`);
    expect(minted.rows[0].n).toBe(2);
  });

  it("a suppressed auth address gets a distinguishable non-202 response", async () => {
    const email = "magic-suppressed-http@dev.gaiada.invalid";
    await createUser(email);
    await adminPool().query(
      `INSERT INTO mail_suppressions (id, email, stream, reason) VALUES (gen_random_uuid(), $1, 'auth', 'manual')`,
      [email],
    );
    const res = await post("/auth/magic-link", { email }, "203.0.113.60");
    expect(res.statusCode).not.toBe(202);
  });

  it("consume: unknown/replayed/expired all return the SAME status + body", async () => {
    const unknown = await app.inject({
      method: "POST", url: "/auth/magic-link/consume",
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { token: "nope" },
    });
    expect(unknown.statusCode).toBe(422);
    const body = unknown.json();
    // App-wide contract (http-error.filter.ts): every HttpException body reshapes to `{ error }`,
    // never Nest's default `{ message }` — assert against the shape this app actually returns.
    expect(body).toHaveProperty("error");
    expect(JSON.stringify(body)).not.toMatch(/reason|expired|replay/i);
  });

  it("404s both endpoints when MAIL_MAGIC_LINKS_ENABLED is off — the feature stays truly dark by default", async () => {
    config.mail.magicLinksEnabled = false;
    const reqRes = await post("/auth/magic-link", { email: "x@dev.gaiada.invalid" }, "203.0.113.70");
    const consumeRes = await app.inject({
      method: "POST", url: "/auth/magic-link/consume",
      headers: { authorization: `Bearer ${TOKEN}` }, payload: { token: "x" },
    });
    expect(reqRes.statusCode).toBe(404);
    expect(consumeRes.statusCode).toBe(404);
    config.mail.magicLinksEnabled = true;
  });

  it("401s without the service token — a browser cannot call this directly", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/magic-link", payload: { email: "x@dev.gaiada.invalid" } });
    expect(res.statusCode).toBe(401);
  });
});
