// WSK-22 — §03 Layer 3 (command authz against the token's scopes) + Layer 4 (the WS4 assertion
// on irreversible commands). Binds to POLICY_DECISION_POINT in control.module.ts for every
// environment except NODE_ENV=test — see that file's comment.
//
// Layer 3 stays exactly what DevModePolicyDecisionPoint already did (scope membership check) —
// the ticket's own brief scopes Layer 3 as "against the token's scopes ... via WSK-21's
// PolicyDecisionPoint", not "stand up a Cerbos sidecar". design §03 does name a Zone B Cerbos
// sidecar as the eventual Layer-3 engine (D-11); that container and its policy set are
// `webdesk/docker-compose.yml` + `webdesk/cerbos/`-shaped work this ticket does not own (WSK-21's
// own README already flagged this the same way) — WSK-31 is where a real Cerbos `check()` call
// swaps in behind this same PolicyDecisionPoint interface, per policy-decision-point.ts's own
// header comment. What changes HERE, versus the dev-mode stub, is Layer 4: real HMAC
// verification, real commandHash comparison, and real (DB-backed) single-use enforcement,
// replacing "was some string present in a header."
//
// WSK-D3's whole point, restated in code: this function refuses a HIGH-impact command with no
// verifiable WS4 assertion regardless of what scopes the token carries or what Zone A's own gate
// decided — "Zone B must refuse a call that skipped WS4 even if Zone A would have allowed it."
import { Injectable } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import type { PolicyDecisionPoint, PolicyDecisionInput, PolicyDecision } from "./policy-decision-point";
import { verifyWs4Signature, computeCommandHash } from "../auth/ws4-assertion";

function requireEnv(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[webdesk:api] ${name} is not set — refusing to boot the real policy decision point in production.`);
  }
  return devFallback;
}

@Injectable()
export class RealPolicyDecisionPoint implements PolicyDecisionPoint {
  private readonly assertionKey = requireEnv("WEBDESK_APPROVAL_ASSERTION_KEY", "dev-only-insecure-ws4-key-do-not-use-in-prod");

  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
  ) {}

  async evaluate(input: PolicyDecisionInput): Promise<PolicyDecision> {
    const { principal, meta, tenantSlug, ws4AssertionHeader, args } = input;

    // Layer 3 — command authz against the token's scopes.
    if (!principal.scopes.includes(meta.scope)) {
      return { allow: false, reason: `principal lacks required scope '${meta.scope}' for command '${meta.command}'` };
    }

    if (meta.impactClass !== "high") {
      return { allow: true };
    }

    // Layer 4 — WS4 assertion, irreversible commands only (design §03 Layer 4 / WSK-D3).
    if (!ws4AssertionHeader) {
      return {
        allow: false,
        reason:
          `command '${meta.command}' is HIGH-impact and always requires a WS4 assertion ` +
          `(design §03 Layer 4) — none was presented`,
      };
    }

    const sig = verifyWs4Signature(ws4AssertionHeader, this.assertionKey);
    if (!sig.ok) {
      return { allow: false, reason: `WS4 assertion rejected: ${sig.reason}` };
    }

    const expectedHash = computeCommandHash(meta.command, args ?? {});
    if (sig.claims.commandHash !== expectedHash) {
      return {
        allow: false,
        reason:
          "WS4 assertion commandHash does not match the actual command arguments — refused " +
          "(design WSK-D3: Zone B never trusts a claimed approval for arguments it did not itself see)",
      };
    }

    const alreadyUsed = await this.wasApprovalIdAlreadyUsed(sig.claims.approvalId, tenantSlug);
    if (alreadyUsed) {
      return {
        allow: false,
        reason: "WS4 assertion has already been used for a prior command — single-use violated, replay refused",
      };
    }

    return { allow: true };
  }

  /**
   * Dedup source of truth is `audit_entries.ws4_approval_id` (design §03: "enforces single use —
   * dedup by approvalId in its audit store"), the SAME table command-audit.service.ts writes to
   * once a command actually completes. Checks BOTH the platform-level ledger (tenant_id IS NULL —
   * `tenant.provision`/`tenant.archive` both audit at platform scope even though `tenant.archive`
   * has a `:slug` route param, per lifecycle.service.ts's own `recordPlatform` call) and, when a
   * tenant is in scope, that tenant's own ledger — rather than hard-coding which HIGH commands
   * use which scope (a table this file would have to keep in sync with lifecycle.service.ts by
   * hand, and does not own).
   *
   * KNOWN GAP, documented rather than hidden (same doctrine as WSK-21's own in-memory
   * idempotency/job stores): this is a SELECT check with no unique constraint backing it
   * (0001_platform_core.sql's `ix_audit_entries_ws4` is a plain index, not a unique one, and
   * `migrations/**` is out of this ticket's owned scope to change). Two requests presenting the
   * SAME approvalId at genuinely the same instant, before either's audit row has committed, could
   * both pass this check. The realistic replay case — an attacker reusing an approvalId that was
   * already used by a COMPLETED prior command — is closed by this check; the sub-millisecond
   * concurrent-double-fire case is not fully closed without a
   * `UNIQUE INDEX ... ON audit_entries (ws4_approval_id) WHERE ws4_approval_id IS NOT NULL`
   * migration, which needs senior-db approval per this ticket's own instruction not to improvise
   * DDL. Reported in ../../../README.md's "required changes" section.
   */
  private async wasApprovalIdAlreadyUsed(approvalId: string, tenantSlug: string | null): Promise<boolean> {
    const platformHit = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM audit_entries WHERE tenant_id IS NULL AND ws4_approval_id = $1 LIMIT 1`,
        [approvalId],
      );
      return rows.length > 0;
    });
    if (platformHit) return true;

    if (tenantSlug === null) return false;
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant) return false; // no tenant, no prior use possible under it — the command itself will 404 downstream

    return this.db.withTenant(tenant.id, (db) =>
      db.query(`SELECT 1 FROM audit_entries WHERE ws4_approval_id = $1 LIMIT 1`, [approvalId]).then((r) => r.rows.length > 0),
    );
  }
}
