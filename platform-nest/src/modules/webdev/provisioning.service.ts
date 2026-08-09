// PRV-02 — the provisioning core: idempotency, adoption, polling, reconciliation.
//
// Design: docs/blueprints/provision-erp-seam-design.md §04 (contract, idempotency, the 409 rule,
// failure/retry) over the schema in §05 as landed by `migrations/0090_webdev_provisioned_sites.sql`.
//
// ═══ WHAT GOES WRONG IF THIS FILE IS WRONG ═══════════════════════════════════════════════════════
// A wrong call here does not corrupt a row — it creates PUBLIC INFRASTRUCTURE. `provision` turns one
// accepted request into a real GitHub repo under `Gaia-Digital-Agency`, a `/var/www/<slug>` directory
// on gda-s01, an nginx vhost, and a Let's Encrypt certificate. Two calls make two of those. And
// because `provision`'s project namespace is GLOBAL AND UNTENANTED, a careless "the name already
// exists, so this must be a retry" adopts ANOTHER CLIENT'S SITE into this tenant's mirror table —
// a tenancy breach invented by convenience code, not by a missing policy.
//
// ═══ THE IDEMPOTENCY ARGUMENT (read this before changing the order of anything) ═══════════════════
// LOCK -> RE-READ -> SERVER-SIDE PRECONDITION RE-CHECK -> ACT, all inside ONE `withTenants`
// transaction. Each word is load-bearing:
//
//  * LOCK. `pg_advisory_xact_lock` is xact-scoped, so it exists only inside a real transaction.
//    `withTenants` wraps its callback in BEGIN/COMMIT; taken on an autocommit connection
//    (`withGlobal`, or a bare pool query) the same call acquires and releases within one statement —
//    a SILENT NO-OP that reads exactly like a working lock. See `core/pipeline-lock.ts`'s header.
//
//  * RE-READ + PRECONDITION RE-CHECK. THE RE-CHECK IS THE FIX; THE LOCK IS ONLY THE ENABLING HALF.
//    This estate proved that empirically on WD-29: adding the lock alone left the duplicates in
//    place, because both racers were acting on a decision computed from a snapshot read OUTSIDE the
//    lock. The loser must re-derive its justification under the lock and discover it has been
//    consumed. `reconcile()` below is where this is not merely stylistic: its action is an UPDATE of
//    an EXISTING row, so `ux_wps_run`/`ux_wps_slug` cannot save it — a second racer with a stale
//    snapshot performs a second EGRESS and provision creates a second repo. The concurrency test
//    mutation-probes exactly that: delete the re-read and it goes red with two provision hits.
//
//  * ACT — INCLUDING THE EGRESS — INSIDE THE TRANSACTION, LOCK STILL HELD. This deliberately holds a
//    pool connection across an HTTPS call (bounded by `timeoutMs * retryAttempts`). The cheaper
//    shape — commit the claim row, then egress outside the lock — is WRONG for the resume path: the
//    claim row's partial-unique only refuses a second INSERT, and the resume path does not INSERT.
//    Two reconcilers would each pass their re-check against a committed `requested` row and each
//    POST. Correctness beats connection hygiene when the failure mode is a second public vhost.
//
//  * The SCHEMA HALF (`ux_wps_run`, `ux_wps_slug`, `ux_wps_provider_ref` in 0090) is the structural
//    backstop for the INSERT path, not a substitute for any of the above. A 23505 from it is
//    translated into an honest 409 rather than a 500 — but it is the second line, not the first.
//
// ═══ THE 409 RULE: ADOPT ONLY IF OURS ═══════════════════════════════════════════════════════════
// On a 409 the service reads the far side's record for that NAME and then asks ONE question, of its
// OWN table, inside `withTenants([tenantId], {modules:['webdev']})`:
//
//     does ANY row in THIS tenant already carry this `provider_ref`?
//
// Yes -> it is a project we created (a crashed or timed-out earlier attempt) -> ADOPT: bind the
// current row to that `provider_ref` and take the far side's status/URLs.
// No  -> the name belongs to somebody else -> REFUSE: `failed / slug_conflict_foreign`, notify, and
// let a human pick a different slug. NEVER auto-adopt.
//
// Two details that make the question safe rather than merely plausible:
//  (a) It is asked WITHOUT a status filter. Ownership is a HISTORICAL fact, not a live-state fact:
//      the canonical ours-case is a row already marked `failed/poll_timeout` that nonetheless
//      recorded a `provider_ref` before it failed. Filtering `status <> 'failed'` here would refuse
//      to adopt our own project on precisely the retry the rule exists to serve.
//  (b) The far side's opinion is IGNORED. Nothing in the 409 body — no `isOurs`, no `devName`, no
//      owner field — participates. `provision` has no tenancy, so it cannot answer the question, and
//      a compromised or merely sloppy far side that volunteers "yes, yours" must not be able to walk
//      another client's site into this table. RLS is what makes "ours" mean "this tenant's": the
//      lookup runs inside the tenant-scoped, module-scoped transaction, so another ERP tenant's row
//      is invisible to it and can never certify ownership either.
//
// KNOWN RESIDUAL WINDOW (reported, not silently papered over): if the process dies AFTER provision
// created the project and BEFORE we recorded `provider_ref`, we hold no evidence of ownership and
// the next attempt refuses our OWN project as foreign. That is the safe direction and matches the
// design's stated fallback (staff notified, manual slug override). Closing it needs an ERP-supplied
// idempotency key echoed by provision — a provision-side change (PRV-08/09), not something this side
// can invent. See the report accompanying this ticket.
//
// ═══ CREDENTIALS ════════════════════════════════════════════════════════════════════════════════
// Nothing here reads, stores, logs, or returns a credential. The provision service password lives in
// `config.provision` and is touched only by `provision-http.ts`; the GitHub PAT and the fleet deploy
// SSH key live on gda-s01 and never enter Zone A at all (design D-P4). `toSiteDto` below is the ONLY
// serializer, and it is an explicit column list precisely so a future column cannot leak by default.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { notify } from "../../core/http";
import { lockPipelineRun } from "../../core/pipeline-lock";
import { deriveRunSlug, isValidProvisionSlug } from "./slug";
import {
  ProvisionEgressError, type ProvisionProject, type ProvisionProvider,
} from "./provision-provider";

