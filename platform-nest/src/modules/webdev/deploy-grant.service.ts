// M6-P4g — the Postgres, ERP-App and ledger adapters for `deploy-grant.ts` (read that file's header first: the
// conditions, the state machine, why the claim commits before any write). This file binds the ports and authorizes:
//
//   withLockedSite  ONE `withTenants([tenantId], …, {modules:['webdev']})` transaction that takes the provisioning advisory
//                   lock (`takeProvisionLock`, the repo step's, P4c's and P4b2's own) before anything is read, so a grant, a
//                   revoke, a scaffold commit and a reconcile serialize on one site. The third wall applies to both tables
//                   read here (webdev_provisioned_sites, webdev_sites): an undeclared module scope matches ZERO rows.
//   readSnapshot    the pinned `webdev_contract_snapshots` row, same tenant + wall.
//   resolveRepo     P4b2's `resolveProvisionedRepo`: the repo GH-12 created for THIS row.
//   git             `erpGitCaller(orgTenant, actor)`: the ERP App through `githubRequest()`, the §4.1 chokepoint.
//   ledger          `withGithubLedger` (`action: "secret_write"`), under the ORG tenant, with the secret's NAME, the GH-12
//                   approval and the basis (`deploy-gate-grant` / `deploy-gate-revoke`, WSK-D29).
//
// ── AUTHORIZATION (no Cerbos change; every entry point goes through `authorizeDeployGrant`) ───────────
//   1. `webdev_provisioned_site · provision` on the request tenant: the grant is the last leg of §08's provisioning, the
//      same gate as the first fill (company_admin, manager, the webdev module manager, platform_admin; not low assurance);
//   2. `github_repo · push` on the GitHub ORG tenant (`resolveGithubOrgTenant`, GHT-1: resolve, then authorize against the
//      resolved tenant, never the URL tenant).
// The pair that authorized the first fill. `github_repo · secret_write` (D14-gated) is NOT used: it means writing a
// credential, which this never does, and the delivery automation (a manager) could never pass it. The ledger still
// records the true verb (`github.secret_write`) with its basis, the WSK-D65 precedent.
//
// ── THE ARCHIVE PATH ─────────────────────────────────────────────────────────────────────────────
// No code path archives or deletes a `webdev_sites` row today (nothing sets `deleted_at`; `webdesk.site.archive` is a 501
// stub). ANY FUTURE ARCHIVE OR REGISTRY-REMOVAL PATH MUST CALL `revokeDeployForSite` before it removes the row. Until
// then the operator route is the revoke, and a deleted registry row can never be (re-)granted (checkSiteConditions).
import { ForbiddenException, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { config } from "../../config";
import { authorize } from "../../core/http";
import { resolveGithubOrgTenant } from "../../core/github-org-tenant";
import { erpGitCaller, githubStatusOf } from "../../core/github/git-data";
import { withGithubLedger } from "../../core/github/ledger";
import { GithubApiError, GithubNotConfiguredError, GithubRateLimitedError, GithubTokenExchangeError } from "../../core/github/errors";
import { emitEvent } from "../../events/outbox.service";
import type { Principal } from "../../rbac/principal";
import { takeProvisionLock } from "./provisioning.service";
import { resolveProvisionedRepo } from "./provisioned-repo";
import type { SnapshotFacts } from "./scaffold-commit";
import {
  DeployGrantRefusal, SITE_SECRET_NOT_DERIVABLE, grantDeploySecrets, parseDeploySecretNames, parseRevokeReason, revokeDeploySecrets,
  type DeployGrantDeps, type DeployGrantResult, type DeployGrantRow, type DeployGrantState, type DeployGrantTx,
  type DeployRevokeResult, type GrantClaim, type RegistryFacts, type SecretOutcome,
} from "./deploy-grant";

const logger = new Logger("DeployGrant");

/** WSK-D29: repos self-deploy via org secrets they are GRANTED; this is that grant (and its revoke). */
export const DEPLOY_GATE_GRANT_BASIS = { kind: "deploy-gate-grant", ruling: "WSK-D29" } as const;
export const DEPLOY_GATE_REVOKE_BASIS = { kind: "deploy-gate-revoke", ruling: "WSK-D29" } as const;

// ── the row ──────────────────────────────────────────────────────────────────────────────────────

interface DeployGrantDbRow {
  id: string;
  tenant_id: string;
  slug: string;
  provider: string;
  provider_ref: string | null;
  status: string;
  repo_url: string | null;
  completion_state: string | null;
  contract_snapshot_id: string | null;
  webdev_site_id: string | null;
  scaffold_state: string | null;
  deploy_grant_state: DeployGrantState | null;
  deploy_grant_secret_names: string[] | null;
  deploy_grant_snapshot_id: string | null;
  deploy_grant_repository_id: string | number | null;
  deploy_grant_head_sha: string | null;
  deploy_grant_error: string | null;
  deploy_grant_updated_at: Date | string | null;
  deploy_grant_granted_at: Date | string | null;
  deploy_grant_revoked_at: Date | string | null;
  deploy_grant_revoke_reason: string | null;
  deploy_grant_site_secret_name: string | null;
  deploy_grant_pending_names: string[] | null;
}

const COLUMNS = `id, tenant_id, slug, provider, provider_ref, status, repo_url, completion_state, contract_snapshot_id, webdev_site_id,
  scaffold_state, deploy_grant_state, deploy_grant_secret_names, deploy_grant_snapshot_id, deploy_grant_repository_id,
  deploy_grant_head_sha, deploy_grant_error, deploy_grant_updated_at, deploy_grant_granted_at, deploy_grant_revoked_at,
  deploy_grant_revoke_reason, deploy_grant_site_secret_name, deploy_grant_pending_names`;

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));
const repoIdOf = (v: string | number | null): number | null => (v === null ? null : Number(v));

