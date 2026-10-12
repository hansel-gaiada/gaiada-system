// M6-P4c — the Postgres + WebDesk adapters for `provision-completion.ts`'s state machine (read that
// file's header first: the states, the transitions, why each step is idempotent and why no second
// approval is filed). This file only binds its ports to the real world:
//
//   withLockedSite  ONE `withTenants([tenantId], …, {modules:['webdev']})` transaction that takes the
//                   repo step's own advisory lock (`takeProvisionLock`) before anything is read. The
//                   third wall applies to both tables written here (webdev_provisioned_sites and
//                   webdev_sites): an undeclared module scope would match ZERO rows, silently.
//   provisionTenant `webdeskZoneB.write` (webdesk-content.service.ts): the one control channel, its
//                   typed errors, and the two `activities` rows (attempted, then the outcome) around the
//                   send. WebDesk `tenant.provision` is MEDIUM (no WS4), sent with a deterministic key.
//   pinContract     `refreshContractSnapshot` (webdev-contracts): fetch, hash-verify, mirror, idempotent
//                   per (tenant, slug, contract_version).
//
// WHERE IT RUNS (every path calls the same `advanceProvisionCompletion`; none of them is the only one):
//   1. `completeAfterRepoApproval` — decide() of the GH-12 repo request (automation-approvals.controller),
//      right after the repo is created, detached so the decider's response never waits on WebDesk;
//   2. `reconcileAndComplete` — POST …/provisioned-sites/:id/reconcile (staff and the hourly
//      wd-provision-reconcile flow): THE resume path after any crash;
//   3. the provision route's detached poller, once the poll reaches provisioned/live.
//
// AUTHORISATION. The completion decides nothing: slug, company, kind and lineage come from the approved
// provisioned row (see the state machine's "APPROVAL CLASS"). Each entry point is itself gated
// (decide() by the generic `decide` gate + GH-12's create_repo rule; reconcile by
// `webdev_provisioned_site · reconcile`), exactly as the repo step's own resume arm is.
import { ForbiddenException, HttpException, Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import type { Principal } from "../../rbac/principal";
import { createWebdevControlHttpDriver } from "../webdev-contracts/contract-fetch-http";
import { ContractControlNotConfiguredError, WebdevControlEgressError, type WebdevControlProvider } from "../webdev-contracts/contract-fetch-provider";
import { refreshContractSnapshot } from "../webdev-contracts/contract-snapshot.service";
import { createErpRepoControlProvider } from "./erp-repo-control-provider";
import type { CanonicalFramework, ProvisionProvider } from "./provision-provider";
import {
  advanceProvisionCompletion,
  nextCompletionStep,
  type CompletionPorts,
  type CompletionReport,
  type CompletionRow,
  type CompletionState,
  type CompletionStep,
  type CompletionTx,
  type ContractPinResult,
  type RegistryUpsertInput,
  type RegistryUpsertResult,
  type TenantProvisionResult,
} from "./provision-completion";
import { reconcileProvisionedSite, takeProvisionLock, type ReconcileOutcome, type SiteStatus } from "./provisioning.service";
import { AmbiguousWriteError, WebdeskProblem, isPlainObject, problemSlug, webdeskZoneB } from "./webdesk-content.service";

const logger = new Logger("ProvisionCompletion");

// ── test seam ────────────────────────────────────────────────────────────────────────────────────
let contractProviderOverride: WebdevControlProvider | null = null;

/** Tests only: the contract mirror's provider (a fixture WebDesk). The WebDesk control client is
 *  injected through `setWebdeskApprovedCommandDepsForTests`, which `webdeskZoneB` already honours. */
export function setProvisionCompletionDepsForTests(deps: { contractProvider?: WebdevControlProvider | null } | null): void {
  contractProviderOverride = deps?.contractProvider ?? null;
}

// ── the row ──────────────────────────────────────────────────────────────────────────────────────

interface CompletionDbRow {
  id: string;
  tenant_id: string;
  provider: string;
  slug: string;
  framework: CanonicalFramework;
  status: SiteStatus;
  repo_url: string | null;
  client_id: string | null;
  project_id: string | null;
  completion_state: CompletionState | null;
  webdev_site_id: string | null;
  webdesk_tenant_slug: string | null;
  contract_snapshot_id: string | null;
  completion_error: string | null;
  completion_updated_at: Date | string | null;
}

const COMPLETION_COLUMNS = `id, tenant_id, provider, slug, framework, status, repo_url, client_id, project_id,
  completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_error, completion_updated_at`;

function toRow(r: CompletionDbRow): CompletionRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    slug: r.slug,
    framework: r.framework,
    status: r.status,
    repoUrl: r.repo_url,
    clientId: r.client_id,
    projectId: r.project_id,
    completionState: r.completion_state,
    webdevSiteId: r.webdev_site_id,
    webdeskTenantSlug: r.webdesk_tenant_slug,
    contractSnapshotId: r.contract_snapshot_id,
    completionError: r.completion_error,
  };
}

