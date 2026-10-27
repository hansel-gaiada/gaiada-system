// M6-P6o (WSK-D88) — the ERP writes each delivered site's deploy secret into GitHub FROM ITS VAULT RECORD.
//
// WSK-D88 (owner, 2026-10-13) amends D29 and D79: the per-site, docroot-locked principal and one org secret per site and
// environment stay (M6-P6d's name, `WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>`), but the value is written by the ERP from the
// site's vault record (`integration_connections`), not by an org owner by hand. The vault is the one copy that counts; the
// org secret is derived from it, so a rotation reseals the vault record and the ERP rewrites the secret. The ERP still
// deploys nothing (each site's own CI does).
//
// This file is the CONDITIONS and the ORDER, written against ports so it runs without a database
// (deploy-secret-write.unit.test.ts, against the in-memory GitHub of core/github/git-data.testkit.ts). The Postgres, ERP
// App, ledger, approval and authorization bindings are deploy-secret.service.ts.
//
// ═══ THE WRITE, STEP BY STEP (each wall says what stops there and what has NOT happened yet) ═══════════════════
//   1. the facts, re-read: the registry row is a live provisioned staging or production row; its provisioned site exists and
//      its deploy grant is NOT `revoked` (an archived site keeps no deploy access, WSK-D82); its `vault_ref` is still the
//      record the approval named; the record is of this tenant, of the provider the row's access needs, `linked`, owned by
//      THIS row (a per-site record, M6-P6o2), the company or the site's own client (another site's or the other environment's
//      per-site record is refused); and its sealed value is the VERSION the approval named (a reseal after filing
//      refuses `deploy_secret_vault_changed`: the decider approved a specific sealed value, not "whatever is there now").
//      Nothing has been asked of GitHub, nothing decrypted.
//   2. the repo: the one GH-12 created for the site (resolveProvisionedRepo), and its numeric id from GitHub. The secret's
//      name is derived from them (siteDeploySecretName), never taken from the caller. A recorded grant for another id
//      refuses `deploy_secret_superseded`.
//   3. the org's Actions public key. An App without `organization_secrets` (O-3) is refused HERE, with the typed
//      `github_permission_missing: organization_secrets`, before the vault is decrypted and before anything is written.
//   4. the existing secret's metadata (never its value): which repositories the write keeps.
//   5. decrypt the vault value, IN MEMORY, check its shape again (deploy-credential.ts) and that it matches this row
//      (environment, transport for the row's access, a docroot for a static site), seal it to the public key
//      (libsodium sealed box, core/github/sealed-box.ts). The plaintext lives in this function's frame only.
//   6. PUT the sealed value: `encrypted_value`, `key_id`, visibility `selected`, and exactly the repositories this site's
//      grant ALREADY holds for this name (the repo itself when the grant recorded it, else none). The write never widens
//      access: a new secret is created visible to no repository, and only the grant (step 7) adds the repo, after every
//      deploy-gate condition (CONTRACT.lock, the pin) has been re-checked. Ledgered as `github.secret_write` with the
//      secret's NAME, the approval, and the basis `deploy-secret-write` (WSK-D88). A failed write throws: step 7 is NOT
//      attempted, so a failed write can never leave a grant behind it.
//   7. the grant, as today (deploy-grant.ts, trigger `secret_write`: automatic, so it never undoes an operator's revoke).
//      Its outcome is reported as data: the value is written whether or not the grant could complete.
//
// ═══ NEVER AT REST, NEVER IN OUTPUT ═════════════════════════════════════════════════════════════════════════════
// The value is never logged, never in an audit row (identifiers only: the secret's name, the record's id, the approval),
// never on the outbox, never in a response, never in an error. Every error from the GitHub write is scrubbed
// (deploy-credential.ts `scrubError`: every string field, its lines, the canonical text, the sealed box) BEFORE the
// ledger records its message. Refusals carry field names and tokens, never values. Proven by the leak scan in
// deploy-secret.db.test.ts (src/testing/secret-value-leaks.ts), with a positive control.
import type { GitCaller, RepoRef } from "../../core/github/git-data";
import { getOrgPublicKey, getOrgSecret, getRepoInfo, putOrgSecretValue } from "../../core/github/org-secrets";
import { sealForGithubSecret } from "../../core/github/sealed-box";
import { siteDeploySecretName, type DeployGrantRow, type DeployGrantState } from "./deploy-grant";
import { vaultRecordRefusal } from "./delivery-binding";
import {
  VAULT_PROVIDER_FOR_TRANSPORT, parseDeployCredentialText, redactorFor, scrubError,
} from "./deploy-credential";

