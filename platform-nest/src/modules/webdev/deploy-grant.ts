// M6-P4g — the deploy gate is the org secret grant. Design: docs/plans/2026-10-13-webdesk-m6-p4g-deploy-grant.md (read it
// first: the conditions, the state, the trigger, the authorization decision, the live dependency on O-3).
//
// This file is the CONDITIONS and the STATE MACHINE, written against ports so it runs without a database
// (deploy-grant.unit.test.ts, against the in-memory GitHub of core/github/git-data.testkit.ts).
// `deploy-grant.service.ts` binds the ports to Postgres, the ERP App and the ledger, and authorizes.
//
// ═══ WHAT A GRANT IS ═════════════════════════════════════════════════════════════════════════════════
// The repo is added to each configured org Actions secret's "selected repositories" list
// (`PUT /orgs/{org}/actions/secrets/{name}/repositories/{repo_id}`), so its own workflows may READ the secret. The ERP never
// holds, reads or writes a secret VALUE (WSK-D29); core/github/org-secrets.ts has no function that could.
//
// ═══ THE CONDITIONS (re-derived at every grant; nothing is trusted from the caller) ═══════════════════
//   the site is an ERP repo control row · §08 completion is `complete` (the pin exists) · its `webdev_sites` row exists,
//   is live and `provisioned` · P4b2's scaffold is `committed` · the repo is the one GH-12 created for it · the registry
//   row names that repo · the default branch's head carries a root CONTRACT.lock that parses (P4b2's parser) and names the
//   PINNED snapshot (P4b2's check). The site facts are read again under the lock immediately before any GitHub write.
//
// ═══ THE STATE MACHINE (webdev_provisioned_sites.deploy_grant_state; migration 202610130100) ═════════════
//
//   NULL ──[claim]──> pending ──[every secret granted]──> granted
//   pending | granted ──[revoke]──> revoked          revoked ──[operator only]──> pending ──> granted
//
//   claim    under the site lock, in its OWN transaction, committed before any write to GitHub: the snapshot the lock
//            names, the repository id, the head the lock was read at, the requester. Once a PUT may have landed, the row
//            already says `pending`, so a crash can never leave a grant the ERP does not know about.
//   grant    a second transaction under the same lock (a grant and a revoke never interleave): one PUT per secret, each
//            ledgered. The names that landed are recorded even when a later one fails, so a re-run completes a partial
//            grant (GitHub's PUT is idempotent). `deploy_grant_secret_names` only grows until a revoke.
//   revoke   under the lock: one DELETE per secret in the fixed list ∪ recorded ∪ every derivable per-site name (staging AND
//            production, M6-P6h2). A 404 means nothing to revoke.
//
// ═══ TWO KINDS OF SECRET (the M6-P6a amendment) ═════════════════════════════════════════════════════
//   1. the fixed list, `WEBDESK_DEPLOY_SECRET_NAMES` (default `WEBDESK_DEPLOY_GRANT`, the marker the templates check);
//   2. ONE per-site secret PER ENVIRONMENT the site has in the registry, `siteDeploySecretName()`: P6's deploy principal for
//      this site and environment, locked to one document root, whose CI copy an org owner creates BY HAND with visibility
//      limited to this site's repo. The name is derived from the repo's name, the environment and the repo's GitHub id
//      (M6-P6f: the repo's own workflow derives the same name), so no other site's grant can ever name it. Always the
//      staging row's name (recorded on the row as `deploy_grant_site_secret_name`); plus the PRODUCTION name when the site
//      has a live production row (M6-P6h2: the row M6-P6g's `POST sites/:id/production` made, `promoted_from_site_id` = the
//      staging row). The production name needs no column of its own: it is derived the same way, and once it has landed it
//      is in `deploy_grant_secret_names` (or in `deploy_grant_pending_names` until the owner creates the secret).
//
// A secret that does not exist YET (404) is not an error: the grant stays `pending`, the name is listed as pending on
// the row and in the answer, and the next grant run (the route, or the next trigger) completes it once the owner has
// created it. A secret not set to "selected repositories" IS an error (a secret visible to every repo voids the gate),
// recorded and never written through. A missing App permission (O-3) stops the whole grant as
// `github_permission_missing: organization_secrets`.
//
// The automatic triggers (after the scaffold commit, and after the production row is created) never re-grant a `revoked`
// site: only an operator's POST undoes an operator's revoke.
//
// A `granted` site that gains a name which is not granted yet (a new production row whose secret the owner has not created,
// a name added to the configuration) STAYS `granted`: the state only ever moves on a claim, a full grant or a revoke, so the
// staging deploys the site already has are not stopped by a secret that is still being created. The name is listed in
// `deploy_grant_pending_names` (migration 202610132340 lifts wps_deploy_grant_links' old rule that `granted` has none), and
// the recorded names are the precise fact: a build target asks about ONE name (`perSiteSecretGranted`), never the state alone.
import { getBranchHead, type GitCaller, type RepoRef } from "../../core/github/git-data";
import {
  addRepoToOrgSecret, getFileAtRef, getOrgSecret, getRepoInfo, isValidSecretName, removeRepoFromOrgSecret,
  type OrgSecretVisibility, type SecretAccessResult,
} from "../../core/github/org-secrets";
import {
  CONTRACT_LOCK_PATH, ScaffoldRefusal, checkLockAgainstPin, parseContractLock, repoUrlNames, type ContractLock, type SnapshotFacts,
} from "./scaffold-commit";

