// M6-P4c2 — the scheduled reconcile: a bounded, periodic retry of the provisioning completion.
//
// ═══ THE GAP THIS CLOSES ═══════════════════════════════════════════════════════════════════════════
// `provision-completion.ts` advances a provisioned site NULL -> registered -> tenant_ready -> complete, and
// its last step pins the contract snapshot only once WebDesk's ASYNC codegen has published latest.json.
// Until then the row records `contract_not_published` and WAITS. Before this file, the row advanced only on
//   (a) the repo approval's decide() hook, (b) a detached poll bounded by PROVISION_POLL_MAX_MS (5 min), and
//   (c) a human pressing "Check status now".
// A site whose codegen outlasted the poll window therefore sat at `tenant_ready` until someone clicked, and
// the delivery automation's code stage never resumed (`webdev.site.contract_pinned` is emitted only at
// `complete`). The comments in the service and the controller referred to a `wd-provision-reconcile` flow;
// no such workflow ever existed in automation/workflows/. This loop is that flow, in-process.
//
// ═══ WHAT A TICK DOES ═══════════════════════════════════════════════════════════════════════════════
//   1. enumerate `companies` (no RLS), then read ONE TENANT PER TRANSACTION with `{modules:['webdev']}` —
//      the monitoring runner's shape. A plain `withGlobal` read of webdev_provisioned_sites returns ZERO
//      rows with no error (no GUC is set); a tenant is also skipped unless `isModuleEnabled(.., 'webdev')`,
//      because the third wall only proves the request DECLARED the scope, not that the tenant enabled it
//      (the HTTP edge's ModuleEnabledGuard never sees a background job).
//   2. select the stuck rows (the predicate, below), drop the ones the back-off says wait, order the rest
//      least-recently-attempted first, and keep BATCH of them across the whole estate.
//   3. advance each through the SAME functions the manual route and the poller call. Nothing here
//      re-implements a step, takes a second lock, or writes a state column:
//        * repo done (provisioned/live)  -> `completeAfterPoll`   (register -> tenant -> contract)
//        * repo approved, row `pending`  -> `reconcileAndComplete` (the repo step's reconcile, then the above)
//      Both end in `advanceProvisionCompletion`, whose every step is LOCK -> RE-READ -> ACT -> RECORD under
//      `takeProvisionLock` — the lock the manual button, the decide() hook and the poller already share. A
//      click racing a tick serialises on it; the loser re-reads, finds the step done, and does nothing, so
//      `webdev.site.contract_pinned` is emitted once (provision-reconcile-loop.db.test.ts pins that).
//      `completeAfterPoll` rather than `reconcileAndComplete` for a row whose repo is already done: the
//      repo step's reconcile would ask GitHub about every such row on every tick, and a GitHub outage would
//      then block the contract pin, which does not need GitHub at all.
//
// ═══ THE SELECTION PREDICATE (`reconcileRoute`, mirrored in SQL by `readCandidates`) ════════════════
//   provider = 'erp_repo'                         (only §08's rows BEGIN a completion; see provision-completion.ts)
//   AND status <> 'failed'                        (a failed repo row never advances)
//   AND completion_state IS DISTINCT FROM 'complete'
//   AND ( (status IN ('provisioned','live') AND repo_url IS NOT NULL)    -- the repo exists
//         OR (status = 'pending' AND the GH-12 request is `approved`) )  -- approved, reconcile not yet seen it
//   AND the row is inside the back-off window (below).
// `webdev_provisioned_sites` has no `deleted_at`: a row is never soft-deleted, only `failed`. The SQL is the
// efficient pre-filter; `reconcileRoute` re-checks every row it returns (and is the unit-tested statement of
// the rule), so a drift between the two can only make the loop do less, never more.
//
// ═══ THE ACTING IDENTITY ═══════════════════════════════════════════════════════════════════════════
// The manual route acts as its caller, the decide() hook as the decider, the poller as the requester. A loop
// has no caller, so it acts as the row's OWN recorded human: `requested_by` first (what the poller used),
// else the GH-12 approval's `decided_by` (what the hook used). Each is assembled with `assemblePrincipal(..,
// 'linked')` — a verified identity, no fresh login, the honest value for a deferred effect (the same call
// scheduled-rebuilds.service makes). Not an invented super-user: the principal is used only for attribution
// (the `webdesk.tenant.provision` ledger rows, `fetched_by` on the contract snapshot, the GitHub read's
// actor) and the completion DECIDES NOTHING — slug, company, kind and lineage all come from the approved
// row, and the one human decision that authorised it is the repo approval. If neither user is still an
// active principal, the row is skipped (counted, logged) and stays for the manual button; the loop never
// falls back to a service identity.
//
// ═══ BACK-OFF (no migration: it reads columns that already exist) ═══════════════════════════════════
// A failing completion step records `completion_error` and bumps `completion_updated_at`; the repo step's
// reconcile bumps `last_reconciled_at` on every look. Together they are the last ATTEMPT. `updated_at` moves
// only on a real transition (the last TRANSITION). The loop keys off both:
//   age since last transition   | minimum gap between attempts
//   < 1 hour                    | none (every tick: codegen usually lands in minutes)
//   1 h to < 6 h                | 30 minutes
//   6 h to < 24 h               | 2 hours
//   >= 24 hours                 | STOP — left for the manual button (the row is not hammered forever, and a
//                               |   WebDesk that has been down for a day is a human's problem)
// For a `pending` row whose request was approved, the transition clock starts at the approval's `decided_at`
// (a request can wait days for a human; the clock must not have run out before the decision).
// An UNEXPECTED fault (a thrown error rather than a typed `completion_error`) is written as
// `completion_failed` / `reconcile_failed: <ErrorName>` so it engages the same back-off and is visible on the
// row; the typed errors are already recorded by the state machine itself.
//
// ═══ NO OFF SWITCH, ON PURPOSE ══════════════════════════════════════════════════════════════════════
// Unlike the monitoring runner (which DIALS CLIENT WEBSITES, so booting must not start it) this loop only
// finishes work a company_admin already approved, idempotently, through paths that already exist. A flag that
// defaults it off would put the stall back silently; a flag that defaults it on adds nothing the interval
// does not. PROVISION_RECONCILE_INTERVAL_MS is the whole control (default 5 min, floor 30 s, empty/zero/junk
// fall back — `readIntervalMs`); a very large value slows it to a trickle. It starts from bootstrap() only,
// never from buildApp(), so no test or one-off script runs it.
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
import { isModuleEnabled } from "../registry";
import { ErpRepoControlNotConfiguredError, createErpRepoControlProvider } from "./erp-repo-control-provider";
import { COMPLETING_PROVIDER, nextCompletionStep, type CompletionReport, type CompletionState } from "./provision-completion";
import { completeAfterPoll, reconcileAndComplete } from "./provision-completion.service";
import { takeProvisionLock, type SiteStatus } from "./provisioning.service";