/** `automation_approvals` identity of this request kind: origin `github` (GH-12's), its own workflow. */
export const DEPLOY_SECRET_WORKFLOW = "github:write_deploy_secret";
export const DEPLOY_SECRET_TOOL = "github.writeDeploySecret";
export const DEPLOY_SECRET_ORIGIN = "github";

export function isDeploySecretWriteRequest(origin: string, workflowId: string | null): boolean {
  return origin === DEPLOY_SECRET_ORIGIN && workflowId === DEPLOY_SECRET_WORKFLOW;
}

/** The GH-04 ledger basis of a value write (the WSK-D65 precedent: the ledger says which ruling a write rests on). */
export const DEPLOY_SECRET_WRITE_BASIS = { kind: "deploy-secret-write", ruling: "WSK-D88" } as const;

// ── refusals ────────────────────────────────────────────────────────────────────────────────────────

export const DEPLOY_SECRET_REFUSALS = {
  not_found: 404,
  deploy_secret_body_invalid: 400,
  deploy_secret_args_invalid: 400,
  deploy_credential_invalid: 422,
  deploy_credential_wrong_record: 422,
  deploy_secret_not_deliverable: 409,
  deploy_secret_no_provisioned_site: 409,
  deploy_secret_site_revoked: 409,
  deploy_secret_no_vault_record: 409,
  deploy_secret_vault_unusable: 422,
  deploy_secret_vault_changed: 409,
  deploy_secret_credential_mismatch: 422,
  deploy_secret_request_open: 409,
  deploy_secret_repo_unresolved: 409,
  deploy_secret_superseded: 409,
  deploy_secret_not_configured: 503,
  self_approval: 403,
  // the far side (the same tokens and statuses as the deploy grant's)
  github_permission_missing: 503,
  github_app_not_installed: 503,
  github_not_configured: 503,
  github_org_unavailable: 503,
  github_rate_limited: 429,
  github_request_failed: 502,
} as const;
export type DeploySecretRefusalCode = keyof typeof DEPLOY_SECRET_REFUSALS;

export class DeploySecretRefusal extends Error {
  readonly status: number;
  constructor(
    readonly code: DeploySecretRefusalCode,
    /** Human text. NEVER a value: field names, tokens, ids. */
    readonly detail: string,
    /** A short qualifier recorded with the token, e.g. `organization_secrets`. */
    readonly qualifier?: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "DeploySecretRefusal";
    this.status = DEPLOY_SECRET_REFUSALS[code];
  }

  /** What the approval row's `execution_error` and the console show: the token, and its qualifier when there is one. */
  get rowToken(): string {
    return this.qualifier ? `${this.code}: ${this.qualifier}` : this.code;
  }
}

const refuse = (code: DeploySecretRefusalCode, detail: string, qualifier?: string): never => {
  throw new DeploySecretRefusal(code, detail, qualifier);
};

// ── the approval's stored arguments (identifiers only) ──────────────────────────────────────────────

export interface DeploySecretArgs {
  provisionedSiteId: string;
  /** The `webdev_sites` row (one environment). */
  webdevSiteId: string;
  environment: "staging" | "production";
  /** The vault record (`integration_connections.id`) the row pointed at when the request was filed. */
  connectionId: string;
  /** sha256 (hex) of the record's sealed envelope at filing: binds the approval to ONE sealed value. Not a value: a hash of
   *  ciphertext under a random IV says nothing about the plaintext. */
  sealedVersion: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Re-validated at execution: the stored `tool_args` are read back from the database, never trusted as clean. */
export function parseDeploySecretArgs(raw: unknown): DeploySecretArgs | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const ok =
    typeof a.provisionedSiteId === "string" && UUID_RE.test(a.provisionedSiteId) &&
    typeof a.webdevSiteId === "string" && UUID_RE.test(a.webdevSiteId) &&
    (a.environment === "staging" || a.environment === "production") &&
    typeof a.connectionId === "string" && UUID_RE.test(a.connectionId) &&
    typeof a.sealedVersion === "string" && /^[0-9a-f]{64}$/.test(a.sealedVersion);
  if (!ok) return null;
  return {
    provisionedSiteId: (a.provisionedSiteId as string).toLowerCase(),
    webdevSiteId: (a.webdevSiteId as string).toLowerCase(),
    environment: a.environment as "staging" | "production",
    connectionId: (a.connectionId as string).toLowerCase(),
    sealedVersion: a.sealedVersion as string,
  };
}

// ── the facts ───────────────────────────────────────────────────────────────────────────────────────

export interface EnvRowFacts {
  id: string;
  environment: string;
  origin: string;
  deleted: boolean;
  access: string;
  kind: string;
  vaultRef: string | null;
  clientId: string | null;
}

