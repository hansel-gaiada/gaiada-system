// WSK-43a (owner ruling WSK-D54, "the lifecycle") — the `media-purge` job: frees the storage of media assets
// the library deleted. It closes the long-standing defect "locked object versions are never freed".
//
// WHY IT EXISTS. Every bucket is versioned with a GOVERNANCE default retention (storage-bootstrap.mjs,
// WEBDESK_STORAGE_LOCK_DAYS, default 1 day). A plain delete of an object on such a bucket only adds a delete
// marker: every version stays, locked, and nothing ever removed them, while the quota counted rows. Now
// `media.delete` soft-deletes the asset with purge_after = deleted_at + that retention, and this job, once the
// retention has passed, deletes EVERY stored version of the object (each by its VersionId, delete markers
// included) and stamps purged_at. The retention has lapsed, so GOVERNANCE lets the delete through without a
// bypass; the api's storage key holds no bypass permission, only s3:DeleteObjectVersion on the public buckets
// (storage-bootstrap.mjs), and a version that is somehow still locked is simply refused by the provider.
//
// THE RULES.
//   * Due means: deleted_at set, purged_at NULL, purge_after <= the DATABASE's now() (every replica agrees).
//   * ONE ASSET PER TRANSACTION, `FOR UPDATE SKIP LOCKED`, the row lock held across the storage calls: a second
//     replica (or an overlapping run) skips what this one holds, and after this one commits the row no longer
//     matches, so an asset is purged once. Both are safe to run at the same time; overlap is only wasted work.
//   * A STORAGE ERROR LEAVES THE ASSET UN-PURGED: the transaction rolls back, the error is logged with the
//     asset id, the asset is not retried within this run, and the next run (an hour later) tries again. It is
//     counted, never thrown: one asset's failure (or a storage outage) must not stop the other assets, the
//     other tenants or the process. If storage succeeded and the commit then failed, the next run lists no
//     versions left, deletes nothing and stamps purged_at: the purge is idempotent.
//   * Per tenant, under that tenant's own webdesk.tenant_ctx (the app role cannot see across tenants), and at
//     most MAX_ASSETS_PER_TENANT per run; the rest is the next run's.
//   * Quota: media/quota.service.ts counts purged_at IS NULL, so the bytes leave the quota in the same commit
//     that stamps purged_at.
import { Inject, Injectable, Logger } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { DbService } from "../db/db.service";
import { decodeBucketKey } from "../media/bucket-key-codec";
import { STORAGE_ADAPTER } from "../storage/storage.tokens";
import type { StorageAdapter } from "../storage/storage.types";
import { PUBLIC_BUCKETS, storageConfig } from "../storage/storage.config";

export const MEDIA_PURGE_ACTOR = "system:scheduler";
export const MEDIA_PURGE_ACTION = "webdesk.media.purged";
/** At most this many assets per tenant per run; the remainder is the next run's. */
export const MAX_ASSETS_PER_TENANT = 200;

export interface MediaPurgeResult {
  tenants: number;
  /** Assets whose stored versions were deleted and purged_at stamped. */
  purged: number;
  /** Object versions (and delete markers) deleted across them. */
  versionsDeleted: number;
  /** Assets left un-purged this run (storage error, or a key that does not decode): see the log. */
  failed: number;
}

type StepOutcome = { kind: "purged"; versions: number } | { kind: "failed" } | null;

@Injectable()
export class MediaPurgeService {
  private readonly logger = new Logger(MediaPurgeService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  /** One run over every tenant. Never rejects for an asset or tenant that failed: those are logged and counted. */
  async runMediaPurge(): Promise<MediaPurgeResult> {
    const tenants = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string }>(`SELECT id, slug FROM tenants ORDER BY slug`);
      return rows;
    });
    const total: MediaPurgeResult = { tenants: tenants.length, purged: 0, versionsDeleted: 0, failed: 0 };
    for (const tenant of tenants) {
      try {
        const r = await this.purgeTenant(tenant.id);
        total.purged += r.purged;
        total.versionsDeleted += r.versionsDeleted;
        total.failed += r.failed;
      } catch (err) {
        total.failed++;
        this.logger.error(`media purge: tenant ${tenant.slug} failed: ${String(err)}`);
      }
    }
    // Quiet when idle: an hourly line saying nothing happened is noise.
    if (total.purged > 0 || total.failed > 0) {
      this.logger.log(`media purge: tenants=${total.tenants} purged=${total.purged} versionsDeleted=${total.versionsDeleted} failed=${total.failed}`);
    }
    return total;
  }

  private async purgeTenant(tenantId: string): Promise<Omit<MediaPurgeResult, "tenants">> {
    const out = { purged: 0, versionsDeleted: 0, failed: 0 };
    // Ids this run has already tried and left: a failed asset is not picked again in a loop.
    const skip: string[] = [];
    while (out.purged + out.failed < MAX_ASSETS_PER_TENANT) {
      const step = await this.purgeOne(tenantId, skip);
      if (step === null) break;
      if (step.kind === "purged") {
        out.purged++;
        out.versionsDeleted += step.versions;
      } else {
        out.failed++;
      }
    }
    return out;
  }

  /** Claims ONE due asset in its own transaction and purges it. null when nothing is due. */
  private async purgeOne(tenantId: string, skip: string[]): Promise<StepOutcome> {
    const claimed: { id?: string } = {};
    try {
      return await this.db.withTenant(tenantId, (db) =>
        db.transaction(async (client): Promise<StepOutcome> => {
          const { rows } = await client.query<{ id: string; bucket_key: string }>(
            `SELECT id, bucket_key FROM media_assets
              WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after <= now() AND id <> ALL($1::uuid[])
              ORDER BY purge_after, id
              LIMIT 1
              FOR UPDATE SKIP LOCKED`,
            [skip],
          );
          const asset = rows[0];
          if (!asset) return null;
          claimed.id = asset.id;
          skip.push(asset.id); // not again in this run, whatever happens next

          const decoded = decodeBucketKey(asset.bucket_key);
          if (!decoded || !PUBLIC_BUCKETS.has(decoded.bucket)) {
            // Library assets live in the public buckets; anything else is a data surprise worth a loud log, not a delete.
            this.logger.error(`media purge: asset ${asset.id} has bucket_key '${asset.bucket_key}', not a public-bucket key: left un-purged`);
            return { kind: "failed" };
          }

          const versions = await this.storage.deleteAllVersions(storageConfig.bucketName(decoded.bucket), decoded.objectKey);
          await client.query(`UPDATE media_assets SET purged_at = now(), updated_at = now() WHERE id = $1`, [asset.id]);
          await this.audit.record(client, {
            tenantId,
            actor: MEDIA_PURGE_ACTOR,
            action: MEDIA_PURGE_ACTION,
            args: { mediaAssetId: asset.id, bucket: decoded.bucket, versionsDeleted: versions },
          });
          return { kind: "purged", versions };
        }),
      );
    } catch (err) {
      // Storage (or the database) failed: the transaction rolled back, the asset is still un-purged.
      this.logger.error(`media purge: asset ${claimed.id ?? "?"} left un-purged, the next run retries: ${String(err)}`);
      // A failure before any asset was claimed (the claim query itself) ends this tenant's run for now.
      return claimed.id ? { kind: "failed" } : null;
    }
  }
}
