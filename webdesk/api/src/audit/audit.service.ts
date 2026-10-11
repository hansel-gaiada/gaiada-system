// WSK-05 — writes to `audit_entries` (design §04/§11: "every command" gets one). `args_hash` is a
// hash of the command's NON-SECRET arguments only — it must never be derivable back into, or
// itself contain, a plaintext api key. Callers pass an already-scrubbed args object; this file
// does not know or care what a "key" looks like.
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export type AuditArgs = Record<string, string | number | boolean | null>;

@Injectable()
export class AuditService {
  hashArgs(args: AuditArgs): string {
    return createHash("sha256").update(JSON.stringify(args)).digest("hex");
  }

  /** Must run on a connection that already has the right GUC context (tenant or platform). */
  async record(
    client: PoolClient,
    entry: { tenantId: string | null; actor: string; action: string; args?: AuditArgs; ws4ApprovalId?: string | null },
  ): Promise<void> {
    const argsHash = entry.args ? this.hashArgs(entry.args) : null;
    await client.query(
      `INSERT INTO audit_entries (tenant_id, actor, action, args_hash, ws4_approval_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.tenantId, entry.actor, entry.action, argsHash, entry.ws4ApprovalId ?? null],
    );
  }
}
