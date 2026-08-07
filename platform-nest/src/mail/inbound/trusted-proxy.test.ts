// MAIL-37 — closes the hole QA-MAIL-11/MAIL-24 fixed for magic-link's limiter but which was never
// ported here: `checkInboundRate`'s per-source key trusted `x-forwarded-for` unconditionally, so N
// freshly-spoofed IPs against a configured limit of M all succeeded (zero protection). Now gated
// behind `config.mail.inboundTrustedProxies` (`../client-ip.ts`, the implementation shared with
// magic-link's fix), keyed on `req.ip` — the raw TCP peer, since this app never sets Fastify's
// `trustProxy` (main.ts).
//
// Also proves the one thing a naive, literal port of magic-link's exact parsing (index 0, "leftmost")
// would have missed: nginx's real `X-Forwarded-For` directive is `$proxy_add_x_forwarded_for`, which
// APPENDS nginx's own perceived peer to whatever the client already sent rather than replacing it — so
// picking the LEFTMOST entry is still attacker-authored even once the trusted-hop gate passes.
// `resolveClientIp(req, { xffPosition: "rightmost" })` is what actually closes that; the third case
// below reproduces the append shape directly and proves rightmost-keying is what makes it safe.
//
// Also covers MAIL-37's ordering question: `inbound.controller.ts` now runs the rate check BEFORE
// `authenticateInbound` (moved from after). The last two cases prove that reorder (a) left the 401
// contract byte-identical for wrong/absent tokens that never trip the limit, and (b) actually took
// effect (a request that trips the limit gets 429 even with a wrong token, because the limiter now
// runs first).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { loadFixture } from "../__fixtures__/inbound";
import { INBOUND_TOKEN_HEADER } from "./auth";
import { resetInboundRateLimitForTest } from "./rate-limit";

const TOKEN = "mail37-inbound-trusted-proxy-token";
const REPLY_DOMAIN = "notify.gaiada.invalid";
const UNTRUSTED_PEER = "192.0.2.60"; // never enrolled in the allowlist in any case below
const TRUSTED_PEER = "192.0.2.61"; // enrolled ONLY where a case is specifically testing the trusted path

/** The A9 "absent token" corpus fixture (04) — 204 regardless of any pre-seeded mail_log state, so
 *  these cases don't need the tenant/mail-seeding machinery `corpus.test.ts` uses for the threading
 *  cases. `run` keeps `MessageId` unique per call so repeated posts are never collapsed by the
 *  provider-message-id idempotency key. */
function absentTokenBody(run: string): string {
  const { payload } = loadFixture("04-absent-token.json", {
    token: "unused", tokenB: "unused", replyDomain: REPLY_DOMAIN, run,
  });
  return JSON.stringify(payload);
}

