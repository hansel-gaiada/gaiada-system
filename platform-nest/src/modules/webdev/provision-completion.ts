// M6-P4c — provisioning finishes webdesk-design-v2.md §08: after the repo exists, the ERP records the
// `webdev_sites` registry row, creates the site's WebDesk tenant, and pins its first contract snapshot.
// This file is the STATE MACHINE, written against ports so it runs without a database or a network
// (provision-completion.unit.test.ts). `provision-completion.service.ts` supplies the Postgres + WebDesk
// adapters; `provisioning.service.ts` still owns the repo step and is unchanged.
//
// ═══ THE STATE MACHINE (webdev_provisioned_sites.completion_state; migration 202610120425) ════════════
//
//   (repo step, provisioning.service.ts)     status: requested -> pending -> provisioned | live
//                                                     (repo_url set by the provider)
//        |
//        |  [register]  precondition: provider = 'erp_repo' AND status IN (provisioned, live)
//        |              AND repo_url IS NOT NULL
//        v              act: upsert webdev_sites ON (tenant_id, domain) — origin=provisioned,
//                            adoption=mandated, kind=FRAMEWORK_TO_KIND[framework] (WSK-D28), repo_url,
//                            project_id/client_id copied from the provisioned row (= the run's)
//   NULL ─────────────> registered          the registry write and the state change are ONE transaction
//        |
//        |  [tenant]    act: WebDesk `tenant.provision` {slug, companyRef = ERP company}, sent with the
//        v                   DETERMINISTIC Idempotency-Key `wps-tenant:<provisioned site id>`
//   registered ───────> tenant_ready        on 2xx (fresh OR replayed), or on 409 when the slug is listed
//        |                                  under THIS company (`tenant.list?companyRef`): adopt
//        |
//        |  [contract]  act: refreshContractSnapshot(slug) — succeeds only once WebDesk's async codegen
//        v                   (M6-P4r-b, queued by tenant.provision) has published latest.json
//   tenant_ready ─────> complete            contract_snapshot_id pinned; webdev_sites.contract_version set
//
// Nothing moves backwards. A step that cannot finish records a typed `completion_error` and leaves the
// state where it was; the next reconcile retries it. `failed` repo rows do not advance.
// Only ERP repo control rows (`provider = 'erp_repo'`, the §08 path) BEGIN a completion: mirror rows left by
// the decommissioned `provision` host (provider 'provision') describe sites on a dead box, and a reconcile
// must not retroactively create WebDesk tenants for them. Adopting one is a deliberate, separate act.
//
// ═══ WHY EACH STEP IS IDEMPOTENT AND CRASH-RESUMABLE ════════════════════════════════════════════════
// Every step is LOCK -> RE-READ -> (still this step?) -> ACT -> RECORD, the repo step's own discipline,
// under the SAME advisory lock (`takeProvisionLock`), so a reconcile, the poller and the decide() hook
// serialize on one site. A replay of a finished step re-reads the state, finds it already past, and does
// nothing: one registry row, one tenant request, no approval.
//   * register: the upsert and `completion_state = 'registered'` commit together. A crash before the
//     commit leaves neither; a crash after leaves both. A registry row with our placeholder domain that is
//     NOT linked is adopted only when it is `origin = 'provisioned'` and no other provisioned row claims
//     it (`ux_wps_webdev_site` is the schema backstop); anything else is `registry_domain_taken`.
//   * tenant: the far side holds the second layer. WebDesk's command envelope claims the Idempotency-Key
//     first and stores the replay record in the same transaction as the tenant row (webdesk/api
//     control/command-envelope.ts), so a crash after WebDesk committed but before we recorded
//     `tenant_ready` is resumed by resending the SAME key: WebDesk answers the stored replay and creates
//     nothing. This is what the repo step could not have (its far side took no key; its "known residual
//     window"). If the replay record is ever gone, the 409 "slug exists" is adopted only when WebDesk's
//     own company-filtered list says the tenant is ours (the repo step's "adopt only if ours" rule).
//     The request is sent while the lock is held, so even two racing reconcilers send it once.
//   * contract: `refreshContractSnapshot` is idempotent on (tenant, slug, contract_version) under its own
//     lock, so it runs OUTSIDE the site lock (it downloads artifacts; holding a pipeline-run lock across
//     that is not worth it), then the result is recorded under the lock after a re-read. Two racers both
//     get the same snapshot row; one records it.
//
// ═══ APPROVAL CLASS (read this before adding a gate) ════════════════════════════════════════════════
// WebDesk classifies `tenant.provision` as MEDIUM (webdesk/api control/command-types.ts): no WS4 for any
// principal on WebDesk's side; on the ERP side MEDIUM means "WS4 for unattended principals". Completion
// runs only for a row whose repo step reached provisioned/live, which for ERP repo control means a
// company_admin APPROVED the GH-12 request for this exact slug (HIGH, WS4) — §08 defines provisioning as
// the repo AND the registry row AND the tenant, so that one human decision covers all three (the same
// shape as WSK-D46 R3: one publish approval also authorises the staging rebuild). The completion steps
// decide nothing new: slug, company, kind and lineage all come from the approved row. So no second
// approval is filed. If WebDesk ever reclassifies `tenant.provision` as HIGH, this must change to file a
// WS4 approval and record a pending state; `provisionTenant` returning a 403 `ws4-approval-required` is
// recorded as an error, never retried around.
import type { CanonicalFramework, SiteKind } from "./provision-provider";
import { FRAMEWORK_TO_KIND } from "./provision-provider";
import type { SiteStatus } from "./provisioning.service";