/** What the routes return beside the site (`completion`). An explicit field list, like `toSiteDto`. */
export interface ProvisionCompletionDto {
  state: CompletionState | null;
  next: CompletionStep;
  webdevSiteId: string | null;
  webdeskTenantSlug: string | null;
  contractSnapshotId: string | null;
  error: string | null;
  updatedAt: string | null;
}

function toDto(r: CompletionDbRow): ProvisionCompletionDto {
  const row = toRow(r);
  const at = r.completion_updated_at;
  return {
    state: row.completionState,
    next: nextCompletionStep(row),
    webdevSiteId: row.webdevSiteId,
    webdeskTenantSlug: row.webdeskTenantSlug,
    contractSnapshotId: row.contractSnapshotId,
    error: row.completionError,
    updatedAt: at === null ? null : at instanceof Date ? at.toISOString() : String(at),
  };
}

export async function readProvisionCompletion(tenantId: string, siteId: string): Promise<ProvisionCompletionDto | null> {
  const r = await withTenants(
    [tenantId],
    (c) => c.query<CompletionDbRow>(`SELECT ${COMPLETION_COLUMNS} FROM webdev_provisioned_sites WHERE id = $1`, [siteId]),
    { modules: ["webdev"] },
  );
  return r.rows[0] ? toDto(r.rows[0]) : null;
}

// ── the transaction port ─────────────────────────────────────────────────────────────────────────

const pgCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined;

/** Constraint violations a registry INSERT can hit (unique on another index, check, FK, not-null). */
const REGISTRY_CONSTRAINT_CODES = new Set(["23505", "23514", "23503", "23502"]);