// ── tunables (named, so the header's table and the tests read the same numbers) ──────────────────

/** How many rows one tick may attempt, across the whole estate. */
export const RECONCILE_BATCH = 20;
/** Rows read per tenant per tick before the batch cut (bounds one tenant's read; the batch bounds the tick). */
export const RECONCILE_SCAN_LIMIT = 100;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Past this long since the last transition the loop leaves the row for the manual button. */
export const RECONCILE_STOP_AFTER_MS = 24 * HOUR;

/** Ascending. `gapMs` is the minimum time since the last attempt, for a row whose last transition is younger than `underMs`. */
export const RECONCILE_BACKOFF: ReadonlyArray<{ underMs: number; gapMs: number }> = [
  { underMs: 1 * HOUR, gapMs: 0 },
  { underMs: 6 * HOUR, gapMs: 30 * MINUTE },
  { underMs: RECONCILE_STOP_AFTER_MS, gapMs: 2 * HOUR },
];

/** The first tick runs this long after boot (not a full interval), so a restart picks stuck rows up promptly. */
export const RECONCILE_FIRST_DELAY_MS = 30_000;

// ── the candidate and the pure rules ────────────────────────────────────────────────────────────

export interface ReconcileCandidate {
  id: string;
  tenantId: string;
  provider: string;
  status: SiteStatus;
  repoUrl: string | null;
  completionState: CompletionState | null;
  /** The GH-12 repo request this row filed is `approved` (only ever true for provider `erp_repo`). */
  approvalApproved: boolean;
  requestedBy: string | null;
  decidedBy: string | null;
  /** The last TRANSITION: GREATEST(updated_at, the approval's decided_at). Epoch ms. */
  anchorMs: number;
  /** The last ATTEMPT that wrote: GREATEST(completion_updated_at, last_reconciled_at). null = never attempted. Epoch ms. */
  lastAttemptMs: number | null;
  createdMs: number;
}