export const DEFAULT_DEPLOY_SECRET_NAMES: readonly string[] = ["WEBDESK_DEPLOY_GRANT"];
export const REVOKE_REASON_MIN = 8;
export const REVOKE_REASON_MAX = 500;

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────

/** Every typed reason a grant or a revoke can be refused, with the HTTP status the route answers. */
export const DEPLOY_GRANT_REFUSALS = {
  deploy_grant_not_configured: 503,
  deploy_grant_reason_required: 422,
  // the site, the registry, the repo (409)
  deploy_grant_repo_unresolved: 409,
  deploy_grant_site_not_complete: 409,
  deploy_grant_no_registry_row: 409,
  deploy_grant_registry_mismatch: 409,
  deploy_grant_not_committed: 409,
  deploy_grant_no_lock: 409,
  deploy_grant_lock_invalid: 409,
  deploy_grant_lock_mismatch: 409,
  deploy_grant_superseded: 409,
  // the far side
  github_permission_missing: 503,
  github_app_not_installed: 503,
  github_not_configured: 503,
  github_org_unavailable: 503,
  github_rate_limited: 429,
  github_request_failed: 502,
  not_found: 404,
} as const;
export type DeployGrantRefusalCode = keyof typeof DEPLOY_GRANT_REFUSALS;

export class DeployGrantRefusal extends Error {
  readonly status: number;
  constructor(
    readonly code: DeployGrantRefusalCode,
    readonly detail: string,
    /** A short qualifier recorded with the token on the row, e.g. `organization_secrets` or a secret name. */
    readonly qualifier?: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "DeployGrantRefusal";
    this.status = DEPLOY_GRANT_REFUSALS[code];
  }

  /** What `deploy_grant_error` records: the token, and its qualifier when there is one. Never a response body. */
  get rowToken(): string {
    return this.qualifier ? `${this.code}: ${this.qualifier}` : this.code;
  }
}

const refuse = (code: DeployGrantRefusalCode, detail: string, qualifier?: string): never => {
  throw new DeployGrantRefusal(code, detail, qualifier);
};

// ── configuration ───────────────────────────────────────────────────────────────────────────────────

/**
 * `WEBDESK_DEPLOY_SECRET_NAMES`: comma-separated org Actions secret NAMES. Empty means the default. Every name must be a
 * valid GitHub secret name and may appear once; anything else refuses (an operator typo must not silently grant less).
 */
export function parseDeploySecretNames(raw: string | undefined | null): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [...DEFAULT_DEPLOY_SECRET_NAMES];
  const names = text.split(",").map((s) => s.trim());
  const seen = new Set<string>();
  for (const n of names) {
    if (!isValidSecretName(n)) {
      refuse("deploy_grant_not_configured", `WEBDESK_DEPLOY_SECRET_NAMES holds ${JSON.stringify(n)}, which is not a GitHub secret name`);
    }
    if (seen.has(n.toUpperCase())) refuse("deploy_grant_not_configured", `WEBDESK_DEPLOY_SECRET_NAMES names ${n} twice`);
    seen.add(n.toUpperCase());
  }
  return names;
}

