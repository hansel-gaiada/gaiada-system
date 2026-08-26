// WSK-11 — suppression checks. "A suppressed address must never be delivered to" (ticket brief).
// 0004_mail.sql's `suppressions` table has no `stream` column (unlike Zone A's, which needs one
// because it has three streams) — Zone B has exactly one stream (identity.ts), so a suppression
// is unconditionally per-address, per-tenant. FORCE RLS + tenant_isolation on this table means
// every call here must run inside an already-active tenant context, same rule as
// mail-templates.service.ts.
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

export type SuppressionReason = "bounce" | "complaint" | "manual" | "unsubscribe";

@Injectable()
export class SuppressionService {
  constructor(private readonly db: DbService) {}

  /** Exact, lowercased match — mirrors the Zone A mail doctrine's own suppression semantics
   * (§5.1), adapted to Zone B's single-stream schema. */
  async isSuppressed(address: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM suppressions WHERE address = lower($1)`,
      [address],
    );
    return rows.length > 0;
  }

  async suppress(tenantId: string, address: string, reason: SuppressionReason): Promise<void> {
    await this.db.query(
      `INSERT INTO suppressions (tenant_id, address, reason) VALUES ($1, lower($2), $3)
       ON CONFLICT (tenant_id, address) DO UPDATE SET reason = EXCLUDED.reason, created_at = now()`,
      [tenantId, address, reason],
    );
  }
}