export type ReconcileRoute = "completion" | "repo_then_completion";

/** THE selection predicate. `null` = leave this row alone. */
export function reconcileRoute(c: Pick<ReconcileCandidate, "provider" | "status" | "repoUrl" | "completionState" | "approvalApproved">): ReconcileRoute | null {
  if (c.provider !== COMPLETING_PROVIDER) return null;
  if (c.status === "failed" || c.completionState === "complete") return null;
  if (c.status === "pending") {
    // The repo step has not seen the approval yet (a crash, GitHub's eventual consistency). Only once a human
    // approved: a request still awaiting its decision is nobody's to chase.
    return c.completionState === null && c.approvalApproved ? "repo_then_completion" : null;
  }
  const step = nextCompletionStep(c);
  return step === "register" || step === "tenant" || step === "contract" ? "completion" : null;
}

/** Minimum gap between attempts for a row this old (since its last transition); `null` = the loop has stopped. */
export function minGapMs(ageMs: number): number | null {
  for (const band of RECONCILE_BACKOFF) if (ageMs < band.underMs) return band.gapMs;
  return null;
}

/** Is this row's turn? (A negative age, i.e. clock skew, reads as brand new.) */
export function isDue(c: Pick<ReconcileCandidate, "anchorMs" | "lastAttemptMs">, nowMs: number): boolean {
  const gap = minGapMs(nowMs - c.anchorMs);
  if (gap === null) return false;
  if (gap === 0 || c.lastAttemptMs === null) return true;
  return nowMs - c.lastAttemptMs >= gap;
}

/** The rows to attempt now: selected, due, least-recently-attempted first (then oldest, then id), cut to `batch`. */
export function planBatch(candidates: ReconcileCandidate[], nowMs: number, batch: number = RECONCILE_BATCH): ReconcileCandidate[] {
  return candidates
    .filter((c) => reconcileRoute(c) !== null && isDue(c, nowMs))
    .sort((a, b) => (a.lastAttemptMs ?? a.anchorMs) - (b.lastAttemptMs ?? b.anchorMs) || a.createdMs - b.createdMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, batch));
}

// ── the database ────────────────────────────────────────────────────────────────────────────────

