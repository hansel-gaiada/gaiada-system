// WSK-07 — per-tenant storage quota (§11a: "Per-tenant storage quotas ... are the enforcement" of
// the self-hosted-media viability preconditions). No dedicated ledger/column exists for this (a live SUM
// is cheap at this scale and cannot drift) — enforced here as a SUM over `media_assets.size_bytes`, scoped
// by the same RLS the rest of this module relies on (db.withTenant already sets `webdesk.tenant_ctx`, so
// this query only ever sees the caller's own rows regardless of how it is written).
//
// WSK-43a — WHAT COUNTS: BYTES HELD. The sum is over every asset whose stored object still exists, that is
// `purged_at IS NULL`: the live library AND the soft-deleted assets still inside their GOVERNANCE retention
// (their object versions cannot be deleted until the lock lapses, so storage really is holding those
// bytes, and a tenant that deletes and re-uploads cannot exceed its quota by doing so). A purged asset
// (`purged_at` set, every stored version deleted by the `media-purge` job) no longer counts: the quota
// drops when the bytes are actually freed, not when the editor clicked delete.
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { storageConfig } from "../storage/storage.config";

@Injectable()
export class QuotaService {
  constructor(private readonly db: DbService) {}

  /**
   * Bytes storage still holds for this tenant, across every bucket (see the header). With `client`, the read
   * runs on that connection (an upload that already holds a transaction must not ask the pool for a second
   * connection while it waits).
   */
  async usedBytes(tenantId: string, client?: PoolClient): Promise<number> {
    const sql = `SELECT sum(size_bytes)::bigint AS total FROM media_assets WHERE purged_at IS NULL`;
    if (client) {
      const { rows } = await client.query<{ total: string | null }>(sql);
      return Number(rows[0]?.total ?? 0);
    }
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ total: string | null }>(sql);
      return Number(rows[0]?.total ?? 0);
    });
  }

  /** Would adding `incomingBytes` push this tenant over its quota? */
  async wouldExceedQuota(tenantId: string, incomingBytes: number, client?: PoolClient): Promise<boolean> {
    const used = await this.usedBytes(tenantId, client);
    return used + incomingBytes > storageConfig.tenantStorageQuotaBytes;
  }
}
