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
 * NOTE for callers: this also clears the D14-05 `deploy.staging`/`deploy.production` entries AND the
 * D14-15 `pm.createTask`/`pm.createDoc` entries registered below (they are all plain calls to
 * `registerExecutableApproval`, no different from a test fixture, once the module has loaded). A
 * test file that needs the deploy pair back after resetting calls `registerCoreExecutableApprovals()`;
 * one that needs the PM pair back calls `registerPmExecutableApprovals()` — either way, do not
 * hand-roll a second copy of their lock/precondition.
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// D14-15 — `pm.createTask` / `pm.createDoc`: the PM module's first two registry entries.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Both tools are thin OBO fronts (`mcp-hub/src/pm-tools.ts`) over platform-nest's own PM endpoints
// (`POST /api/:t/pm/tasks`, `POST /api/:t/pm/projects/:projectId/docs`) — `impact:"low"`, `write:true`,
// allowlisted to `wf:report` only (WD-06's report sink). Before this entry existed, `getExecutable()`
// returning undefined kept every approved PM write permanently `not_applicable` — this is what lets
// one actually execute.
//
// THE J2 BALL-PASS TOOL DOES NOT EXIST YET — it is deliberately NOT registered here. The PM Phase-4
// contract (`docs/superpowers/plans/2026-08-04-pm-repsona-parity-phase4-plan.md`, item `P4-J2`)
// PROPOSES a write-tool set for the hub to ship next — `pm.setStatus`, `pm.passBall`,
// `pm.setDueDate`, `pm.comment` — and calls out `pm.passBall` as "the interesting one" for the
// impact gate. Verified at build time: `mcp-hub/src/pm-tools.ts` registers exactly two tools today,
// `pm.createTask` and `pm.createDoc`; none of the four J2 names exist anywhere in the hub or the
// platform. Registering a name nobody can call is dead configuration — the same reason D14-16 (the
// mail equivalent) was deferred — so only the two real tools are registered below. When
// `pm.passBall` lands, give it its OWN entry with its OWN precondition (a ball-pass is a
// status-transition-adjacent action, not a create — "already passed to this holder" / "task closed"
// are candidate typed refusals, but that is the next ticket's call to make, not this one's to guess).
//
// SCOPE BOUNDARY — READ THIS BEFORE ASSUMING ANY PM WRITE PATH IS WIRED. An earlier draft of this
// comment said these entries "complete the AUTOMATION (n8n) re-drive path". That is **backwards**, and
// the inversion matters, so here is the actual reachability:
//
// Both tools are `impact: "low"` (`mcp-hub/src/pm-tools.ts`), and the D14 gate suspends only
// `tool.write && tool.impact !== "low"` (`mcp-hub/src/policy.ts`). So on the n8n path these tools
// NEVER suspend, never file an `automation_approvals` row, and therefore can never reach this
// registry at all. The schema agrees: `automation_approvals.impact` is
// `CHECK (impact IN ('medium','high','unclassified'))` — a low-impact write cannot even be
// REPRESENTED as a suspended row. Registering them buys the n8n path exactly nothing.
//
// The only path that can reach these entries is the AGENT path, and only if an `AgentDef` declares
// one of these tools as a `high_write`: D14-12's stricter-wins reconciliation would then suspend it
// and file an `origin='agent'` row, which this entry would execute. That is genuinely useful, because
// D14-14's `RERUN_CAPABLE_HIGH_WRITES` allowlist requires TWO things per tool before a `high_write`
// is permitted — a live resolver AND an `approval-executables.ts` entry with a server-side
// precondition. These entries are that second half for PM.
//
// REACHABILITY, CORRECTED 2026-08-06 — one of the two blockers named here is now GONE. The assurance
// ceiling is closed (`mcp-hub/src/principal.ts`'s `elevateAssurance`; design
// docs/superpowers/plans/2026-08-06-assurance-minting-design.md): an agent envelope presented by
// ai-agents or platform-nest, with the platform vouching for it, now mints `"verified"`, so
// `approvals.resolveExecute` clears its `minAssurance` floor and the transport is live.
//
// The REMAINING blocker is the other one, unchanged: no `AgentDef` declares a `high_write` (the guard
// test forbids it while `RERUN_CAPABLE_HIGH_WRITES` is empty). Until one does, nothing files an
// `origin='agent'` row that these entries could execute. So: still do NOT read this as unblocking PM
// Phase-4 J2 — but the reason is now the empty allowlist alone, NOT assurance. Two things follow that
// a future reader would otherwise get wrong: a `requires verified assurance` denial from here is now a
// real misconfiguration (an unset HUB_ASSURANCE_TOKEN — check `/admin/info`'s
// `assuranceElevationConfigured`), not the expected steady state; and adding a `high_write` is now the
// single remaining step, not the first of two.
//
// NO PIPELINE CO-LOCK (stated so nobody adds `lockPipelineRun` here "for safety" later): PM tools
// never read or write `pipeline_runs` / `pipeline_stages` — those are mutated by
// `pipeline.controller.ts` exclusively under `PIPELINE_RUN_LOCK_NS`, which is why `deploy.*` above
// takes that lock. Neither PM entry touches that state, so co-locking it here would only manufacture
// a false dependency between two systems that share nothing.
//
// "project exists and is not archived": `projects.status` (0001_core.sql) is free text with no CHECK
// constraint; `'archived'` is the value the rest of the platform already treats as terminal (see
// `core/portal-workspace.controller.ts`'s own exclusion list). Soft-deleted (`deleted_at IS NOT NULL`)
// and archived are BOTH refused, but with different typed reasons — `project_not_found` vs
// `project_archived` — because they are different facts for a human reading the approval row: one
// means "that project is gone", the other "that project was deliberately closed after this write was
// filed and someone should look at why".
//
// "target status/board still valid": NOT a live branch for either entry today. Neither tool's input
// schema (`mcp-hub/src/pm-tools.ts`) accepts a status/board argument: `pm.createTask` always lands on
// the project's own default (first-by-position) status inside `pm.controller.ts#createTask`'s own
// handler, and `pm.createDoc` has no status concept at all. This becomes a real, tested branch once
// `pm.setStatus` (or `pm.passBall`) gets its own entry — noted here so its absence reads as a
// deliberate scope call, not an oversight.
//
// "assignee still a member" (`assignee_gone`): only `pm.createTask` can name one
// (`assigneeUserId`) — `pm.createDoc` has no assignee field, so its precondition never runs this
// check. Reused verbatim from `pm.controller.ts`'s own `addContributor` membership check
// (`SELECT 1 FROM company_memberships WHERE user_id = $1 AND deleted_at IS NULL AND status =
// 'active'`, scoped by the surrounding `withTenants` RLS context rather than a second `tenant_id`
// filter) — not reimplemented. A present-but-departed assignee REFUSES rather than silently creating
// the task unassigned: the approval was filed to assign a named person, and creating it anyway would
// misrepresent what was approved (the WD-29 lesson: never let a stale snapshot's intent quietly
// mutate into something else at execution time).
//
// LOCK KEY: the PM project id extracted from `tool_args.projectId` — the one unit of consistency both
// tools' approvals for the SAME project contend over (mirrors `deployLockKey`'s runId choice above).
// Shared, unprefixed, across `pm.createTask` and `pm.createDoc` for a VALID id (two writes into the
// same project are exactly the case worth serializing); a missing/malformed id falls back to a
// tool-prefixed key of the raw args so no two distinct malformed calls — and no two distinct tools'
// malformed calls — ever collapse onto one shared constant lock.

