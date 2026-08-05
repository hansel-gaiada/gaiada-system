// MAIL-24 — closes QA-MAIL-11 Finding 3: `clientIp()` (controller.ts) trusted `x-forwarded-for`
// verbatim with no proxy allowlist, so 8 freshly-spoofed IPs against a configured limit of 3 all
// minted (zero protection). The fix gates that header behind `config.mail.magicLinkTrustedProxies`,
// keyed on `req.ip` — the raw TCP peer, since this app never sets Fastify's `trustProxy` (main.ts).
//
// `light-my-request` (Fastify's `app.inject`) supports a `remoteAddress` option (default
// '127.0.0.1') that becomes `req.socket.remoteAddress` / `req.ip` — used here to give each test a
// deterministic, known "real" peer address without guessing Fastify's default.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createUser } from "../../testing/fixtures";
import { resetMagicLinkRateLimitForTest } from "./rate-limit";

const TOKEN = "mail24-trusted-proxy-token";
const UNTRUSTED_PEER = "192.0.2.50"; // never enrolled in the allowlist in either test
const TRUSTED_PEER = "192.0.2.51"; // enrolled ONLY in the "trusted" test

describe.skipIf(!TEST_URL)("MAIL-24 Finding 3 — trusted-proxy allowlist for clientIp()", () => {
  let app: NestFastifyApplication;
  const saved = {
    enabled: config.mail.magicLinksEnabled,
    serviceToken: config.serviceToken,
    ipLimit: config.mail.magicLinkRatePerIpHour,
    addrLimit: config.mail.magicLinkRatePerAddressHour,
    trustedProxies: config.mail.magicLinkTrustedProxies,
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = TOKEN;
    config.mail.magicLinksEnabled = true;
    app = await buildApp();
  });
  afterAll(async () => {
    config.mail.magicLinksEnabled = saved.enabled;
    config.serviceToken = saved.serviceToken;
    config.mail.magicLinkRatePerIpHour = saved.ipLimit;
    config.mail.magicLinkRatePerAddressHour = saved.addrLimit;
    config.mail.magicLinkTrustedProxies = saved.trustedProxies;
    await app.close();
    await teardownTestDb();
  });
  afterEach(async () => {
    resetMagicLinkRateLimitForTest();
    config.mail.magicLinkTrustedProxies = saved.trustedProxies;
    await adminPool().query(`DELETE FROM auth_magic_links`);
    await adminPool().query(`DELETE FROM mail_log`);
    await adminPool().query(`DELETE FROM mail_suppressions`);
  });

  function postFrom(remoteAddress: string, payload: Record<string, unknown>, xff?: string) {
    return app.inject({
      method: "POST",
      url: "/auth/magic-link",
      remoteAddress,
      headers: { authorization: `Bearer ${TOKEN}`, ...(xff ? { "x-forwarded-for": xff } : {}) },
      payload,
    });
  }

  it("spoofed XFF from an UNTRUSTED peer does NOT move the rate-limit key — mint count stays capped at the per-IP limit", async () => {
    config.mail.magicLinkTrustedProxies = []; // default posture: trust nothing
    config.mail.magicLinkRatePerAddressHour = 0; // isolate the IP axis
    config.mail.magicLinkRatePerIpHour = 3;
    const attempts = 8;
    const emails: string[] = [];
    for (let i = 0; i < attempts; i++) {
      const email = `mail24-untrusted-spoof-${i}@dev.gaiada.invalid`;
      emails.push(email);
      await createUser(email);
    }
    const results: number[] = [];
    for (let i = 0; i < attempts; i++) {
      // A NEW claimed IP on every request, from a peer that is NOT in the trusted-proxy allowlist —
      // exactly QA's attack shape, but now against the fixed clientIp().
      const r = await postFrom(UNTRUSTED_PEER, { email: emails[i] }, `198.51.100.${i}`);
      results.push(r.statusCode);
    }
    // Still always 202 — enumeration-resistance is unaffected by this fix; rate-limited requests
    // fold into the same {status:"accepted"} shape as a real mint (design §5.1), so a bypassed
    // limit was NEVER visible in the status code. What actually moved is whether the write happened.
    expect(results.every((s) => s === 202)).toBe(true);
    const minted = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_magic_links WHERE email = ANY($1)`,
      [emails],
    );
    // All 8 requests shared ONE bucket (the untrusted socket address, `UNTRUSTED_PEER`) because the
    // spoofed header was ignored outright — so only the first 3 (the configured per-IP limit)
    // actually minted, unlike the pre-fix behaviour where QA proved all 8 minted.
    expect(minted.rows[0].n).toBe(3);
  });

  it("the SAME spoofed XFF values from a TRUSTED peer DO move the rate-limit key — each distinct address gets its own bucket", async () => {
    config.mail.magicLinkTrustedProxies = [TRUSTED_PEER];
    config.mail.magicLinkRatePerAddressHour = 0; // isolate the IP axis
    config.mail.magicLinkRatePerIpHour = 3;
    const attempts = 8;
    const emails: string[] = [];
    for (let i = 0; i < attempts; i++) {
      const email = `mail24-trusted-spoof-${i}@dev.gaiada.invalid`;
      emails.push(email);
      await createUser(email);
    }
    const results: number[] = [];
    for (let i = 0; i < attempts; i++) {
      // Each request claims a DIFFERENT downstream IP via XFF, but now from a peer that IS the
      // configured trusted proxy — the legitimate case this header exists for (platform-ui
      // forwarding a real browser IP through its own trusted hop).
      const r = await postFrom(TRUSTED_PEER, { email: emails[i] }, `198.51.100.${100 + i}`);
      results.push(r.statusCode);
    }
    expect(results.every((s) => s === 202)).toBe(true);
    const minted = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_magic_links WHERE email = ANY($1)`,
      [emails],
    );
    // Each of the 8 requests carried a DIFFERENT trusted-forwarded IP, so none of them shared a
    // bucket with any other — the per-IP limit(3) never triggered for any single one of them, and
    // all 8 minted. This is the "still works" half of the pin: a trusted proxy's forwarded IP is
    // honoured, not just an untrusted one's ignored.
    expect(minted.rows[0].n).toBe(8);
  });
});