describe.skipIf(!TEST_URL)("MAIL-37 — inbound trusted-proxy allowlist + rate-limit/auth ordering", () => {
  let app: NestFastifyApplication;
  const saved = {
    token: config.mail.inboundToken,
    signingKey: config.mail.inboundSigningKey,
    rate: config.mail.inboundRatePerMin,
    trustedProxies: config.mail.inboundTrustedProxies,
    replyDomain: config.mail.replyDomain,
  };

  beforeAll(async () => {
    await initTestDb();
    config.mail.inboundToken = TOKEN;
    config.mail.inboundSigningKey = "";
    config.mail.replyDomain = REPLY_DOMAIN;
    app = await buildApp();
  });
  afterAll(async () => {
    Object.assign(config.mail, {
      inboundToken: saved.token,
      inboundSigningKey: saved.signingKey,
      inboundRatePerMin: saved.rate,
      inboundTrustedProxies: saved.trustedProxies,
      replyDomain: saved.replyDomain,
    });
    await app.close();
    await teardownTestDb();
  });
  afterEach(() => {
    resetInboundRateLimitForTest();
    config.mail.inboundRatePerMin = saved.rate;
    config.mail.inboundTrustedProxies = saved.trustedProxies;
  });

  function postFrom(remoteAddress: string, opts: { xff?: string; token?: string; run: string }) {
    return app.inject({
      method: "POST",
      url: "/api/mail/inbound/brevo",
      remoteAddress,
      headers: {
        "content-type": "application/json",
        [INBOUND_TOKEN_HEADER]: opts.token ?? TOKEN,
        ...(opts.xff ? { "x-forwarded-for": opts.xff } : {}),
      },
      payload: absentTokenBody(opts.run),
    });
  }

  it("spoofed XFF from an UNTRUSTED peer does not move the rate-limit key — capped at the configured limit despite N distinct spoofed values (MAIL-24's probe shape, reproduced here)", async () => {
    config.mail.inboundTrustedProxies = []; // default posture: trust nothing
    config.mail.inboundRatePerMin = 3;
    const attempts = 8;
    const codes: number[] = [];
    for (let i = 0; i < attempts; i++) {
      // A NEW claimed IP on every request, from a peer that is NOT in the trusted-proxy allowlist.
      // eslint-disable-next-line no-await-in-loop
      codes.push((await postFrom(UNTRUSTED_PEER, { xff: `198.51.100.${i}`, run: `untrusted-${i}` })).statusCode);
    }
    // All 8 requests shared ONE bucket (the untrusted socket address) because the spoofed header was
    // ignored outright — so only the first 3 (the configured limit) succeeded, unlike the pre-fix
    // behaviour where all 8 would have minted their own bucket.
    expect(codes.filter((c) => c === 204)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
  });

  it("a TRUSTED peer's forwarded IP IS honoured — each distinct forwarded address gets its own bucket", async () => {
    config.mail.inboundTrustedProxies = [TRUSTED_PEER];
    config.mail.inboundRatePerMin = 3;
    const attempts = 8;
    const codes: number[] = [];
    for (let i = 0; i < attempts; i++) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await postFrom(TRUSTED_PEER, { xff: `198.51.100.${100 + i}`, run: `trusted-${i}` })).statusCode);
    }
    // 8 distinct trusted-forwarded IPs, none sharing a bucket, so the per-source limit (3) never
    // triggers for any single one of them — real per-client limiting works once nginx is in front.
    expect(codes.every((c) => c === 204)).toBe(true);
  });

  it("a TRUSTED peer's APPENDED-STYLE XFF (nginx's real $proxy_add_x_forwarded_for shape) is not spoofable via the attacker-authored leftmost segment — only the rightmost (nginx's own appended peer) is keyed", async () => {
    config.mail.inboundTrustedProxies = [TRUSTED_PEER];
    config.mail.inboundRatePerMin = 3;
    // Same REAL rightmost value on every request (nginx always appends the one true peer it sees),
    // but a FRESH attacker-supplied leftmost value each time — exactly what a caller hitting nginx
    // directly can freely set. If leftmost were trusted (a literal port of magic-link's index-0
    // parsing), this would look like 8 different sources and all 8 would succeed — the bug this case
    // exists to catch.
    const attempts = 8;
    const codes: number[] = [];
    for (let i = 0; i < attempts; i++) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await postFrom(TRUSTED_PEER, { xff: `203.0.113.${i}, 198.51.100.200`, run: `append-spoof-${i}` })).statusCode);
    }
    expect(codes.filter((c) => c === 204)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);

    // Conversely, distinct RIGHTMOST values (distinct real nginx-perceived peers) each still get
    // their own bucket even with an IDENTICAL attacker-supplied leftmost value — proving the fix is
    // specifically "trust the rightmost", not "ignore multi-segment XFF entirely".
    resetInboundRateLimitForTest();
    const codes2: number[] = [];
    for (let i = 0; i < attempts; i++) {
      // eslint-disable-next-line no-await-in-loop
      codes2.push((await postFrom(TRUSTED_PEER, { xff: `203.0.113.99, 198.51.100.${210 + i}`, run: `append-distinct-${i}` })).statusCode);
    }
    expect(codes2.every((c) => c === 204)).toBe(true);
  });

  it("ordering safety: the rate limiter running BEFORE auth leaves the 401 contract byte-identical for wrong vs. absent tokens that never trip the limit", async () => {
    config.mail.inboundRatePerMin = 60; // comfortably above what this case sends
    const payload = absentTokenBody("ordering-401");
    const none = await app.inject({
      method: "POST", url: "/api/mail/inbound/brevo",
      headers: { "content-type": "application/json" }, payload,
    });
    const wrong = await app.inject({
      method: "POST", url: "/api/mail/inbound/brevo",
      headers: { "content-type": "application/json", [INBOUND_TOKEN_HEADER]: "not-the-token" }, payload,
    });
    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(none.body).toBe(wrong.body); // byte-identical — still not a token oracle, unaffected by the reorder
  });

  it("ordering proof: a request over the limit gets 429 even with a WRONG token — proves the limiter now runs before auth, not just that both still work independently", async () => {
    config.mail.inboundTrustedProxies = [];
    config.mail.inboundRatePerMin = 1;
    const first = await postFrom(UNTRUSTED_PEER, { run: "order-proof-1" }); // valid token, consumes the one slot
    const second = await postFrom(UNTRUSTED_PEER, { token: "not-the-token", run: "order-proof-2" }); // over limit AND wrong token
    expect(first.statusCode).toBe(204);
    // If auth still ran first, a wrong token would 401 regardless of the limit. Getting 429 here
    // proves the limiter is the one that fires.
    expect(second.statusCode).toBe(429);
  });
});