function toRow(r: DeployGrantDbRow): DeployGrantRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    slug: r.slug,
    provider: r.provider,
    providerRef: r.provider_ref,
    status: r.status,
    repoUrl: r.repo_url,
    completionState: r.completion_state,
    contractSnapshotId: r.contract_snapshot_id,
    webdevSiteId: r.webdev_site_id,
    scaffoldState: r.scaffold_state,
    grantState: r.deploy_grant_state,
    grantSecretNames: r.deploy_grant_secret_names ?? [],
    grantSnapshotId: r.deploy_grant_snapshot_id,
    grantRepositoryId: repoIdOf(r.deploy_grant_repository_id),
    grantHeadSha: r.deploy_grant_head_sha,
    grantError: r.deploy_grant_error,
    grantSiteSecretName: r.deploy_grant_site_secret_name,
    grantPendingNames: r.deploy_grant_pending_names ?? [],
  };
}

/** What `GET provisioned-sites/:id` returns beside the site (`deployGrant`). An explicit field list; names, never values. */
export interface DeployGrantDto {
  state: DeployGrantState | null;
  secretNames: string[];
  /** This site's per-site deploy secret (derived; the org owner creates it by hand with this exact name). Null until a grant
   *  has read the repo: the name ends in the repository's GitHub id. */
  siteSecretName: string | null;
  /** Why `siteSecretName` is null (SITE_SECRET_NOT_DERIVABLE), else null: the console shows it instead of a made-up name. */
  siteSecretNote: string | null;
  /** Names the owner has not created yet: the grant completes on the next run once they exist. */
  pendingNames: string[];
  snapshotId: string | null;
  repositoryId: number | null;
  headSha: string | null;
  error: string | null;
  updatedAt: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

function toDto(r: DeployGrantDbRow): DeployGrantDto {
  return {
    state: r.deploy_grant_state,
    secretNames: r.deploy_grant_secret_names ?? [],
    siteSecretName: r.deploy_grant_site_secret_name,
    siteSecretNote: r.deploy_grant_site_secret_name ? null : SITE_SECRET_NOT_DERIVABLE,
    pendingNames: r.deploy_grant_pending_names ?? [],
    snapshotId: r.deploy_grant_snapshot_id,
    repositoryId: repoIdOf(r.deploy_grant_repository_id),
    headSha: r.deploy_grant_head_sha,
    error: r.deploy_grant_error,
    updatedAt: iso(r.deploy_grant_updated_at),
    grantedAt: iso(r.deploy_grant_granted_at),
    revokedAt: iso(r.deploy_grant_revoked_at),
    revokeReason: r.deploy_grant_revoke_reason,
  };
}

export async function readDeployGrant(tenantId: string, siteId: string): Promise<DeployGrantDto | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<DeployGrantDbRow>(`SELECT ${COLUMNS} FROM webdev_provisioned_sites WHERE id = $1`, [siteId]),
    { modules: ["webdev"] },
  );
  return r.rows[0] ? toDto(r.rows[0]) : null;
}

