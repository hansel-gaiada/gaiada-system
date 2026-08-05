// D14-02 — the executable-approval registry SKELETON (types + registration only). D14-03 extends
// each entry with `precondition(client, toolArgs)` and `lockKey(toolArgs)` and builds the executor
// that actually re-drives the tool call through the hub as the original filing principal. This
// file's only job today is the REGISTRY SEAM: `AutomationApprovalsController.decide()` (both decide
// surfaces — the façade delegates to that same method, never reimplements it) consults
// `getExecutable(toolName)` to decide whether an approved row's `execution_status` becomes
// 'pending'. See that method for the full eligibility rule.
//
// REGISTRY DOCTRINE (binding for every future ticket that adds an entry, starting with D14-05):
//   - Additions are deliberate, one per ticket, each carrying its own precondition. There is NO
//     generic "call any MCP tool by name" bridge here — that would turn this file into an
//     unattended command dispatcher gated only by the impact-suspend branch, which is exactly the
//     failure mode the program exists to avoid.
//   - Money-spending tools are PERMANENTLY BARRED. `search.setBudget`, `search.applyNegatives`,
//     `search.launchCampaign` (sem-apply.ts's own header, SM-55/A13) must NEVER be registered here:
//     doing so would both double-apply against sem-apply's caller-re-driven apply path AND spend a
//     client's real ad budget with no human present at execution time. If a future reviewer
//     proposes registering one of these tool names, that proposal is the bug, not a missing feature.
//   - An absent entry is the SAFE default. `getExecutable()` returning undefined is what keeps
//     `origin='hr'` (modules/hr/leave-decision.ts's own domain mutation on the decided event) and
//     the search apply path (caller-re-driven, no decided-event handler by design) untouched by this
//     program — migration 0078's own header states this is load-bearing, not incidental.
//
// D14-03 EXTENSION — every entry now also carries the two things the executor cannot invent for it:
// a `lockKey` (what to serialize on) and a `precondition` (what must STILL be true at execution
// time). See `PreconditionVerdict` below and `core/approval-execute.ts`'s header for why the lock
// alone is not the fix.
import type { PoolClient } from "pg";
import { lockPipelineRun } from "./pipeline-lock";

/** The result of a server-side precondition re-evaluation. `reason` is a TYPED token (snake_case,
 *  e.g. `run_blocked`, `stage_already_deployed`, `run_not_found`) — it is stored verbatim after the
 *  `precondition_failed: ` prefix in `automation_approvals.execution_error` and surfaces in the UI
 *  and in a notification, so treat it as a contract, not a log message. Never put user text,
 *  identifiers or secrets in it. */
export type PreconditionVerdict = { ok: true } | { ok: false; reason: string };

export interface ExecutableApprovalEntry {
  /** The MCP tool name this entry authorizes auto-execution for — identical to the string stored on
   *  `automation_approvals.tool_name`. Kept on the entry (not just the map key) so callers that hold
   *  an entry retrieved by a different lookup path can still see which tool it is. */
  toolName: string;

  /**
   * The advisory-lock key for ONE unit of consistency this tool's approvals contend over — for
   * `deploy.*` that is the pipeline run id extracted from `toolArgs` (D14-05), NOT the tenant and
   * NOT the approval id.
   *
   *  - Keying on the APPROVAL ID would be useless: the single-use `pending -> executing` claim
   *    already serializes one row against itself. The lock exists to serialize this approval
   *    against a DIFFERENT writer of the same domain state (an n8n pipeline decision, a second
   *    approval filed for the same run).
   *  - Keying on the TENANT would serialize every approval in the deployment behind every other
   *    (see `core/pipeline-lock.ts`'s "LOCK SCOPE" note — in this deployment nearly all rows are one
   *    tenant's).
   *
   * Must be a pure function of `toolArgs` and stable across attempts: a retry re-derives it and must
   * land on the same key. `hashtext` is 32-bit, so distinct keys can collide and serialize
   * unnecessarily — correctness-safe, and the same trade-off the rest of the platform accepts.
   */
  lockKey(toolArgs: Record<string, unknown>): string;

  /**
   * Re-evaluate, SERVER-SIDE and under the lock, the state the approval was filed against. Called
   * on `client` — a connection already inside the executor's `withTenants` transaction that holds
   * `pg_advisory_xact_lock(hashtext(lockKey(toolArgs)))`, so reads here are atomic with respect to
   * any other holder of that key.
   *
   * This is the WD-29 lesson restated: the lock is only the enabling half. A decision minted from a
   * snapshot read minutes ago (here: whenever the human clicked Approve) must be re-derived from
   * current state, or the loser of a race happily re-applies something already applied. A verdict of
   * `{ ok: false }` means the executor NEVER calls the hub — no tool call, no grant spent.
   *
   * Must not write. Must not call out over the network (it runs inside an open transaction).
   */
  precondition(client: PoolClient, toolArgs: Record<string, unknown>): Promise<PreconditionVerdict>;
}