function txFor(c: PoolClient, tenantId: string, siteId: string): CompletionTx {
  const event = (type: string, payload: Record<string, unknown>) =>
    emitEvent(c, tenantId, "webdev_provisioned_site", siteId, type, payload);
  const advance = async (sql: string, params: unknown[], what: string): Promise<Record<string, unknown>> => {
    const r = await c.query(sql, params);
    // Under the lock, after a re-read that chose this step, the guarded UPDATE must match. If it does
    // not, something moved the row outside the lock: fail loudly and roll the step back.
    if (r.rowCount !== 1) throw new Error(`provision completion: ${what} matched ${r.rowCount} rows`);
    return r.rows[0] ?? {};
  };

  return {
    async read() {
      const r = await c.query<CompletionDbRow>(`SELECT ${COMPLETION_COLUMNS} FROM webdev_provisioned_sites WHERE id = $1`, [siteId]);
      return r.rows[0] ? toRow(r.rows[0]) : null;
    },

    async upsertRegistry(input: RegistryUpsertInput): Promise<RegistryUpsertResult> {
      const id = newId();
      // A SAVEPOINT, so a constraint refusal is answered as data and the transaction can still record it.
      await c.query("SAVEPOINT wps_registry");
      let inserted: string | null = null;
      try {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO webdev_sites
             (id, tenant_id, domain, environment, project_id, client_id, kind, repo_url, adoption, origin, notes, origin_site)
           VALUES ($1, $2, $3, 'staging', $4, $5, $6, $7, 'mandated', 'provisioned', $8, $9)
           ON CONFLICT (tenant_id, domain) WHERE deleted_at IS NULL DO NOTHING
           RETURNING id`,
          [
            id, input.tenantId, input.domain, input.projectId, input.clientId, input.kind, input.repoUrl,
            `Provisioned by ERP repo control (webdev_provisioned_sites ${input.provisionedSiteId}). `
              + "The domain is a placeholder until the site gets its real one.",
            config.originSite,
          ],
        );
        inserted = ins.rows[0]?.id ?? null;
        await c.query("RELEASE SAVEPOINT wps_registry");
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT wps_registry");
        const code = pgCode(err);
        if (code && REGISTRY_CONSTRAINT_CODES.has(code)) return { outcome: "rejected", reason: `pg_${code}` };
        throw err;
      }
      if (inserted) {
        await emitEvent(c, tenantId, "webdev_site", inserted, "webdev.site.created", {
          domain: input.domain, environment: "staging", origin: "provisioned", provisionedSiteId: input.provisionedSiteId,
        });
        return { outcome: "inserted", webdevSiteId: inserted };
      }
      // The domain is already registered. Adopt ONLY a row that provisioning made (origin) and that no
      // other provisioned row claims (ux_wps_webdev_site is the schema half of the same rule).
      const existing = await c.query<{ id: string; origin: string }>(
        `SELECT id, origin FROM webdev_sites WHERE tenant_id = $1 AND domain = $2 AND deleted_at IS NULL`,
        [input.tenantId, input.domain],
      );
      const row = existing.rows[0];
      if (!row || row.origin !== "provisioned") return { outcome: "conflict" };
      const claimed = await c.query(
        `SELECT 1 FROM webdev_provisioned_sites WHERE webdev_site_id = $1 AND id <> $2 LIMIT 1`,
        [row.id, input.provisionedSiteId],
      );
      if ((claimed.rowCount ?? 0) > 0) return { outcome: "conflict" };
      return { outcome: "adopted", webdevSiteId: row.id };
    },

    async markRegistered(webdevSiteId: string) {
      await advance(
        `UPDATE webdev_provisioned_sites
            SET completion_state = 'registered', webdev_site_id = $2, completion_error = NULL,
                completion_updated_at = now(), updated_at = now()
          WHERE id = $1 AND completion_state IS NULL`,
        [siteId, webdevSiteId],
        "registered",
      );
      await event("webdev.site.provision_registered", { webdevSiteId });
    },

    async markTenantReady(webdeskTenantSlug: string, how: "created" | "replayed" | "adopted") {
      await advance(
        `UPDATE webdev_provisioned_sites
            SET completion_state = 'tenant_ready', webdesk_tenant_slug = $2, completion_error = NULL,
                completion_updated_at = now(), updated_at = now()
          WHERE id = $1 AND completion_state = 'registered'`,
        [siteId, webdeskTenantSlug],
        "tenant_ready",
      );
      await event("webdev.site.webdesk_tenant_ready", { webdeskTenantSlug, how });
    },

    async markComplete(snapshotId: string, contractVersion: string) {
      const updated = await advance(
        `UPDATE webdev_provisioned_sites
            SET completion_state = 'complete', contract_snapshot_id = $2, completion_error = NULL,
                completion_updated_at = now(), updated_at = now()
          WHERE id = $1 AND completion_state = 'tenant_ready'
          RETURNING webdev_site_id`,
        [siteId, snapshotId],
        "complete",
      );
      // The registry row carries the pinned contract version (§04's Delivery group).
      await c.query(
        `UPDATE webdev_sites SET contract_version = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [updated.webdev_site_id, contractVersion],
      );
      await event("webdev.site.contract_pinned", { snapshotId, contractVersion });
    },

    async recordError(token: string) {
      await c.query(
        `UPDATE webdev_provisioned_sites SET completion_error = $2, completion_updated_at = now() WHERE id = $1`,
        [siteId, token.slice(0, 300)],
      );
    },
  };
}

// ── the WebDesk port ─────────────────────────────────────────────────────────────────────────────

/** A typed token for a tenant.provision that did not land. Never a response body. */
function tenantErrorToken(err: unknown): string {
  if (err instanceof WebdeskProblem) return `webdesk_refused: ${err.getStatus()} ${problemSlug(err.problem) ?? "unknown"}`;
  if (err instanceof AmbiguousWriteError) return "webdesk_ambiguous";
  if (err instanceof ForbiddenException) return "actor_required";
  if (err instanceof HttpException) {
    const r = err.getResponse() as { message?: unknown; reason?: unknown };
    const m = typeof r?.message === "string" ? r.message : `http_${err.getStatus()}`;
    return typeof r?.reason === "string" && r.reason !== m ? `${m}: ${r.reason}` : m;
  }
  return `webdesk_error: ${(err as Error)?.name ?? "unknown"}`;
}