// ── the transaction port ─────────────────────────────────────────────────────────────────────────

function txFor(c: PoolClient, tenantId: string, siteId: string): DeployGrantTx {
  const guarded = async (sql: string, params: unknown[], what: string): Promise<void> => {
    const r = await c.query(sql, params);
    // Under the lock, after a re-read that chose this step, the guarded UPDATE must match exactly one row.
    if (r.rowCount !== 1) throw new Error(`deploy grant: ${what} matched ${r.rowCount} rows`);
  };
  return {
    async read() {
      const r = await c.query<DeployGrantDbRow>(`SELECT ${COLUMNS} FROM webdev_provisioned_sites WHERE id = $1`, [siteId]);
      return r.rows[0] ? toRow(r.rows[0]) : null;
    },

    async readRegistry(webdevSiteId: string): Promise<RegistryFacts | null> {
      // Deleted rows are read too (and refused as such): "deleted" is a fact the condition needs, not a missing row.
      const r = await c.query<{ id: string; deleted_at: Date | null; origin: string; repo_url: string | null; environment: string }>(
        `SELECT id, deleted_at, origin, repo_url, environment FROM webdev_sites WHERE id = $1 AND tenant_id = $2`,
        [webdevSiteId, tenantId],
      );
      const s = r.rows[0];
      return s ? { id: s.id, deleted: s.deleted_at !== null, origin: s.origin, repoUrl: s.repo_url, environment: s.environment } : null;
    },

    async claim(input: GrantClaim) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET deploy_grant_state = CASE WHEN deploy_grant_state IN ('pending', 'granted') THEN deploy_grant_state ELSE 'pending' END,
                deploy_grant_secret_names = CASE WHEN deploy_grant_state IN ('pending', 'granted')
                                                 THEN COALESCE(deploy_grant_secret_names, '{}') ELSE '{}' END,
                deploy_grant_pending_names = CASE WHEN deploy_grant_state IN ('pending', 'granted')
                                                  THEN COALESCE(deploy_grant_pending_names, '{}') ELSE '{}' END,
                deploy_grant_snapshot_id = $2, deploy_grant_repository_id = $3, deploy_grant_head_sha = $4,
                deploy_grant_requested_by = $5, deploy_grant_site_secret_name = $6,
                deploy_grant_updated_at = now(), updated_at = now()
          WHERE id = $1 AND scaffold_state = 'committed'`,
        [siteId, input.snapshotId, input.repositoryId, input.headSha, input.requestedBy, input.siteSecretName],
        "claim",
      );
    },

    async recordSecretNames(names: string[]) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET deploy_grant_secret_names = $2, deploy_grant_updated_at = now(), updated_at = now()
          WHERE id = $1 AND deploy_grant_state IS NOT NULL`,
        [siteId, names],
        "record names",
      );
    },

    async recordPending(pending: string[], error: string | null) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET deploy_grant_pending_names = $2, deploy_grant_error = $3, deploy_grant_updated_at = now(), updated_at = now()
          WHERE id = $1 AND deploy_grant_state IS NOT NULL`,
        [siteId, pending, error === null ? null : error.slice(0, 300)],
        "record pending",
      );
    },

    async markGranted(names: string[]) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET deploy_grant_state = 'granted', deploy_grant_secret_names = $2, deploy_grant_error = NULL,
                deploy_grant_pending_names = '{}',
                deploy_grant_granted_at = now(), deploy_grant_updated_at = now(), updated_at = now()
          WHERE id = $1 AND deploy_grant_state IN ('pending', 'granted')`,
        [siteId, names],
        "granted",
      );
      const r = await c.query<{ deploy_grant_snapshot_id: string; deploy_grant_repository_id: string }>(
        `SELECT deploy_grant_snapshot_id, deploy_grant_repository_id FROM webdev_provisioned_sites WHERE id = $1`,
        [siteId],
      );
      await emitEvent(c, tenantId, "webdev_provisioned_site", siteId, "webdev.site.deploy_granted", {
        secretNames: names,
        snapshotId: r.rows[0]?.deploy_grant_snapshot_id ?? null,
        repositoryId: repoIdOf(r.rows[0]?.deploy_grant_repository_id ?? null),
      });
    },

    async markRevoked(input) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET deploy_grant_state = 'revoked', deploy_grant_secret_names = '{}', deploy_grant_pending_names = '{}',
                deploy_grant_repository_id = $2,
                deploy_grant_revoked_at = now(), deploy_grant_revoked_by = $3, deploy_grant_revoke_reason = $4,
                deploy_grant_error = NULL, deploy_grant_updated_at = now(), updated_at = now()
          WHERE id = $1 AND deploy_grant_state IN ('pending', 'granted', 'revoked')`,
        [siteId, input.repositoryId, input.revokedBy, input.reason],
        "revoked",
      );
      await emitEvent(c, tenantId, "webdev_provisioned_site", siteId, "webdev.site.deploy_revoked", {
        secretNames: input.revokedNames,
        repositoryId: input.repositoryId,
        reason: input.reason,
      });
    },

    async recordError(token: string) {
      await c.query(
        `UPDATE webdev_provisioned_sites SET deploy_grant_error = $2, deploy_grant_updated_at = now() WHERE id = $1`,
        [siteId, token.slice(0, 300)],
      );
    },
  };
}

function withLockedSite(tenantId: string, siteId: string) {
  return <T>(fn: (tx: DeployGrantTx) => Promise<T>): Promise<T> =>
    withTenants<T>(
      [tenantId],
      async (c) => {
        // Pre-lock read supplies the lock key only (pipeline_run_id and slug are immutable on this row). Everything is
        // RE-READ inside `fn`.
        const pre = await c.query<{ pipeline_run_id: string | null; slug: string }>(
          `SELECT pipeline_run_id, slug FROM webdev_provisioned_sites WHERE id = $1`,
          [siteId],
        );
        if (pre.rows[0]) await takeProvisionLock(c, pre.rows[0].pipeline_run_id, pre.rows[0].slug);
        return fn(txFor(c, tenantId, siteId));
      },
      { modules: ["webdev"] },
    );
}

async function readSnapshot(tenantId: string, snapshotId: string): Promise<SnapshotFacts | null> {
  const r = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string; contract_version: string; vocabulary_version: string; content_hash: string }>(
        `SELECT id, contract_version, vocabulary_version, content_hash FROM webdev_contract_snapshots WHERE id = $1`,
        [snapshotId],
      ),
    { modules: ["webdev"] },
  );
  const s = r.rows[0];
  return s ? { id: s.id, contractVersion: s.contract_version, vocabularyVersion: s.vocabulary_version, contentHash: s.content_hash } : null;
}

// ── errors ───────────────────────────────────────────────────────────────────────────────────────

/** A far-side error as ONE typed refusal. A 403 "not accessible by integration" is the App missing a permission: on an
 *  org-secret call that is `organization_secrets` (O-3), named so the owner knows exactly what to grant. */
export function classifyDeployGrantError(err: unknown): DeployGrantRefusal | null {
  if (err instanceof DeployGrantRefusal) return err;
  if (err instanceof GithubNotConfiguredError) return new DeployGrantRefusal("github_not_configured", err.message);
  if (err instanceof GithubTokenExchangeError) {
    const s = (err.detail as { httpStatus?: unknown } | undefined)?.httpStatus;
    return s === 403 || s === 404
      ? new DeployGrantRefusal("github_app_not_installed", `the GitHub App installation was refused (HTTP ${String(s)})`)
      : new DeployGrantRefusal("github_not_configured", `GitHub refused the App credential (HTTP ${String(s ?? "?")})`);
  }
  if (err instanceof GithubRateLimitedError) return new DeployGrantRefusal("github_rate_limited", err.message);
  if (err instanceof GithubApiError) {
    const s = githubStatusOf(err);
    const operation = String((err.detail as { operation?: unknown } | undefined)?.operation ?? "");
    const orgSecrets = operation.includes("/actions/secrets/");
    if (s === 403) {
      return orgSecrets
        ? new DeployGrantRefusal(
          "github_permission_missing",
          "organization_secrets: the ERP GitHub App lacks Organization permissions > Secrets: read and write. The org owner "
            + "must grant it on the App and accept the updated permissions on the installation (O-3).",
          "organization_secrets",
        )
        : new DeployGrantRefusal("github_permission_missing", `contents: the ERP GitHub App cannot read this repository (${err.message})`, "contents");
    }
    if (s === 404) return new DeployGrantRefusal("github_app_not_installed", `the ERP App cannot see the repo: install it on that repository (${err.message})`);
    return new DeployGrantRefusal("github_request_failed", err.message);
  }
  return null;
}

// ── authorization + composition ──────────────────────────────────────────────────────────────────

/** The two existing gates (see the header), in the GHT-1 order. Returns the org tenant the ERP App and ledger live under. */
export async function authorizeDeployGrant(principal: Principal, tenantId: string, siteId: string): Promise<string> {
  await authorize(principal, { kind: "webdev_provisioned_site", tenantId, id: siteId, module: "webdev" }, "provision");
  const org = await resolveGithubOrgTenant(tenantId);
  if (!org.ok) {
    throw new DeployGrantRefusal(
      "github_org_unavailable",
      org.reason === "unconfigured" ? "the GitHub org tenant is not configured (GITHUB_REPO_SYNC_TENANT_ID)" : "this company has no GitHub org registered for its root",
    );
  }
  await authorize(principal, { kind: "github_repo", tenantId: org.tenantId, module: "webdev" }, "push");
  return org.tenantId;
}

function actorIdOf(principal: Principal): string {
  if (!principal.userId) throw new ForbiddenException("an authenticated principal is required to change a deploy grant");
  return principal.userId;
}

/** The provider_ref (the GH-12 approval) of a row, read for the ledger's `approvalId`. */
async function approvalIdOf(tenantId: string, siteId: string): Promise<string | undefined> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<{ provider_ref: string | null }>(`SELECT provider_ref FROM webdev_provisioned_sites WHERE id = $1`, [siteId]),
    { modules: ["webdev"] },
  );
  return r.rows[0]?.provider_ref ?? undefined;
}

/** The real ports, for one site. Exported for the DB suite, which drives the state machine below the authz checks (the
 *  HTTP suite covers those), exactly as scaffold-commit.db.test.ts drives P4b2's. */
export function deployGrantPorts(a: {
  tenantId: string;
  siteId: string;
  orgTenantId: string;
  actorId: string;
  secretNames: string[];
  approvalId?: string;
}): DeployGrantDeps {
  return {
    withLockedSite: withLockedSite(a.tenantId, a.siteId),
    readSnapshot: (id) => readSnapshot(a.tenantId, id),
    resolveRepo: (row) => resolveProvisionedRepo(a.tenantId, row),
    git: erpGitCaller(a.orgTenantId, a.actorId),
    secretNames: a.secretNames,
    ledger: async (op, target, perform) =>
      (
        await withGithubLedger(
          {
            tenantId: a.orgTenantId,
            actorId: a.actorId,
            repo: `${target.repo.owner}/${target.repo.name}`,
            action: "secret_write",
            secretName: target.secretName,
            basis: op === "grant" ? DEPLOY_GATE_GRANT_BASIS : DEPLOY_GATE_REVOKE_BASIS,
            ...(op === "grant" && a.approvalId ? { approvalId: a.approvalId } : {}),
          },
          async () => ({ data: await perform() }),
        )
      ).data,
    actor: { userId: a.actorId },
    classifyError: classifyDeployGrantError,
  };
}

/** Authorize, then grant (re-checking every condition). The explicit POST route and the scaffold follow-on both come here. */
export async function grantDeployForSite(
  principal: Principal,
  tenantId: string,
  siteId: string,
  trigger: "scaffold" | "operator",
): Promise<DeployGrantResult> {
  const orgTenantId = await authorizeDeployGrant(principal, tenantId, siteId);
  const actorId = actorIdOf(principal);
  const secretNames = parseDeploySecretNames(config.webdeskDeploySecretNames);
  const ports = deployGrantPorts({ tenantId, siteId, orgTenantId, actorId, secretNames, approvalId: await approvalIdOf(tenantId, siteId) });
  return grantDeploySecrets(ports, { siteId, trigger });
}

/**
 * Authorize, then revoke. THE function any future archive / registry-removal path must call (see the header). An invalid
 * name configuration does not block a revoke: the recorded names are still removed.
 */
export async function revokeDeployForSite(
  principal: Principal,
  tenantId: string,
  siteId: string,
  reasonInput: unknown,
): Promise<DeployRevokeResult> {
  const orgTenantId = await authorizeDeployGrant(principal, tenantId, siteId);
  // Validated only AFTER both checks: a caller who may not revoke learns nothing from a malformed body.
  const reason = parseRevokeReason(typeof reasonInput === "string" ? { reason: reasonInput } : reasonInput);
  const actorId = actorIdOf(principal);
  let secretNames: string[] = [];
  try {
    secretNames = parseDeploySecretNames(config.webdeskDeploySecretNames);
  } catch (err) {
    if (!(err instanceof DeployGrantRefusal)) throw err;
    logger.warn(`revoke of ${siteId}: ${err.message}; removing the recorded names only`);
  }
  const ports = deployGrantPorts({ tenantId, siteId, orgTenantId, actorId, secretNames });
  return revokeDeploySecrets(ports, { siteId, reason });
}

/** What the scaffold commit's answer carries about the grant that followed it. Never a secret value. */
export interface DeployGrantSummary {
  outcome: DeployGrantResult["outcome"] | "refused";
  state: DeployGrantState | null;
  siteSecretName: string | null;
  /** Why `siteSecretName` is null (SITE_SECRET_NOT_DERIVABLE), else null. */
  siteSecretNote: string | null;
  secrets: SecretOutcome[];
  /** Secret names the owner has not created yet. */
  pending: string[];
  error: string | null;
}

/**
 * M6-P4g's trigger: called by the scaffold commit AFTER its `committed` is recorded. Never throws, so the commit's answer
 * is never turned into an error by the grant; a refusal is recorded on the row and returned as data.
 */
export async function followScaffoldCommit(principal: Principal, tenantId: string, siteId: string): Promise<DeployGrantSummary> {
  try {
    const r = await grantDeployForSite(principal, tenantId, siteId, "scaffold");
    return { outcome: r.outcome, state: r.state, siteSecretName: r.siteSecretName, siteSecretNote: r.siteSecretNote, secrets: r.secrets, pending: r.pending, error: r.error };
  } catch (err) {
    const now = await readDeployGrant(tenantId, siteId).catch(() => null);
    const base = { state: now?.state ?? null, siteSecretName: now?.siteSecretName ?? null, siteSecretNote: now ? now.siteSecretNote : SITE_SECRET_NOT_DERIVABLE, secrets: [], pending: now?.pendingNames ?? [] };
    if (err instanceof DeployGrantRefusal) return { outcome: "refused", ...base, error: err.rowToken };
    if (err instanceof ForbiddenException) return { outcome: "refused", ...base, error: "forbidden" };
    logger.error(`deploy grant after the scaffold commit of ${siteId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: "refused", ...base, error: "deploy_grant_failed" };
  }
}