/**
 * THE per-site deploy secret's name (P6: one deploy principal per site and environment, locked to one document root).
 *
 *   WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>      e.g. WEBDESK_DEPLOY_ACME_SITE_STAGING_123456789
 *
 * `<SLUG>` and `<ENV>` are uppercased with every character outside A-Z0-9 replaced by `_` (readable for the owner who
 * creates the secret by hand). `<REPOID>` is the GitHub repository's numeric id: the identity. M6-P6f changed this from
 * `<H8>` (8 hex of sha256(the provisioned site's id)), because a site repo's own workflow has to derive the name of its
 * own secret and it never sees a provisioned site's id; every workflow knows `github.repository_id`, and a repository id
 * is unique across GitHub, so two sites can never share a name (the readable part alone can collide: slugs are unique
 * only per company while org secret names are org-wide, and `-`/`_`/`.` all map to `_`).
 *
 * Callers pass the RESOLVED repo's name and id (what the workflow sees as `github.event.repository.name` and
 * `github.repository_id`). The ERP only learns the id when a grant reads the repo, so before the first claim there is no
 * name: see `SITE_SECRET_NOT_DERIVABLE`.
 *
 * The shell twin is webdesk/templates/_deploy/secret-name.sh; both are tested against ONE fixture,
 * webdesk/templates/_deploy/secret-name.fixture.json, so they cannot drift. Refuses (throws) what the twin refuses.
 */
export function siteDeploySecretName(site: { slug: string; environment: string; repositoryId: number }): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(site.slug)) throw new Error("a per-site deploy secret needs a slug of A-Z a-z 0-9 . _ -");
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(site.environment)) throw new Error("a per-site deploy secret needs an environment of A-Z a-z 0-9 . _ -");
  if (typeof site.repositoryId !== "number" || !Number.isSafeInteger(site.repositoryId) || site.repositoryId <= 0) {
    throw new Error("a per-site deploy secret needs the GitHub repository id (a positive integer)");
  }
  const part = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const name = `WEBDESK_DEPLOY_${part(site.slug)}_${part(site.environment)}_${site.repositoryId}`;
  if (!isValidSecretName(name)) throw new Error(`derived an invalid secret name: ${name}`);
  return name;
}

/** What the console shows in place of the per-site secret's name while the ERP does not know the repository id yet. */
export const SITE_SECRET_NOT_DERIVABLE =
  "not derivable yet: the name ends in the repository's GitHub id, which the ERP records at the first grant (it needs the repo to exist and be readable)";

/** The environments whose per-site secret a grant covers: the staging row's, plus production when it has a live row. */
export function grantEnvironments(registry: Pick<RegistryFacts, "environment" | "production">): string[] {
  return [...new Set([registry.environment, ...(registry.production ? [registry.production.environment] : [])])];
}

/** The per-site names of these environments, in order. Throws like `siteDeploySecretName`. */
export function perSiteSecretNames(site: { slug: string; repositoryId: number }, environments: readonly string[]): string[] {
  return [...new Set(environments.map((environment) => siteDeploySecretName({ ...site, environment })))];
}

/** Every per-site environment a REVOKE sweeps: the registry row's (staging) and `production`, whether or not a production row
 *  exists now (it may have been removed, or its secret created by hand before the row). A name that was never created answers
 *  404, which is nothing to revoke. */
export function revokableEnvironments(registry: Pick<RegistryFacts, "environment"> | null): string[] {
  return [...new Set([registry?.environment ?? "staging", "production"])];
}

/**
 * Where each environment's per-site secret stands, from what the row recorded. `repoName` is the resolved repo's name (the
 * `<SLUG>`), `repositoryId` the id the name ends in. [] when either is unknown (a name is never invented).
 */
export function siteSecretRefs(a: {
  repoName: string | null;
  repositoryId: number | null;
  stagingEnvironment: string | null;
  hasProduction: boolean;
  grantedNames: readonly string[];
  pendingNames: readonly string[];
}): SiteSecretRef[] {
  if (!a.repoName || a.repositoryId === null || !a.stagingEnvironment) return [];
  const environments = grantEnvironments({
    environment: a.stagingEnvironment,
    production: a.hasProduction ? { siteId: "", environment: "production" } : null,
  });
  const out: SiteSecretRef[] = [];
  for (const environment of environments) {
    let name: string;
    try {
      name = siteDeploySecretName({ slug: a.repoName, environment, repositoryId: a.repositoryId });
    } catch {
      continue;
    }
    const status = a.grantedNames.some((n) => n.toUpperCase() === name)
      ? "granted"
      : a.pendingNames.some((n) => n.toUpperCase() === name) ? "pending" : "not_granted";
    out.push({ environment, name, status });
  }
  return out;
}

// ── the row and the ports ───────────────────────────────────────────────────────────────────────────

export type DeployGrantState = "pending" | "granted" | "revoked";

