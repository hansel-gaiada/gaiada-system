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
//
// M4 F1 — two assertion versions (auth/ws4-assertion.ts verifyWs4Assertion picks one by SHAPE):
//   v1 HMAC   accepted only while WEBDESK_APPROVAL_ASSERTION_KEY holds a real key. In production an
//             unset key, or one of the published placeholders, retires v1 (logged at boot); outside
//             production the old dev default still applies, so the test suites are unchanged.
//   v2 EdDSA  accepted only while the pinned WS4 key set (WEBDESK_WS4_JWKS_FILE, auth/ws4-jwks.ts) is
//             installed. A present-but-malformed file, or one sharing a kid or a key with the editorial
//             JWKS, REFUSES BOOT (thrown from this constructor). Absent → v2 unavailable, v1 unaffected.
// With neither, the api still boots (/v1 delivery stays up) and every HIGH command is refused here,
// fail closed, with the reason in the boot log and in every refusal. Single use is the same for both
// versions (the approvalId dedup below). On ALLOW the verified version is noted for the audit row
// (auth/ws4-verified-version.ts → audit_entries.ws4_assertion_version, migration 0018).
import { Injectable, Logger } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import type { PolicyDecisionPoint, PolicyDecisionInput, PolicyDecision } from "./policy-decision-point";
import { computeCommandHash, verifyWs4Assertion, type Ws4VerifierKeys } from "../auth/ws4-assertion";
import { assertWs4KeysDisjointFromEditorial, loadWs4Jwks, WS4_JWKS_FILE_ENV } from "../auth/ws4-jwks";
import { EditorialJwksError, loadEditorialJwks, EDITORIAL_JWKS_FILE_ENV } from "../auth/editorial-jwks";
import { noteVerifiedWs4Version } from "../auth/ws4-verified-version";

export const WS4_HMAC_KEY_ENV = "WEBDESK_APPROVAL_ASSERTION_KEY";
/** The non-production default (unchanged from WSK-22). Never accepted in production. */
export const WS4_DEV_HMAC_KEY = "dev-only-insecure-ws4-key-do-not-use-in-prod";
/** Values published in this repo (the dev default and webdesk/.env.example): never a production key. */
const WS4_PLACEHOLDER_HMAC_KEYS: ReadonlySet<string> = new Set([WS4_DEV_HMAC_KEY, "changeme_approval_assertion_key"]);

export interface Ws4GateConfig extends Ws4VerifierKeys {
  /** One line per version, for the boot log: what is accepted and why. Never a key. */
  summary: string[];
}

/**
 * Resolves what Layer 4 accepts from the environment. Pure apart from reading the JWKS files.
 * Throws (boot refused) only for a present-but-malformed WS4 JWKS, or one overlapping the editorial
 * key set.
 */
export function resolveWs4GateConfig(env: NodeJS.ProcessEnv = process.env): Ws4GateConfig {
  const production = env.NODE_ENV === "production";
  const summary: string[] = [];

  let hmacKey: string | null;
  const raw = env[WS4_HMAC_KEY_ENV];
  if (raw && raw.length > 0) {
    if (production && WS4_PLACEHOLDER_HMAC_KEYS.has(raw)) {
      hmacKey = null;
      summary.push(`v1 (HMAC) REFUSED: ${WS4_HMAC_KEY_ENV} holds a published placeholder, never a production key`);
    } else {
      hmacKey = raw;
      summary.push(`v1 (HMAC) accepted (${WS4_HMAC_KEY_ENV} set)`);
    }
  } else if (production) {
    hmacKey = null;
    summary.push(`v1 (HMAC) retired: ${WS4_HMAC_KEY_ENV} is not set`);
  } else {
    hmacKey = WS4_DEV_HMAC_KEY;
    summary.push(`v1 (HMAC) accepted with the NON-PRODUCTION default key (${WS4_HMAC_KEY_ENV} unset, NODE_ENV=${env.NODE_ENV ?? ""})`);
  }

  const v2 = loadWs4Jwks(env[WS4_JWKS_FILE_ENV]); // throws on a present-but-malformed file: boot refused
  if (v2.state === "configured") {
    let editorial: ReturnType<typeof loadEditorialJwks> | null = null;
    try {
      editorial = loadEditorialJwks(env[EDITORIAL_JWKS_FILE_ENV]);
    } catch (err) {
      // A malformed editorial file refuses boot in the editorial resolver, with its own message.
      if (!(err instanceof EditorialJwksError)) throw err;
    }
    if (editorial?.state === "configured") assertWs4KeysDisjointFromEditorial(v2.keys, v2.source, editorial.keys);
    summary.push(`v2 (EdDSA) accepted, WS4 JWKS from ${v2.source}: kid(s) ${[...v2.keys.keys()].join(", ")}`);
  } else {
    summary.push(`v2 (EdDSA) unavailable: ${v2.reason}`);
  }

  return { hmacKey, v2Keys: v2.state === "configured" ? v2.keys : null, summary };
}

@Injectable()
export class RealPolicyDecisionPoint implements PolicyDecisionPoint {
  private readonly logger = new Logger(RealPolicyDecisionPoint.name);
  private readonly ws4Keys: Ws4VerifierKeys;

  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
  ) {
    const gate = resolveWs4GateConfig();
    this.ws4Keys = { hmacKey: gate.hmacKey, v2Keys: gate.v2Keys };
    const line = `WS4 gate: ${gate.summary.join("; ")}`;
    if (gate.hmacKey === null && gate.v2Keys === null) {
      this.logger.error(`${line} — NO WS4 assertion can verify: every HIGH-impact command will be refused`);
    } else {
      this.logger.log(line);
    }
  }

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

    const sig = verifyWs4Assertion(ws4AssertionHeader, this.ws4Keys);
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

    noteVerifiedWs4Version(sig.claims.approvalId, sig.version);
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