/** Advisory-lock namespace for OFF-PIPELINE provisioning (no `pipeline_run_id` to key on). 'WP'+1,
 *  distinct from `PIPELINE_RUN_LOCK_NS` and from the search module's spaces so a slug hash can never
 *  collide with a run-id hash in the shared lock space.
 *
 *  Exactly ONE lock is taken per transaction — the run lock when there is a run, this one otherwise.
 *  Never both: two locks would introduce an ordering, and an ordering introduces deadlock. The
 *  cross-run slug collision that the second lock would have covered is instead handled structurally
 *  by `ux_wps_slug`, whose 23505 this file translates into a 409 `slug_taken`. */
export const WEBDEV_PROVISION_LOCK_NS = 0x57500001;

export type SiteStatus = "requested" | "pending" | "provisioned" | "live" | "failed";

/** The API/DTO shape of one mirror row. An EXPLICIT column list, never `SELECT *` mapped wholesale —
 *  the mirror table is adjacent to a credentialed integration, and "serialize whatever the row has"
 *  is how a future column becomes an accidental disclosure. */
export interface SiteDto {
  id: string;
  tenantId: string;
  pipelineRunId: string | null;
  provider: string;
  providerRef: string | null;
  slug: string;
  framework: "vite" | "nextjs";
  repoUrl: string | null;
  stagingUrl: string | null;
  status: SiteStatus;
  failureReason: string | null;
  requestedBy: string | null;
  approvalId: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SiteRow {
  id: string;
  tenant_id: string;
  pipeline_run_id: string | null;
  provider: string;
  provider_ref: string | null;
  slug: string;
  framework: "vite" | "nextjs";
  repo_url: string | null;
  staging_url: string | null;
  status: SiteStatus;
  failure_reason: string | null;
  requested_by: string | null;
  approval_id: string | null;
  last_reconciled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

export function toSiteDto(r: SiteRow): SiteDto {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    pipelineRunId: r.pipeline_run_id,
    provider: r.provider,
    providerRef: r.provider_ref,
    slug: r.slug,
    framework: r.framework,
    repoUrl: r.repo_url,
    stagingUrl: r.staging_url,
    status: r.status,
    failureReason: r.failure_reason,
    requestedBy: r.requested_by,
    approvalId: r.approval_id,
    lastReconciledAt: iso(r.last_reconciled_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

const SITE_COLUMNS = `id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework,
  repo_url, staging_url, status, failure_reason, requested_by, approval_id, last_reconciled_at,
  created_at, updated_at`;

// ── Framework / stack vocabulary (design D-P7) ───────────────────────────────────────────────────
export const SUPPORTED_FRAMEWORKS = new Set(["vite", "nextjs"]);
/** Stack tokens this seam can actually deliver. `provision` creates STATIC EXPORTS ONLY — no
 *  per-project database, no runtime, no port (`docs/architecture.md:46-48` in the provision repo).
 *  Its own PRD vocabulary nonetheless has a stack "B = WordPress+MySQL" and a stack "C = full stack"
 *  that its provisioner cannot express.
 *
 *  D-P7: those are REFUSED WITH ROUTING, never downgraded. Shipping a static brochure site against a
 *  WordPress PRD is a client-facing lie, and the refusal is the demand signal for webdesk P6. */
const STATIC_STACKS = new Set(["a", "static", "vite", "nextjs", "next", "astro"]);

export type PreconditionReason =
  | "run_not_found"
  | "run_blocked"
  | "prd_gate_not_decided";

export type PreconditionResult =
  | { ok: true; runTitle: string | null; runOwnerId: string | null }
  | { ok: false; reason: PreconditionReason };

/**
 * The §04 precondition, evaluated SERVER-SIDE and UNDER THE CALLER'S LOCK.
 *
 * Registered verbatim as the D14 executable-registry precondition (PRV-03) so approve-execute
 * re-derives it at EXECUTION time rather than trusting the state that existed when the approval was
 * filed — an approval can sit for days, and "the run was fine when a human clicked approve" is not
 * the same claim as "the run is fine now".
 *
 * `requireSignedPrdGate` splits the two trigger paths deliberately (design §04's two triggers):
 *  - AUTOMATION path (true): the whole reason the automation may propose at all is that a `prd_sign`
 *    gate landed `approved`/`signed`. Re-checking it closes the window where the gate was reopened,
 *    reversed, or the run rewound between proposal and execution.
 *  - STAFF path (false): a human clicking "Provision" on the run workspace IS the decision, gated by
 *    Cerbos, and the design explicitly extends that path to manual runs and mini-runs — which may
 *    legitimately have no `prd_sign` gate at all. Hard-requiring the gate there would break the
 *    stated use case, not tighten it.
 * NOTE this is a REPORTED design ambiguity: §04 states the predicate once, in the D14 registry
 * context, and does not say whether the staff endpoint inherits it. This split is the reading that
 * keeps both documented triggers working; flip `requireSignedPrdGate` to true unconditionally if the
 * owner decides otherwise (OQ-P1's neighbourhood — one argument, no redesign).
 *
 * The "no existing non-failed row for this run" arm is NOT here: it is evaluated by the caller
 * because its answer is not a boolean but a ROW (the loser of a race must be handed the existing
 * site, not an error).
 */
export async function evaluateProvisionPrecondition(
  c: PoolClient,
  runId: string,
  opts: { requireSignedPrdGate: boolean },
): Promise<PreconditionResult> {
  const run = await c.query<{ status: string; title: string | null; created_by: string | null }>(
    `SELECT status, title, created_by FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`,
    [runId],
  );
  if (!run.rows[0]) return { ok: false, reason: "run_not_found" };
  // WD-05: a run parked `blocked` (revise budget exhausted) must not acquire new infrastructure.
  if (run.rows[0].status === "blocked") return { ok: false, reason: "run_blocked" };

  if (opts.requireSignedPrdGate) {
    const gate = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pipeline_gates
        WHERE run_id = $1 AND kind = 'prd_sign' AND status = 'decided'
          AND decision IN ('approved', 'signed') AND deleted_at IS NULL`,
      [runId],
    );
    if (Number(gate.rows[0]?.n ?? "0") === 0) return { ok: false, reason: "prd_gate_not_decided" };
  }
  return { ok: true, runTitle: run.rows[0].title, runOwnerId: run.rows[0].created_by };
}

export type ProvisionOutcome =
  /** A new mirror row was created and egress succeeded (201). */
  | { outcome: "created"; site: SiteDto }
  /** Idempotent re-call, or the loser of a race: the EXISTING non-failed row, no second egress (200). */
  | { outcome: "existing"; site: SiteDto }
  /** Adopted a far-side project we could PROVE is ours (200) — see the 409 rule in the header. */
  | { outcome: "adopted"; site: SiteDto }
  /** The name belongs to a site that is not ours. Row recorded as `failed/slug_conflict_foreign` (409). */
  | { outcome: "conflict_foreign"; site: SiteDto }
  /** Another non-failed row in this tenant already holds this slug (409) — `ux_wps_slug`. */
  | { outcome: "slug_taken" }
  /** provision refused the input or our credential. Row recorded as `failed/provider_rejected` (502). */
  | { outcome: "provider_rejected"; site: SiteDto; reason: string }
  /** The hop itself failed. Row recorded as `failed/egress_error` (502). */
  | { outcome: "egress_error"; site: SiteDto; reason: string }
  | { outcome: "precondition_failed"; reason: PreconditionReason }
  | { outcome: "invalid"; reason: "invalid_slug" | "unsupported_stack" | "unsupported_framework" };

export interface ProvisionSiteArgs {
  tenantId: string;
  provider: ProvisionProvider;
  /** Null for an off-pipeline site (schema allows it; the lock keys on the slug instead). */
  runId: string | null;
  framework?: string;
  slug?: string;
  /** Optional PRD stack hint. Anything non-static is refused with routing (D-P7). */
  stack?: string;
  requestedBy: string | null;
  /** Display name written into provision's `devName` for attribution IN PROVISION'S OWN UI. Never an
   *  ERP id — provision stores no ERP identifiers (design §04). */
  requestedByName: string;
  /** `automation_approvals.id` when the WS4/D14 path drove this. Attribution only, never authz. */
  approvalId?: string | null;
  /** True on the automation path (D14 executes the approved call) — see
   *  `evaluateProvisionPrecondition`. */
  requireSignedPrdGate?: boolean;
}

async function readSite(c: PoolClient, id: string): Promise<SiteRow | null> {
  const r = await c.query<SiteRow>(
    `SELECT ${SITE_COLUMNS} FROM webdev_provisioned_sites WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** The "no existing live attempt for this run" arm of the precondition, as a ROW. Mirrors
 *  `ux_wps_run`'s predicate exactly (`pipeline_run_id IS NOT NULL AND status <> 'failed'`) so the
 *  code half and the schema half can never disagree about what "already attempted" means. */
async function existingLiveSiteForRun(c: PoolClient, runId: string): Promise<SiteRow | null> {
  const r = await c.query<SiteRow>(
    `SELECT ${SITE_COLUMNS} FROM webdev_provisioned_sites
      WHERE pipeline_run_id = $1 AND status <> 'failed'
      LIMIT 1`,
    [runId],
  );
  return r.rows[0] ?? null;
}

/** THE OWNERSHIP TEST. See the header's "adopt only if ours".
 *
 *  Deliberately unfiltered by status (a) and deliberately asked of OUR table, not the far side (b).
 *  Runs inside the caller's tenant-scoped + module-scoped transaction, so RLS is what bounds "ours"
 *  to this tenant. */
async function providerRefIsOurs(c: PoolClient, providerRef: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM webdev_provisioned_sites WHERE provider_ref = $1 LIMIT 1`,
    [providerRef],
  );
  return r.rowCount ? r.rowCount > 0 : false;
}

/** Far-side lifecycle -> ERP status. Identity on the three success states by design (§04's mapping);
 *  a far-side `failed` becomes our `failed/provider_failed`. An UNKNOWN far-side status never gets
 *  here — `provision-http.ts` already narrows it to `pending` rather than letting it be trusted. */
function mapProviderStatus(s: ProvisionProject["status"]): { status: SiteStatus; failureReason: string | null } {
  if (s === "failed") return { status: "failed", failureReason: "provider_failed" };
  return { status: s, failureReason: null };
}

/** Terminal for polling purposes. `failed` is terminal for the POLLER but explicitly NOT final for
 *  the RECONCILER (§04: a `failed/poll_timeout` row is "honest, not final" and the hourly reconcile
 *  flow flips it forward when provision's own restart-resume eventually succeeds). */
const isPollTerminal = (s: SiteStatus): boolean => s === "live" || s === "failed";

async function markFailed(
  c: PoolClient, tenantId: string, row: SiteRow, reason: string,
): Promise<SiteRow> {
  const r = await c.query<SiteRow>(
    `UPDATE webdev_provisioned_sites
        SET status = 'failed', failure_reason = $2, updated_at = now()
      WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
    [row.id, reason],
  );
  const updated = r.rows[0];
  await emitEvent(c, tenantId, "webdev_provisioned_site", row.id, "webdev.site.provision_failed", {
    slug: row.slug, pipelineRunId: row.pipeline_run_id, reason, provider: row.provider,
  });
  return updated;
}

/** Best-effort routing of a failure to the humans who can act on it (design §04: "failed routes to
 *  the run owner + dept lead"). Runs AFTER the transaction commits — `notify` opens its own
 *  `withTenants`, and a notification failure must never roll back the recorded failure itself. */
async function notifyFailure(tenantId: string, site: SiteDto, runOwnerId: string | null, reason: string): Promise<void> {
  const recipients = new Set<string>();
  if (site.requestedBy) recipients.add(site.requestedBy);
  if (runOwnerId) recipients.add(runOwnerId);
  for (const uid of recipients) {
    try {
      await notify(tenantId, uid, null, "webdev.site.provision_failed", {
        title: "Site provisioning failed",
        body: `Provisioning "${site.slug}" failed: ${reason}`,
        href: site.pipelineRunId ? `/pipeline/${site.pipelineRunId}` : "/pipeline",
        entityType: "webdev_provisioned_site",
        entityId: site.id,
        severity: "warning",
        // The typed failure token, so the UI can render a specific remedy (e.g. "pick another slug")
        // instead of a generic "something went wrong".
        failureReason: reason,
      });
    } catch {
      // best-effort only — never fail a recorded outcome over a notification
    }
  }
}

/**
 * THE EGRESS STEP, shared by the create path and the resume path.
 *
 * Preconditions the caller MUST have established, under the lock, immediately before calling:
 *   - `row` was re-read inside this transaction (not a snapshot from before the lock);
 *   - `row.provider_ref IS NULL` (nothing has been created for it yet);
 *   - `row.status = 'requested'`.
 * Those three are the entire idempotency contract. This function performs exactly one
 * `createProject` call and then records its outcome; it never loops and never retries an HTTP answer.
 */
async function performEgress(
  c: PoolClient,
  args: { tenantId: string; provider: ProvisionProvider; row: SiteRow; devName: string },
): Promise<ProvisionOutcome> {
  const { tenantId, provider, row, devName } = args;

  let result;
  try {
    result = await provider.createProject({ name: row.slug, framework: row.framework, devName });
  } catch (err) {
    // Transport failure: we do NOT know whether provision received it. Record it honestly and stop.
    // No automatic re-POST, ever — recovery is a precondition-gated re-drive through this same code.
    //
    // Every throw lands here, not just `ProvisionEgressError`. That is deliberate: an unexpected
    // error from the driver leaves the SAME ambiguity (the request may or may not have been
    // received), so it must be recorded as such rather than rolled back into "nothing happened".
    // The distinction is preserved in the message, which is what an operator reads.
    const detail = err instanceof ProvisionEgressError
      ? err.message
      : `unexpected driver error: ${(err as Error)?.message ?? String(err)}`;
    const updated = await markFailed(c, tenantId, row, "egress_error");
    return { outcome: "egress_error", site: toSiteDto(updated), reason: detail };
  }

  if (result.outcome === "rejected") {
    const updated = await markFailed(c, tenantId, row, "provider_rejected");
    return { outcome: "provider_rejected", site: toSiteDto(updated), reason: result.reason };
  }

  if (result.outcome === "conflict") {
    const existing = result.existing;
    // ADOPT ONLY IF OURS. `existing === null` (the far side would not tell us which project holds
    // the name) is treated exactly like "not ours": refuse. Failing closed on an unreadable far side
    // is the whole point — the alternative is guessing about someone else's site.
    if (existing && (await providerRefIsOurs(c, existing.id))) {
      const mapped = mapProviderStatus(existing.status);
      const r = await c.query<SiteRow>(
        `UPDATE webdev_provisioned_sites
            SET provider_ref = $2, status = $3, failure_reason = $4,
                repo_url = COALESCE($5, repo_url), staging_url = COALESCE($6, staging_url),
                last_reconciled_at = now(), updated_at = now()
          WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
        [row.id, existing.id, mapped.status, mapped.failureReason, existing.repoUrl, existing.stagingUrl],
      );
      const updated = r.rows[0];
      await emitEvent(c, tenantId, "webdev_provisioned_site", row.id, "webdev.site.provision_requested", {
        slug: row.slug, pipelineRunId: row.pipeline_run_id, providerRef: existing.id,
        provider: row.provider, adopted: true,
      });
      return { outcome: "adopted", site: toSiteDto(updated) };
    }
    const updated = await markFailed(c, tenantId, row, "slug_conflict_foreign");
    return { outcome: "conflict_foreign", site: toSiteDto(updated) };
  }

  // Accepted (202). Bind the correlation key in the SAME transaction as the egress that produced it —
  // the narrowest possible window in which a crash could leave a project we cannot prove is ours.
  const project = result.project;
  const mapped = mapProviderStatus(project.status);
  const r = await c.query<SiteRow>(
    `UPDATE webdev_provisioned_sites
        SET provider_ref = $2, status = $3, failure_reason = $4, repo_url = $5, staging_url = $6,
            updated_at = now()
      WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
    [row.id, project.id, mapped.status, mapped.failureReason, project.repoUrl, project.stagingUrl],
  );
  const updated = r.rows[0];
  await emitEvent(c, tenantId, "webdev_provisioned_site", row.id, "webdev.site.provision_requested", {
    slug: row.slug, pipelineRunId: row.pipeline_run_id, providerRef: project.id,
    provider: row.provider, framework: row.framework, adopted: false,
  });
  return { outcome: "created", site: toSiteDto(updated) };
}

/** Take the ONE lock for this operation (see `WEBDEV_PROVISION_LOCK_NS`). Must be the first statement
 *  after BEGIN whose result anything depends on. */
async function takeLock(c: PoolClient, runId: string | null, slug: string): Promise<void> {
  if (runId) {
    await lockPipelineRun(c, runId);
    return;
  }
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [WEBDEV_PROVISION_LOCK_NS, slug]);
}

/** Postgres unique-violation. */
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === "23505";

/**
 * POST /api/:tenantId/modules/webdev/provision — the whole seam in one transaction.
 *
 * Order is the contract: LOCK -> re-read -> precondition -> claim -> egress -> record. See the file
 * header for why each step is where it is.
 */
export async function provisionSite(args: ProvisionSiteArgs): Promise<ProvisionOutcome> {
  const { tenantId, provider, runId, requestedBy, requestedByName } = args;

  const framework = args.framework ?? "vite"; // OQ-P4 default: `vite` (P-7 makes nextjs the buggier target today)
  if (!SUPPORTED_FRAMEWORKS.has(framework)) return { outcome: "invalid", reason: "unsupported_framework" };
  // D-P7: refuse-with-routing, never downgrade.
  if (args.stack !== undefined && !STATIC_STACKS.has(String(args.stack).trim().toLowerCase())) {
    return { outcome: "invalid", reason: "unsupported_stack" };
  }

  let runOwnerId: string | null = null;
  const outcome = await withTenants<ProvisionOutcome>([tenantId], async (c) => {
    // ── 1. LOCK. Slug may still be unknown (derived from the run title) when there IS a run, and in
    // that case the run id is what we lock on anyway, so the ordering works out: lock first, derive
    // after. For the off-pipeline case the caller must supply an explicit slug — there is no title
    // to derive from — so the slug is available to lock on before anything is read.
    const preSlug = args.slug?.trim().toLowerCase() ?? "";
    if (!runId && !preSlug) return { outcome: "invalid", reason: "invalid_slug" };
    await takeLock(c, runId, preSlug);

    // ── 2. RE-READ + PRECONDITION RE-CHECK, under the lock.
    let slug = preSlug;
    if (runId) {
      const pre = await evaluateProvisionPrecondition(c, runId, {
        requireSignedPrdGate: args.requireSignedPrdGate ?? false,
      });
      if (!pre.ok) return { outcome: "precondition_failed", reason: pre.reason };
      runOwnerId = pre.runOwnerId;
      if (!slug) slug = deriveRunSlug(pre.runTitle, runId);

      // The row-shaped arm: the loser of a race is handed the EXISTING site, not an error, and no
      // second egress happens.
      //
      // MUTATION-PROBED 2026-08-09, and the result is worth recording precisely because it was NOT
      // the expected one. With `ux_wps_run` in place, deleting this arm leaves the CREATE RACE test
      // GREEN: the loser's INSERT hits the partial-unique, the 23505 is translated below, and the
      // caller still gets the existing row with still exactly one egress. In other words, on the
      // INSERT path the SCHEMA half is what structurally holds, and this arm's contribution is
      // returning 200-with-the-row instead of taking an abort-and-recover detour.
      //
      // So the suite proves the claim a second way instead of pretending: `CREATE RACE (index
      // dropped)` runs the same race with `ux_wps_run` removed, and THERE deleting this arm goes RED
      // with two egresses. That is the design's "two independent layers, each sufficient alone"
      // (D-P5) actually demonstrated, rather than a test that silently only ever exercised one.
      // The row-shaped arm: the loser of a race is handed the EXISTING site, not an error, and no
      // second egress happens.
      //
      // MUTATION-PROBED 2026-08-09, and the result is worth recording precisely because it was NOT
      // the expected one. With the partial uniques in place, deleting this arm leaves the CREATE RACE
      // test GREEN: the loser's INSERT hits `ux_wps_run` (or `ux_wps_slug`), the 23505 is translated
      // below, and the caller still gets the existing row with still exactly one egress. On the
      // INSERT path the SCHEMA half is what structurally holds; this arm's contribution is returning
      // 200-with-the-row instead of an abort-and-recover detour.
      //
      // So the suite proves the code half a second way rather than pretending: `CREATE RACE (partial
      // uniques dropped)` re-runs the race with all three backstops removed, and THERE deleting this
      // arm goes RED with `mock.hitCount("provision") === 2` — two real creates on the far side. That
      // is the design's "two independent layers, each sufficient alone" (D-P5) actually demonstrated,
      // instead of a test that only ever exercised one of them.
      const existing = await existingLiveSiteForRun(c, runId);
      if (existing) return { outcome: "existing", site: toSiteDto(existing) };
    }

    if (!isValidProvisionSlug(slug)) return { outcome: "invalid", reason: "invalid_slug" };

    // ── 3. CLAIM. Occupies the `ux_wps_run` / `ux_wps_slug` partial-unique slot before any egress,
    // so even a caller that somehow bypassed the re-check above collides here instead of creating a
    // second repo. `requested` is the design's explicit PRE-EGRESS state (0090 deviation 1).
    const id = newId();
    let row: SiteRow;
    try {
      const ins = await c.query<SiteRow>(
        `INSERT INTO webdev_provisioned_sites
           (id, tenant_id, pipeline_run_id, provider, slug, framework, status, requested_by, approval_id, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9)
         RETURNING ${SITE_COLUMNS}`,
        [id, tenantId, runId, provider.key, slug, framework, requestedBy, args.approvalId ?? null, config.originSite],
      );
      row = ins.rows[0];
    } catch (err) {
      // The schema half spoke. Translate into an honest answer rather than a 500: either another
      // non-failed row already holds this slug in this tenant (`ux_wps_slug`), or a racer beat us to
      // the run slot (`ux_wps_run`) despite the re-check — both mean "do not egress".
      if (!isUniqueViolation(err)) throw err;
      throw new SlugOrRunTakenError();
    }

    // ── 4. ACT: the egress, still under the lock, in this transaction.
    return performEgress(c, { tenantId, provider, row, devName: requestedByName });
  }, { modules: ["webdev"] }).catch(async (err: unknown) => {
    if (err instanceof SlugOrRunTakenError) {
      // Re-read outside the aborted transaction so the caller can be told WHICH row holds it.
      if (runId) {
        const existing = await withTenants([tenantId], (c) => existingLiveSiteForRun(c, runId), { modules: ["webdev"] });
        if (existing) return { outcome: "existing", site: toSiteDto(existing) } as ProvisionOutcome;
      }
      return { outcome: "slug_taken" } as ProvisionOutcome;
    }
    throw err;
  });

  if (outcome.outcome === "conflict_foreign") {
    await notifyFailure(tenantId, outcome.site, runOwnerId, "slug_conflict_foreign");
  } else if (outcome.outcome === "egress_error" || outcome.outcome === "provider_rejected") {
    await notifyFailure(tenantId, outcome.site, runOwnerId, outcome.site.failureReason ?? "failed");
  }
  return outcome;
}

/** Internal signal: the partial-unique refused the claim. Never escapes this module. */
class SlugOrRunTakenError extends Error {
  constructor() {
    super("slug or run already has a live provisioning attempt");
    this.name = "SlugOrRunTakenError";
  }
}

// ═══ POLLING ═════════════════════════════════════════════════════════════════════════════════════
// `provision`'s async steps LOG AND SIT on a hard failure until its own restart-resume re-drives
// them (`provisionProject.ts:236-238`). There is no callback, no webhook (v1 has NO B′→A channel at
// all, by design), and no error surface. TIME IS THE ONLY HONEST SIGNAL the ERP has, so the poll
// window exhausting becomes `failed/poll_timeout` — an honest, NON-FINAL failure the reconciler is
// expected to flip forward later.

export interface PollOptions {
  intervalMs?: number;
  maxIntervalMs?: number;
  maxMs?: number;
  /** Injected for tests; production uses real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ONE poll: lock -> re-read -> (still pollable?) -> GET -> record any transition. Its own
 *  transaction, so the loop never holds a connection across a sleep. */
async function pollOnce(
  tenantId: string, siteId: string, provider: ProvisionProvider,
): Promise<{ done: boolean; site: SiteDto | null }> {
  return withTenants([tenantId], async (c) => {
    const pre = await readSite(c, siteId);
    if (!pre) return { done: true, site: null };
    await takeLock(c, pre.pipeline_run_id, pre.slug);
    // RE-READ under the lock: a concurrent reconcile may have advanced or failed this row while we
    // waited, and acting on `pre` would overwrite its decision with a stale one.
    const row = await readSite(c, siteId);
    if (!row) return { done: true, site: null };
    if (isPollTerminal(row.status) || !row.provider_ref) {
      return { done: true, site: toSiteDto(row) };
    }
    const project = await provider.getProject(row.provider_ref);
    if (!project) return { done: false, site: toSiteDto(row) };
    const mapped = mapProviderStatus(project.status);
    if (mapped.status === row.status && project.repoUrl === row.repo_url && project.stagingUrl === row.staging_url) {
      return { done: isPollTerminal(row.status), site: toSiteDto(row) };
    }
    const upd = await c.query<SiteRow>(
      `UPDATE webdev_provisioned_sites
          SET status = $2, failure_reason = $3, repo_url = COALESCE($4, repo_url),
              staging_url = COALESCE($5, staging_url), last_reconciled_at = now(), updated_at = now()
        WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
      [row.id, mapped.status, mapped.failureReason, project.repoUrl, project.stagingUrl],
    );
    const updated = upd.rows[0];
    if (mapped.status === "failed") {
      await emitEvent(c, tenantId, "webdev_provisioned_site", row.id, "webdev.site.provision_failed", {
        slug: row.slug, pipelineRunId: row.pipeline_run_id, reason: mapped.failureReason, provider: row.provider,
      });
    } else if (mapped.status === "provisioned" || mapped.status === "live") {
      await emitEvent(c, tenantId, "webdev_provisioned_site", row.id, "webdev.site.provisioned", {
        slug: row.slug, pipelineRunId: row.pipeline_run_id, status: mapped.status,
        repoUrl: updated.repo_url, stagingUrl: updated.staging_url, provider: row.provider,
      });
    }
    return { done: isPollTerminal(mapped.status), site: toSiteDto(updated) };
  }, { modules: ["webdev"] });
}

/**
 * Poll one site to a terminal state or to `failed/poll_timeout`.
 *
 * The controller fires this DETACHED after responding 201 (the design's contract returns as soon as
 * the mirror row exists and egress has begun), so a slow certbot never holds an HTTP request open.
 * Tests await it directly with a compressed window.
 */
export async function pollProvisioningSite(
  tenantId: string, siteId: string, provider: ProvisionProvider, opts: PollOptions = {},
): Promise<SiteDto | null> {
  const sleep = opts.sleepImpl ?? realSleep;
  const maxMs = opts.maxMs ?? config.provision.pollMaxMs;
  const maxInterval = opts.maxIntervalMs ?? config.provision.pollMaxIntervalMs;
  let interval = opts.intervalMs ?? config.provision.pollIntervalMs;
  const deadline = Date.now() + maxMs;

  let last: SiteDto | null = null;
  for (;;) {
    const r = await pollOnce(tenantId, siteId, provider);
    last = r.site;
    if (r.done) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining));
    interval = Math.min(interval * 2, maxInterval);
    if (Date.now() >= deadline) break;
  }

  // Window exhausted. HONEST, NOT FINAL (§04): the row is `failed` so it stops occupying the
  // partial-unique slot and a retry is possible, and `reconcile()` can still flip it forward when
  // provision's own restart-resume eventually completes the work.
  return withTenants([tenantId], async (c) => {
    const pre = await readSite(c, siteId);
    if (!pre) return null;
    await takeLock(c, pre.pipeline_run_id, pre.slug);
    const row = await readSite(c, siteId);
    if (!row || isPollTerminal(row.status)) return row ? toSiteDto(row) : null;
    const updated = await markFailed(c, tenantId, row, "poll_timeout");
    return toSiteDto(updated);
  }, { modules: ["webdev"] });
}

// ═══ RECONCILE ═══════════════════════════════════════════════════════════════════════════════════

export type ReconcileOutcome =
  | { outcome: "unchanged"; site: SiteDto }
  | { outcome: "advanced"; site: SiteDto }
  | { outcome: "superseded"; site: SiteDto }
  | { outcome: "not_found" }
  | ProvisionOutcome;

/**
 * POST …/provisioned-sites/:id/reconcile — re-poll now, or RESUME a never-egressed row.
 *
 * ── WHY THIS IS THE DANGEROUS ONE ────────────────────────────────────────────────────────────────
 * Its action on the resume path is an UPDATE of an existing row, so NO unique index participates.
 * Two concurrent reconciles that each decided "this row still needs egress" from a snapshot taken
 * before the lock will each call `createProject` — two repos, two vhosts. The lock plus the RE-READ
 * below is the ONLY thing that prevents it, which is why the concurrency test mutation-probes
 * exactly this re-read.
 */
export async function reconcileProvisionedSite(args: {
  tenantId: string;
  siteId: string;
  provider: ProvisionProvider;
  requestedByName: string;
}): Promise<ReconcileOutcome> {
  const { tenantId, siteId, provider, requestedByName } = args;
  return withTenants<ReconcileOutcome>([tenantId], async (c) => {
    // Pre-lock read: cheap existence/tenancy check, and it supplies the lock key. Nothing is DECIDED
    // from it — `pipeline_run_id` and `slug` are immutable on this row, which is exactly the property
    // `core/pipeline-lock.ts` documents as safe to read before locking. Everything else is re-read.
    const pre = await readSite(c, siteId);
    if (!pre) return { outcome: "not_found" };
    await takeLock(c, pre.pipeline_run_id, pre.slug);

    // ══ THE PRECONDITION RE-CHECK ══
    // MUTATION-PROBED 2026-08-09: replacing this re-read with the pre-lock snapshot (`const row =
    // pre`) turned the RESUME RACE test RED with `mock.hitCount("provision") === 2` — two real
    // creates on the far side, i.e. two GitHub repos and two nginx vhosts in production. The lock
    // alone does not prevent that: both racers hold it in turn and both act on a justification
    // computed before they held it. This line is the fix.
    const row = await readSite(c, siteId);
    if (!row) return { outcome: "not_found" };

    // Resume: a row that has never egressed (design §03 — "stays `requested` if the failure precedes
    // any successful egress"). Re-drive it through the SAME single-egress path.
    if (!row.provider_ref && row.status === "requested") {
      return performEgress(c, { tenantId, provider, row, devName: requestedByName });
    }

    if (!row.provider_ref) {
      // `failed` before any egress — nothing to poll and nothing to resume (a retry is a NEW row
      // through the provision endpoint, which is precondition-gated).
      return { outcome: "unchanged", site: toSiteDto(row) };
    }

    const project = await provider.getProject(row.provider_ref);
    if (!project) {
      await c.query(`UPDATE webdev_provisioned_sites SET last_reconciled_at = now() WHERE id = $1`, [row.id]);
      const refreshed = await readSite(c, row.id);
      return { outcome: "unchanged", site: toSiteDto(refreshed as SiteRow) };
    }
    const mapped = mapProviderStatus(project.status);

    // Flipping a FAILED row forward (§04's "honest, not final") needs one more server-side re-check:
    // a retry row for the same run may already exist and hold the `ux_wps_run` slot. Reviving this
    // one would be refused by the index as a 23505 — so ask first and record `superseded` instead of
    // surfacing a constraint error the operator cannot act on.
    if (row.status === "failed" && mapped.status !== "failed" && row.pipeline_run_id) {
      const live = await existingLiveSiteForRun(c, row.pipeline_run_id);
      if (live && live.id !== row.id) {
        const upd = await c.query<SiteRow>(
          `UPDATE webdev_provisioned_sites
              SET failure_reason = 'superseded', last_reconciled_at = now(), updated_at = now()
            WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
          [row.id],
        );
        return { outcome: "superseded", site: toSiteDto(upd.rows[0]) };
      }
    }

    const changed =
      mapped.status !== row.status || project.repoUrl !== row.repo_url || project.stagingUrl !== row.staging_url;
    const upd = await c.query<SiteRow>(
      `UPDATE webdev_provisioned_sites
          SET status = $2, failure_reason = $3, repo_url = COALESCE($4, repo_url),
              staging_url = COALESCE($5, staging_url), last_reconciled_at = now(),
              updated_at = CASE WHEN $6 THEN now() ELSE updated_at END
        WHERE id = $1 RETURNING ${SITE_COLUMNS}`,
      [row.id, mapped.status, mapped.failureReason, project.repoUrl, project.stagingUrl, changed],
    );
    const updated = upd.rows[0];
    if (changed && (mapped.status === "provisioned" || mapped.status === "live")) {
      await emitEvent(c, tenantId, "webdev_provisioned_site", row.id, "webdev.site.provisioned", {
        slug: row.slug, pipelineRunId: row.pipeline_run_id, status: mapped.status,
        repoUrl: updated.repo_url, stagingUrl: updated.staging_url, provider: row.provider,
      });
    } else if (changed && mapped.status === "failed") {
      await emitEvent(c, tenantId, "webdev_provisioned_site", row.id, "webdev.site.provision_failed", {
        slug: row.slug, pipelineRunId: row.pipeline_run_id, reason: mapped.failureReason, provider: row.provider,
      });
    }
    return { outcome: changed ? "advanced" : "unchanged", site: toSiteDto(updated) };
  }, { modules: ["webdev"] });
}

// ═══ READS ═══════════════════════════════════════════════════════════════════════════════════════

/** GET …/provisioned-sites[?runId=]. EVERY read declares `{modules:['webdev']}` — 0090 carries the
 *  THIRD WALL, so an undeclared module scope makes this return ZERO ROWS silently rather than
 *  erroring (the WD-23A-1 two-sided handshake). That is the failure this comment exists to prevent
 *  someone from "simplifying" into existence. */
export async function listProvisionedSites(tenantId: string, runId?: string): Promise<SiteDto[]> {
  const where = runId ? `WHERE pipeline_run_id = $1` : ``;
  const rows = await withTenants(
    [tenantId],
    (c) =>
      c.query<SiteRow>(
        `SELECT ${SITE_COLUMNS} FROM webdev_provisioned_sites ${where} ORDER BY created_at DESC LIMIT 200`,
        runId ? [runId] : [],
      ),
    { modules: ["webdev"] },
  );
  return rows.rows.map(toSiteDto);
}

export async function getProvisionedSite(tenantId: string, id: string): Promise<SiteDto | null> {
  const row = await withTenants([tenantId], (c) => readSite(c, id), { modules: ["webdev"] });
  return row ? toSiteDto(row) : null;
}
