// WSK-43a (owner ruling WSK-D54, "the lifecycle") — the `media-purge` job and the storage call under it:
// every stored version of a soft-deleted asset's object is deleted once its GOVERNANCE retention has passed,
// purged_at is set, and the quota drops. This closes the defect "locked object versions are never freed".
//
// REAL RustFS (the gate provides it; storage-bootstrap.mjs has made the buckets: versioned, GOVERNANCE, one
// day) and the api's own least-privilege storage key. Everything the api itself writes is locked for the
// bucket default, one day, so nothing it wrote can be purged inside a test run; the purge tests therefore write
// their objects through the ROOT client with an explicit retention that lapses in seconds (RustFS honours a
// per-object retention shorter than the bucket default: measured, see the first test), wait for it to lapse,
// and verify with an independent listing of every version. The NEGATIVE CONTROL uses an object written the way
// the api writes (default lock) and shows the purge is refused by the provider, not bypassed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "@nestjs/common";
import { asTenant, buildContentApp, createContentFixture, type ContentFixture } from "./content-test-kit";
import { MEDIA_BUCKET, auditRows, getAsset, listVersions, plainDelete, putLockedForSeconds, seedAsset, sleep } from "./media-library-kit";
import { S3StorageAdapter } from "../src/storage/s3-storage.adapter";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { QuotaService } from "../src/media/quota.service";
import type { StorageAdapter } from "../src/storage/storage.types";
import { MEDIA_PURGE_ACTION, MediaPurgeService } from "../src/scheduler/media-purge.service";

const svcCfg = {
  endpoint: process.env.STORAGE_ENDPOINT || "http://127.0.0.1:9000",
  region: "us-east-1",
  forcePathStyle: true,
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "webdesk_api",
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_api_secret_key",
};

/** Wraps the real adapter, counting deleteAllVersions per key and optionally failing for chosen keys. */
class CountingAdapter implements StorageAdapter {
  readonly providerName = "counting";
  readonly calls: string[] = [];
  constructor(
    private readonly inner: StorageAdapter,
    private readonly failFor: ReadonlySet<string> = new Set(),
  ) {}
  putObject(b: string, k: string, body: Buffer, ct: string) {
    return this.inner.putObject(b, k, body, ct);
  }
  getObject(b: string, k: string) {
    return this.inner.getObject(b, k);
  }
  headObject(b: string, k: string) {
    return this.inner.headObject(b, k);
  }
  deleteObject(b: string, k: string) {
    return this.inner.deleteObject(b, k);
  }
  presignGetObject(b: string, k: string, e: number) {
    return this.inner.presignGetObject(b, k, e);
  }
  ensureBucket(b: string) {
    return this.inner.ensureBucket(b);
  }
  async deleteAllVersions(b: string, k: string): Promise<number> {
    this.calls.push(k);
    if (this.failFor.has(k)) throw new Error(`simulated storage outage for ${k}`);
    return this.inner.deleteAllVersions(b, k);
  }
}

const due = { deletedAgo: "3 days", purgeAfterAgo: "1 hour" }; // deleted 3 days ago, purgeable since an hour ago
const notDue = { deletedAgo: "1 hour", purgeAfterAgo: "-23 hours" };

