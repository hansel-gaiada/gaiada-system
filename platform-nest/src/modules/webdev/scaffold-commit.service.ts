// M6-P4b2 — the Postgres, ERP-App and ledger adapters for `scaffold-commit.ts` (read that file's header first: the
// integrity checks, the state machine, first-fill-only). This file binds the ports and authorizes:
//
//   withLockedSite  ONE `withTenants([tenantId], …, {modules:['webdev']})` transaction that takes the provisioning
//                   advisory lock (`takeProvisionLock`, the repo step's and P4c's own) before anything is read, so a
//                   scaffold commit, a reconcile and a completion serialize on one site. The third wall applies: an
//                   undeclared module scope would match ZERO rows, silently.
//   readSnapshot    the pinned `webdev_contract_snapshots` row (versions + content hash), same tenant + wall.
//   resolveRepo     the repo GH-12 created for THIS row: `provider_ref` -> an APPROVED `github:create_repo` approval
//                   -> `config.githubOrg` / its `tool_args.name`, and `repo_url` must name exactly that repo.
//   git             `erpGitCaller(orgTenant, actor)`: the ERP App through `githubRequest()`, the §4.1 chokepoint.
//   ledger          `withGithubLedger` (`action: "push"`, attribution = the acting principal), under the ORG tenant.
//
// ── AUTHORIZATION (no Cerbos change) ─────────────────────────────────────────────────────────────
//   1. the route: `webdev_provisioned_site · provision` on the request tenant (the controller; the first fill is the
//      last leg of §08's provisioning, same tier as `reconcile`);
//   2. here: `github_repo · push` on the GitHub ORG tenant resolved by `resolveGithubOrgTenant` (GHT-1; the order
//      workflow-dispatch.ts follows: resolve, then authorize against the resolved tenant, never the URL tenant).
//      `push` is ordinary write traffic in resource_github_repo.yaml (role-tier gated, not D14-gated).
// The ERP App credential and the ledger rows live under that org tenant too.
import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { authorize } from "../../core/http";
import { resolveGithubOrgTenant } from "../../core/github-org-tenant";
import { erpGitCaller, githubStatusOf, type RepoRef } from "../../core/github/git-data";
import { withGithubLedger } from "../../core/github/ledger";
import { GithubApiError, GithubNotConfiguredError, GithubRateLimitedError, GithubTokenExchangeError } from "../../core/github/errors";
import { emitEvent } from "../../events/outbox.service";
import type { Principal } from "../../rbac/principal";
import { takeProvisionLock } from "./provisioning.service";
import { resolveProvisionedRepo } from "./provisioned-repo";
import { followScaffoldCommit, type DeployGrantSummary } from "./deploy-grant.service";
import {
  ScaffoldRefusal, commitScaffoldTree, repoUrlNames,
  type ClaimInput, type ScaffoldActor, type ScaffoldCommitDeps, type ScaffoldCommitResult, type ScaffoldRow,
  type ScaffoldState, type ScaffoldTx, type SnapshotFacts,
} from "./scaffold-commit";

export { repoUrlNames, resolveProvisionedRepo };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── the row ──────────────────────────────────────────────────────────────────────────────────────

interface ScaffoldDbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_ref: string | null;
  status: string;
  repo_url: string | null;
  pipeline_run_id: string | null;
  completion_state: string | null;
  contract_snapshot_id: string | null;
  scaffold_state: ScaffoldState | null;
  scaffold_manifest_sha256: string | null;
  scaffold_snapshot_id: string | null;
  scaffold_branch: string | null;
  scaffold_base_sha: string | null;
  scaffold_tree_sha: string | null;
  scaffold_commit_sha: string | null;
  scaffold_file_count: number | null;
  scaffold_total_bytes: number | null;
  scaffold_error: string | null;
  scaffold_updated_at: Date | string | null;
  scaffold_committed_at: Date | string | null;
}

const SCAFFOLD_COLUMNS = `id, tenant_id, provider, provider_ref, status, repo_url, pipeline_run_id, completion_state,
  contract_snapshot_id, scaffold_state, scaffold_manifest_sha256, scaffold_snapshot_id, scaffold_branch, scaffold_base_sha,
  scaffold_tree_sha, scaffold_commit_sha, scaffold_file_count, scaffold_total_bytes, scaffold_error, scaffold_updated_at,
  scaffold_committed_at`;