export interface VaultFacts {
  id: string;
  provider: string;
  status: string;
  ownerKind: string;
  ownerId: string;
  /** sha256 hex of `access_token_enc`, or null when nothing is sealed. */
  sealedVersion: string | null;
}

export interface WriteFacts {
  env: EnvRowFacts | null;
  /** The provisioned site this row belongs to (its staging row, or the staging row its production row was made from). */
  site: DeployGrantRow | null;
  /** The record `env.vaultRef` names, in this tenant, live; null when it names nothing. */
  vault: VaultFacts | null;
}

/**
 * Step 1's checks. `expect` is the approval's stored arguments (execution); without it (filing) the row's CURRENT pointer and
 * seal are what would be filed. Throws the first refusal. Returns the vault facts the caller files or compares.
 */
export function checkWriteFacts(facts: WriteFacts, expect?: DeploySecretArgs): VaultFacts {
  const env = facts.env;
  if (!env || env.deleted) return refuse("not_found", "webdev site not found");
  if (env.origin !== "provisioned" || (env.environment !== "staging" && env.environment !== "production")) {
    return refuse("deploy_secret_not_deliverable", `only a provisioned staging or production row has a deploy secret (this is ${env.origin}/${env.environment})`);
  }
  if (expect && env.environment !== expect.environment) return refuse("deploy_secret_superseded", "the row's environment changed after the request was filed");
  const site = facts.site;
  if (!site) return refuse("deploy_secret_no_provisioned_site", "this row belongs to no provisioned site (a hand-registered site has no ERP deploy secret)");
  if (expect && site.id !== expect.provisionedSiteId) return refuse("deploy_secret_superseded", "the row belongs to another provisioned site than the request named");
  if (site.grantState === "revoked") {
    return refuse("deploy_secret_site_revoked", "the site's deploy grant is revoked (an archived site keeps no deploy access, WSK-D82); nothing is written");
  }
  if (!env.vaultRef || !facts.vault) return refuse("deploy_secret_no_vault_record", "the row is not bound to a vault record (POST sites/:id/delivery-binding)");
  const v = facts.vault;
  if (expect && v.id !== expect.connectionId) return refuse("deploy_secret_vault_changed", "the row now points at another vault record than the request named; file a new request");
  // The owner rule is the bind's (delivery-binding.ts): this row's own per-site record (M6-P6o2), the company, or the row's client.
  const r = vaultRecordRefusal({ provider: v.provider, status: v.status, ownerKind: v.ownerKind, ownerId: v.ownerId }, env.access, { id: env.id, clientId: env.clientId });
  if (r) return refuse("deploy_secret_vault_unusable", r.detail, r.code);
  if (!v.sealedVersion) return refuse("deploy_secret_vault_unusable", "the vault record holds no sealed credential", "vault_ref_not_linked");
  if (expect && v.sealedVersion !== expect.sealedVersion) {
    return refuse("deploy_secret_vault_changed", "the vault record was resealed after the request was filed; file a new request for the current value");
  }
  return v;
}

// ── the ports ───────────────────────────────────────────────────────────────────────────────────────

/** What the grant step reports (deploy-grant.service.ts's `DeployGrantSummary`, narrowed). Never a value. */
export interface GrantStepOutcome {
  outcome: string;
  state: DeployGrantState | null;
  error: string | null;
}

export interface DeploySecretWriteDeps {
  loadFacts(): Promise<WriteFacts>;
  /** The repo GH-12 created for the site, or null when it cannot be proven. */
  resolveRepo(site: DeployGrantRow): Promise<RepoRef | null>;
  /** The ERP App (production: `erpGitCaller` under the GitHub org tenant). */
  git: GitCaller;
  /** Decrypt the vault record's value. Called ONCE, after every check and after the public key was read. */
  openVault(connectionId: string): Promise<string | null>;
  /** Wraps the one value write in the GH-04 ledger (`github.secret_write`, the NAME, the approval, the basis). */
  ledger<T>(target: { repo: RepoRef; secretName: string }, perform: () => Promise<T>): Promise<T>;
  /** Step 7: the existing grant. Never throws (a refusal comes back as data). */
  grant(): Promise<GrantStepOutcome>;
  /** Maps a far-side error to a typed refusal; null rethrows it (already scrubbed). */
  classifyError(err: unknown): DeploySecretRefusal | null;
}

export interface DeploySecretWriteResult {
  outcome: "written";
  secretName: string;
  environment: "staging" | "production";
  repo: string;
  repositoryId: number;
  /** GitHub's answer: a new secret (201) or an update of an existing one (204). */
  written: "created" | "updated";
  /** The org public key id the value was sealed to. Public. */
  keyId: string;
  /** The repositories the write left selected (this repo when the grant already held the name, else none). */
  selectedRepositoryIds: number[];
  sealedVersion: string;
  grant: GrantStepOutcome;
}