export type CompletionState = "registered" | "tenant_ready" | "complete";
export type CompletionStep = "not_ready" | "register" | "tenant" | "contract" | "done";

/** The registry row needs a domain (NOT NULL, the D35 key with tenant_id), and a freshly provisioned site
 *  has none yet. It gets `<slug>.provisioned.invalid`: RFC 2606 reserves `.invalid`, so it can never
 *  resolve, never collide with a real client domain, and never be mistaken for a measurement. The real
 *  domain replaces it when the site gets one (a follow-up: there is no domain-edit path today). The slug
 *  is unique per tenant among live provisioned rows (ux_wps_slug), which makes the domain unique too. */
export const PROVISIONED_PLACEHOLDER_DOMAIN_SUFFIX = "provisioned.invalid";

export function placeholderDomainFor(slug: string): string {
  return `${slug}.${PROVISIONED_PLACEHOLDER_DOMAIN_SUFFIX}`;
}

/** WebDesk's claim-first Idempotency-Key for this site's tenant.provision. Deterministic per provisioned
 *  row (a uuid), so every resend is the same command to WebDesk. */
export function tenantIdempotencyKey(provisionedSiteId: string): string {
  return `wps-tenant:${provisionedSiteId}`;
}

export function kindForFramework(framework: CanonicalFramework): SiteKind {
  return FRAMEWORK_TO_KIND[framework];
}

/** The provider whose rows begin a completion (§08's ERP repo control; `ErpRepoControlProvider.key`). */
export const COMPLETING_PROVIDER = "erp_repo";

export interface CompletionRow {
  id: string;
  tenantId: string;
  /** `webdev_provisioned_sites.provider`. */
  provider: string;
  slug: string;
  framework: CanonicalFramework;
  status: SiteStatus;
  repoUrl: string | null;
  clientId: string | null;
  projectId: string | null;
  completionState: CompletionState | null;
  webdevSiteId: string | null;
  webdeskTenantSlug: string | null;
  contractSnapshotId: string | null;
  completionError: string | null;
}