const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

function toRow(r: ScaffoldDbRow): ScaffoldRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    providerRef: r.provider_ref,
    status: r.status,
    repoUrl: r.repo_url,
    pipelineRunId: r.pipeline_run_id,
    completionState: r.completion_state,
    contractSnapshotId: r.contract_snapshot_id,
    scaffoldState: r.scaffold_state,
    scaffoldManifestSha256: r.scaffold_manifest_sha256,
    scaffoldSnapshotId: r.scaffold_snapshot_id,
    scaffoldBranch: r.scaffold_branch,
    scaffoldBaseSha: r.scaffold_base_sha,
    scaffoldTreeSha: r.scaffold_tree_sha,
    scaffoldCommitSha: r.scaffold_commit_sha,
    scaffoldFileCount: r.scaffold_file_count,
    scaffoldTotalBytes: r.scaffold_total_bytes,
    scaffoldError: r.scaffold_error,
    scaffoldCommittedAt: iso(r.scaffold_committed_at),
  };
}

/** What `GET provisioned-sites/:id` returns beside the site (`scaffold`). An explicit field list. */
export interface ScaffoldCommitDto {
  state: ScaffoldState | null;
  branch: string | null;
  baseSha: string | null;
  treeSha: string | null;
  commitSha: string | null;
  snapshotId: string | null;
  manifestSha256: string | null;
  fileCount: number | null;
  totalBytes: number | null;
  error: string | null;
  updatedAt: string | null;
  committedAt: string | null;
}

function toDto(r: ScaffoldDbRow): ScaffoldCommitDto {
  return {
    state: r.scaffold_state,
    branch: r.scaffold_branch,
    baseSha: r.scaffold_base_sha,
    treeSha: r.scaffold_tree_sha,
    commitSha: r.scaffold_commit_sha,
    snapshotId: r.scaffold_snapshot_id,
    manifestSha256: r.scaffold_manifest_sha256,
    fileCount: r.scaffold_file_count,
    totalBytes: r.scaffold_total_bytes,
    error: r.scaffold_error,
    updatedAt: iso(r.scaffold_updated_at),
    committedAt: iso(r.scaffold_committed_at),
  };
}

export async function readScaffoldCommit(tenantId: string, siteId: string): Promise<ScaffoldCommitDto | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<ScaffoldDbRow>(`SELECT ${SCAFFOLD_COLUMNS} FROM webdev_provisioned_sites WHERE id = $1`, [siteId]),
    { modules: ["webdev"] },
  );
  return r.rows[0] ? toDto(r.rows[0]) : null;
}

// ── the transaction port ─────────────────────────────────────────────────────────────────────────

