// WSK-25 — the snapshot-first mechanism itself. `takeSnapshot` reads the target environment's
// CURRENT content and durably commits it to `promotion_snapshots` (immutable — REVOKE
// UPDATE/DELETE, see ../../migrations/0008_promotion.sql) in its OWN, independently-committed
// call — the caller (promotion-command.service.ts) MUST await this and see it resolve before
// opening the migrate/import transaction. That ordering — not a flag, not a comment, an actual
// sequential await — is the property test/promotion-snapshot-first.spec.ts proves by injecting a
// real failure into the step AFTER this one and showing the snapshot row is still there,
// untouched, readable in a fresh connection.
import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { ContentBundleService, bundleChecksum } from "./content-bundle.service";
import type { ContentBundle } from "./content-bundle.types";

export interface SnapshotRow {
  id: string;
  envId: string;
  bundle: ContentBundle;
  checksum: string;
  itemCount: number;
  takenAt: string;
}

@Injectable()
export class PromotionSnapshotService {
  constructor(
    private readonly db: DbService,
    private readonly bundles: ContentBundleService,
  ) {}

  /**
   * Exports the target environment's site content RIGHT NOW and commits it as a restore point.
   * Returns once the INSERT has actually committed — the caller may treat that return as proof
   * the snapshot is durable, not merely queued.
   */
  async takeSnapshot(input: { tenantId: string; promotionRunId: string; envId: string; siteId: string }): Promise<SnapshotRow> {
    const bundle = await this.bundles.exportBundle(input.tenantId, input.siteId);
    const checksum = bundleChecksum(bundle);
    const itemCount = bundle.contentItems.length;

    const row = await this.db.withTenant(input.tenantId, (db) =>
      db.transaction(async (client) => {
        const { rows } = await client.query<{ id: string; taken_at: string }>(
          `INSERT INTO promotion_snapshots (id, tenant_id, promotion_run_id, env_id, bundle, checksum, item_count)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6)
           RETURNING id, taken_at`,
          [input.tenantId, input.promotionRunId, input.envId, JSON.stringify(bundle), checksum, itemCount],
        );
        return rows[0];
      }),
    );

    return { id: row.id, envId: input.envId, bundle, checksum, itemCount, takenAt: row.taken_at };
  }

  /** Most recent restore point for `envId`, or null if none was ever taken — the rollback caller MUST refuse rather than treat null as "nothing to do". */
  async latestSnapshot(tenantId: string, envId: string): Promise<SnapshotRow | null> {
    const row = await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ id: string; bundle: ContentBundle; checksum: string; item_count: number; taken_at: string }>(
        `SELECT id, bundle, checksum, item_count, taken_at
           FROM promotion_snapshots
          WHERE env_id = $1
          ORDER BY taken_at DESC
          LIMIT 1`,
        [envId],
      );
      return rows[0] ?? null;
    });
    if (!row) return null;

    // Integrity check on the way OUT, not just the way in — a restore built from a silently
    // corrupted snapshot would be worse than refusing outright.
    const recomputed = bundleChecksum(row.bundle);
    if (recomputed !== row.checksum) {
      throw new InternalServerErrorException(
        `promotion_snapshots row ${row.id} failed its own checksum (stored ${row.checksum}, recomputed ${recomputed}) — refusing to restore from a snapshot that may have been altered`,
      );
    }

    return { id: row.id, envId, bundle: row.bundle, checksum: row.checksum, itemCount: row.item_count, takenAt: row.taken_at };
  }
}