/** THE transition function. Pure: what the next step is for this row, or that there is none. */
export function nextCompletionStep(row: Pick<CompletionRow, "provider" | "status" | "repoUrl" | "completionState">): CompletionStep {
  if (row.completionState === "complete") return "done";
  // A failed repo row never acquires anything new (the repo step's own rule for `blocked` runs).
  if (row.status === "failed") return "not_ready";
  if (row.completionState === "tenant_ready") return "contract";
  if (row.completionState === "registered") return "tenant";
  if (row.provider === COMPLETING_PROVIDER && (row.status === "provisioned" || row.status === "live") && row.repoUrl) return "register";
  return "not_ready";
}

export interface RegistryUpsertInput {
  tenantId: string;
  provisionedSiteId: string;
  domain: string;
  kind: SiteKind;
  repoUrl: string;
  clientId: string | null;
  projectId: string | null;
}

export type RegistryUpsertResult =
  | { outcome: "inserted" | "adopted"; webdevSiteId: string }
  /** The domain is held by a registry row that is not ours to adopt. */
  | { outcome: "conflict" }
  /** The database refused the row (a constraint). Typed, never a 500. */
  | { outcome: "rejected"; reason: string };

/** One transaction holding the site's provisioning lock. Writes commit only when the callback resolves. */
export interface CompletionTx {
  read(): Promise<CompletionRow | null>;
  upsertRegistry(input: RegistryUpsertInput): Promise<RegistryUpsertResult>;
  /** NULL -> registered. */
  markRegistered(webdevSiteId: string): Promise<void>;
  /** registered -> tenant_ready. */
  markTenantReady(webdeskTenantSlug: string, how: "created" | "replayed" | "adopted"): Promise<void>;
  /** tenant_ready -> complete. */
  markComplete(snapshotId: string, contractVersion: string): Promise<void>;
  recordError(token: string): Promise<void>;
}

export type TenantProvisionResult =
  /** WebDesk created the tenant now. */
  | { outcome: "created" }
  /** WebDesk answered the stored replay for this key: the tenant was created by an earlier send. */
  | { outcome: "replayed" }
  /** 409 slug-exists, and WebDesk's company-filtered list shows the tenant under THIS company. */
  | { outcome: "adopted" }
  /** 409 slug-exists, and the tenant is NOT this company's. Needs a human (a different slug). */
  | { outcome: "foreign" }
  /** Anything else: transient, ambiguous, refused or unconfigured. Recorded; resent with the SAME key. */
  | { outcome: "retry"; reason: string };

export type ContractPinResult =
  | { outcome: "pinned"; snapshotId: string; contractVersion: string }
  /** Not published yet (codegen is async), unreachable, or refused by a mirror tripwire. Retried later. */
  | { outcome: "not_yet"; reason: string };

export interface CompletionPorts {
  withLockedSite<T>(fn: (tx: CompletionTx) => Promise<T>): Promise<T>;
  provisionTenant(input: { slug: string; companyRef: string; idempotencyKey: string }): Promise<TenantProvisionResult>;
  pinContract(webdeskTenantSlug: string): Promise<ContractPinResult>;
}

export interface CompletionReport {
  /** The state after this call. `null` = not begun. */
  state: CompletionState | null;
  /** What the row needs next (`done` once complete, `not_ready` while the repo step runs). */
  next: CompletionStep;
  /** The steps this call finished, in order. */
  advanced: Array<Exclude<CompletionStep, "not_ready" | "done">>;
  /** The typed reason the next step could not finish, if it was attempted and did not. */
  error: string | null;
  notFound?: true;
}

type StepResult =
  | { kind: "advanced"; step: "register" | "tenant" | "contract" }
  | { kind: "stopped"; row: CompletionRow | null; error: string | null }
  | { kind: "contract"; slug: string };