function txFor(c: PoolClient, tenantId: string, siteId: string): ScaffoldTx {
  const guarded = async (sql: string, params: unknown[], what: string): Promise<void> => {
    const r = await c.query(sql, params);
    // Under the lock, after a re-read that chose this step, the guarded UPDATE must match exactly one row.
    if (r.rowCount !== 1) throw new Error(`scaffold commit: ${what} matched ${r.rowCount} rows`);
  };
  return {
    async read() {
      const r = await c.query<ScaffoldDbRow>(`SELECT ${SCAFFOLD_COLUMNS} FROM webdev_provisioned_sites WHERE id = $1`, [siteId]);
      return r.rows[0] ? toRow(r.rows[0]) : null;
    },

    async claim(input: ClaimInput) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET scaffold_state = 'pending', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = $4,
                scaffold_base_sha = $5, scaffold_tree_sha = NULL, scaffold_commit_sha = NULL, scaffold_file_count = $6,
                scaffold_total_bytes = $7, scaffold_goal_id = $8, scaffold_requested_by = $9, scaffold_error = NULL,
                scaffold_updated_at = now(), updated_at = now()
          WHERE id = $1 AND completion_state = 'complete'
            AND (scaffold_state IS NULL OR scaffold_state IN ('pending', 'commit_created'))`,
        [siteId, input.manifestSha256, input.snapshotId, input.branch, input.baseSha, input.fileCount, input.totalBytes,
          input.goalId, input.requestedBy],
        "claim",
      );
    },

    async markCommitCreated(manifestSha256: string, treeSha: string, commitSha: string) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET scaffold_state = 'commit_created', scaffold_tree_sha = $3, scaffold_commit_sha = $4, scaffold_error = NULL,
                scaffold_updated_at = now(), updated_at = now()
          WHERE id = $1 AND scaffold_state = 'pending' AND scaffold_manifest_sha256 = $2`,
        [siteId, manifestSha256, treeSha, commitSha],
        "commit_created",
      );
    },

    async markCommitted(manifestSha256: string, commitSha: string) {
      await guarded(
        `UPDATE webdev_provisioned_sites
            SET scaffold_state = 'committed', scaffold_error = NULL, scaffold_committed_at = now(),
                scaffold_updated_at = now(), updated_at = now()
          WHERE id = $1 AND scaffold_state = 'commit_created' AND scaffold_manifest_sha256 = $2 AND scaffold_commit_sha = $3`,
        [siteId, manifestSha256, commitSha],
        "committed",
      );
      await emitEvent(c, tenantId, "webdev_provisioned_site", siteId, "webdev.site.scaffold_committed", { commitSha, manifestSha256 });
    },

    async recordError(token: string) {
      await c.query(
        `UPDATE webdev_provisioned_sites SET scaffold_error = $2, scaffold_updated_at = now() WHERE id = $1`,
        [siteId, token.slice(0, 300)],
      );
    },
  };
}