interface CandidateDbRow {
  id: string;
  provider: string;
  status: SiteStatus;
  repo_url: string | null;
  completion_state: CompletionState | null;
  requested_by: string | null;
  decided_by: string | null;
  approval_approved: boolean;
  anchor_at: Date | string;
  last_attempt_at: Date | string | null;
  created_at: Date | string;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * One tenant, one transaction, scope `webdev` (the third wall; `automation_approvals` has no module predicate).
 * Over-reads on purpose (everything not ruled out cheaply); `planBatch` makes the real cut.
 */
export async function readCandidates(tenantId: string, nowMs: number = Date.now()): Promise<ReconcileCandidate[]> {
  const r = await withTenants(
    [tenantId],
    (c) =>
      c.query<CandidateDbRow>(
        `SELECT w.id, w.provider, w.status, w.repo_url, w.completion_state, w.requested_by,
                a.decided_by, (a.id IS NOT NULL) AS approval_approved,
                GREATEST(w.updated_at, COALESCE(a.decided_at, w.updated_at)) AS anchor_at,
                GREATEST(w.completion_updated_at, w.last_reconciled_at) AS last_attempt_at, w.created_at
           FROM webdev_provisioned_sites w
           LEFT JOIN automation_approvals a
             ON a.id::text = w.provider_ref AND a.origin = 'github' AND a.workflow_id = $1
            AND a.status = 'approved' AND a.deleted_at IS NULL
          WHERE w.provider = $2
            AND w.status <> 'failed'
            AND w.completion_state IS DISTINCT FROM 'complete'
            AND ((w.status IN ('provisioned', 'live') AND w.repo_url IS NOT NULL)
                 OR (w.status = 'pending' AND a.id IS NOT NULL))
            AND GREATEST(w.updated_at, COALESCE(a.decided_at, w.updated_at)) > to_timestamp($3::double precision / 1000.0)
          ORDER BY COALESCE(GREATEST(w.completion_updated_at, w.last_reconciled_at), w.updated_at), w.created_at, w.id
          LIMIT $4`,
        [GITHUB_CREATE_REPO_WORKFLOW, COMPLETING_PROVIDER, nowMs - RECONCILE_STOP_AFTER_MS, RECONCILE_SCAN_LIMIT],
      ),
    { modules: ["webdev"] },
  );
  return r.rows.map((w) => ({
    id: w.id,
    tenantId,
    provider: w.provider,
    status: w.status,
    repoUrl: w.repo_url,
    completionState: w.completion_state,
    approvalApproved: w.approval_approved,
    requestedBy: w.requested_by,
    decidedBy: w.decided_by,
    anchorMs: ms(w.anchor_at),
    lastAttemptMs: w.last_attempt_at === null ? null : ms(w.last_attempt_at),
    createdMs: ms(w.created_at),
  }));
}

/** Annotate an unexpected fault on the row, under the site lock, so it shows in the UI and engages the back-off. */
async function recordFaultOnRow(tenantId: string, siteId: string, token: string): Promise<void> {
  await withTenants(
    [tenantId],
    async (c) => {
      const pre = await c.query<{ pipeline_run_id: string | null; slug: string }>(
        `SELECT pipeline_run_id, slug FROM webdev_provisioned_sites WHERE id = $1`,
        [siteId],
      );
      if (!pre.rows[0]) return;
      await takeProvisionLock(c, pre.rows[0].pipeline_run_id, pre.rows[0].slug);
      // Guarded: a racer that finished the row while we waited for the lock must not get an error stamped on it.
      await c.query(
        `UPDATE webdev_provisioned_sites SET completion_error = $2, completion_updated_at = now()
          WHERE id = $1 AND completion_state IS DISTINCT FROM 'complete'`,
        [siteId, token.slice(0, 300)],
      );
    },
    { modules: ["webdev"] },
  );
}

// ── the tick ────────────────────────────────────────────────────────────────────────────────────

export interface TickDeps {
  listTenants(): Promise<string[]>;
  tenantEnabled(tenantId: string): Promise<boolean>;
  readCandidates(tenantId: string, nowMs: number): Promise<ReconcileCandidate[]>;
  /** An ACTIVE principal for a user id, or null. */
  assemble(userId: string): Promise<Principal | null>;
  /** Advance one row through the shared functions. May throw `ErpRepoControlNotConfiguredError`. */
  advance(c: ReconcileCandidate, principal: Principal): Promise<CompletionReport | null>;
  recordFault(c: ReconcileCandidate, token: string): Promise<void>;
  log(message: string): void;
}

export interface TickResult {
  tenants: number;
  /** Rows the batch chose (due, within the window), before the actor check. */
  planned: number;
  /** Rows actually driven through the state machine. */
  attempted: number;
  /** Rows that moved at least one step. */
  progressed: number;
  /** Rows that reached `complete` in this tick. */
  completed: number;
  /** Rows whose attempt threw, or ended in `completion_failed`. */
  failed: number;
  /** Rows with no active requester or decider. */
  noActor: number;
  /** Rows skipped because the repo driver is not configured (GITHUB_ORG unset). */
  notConfigured: number;
  /** Tenants whose read threw. */
  tenantErrors: number;
}

const defaultDeps: TickDeps = {
  listTenants: async () =>
    (await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`))).rows.map((r) => r.id),
  tenantEnabled: (tenantId) => isModuleEnabled(tenantId, "webdev"),
  readCandidates,
  assemble: (userId) => assemblePrincipal(userId, "linked"),
  advance: async (c, principal) => {
    if (reconcileRoute(c) === "completion") return completeAfterPoll(c.tenantId, c.id, principal);
    const provider = createErpRepoControlProvider(c.tenantId, principal.userId ?? null);
    // `requestedByName` matters only to the repo step's resume arm (a row that never filed its request), which
    // cannot apply: this row's provider_ref IS an approved GH-12 request. The decide() hook passes the same.
    const r = await reconcileAndComplete({ tenantId: c.tenantId, siteId: c.id, provider, requestedByName: "Web Dev provisioning", principal });
    return r.completion;
  },
  recordFault: (c, token) => recordFaultOnRow(c.tenantId, c.id, token),
  // eslint-disable-next-line no-console
  log: (message) => console.log(message),
};

/** One pass over the estate. Never throws: a failure is counted, logged and left for the next tick. */
export async function runProvisionReconcileTick(overrides: Partial<TickDeps> = {}, nowMs: number = Date.now()): Promise<TickResult> {
  const deps: TickDeps = { ...defaultDeps, ...overrides };
  const out: TickResult = { tenants: 0, planned: 0, attempted: 0, progressed: 0, completed: 0, failed: 0, noActor: 0, notConfigured: 0, tenantErrors: 0 };

  let tenants: string[];
  try {
    tenants = await deps.listTenants();
  } catch (err) {
    out.tenantErrors += 1;
    deps.log(`[webdev reconcile] could not list companies: ${(err as Error)?.name ?? "error"}`);
    return out;
  }
  out.tenants = tenants.length;

  // Phase 1: one tenant per transaction. Each tenant contributes at most a batch's worth of due rows.
  const pool: ReconcileCandidate[] = [];
  for (const tenantId of tenants) {
    try {
      const rows = await deps.readCandidates(tenantId, nowMs);
      const due = planBatch(rows, nowMs, RECONCILE_BATCH);
      if (due.length === 0) continue;
      // Only a tenant that HAS work is asked whether the module is on (the third wall cannot answer that).
      if (!(await deps.tenantEnabled(tenantId))) continue;
      pool.push(...due);
    } catch (err) {
      out.tenantErrors += 1;
      deps.log(`[webdev reconcile] tenant ${tenantId}: read failed (${(err as Error)?.name ?? "error"})`);
    }
  }

  // Phase 2: the estate-wide cut, least recently attempted first, so no tenant starves another.
  const batch = planBatch(pool, nowMs, RECONCILE_BATCH);
  out.planned = batch.length;

  const actors = new Map<string, Principal | null>();
  const actorOf = async (userId: string | null): Promise<Principal | null> => {
    if (!userId) return null;
    if (!actors.has(userId)) {
      try {
        actors.set(userId, await deps.assemble(userId));
      } catch {
        actors.set(userId, null);
      }
    }
    return actors.get(userId) ?? null;
  };

  for (const c of batch) {
    const principal = (await actorOf(c.requestedBy)) ?? (await actorOf(c.decidedBy));
    if (!principal) {
      out.noActor += 1;
      continue;
    }
    try {
      const report = await deps.advance(c, principal);
      out.attempted += 1;
      if (report && report.advanced.length > 0) out.progressed += 1;
      if (report?.state === "complete" && report.advanced.length > 0) out.completed += 1;
      if (report?.error === "completion_failed") {
        out.failed += 1;
        await deps.recordFault(c, "completion_failed").catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ErpRepoControlNotConfiguredError) {
        out.notConfigured += 1;
        continue;
      }
      out.attempted += 1;
      out.failed += 1;
      const name = (err as Error)?.name ?? "error";
      deps.log(`[webdev reconcile] site ${c.id}: attempt failed (${name})`);
      await deps.recordFault(c, `reconcile_failed: ${name}`).catch(() => undefined);
    }
  }
  return out;
}

/**
 * Chained setTimeout (never setInterval — a slow tick cannot overlap the next), the monitoring runner's shape.
 * A failed tick logs and the loop continues. Quiet unless something moved or broke.
 */
export function startProvisionReconcileLoop(
  intervalMs: number,
  firstDelayMs: number = RECONCILE_FIRST_DELAY_MS,
  overrides: Partial<TickDeps> = {},
): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await runProvisionReconcileTick(overrides);
      if (r.progressed > 0 || r.failed > 0 || r.tenantErrors > 0 || r.noActor > 0) {
        // eslint-disable-next-line no-console
        console.log("[webdev reconcile] tick:", r);
      }
    } catch (e) {
      // runProvisionReconcileTick does not throw; this is the guard that keeps a surprise from killing the loop.
      // eslint-disable-next-line no-console
      console.error("[webdev reconcile] tick failed:", (e as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, firstDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** The boot line main.ts logs once. Kept here so the numbers cannot drift from the tunables. */
export function provisionReconcileStartLine(): string {
  return (
    `webdev provisioned-site reconcile on: every ${config.provision.reconcileIntervalMs}ms ` +
    `(batch ${RECONCILE_BATCH}, back-off then stop after ${RECONCILE_STOP_AFTER_MS / HOUR}h per site; PROVISION_RECONCILE_INTERVAL_MS)`
  );
}