/** One step under the lock. The contract step only DECIDES here; its fetch runs outside the lock. */
async function lockedStep(ports: CompletionPorts, companyRef: string): Promise<StepResult> {
  return ports.withLockedSite(async (tx): Promise<StepResult> => {
    const row = await tx.read();
    if (!row) return { kind: "stopped", row: null, error: null };
    const step = nextCompletionStep(row);
    switch (step) {
      case "register": {
        const res = await tx.upsertRegistry({
          tenantId: row.tenantId,
          provisionedSiteId: row.id,
          domain: placeholderDomainFor(row.slug),
          kind: kindForFramework(row.framework),
          repoUrl: row.repoUrl as string,
          clientId: row.clientId,
          projectId: row.projectId,
        });
        if (res.outcome === "conflict" || res.outcome === "rejected") {
          const error = res.outcome === "conflict" ? "registry_domain_taken" : `registry_rejected: ${res.reason}`;
          await tx.recordError(error);
          return { kind: "stopped", row, error };
        }
        await tx.markRegistered(res.webdevSiteId);
        return { kind: "advanced", step };
      }
      case "tenant": {
        const res = await ports.provisionTenant({
          slug: row.slug,
          companyRef,
          idempotencyKey: tenantIdempotencyKey(row.id),
        });
        if (res.outcome === "created" || res.outcome === "replayed" || res.outcome === "adopted") {
          await tx.markTenantReady(row.slug, res.outcome);
          return { kind: "advanced", step };
        }
        const error = res.outcome === "foreign" ? "webdesk_tenant_slug_foreign" : res.reason;
        await tx.recordError(error);
        return { kind: "stopped", row, error };
      }
      case "contract":
        return { kind: "contract", slug: row.webdeskTenantSlug as string };
      default:
        return { kind: "stopped", row, error: null };
    }
  });
}

/**
 * Advance one provisioned site as far as it can go right now, one step at a time, each step in its own
 * lock-held transaction. Safe to call any number of times, concurrently, at any state.
 * `companyRef` = the ERP company id, which WebDesk stores as the tenant's `company_ref`.
 */
export async function advanceProvisionCompletion(ports: CompletionPorts, companyRef: string): Promise<CompletionReport> {
  const advanced: CompletionReport["advanced"] = [];
  // At most three forward steps exist; the bound only guards against a port that lies about progress.
  for (let i = 0; i < 4; i++) {
    const r = await lockedStep(ports, companyRef);
    if (r.kind === "advanced") {
      advanced.push(r.step);
      continue;
    }
    if (r.kind === "stopped") {
      if (!r.row) return { state: null, next: "not_ready", advanced, error: null, notFound: true };
      return { state: r.row.completionState, next: nextCompletionStep(r.row), advanced, error: r.error };
    }
    // The contract step: fetch + verify + mirror OUTSIDE the lock (idempotent per version), then record.
    const pin = await ports.pinContract(r.slug);
    const recorded = await ports.withLockedSite(async (tx): Promise<StepResult> => {
      const row = await tx.read();
      if (!row) return { kind: "stopped", row: null, error: null };
      // RE-READ: a racer may have recorded it already. Then there is nothing left for us to do.
      if (nextCompletionStep(row) !== "contract") return { kind: "stopped", row, error: null };
      if (pin.outcome === "pinned") {
        await tx.markComplete(pin.snapshotId, pin.contractVersion);
        return { kind: "advanced", step: "contract" };
      }
      await tx.recordError(pin.reason);
      return { kind: "stopped", row, error: pin.reason };
    });
    if (recorded.kind === "advanced") {
      advanced.push("contract");
      continue;
    }
    if (recorded.kind === "stopped") {
      if (!recorded.row) return { state: null, next: "not_ready", advanced, error: null, notFound: true };
      return { state: recorded.row.completionState, next: nextCompletionStep(recorded.row), advanced, error: recorded.error };
    }
  }
  // Unreachable with honest ports (three steps, then `done` stops the loop).
  return { state: "complete", next: "done", advanced, error: null };
}