/**
 * What a caller HANDS to `registerExecutableApproval`. `lockKey`/`precondition` are optional HERE
 * and required on the stored entry, and that asymmetry is deliberate:
 *
 *  - Every real entry (D14-05 onward) MUST supply both. The doctrine above is not satisfied by a
 *    tool name alone.
 *  - D14-02's registry skeleton shipped before those two fields existed, and its suites register
 *    name-only fixture entries. Rather than let a missing precondition mean "no precondition to
 *    check" — an unguarded auto-execute, the single worst outcome available in this file — an
 *    omitted `precondition` is normalized to one that REFUSES with `no_precondition_registered`.
 *    An incomplete entry is therefore inert and loud (the row lands `failed` with that typed reason
 *    and notifies), never silently executable.
 */
export type ExecutableApprovalInput = Pick<ExecutableApprovalEntry, "toolName"> &
  Partial<Pick<ExecutableApprovalEntry, "lockKey" | "precondition">>;

const registry = new Map<string, ExecutableApprovalEntry>();

/** The typed refusal reason a name-only registration produces (see `ExecutableApprovalInput`). */
export const NO_PRECONDITION_REASON = "no_precondition_registered";

/**
 * Register an executable-approval entry. Throws on a duplicate `toolName` — registration is
 * deliberate and one-shot per tool (see the file header's doctrine), never a silent overwrite that
 * could let a later, weaker registration replace an earlier precondition unnoticed.
 */
export function registerExecutableApproval(entry: ExecutableApprovalInput): void {
  if (registry.has(entry.toolName)) {
    throw new Error(`executable approval already registered for tool '${entry.toolName}'`);
  }
  registry.set(entry.toolName, {
    toolName: entry.toolName,
    // Fail-closed defaults, never permissive ones. The lock key falls back to the tool name (so the
    // lock is still taken and still real), and the precondition refuses outright.
    lockKey: entry.lockKey ?? (() => `executable-approval:${entry.toolName}`),
    precondition: entry.precondition ?? (async () => ({ ok: false, reason: NO_PRECONDITION_REASON })),
  });
}

/**
 * Looked up by `automation_approvals.tool_name` at decide time (both decide surfaces, D14-02) and
 * again by the executor at execution time (D14-03). Returns undefined for any tool not deliberately
 * registered — the safe default that keeps every non-registered row `execution_status='not_applicable'`
 * forever, regardless of origin.
 */
export function getExecutable(toolName: string): ExecutableApprovalEntry | undefined {
  return registry.get(toolName);
}

/**
 * Test-only reset, mirroring `modules/registry.ts`'s `resetModules()` — clears the in-memory map so
 * test files that register their own fixture entries don't collide with entries left over from a
 * prior test run in the same process.
 *
 * NOTE for callers: this also clears the D14-05 `deploy.staging`/`deploy.production` entries
 * registered below (they are a plain call to `registerExecutableApproval`, no different from a test
 * fixture, once the module has loaded). A test file that needs them back after resetting calls
 * `registerCoreExecutableApprovals()` — do not hand-roll a second copy of their lock/precondition.
 */