async function provisionTenantOverControl(
  principal: Principal,
  tenantId: string,
  siteId: string,
  input: { slug: string; companyRef: string; idempotencyKey: string },
): Promise<TenantProvisionResult> {
  try {
    const r = await webdeskZoneB.write(principal, tenantId, {
      command: "tenant.provision",
      verb: "webdesk.tenant.provision",
      method: "POST",
      path: "/control/v1/tenants",
      params: {},
      body: { slug: input.slug, companyRef: input.companyRef },
      idempotencyKey: input.idempotencyKey,
      entity: { type: "webdev_provisioned_site", id: siteId },
      ledger: { slug: input.slug, provisionedSiteId: siteId },
    });
    return isPlainObject(r.body) && r.body.replayed === true ? { outcome: "replayed" } : { outcome: "created" };
  } catch (err) {
    if (err instanceof WebdeskProblem && err.getStatus() === 409) {
      // The slug exists. Ours only if WebDesk's OWN company-filtered list says so (never the 409 body).
      let listed: boolean;
      try {
        const tenants = await webdeskZoneB.tenantsOf(tenantId, { fresh: true });
        listed = tenants.some((t) => t.slug === input.slug);
      } catch (listErr) {
        return { outcome: "retry", reason: `webdesk_tenant_list_unavailable: ${tenantErrorToken(listErr)}` };
      }
      if (listed) return { outcome: "adopted" };
      const slug = problemSlug(err.problem) ?? "";
      // An idempotency-layer 409 (a claim still in flight, a key reuse) is not a foreign tenant.
      if (/idempotency|in-progress|in_flight/i.test(slug)) return { outcome: "retry", reason: tenantErrorToken(err) };
      return { outcome: "foreign" };
    }
    return { outcome: "retry", reason: tenantErrorToken(err) };
  } finally {
    // A provisioned tenant changes the company's tenant list; the wall must not serve a stale one.
    webdeskZoneB.clearSiteCache(tenantId);
  }
}

// ── the contract port ────────────────────────────────────────────────────────────────────────────

async function pinContractSnapshot(tenantId: string, fetchedBy: string | null, slug: string): Promise<ContractPinResult> {
  let provider: WebdevControlProvider;
  try {
    provider = contractProviderOverride ?? createWebdevControlHttpDriver();
  } catch (err) {
    if (err instanceof ContractControlNotConfiguredError) return { outcome: "not_yet", reason: "contract_channel_not_configured" };
    throw err;
  }
  try {
    const r = await refreshContractSnapshot({ tenantId, slug, fetchedBy, provider });
    if (r.outcome === "created" || r.outcome === "idempotent") {
      return { outcome: "pinned", snapshotId: r.snapshot.id, contractVersion: r.snapshot.contractVersion };
    }
    switch (r.outcome) {
      case "hash_mismatch":
        return { outcome: "not_yet", reason: "contract_hash_mismatch" };
      case "block_library_hash_mismatch":
        return { outcome: "not_yet", reason: "contract_block_library_hash_mismatch" };
      case "determinism_breach":
        return { outcome: "not_yet", reason: "contract_determinism_breach" };
      default: {
        const never: never = r;
        throw new Error(`unhandled refresh outcome: ${JSON.stringify(never)}`);
      }
    }
  } catch (err) {
    if (err instanceof WebdevControlEgressError) {
      // Codegen is async (M6-P4r-b): until latest.json exists WebDesk answers 404. The message is
      // matched, never stored (it can quote a response).
      return { outcome: "not_yet", reason: /returned 404/.test(err.message) ? "contract_not_published" : "contract_unreachable" };
    }
    throw err;
  }
}

// ── composition ──────────────────────────────────────────────────────────────────────────────────