export interface DeployGrantRow {
  id: string;
  tenantId: string;
  slug: string;
  provider: string;
  providerRef: string | null;
  status: string;
  repoUrl: string | null;
  completionState: string | null;
  contractSnapshotId: string | null;
  webdevSiteId: string | null;
  scaffoldState: string | null;
  grantState: DeployGrantState | null;
  /** The secrets the repo is known to hold access to ([] when none). */
  grantSecretNames: string[];
  grantSnapshotId: string | null;
  grantRepositoryId: number | null;
  grantHeadSha: string | null;
  grantError: string | null;
  /** The per-site secret's derived name, recorded at claim together with the repository id it ends in (`siteDeploySecretName`). */
  grantSiteSecretName: string | null;
  /** Names the owner has not created yet (404): the grant completes when they exist. [] when none. */
  grantPendingNames: string[];
}

/** The linked `webdev_sites` row, as the conditions need it. */
export interface RegistryFacts {
  id: string;
  deleted: boolean;
  origin: string;
  repoUrl: string | null;
  /** `webdev_sites.environment`: the `<ENV>` of the per-site secret. */
  environment: string;
  /** M6-P6h2: the live PRODUCTION row made from this row (`promoted_from_site_id` = this row, `deleted_at IS NULL`), or null.
   *  Its `environment` is the production secret's `<ENV>`. */
  production: { siteId: string; environment: string } | null;
}

export interface GrantClaim {
  snapshotId: string;
  repositoryId: number;
  headSha: string;
  requestedBy: string;
  siteSecretName: string;
}

/** One transaction holding the site's provisioning lock. */
export interface DeployGrantTx {
  read(): Promise<DeployGrantRow | null>;
  readRegistry(webdevSiteId: string): Promise<RegistryFacts | null>;
  /** NULL | revoked -> pending (names cleared on a fresh claim); pending | granted keep their state, facts refreshed. */
  claim(c: GrantClaim): Promise<void>;
  /** The secrets the repo is known to hold, without a state change (a partial grant or revoke). */
  recordSecretNames(names: string[]): Promise<void>;
  /** The names still waiting for the owner (404), and the error (null when the only shortfall is waiting). */
  recordPending(pending: string[], error: string | null): Promise<void>;
  /** pending | granted -> granted, with these names; clears the error and the pending names. */
  markGranted(names: string[]): Promise<void>;
  /** pending | granted | revoked -> revoked; names cleared. */
  markRevoked(r: { reason: string; revokedBy: string; repositoryId: number; revokedNames: string[] }): Promise<void>;
  recordError(token: string): Promise<void>;
}

export interface DeployGrantDeps {
  withLockedSite<T>(fn: (tx: DeployGrantTx) => Promise<T>): Promise<T>;
  readSnapshot(snapshotId: string): Promise<SnapshotFacts | null>;
  /** The repo GH-12 created for this row, or null when it cannot be proven. */
  resolveRepo(row: DeployGrantRow): Promise<RepoRef | null>;
  /** The ERP App (production: `erpGitCaller`). */
  git: GitCaller;
  /** The configured FIXED deploy secret names (`parseDeploySecretNames`). The per-site one is derived, never configured. */
  secretNames: string[];
  /** Wraps one org-secret write in the activities ledger (`github.secret_write`). */
  ledger<T>(op: "grant" | "revoke", target: { repo: RepoRef; secretName: string }, perform: () => Promise<T>): Promise<T>;
  actor: { userId: string };
  /** Maps a far-side error to a typed refusal (recorded on the row); null leaves it unrecorded and rethrown. */
  classifyError?(err: unknown): DeployGrantRefusal | null;
}

/** One environment's per-site deploy secret and where it stands: `granted` (the repo may read it), `pending` (the owner has not
 *  created it yet: the grant completes once they have), `not_granted` (anything else: not claimed yet, not selected, revoked). */
export interface SiteSecretRef {
  environment: string;
  name: string;
  status: "granted" | "pending" | "not_granted";
}

export interface SecretOutcome {
  name: string;
  result: SecretAccessResult;
}

export interface DeployGrantResult {
  /** granted: every secret is granted · already_granted: the scaffold re-submit found it granted, no GitHub call ·
   *  pending: every secret that exists is granted, the ones named in `pending` do not exist yet (not an error) ·
   *  partial: some secret is not set to "selected repositories" (an error, recorded) · skipped_revoked: the automatic
   *  trigger found an operator's revoke and left it. */
  outcome: "granted" | "already_granted" | "pending" | "partial" | "skipped_revoked";
  siteId: string;
  /** This site's derived per-site secret name (null until a grant has read the repo: the name ends in its GitHub id,
   *  and `siteSecretNote` then says why). */
  siteSecretName: string | null;
  /** Why `siteSecretName` is null (`SITE_SECRET_NOT_DERIVABLE`), else null. */
  siteSecretNote: string | null;
  /** M6-P6h2: every environment's per-site secret (staging, then production when the site has a production row), each with
   *  where it stands. [] until the repo's name and GitHub id are known. */
  siteSecrets: SiteSecretRef[];
  /** Secret names the owner has not created yet. */
  pending: string[];
  state: DeployGrantState | null;
  repo: string | null;
  repositoryId: number | null;
  snapshotId: string | null;
  headSha: string | null;
  secrets: SecretOutcome[];
  error: string | null;
}

