// M6-P6o (WSK-D88) — the Postgres, vault, ERP-App, ledger, approval and authorization bindings of deploy-secret-write.ts
// (read that file's header first: the seven steps and where each wall is). Four entry points, plus M6-P6o2's per-site
// record (one row's OWN vault record, owner_kind `webdev_site`, owner_id = the registry row; migration 202610271200):
//
//   createSiteDeployRecord      POST sites/:id/deploy-credentials       make (or return) the row's own ssh/ftp record (step 2a).
//   listSiteDeployRecords       GET  sites/:id/deploy-credentials       the row's own records, masked.
//   sealDeployCredential        PUT  deploy-credentials/:connectionId   the TRACKED way a hosting credential enters the vault
//                               (replaces the local, untracked VLT-4 script for deploy principals; runbook step 2b).
//   fileDeploySecretWrite       POST sites/:id/deploy-secret            files ONE HIGH approval to write that row's secret.
//   preflight / execute         automation-approvals.controller.ts#decide() runs these for an approved row, in-band, as the
//                               DECIDER (GH-12's shape: origin `github`, its own workflow id, never the D14 hub registry).
//   readDeploySecretState       GET  sites/:id/deploy-secret            what the console shows: written, stale, or PENDING with
//                               the typed reason (O-3 reads `github_permission_missing: organization_secrets`, never success).
//
// ── AUTHORIZATION (no Cerbos change; every key below already exists) ──────────────────────────────────────────────
//   record   (P6o2) `webdev_site · update` on the row (the bind's gate) + `integration_connection · manage` (ownerId ""):
//            a per-site record is the company tier like every non-user record; read is `webdev_site · read` + `manage`.
//   seal     `integration_connection · manage` on the record (the company tier every other vault write asks for a company or
//            client record: the generic connections API, Figma's PUT). Checked BEFORE the body is read, so a caller who may
//            not seal learns nothing from a malformed body (and the value is never parsed for them).
//   file     the deploy grant's pair: `webdev_provisioned_site · provision` on the company, then `github_repo · push` on the
//            GitHub org tenant (GHT-1: resolve, then authorize against the resolved tenant).
//   decide   the generic `automation_approval · decide` (company_admin) in decide(), THEN, here, before the decide UPDATE:
//            decider ≠ requester (VLT-3's rule, in code: Cerbos has no notion of "the user who filed this row"), and the
//            decider must hold all three of `webdev_provisioned_site · provision`, `integration_connection · manage` on the
//            record (VLT-3's decider gate: who lifts a credential gate must be able to administer the credential), and
//            `github_repo · secret_write` WITH this approval's id (resource_github_repo.yaml's D14 rule: company_admin or
//            module_manager, approvalId required). The executor re-checks the stored `decided_by` against `requested_by`
//            (a second wall for a row approved by any other path) and re-authorizes `secret_write` before any egress.
//   The PGL-05 generic self-approval rule (approval-self-approval.ts) covers automation/agent rows and is untouched; this kind
//   is a human-filed `github` row, so its own rule above is what applies.
//
// ── NEVER AT REST, NEVER IN OUTPUT ─────────────────────────────────────────────────────────────────────────────────
// The seal route answers the masked connection (`hasToken`) and a version hash of the CIPHERTEXT, never the value. The
// approval stores identifiers only. The audit rows and outbox events carry the record's id, the secret's NAME, the approval
// id and tokens. Nothing in this file logs a value or an error message that could hold one.
import { createHash } from "node:crypto";
import { BadRequestException, ForbiddenException, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { fileAutomationApproval } from "../../core/approval-filing";
import { resolveGithubOrgTenant } from "../../core/github-org-tenant";
import { erpGitCaller } from "../../core/github/git-data";
import { withGithubLedger } from "../../core/github/ledger";
import {
  createConnection, getConnectionRow, listConnections, readAccessToken, setConnectionTokens, type ConnectionResponse,
} from "../../core/integrations.service";
import { cerbosOwnerId, connectionAction } from "../../core/integrations.controller";
import { tokenVaultConfigured } from "../../core/secret-box";
import type { Principal } from "../../rbac/principal";
import { resolveProvisionedRepo } from "./provisioned-repo";
import { parseGithubRepoUrl } from "./site-build-targets";
import { siteDeploySecretName } from "./deploy-grant";
import { classifyDeployGrantError, followSecretWrite, readDeployGrantRowIn } from "./deploy-grant.service";
import { VAULT_PROVIDER_FOR_TRANSPORT, parseDeployCredential } from "./deploy-credential";
import {
  DEPLOY_SECRET_ORIGIN, DEPLOY_SECRET_TOOL, DEPLOY_SECRET_WORKFLOW, DEPLOY_SECRET_WRITE_BASIS, DeploySecretRefusal,
  checkWriteFacts, parseDeploySecretArgs, writeDeploySecret,
  type DeploySecretArgs, type DeploySecretRefusalCode, type DeploySecretWriteDeps, type DeploySecretWriteResult,
  type EnvRowFacts, type VaultFacts, type WriteFacts,
} from "./deploy-secret-write";

const logger = new Logger("DeploySecret");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEPLOY_SECRET_REASON_MAX = 500;

/** sha256 (hex) of a sealed envelope: the "which sealed value" an approval is bound to. A hash of ciphertext, not of a value. */
export function sealedVersionOf(enc: string | null | undefined): string | null {
  return enc ? createHash("sha256").update(enc, "utf8").digest("hex") : null;
}

const refuse = (code: DeploySecretRefusalCode, detail: string, qualifier?: string): never => {
  throw new DeploySecretRefusal(code, detail, qualifier);
};

// ── the facts ──────────────────────────────────────────────────────────────────────────────────────

async function readFactsIn(c: PoolClient, tenantId: string, webdevSiteId: string): Promise<WriteFacts> {
  const e = await c.query<{
    id: string; environment: string; origin: string; deleted_at: Date | null; access: string; kind: string;
    vault_ref: string | null; client_id: string | null; promoted_from_site_id: string | null;
  }>(
    `SELECT id, environment, origin, deleted_at, access, kind, vault_ref, client_id, promoted_from_site_id
       FROM webdev_sites WHERE id = $1 AND tenant_id = $2`,
    [webdevSiteId, tenantId],
  );
  const row = e.rows[0];
  if (!row) return { env: null, site: null, vault: null };
  const env: EnvRowFacts = {
    id: row.id, environment: row.environment, origin: row.origin, deleted: row.deleted_at !== null, access: row.access,
    kind: row.kind, vaultRef: row.vault_ref, clientId: row.client_id,
  };
  // The provisioned site: a staging row is its `webdev_site_id`; a production row was made from that staging row.
  const stagingId = row.environment === "production" ? row.promoted_from_site_id : row.id;
  let site = null;
  if (stagingId) {
    const p = await c.query<{ id: string }>(
      `SELECT id FROM webdev_provisioned_sites WHERE tenant_id = $1 AND webdev_site_id = $2 ORDER BY created_at, id LIMIT 1`,
      [tenantId, stagingId],
    );
    if (p.rows[0]) site = await readDeployGrantRowIn(c, p.rows[0].id);
  }
  let vault: VaultFacts | null = null;
  if (row.vault_ref && UUID_RE.test(row.vault_ref)) {
    const v = await c.query<{ id: string; provider: string; status: string; owner_kind: string; owner_id: string; access_token_enc: string | null }>(
      `SELECT id, provider, status, owner_kind, owner_id, access_token_enc FROM integration_connections
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [row.vault_ref.toLowerCase(), tenantId],
    );
    const r = v.rows[0];
    if (r) vault = { id: r.id, provider: r.provider, status: r.status, ownerKind: r.owner_kind, ownerId: r.owner_id, sealedVersion: sealedVersionOf(r.access_token_enc) };
  }
  return { env, site, vault };
}

function readFacts(tenantId: string, webdevSiteId: string): Promise<WriteFacts> {
  return withTenants([tenantId], (c) => readFactsIn(c, tenantId, webdevSiteId), { modules: ["webdev"] });
}

function actorOf(principal: Principal): string {
  if (!principal.userId) throw new ForbiddenException("an authenticated user is required");
  return principal.userId;
}

async function orgTenantOf(tenantId: string): Promise<string> {
  const org = await resolveGithubOrgTenant(tenantId);
  if (!org.ok) {
    return refuse(
      "github_org_unavailable",
      org.reason === "unconfigured" ? "the GitHub org tenant is not configured (GITHUB_REPO_SYNC_TENANT_ID)" : "this company has no GitHub org registered for its root",
    );
  }
  return org.tenantId;
}

// ── 0. the per-site record (M6-P6o2, runbook step 2a) ──────────────────────────────────────────────

/** The live staging or production registry row a per-site record names, or null. Read under both RLS walls. */
async function ownerRowOf(tenantId: string, webdevSiteId: string): Promise<{ id: string; environment: "staging" | "production" } | null> {
  if (!UUID_RE.test(webdevSiteId)) return null;
  const r = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string; environment: string }>(
        `SELECT id, environment FROM webdev_sites WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [webdevSiteId.toLowerCase(), tenantId],
      ),
    { modules: ["webdev"] },
  );
  const row = r.rows[0];
  if (!row || (row.environment !== "staging" && row.environment !== "production")) return null;
  return { id: row.id, environment: row.environment };
}

/** The providers a per-site deploy record may have: `ssh` (SFTP) or `ftp` (FTPS), the bind's `VAULT_PROVIDER_FOR_ACCESS`. */
export const SITE_DEPLOY_RECORD_PROVIDERS: readonly string[] = ["ssh", "ftp"];
const EXTERNAL_ACCOUNT_MAX = 200;

/**
 * Create (or return) the per-site vault record of ONE registry row: `owner_kind 'webdev_site'`, `owner_id` = the row's id
 * (migration 202610271200). One `ssh` and one `ftp` record per row, so every site and environment holds its own principal
 * (WSK-D79). Idempotent: the generic upsert on `(tenant, owner_kind, owner_id, provider)` returns the same record (a revoked
 * one comes back `unconfigured`, with no token). Body EXACTLY `{provider}` or `{provider, externalAccount}` (a LABEL, never a
 * secret). No token is accepted here: the value is sealed with PUT deploy-credentials/:connectionId.
 *
 * Authorization first, independent of the body: `webdev_site · update` on the row (the bind's gate) AND
 * `integration_connection · manage` (the company tier every non-user vault record asks; ownerId "" so `owns` never matches).
 */
export async function createSiteDeployRecord(principal: Principal, tenantId: string, webdevSiteId: string, body: unknown): Promise<ConnectionResponse> {
  if (!UUID_RE.test(webdevSiteId)) return refuse("not_found", "webdev site not found");
  const id = webdevSiteId.toLowerCase();
  await authorize(principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "update");
  await authorize(principal, { kind: "integration_connection", tenantId, ownerId: "" }, "manage");
  const actorId = actorOf(principal);

  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const keys = b ? Object.keys(b) : [];
  const ext = b?.externalAccount;
  if (
    !b || keys.some((k) => k !== "provider" && k !== "externalAccount") ||
    typeof b.provider !== "string" || !SITE_DEPLOY_RECORD_PROVIDERS.includes(b.provider) ||
    (ext !== undefined && ext !== null && (typeof ext !== "string" || ext.trim().length === 0 || ext.length > EXTERNAL_ACCOUNT_MAX))
  ) {
    return refuse(
      "deploy_secret_body_invalid",
      `the body must be exactly {provider: "ssh"|"ftp"} or {provider, externalAccount} (a label of 1 to ${EXTERNAL_ACCOUNT_MAX} characters, never a secret)`,
    );
  }
  const owner = await ownerRowOf(tenantId, id);
  if (!owner) {
    // Distinguish a row that exists but is not deliverable from one that does not exist (or is another tenant's: RLS hides it).
    const any = await withTenants([tenantId], (c) => c.query(`SELECT 1 FROM webdev_sites WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, tenantId]), { modules: ["webdev"] });
    if (!any.rows[0]) return refuse("not_found", "webdev site not found");
    return refuse("deploy_secret_not_deliverable", "only a staging or production row has a deploy record (a preview or development row is never delivered)");
  }
  const record = await createConnection(tenantId, {
    ownerKind: "webdev_site",
    ownerId: owner.id,
    provider: b.provider,
    externalAccount: typeof ext === "string" ? ext.trim() : null,
    createdBy: actorId,
  });
  await writeActivity(tenantId, actorId, "created", "integration_connection", record.id, {
    ownerKind: "webdev_site", webdevSiteId: owner.id, environment: owner.environment, provider: record.provider,
  });
  return record;
}

/** The per-site records of ONE registry row (masked: `hasToken`, never a value). `webdev_site · read` on the row and
 *  `integration_connection · manage` (reading a vault record that is not your own is the company tier). */
export async function listSiteDeployRecords(principal: Principal, tenantId: string, webdevSiteId: string): Promise<ConnectionResponse[]> {
  if (!UUID_RE.test(webdevSiteId)) return refuse("not_found", "webdev site not found");
  const id = webdevSiteId.toLowerCase();
  await authorize(principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "read");
  await authorize(principal, { kind: "integration_connection", tenantId, ownerId: "" }, "manage");
  const exists = await withTenants([tenantId], (c) => c.query(`SELECT 1 FROM webdev_sites WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, tenantId]), { modules: ["webdev"] });
  if (!exists.rows[0]) return refuse("not_found", "webdev site not found");
  return listConnections(tenantId, { ownerKind: "webdev_site", ownerId: id, includeRevoked: true });
}

// ── 1. the seal (runbook step 2b) ──────────────────────────────────────────────────────────────────

export interface SealedCredentialDto {
  /** The masked record: `hasToken`, never the value. */
  connection: ConnectionResponse;
  /** The version a write approval is bound to (sha256 of the ciphertext). */
  sealedVersion: string;
  environment: string;
  transport: string;
}

/**
 * Seal a per-site deploy credential into its vault record. Body EXACTLY `{credential: {...}}` (the deploy secret's documented
 * shape, deploy-credential.ts). Accepted once and never echoed: the answer is the masked record and a ciphertext hash. A
 * reseal replaces the value; the org secret is then STALE until a write is approved (`GET sites/:id/deploy-secret`).
 */
export async function sealDeployCredential(principal: Principal, tenantId: string, connectionId: string, body: unknown): Promise<SealedCredentialDto> {
  if (!UUID_RE.test(connectionId)) return refuse("not_found", "vault record not found");
  const row = await getConnectionRow(tenantId, connectionId.toLowerCase());
  if (!row || row.deleted_at !== null) return refuse("not_found", "vault record not found");
  // Authorization first, independent of the body (validation must never pre-empt the gate under test).
  const authOwner = cerbosOwnerId(row.owner_kind, row.owner_id);
  await authorize(
    principal,
    { kind: "integration_connection", id: row.id, tenantId, ownerId: authOwner },
    connectionAction("update", authOwner, principal.userId ?? ""),
  );
  const actorId = actorOf(principal);

  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || Object.keys(b).length !== 1 || !("credential" in b)) {
    return refuse("deploy_secret_body_invalid", "the body must be exactly {credential: {...}}");
  }
  const parsed = parseDeployCredential(b.credential);
  if (!parsed.ok) return refuse("deploy_credential_invalid", `the credential does not have the documented shape: ${parsed.problems.join("; ")}`);
  const want = VAULT_PROVIDER_FOR_TRANSPORT[parsed.credential.transport];
  if (row.provider !== want) {
    return refuse("deploy_credential_wrong_record", `transport ${parsed.credential.transport} needs a vault record of provider ${want}, this one is ${row.provider}`, "provider");
  }
  if (row.owner_kind !== "company" && row.owner_kind !== "client" && row.owner_kind !== "webdev_site") {
    return refuse("deploy_credential_wrong_record", "a deploy credential belongs to a site row's own record, a company or a client record, never a user's", "owner");
  }
  if (row.status === "revoked") return refuse("deploy_credential_wrong_record", "the record is revoked; create it again first (POST sites/:id/deploy-credentials)", "revoked");
  if (row.owner_kind === "webdev_site") {
    // A per-site record (M6-P6o2) is ONE row's: its owning row must still be a live staging or production row of this tenant,
    // and the credential must be for that row's environment (the write re-checks it; refusing here keeps a wrong value out).
    const owner = await ownerRowOf(tenantId, row.owner_id);
    if (!owner) return refuse("deploy_credential_wrong_record", "the record's site row no longer exists, or is not a staging or production row", "owner");
    if (parsed.credential.environment !== owner.environment) {
      return refuse(
        "deploy_credential_wrong_record",
        `this record is the ${owner.environment} row's own; the credential is for ${parsed.credential.environment}`,
        "environment",
      );
    }
  }
  if (!tokenVaultConfigured()) return refuse("deploy_secret_not_configured", "the vault is not configured (INTEGRATION_TOKEN_KEY); nothing was stored");

  const connection = await setConnectionTokens(tenantId, row.id, { accessToken: parsed.canonical });
  const after = await getConnectionRow(tenantId, row.id);
  const sealedVersion = sealedVersionOf(after?.access_token_enc) as string;
  // Identifiers and the non-secret shape facts only.
  await writeActivity(tenantId, actorId, "deploy_credential_sealed", "integration_connection", row.id, {
    provider: row.provider, environment: parsed.credential.environment, transport: parsed.credential.transport,
  });
  return { connection, sealedVersion, environment: parsed.credential.environment, transport: parsed.credential.transport };
}

