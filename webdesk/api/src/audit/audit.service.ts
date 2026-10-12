// WSK-05 — writes to `audit_entries` (design §04/§11: "every command" gets one). `args_hash` is a
// hash of the command's NON-SECRET arguments only — it must never be derivable back into, or
// itself contain, a plaintext api key. Callers pass an already-scrubbed args object; this file
// does not know or care what a "key" looks like.
//
// M4 F1: a row carrying a WS4 approval id also records WHICH assertion version Layer 4 verified for
// it (`ws4_assertion_version`, 1 = HMAC, 2 = EdDSA; migration 0018). The version comes from
// control/auth/ws4-verified-version.ts, keyed by the same approval id; NULL when this process did not
// verify it (the dev-mode policy decision point, or no approval at all). Callers pass nothing new.
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { verifiedWs4VersionOf } from "../control/auth/ws4-verified-version";

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
    const ws4ApprovalId = entry.ws4ApprovalId ?? null;
    await client.query(
      `INSERT INTO audit_entries (tenant_id, actor, action, args_hash, ws4_approval_id, ws4_assertion_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.tenantId, entry.actor, entry.action, argsHash, ws4ApprovalId, verifiedWs4VersionOf(ws4ApprovalId)],
    );
  }
}