function extractPmProjectId(toolArgs: Record<string, unknown>): string | null {
  const v = toolArgs?.projectId;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function pmLockKey(toolArgs: Record<string, unknown>, toolName: string): string {
  const projectId = extractPmProjectId(toolArgs);
  if (projectId) return projectId;
  return `${toolName}:invalid-project-id:${JSON.stringify(toolArgs)}`;
}

/** Shared "project still exists and is not archived" check both PM preconditions start with.
 *  Never writes; only reads. A missing/malformed `projectId` fails closed as `project_not_found`
 *  rather than throwing — there is no project to re-evaluate against. */
async function pmProjectPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const projectId = extractPmProjectId(toolArgs);
  if (!projectId) return { ok: false, reason: "project_not_found" };
  const project = await client.query<{ status: string }>(
    `SELECT status FROM projects WHERE id = $1 AND deleted_at IS NULL`,
    [projectId],
  );
  const row = project.rows[0];
  if (!row) return { ok: false, reason: "project_not_found" };
  if (row.status === "archived") return { ok: false, reason: "project_archived" };
  return { ok: true };
}

function extractPmAssigneeUserId(toolArgs: Record<string, unknown>): string | null {
  const v = toolArgs?.assigneeUserId;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

async function pmCreateTaskPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const projectVerdict = await pmProjectPrecondition(client, toolArgs);
  if (!projectVerdict.ok) return projectVerdict;
  const assigneeUserId = extractPmAssigneeUserId(toolArgs);
  if (!assigneeUserId) return { ok: true };
  // Same membership predicate as pm.controller.ts's own addContributor guard — reused, not
  // reimplemented. Scoped by the surrounding withTenants() RLS context, same as that call site.
  const member = await client.query(
    `SELECT 1 FROM company_memberships WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'`,
    [assigneeUserId],
  );
  if (!member.rows[0]) return { ok: false, reason: "assignee_gone" };
  return { ok: true };
}