function withLockedSite(tenantId: string, siteId: string) {
  return <T>(fn: (tx: ScaffoldTx) => Promise<T>): Promise<T> =>
    withTenants<T>(
      [tenantId],
      async (c) => {
        // Pre-lock read supplies the lock key only (pipeline_run_id and slug are immutable on this row, the argument
        // reconcileProvisionedSite and P4c make). Everything is RE-READ inside `fn`.
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

// ── the other ports ──────────────────────────────────────────────────────────────────────────────

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

/** A far-side error as ONE typed refusal (workflow-dispatch.ts's classification, for the Git Data API). */
export function classifyGithubError(err: unknown): ScaffoldRefusal | null {
  if (err instanceof ScaffoldRefusal) return err;
  if (err instanceof GithubNotConfiguredError) return new ScaffoldRefusal("github_not_configured", err.message);
  if (err instanceof GithubTokenExchangeError) {
    const s = (err.detail as { httpStatus?: unknown } | undefined)?.httpStatus;
    return s === 403 || s === 404
      ? new ScaffoldRefusal("github_app_not_installed", `the GitHub App installation was refused (HTTP ${String(s)})`)
      : new ScaffoldRefusal("github_not_configured", `GitHub refused the App credential (HTTP ${String(s ?? "?")})`);
  }
  if (err instanceof GithubRateLimitedError) return new ScaffoldRefusal("github_rate_limited", err.message);
  if (err instanceof GithubApiError) {
    const s = githubStatusOf(err);
    if (s === 404) return new ScaffoldRefusal("github_app_not_installed", `the ERP App cannot see the repo: install it on that repository (${err.message})`);
    if (s === 403) return new ScaffoldRefusal("github_app_permission_missing", `the ERP App lacks a permission for this write (contents: write) (${err.message})`);
    return new ScaffoldRefusal("github_write_failed", err.message);
  }
  return null;
}

async function actorOf(principal: Principal): Promise<ScaffoldActor> {
  const userId = principal.userId;
  if (!userId) throw new ForbiddenException("an authenticated principal is required to commit a scaffold");
  const r = await withGlobal((c) => c.query<{ name: string | null; email: string | null }>(`SELECT name, email FROM users WHERE id = $1`, [userId]));
  const name = r.rows[0]?.name?.trim() || "Gaiada ERP";
  const email = r.rows[0]?.email?.trim() || `noreply+${userId}@users.invalid`;
  return { userId, name, email };
}

// ── the request body ─────────────────────────────────────────────────────────────────────────────

export interface ScaffoldCommitBody {
  runId: string;
  goalId: string | null;
  contractSnapshotId: string | null;
  files: unknown;
}

/** The body's own shape (the files are checked by `verifyScaffoldTree`). Throws a 422 refusal naming the field. */
export function parseScaffoldCommitBody(body: unknown): ScaffoldCommitBody {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const uuidOrNull = (k: string): string | null => {
    const v = b[k];
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || !UUID_RE.test(v)) throw new ScaffoldRefusal("scaffold_manifest_invalid", `${k} must be a uuid`);
    return v.toLowerCase();
  };
  const runId = uuidOrNull("runId");
  if (!runId) throw new ScaffoldRefusal("scaffold_manifest_invalid", "runId is required (the pipeline run the tree was composed for)");
  return { runId, goalId: uuidOrNull("goalId"), contractSnapshotId: uuidOrNull("contractSnapshotId"), files: b.files };
}

// ── composition ──────────────────────────────────────────────────────────────────────────────────

/** The commit's answer, plus the M6-P4g deploy grant that followed it (additive). */
export type ScaffoldCommitResponse = ScaffoldCommitResult & { deployGrant: DeployGrantSummary };

/**
 * The route's whole job after its own `provision` check: resolve the org tenant, authorize `github_repo · push`
 * there, bind the ports, and run the state machine. Throws `ScaffoldRefusal` (typed, with its HTTP status) or
 * `ForbiddenException` (Cerbos).
 *
 * M6-P4g: once the first fill is `committed` (recorded in its own transaction by the state machine), the deploy grant
 * follows in the same call, with the same principal and no new approval. It runs AFTER the commit is recorded and never
 * throws (`followScaffoldCommit`), so the commit's answer is never turned into an error by it; its outcome rides along as
 * `deployGrant`. An identical re-submit (`already_committed`) re-runs it, which is how a grant that could not finish
 * resumes (for example once the App holds `organization_secrets`, O-3); a granted site answers from the row.
 */
export async function commitScaffoldForSite(
  principal: Principal,
  tenantId: string,
  siteId: string,
  body: unknown,
): Promise<ScaffoldCommitResponse> {
  const parsed = parseScaffoldCommitBody(body);
  const org = await resolveGithubOrgTenant(tenantId);
  if (!org.ok) {
    throw new ScaffoldRefusal(
      "github_org_unavailable",
      org.reason === "unconfigured" ? "the GitHub org tenant is not configured (GITHUB_REPO_SYNC_TENANT_ID)" : "this company has no GitHub org registered for its root",
    );
  }
  await authorize(principal, { kind: "github_repo", tenantId: org.tenantId, module: "webdev" }, "push");
  const actor = await actorOf(principal);
  const deps = scaffoldCommitPorts({ tenantId, siteId, orgTenantId: org.tenantId, actor });
  const committed = await commitScaffoldTree(deps, {
    siteId, runId: parsed.runId, goalId: parsed.goalId, contractSnapshotId: parsed.contractSnapshotId, files: parsed.files,
  });
  return { ...committed, deployGrant: await followScaffoldCommit(principal, tenantId, siteId) };
}

/** The real ports, for one site. Exported for the DB suite, which drives the state machine below the authz checks
 *  (the HTTP suite covers those), exactly as provision-completion.db.test.ts drives P4c's. */
export function scaffoldCommitPorts(a: { tenantId: string; siteId: string; orgTenantId: string; actor: ScaffoldActor }): ScaffoldCommitDeps {
  return {
    withLockedSite: withLockedSite(a.tenantId, a.siteId),
    readSnapshot: (id) => readSnapshot(a.tenantId, id),
    resolveRepo: (row) => resolveProvisionedRepo(a.tenantId, row),
    git: erpGitCaller(a.orgTenantId, a.actor.userId),
    ledger: (_step, target, perform) =>
      withGithubLedger(
        {
          tenantId: a.orgTenantId,
          actorId: a.actor.userId,
          repo: `${target.repo.owner}/${target.repo.name}`,
          ref: `refs/heads/${target.branch}`,
          action: "push",
          attribution: { name: a.actor.name, email: a.actor.email },
        },
        perform,
      ),
    actor: a.actor,
    now: () => new Date(),
    classifyError: classifyGithubError,
  };
}