describe("WSK-43a media purge", () => {
  let app: NestFastifyApplication;
  let db: DbService;
  let audit: AuditService;
  let real: S3StorageAdapter;
  const makeService = (adapter: StorageAdapter = real) => new MediaPurgeService(db, audit, adapter);

  beforeAll(async () => {
    app = await buildContentApp();
    db = app.get(DbService);
    audit = app.get(AuditService);
    real = new S3StorageAdapter(svcCfg);
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // The storage call
  // ==============================================================================================
  describe("StorageAdapter.deleteAllVersions (real RustFS, the api's own key)", () => {
    it("deletes EVERY version and delete marker of exactly that key once the lock has lapsed, and nothing of a sibling key; a still-locked version is refused, not bypassed", async () => {
      const prefix = `wsk43/adapter-${randomUUID()}`;
      const key = `${prefix}/a`;
      const sibling = `${prefix}/ab`; // shares the prefix "a": must survive
      await putLockedForSeconds(MEDIA_BUCKET, key, "v1", 2);
      await putLockedForSeconds(MEDIA_BUCKET, key, "v2", 2);
      await plainDelete(MEDIA_BUCKET, key); // a delete marker, which is what the api's own deleteObject leaves behind
      await putLockedForSeconds(MEDIA_BUCKET, sibling, "sib", 2);
      const before = await listVersions(MEDIA_BUCKET, key);
      expect(before.versions).toHaveLength(2);
      expect(before.markers).toHaveLength(1);

      // THE LOCK HOLDS: too early, the provider refuses (the api key holds no bypass permission)
      await expect(real.deleteAllVersions(MEDIA_BUCKET, key)).rejects.toMatchObject({ name: "AccessDenied" });
      expect((await listVersions(MEDIA_BUCKET, key)).versions.length).toBeGreaterThan(0);

      await sleep(3500);
      expect(await real.deleteAllVersions(MEDIA_BUCKET, key)).toBe(3); // 2 versions + 1 marker
      expect(await listVersions(MEDIA_BUCKET, key)).toEqual({ versions: [], markers: [] });
      expect((await listVersions(MEDIA_BUCKET, sibling)).versions).toHaveLength(1);
      expect(await real.deleteAllVersions(MEDIA_BUCKET, key)).toBe(0); // idempotent: nothing left
      expect(await real.deleteAllVersions(MEDIA_BUCKET, `${prefix}/never-existed`)).toBe(0);
      expect(await real.deleteAllVersions(MEDIA_BUCKET, sibling)).toBe(1);
    }, 30_000);

    it("pages through a truncated version listing (a stubbed client, since a thousand real versions is not worth the minutes)", async () => {
      const adapter = new S3StorageAdapter(svcCfg);
      const sent: { cmd: string; input: Record<string, unknown> }[] = [];
      (adapter as unknown as { client: { send: (c: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown> } }).client = {
        async send(c) {
          sent.push({ cmd: c.constructor.name, input: c.input });
          if (c.constructor.name === "ListObjectVersionsCommand") {
            if (!c.input.KeyMarker) {
              return { IsTruncated: true, NextKeyMarker: "k", NextVersionIdMarker: "v2", Versions: [{ Key: "k", VersionId: "v1" }, { Key: "k", VersionId: "v2" }, { Key: "kk", VersionId: "other" }] };
            }
            return { IsTruncated: false, Versions: [{ Key: "k", VersionId: "v3" }], DeleteMarkers: [{ Key: "k", VersionId: "m1" }] };
          }
          return {};
        },
      };
      expect(await adapter.deleteAllVersions("media", "k")).toBe(4);
      const lists = sent.filter((s) => s.cmd === "ListObjectVersionsCommand");
      expect(lists).toHaveLength(2);
      expect(lists[1].input).toMatchObject({ KeyMarker: "k", VersionIdMarker: "v2", Prefix: "k" });
      expect(sent.filter((s) => s.cmd === "DeleteObjectCommand").map((s) => s.input.VersionId)).toEqual(["v1", "v2", "v3", "m1"]); // 'kk' (a sibling) is never deleted
    });
  });

  // ==============================================================================================
  // The job
  // ==============================================================================================
  describe("media-purge", () => {
    let f: ContentFixture;
    const keyOf = (label: string) => `t/${randomUUID()}/${randomUUID()}-${label}.png`;
    let purgeable: { id: string; objectKey: string; versions: number }[] = [];
    let early: { id: string; objectKey: string };
    let live: { id: string; objectKey: string };

    beforeAll(async () => {
      f = await createContentFixture("purge");
      // 3 assets, each with 2 versions + a delete marker whose lock lapses in ~3 s
      for (let i = 0; i < 3; i++) {
        const a = await seedAsset(f, { sizeBytes: 1000 * (i + 1), deleted: due, objectKey: keyOf(`due${i}`) });
        await putLockedForSeconds(MEDIA_BUCKET, a.objectKey, "one", 3);
        await putLockedForSeconds(MEDIA_BUCKET, a.objectKey, "two", 3);
        await plainDelete(MEDIA_BUCKET, a.objectKey);
        purgeable.push({ id: a.id, objectKey: a.objectKey, versions: 3 });
      }
      // deleted, but its purge_after is still in the future
      early = await seedAsset(f, { sizeBytes: 7000, deleted: notDue, objectKey: keyOf("early") });
      await putLockedForSeconds(MEDIA_BUCKET, early.objectKey, "early", 3);
      // not deleted at all
      live = await seedAsset(f, { sizeBytes: 9000, objectKey: keyOf("live") });
      await putLockedForSeconds(MEDIA_BUCKET, live.objectKey, "live", 3);
      await sleep(3500); // every lock above has lapsed: only purge_after / deleted_at stand between these objects and the job
    }, 30_000);

    it("PURGES a deleted asset past purge_after: every stored version is gone (independent listing), purged_at set, the QUOTA drops by its bytes, the purge is audited; assets before purge_after and live assets are UNTOUCHED", async () => {
      const quota = app.get(QuotaService);
      expect(await quota.usedBytes(f.tenantId)).toBe(1000 + 2000 + 3000 + 7000 + 9000);
      for (const a of purgeable) expect((await listVersions(MEDIA_BUCKET, a.objectKey)).versions).toHaveLength(2);

      const result = await makeService().runMediaPurge();
      expect(result.failed).toBe(0);
      expect(result.purged).toBeGreaterThanOrEqual(3);
      expect(result.versionsDeleted).toBeGreaterThanOrEqual(9);

      for (const a of purgeable) {
        expect(await listVersions(MEDIA_BUCKET, a.objectKey)).toEqual({ versions: [], markers: [] }); // EVERY version and marker
        const row = (await getAsset(f, a.id)) as Record<string, any>;
        expect(row.purged_at).not.toBeNull();
        expect(row.deleted_at).not.toBeNull();
      }
      expect(await quota.usedBytes(f.tenantId)).toBe(7000 + 9000); // the three purged assets' bytes are freed

      // not yet due: untouched, still counted
      expect((await listVersions(MEDIA_BUCKET, early.objectKey)).versions).toHaveLength(1);
      expect((await getAsset(f, early.id))?.purged_at).toBeNull();
      // not deleted: untouched
      expect((await listVersions(MEDIA_BUCKET, live.objectKey)).versions).toHaveLength(1);
      expect((await getAsset(f, live.id))?.purged_at).toBeNull();
      expect((await getAsset(f, live.id))?.deleted_at).toBeNull();

      const purgedAudit = await auditRows(f, MEDIA_PURGE_ACTION);
      expect(purgedAudit).toHaveLength(3);
      expect(purgedAudit.every((r) => r.actor === "system:scheduler")).toBe(true);
    }, 60_000);

    it("a second run is a no-op for what is already purged, and the early asset becomes purgeable only when ITS purge_after (the database's clock) passes", async () => {
      const again = await makeService().runMediaPurge();
      expect(again.failed).toBe(0);
      expect(again.purged).toBe(0);
      expect((await listVersions(MEDIA_BUCKET, early.objectKey)).versions).toHaveLength(1);
      // its purge_after arrives (moved by the migrator, the database's now() decides): now it goes
      await asTenant(f.tenantId, async (c) => {
        await c.query(`UPDATE media_assets SET deleted_at = now() - interval '2 days', purge_after = now() - interval '1 second' WHERE id = $1`, [early.id]);
      });
      const r = await makeService().runMediaPurge();
      expect(r.purged).toBe(1);
      expect(await listVersions(MEDIA_BUCKET, early.objectKey)).toEqual({ versions: [], markers: [] });
      expect((await getAsset(f, early.id))?.purged_at).not.toBeNull();
      expect((await getAsset(f, live.id))?.purged_at).toBeNull(); // and the live one still is not
    }, 60_000);

    it("TWO PARALLEL RUNS purge each asset ONCE (FOR UPDATE SKIP LOCKED): each key's storage purge is called exactly once across both, every asset ends purged, one audit row each", async () => {
      const g = await createContentFixture("purge-par");
      const items: { id: string; objectKey: string }[] = [];
      for (let i = 0; i < 8; i++) {
        const a = await seedAsset(g, { sizeBytes: 100, deleted: due, objectKey: keyOf(`par${i}`) });
        await putLockedForSeconds(MEDIA_BUCKET, a.objectKey, "x", 2);
        items.push(a);
      }
      await sleep(2500);
      const a = new CountingAdapter(real);
      const b = new CountingAdapter(real);
      const [ra, rb] = await Promise.all([makeService(a).runMediaPurge(), makeService(b).runMediaPurge()]);
      expect(ra.failed + rb.failed).toBe(0);
      const calls = [...a.calls, ...b.calls].filter((k) => items.some((i) => i.objectKey === k));
      expect(calls.sort()).toEqual(items.map((i) => i.objectKey).sort()); // once each, no key twice
      for (const i of items) {
        expect((await getAsset(g, i.id))?.purged_at).not.toBeNull();
        expect(await listVersions(MEDIA_BUCKET, i.objectKey)).toEqual({ versions: [], markers: [] });
      }
      expect(await auditRows(g, MEDIA_PURGE_ACTION)).toHaveLength(8);
    }, 60_000);

    it("NEGATIVE CONTROL: an object still under its retention lock (written the way the api writes: the bucket default) is REFUSED by the provider: the asset stays un-purged, the run does not throw, the versions are still there", async () => {
      const g = await createContentFixture("purge-locked");
      const objectKey = keyOf("locked");
      await real.putObject(MEDIA_BUCKET, objectKey, Buffer.from("api written"), "image/png"); // default GOVERNANCE lock: one day
      const a = await seedAsset(g, { sizeBytes: 55, deleted: due, objectKey });
      const errors: string[] = [];
      const orig = Logger.prototype.error;
      Logger.prototype.error = function (this: Logger, msg: unknown, ...rest: unknown[]) {
        errors.push(String(msg));
        return (orig as (...args: unknown[]) => void).call(this, msg, ...rest);
      } as typeof Logger.prototype.error;
      let result;
      try {
        result = await makeService().runMediaPurge(); // resolves: a storage error is counted, never thrown
      } finally {
        Logger.prototype.error = orig;
      }
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect((await getAsset(g, a.id))?.purged_at).toBeNull();
      expect((await listVersions(MEDIA_BUCKET, objectKey)).versions).toHaveLength(1);
      expect(errors.some((e) => e.includes(a.id) && /left un-purged/.test(e))).toBe(true); // logged, with the asset id
      expect(await app.get(QuotaService).usedBytes(g.tenantId)).toBe(55); // still counted
      // it is not retried within a run in a loop, and stays eligible for the next one: take it out of the job's way for later tests
      await asTenant(g.tenantId, async (c) => {
        await c.query(`UPDATE media_assets SET purged_at = now() WHERE id = $1`, [a.id]);
      });
    }, 60_000);

    it("A STORAGE ERROR on one asset leaves THAT asset un-purged and the others are purged; the run resolves; the next run (storage back) purges it", async () => {
      const g = await createContentFixture("purge-outage");
      const good: { id: string; objectKey: string }[] = [];
      for (let i = 0; i < 3; i++) {
        const a = await seedAsset(g, { sizeBytes: 10, deleted: due, objectKey: keyOf(`good${i}`) });
        await putLockedForSeconds(MEDIA_BUCKET, a.objectKey, "x", 2);
        good.push(a);
      }
      const bad = await seedAsset(g, { sizeBytes: 10, deleted: due, objectKey: keyOf("bad") });
      await putLockedForSeconds(MEDIA_BUCKET, bad.objectKey, "x", 2);
      await sleep(2500);
      const flaky = new CountingAdapter(real, new Set([bad.objectKey]));
      const r = await makeService(flaky).runMediaPurge();
      expect(r.failed).toBeGreaterThanOrEqual(1);
      for (const a of good) expect((await getAsset(g, a.id))?.purged_at).not.toBeNull();
      expect((await getAsset(g, bad.id))?.purged_at).toBeNull();
      expect((await listVersions(MEDIA_BUCKET, bad.objectKey)).versions).toHaveLength(1);
      expect(flaky.calls.filter((k) => k === bad.objectKey)).toHaveLength(1); // not retried in a loop within the run
      // storage is back
      const healed = await makeService().runMediaPurge();
      expect(healed.failed).toBe(0);
      expect((await getAsset(g, bad.id))?.purged_at).not.toBeNull();
      expect(await listVersions(MEDIA_BUCKET, bad.objectKey)).toEqual({ versions: [], markers: [] });
    }, 60_000);

    it("an asset whose object is already gone is purged (idempotent: 0 versions deleted, purged_at set); a malformed bucket_key is left un-purged and the run goes on", async () => {
      const g = await createContentFixture("purge-odd");
      const gone = await seedAsset(g, { sizeBytes: 5, deleted: due, objectKey: keyOf("gone") }); // never stored
      const weird = await seedAsset(g, { sizeBytes: 5, deleted: due, objectKey: keyOf("weird") });
      await asTenant(g.tenantId, async (c) => {
        await c.query(`UPDATE media_assets SET bucket_key = 'no-bucket-prefix-here' WHERE id = $1`, [weird.id]);
      });
      const r = await makeService().runMediaPurge();
      expect(r.failed).toBeGreaterThanOrEqual(1);
      expect((await getAsset(g, gone.id))?.purged_at).not.toBeNull();
      expect((await getAsset(g, weird.id))?.purged_at).toBeNull();
      await asTenant(g.tenantId, async (c) => {
        await c.query(`UPDATE media_assets SET purged_at = now() WHERE id = $1`, [weird.id]);
      });
    }, 30_000);

    it("the job never reaches across tenants: a due asset of tenant B is purged under B's own context, and tenant A's rows were never read for it", async () => {
      const a = await createContentFixture("purge-iso-a");
      const b = await createContentFixture("purge-iso-b");
      const sa = await seedAsset(a, { deleted: due, objectKey: keyOf("iso-a") });
      const sb = await seedAsset(b, { deleted: due, objectKey: keyOf("iso-b") });
      await makeService().runMediaPurge();
      expect((await getAsset(a, sa.id))?.purged_at).not.toBeNull();
      expect((await getAsset(b, sb.id))?.purged_at).not.toBeNull();
      expect(await auditRows(a, MEDIA_PURGE_ACTION)).toHaveLength(1);
      expect(await auditRows(b, MEDIA_PURGE_ACTION)).toHaveLength(1);
      expect((await auditRows(a, MEDIA_PURGE_ACTION))[0].tenant_id).toBe(a.tenantId);
    }, 30_000);
  });
});