// ── 2. the filing ──────────────────────────────────────────────────────────────────────────────────

export interface DeploySecretFilingDto {
  approvalId: string;
  status: "pending";
  environment: string;
  /** The org secret's name when the ERP already knows the repository id (a grant has run), else null: the executor derives
   *  it from GitHub at write time either way. */
  secretName: string | null;
  sealedVersion: string;
}

function knownSecretName(site: { repoUrl: string | null; grantRepositoryId: number | null }, environment: string): string | null {
  const name = parseGithubRepoUrl(site.repoUrl)?.name;
  if (!name || site.grantRepositoryId === null) return null;
  try {
    return siteDeploySecretName({ slug: name, environment, repositoryId: site.grantRepositoryId });
  } catch {
    return null;
  }
}

/** File the HIGH approval to write one row's org secret from its vault record. Body: nothing, or `{reason}`. */
export async function fileDeploySecretWrite(principal: Principal, tenantId: string, webdevSiteId: string, body: unknown): Promise<DeploySecretFilingDto> {
  if (!UUID_RE.test(webdevSiteId)) return refuse("not_found", "webdev site not found");
  const id = webdevSiteId.toLowerCase();
  const facts0 = await readFacts(tenantId, id);
  if (!facts0.env || facts0.env.deleted) return refuse("not_found", "webdev site not found");
  if (facts0.site) {
    // The deploy grant's own pair (deploy-grant.service.ts#authorizeDeployGrant), in the GHT-1 order.
    await authorize(principal, { kind: "webdev_provisioned_site", tenantId, id: facts0.site.id, module: "webdev" }, "provision");
    const org = await orgTenantOf(tenantId);
    await authorize(principal, { kind: "github_repo", tenantId: org, module: "webdev" }, "push");
  } else {
    await authorize(principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "update");
  }
  const requestedBy = actorOf(principal);

  const b = body === undefined || body === null ? {} : body;
  if (typeof b !== "object" || Array.isArray(b)) return refuse("deploy_secret_body_invalid", "the body must be empty or exactly {reason}");
  const keys = Object.keys(b as Record<string, unknown>);
  const reasonIn = (b as Record<string, unknown>).reason;
  if (keys.some((k) => k !== "reason") || (reasonIn !== undefined && (typeof reasonIn !== "string" || reasonIn.trim().length === 0 || reasonIn.length > DEPLOY_SECRET_REASON_MAX))) {
    return refuse("deploy_secret_body_invalid", `the body must be empty or exactly {reason} (a string of 1 to ${DEPLOY_SECRET_REASON_MAX} characters)`);
  }

  const facts = await readFacts(tenantId, id);
  const vault = checkWriteFacts(facts);
  const env = facts.env as EnvRowFacts;
  const site = facts.site as NonNullable<WriteFacts["site"]>;

  const open = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM automation_approvals
        WHERE origin = $1 AND workflow_id = $2 AND status = 'pending' AND deleted_at IS NULL AND tool_args->>'webdevSiteId' = $3
        ORDER BY created_at LIMIT 1`,
      [DEPLOY_SECRET_ORIGIN, DEPLOY_SECRET_WORKFLOW, id],
    ),
  );
  if (open.rows[0]) return refuse("deploy_secret_request_open", `a write request for this row is already waiting (${open.rows[0].id})`, open.rows[0].id);

  const environment = env.environment as "staging" | "production";
  const secretName = knownSecretName(site, environment);
  const args: DeploySecretArgs = {
    provisionedSiteId: site.id, webdevSiteId: id, environment, connectionId: vault.id, sealedVersion: vault.sealedVersion as string,
  };
  const filed = await fileAutomationApproval({
    tenantId,
    workflowId: DEPLOY_SECRET_WORKFLOW,
    toolName: DEPLOY_SECRET_TOOL,
    // Identifiers only. `secretName` is display (the executor derives the name from GitHub, never from these args).
    toolArgs: { ...args, ...(secretName ? { secretName } : {}) },
    impact: "high",
    reason: typeof reasonIn === "string" ? reasonIn.trim() : `write the ${environment} deploy secret of ${site.slug} from its vault record (WSK-D88)`,
    origin: DEPLOY_SECRET_ORIGIN,
    requestedBy,
  });
  await writeActivity(tenantId, requestedBy, "requested", "webdev_site", id, { deploySecretWrite: filed.id, environment, connectionId: vault.id });
  return { approvalId: filed.id, status: "pending", environment, secretName, sealedVersion: args.sealedVersion };
}

// ── 3. decide(): preflight and execution ───────────────────────────────────────────────────────────

/**
 * Before the decide UPDATE (approve only): the stored args parse, the decider is not the requester, and the decider holds
 * the three gates in this file's header. A refusal is a 400/403/503 and the row stays `pending`.
 */
export async function preflightDeploySecretWrite(
  tenantId: string,
  approvalId: string,
  toolArgs: unknown,
  requestedBy: string | null,
  decider: Principal,
): Promise<void> {
  const args = parseDeploySecretArgs(toolArgs);
  if (!args) throw new BadRequestException({ message: "deploy_secret_args_invalid: this request's stored arguments are malformed", reason: "deploy_secret_args_invalid" });
  if (!decider.userId) throw new ForbiddenException({ message: "approver_unknown: an authenticated decider is required", reason: "approver_unknown" });
  if (!requestedBy || requestedBy === decider.userId || decider.actFor?.userId === requestedBy) {
    throw new ForbiddenException({
      message: "self_approval: a deploy secret write may not be approved by the user who requested it",
      reason: "self_approval",
    });
  }
  await authorize(decider, { kind: "webdev_provisioned_site", tenantId, id: args.provisionedSiteId, module: "webdev" }, "provision");
  await authorize(decider, { kind: "integration_connection", id: args.connectionId, tenantId, ownerId: "" }, "manage");
  let org: string;
  try {
    org = await orgTenantOf(tenantId);
  } catch (err) {
    if (err instanceof DeploySecretRefusal) throw new ServiceUnavailableException({ message: err.code, reason: err.detail });
    throw err;
  }
  await authorize(decider, { kind: "github_repo", tenantId: org, module: "webdev", approvalId }, "secret_write");
}

export type DeploySecretExecution =
  | { executionStatus: "executed"; result: DeploySecretWriteResult }
  | { executionStatus: "failed"; error: string; secretName: string | null }
  | { executionStatus: "not_claimed"; error: "already_decided_or_executed" };

export function toDeploySecretRefusal(err: unknown): DeploySecretRefusal | null {
  if (err instanceof DeploySecretRefusal) return err;
  const g = classifyDeployGrantError(err);
  if (!g) return null;
  const code = (g.code in { github_permission_missing: 1, github_app_not_installed: 1, github_not_configured: 1, github_org_unavailable: 1, github_rate_limited: 1, github_request_failed: 1 })
    ? (g.code as DeploySecretRefusalCode)
    : "github_request_failed";
  return new DeploySecretRefusal(code, g.detail, g.qualifier);
}

/** The real ports for one write. Exported for the DB suite, which drives them below the decide() route. */
export function deploySecretPorts(a: {
  tenantId: string;
  webdevSiteId: string;
  orgTenantId: string;
  actorId: string;
  approvalId: string;
  decider: Principal;
}): DeploySecretWriteDeps {
  return {
    loadFacts: () => readFacts(a.tenantId, a.webdevSiteId),
    resolveRepo: (site) => resolveProvisionedRepo(a.tenantId, site),
    git: erpGitCaller(a.orgTenantId, a.actorId),
    openVault: (connectionId) => withTenants([a.tenantId], (c) => readAccessToken(c, connectionId)),
    ledger: async (target, perform) =>
      (
        await withGithubLedger(
          {
            tenantId: a.orgTenantId,
            actorId: a.actorId,
            repo: `${target.repo.owner}/${target.repo.name}`,
            action: "secret_write",
            secretName: target.secretName,
            basis: DEPLOY_SECRET_WRITE_BASIS,
            approvalId: a.approvalId,
          },
          async () => ({ data: await perform() }),
        )
      ).data,
    grant: async () => {
      const facts = await readFacts(a.tenantId, a.webdevSiteId);
      if (!facts.site) return { outcome: "refused", state: null, error: "deploy_secret_no_provisioned_site" };
      const g = await followSecretWrite(a.decider, a.tenantId, facts.site.id);
      return { outcome: g.outcome, state: g.state, error: g.error };
    },
    classifyError: toDeploySecretRefusal,
  };
}

async function recordExecution(
  tenantId: string,
  approvalId: string,
  actorId: string,
  args: DeploySecretArgs | null,
  outcome: { ok: true; result: DeploySecretWriteResult } | { ok: false; error: string; secretName: string | null },
): Promise<void> {
  const result = outcome.ok
    ? {
      secretName: outcome.result.secretName, environment: outcome.result.environment, repositoryId: outcome.result.repositoryId,
      written: outcome.result.written, keyId: outcome.result.keyId, selectedRepositoryIds: outcome.result.selectedRepositoryIds,
      sealedVersion: outcome.result.sealedVersion, grant: outcome.result.grant,
    }
    : { error: outcome.error, secretName: outcome.secretName, sealedVersion: args?.sealedVersion ?? null };
  await withTenants([tenantId], async (c) => {
    await c.query(
      `UPDATE automation_approvals
          SET execution_status = $2, executed_at = now(), executed_by = $3, execution_result = $4::jsonb,
              execution_error = $5, updated_at = now()
        WHERE id = $1 AND execution_status = 'executing'`,
      [approvalId, outcome.ok ? "executed" : "failed", actorId, JSON.stringify(result), outcome.ok ? null : outcome.error.slice(0, 300)],
    );
    if (args) {
      await emitEvent(c, tenantId, "webdev_site", args.webdevSiteId, outcome.ok ? "webdev.site.deploy_secret_written" : "webdev.site.deploy_secret_write_failed", {
        approvalId, environment: args.environment, connectionId: args.connectionId, ...result,
      });
    }
  });
  if (args) {
    await writeActivity(tenantId, actorId, outcome.ok ? "deploy_secret_written" : "deploy_secret_write_failed", "webdev_site", args.webdevSiteId, {
      approvalId, connectionId: args.connectionId, environment: args.environment, secretName: outcome.ok ? outcome.result.secretName : outcome.secretName,
      ...(outcome.ok ? { written: outcome.result.written, grant: outcome.result.grant.outcome } : { error: outcome.error }),
    });
  }
}

/**
 * Execute an APPROVED write, in-band, as the decider, exactly once. Never throws: every outcome is recorded on the approval
 * (`executed` with identifiers, or `failed` with a typed token) and returned as data; the decision itself stands either way.
 */
export async function executeApprovedDeploySecretWrite(
  tenantId: string,
  approvalId: string,
  toolArgs: unknown,
  decider: Principal,
): Promise<DeploySecretExecution> {
  // Claim: the ONE transition pending -> executing (a re-presented or concurrent decide finds nothing to claim).
  const claim = await withTenants([tenantId], (c) =>
    c.query<{ requested_by: string | null; decided_by: string | null }>(
      `UPDATE automation_approvals SET execution_status = 'executing', updated_at = now()
        WHERE id = $1 AND origin = $2 AND workflow_id = $3 AND status = 'approved' AND execution_status = 'pending' AND deleted_at IS NULL
        RETURNING requested_by, decided_by`,
      [approvalId, DEPLOY_SECRET_ORIGIN, DEPLOY_SECRET_WORKFLOW],
    ),
  );
  if (!claim.rows[0]) return { executionStatus: "not_claimed", error: "already_decided_or_executed" };
  const { requested_by: requestedBy, decided_by: decidedBy } = claim.rows[0];
  const actorId = decider.userId ?? decidedBy ?? "";
  const args = parseDeploySecretArgs(toolArgs);
  const fail = async (error: string, secretName: string | null = null): Promise<DeploySecretExecution> => {
    await recordExecution(tenantId, approvalId, actorId, args, { ok: false, error, secretName });
    return { executionStatus: "failed", error, secretName };
  };
  if (!args) return fail("deploy_secret_args_invalid");
  // The second wall: the STORED decider, whatever path approved the row.
  if (!decidedBy || !requestedBy || decidedBy === requestedBy || decidedBy !== decider.userId) return fail("approver_refused: self_approval");

  try {
    const orgTenantId = await orgTenantOf(tenantId);
    // Defence in depth: the D14 rule again, as the decider, before any egress.
    await authorize(decider, { kind: "github_repo", tenantId: orgTenantId, module: "webdev", approvalId }, "secret_write");
    const result = await writeDeploySecret(
      deploySecretPorts({ tenantId, webdevSiteId: args.webdevSiteId, orgTenantId, actorId, approvalId, decider }),
      args,
    );
    await recordExecution(tenantId, approvalId, actorId, args, { ok: true, result });
    return { executionStatus: "executed", result };
  } catch (err) {
    const typed = toDeploySecretRefusal(err);
    if (typed) return fail(typed.rowToken);
    if (err instanceof ForbiddenException) return fail("forbidden");
    // Never the message: an unclassified error's text is not trusted to be value-free.
    logger.error(`deploy secret write ${approvalId} failed (${err instanceof Error ? err.name : typeof err})`);
    return fail("deploy_secret_write_failed");
  }
}

// ── 4. the console read ────────────────────────────────────────────────────────────────────────────

/**
 * Where a row's org secret stands, against its vault record:
 *   no_credential      the row has no usable vault record (`reason` is the refusal token)
 *   not_requested      the vault holds a credential and no write was ever filed
 *   awaiting_approval  a write is filed and waits for a second person
 *   pending            approved, not written: executing, or FAILED with `reason` (O-3: `github_permission_missing:
 *                      organization_secrets`); never shown as success
 *   rejected           the last request was rejected
 *   written            GitHub holds the value the vault holds now
 *   stale              GitHub holds an older value: the vault was resealed (a rotation) and the rewrite is not approved yet
 *   revoked            the site's deploy grant is revoked (archived, WSK-D82): nothing is written
 */
export type DeploySecretState = "no_credential" | "not_requested" | "awaiting_approval" | "pending" | "rejected" | "written" | "stale" | "revoked";

export interface DeploySecretStateDto {
  siteId: string;
  environment: string | null;
  secretName: string | null;
  state: DeploySecretState;
  reason: string | null;
  approvalId: string | null;
  writtenAt: string | null;
  /** The grant step's outcome after the last write, when there was one. */
  grant: { outcome: string; state: string | null; error: string | null } | null;
}

export async function readDeploySecretState(principal: Principal, tenantId: string, webdevSiteId: string): Promise<DeploySecretStateDto> {
  if (!UUID_RE.test(webdevSiteId)) return refuse("not_found", "webdev site not found");
  const id = webdevSiteId.toLowerCase();
  await authorize(principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "read");
  const facts = await readFacts(tenantId, id);
  if (!facts.env || facts.env.deleted) return refuse("not_found", "webdev site not found");
  const last = await withTenants([tenantId], (c) =>
    c.query<{ id: string; status: string; execution_status: string; execution_error: string | null; execution_result: Record<string, unknown> | null; tool_args: Record<string, unknown>; executed_at: Date | null }>(
      `SELECT id, status, execution_status, execution_error, execution_result, tool_args, executed_at FROM automation_approvals
        WHERE origin = $1 AND workflow_id = $2 AND deleted_at IS NULL AND tool_args->>'webdevSiteId' = $3
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [DEPLOY_SECRET_ORIGIN, DEPLOY_SECRET_WORKFLOW, id],
    ),
  );
  const a = last.rows[0];
  const base = {
    siteId: id,
    environment: facts.env.environment,
    secretName: (a?.execution_result?.secretName as string | undefined)
      ?? (a?.tool_args?.secretName as string | undefined)
      ?? (facts.site ? knownSecretName(facts.site, facts.env.environment) : null),
    approvalId: a?.id ?? null,
    writtenAt: null as string | null,
    grant: null as DeploySecretStateDto["grant"],
  };
  if (facts.site?.grantState === "revoked") return { ...base, state: "revoked", reason: "deploy_secret_site_revoked" };
  let currentVersion: string | null = null;
  try {
    currentVersion = checkWriteFacts(facts).sealedVersion;
  } catch (err) {
    if (!(err instanceof DeploySecretRefusal)) throw err;
    if (!a || a.execution_status !== "executed") return { ...base, state: "no_credential", reason: err.rowToken };
  }
  if (!a) return { ...base, state: "not_requested", reason: null };
  if (a.status === "pending") return { ...base, state: "awaiting_approval", reason: null };
  if (a.status === "rejected") return { ...base, state: "rejected", reason: null };
  if (a.execution_status === "executed") {
    const r = a.execution_result ?? {};
    const grant = (r.grant ?? null) as DeploySecretStateDto["grant"];
    const writtenAt = a.executed_at ? a.executed_at.toISOString() : null;
    const inSync = currentVersion !== null && r.sealedVersion === currentVersion;
    return { ...base, writtenAt, grant, state: inSync ? "written" : "stale", reason: inSync ? null : "the vault record was resealed after the last write" };
  }
  // Approved and not written: executing, or failed with its token. Never success.
  return { ...base, state: "pending", reason: a.execution_status === "failed" ? (a.execution_error ?? "deploy_secret_write_failed") : a.execution_status };
}