export interface DeployRevokeResult {
  /** revoked: recorded · not_granted: the ERP never granted this site (swept anyway, nothing recorded) · partial: a
   *  secret is visible to all repos, so the repo still reads it (named in `secrets`). */
  outcome: "revoked" | "not_granted" | "partial";
  siteId: string;
  state: DeployGrantState | null;
  repo: string;
  repositoryId: number;
  secrets: SecretOutcome[];
  error: string | null;
}

// ── the conditions ──────────────────────────────────────────────────────────────────────────────────

/** The site's own facts (before the repo is resolved). Throws the first refusal. */
export function checkSiteConditions(row: DeployGrantRow, registry: RegistryFacts | null): void {
  if (row.provider !== "erp_repo" || !row.providerRef) {
    return refuse("deploy_grant_repo_unresolved", "only a repo created by ERP repo control (GH-12) is granted deploy access");
  }
  if (row.completionState !== "complete" || !row.contractSnapshotId) {
    return refuse("deploy_grant_site_not_complete", `provisioning is not complete (state: ${row.completionState ?? "none"})`);
  }
  if (row.status !== "provisioned" && row.status !== "live") return refuse("deploy_grant_site_not_complete", `the repo step is ${row.status}`);
  if (!row.repoUrl) return refuse("deploy_grant_repo_unresolved", "the provisioned row has no repo_url");
  if (!row.webdevSiteId || !registry || registry.deleted) {
    return refuse("deploy_grant_no_registry_row", "the site has no live webdev_sites row: an unregistered repo is never granted deploy access");
  }
  if (registry.origin !== "provisioned") {
    return refuse("deploy_grant_no_registry_row", `the linked webdev_sites row has origin ${registry.origin}, not provisioned`);
  }
  if (row.scaffoldState !== "committed") {
    return refuse("deploy_grant_not_committed", `the scaffold's first fill is not committed (state: ${row.scaffoldState ?? "none"})`);
  }
}

/** The registry row must name the repo GH-12 created. */
export function checkRegistryNamesRepo(registry: RegistryFacts, repo: RepoRef): void {
  if (!registry.repoUrl || !repoUrlNames(registry.repoUrl, repo.owner, repo.name)) {
    refuse("deploy_grant_registry_mismatch", `the webdev_sites row does not name ${repo.owner}/${repo.name}`);
  }
}

/** The lock at the head: present, well-formed, and naming the pinned snapshot. Returns it. */
export function checkLockBytes(bytes: Buffer | null, pinned: SnapshotFacts | null, where: string): ContractLock {
  if (!bytes) return refuse("deploy_grant_no_lock", `${where} carries no ${CONTRACT_LOCK_PATH} at its root`);
  let lock: ContractLock;
  try {
    lock = parseContractLock(bytes);
  } catch (err) {
    if (err instanceof ScaffoldRefusal) return refuse("deploy_grant_lock_invalid", `${where}: ${err.detail}`);
    throw err;
  }
  if (!pinned) return refuse("deploy_grant_lock_mismatch", "the site's pinned snapshot is not readable");
  try {
    checkLockAgainstPin(lock, pinned);
  } catch (err) {
    if (err instanceof ScaffoldRefusal) return refuse("deploy_grant_lock_mismatch", `${where}: ${err.detail}`);
    throw err;
  }
  return lock;
}

const repoName = (r: RepoRef): string => `${r.owner}/${r.name}`;
const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/** The row token for secrets not set to "selected repositories" (an error), or null. A missing secret is NOT an error:
 *  it is listed as pending instead. */
export function shortfallToken(short: readonly SecretOutcome[]): string | null {
  const notSelected = short.filter((s) => s.result === "not_selected").map((s) => s.name);
  return notSelected.length ? `deploy_grant_secret_not_selected: ${notSelected.join(",")}` : null;
}

/** The reason an operator gives for a revoke: required, trimmed, 8 to 500 characters. */
export function parseRevokeReason(body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < REVOKE_REASON_MIN || reason.length > REVOKE_REASON_MAX) {
    refuse("deploy_grant_reason_required", `a revoke needs a reason of ${REVOKE_REASON_MIN} to ${REVOKE_REASON_MAX} characters`);
  }
  return reason;
}