export function resetExecutableApprovals(): void {
  registry.clear();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// D14-05 — `deploy.staging` / `deploy.production`: the WD-08 dead end's first two registry entries.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Both tools are defined in `mcp-hub/src/delivery-tools.ts`. `deploy.staging` is `impact:"low"` and,
// per that file's own header, an UNCONDITIONAL dispatch with no dedupe key of its own — the precondition
// below is the only thing standing between a stale approval and a duplicate/late redeploy.
// `deploy.production` is `impact:"high"`. This comment previously said an `origin='automation'`
// re-drive was denied end-to-end under Cerbos until D14-13 landed. **D14-13 HAS LANDED** (2026-08-05):
// `cerbos/policies/resource_mcp_tool.yaml`'s impact conjunct now admits a verified-grant call whose
// tool is in the executable list `["deploy.staging","deploy.production"]`, and the hub passes the
// verified `approvalId` from the branded grant only. So that window is CLOSED — both tools execute for
// `origin='automation'` as well as `origin='agent'`. Verified live by the D14-09 gate (an ALLOW
// dispatch, plus negative cases: workflow-unscoped ⇒ deny, tool-off-list ⇒ deny, forged/non-string
// `approvalId` ⇒ deny).
//
// WHAT "the run/stage is still in the state the deploy was filed against" MEANS HERE: each tool
// corresponds 1:1 to a SINGLE-SHOT pipeline stage of the SAME name — `pipeline.controller.ts`'s
// `SINGLE_SHOT_STAGE_NAMES` already lists `'staging'` and `'production'` under track `'delivery'`
// (the WD-29 precedent this entry REUSES rather than reimplements: same "created at most once per
// run" semantics `existingStageForRepeatedCreate` already enforces for stage-creation). "Still
// awaiting this deploy" therefore means: no stage row for that name yet (this is the first attempt),
// or a stage row exists but is not yet `'done'`. `'done'` means a PRIOR dispatch already landed — a
// second approved row reaching execution for the same run+stage is a decision made from a snapshot
// that predates that landing (the human clicked Approve before, or concurrently with, the deploy that
// already went out), and re-dispatching would silently redeploy on every retriggered/duplicate
// approval. Run-level: a run whose status is `'blocked'` (parked by WD-05's escalation path) or
// `'complete'` (the run's work is already over) can never legitimately want a NEW deploy dispatched
// against it — both map to the single typed reason `run_blocked`.
//
// WHY THIS ENTRY TAKES `lockPipelineRun` (decided deliberately, per the ticket's instruction to state
// the choice): the precondition reads `pipeline_runs.status` and `pipeline_stages.status`, and BOTH
// are mutated by `pipeline.controller.ts` UNDER `lockPipelineRun` (`updateRun`'s park-to-`'blocked'`,
// `updateStage`'s status transitions, `decideGate`'s downstream effects). `APPROVAL_EXEC_LOCK_NS`
// (`approval-execute.ts`) is a DIFFERENT advisory-lock namespace from `PIPELINE_RUN_LOCK_NS`
// (`pipeline-lock.ts`) — holding the approval-exec lock alone does NOT serialize against a concurrent
// pipeline-controller write. Reading run/stage status without also taking the pipeline lock would be
// exactly the read-then-act TOCTOU gap WD-29 closed for `pipeline.controller.ts` itself, reopened here
// for a second writer of the same state. So `lockPipelineRun(client, runId)` is the FIRST statement,
// before any read the verdict depends on — the exact ordering `pipeline-lock.ts`'s own doc requires.
//
// LOCK KEY (`APPROVAL_EXEC_LOCK_NS`'s key — NOT the pipeline lock taken above): the pipeline run id
// extracted from `tool_args.runId`. A MISSING or non-string `runId` fails closed: the precondition
// refuses with `run_not_found` (there is no run to check against, and `lockPipelineRun` needs a real
// id to be meaningful) — but the LOCK KEY must not collapse every malformed call onto one shared
// constant: a bare literal like `"deploy.staging"` would serialize every bad-input approval for this
// tool behind a SINGLE advisory lock for no benefit (the refusal doesn't need serialization — it
// needs to never reach the hub, which the precondition already guarantees on its own). The fallback
// below keys on the tool's own name plus the raw invalid args, which is still a pure, stable function
// of `toolArgs` (same malformed input -> same key, satisfying the retry requirement) and only
// collides for byte-identical malformed payloads of the SAME tool — never across the whole registry.

function extractRunId(toolArgs: Record<string, unknown>): string | null {
  const v = toolArgs?.runId;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function deployLockKey(toolArgs: Record<string, unknown>, toolName: string): string {
  const runId = extractRunId(toolArgs);
  if (runId) return runId;
  return `${toolName}:invalid-run-id:${JSON.stringify(toolArgs)}`;
}

/** Shared precondition body for both `deploy.*` entries — the target SINGLE-SHOT stage name is the
 *  only thing that differs between them. Never writes; only reads under the pipeline-run lock. */
async function deployPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
  stageName: "staging" | "production",
): Promise<PreconditionVerdict> {
  const runId = extractRunId(toolArgs);
  // Fail closed on a missing/malformed runId: there is no run to re-evaluate against, and reusing
  // `run_not_found` (rather than inventing a fourth typed reason) is deliberate — "the id in this
  // approval's args does not resolve to a run" is true whether the id is absent, the wrong type, or
  // simply unknown to this tenant.
  if (!runId) return { ok: false, reason: "run_not_found" };

  await lockPipelineRun(client, runId);

  const run = await client.query<{ status: string }>(
    `SELECT status FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`,
    [runId],
  );
  const runRow = run.rows[0];
  if (!runRow) return { ok: false, reason: "run_not_found" };
  if (runRow.status === "blocked" || runRow.status === "complete") {
    return { ok: false, reason: "run_blocked" };
  }

  const stage = await client.query<{ status: string }>(
    `SELECT status FROM pipeline_stages WHERE run_id = $1 AND track = 'delivery' AND name = $2
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    [runId, stageName],
  );
  if (stage.rows[0]?.status === "done") {
    return { ok: false, reason: "stage_already_deployed" };
  }

  return { ok: true };
}

/**
 * Registers `deploy.staging` and `deploy.production`. Exported (rather than left as a bare top-level
 * side effect only) so a test file that calls `resetExecutableApprovals()` can restore exactly these
 * two entries afterward without re-deriving their lock/precondition — see the doc on
 * `resetExecutableApprovals` above. Also called once at module load, below, so production boot needs
 * no separate wiring (main.ts already loads this module transitively via `approval-execute.ts` and
 * `automation-approvals.controller.ts`).
 */
export function registerCoreExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "deploy.staging",
    lockKey: (args) => deployLockKey(args, "deploy.staging"),
    precondition: (client, args) => deployPrecondition(client, args, "staging"),
  });
  registerExecutableApproval({
    toolName: "deploy.production",
    lockKey: (args) => deployLockKey(args, "deploy.production"),
    precondition: (client, args) => deployPrecondition(client, args, "production"),
  });
}

registerCoreExecutableApprovals();
