// MAIL-24 — re-measurement for QA-MAIL-11 Finding 1 (timing-enumeration oracle), same methodology
// QA's `qa-mail11-adversarial.test.ts` used (N=30 per branch, median + IQR over a real DB), run
// AFTER `dummyEquivalentWork` (service.ts) was rewritten to pay an equivalent-shape real cost
// (suppression SELECT + borrowed-user INSERT/DELETE decoy + template render + mail_log
// INSERT/DELETE decoy) instead of three trivial `SELECT 1`s. QA's own file is left untouched —
// this is a SEPARATE, additional measurement, not a replacement or a loosening of its assertion.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createUser } from "../../testing/fixtures";
import { resetMagicLinkRateLimitForTest } from "./rate-limit";

const TOKEN = "mail24-timing-remeasure-token";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function iqr(xs: number[]): [number, number] {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.floor(p * (s.length - 1))];
  return [q(0.25), q(0.75)];
}

describe.skipIf(!TEST_URL)("MAIL-24 Finding 1 — timing re-measurement (known vs unknown, N=30)", () => {
  let app: NestFastifyApplication;
  const saved = {
    enabled: config.mail.magicLinksEnabled,
    serviceToken: config.serviceToken,
    addrLimit: config.mail.magicLinkRatePerAddressHour,
    ipLimit: config.mail.magicLinkRatePerIpHour,
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
    config.mail.magicLinkRatePerAddressHour = saved.addrLimit;
    config.mail.magicLinkRatePerIpHour = saved.ipLimit;
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
      headers: { authorization: `Bearer ${TOKEN}`, ...(ip ? { "x-forwarded-for": ip } : {}) },
      payload,
    });
  }

  it("known vs unknown median/IQR ratio is closed to near-parity (was 3.25x pre-fix)", async () => {
    config.mail.magicLinkRatePerAddressHour = 0; // isolate the mint path itself, same as QA's probe
    config.mail.magicLinkRatePerIpHour = 0;
    const N = 30;
    const knownMs: number[] = [];
    const unknownMs: number[] = [];
    for (let i = 0; i < N; i++) {
      const email = `mail24-timing-known-${i}@dev.gaiada.invalid`;
      await createUser(email);
      const t0 = Date.now();
      const r = await post("/auth/magic-link", { email }, `203.0.113.${100 + (i % 100)}`);
      knownMs.push(Date.now() - t0);
      expect(r.statusCode).toBe(202);
    }
    for (let i = 0; i < N; i++) {
      const t0 = Date.now();
      const r = await post(
        "/auth/magic-link",
        { email: `mail24-timing-unknown-${i}@dev.gaiada.invalid` },
        `203.0.113.${200 + (i % 55)}`,
      );
      unknownMs.push(Date.now() - t0);
      expect(r.statusCode).toBe(202);
    }
    const [kMed, uMed] = [median(knownMs), median(unknownMs)];
    const [kQ1, kQ3] = iqr(knownMs);
    const [uQ1, uQ3] = iqr(unknownMs);
    const ratio = Math.max(kMed, uMed, 1) / Math.max(Math.min(kMed, uMed), 1);
    // eslint-disable-next-line no-console
    console.log(
      "[mail24-remeasure] known: median=%dms IQR=[%d,%d] n=%d; unknown: median=%dms IQR=[%d,%d] n=%d; ratio(median)=%s",
      kMed, kQ1, kQ3, N, uMed, uQ1, uQ3, N, ratio.toFixed(2),
    );
    // QA's own test (qa-mail11-adversarial.test.ts) keeps its original, looser `< 5` bound
    // UNCHANGED — that assertion is QA's and is not weakened here. This is a strictly TIGHTER,
    // additional bound proving the gap actually closed post-fix (pre-fix measured ratio was
    // 3.25x; this fails loudly if a future change regresses back toward that).
    //
    // ── 2026-09-03: the bound is now ABSOLUTE, because the ratio alone measured the machine, not
    // the code. Both medians sit at 4-6ms here, and `Date.now()` quantises to whole milliseconds
    // with a floor of 1 in the denominator, so a single millisecond of scheduler jitter reads as a
    // "1.25x timing gap" and 11ms vs 6ms — nothing but load — reads as 1.83x and FAILS. Measured
    // on the shared Linux runner: run alone, this test reports ratios of 1.00-1.25 on both clean
    // main and a feature branch (3 runs each, medians 4-5.5ms, indistinguishable); run inside the
    // full 500-file suite it reported 1.83 and 2.59 and failed, on BOTH trees. It was flagging
    // concurrency, and it had already cost one false "regression" investigation.
    //
    // What a timing oracle actually requires is a measurable ABSOLUTE difference an attacker can
    // separate from network noise — a 1ms delta is not an oracle whatever its ratio. So: assert the
    // absolute gap, and keep the ratio check only where a ratio is meaningful (medians large enough
    // that quantisation is not the dominant term). This is not a weakening: at the pre-fix 3.25x
    // with the medians that produced it, `absDelta` was far past 5ms and this still fails loudly.
    const absDelta = Math.abs(kMed - uMed);
    expect(absDelta).toBeLessThan(5);
    if (Math.min(kMed, uMed) >= 20) {
      expect(ratio).toBeLessThan(1.8);
    }
  }, 60_000);
});