// ── the grant ───────────────────────────────────────────────────────────────────────────────────────

export interface GrantRequest {
  siteId: string;
  /** scaffold: the automatic follow-on of the scaffold commit · production: the automatic follow-on of creating a production
   *  row (M6-P6h2) · secret_write: the automatic follow-on of the ERP writing a per-site secret's value from the vault
   *  (M6-P6o, WSK-D88) · operator: the explicit POST (re-checks and re-grants). Every automatic trigger never undoes a revoke. */
  trigger: "scaffold" | "production" | "secret_write" | "operator";
}

/**
 * Grant the site's repo READ access to every configured deploy secret, once every condition holds. Safe to call again at
 * any point (a crash, a partial grant, a lost answer): it completes what is missing. Throws `DeployGrantRefusal`.
 */
export async function grantDeploySecrets(deps: DeployGrantDeps, req: GrantRequest): Promise<DeployGrantResult> {
  const fixedNames = deps.secretNames;
  if (fixedNames.length === 0) refuse("deploy_grant_not_configured", "no deploy secret names are configured");

  const first = await deps.withLockedSite(async (tx) => {
    const row = await tx.read();
    return { row, registry: row?.webdevSiteId ? await tx.readRegistry(row.webdevSiteId) : null };
  });
  const row0 = first.row;
  if (!row0) return refuse("not_found", "provisioned site not found");

  const result = (
    row: DeployGrantRow,
    outcome: DeployGrantResult["outcome"],
    repo: RepoRef | null,
    secrets: SecretOutcome[],
    registry: RegistryFacts | null = null,
  ): DeployGrantResult => ({
    outcome,
    siteId: row.id,
    siteSecretName: row.grantSiteSecretName,
    siteSecretNote: row.grantSiteSecretName ? null : SITE_SECRET_NOT_DERIVABLE,
    siteSecrets: siteSecretRefs({
      repoName: repo?.name ?? null, repositoryId: row.grantRepositoryId, stagingEnvironment: registry?.environment ?? null,
      hasProduction: registry?.production != null, grantedNames: row.grantSecretNames, pendingNames: row.grantPendingNames,
    }),
    pending: row.grantPendingNames,
    state: row.grantState,
    repo: repo ? repoName(repo) : null,
    repositoryId: row.grantRepositoryId,
    snapshotId: row.grantSnapshotId,
    headSha: row.grantHeadSha,
    secrets,
    error: row.grantError,
  });

  // An operator's revoke is never undone by an automatic path (the scaffold commit's, or a new production row's).
  const automatic = req.trigger !== "operator";
  if (automatic && row0.grantState === "revoked") return result(row0, "skipped_revoked", null, []);

  const recordAndThrow = async (err: unknown): Promise<never> => {
    const typed = err instanceof DeployGrantRefusal ? err : (deps.classifyError?.(err) ?? null);
    if (typed && typed.code !== "not_found") {
      await deps.withLockedSite(async (tx) => {
        if (await tx.read()) await tx.recordError(typed.rowToken);
      });
    }
    throw typed ?? err;
  };

  try {
    checkSiteConditions(row0, first.registry);
    const repo = await deps.resolveRepo(row0);
    if (!repo) return refuse("deploy_grant_repo_unresolved", "the GH-12 repo for this site could not be proven (approval, org or repo_url disagree)");
    const registry0 = first.registry as RegistryFacts;
    checkRegistryNamesRepo(registry0, repo);
    // An automatic trigger on a site already granted for these names and this pin: nothing to do. The per-site names end in the
    // repository id, so they are derived here from the id the last grant recorded (none: nothing to compare). The names
    // include the PRODUCTION secret once the site has a production row, so creating that row is never short-circuited.
    if (automatic && row0.grantState === "granted" && row0.grantSnapshotId === row0.contractSnapshotId && row0.grantRepositoryId !== null) {
      const perSite = perSiteSecretNames({ slug: repo.name, repositoryId: row0.grantRepositoryId }, grantEnvironments(registry0));
      const held = [...new Set([...fixedNames, ...perSite])];
      if (row0.grantSiteSecretName === perSite[0] && held.every((n) => row0.grantSecretNames.includes(n))) {
        return result(row0, "already_granted", repo, held.map((name) => ({ name, result: "granted" as const })), registry0);
      }
    }

    // Fresh reads at GitHub: which repo (its id), its default branch's head, the lock at that head.
    const info = await getRepoInfo(deps.git, repo);
    // The fixed list, then THIS site's own per-site secrets, one per environment the registry holds for it (the staging row's,
    // and the production row's once it exists), derived from the resolved repo's name and id (what the site's own workflow sees
    // as `github.event.repository.name` / `github.repository_id`), never from the caller.
    const perSiteNames = perSiteSecretNames({ slug: repo.name, repositoryId: info.id }, grantEnvironments(registry0));
    const siteSecretName = perSiteNames[0];
    const names = [...new Set([...fixedNames, ...perSiteNames])];
    const head = await getBranchHead(deps.git, repo, info.defaultBranch);
    if (!head) return refuse("deploy_grant_no_lock", `the default branch ${info.defaultBranch} does not exist`);
    const where = `${info.defaultBranch}@${head.slice(0, 12)}`;
    const lockBytes = await getFileAtRef(deps.git, repo, CONTRACT_LOCK_PATH, head);
    const pinned = await deps.readSnapshot(row0.contractSnapshotId as string);
    const lock = checkLockBytes(lockBytes, pinned, where);

    // Each secret's metadata (never its value), before any write: a missing App permission stops everything here.
    const visibility = new Map<string, OrgSecretVisibility | "unknown" | null>();
    for (const name of names) visibility.set(name, (await getOrgSecret(deps.git, repo.owner, name))?.visibility ?? null);

    // CLAIM: its own transaction, committed before any write, the site facts re-checked under the lock.
    const claimed = await deps.withLockedSite(async (tx) => {
      const r = await tx.read();
      if (!r) return refuse("not_found", "provisioned site not found");
      if (automatic && r.grantState === "revoked") return null;
      const reg = r.webdevSiteId ? await tx.readRegistry(r.webdevSiteId) : null;
      checkSiteConditions(r, reg);
      if (r.providerRef !== row0.providerRef || r.repoUrl !== row0.repoUrl || reg?.environment !== registry0.environment) {
        return refuse("deploy_grant_superseded", "the site's repo changed while the grant was being checked");
      }
      if (r.contractSnapshotId !== lock.snapshotId) {
        return refuse("deploy_grant_lock_mismatch", `the site's pin moved to ${r.contractSnapshotId} while the grant was being checked`);
      }
      await tx.claim({ snapshotId: lock.snapshotId, repositoryId: info.id, headSha: head, requestedBy: deps.actor.userId, siteSecretName });
      return tx.read();
    });
    if (claimed === null) return result(row0, "skipped_revoked", repo, [], registry0);

    // GRANT: under the lock, so a revoke cannot interleave. Per-name answers are data; a thrown error stops the loop.
    const done = await deps.withLockedSite(async (tx) => {
      const r = await tx.read();
      if (!r) return refuse("not_found", "provisioned site not found");
      if (r.grantState === "revoked" || r.grantRepositoryId !== info.id || r.grantSiteSecretName !== siteSecretName) {
        return refuse("deploy_grant_superseded", "the grant was revoked or re-claimed while this one was being written");
      }
      const secrets: SecretOutcome[] = [];
      const landed: string[] = [];
      let failure: unknown = null;
      for (const name of names) {
        const v = visibility.get(name);
        if (v === null) {
          secrets.push({ name, result: "missing" });
          continue;
        }
        if (v !== "selected") {
          // "all" or "private" makes the secret readable by every (private) repo: writing through it would void the gate.
          secrets.push({ name, result: "not_selected" });
          continue;
        }
        try {
          const res = await deps.ledger("grant", { repo, secretName: name }, () => addRepoToOrgSecret(deps.git, repo.owner, name, info.id));
          secrets.push({ name, result: res });
          if (res === "granted") landed.push(name);
        } catch (err) {
          failure = err;
          break;
        }
      }
      const held = union(r.grantSecretNames, landed);
      if (failure !== null) {
        // What landed is recorded (this transaction commits); the error is recorded by recordAndThrow.
        await tx.recordSecretNames(held);
        return { failure, secrets, row: null };
      }
      const short = secrets.filter((s) => s.result !== "granted");
      if (short.length === 0) {
        await tx.markGranted(held);
      } else {
        await tx.recordSecretNames(held);
        await tx.recordPending(secrets.filter((s) => s.result === "missing").map((s) => s.name), shortfallToken(short));
      }
      return { failure: null, secrets, row: await tx.read() };
    });
    if (done.failure !== null) throw done.failure;
    const row = done.row as DeployGrantRow;
    const outcome = done.secrets.every((s) => s.result === "granted")
      ? "granted"
      : done.secrets.some((s) => s.result === "not_selected") ? "partial" : "pending";
    return result(row, outcome, repo, done.secrets, registry0);
  } catch (err) {
    return recordAndThrow(err);
  }
}