export function provisionCompletionPorts(tenantId: string, siteId: string, principal: Principal): CompletionPorts {
  return {
    withLockedSite: <T>(fn: (tx: CompletionTx) => Promise<T>) =>
      withTenants<T>(
        [tenantId],
        async (c) => {
          // Pre-lock read supplies the lock key only; pipeline_run_id and slug are immutable on this row
          // (the same argument reconcileProvisionedSite makes). Everything is RE-READ inside `fn`.
          const pre = await c.query<{ pipeline_run_id: string | null; slug: string }>(
            `SELECT pipeline_run_id, slug FROM webdev_provisioned_sites WHERE id = $1`,
            [siteId],
          );
          if (pre.rows[0]) await takeProvisionLock(c, pre.rows[0].pipeline_run_id, pre.rows[0].slug);
          return fn(txFor(c, tenantId, siteId));
        },
        { modules: ["webdev"] },
      ),
    provisionTenant: (input) => provisionTenantOverControl(principal, tenantId, siteId, input),
    pinContract: (slug) => pinContractSnapshot(tenantId, principal.userId ?? null, slug),
  };
}

/** Advance one provisioned site's completion. Throws only on an unexpected (database) failure. */
export function completeProvisionedSite(tenantId: string, siteId: string, principal: Principal): Promise<CompletionReport> {
  return advanceProvisionCompletion(provisionCompletionPorts(tenantId, siteId, principal), tenantId);
}

/** Never throws: an entry point's own outcome (a reconcile, a decide) must not be lost to a completion fault. */
async function completeSafely(tenantId: string, siteId: string, principal: Principal): Promise<CompletionReport> {
  try {
    return await completeProvisionedSite(tenantId, siteId, principal);
  } catch (err) {
    logger.error(`provisioned site ${siteId}: completion failed unexpectedly (${(err as Error)?.name ?? "error"}: ${(err as Error)?.message ?? ""})`);
    return { state: null, next: "not_ready", advanced: [], error: "completion_failed" };
  }
}

function siteOf(outcome: ReconcileOutcome): { id: string } | null {
  return "site" in outcome && outcome.site ? outcome.site : null;
}

/**
 * The reconcile route's whole job: the repo step's reconcile (unchanged), then the completion. THE
 * resume path: whatever crashed, between whichever two steps, the next call here picks it up.
 */
export async function reconcileAndComplete(args: {
  tenantId: string;
  siteId: string;
  provider: ProvisionProvider;
  requestedByName: string;
  principal: Principal;
}): Promise<{ outcome: ReconcileOutcome; completion: CompletionReport | null }> {
  const outcome = await reconcileProvisionedSite(args);
  const site = siteOf(outcome);
  const completion = site ? await completeSafely(args.tenantId, site.id, args.principal) : null;
  return { outcome, completion };
}

/** The poller's tail: once a detached poll ends, finish what can be finished. Never throws. */
export async function completeAfterPoll(tenantId: string, siteId: string, principal: Principal): Promise<CompletionReport> {
  return completeSafely(tenantId, siteId, principal);
}

/**
 * decide()'s hook (automation-approvals.controller.ts), called right after GH-12 created the repo for
 * approval `approvalId`. Finds the provisioned row that filed it (provider `erp_repo`, `provider_ref` =
 * the approval id), reconciles it (GitHub is asked for the new repo) and completes it. NEVER throws and
 * never blocks the decision: if anything is not ready (GitHub's eventual consistency, WebDesk's async
 * codegen), the next reconcile finishes it.
 */
export async function completeAfterRepoApproval(tenantId: string, approvalId: string, decider: Principal): Promise<void> {
  try {
    const found = await withTenants(
      [tenantId],
      (c) =>
        c.query<{ id: string }>(
          `SELECT id FROM webdev_provisioned_sites WHERE provider = 'erp_repo' AND provider_ref = $1 LIMIT 1`,
          [approvalId],
        ),
      { modules: ["webdev"] },
    );
    const siteId = found.rows[0]?.id;
    if (!siteId) return; // a GH-12 request filed by the Repositories tab, not by provisioning
    const provider = createErpRepoControlProvider(tenantId, decider.userId ?? null);
    // `requestedByName` is used only by the repo step's resume arm (a row that never filed its request),
    // which cannot apply here: this row's provider_ref IS the approval just decided.
    await reconcileAndComplete({ tenantId, siteId, provider, requestedByName: "Web Dev provisioning", principal: decider });
  } catch (err) {
    logger.warn(`approval ${approvalId}: provisioning completion deferred to reconcile (${(err as Error)?.name ?? "error"})`);
  }
}