/** Run steps 1 to 7. Throws `DeploySecretRefusal` (or a scrubbed, unclassified error) before step 7 on any failure. */
export async function writeDeploySecret(deps: DeploySecretWriteDeps, args: DeploySecretArgs): Promise<DeploySecretWriteResult> {
  const classified = (err: unknown): unknown => (err instanceof DeploySecretRefusal ? err : (deps.classifyError(err) ?? err));

  // 1. the facts.
  const facts = await deps.loadFacts();
  checkWriteFacts(facts, args);
  const env = facts.env as EnvRowFacts;
  const site = facts.site as DeployGrantRow;

  let repo: RepoRef | null;
  let repositoryId: number;
  let secretName: string;
  let publicKey: { keyId: string; key: string };
  let visibility: string | null;
  try {
    // 2. the repo and the name.
    repo = await deps.resolveRepo(site);
    if (!repo) return refuse("deploy_secret_repo_unresolved", "the GH-12 repo for this site could not be proven (approval, org or repo_url disagree)");
    repositoryId = (await getRepoInfo(deps.git, repo)).id;
    if (site.grantRepositoryId !== null && site.grantRepositoryId !== repositoryId) {
      return refuse("deploy_secret_superseded", "the site's grant recorded another repository id than GitHub reports for its repo");
    }
    secretName = siteDeploySecretName({ slug: repo.name, environment: env.environment, repositoryId });
    // 3. the public key: O-3 stops here, before anything is decrypted or written.
    publicKey = await getOrgPublicKey(deps.git, repo.owner);
    // 4. the existing secret's metadata.
    visibility = (await getOrgSecret(deps.git, repo.owner, secretName))?.visibility ?? null;
  } catch (err) {
    throw classified(err);
  }

  const target: RepoRef = repo;
  // The write keeps only what the grant already holds for this name, so it never widens access (step 6's rule).
  const held = visibility !== null && site.grantState !== null && site.grantSecretNames.some((n) => n.toUpperCase() === secretName);
  const selectedRepositoryIds = held ? [repositoryId] : [];

  // 5. decrypt in memory, check, seal.
  const plaintext = await deps.openVault(args.connectionId);
  if (!plaintext) return refuse("deploy_secret_vault_unusable", "the vault record holds no sealed credential", "vault_ref_not_linked");
  const parsed = parseDeployCredentialText(plaintext);
  if (!parsed.ok) return refuse("deploy_credential_invalid", `the sealed credential does not have the documented shape: ${parsed.problems.join("; ")}`);
  const cred = parsed.credential;
  if (cred.environment !== env.environment) {
    return refuse("deploy_secret_credential_mismatch", `the sealed credential is for environment ${cred.environment}, this row is ${env.environment} (a staging credential never deploys production)`, "environment");
  }
  if (VAULT_PROVIDER_FOR_TRANSPORT[cred.transport] !== facts.vault?.provider) {
    return refuse("deploy_secret_credential_mismatch", `transport ${cred.transport} does not match the vault record's provider`, "transport");
  }
  if ((env.kind === "static" || env.kind === "fullstack") && !cred.docroot) {
    return refuse("deploy_secret_credential_mismatch", `a ${env.kind} site's credential needs docroot (the document root's name inside remoteBase)`, "docroot");
  }
  let sealed: string;
  try {
    sealed = await sealForGithubSecret(publicKey.key, parsed.canonical);
  } catch {
    // The only inputs are GitHub's key (public) and the value; say nothing about the value.
    return refuse("github_request_failed", "GitHub's Actions public key could not be used to seal the value");
  }
  const redact = redactorFor(cred, parsed.canonical, [sealed]);

  // 6. the write. Ledgered; its error scrubbed before the ledger records it; a failure stops here (no grant).
  let written: "created" | "updated";
  try {
    written = await deps.ledger({ repo: target, secretName }, async () => {
      try {
        return await putOrgSecretValue(deps.git, target.owner, secretName, {
          encryptedValue: sealed, keyId: publicKey.keyId, selectedRepositoryIds,
        });
      } catch (err) {
        throw scrubError(err, redact);
      }
    });
  } catch (err) {
    throw classified(scrubError(err, redact));
  }

  // 7. the grant, as today. Reported, never thrown.
  const grant = await deps.grant();

  return {
    outcome: "written",
    secretName,
    environment: args.environment,
    repo: `${target.owner}/${target.name}`,
    repositoryId,
    written,
    keyId: publicKey.keyId,
    selectedRepositoryIds,
    sealedVersion: args.sealedVersion,
    grant,
  };
}