// ── the revoke ──────────────────────────────────────────────────────────────────────────────────────

export interface RevokeRequest {
  siteId: string;
  reason: string;
}

/**
 * Remove the site's repo from every deploy secret it may hold (fixed list ∪ recorded ∪ every per-site name). Idempotent. A site the ERP never
 * granted is still swept (the DELETEs are harmless) but nothing is recorded. Throws `DeployGrantRefusal`.
 */
export async function revokeDeploySecrets(deps: DeployGrantDeps, req: RevokeRequest): Promise<DeployRevokeResult> {
  const reason = req.reason.trim();
  if (reason.length < REVOKE_REASON_MIN || reason.length > REVOKE_REASON_MAX) {
    refuse("deploy_grant_reason_required", `a revoke needs a reason of ${REVOKE_REASON_MIN} to ${REVOKE_REASON_MAX} characters`);
  }
  const row0 = await deps.withLockedSite((tx) => tx.read());
  if (!row0) return refuse("not_found", "provisioned site not found");

  const recordAndThrow = async (err: unknown): Promise<never> => {
    const typed = err instanceof DeployGrantRefusal ? err : (deps.classifyError?.(err) ?? null);
    if (typed && typed.code !== "not_found") {
      await deps.withLockedSite(async (tx) => {
        if (await tx.read()) await tx.recordError(typed.rowToken);
      });
    }
    throw typed ?? err;
  };

  try {
    if (row0.provider !== "erp_repo" || !row0.providerRef) {
      refuse("deploy_grant_repo_unresolved", "only a repo created by ERP repo control (GH-12) holds an ERP deploy grant");
    }
    const repo = await deps.resolveRepo(row0);
    if (!repo) return refuse("deploy_grant_repo_unresolved", "the GH-12 repo for this site could not be proven (approval, org or repo_url disagree)");
    const knownId = row0.grantRepositoryId ?? (await getRepoInfo(deps.git, repo)).id;

    const done = await deps.withLockedSite(async (tx) => {
      const r = await tx.read();
      if (!r) return refuse("not_found", "provisioned site not found");
      const repositoryId = r.grantRepositoryId ?? knownId;
      // The fixed list, what the row recorded, the staging per-site secret the claim recorded, and EVERY derivable per-site name
      // (staging and production, M6-P6h2, whether or not a production row exists now). This is also the archive path's sweep
      // (`revokeDeployAfterArchive` goes through `revokeDeployForSite`).
      const reg = r.webdevSiteId ? await tx.readRegistry(r.webdevSiteId) : null;
      const derivable = perSiteSecretNames({ slug: repo.name, repositoryId }, revokableEnvironments(reg));
      const names = union(union(deps.secretNames, r.grantSecretNames), union(r.grantSiteSecretName ? [r.grantSiteSecretName] : [], derivable));
      let remaining = [...r.grantSecretNames];
      const secrets: SecretOutcome[] = [];
      let failure: unknown = null;
      for (const name of names) {
        try {
          const res = await deps.ledger("revoke", { repo, secretName: name }, () => removeRepoFromOrgSecret(deps.git, repo.owner, name, repositoryId));
          secrets.push({ name, result: res });
          if (res === "revoked" || res === "missing") remaining = remaining.filter((n) => n !== name);
        } catch (err) {
          failure = err;
          break;
        }
      }
      if (failure !== null) {
        if (r.grantState !== null) await tx.recordSecretNames(remaining);
        return { failure, secrets, repositoryId, outcome: null, row: null };
      }
      if (r.grantState === null) return { failure: null, secrets, repositoryId, outcome: "not_granted" as const, row: r };
      const stuck = secrets.filter((s) => s.result === "not_selected");
      if (stuck.length > 0) {
        await tx.recordSecretNames(remaining);
        await tx.recordError(shortfallToken(stuck) as string);
        return { failure: null, secrets, repositoryId, outcome: "partial" as const, row: await tx.read() };
      }
      await tx.markRevoked({ reason, revokedBy: deps.actor.userId, repositoryId, revokedNames: names });
      return { failure: null, secrets, repositoryId, outcome: "revoked" as const, row: await tx.read() };
    });
    if (done.failure !== null) throw done.failure;
    const row = done.row as DeployGrantRow;
    return {
      outcome: done.outcome as DeployRevokeResult["outcome"],
      siteId: row.id,
      state: row.grantState,
      repo: repoName(repo),
      repositoryId: done.repositoryId,
      secrets: done.secrets,
      error: row.grantError,
    };
  } catch (err) {
    return recordAndThrow(err);
  }
}