/**
 * Registers `pm.createTask` and `pm.createDoc`. Exported for the same reason
 * `registerCoreExecutableApprovals` is: a test file that calls `resetExecutableApprovals()` and wants
 * these two back afterward should call this rather than hand-roll a second copy of their
 * lock/precondition. `resetExecutableApprovals()` clears these along with the deploy entries — same
 * note applies as that function's own doc.
 */
export function registerPmExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "pm.createTask",
    lockKey: (args) => pmLockKey(args, "pm.createTask"),
    precondition: pmCreateTaskPrecondition,
  });
  registerExecutableApproval({
    toolName: "pm.createDoc",
    lockKey: (args) => pmLockKey(args, "pm.createDoc"),
    precondition: pmProjectPrecondition,
  });
}

registerPmExecutableApprovals();

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// D14-17 — Assistant write-tool entries (Phase-6 v1 proposal set): EVALUATED, ZERO NET-NEW ENTRIES.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// This ticket's own instruction (docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md,
// "D14-17") is: derive the tool list from the assistant broker's REAL capability surface, not from
// guesswork, and report an empty finding honestly rather than inventing tools to justify the ticket.
// The finding, with the evidence that makes it falsifiable:
//
//   1. `modules/assistant/broker.ts`'s `ASSISTANT_AGENT_TOOLS` is the broker's ENTIRE tool universe —
//      `runToolTurn` refuses any `agent` not present as a key of that map before it ever contacts the
//      runner (`if (!required) return { outcome: "error", errorKind: "unknown_agent" }`). Today it has
//      exactly two entries, BOTH read-only: `"status-reporter": ["projects.list", "tasks.list"]` and
//      `"approvals-chaser": ["agency.pendingApprovals"]`. Neither AgentDef the broker can drive holds
//      any write tool at all, let alone a `high_write` one.
//   2. `ai-agents/src/specialists.ts` has exactly THREE AgentDefs. `taskTriager` — the repo's only
//      write-capable specialist (`tasks.update`, `low_write`) — is NOT reachable through the broker: it
//      lives in `writeSpecialists`, not `specialists`, and `ASSISTANT_AGENT_TOOLS` names neither map.
//      So even the one write ai-agents can do anywhere is structurally unreachable from a chat turn.
//   3. `ai-agents/src/agent-write-guard.test.ts`'s `RERUN_CAPABLE_HIGH_WRITES` allowlist — the CI-
//      enforced set of tool names ANY AgentDef anywhere is permitted to declare `high_write` — is
//      `[]`. The guard test structurally fails the build the moment any AgentDef (assistant-driven or
//      not) declares a `high_write` outside that (currently empty) allowlist. A `high_write` is the
//      ONLY thing that ever files an `origin='agent'` proposal in the first place (`agent.ts`'s write
//      gate); a `low_write` executes immediately and never reaches this registry.
//
// CONCLUSION: the assistant's proposable write-tool surface is EMPTY today, by construction, enforced
// in a different project's CI guard (2 above) that this ticket must not weaken. There is therefore
// nothing net-new to register here. The ticket's fallback instruction — "the v1 set fully reuses
// D14-15's PM entries" — is satisfied exactly as written: `pm.createTask` / `pm.createDoc` are already
// registered above (D14-15) and need no change; the moment some future AgentDef the broker can drive
// declares one of them (or any other tool) as `high_write`, D14-12's stricter-wins reconciliation would
// treat it as high-impact and file an `origin='agent'` row, and THIS registry (unchanged) is what would
// let it execute — that is future work for whichever ticket adds that AgentDef, not this one.
//
// Regression coverage for this finding lives in `d14-17-assistant-write-registry.test.ts`: it pins the
// broker's read-only tool surface, proves a representative unregistered "assistant write" tool name
// stays `execution_status='not_applicable'` and never auto-executes (both directions — see that file),
// and documents why no Cerbos `resource_mcp_tool.yaml` change accompanies this entry (that file's own
// D14-17 note explains the same finding from the policy side).
//
// MONEY TOOLS REMAIN PERMANENTLY BARRED (restated, per this ticket's explicit instruction): nothing in
// this section registers, or ever may register, `search.setBudget` / `search.applyNegatives` /
// `search.launchCampaign` (SM-55 / architect ruling A13) — see this file's header doctrine. VER-01
// verified `search.setBudget` stays `not_applicable` even after a human approves it; nothing here
// changes that.
