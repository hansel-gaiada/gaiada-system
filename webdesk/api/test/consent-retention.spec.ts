// M5-G6 — the consent-log retention purge (ConsentPurgeService, run by the hourly forms-retention-purge job).
// Needs the forms infrastructure (Postgres) and the Linux gate; not run on the Windows dev box.
// Proves: a consent id's whole history goes once its LATEST record is older than the retention, a history with a
// recent record is kept whole, tenants are swept under their own context (no cross-tenant reach), the horizon is
// configurable, and an EMPTY env var means the 26-month default, never 0 (which would purge everything).
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asMigrator, buildConsentTestApp, readConsent } from "./consent-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { ConsentPurgeService } from "../src/consent/consent-purge.service";
import { ConsentConfigError } from "../src/consent/consent.config";

describe("M5-G6 — consent retention purge", () => {
  let app: NestFastifyApplication;
  let purge: ConsentPurgeService;
  let A: FixtureTenant;
  let B: FixtureTenant;
  const saved = process.env.WEBDESK_CONSENT_RETENTION_MONTHS;

  beforeAll(async () => {
    app = await buildConsentTestApp();
    purge = app.get(ConsentPurgeService);
    A = await createFixtureTenant("consent-ret-a");
    B = await createFixtureTenant("consent-ret-b");
  }, 30_000);

  afterEach(() => {
    if (saved === undefined) delete process.env.WEBDESK_CONSENT_RETENTION_MONTHS;
    else process.env.WEBDESK_CONSENT_RETENTION_MONTHS = saved;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seeds records for one consent id, each `monthsAgo` old (the table is append-only to the app role, so seed as the owner). */
  async function seed(t: FixtureTenant, consentId: string, monthsAgo: number[]) {
    await asMigrator(t.tenantId, async (c) => {
      for (const m of monthsAgo) {
        await c.query(
          `INSERT INTO consent_records (consent_id, tenant_id, site_id, analytics, marketing, notice_version, action, recorded_at)
           VALUES ($1, $2, $3, true, false, '3', 'grant', now() - make_interval(months => $4::int, days => 1))`,
          [consentId, t.tenantId, t.siteId, m],
        );
      }
    });
  }

  it("deletes a history whose LATEST record is past 26 months, and keeps a recent one", async () => {
    delete process.env.WEBDESK_CONSENT_RETENTION_MONTHS;
    const old = randomUUID();
    const fresh = randomUUID();
    await seed(A, old, [40, 30, 27]);
    await seed(A, fresh, [10, 1]);
    const results = await purge.purgeExpiredConsent();
    expect(results.find((r) => r.tenantId === A.tenantId)?.purgedCount).toBeGreaterThanOrEqual(3);
    expect(await readConsent(A.tenantId, old)).toHaveLength(0);
    expect(await readConsent(A.tenantId, fresh)).toHaveLength(2);
  });

  it("a history is purged whole or not at all: old records survive while a newer one keeps the id alive", async () => {
    const id = randomUUID();
    await seed(A, id, [60, 50, 2]); // two ancient records, one recent
    await purge.purgeExpiredConsent();
    expect(await readConsent(A.tenantId, id)).toHaveLength(3);
  });

  it("an EMPTY WEBDESK_CONSENT_RETENTION_MONTHS is the 26-month default, not 0: recent records survive the sweep", async () => {
    process.env.WEBDESK_CONSENT_RETENTION_MONTHS = "";
    const recent = randomUUID();
    await seed(A, recent, [0]); // a day old
    await purge.purgeExpiredConsent();
    expect(await readConsent(A.tenantId, recent)).toHaveLength(1);
  });

  it("a malformed horizon fails loudly BEFORE anything is deleted", async () => {
    const id = randomUUID();
    await seed(A, id, [100]);
    for (const bad of ["0", "-3", "abc"]) {
      process.env.WEBDESK_CONSENT_RETENTION_MONTHS = bad;
      await expect(purge.purgeExpiredConsent()).rejects.toBeInstanceOf(ConsentConfigError);
    }
    expect(await readConsent(A.tenantId, id)).toHaveLength(1); // untouched
  });

  it("the horizon is configurable: 3 months purges a 4-month-old history that 26 would keep", async () => {
    const id = randomUUID();
    await seed(A, id, [4]);
    await purge.purgeExpiredConsent(); // default 26: kept
    expect(await readConsent(A.tenantId, id)).toHaveLength(1);
    process.env.WEBDESK_CONSENT_RETENTION_MONTHS = "3";
    await purge.purgeExpiredConsent();
    expect(await readConsent(A.tenantId, id)).toHaveLength(0);
  });

  it("each tenant is swept under its own context: B's due records go, A's recent ones are not touched by B's sweep", async () => {
    const aRecent = randomUUID();
    const bOld = randomUUID();
    const bRecent = randomUUID();
    await seed(A, aRecent, [1]);
    await seed(B, bOld, [30]);
    await seed(B, bRecent, [1]);
    const results = await purge.purgeExpiredConsent();
    expect(results.find((r) => r.tenantId === B.tenantId)?.purgedCount).toBeGreaterThanOrEqual(1);
    expect(await readConsent(B.tenantId, bOld)).toHaveLength(0);
    expect(await readConsent(B.tenantId, bRecent)).toHaveLength(1);
    expect(await readConsent(A.tenantId, aRecent)).toHaveLength(1);
  });

  it("is idempotent: a second sweep deletes nothing more", async () => {
    await purge.purgeExpiredConsent();
    const again = await purge.purgeExpiredConsent();
    expect(again.every((r) => r.purgedCount === 0 || r.tenantId !== A.tenantId)).toBe(true);
  });
});
