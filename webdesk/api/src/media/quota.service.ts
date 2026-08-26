// WSK-07 — per-tenant storage quota (§11a: "Per-tenant storage quotas ... are the enforcement" of
// the self-hosted-media viability preconditions). No dedicated ledger/column exists for this yet
// (migrations are out of this ticket's scope) — enforced here as a live SUM over
// `media_assets.size_bytes`, scoped by the same RLS the rest of this ticket relies on
// (db.withTenant already sets `webdesk.tenant_ctx`, so this query only ever sees the caller's own
// rows regardless of how it is written).
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { storageConfig } from "../storage/storage.config";

@Injectable()
export class QuotaService {
  constructor(private readonly db: DbService) {}

  /** Bytes already stored for this tenant, across every bucket. */
  async usedBytes(tenantId: string): Promise<number> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ total: string | null }>(
        `SELECT sum(size_bytes)::bigint AS total FROM media_assets`,
      );
      return Number(rows[0]?.total ?? 0);
    });
  }

  /** Would adding `incomingBytes` push this tenant over its quota? */
  async wouldExceedQuota(tenantId: string, incomingBytes: number): Promise<boolean> {
    const used = await this.usedBytes(tenantId);
    return used + incomingBytes > storageConfig.tenantStorageQuotaBytes;
  }
}
