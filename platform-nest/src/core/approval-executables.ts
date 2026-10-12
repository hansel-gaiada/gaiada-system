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
import { evaluateProvisionPrecondition } from "../modules/webdev/provisioning.service";
// SMM-09 — see this file's own SMM-09 section, at the bottom, for the reasoning behind every one of
// these four. Same siting as PRV-03's import above: the domain rules live in the module.
import {
  SOCIAL_PUBLISH_TOOL,
  SOCIAL_PUBLISH_METERED_TOOL,
  publishLockKey,
} from "../modules/social/publish-precondition";
// SMM-31 — the client-review gate, composed IN FRONT of the six-stage chain (never inside it — see
// that file's header for why `PUBLISH_PRECONDITION_STAGES` stays untouched).
import { evaluatePublishPreconditionWithClientReview } from "../modules/social/client-review";
// SMM-17 — the reply gate, built by reusing SMM-09's pattern rather than reinventing it. See this
// file's own SMM-17 section, below the SMM-09 one, for the full reasoning.
import { SOCIAL_REPLY_TOOL, replyLockKey, evaluateReplyPrecondition } from "../modules/social/reply-precondition";
// SMM-35 — the assistant's first social write proposal, `social.createReplyDraft`. See this file's
// own SMM-35 section, below the SMM-17 one, for the full reasoning. `declareSocialModuleScope` is
// the SAME self-declaration every other social precondition in this file already makes (imported
// from the leaf module directly, rather than through publish-precondition.ts's re-export, since this
// entry has no other reason to depend on that file).
import { declareSocialModuleScope } from "../modules/social/module-scope";
// SMM-22 — the config-gated bar lift for social.publishPostMetered. See this file's own SMM-22
// section for the full reasoning; `resolveXPricing` is the money guard the boot check verifies.
import { config } from "../config";
import { readIssueReadiness } from "../modules/invoice/issue";
import { NotFoundException } from "@nestjs/common";
import { resolveXPricing } from "../modules/social/usage-ledger";
import { EditorialScopeError, isEditorialRole, normaliseEditorialScope } from "../rbac/editorial-roles";

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

  /**
   * SMM-09 — opt OUT of `core/approval-execute.ts`'s bounded in-invocation auto-retry, entirely and
   * regardless of the tenant's `automation.approvalRetry.autoRetryCount` setting.
   *
   * Default `false` (absent), which preserves the existing behaviour for every entry that shipped
   * before this field: the tenant setting decides, and 0 (manual retry only) is already that
   * setting's own default.
   *
   * WHY AN ENTRY WOULD SET IT. The executor's auto-retry is safe for a tool whose precondition can
   * DETECT a first attempt that landed — `deploy.*` re-reads the stage's `done` status, so a retry
   * after a lost response refuses instead of redeploying. For an OUTBOUND-PUBLIC action there is no
   * such observation available in the ambiguous window: a `hub_unreachable` (no verdict obtained,
   * the call may or may not have landed) or a `tool_error` (may have partially applied) on a publish
   * means the post may ALREADY BE ON A CLIENT'S PUBLIC FEED while our row says nothing landed. The
   * one thing that must not happen next is an unattended second attempt.
   *
   * So a publish surfaces for HUMAN resolution instead: the row lands `failed` with its typed error,
   * both principals are notified at severity `warning`, and D14-07's retry endpoint is the only way
   * forward — a human decision, re-earning the right through a fresh lock + precondition. That is
   * the same doctrine `approval-execute.ts`'s header already states for the crash-wedge case ("the
   * platform cannot know whether a call whose response was lost actually landed, so unwedging
   * automatically would be a coin-flip on double-execution"), applied to the retry loop for the one
   * class of tool where the coin-flip is public and irreversible.
   */
  neverAutoRetry?: boolean;

  /**
   * P2-07 — module keys this entry's `precondition` needs in scope to see its own tables.
   *
   * ⚠ THIS FIELD EXISTS BECAUSE ITS ABSENCE IS SILENT, AND SILENT IN THE PERMISSIVE DIRECTION.
   * `core/approval-execute.ts` opens its claim transaction as `withTenants([tenantId], …)` with no
   * `modules` — correct for every entry that shipped before this one, because `pipeline_runs`,
   * `pipeline_gates` and friends are CORE tables with a plain `tenant_isolation` policy. A
   * MODULE-OWNED table composes its policy as `tenant_id = ANY(app_current_tenants()) AND
   * app_module_allowed('<mod>')`, and with `app.scopes` unset that second conjunct is FALSE — so the
   * precondition reads ZERO ROWS and gets no error (db/index.ts's WithTenantsOptions note; the
   * estate's [migration-backfill-rls-trap]).
   *
   * Zero rows is not a neutral failure for a precondition. `hr.hireEmployee`'s guard is
   * "does a live employee with this work email already exist?" — under an unset scope the answer is
   * always no, so the ONE check that stops an approved hire from being applied twice would pass
   * every time, and the tool whose retry it protects is the one that creates a person. The
   * transfer/terminate guards fail the other way (always `employee_not_found`), which is safe but
   * makes the tools permanently inert. Both shapes are invisible in a test that stubs the client.
   *
   * Set as `SET LOCAL`-scoped `app.scopes` immediately before the precondition runs, so it lasts
   * exactly the transaction that needs it and never leaks to the next borrower of that pooled
   * connection. Declared on the ENTRY rather than set from inside a precondition deliberately: the
   * executor owns the transaction, and a precondition that quietly widened its own visibility would
   * put an RLS decision in the least visible place available.
   */
  preconditionModules?: string[];

  /**
   * PV3 follow-up (2026-10-12) — a separation-of-duties check on the human who APPROVES, not on the
   * principal who executes.
   *
   * Invariant 1 of `core/approval-execute.ts` re-drives an approved call as the ORIGINAL FILING
   * PRINCIPAL. That is right for authority, and it is also why a route's maker-checker rule cannot see
   * the approver: the route compares its own "maker" column with the FILER. For
   * `invoicePayments.decide` that meant the person who recorded a payment could approve an agent's
   * request to confirm it, and the payment was confirmed by its own recorder, one step removed. The
   * route never learns who lifted the gate, so the rule has to be stated here, where the approver is
   * known.
   *
   * Called twice, both times inside a `withTenants` transaction for the approval's own tenant, with
   * `preconditionModules` in scope:
   *   1. by `AutomationApprovalsController.decide()` (the ONE decide surface for automation/agent rows;
   *      the `/approvals/:id/decide` façade delegates to it) BEFORE the decide UPDATE, with the
   *      deciding principal (and the human an `actFor` call acts for). A refusal is a 403 carrying the
   *      typed `reason`; the row stays `pending` and nothing executes.
   *   2. by the executor's claim transaction, against the row's stored `decided_by`, so a row that
   *      reached `approved` any other way (a future decide surface, a hand edit, a D14-07 retry of a row
   *      decided before this check existed) is refused as well. There the row lands `failed` with
   *      `approver_refused: <reason>` and the hub is never called.
   *
   * It is NOT a second authorization of the call: Cerbos still runs for real at execution, as the
   * filer. It answers only "may THIS human be the one who lets it through?". Same rules as
   * `precondition`: a typed snake_case reason, no writes, no network. Absent = no approver rule, which
   * is every entry that shipped before this field.
   */
  approverCheck?(
    client: PoolClient,
    toolArgs: Record<string, unknown>,
    approver: ApprovalApprover,
  ): Promise<PreconditionVerdict>;
}

/** Who approved (or is approving) a D14 row. `actForUserId` is set when the decide call itself arrived
 *  as a delegated (`x-act-for`) call, so a rule can refuse if EITHER human is the excluded one. */
export interface ApprovalApprover {
  userId: string;
  actForUserId?: string;
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
  Partial<Pick<ExecutableApprovalEntry, "lockKey" | "precondition" | "neverAutoRetry" | "preconditionModules" | "approverCheck">>;

const registry = new Map<string, ExecutableApprovalEntry>();

/** The typed refusal reason a name-only registration produces (see `ExecutableApprovalInput`). */
export const NO_PRECONDITION_REASON = "no_precondition_registered";

/**
 * Register an executable-approval entry. Throws on a duplicate `toolName` — registration is
 * deliberate and one-shot per tool (see the file header's doctrine), never a silent overwrite that
 * could let a later, weaker registration replace an earlier precondition unnoticed. Also throws for
 * a tool that is BARRED (see `registerBarredExecutable` below): a bar is a decision, and a later
 * ticket must not be able to un-make it by adding an entry.
 */
export function registerExecutableApproval(entry: ExecutableApprovalInput): void {
  if (registry.has(entry.toolName)) {
    throw new Error(`executable approval already registered for tool '${entry.toolName}'`);
  }
  if (barred.has(entry.toolName)) {
    throw new Error(
      `tool '${entry.toolName}' is BARRED from executable approval (${barred.get(entry.toolName)!.reason}) `
      + "— registering it would undo a deliberate bar; if the bar is genuinely wrong, remove the "
      + "registerBarredExecutable() call in the same change and say why",
    );
  }
  registry.set(entry.toolName, {
    toolName: entry.toolName,
    // Fail-closed defaults, never permissive ones. The lock key falls back to the tool name (so the
    // lock is still taken and still real), and the precondition refuses outright.
    lockKey: entry.lockKey ?? (() => `executable-approval:${entry.toolName}`),
    precondition: entry.precondition ?? (async () => ({ ok: false, reason: NO_PRECONDITION_REASON })),
    neverAutoRetry: entry.neverAutoRetry === true,
    // Absent stays absent rather than becoming `[]` — an empty array and an omitted field mean the
    // same thing to the executor, and normalizing would make "declares no modules" and "declares
    // none needed" indistinguishable to anyone auditing the registry.
    ...(entry.preconditionModules?.length ? { preconditionModules: [...entry.preconditionModules] } : {}),
    ...(entry.approverCheck ? { approverCheck: entry.approverCheck } : {}),
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE BARRED LIST — a NEGATIVE registration (SMM-09).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Read this before assuming a barred entry weakens the header's doctrine — it is the opposite.
//
// The doctrine says an absent entry is the SAFE default and money-spending tools must NEVER be
// registered. Both still hold, byte for byte: a barred tool is NOT in the executable map,
// `getExecutable()` returns undefined for it, so both decide surfaces leave its approved rows at
// `execution_status='not_applicable'` FOREVER and the executor fails closed with `not_executable`.
// Nothing about a bar makes a tool more reachable.
//
// What a bar ADDS is that the decision is a FACT IN CODE with a typed reason, rather than an absence
// somebody has to already know about:
//   * `registerExecutableApproval` throws for a barred name, so a future ticket cannot quietly make
//     the twin executable — the bar is enforced, not merely documented in a comment.
//   * `isBarredExecutable(name)` gives the UI, the tool surface and the tests a positive answer to
//     "why can this never auto-execute", instead of an undefined that is indistinguishable from
//     "nobody has got round to it yet".
//
// SMM-09's `social.publishPostMetered` is the first, and it exists for D-14's money split: the free
// path is registry-eligible precisely BECAUSE the metered one is separately named and cannot
// execute. The pre-existing permanent bars (`search.setBudget` / `search.applyNegatives` /
// `search.launchCampaign`, SM-55 / architect ruling A13) are deliberately NOT converted here — that
// is a behaviour-neutral change to another module's contract and belongs to whoever owns it next.

export interface BarredExecutableEntry {
  toolName: string;
  /** A snake_case TOKEN, same contract rules as a `PreconditionVerdict.reason`. */
  reason: string;
  /** Prose for a human reading the registry or a refusal. Never rendered as the token. */
  note: string;
}

const barred = new Map<string, BarredExecutableEntry>();

/**
 * Record that a tool may NEVER auto-execute on approval. Throws if the name is already registered
 * as executable (a bar must not silently disarm a live entry — remove the registration in the same
 * change) or already barred.
 */
export function registerBarredExecutable(entry: BarredExecutableEntry): void {
  if (registry.has(entry.toolName)) {
    throw new Error(
      `cannot bar '${entry.toolName}': it is already registered as an executable approval — remove `
      + "that registration in the same change if the bar is intended",
    );
  }
  if (barred.has(entry.toolName)) {
    throw new Error(`tool '${entry.toolName}' is already barred`);
  }
  barred.set(entry.toolName, entry);
}

/** The bar entry for `toolName`, or undefined. */
export function getBarredExecutable(toolName: string): BarredExecutableEntry | undefined {
  return barred.get(toolName);
}

/**
 * SMM-22 — THE ONE DELIBERATE WAY A BAR MAY BE LIFTED. Every other rule in this file stands: a bar
 * is a decision, `registerExecutableApproval` still throws for a barred name (this function is what
 * makes a name STOP being barred, not a bypass of that check), and this must be called ONLY from a
 * config-gated call site that has ALREADY verified the money guards a bar exists to protect — see
 * `registerSocialMeteredExecutableApprovalIfEnabled` below for the one caller.
 *
 * No-op if the name was never barred (idempotent for the same reason `resetExecutableApprovals`'s
 * clear operations are — a boot-time call site may run more than once in a test process).
 */
export function liftBarredExecutable(toolName: string): void {
  barred.delete(toolName);
}

export function isBarredExecutable(toolName: string): boolean {
  return barred.has(toolName);
}

/** Every bar, for a status/registry surface. Copy, never the live map. */
export function listBarredExecutables(): BarredExecutableEntry[] {
  return [...barred.values()];
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
 * NOTE for callers: this also clears the D14-05 `deploy.staging`/`deploy.production` entries, the
 * D14-15 `pm.createTask`/`pm.createDoc` entries, the PRV-03 `webdev.provisionSite` entry, the
 * SMM-09 `social.publishPost` entry + its `social.publishPostMetered` BAR, AND the SMM-17
 * `social.sendReply` entry registered below (they are all plain calls to
 * `registerExecutableApproval`/`registerBarredExecutable`, no different from a test fixture, once
 * the module has loaded).
 *
 * ⚠ TO RESTORE, CALL `registerAllExecutableApprovals()` — the same function production boot uses.
 * This doc used to enumerate the individual bootstraps to call back, and it went stale: it named
 * three of the nine, so suites restored a partial registry and every LATER suite in the same vitest
 * worker inherited the gap. That is what broke D14-17 (A1) on main (2026-08-23). Do not re-introduce
 * a hand-written list here; there is exactly one, at the bottom of this file.
 *
 * The per-area bootstraps stay exported for the narrow case of a suite that deliberately wants ONLY
 * its own area registered (and is the last word on the registry for its worker). If you are not sure
 * you want that, you want `registerAllExecutableApprovals()`.
 *
 * ⚠ It clears the BARRED map too. That is the right direction for a test seam (a leftover bar would
 * make an unrelated suite's registration throw), and it is safe because the bar's real enforcement
 * is the empty executable map, not the bar itself: a cleared registry executes nothing at all.
 */
export function resetExecutableApprovals(): void {
  registry.clear();
  barred.clear();
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PRV-03 — `webdev.provisionSite`: the provision<->ERP seam's one registry entry.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/blueprints/provision-erp-seam-design.md §04 (idempotency/precondition), §06 (D14
// integration point), §09 D-P5/D-P3. The tool is defined in `modules/webdev/index.ts`
// (`write:true`, `impact:"medium"`) and dispatched by `modules/webdev/webdev.controller.ts` ->
// `provisioning.service.ts#provisionSite`. It creates PUBLIC infrastructure — a private repo under
// `Gaia-Digital-Agency`, a `/var/www/<slug>` directory, an nginx vhost, a Let's Encrypt cert — so an
// `origin='automation'` re-drive needs BOTH this entry (D14's in-code half) AND the
// `resource_mcp_tool.yaml` executable-list entry (Cerbos's independent half, PRV-03's own note
// there) before it can execute at all. Absent either one, an approved row stays `failed` — the safe
// direction, never a silent unattended-dispatch.
//
// WHAT THIS PRECONDITION CHECKS, AND WHY IT IS NARROWER THAN `provisionSite`'s OWN RE-CHECK — READ
// THIS BEFORE ASSUMING A ROW-EXISTENCE CHECK IS MISSING. `provisioning.service.ts` exports
// `evaluateProvisionPrecondition(client, runId, opts)` PRECISELY so this entry could re-derive it
// verbatim rather than re-implementing a second copy that could drift from the one the manual/staff
// endpoint path also uses (see that function's own header — it says as much). Called here with
// `requireSignedPrdGate: true`, per its own documented split: the AUTOMATION path (this one) is only
// entitled to propose in the first place because a `prd_sign` gate landed `approved`/`signed`
// (design §04's primary trigger) — re-checking it here closes the window where the gate was
// reopened, reversed, or the run parked `blocked` between proposal and a human clicking Approve
// (which can be minutes, hours, or days later; WD-29's whole lesson is that "fine when approved" is
// not the same claim as "fine now").
//
// The "no existing non-failed mirror row for this run" arm is DELIBERATELY NOT duplicated here, and
// that is not an oversight — `evaluateProvisionPrecondition`'s own header states why: that answer is
// a ROW, not a boolean (the loser of a race is handed the existing site, never an error), so it
// belongs to `provisionSite`'s own LOCK -> re-read -> claim sequence, which is exactly what runs when
// the executor's hub call actually lands (`webdev.controller.ts` -> `provisionSite`). This entry's
// job is narrower and different: decide whether the executor may call the hub AT ALL. Both checks
// run under a lock keyed on the SAME `runId` (this entry via `lockPipelineRun` below, the endpoint's
// own `takeLock` via `lockPipelineRun` too), just in two SEPARATE transactions — the claim
// transaction here commits before the hub call is made (approval-execute.ts's own "TRANSACTION
// BOUNDARY" note: never hold an advisory lock across the network hop back into this same platform),
// so the two checks narrow, but do not eliminate, the same tiny window every other D14 entry accepts
// (`deployPrecondition`'s header note applies verbatim: re-derived is not the same guarantee as
// atomic-with-the-write, and the SECOND, schema-level backstop — `ux_wps_run`/`ux_wps_slug` in 0090
// — is what makes a slipped race land a 409/`existing` outcome rather than a second repo).
//
// LOCK KEY: reuses `deployLockKey` (already generic over `toolName`, despite its name) rather than
// hand-rolling a second copy of "runId, or a tool-prefixed fallback for malformed args" — the exact
// same fail-closed shape `deployLockKey`/`pmLockKey` already established for this file.
function webdevProvisionLockKey(toolArgs: Record<string, unknown>): string {
  return deployLockKey(toolArgs, "webdev.provisionSite");
}

/** The registry precondition. Never writes; only reads (via `evaluateProvisionPrecondition`) under
 *  the pipeline-run lock taken as the FIRST statement — same ordering `deployPrecondition` requires,
 *  for the same reason (`pipeline_runs.status` and `pipeline_gates` are mutated elsewhere under this
 *  exact lock; reading them without it would reopen the WD-29 TOCTOU gap for a second writer). */
async function webdevProvisionPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const runId = extractRunId(toolArgs);
  // Fail closed on a missing/malformed runId: there is no run to lock or re-evaluate against.
  // `run_not_found` matches `evaluateProvisionPrecondition`'s own token for "no such run" — one typed
  // vocabulary, not two spellings of the same fact.
  if (!runId) return { ok: false, reason: "run_not_found" };

  await lockPipelineRun(client, runId);
  const verdict = await evaluateProvisionPrecondition(client, runId, { requireSignedPrdGate: true });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true };
}

/**
 * Registers `webdev.provisionSite`. Exported for the same reason `registerCoreExecutableApprovals`/
 * `registerPmExecutableApprovals` are: a test file that calls `resetExecutableApprovals()` and wants
 * this entry back afterward should call this rather than hand-roll a second copy of its lock/
 * precondition. `resetExecutableApprovals()` clears this along with every other entry — same note
 * applies as `resetExecutableApprovals`'s own doc.
 */
export function registerWebdevExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "webdev.provisionSite",
    lockKey: webdevProvisionLockKey,
    precondition: webdevProvisionPrecondition,
  });
}


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WSK-31 — the §07 WebDesk control-plane commands: `webdesk.schema.apply`, `webdesk.site.provision`,
// `webdesk.deploy.staging` (medium) and `webdesk.site.promote`/`rollback`/`setDomain`,
// `webdesk.key.mint`/`rotate`/`revoke`, `webdesk.site.archive` (HIGH, always-WS4).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/blueprints/webdesk-design.md §07 (impact classes) / §09 (D14 pairing doctrine).
// Every tool is declared in `modules/webdev/index.ts` and dispatched by
// `modules/webdev/webdesk-control.controller.ts`. THE D14 REGISTRY PAIRING DOCTRINE applies here
// exactly as the file header states: a registry entry with no matching Cerbos executable-list entry
// (resource_mcp_tool.yaml) would pass its precondition and then be denied at the door. Both are
// added in this same change.
//
// WHY EVERY PRECONDITION HERE REFUSES, ALWAYS — READ THIS BEFORE ASSUMING IT IS A PLACEHOLDER LEFT
// UNFINISHED. `webdesk-control.controller.ts`'s own endpoints are honest 501 stubs: WSK-23 (the ERP
// module egress client into Zone B) has not landed, so there is genuinely nothing for an approved
// row to execute yet. Leaving these tools OUT of the registry entirely would make an approved row
// sit `not_applicable` forever — indistinguishable from "nobody built the executor" to whoever is
// reading the approval. Registering them WITH a precondition that always names the real, typed
// reason (`webdesk_control_plane_not_wired`) is more honest: the row lands `failed` with a reason
// that says exactly what is missing, not merely that nothing happened. When WSK-23 lands, this
// precondition is the ONE place that needs a real re-check (site/env state, same as
// `webdevProvisionPrecondition` re-derives PRV-03's own state) — nothing about the registrations
// below needs to change shape.
//
// LOCK KEY: `siteId` when the tool args carry one (every §07 command except the two key-lifecycle
// ones, which carry `keyId` instead) — the one unit of consistency two approvals for the SAME site
// (or key) contend over. A missing/malformed id falls back to a tool-prefixed key of the raw args,
// same fail-closed shape `deployLockKey`/`pmLockKey`/`webdevProvisionLockKey` already established.
function webdeskUnitId(toolArgs: Record<string, unknown>): string | null {
  const siteId = toolArgs?.siteId;
  if (typeof siteId === "string" && siteId.trim().length > 0) return siteId;
  const keyId = toolArgs?.keyId;
  if (typeof keyId === "string" && keyId.trim().length > 0) return keyId;
  return null;
}

function webdeskLockKey(toolArgs: Record<string, unknown>, toolName: string): string {
  const unit = webdeskUnitId(toolArgs);
  if (unit) return `webdesk:${unit}`;
  return `${toolName}:invalid-args:${JSON.stringify(toolArgs)}`;
}

/** Always refuses — see the section header above for why that is the honest answer today, not an
 *  unfinished one. Never writes; never calls out over the network (precondition contract). */
async function webdeskNotWiredPrecondition(): Promise<PreconditionVerdict> {
  return { ok: false, reason: "webdesk_control_plane_not_wired" };
}

/** The §07 command names this ticket registers — medium and HIGH writes only.
 *  `webdesk.schema.propose` is deliberately EXCLUDED: it is `impact:"low"` (draft-only by
 *  construction, §07), and a low-impact write never suspends, so it can never reach this registry
 *  at all (same reasoning `pm.createTask`/`pm.createDoc`'s own D14-15 section already states for
 *  their low-impact siblings). The three read tools are excluded for the same reason `pm.listTasks`
 *  etc. need no registry entry: nothing to approve. */
export const WEBDESK_REGISTRY_TOOLS: readonly string[] = [
  "webdesk.schema.apply",
  "webdesk.site.provision",
  "webdesk.deploy.staging",
  "webdesk.site.promote",
  "webdesk.site.rollback",
  "webdesk.site.setDomain",
  "webdesk.key.mint",
  "webdesk.key.rotate",
  "webdesk.key.revoke",
  "webdesk.site.archive",
];

/**
 * Registers the ten §07 medium/HIGH webdesk tools. Exported for the same reason the other
 * bootstraps are: a suite that calls `resetExecutableApprovals()` and wants these back should call
 * this rather than hand-roll a second copy of the lock/precondition.
 */
export function registerWebdeskExecutableApprovals(): void {
  for (const toolName of WEBDESK_REGISTRY_TOOLS) {
    registerExecutableApproval({
      toolName,
      lockKey: (args) => webdeskLockKey(args, toolName),
      // WSK-59: the commands whose routes are now REAL carry a real (structural) precondition (schema.apply,
      // site.provision; key.mint since 2026-10-11; site.archive since 2026-10-12); the other six stay honestly not-wired.
      precondition: WEBDESK_STRUCTURAL_PRECONDITIONS[toolName] ?? webdeskNotWiredPrecondition,
    });
  }
  registerWebdeskContentExecutableApprovals();
  registerWebdeskMediaExecutableApprovals();
  registerWebdeskEditorialExecutableApprovals();
  registerWebdeskContractExecutableApprovals();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WSK-59 — the content editor's MEDIUM tools: `webdesk.content.unpublish` and `webdesk.content.delete`
// (write-plane design §12 WSK-59), plus the real preconditions for `webdesk.schema.apply` and
// `webdesk.site.provision` (their routes stopped being 501 stubs in the same change).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// THE D14 PAIRING. Both halves land together: these entries AND the tool names in
// `cerbos/policies/resource_mcp_tool.yaml`'s executable list. An entry without the Cerbos half passes its
// precondition and is then denied at the hub's door; the Cerbos half without an entry suspends an agent
// and then does nothing on approval (`not_applicable`). `webdesk.content.create/update/restoreVersion/
// requestPublish` are `impact:"low"` and never suspend, so they are in neither (the `webdesk.schema.propose`
// reasoning). There is no publish tool: publish executes only at decide() through WSK-66's in-band path.
//
// THE PRECONDITION IS STRUCTURAL ONLY, ON PURPOSE. Zone B's own guards are the atomic re-check:
// `unpublish` carries `expectedPublishedVersion` (409 `published-version-changed` / `not-live` when the
// world moved since filing) and `delete` carries `baseVersion` (409 `version-conflict`, `item-is-live`).
// Re-deriving those here would need a Zone B read inside an open transaction, which a precondition may not
// do ("must not call out over the network"), and would only be a staler copy of the check Zone B makes
// atomically. What this CAN refuse before the hub is called is a malformed row: the executor never calls
// the hub for it, so no grant is spent.
//
// RE-DRIVE. On approval `approval-execute.ts` re-drives the tool through the hub as the ORIGINAL filing
// principal (its OBO envelope, never the approver's); the platform then runs the same BFF route, so Cerbos
// authorises the requester's CURRENT standing and the editorial assertion is signed for the requester.

const UUID_RE_EXEC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function contentItemArgsOk(a: Record<string, unknown>): string | null {
  if (!nonEmptyString(a.tenantSlug)) return "tenant_slug_invalid";
  if (typeof a.siteId !== "string" || !UUID_RE_EXEC.test(a.siteId)) return "site_id_invalid";
  if (typeof a.itemId !== "string" || !UUID_RE_EXEC.test(a.itemId)) return "item_id_invalid";
  return null;
}

async function webdeskUnpublishPrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  const bad = contentItemArgsOk(a);
  if (bad) return { ok: false, reason: bad };
  const v = a.expectedPublishedVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { ok: false, reason: "expected_published_version_invalid" };
  return { ok: true };
}

async function webdeskDeletePrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  const bad = contentItemArgsOk(a);
  if (bad) return { ok: false, reason: bad };
  const v = a.baseVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { ok: false, reason: "base_version_invalid" };
  return { ok: true };
}

async function webdeskSchemaApplyPrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  if (!nonEmptyString(a.tenantSlug)) return { ok: false, reason: "tenant_slug_invalid" };
  if (typeof a.siteId !== "string" || !UUID_RE_EXEC.test(a.siteId)) return { ok: false, reason: "site_id_invalid" };
  if (!nonEmptyString(a.collectionKey)) return { ok: false, reason: "collection_key_invalid" };
  if (!isRecord(a.schema)) return { ok: false, reason: "schema_invalid" };
  return { ok: true };
}

async function webdeskSiteProvisionPrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  if (!nonEmptyString(a.tenantSlug)) return { ok: false, reason: "tenant_slug_invalid" };
  if (a.kind !== "astro" && a.kind !== "node" && a.kind !== "wp") return { ok: false, reason: "kind_invalid" };
  if (!nonEmptyString(a.name)) return { ok: false, reason: "name_invalid" };
  return { ok: true };
}

/** 2026-10-11: `POST control/sites/:siteId/keys` stopped being a 501 stub. What it does on a re-drive is FILE a
 *  key.mint approval as the original requester (it never mints; WSK-66 mints at decide(), as a DIFFERENT user),
 *  so an approved hub suspension of `webdesk.key.mint` leads to that second, maker-checker approval. Structural
 *  only, for the reason given above: the wall, the environment check and the de-dup run in the route. */
async function webdeskKeyMintPrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  if (!nonEmptyString(a.tenantSlug)) return { ok: false, reason: "tenant_slug_invalid" };
  if (typeof a.siteId !== "string" || !UUID_RE_EXEC.test(a.siteId)) return { ok: false, reason: "site_id_invalid" };
  if (typeof a.envId !== "string" || !UUID_RE_EXEC.test(a.envId)) return { ok: false, reason: "env_id_invalid" };
  if (a.scope !== "read" && a.scope !== "write") return { ok: false, reason: "scope_invalid" };
  return { ok: true };
}

/** 2026-10-12 (owner ruling: archiving a site takes an approval): `POST control/sites/:siteId/archive` stopped being a
 *  501 stub. What it does on a re-drive is FILE a site.archive approval as the original requester (it never archives;
 *  WSK-66 sends the archive at decide(), as a DIFFERENT user), exactly like key.mint above. The tool stays registered
 *  (and stays in resource_mcp_tool.yaml's executable list: the D14 pairing is unchanged); only its precondition went
 *  from always-refusing to structural. The wall, the active-site check and the de-dup run in the route. */
async function webdeskSiteArchivePrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  if (!nonEmptyString(a.tenantSlug)) return { ok: false, reason: "tenant_slug_invalid" };
  if (typeof a.siteId !== "string" || !UUID_RE_EXEC.test(a.siteId)) return { ok: false, reason: "site_id_invalid" };
  return { ok: true };
}

const WEBDESK_STRUCTURAL_PRECONDITIONS: Record<string, (client: PoolClient, a: Record<string, unknown>) => Promise<PreconditionVerdict>> = {
  "webdesk.schema.apply": webdeskSchemaApplyPrecondition,
  "webdesk.site.provision": webdeskSiteProvisionPrecondition,
  "webdesk.key.mint": webdeskKeyMintPrecondition,
  "webdesk.site.archive": webdeskSiteArchivePrecondition,
};

/** The two MEDIUM content tools that can suspend. Mirrored in `resource_mcp_tool.yaml`'s executable list. */
export const WEBDESK_CONTENT_REGISTRY_TOOLS: readonly string[] = ["webdesk.content.unpublish", "webdesk.content.delete"];

function webdeskContentLockKey(a: Record<string, unknown>, toolName: string): string {
  // The unit of consistency is the ITEM: two approvals to take the same item down (or delete it) contend.
  const itemId = a?.itemId;
  if (typeof itemId === "string" && itemId.trim().length > 0) return `webdesk:content:${itemId}`;
  return `${toolName}:invalid-args:${JSON.stringify(a)}`;
}

export function registerWebdeskContentExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "webdesk.content.unpublish",
    lockKey: (a) => webdeskContentLockKey(a, "webdesk.content.unpublish"),
    precondition: webdeskUnpublishPrecondition,
  });
  registerExecutableApproval({
    toolName: "webdesk.content.delete",
    lockKey: (a) => webdeskContentLockKey(a, "webdesk.content.delete"),
    precondition: webdeskDeletePrecondition,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// WSK-43b — the media library's MEDIUM tools that can suspend: `webdesk.media.update` and `webdesk.media.delete`.
// The same D14 pairing as the content tools above: these entries AND the two names in
// `cerbos/policies/resource_mcp_tool.yaml`'s executable list, in one change.
//
// `webdesk.media.uploadToken` is MEDIUM too but is deliberately NOT here, nor in the Cerbos list. Its result is a
// one-time secret (the upload URL carries the token), and `approval-execute.ts` stores a re-driven tool's result
// text in `automation_approvals.execution_result`: registering it would write a plaintext token into a durable table.
// Without an entry an unattended agent/n8n call suspends and does nothing on approval (`not_applicable`), so an
// unattended caller can never obtain a token; an attended human is not suspended and gets it directly.
//
// STRUCTURAL PRECONDITION ONLY, for the content tools' reason: Zone B's own guards are the atomic re-check
// (`media.delete` answers 409 `media-in-use` when the world moved since filing; deleting a deleted asset is a no-op).
// ═════════════════════════════════════════════════════════════════════════════════════════════════

function mediaAssetArgsOk(a: Record<string, unknown>): string | null {
  if (!nonEmptyString(a.tenantSlug)) return "tenant_slug_invalid";
  if (typeof a.siteId !== "string" || !UUID_RE_EXEC.test(a.siteId)) return "site_id_invalid";
  if (typeof a.assetId !== "string" || !UUID_RE_EXEC.test(a.assetId)) return "asset_id_invalid";
  return null;
}

async function webdeskMediaUpdatePrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  const bad = mediaAssetArgsOk(a);
  if (bad) return { ok: false, reason: bad };
  if (!["title", "alt", "tags"].some((k) => a[k] !== undefined)) return { ok: false, reason: "no_media_fields" };
  return { ok: true };
}

async function webdeskMediaDeletePrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  const bad = mediaAssetArgsOk(a);
  return bad ? { ok: false, reason: bad } : { ok: true };
}

/** The two MEDIUM media tools that can suspend. Mirrored in `resource_mcp_tool.yaml`'s executable list. */
export const WEBDESK_MEDIA_REGISTRY_TOOLS: readonly string[] = ["webdesk.media.update", "webdesk.media.delete"];

function webdeskMediaLockKey(a: Record<string, unknown>, toolName: string): string {
  // The unit of consistency is the ASSET: an update and a delete of one asset contend.
  const assetId = a?.assetId;
  if (typeof assetId === "string" && assetId.trim().length > 0) return `webdesk:media:${assetId}`;
  return `${toolName}:invalid-args:${JSON.stringify(a)}`;
}

export function registerWebdeskMediaExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "webdesk.media.update",
    lockKey: (a) => webdeskMediaLockKey(a, "webdesk.media.update"),
    precondition: webdeskMediaUpdatePrecondition,
  });
  registerExecutableApproval({
    toolName: "webdesk.media.delete",
    lockKey: (a) => webdeskMediaLockKey(a, "webdesk.media.delete"),
    precondition: webdeskMediaDeletePrecondition,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// M5-W1b — the writers' room grant tools: `webdesk.editorial.grantRole` (HIGH, like iam.grantRole: it widens somebody's
// authority) and `webdesk.editorial.revokeRole` (MEDIUM: a de-escalation). Both are writes, so an unattended caller
// suspends for a human decision; these entries are what make the approval, once given, actually complete. The same D14
// pairing as the content and media tools: these entries AND the two names in `resource_mcp_tool.yaml`'s executable
// list, in one change.
//
// WHAT STILL BOUNDS A RE-DRIVE, independently of the approval: it runs as the ORIGINAL filing principal, through the same
// BFF route, so Cerbos decides `webdesk_collection:manage_editorial` on that principal's CURRENT standing; the choke point
// (`grantEditorialRole`) re-checks the site against WebDesk, the collections and locales, the target's membership and
// kind, and refuses a self-grant. An agent can therefore never grant more than the human behind it may.
//
// STRUCTURAL PRECONDITIONS ONLY, for the content tools' reason: the route's own checks are the atomic re-check, and they
// need a WebDesk read that a precondition may not make. Both writes are idempotent at the route (a re-grant of the same
// scope and a revoke of what is not held are `changed: false` no-ops with no audit row), so an auto-retry after a lost
// response is safe without a landed-detection read.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

function editorialArgsOk(a: Record<string, unknown>): string | null {
  if (!nonEmptyString(a.tenantSlug)) return "tenant_slug_invalid";
  if (typeof a.siteId !== "string" || !UUID_RE_EXEC.test(a.siteId)) return "site_id_invalid";
  if (typeof a.userId !== "string" || !UUID_RE_EXEC.test(a.userId)) return "user_id_invalid";
  if (!isEditorialRole(a.role)) return "role_invalid";
  return null;
}

async function webdeskEditorialGrantPrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  const bad = editorialArgsOk(a);
  if (bad) return { ok: false, reason: bad };
  try {
    normaliseEditorialScope(a);
  } catch (err) {
    if (err instanceof EditorialScopeError) return { ok: false, reason: "scope_invalid" };
    throw err;
  }
  if (a.expiresAt !== undefined && a.expiresAt !== null) {
    const t = typeof a.expiresAt === "string" ? Date.parse(a.expiresAt) : Number.NaN;
    // An expiry that passed while the approval sat in the inbox is refused here rather than at the route, so the row
    // records why ("the grant would already be over") instead of a generic 400.
    if (!Number.isFinite(t)) return { ok: false, reason: "expires_at_invalid" };
    if (t <= Date.now()) return { ok: false, reason: "expires_at_passed" };
  }
  return { ok: true };
}

async function webdeskEditorialRevokePrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  const bad = editorialArgsOk(a);
  return bad ? { ok: false, reason: bad } : { ok: true };
}

/** The two writers' room grant tools that can suspend. Mirrored in `resource_mcp_tool.yaml`'s executable list. */
export const WEBDESK_EDITORIAL_REGISTRY_TOOLS: readonly string[] = ["webdesk.editorial.grantRole", "webdesk.editorial.revokeRole"];

function webdeskEditorialLockKey(a: Record<string, unknown>, toolName: string): string {
  // The unit of consistency is (person, site): a grant and a revoke of one person on one site contend; two sites do not.
  const userId = a?.userId;
  const siteId = a?.siteId;
  if (typeof userId === "string" && userId.trim().length > 0 && typeof siteId === "string" && siteId.trim().length > 0) {
    return `webdesk:editorial:${userId}:${siteId}`;
  }
  return `${toolName}:invalid-args:${JSON.stringify(a)}`;
}

export function registerWebdeskEditorialExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "webdesk.editorial.grantRole",
    lockKey: (a) => webdeskEditorialLockKey(a, "webdesk.editorial.grantRole"),
    precondition: webdeskEditorialGrantPrecondition,
  });
  registerExecutableApproval({
    toolName: "webdesk.editorial.revokeRole",
    lockKey: (a) => webdeskEditorialLockKey(a, "webdesk.editorial.revokeRole"),
    precondition: webdeskEditorialRevokePrecondition,
  });
}


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// M6-P4c — `webdesk.contract.regenerate` (MEDIUM): WebDesk's contract.regenerate for one of the company's
// tenants (`slug`) or all of them (no `slug`). The same D14 pairing as every MEDIUM webdesk tool: this
// entry AND the name in `cerbos/policies/resource_mcp_tool.yaml`'s executable list, in one change. An
// unattended caller suspends; on approval the executor re-drives the tool through the hub as the ORIGINAL
// principal, and the platform route re-checks Cerbos `operate` and the company wall on their CURRENT standing.
// STRUCTURAL precondition only (the content tools' reason: the route's wall and WebDesk's own guards are the
// atomic re-check; a precondition may not call out over the network). It refuses a malformed slug before
// any grant is spent.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const WEBDESK_TENANT_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;

/** Mirrored in `resource_mcp_tool.yaml`'s executable list. */
export const WEBDESK_CONTRACT_REGISTRY_TOOLS: readonly string[] = ["webdesk.contract.regenerate"];

async function webdeskContractRegeneratePrecondition(_client: PoolClient, a: Record<string, unknown>): Promise<PreconditionVerdict> {
  if (a.slug !== undefined && (typeof a.slug !== "string" || !WEBDESK_TENANT_SLUG_RE.test(a.slug))) {
    return { ok: false, reason: "tenant_slug_invalid" };
  }
  return { ok: true };
}

function webdeskContractLockKey(a: Record<string, unknown>): string {
  // The unit of consistency is (company, tenant); a company-wide run is its own unit.
  const tenantId = typeof a?.tenantId === "string" && a.tenantId.trim() ? a.tenantId : "no-tenant";
  const slug = typeof a?.slug === "string" && a.slug.trim() ? a.slug : "*";
  return `webdesk:contract:${tenantId}:${slug}`;
}

export function registerWebdeskContractExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "webdesk.contract.regenerate",
    lockKey: webdeskContractLockKey,
    precondition: webdeskContractRegeneratePrecondition,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SMM-09 — `social.publishPost` (executable) and `social.publishPostMetered` (BARRED twin).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md — the SMM-09 row, D-14 (publish executes
// on approval; money split out of that path), D-15 (`payload_hash` IS `argsSha256`), OQ-2 (X ships
// disabled), plus D-22 (owner decision 2026-08-18, TikTok creator consent). The precondition body
// lives in `modules/social/publish-precondition.ts` — same siting decision as PRV-03's
// `evaluateProvisionPrecondition`: the domain rules belong to the module, this file is the thin,
// auditable binding of (lockKey, precondition, retry policy) to a tool name.
//
// ── WHY A PUBLISH IS REGISTRY-ELIGIBLE AT ALL ────────────────────────────────────────────────────
// The doctrine at the top of this file bars money-spending tools PERMANENTLY, and publishing is the
// obvious candidate for that bar. D-14 resolves it by SPLITTING THE PATH BY TOOL NAME rather than by
// a runtime branch:
//
//   social.publishPost         — every network Postiz reaches for $0. Registered below. An approval
//                                for it EXECUTES, which is what closes the "approved but never
//                                published" dead end D14 exists to fix (agentic criterion 4).
//   social.publishPostMetered  — any variant on a metered network. X is the only one in v1, it
//                                ships DISABLED in every scope (OQ-2, and `DEFAULT_TOOL_SCOPE` in
//                                modules/social/index.ts pins `networks.x: false`), and this name is
//                                BARRED below. It stays caller-re-driven, honouring the money bar.
//
// Splitting by NAME is the load-bearing choice: it makes the metered path visibly different at the
// tool surface, where an operator, an agent and this registry can all see it, instead of hiding the
// distinction inside a conditional that a later edit could invert. Belt and braces, the free tool's
// own precondition ALSO refuses a metered-network variant
// (`metered_network_requires_metered_tool`), so a routing bug cannot spend a client's money by
// reaching the registered tool with an X variant.
//
// ── LOCK KEY: THE VARIANT, NOT THE POST AND NOT THE TENANT ───────────────────────────────────────
// `tool_args.variantId`. A variant is one post on one account — the actual unit of publication, and
// the unit two approvals contend over. Keying on the POST would serialize a five-network fan-out
// behind itself for no correctness gain; keying on the TENANT would serialize every publish in the
// agency behind every other (this deployment is nearly all one tenant — see pipeline-lock.ts's
// "LOCK SCOPE" note). A missing/malformed id falls back to a tool-prefixed key over the raw args:
// still pure and stable across retries, and it never collapses every bad call onto one shared lock.
//
// ── NO PIPELINE CO-LOCK ──────────────────────────────────────────────────────────────────────────
// Stated so nobody adds `lockPipelineRun` here "for safety" later: nothing in the social module
// reads or writes `pipeline_runs`/`pipeline_stages`. Co-locking would manufacture a false dependency
// between two systems that share no state. The state THIS precondition reads (`social_post_variants`,
// `social_engagements`, `social_accounts`, `social_usage_ledger`) is written under
// `APPROVAL_EXEC_LOCK_NS` by this path and by SMM-10's dispatch, which must take the SAME key.
//
// ── NO AUTO-RETRY (the one behavioural difference from every entry above) ────────────────────────
// `neverAutoRetry: true`. A publish whose outcome is UNKNOWN — `hub_unreachable` (no verdict) or
// `tool_error` (may have partially applied) — may already be on a client's public feed. `deploy.*`
// can afford the executor's bounded auto-retry because its precondition can OBSERVE a landed first
// attempt (the stage goes `done`); a publish in the ambiguous window has no such observation, so an
// unattended second attempt is a coin-flip on a duplicate public post. It surfaces for a human
// instead: `failed`, notified at `warning`, and D14-07's retry endpoint (which re-takes the lock and
// re-evaluates this precondition) is the only way forward.
//
// ── THE CERBOS HALF ──────────────────────────────────────────────────────────────────────────────
// `social.publishPost` is `write:true, impact:"high"` at the hub, so an `origin='automation'`
// re-drive also needs the tool name in `cerbos/policies/resource_mcp_tool.yaml`'s executable-tool
// list (D14-13). That file's own header states the both-places rule and that drift fails CLOSED.
// This ticket adds it there. `social.publishPostMetered` is added to NEITHER list, which is what
// being barred means.
//
// ── WHAT THIS TICKET DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────
// It declares no `McpToolDef` for either name. `modules/social/index.ts`'s own header states the
// rule: "a declared MCP tool whose endpoint does not exist is a lie the hub will happily publish to
// every agent in the estate" — and a publish tool is the worst possible instance of it. The dispatch
// endpoint (approval-execution → `schedulePost` + the transactional stamp of `approval_id` and
// `provider_post_id`) is SMM-10's. When SMM-10 wires it, it declares the tool with
// `SOCIAL_PUBLISH_TOOL_CLASSIFICATION` (`write:true, impact:"high"`, exported and pinned by a test)
// — those two values ARE the D14 gate, and a publish that is not `high` is a publish that never
// suspends. Until then the entry below is inert in exactly the way the doctrine wants: registered,
// precondition-guarded, and reachable by nothing.

function socialPublishLockKey(toolArgs: Record<string, unknown>): string {
  return publishLockKey(toolArgs, SOCIAL_PUBLISH_TOOL);
}

/** Adapts the module's richer `{ok, stage, reason}` verdict onto the registry's `PreconditionVerdict`.
 *  The STAGE is dropped on this path deliberately: `execution_error` carries one typed token and
 *  `PUBLISH_REFUSAL_STAGE` maps it back to its stage for anyone who wants it, so putting both in the
 *  string would give the estate two spellings of one refusal.
 *
 *  SMM-31: runs the client-review gate FIRST (composed by `evaluatePublishPreconditionWithClientReview`,
 *  never folded into the six-stage chain — see `modules/social/client-review.ts`'s header), so an
 *  engagement with `tool_scope.posting.requiresClientOk` set refuses here before ever reaching the
 *  hash/budget/creator-info stages, and re-derives on every execution attempt exactly like the rest
 *  of this gate. */
async function socialPublishPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const verdict = await evaluatePublishPreconditionWithClientReview(client, toolArgs, SOCIAL_PUBLISH_TOOL);
  if (verdict.ok) return { ok: true };
  return { ok: false, reason: verdict.reason };
}

/**
 * Registers `social.publishPost` AND the `social.publishPostMetered` bar. Exported for the same
 * reason the other three bootstraps are: a test file that calls `resetExecutableApprovals()` and
 * wants this state back should call this rather than hand-roll a second copy of the lock/precondition
 * — or, worse, restore the executable entry and forget the bar.
 */
export function registerSocialExecutableApprovals(): void {
  registerBarredExecutable({
    toolName: SOCIAL_PUBLISH_METERED_TOOL,
    reason: "metered_tool_barred",
    note:
      "D-14: any variant on a metered network (X today) rides this separately-named tool, which is "
      + "never auto-executed on approval. It stays caller-re-driven so the registry's permanent bar "
      + "on money-spending tools holds without an owner amendment. SMM-22 owns the metered path.",
  });
  registerExecutableApproval({
    toolName: SOCIAL_PUBLISH_TOOL,
    lockKey: socialPublishLockKey,
    precondition: socialPublishPrecondition,
    neverAutoRetry: true,
  });
}


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SMM-17 — `social.sendReply`: the reply gate's registry entry, built by REUSING SMM-09's pattern.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md, SMM-17 row, as AMENDED by D-14's own
// extension: "a reply is an outbound public write, so it takes the same discipline as a publish:
// draft -> WS4 approval -> send, with its own executable-approval registry entry and its own
// precondition." The precondition body lives in `modules/social/reply-precondition.ts` — SAME siting
// decision as SMM-09's `evaluatePublishPrecondition`, and for the same reason: the domain rules
// belong to the module, this file stays a thin, auditable binding of (lockKey, precondition, retry
// policy) to a tool name.
//
// ── THIS IS SMM-09's PATTERN, REUSED, NOT REINVENTED ────────────────────────────────────────────
//   * `SOCIAL_REPLY_TOOL_CLASSIFICATION` is `{...SOCIAL_PUBLISH_TOOL_CLASSIFICATION}` — SPREAD, never
//     retyped (reply-precondition.ts's own doc). A reply and a publish are both outbound public
//     writes with the same irreversibility, so they share one classification literal, not two that
//     could drift.
//   * The lock key is the MESSAGE id (the unit of the outbound act), mirroring `publishLockKey`'s
//     variant-id reasoning exactly — never the thread, never the tenant.
//   * `neverAutoRetry: true` — SEE BELOW for why this is not merely copied from publish but
//     independently re-derived and still lands on the same answer.
//
// ── WHY `neverAutoRetry: true` ───────────────────────────────────────────────────────────────────
// The SAME reasoning `approval-executables.ts`'s own doc gives for `neverAutoRetry` on the FIELD
// definition applies here word for word: a reply is an OUTBOUND PUBLIC action. A `hub_unreachable`
// (no verdict obtained) or a `tool_error` (may have partially applied) on a send means the reply MAY
// ALREADY BE VISIBLE on a client's public thread while our row says nothing landed. There is no
// server-side observation this precondition could make to tell "definitely didn't land" from
// "landed, but the response was lost" — `SocialPublisher.sendReply`'s contract (types.ts) returns
// only `{externalId}` on success; there is no idempotency key a retry could probe first (unlike
// `deploy.*`, which can re-read a pipeline stage's own `done` status before deciding whether a retry
// is safe). So the one thing that must never happen is an unattended second attempt: the message
// surfaces `failed` for a HUMAN to look at, and D14-07's retry endpoint (a fresh lock + a fresh
// precondition re-run) is the only way forward — never an automatic one. This is IDENTICAL to why
// `social.publishPost` sets it, and independently justified rather than copied on the assumption that
// "publish does it so reply should too": both share the exact property (irreversible, unattended,
// unobservable landed-or-not) that the field exists to name.
//
// ── LOCK KEY: THE MESSAGE, NOT THE THREAD AND NOT THE TENANT ────────────────────────────────────
// `tool_args.messageId`. A message is one reply on one thread — the actual unit of the outbound act,
// and the unit two approvals contend over. Keying on the THREAD would serialize unrelated replies on
// the same thread behind each other for no correctness gain (0105's own unique partial index,
// `ux_social_inbox_messages_approval`, already makes one message's grant one-shot on its own).
//
// ── NO PIPELINE CO-LOCK, NO CREATOR-INFO STAGE ───────────────────────────────────────────────────
// Nothing in the reply path reads `pipeline_runs`/`pipeline_stages`, and no network in v1 requires
// upload-time consent re-verification for a TEXT reply the way TikTok does for a publish — so
// neither of SMM-09's own extra machinery (the pipeline lock, `CreatorInfoVerifier`) has an analogue
// here. `reply-precondition.ts`'s four stages (scope -> hash -> unconsumed -> retention) are the
// complete chain; see that file's own header for why `retention` replaces `budget`/`creator_info`
// rather than sitting alongside them.
//
// ── THE CERBOS HALF ──────────────────────────────────────────────────────────────────────────────
// `social.sendReply` is `write:true, impact:"high"` at the hub (spread from the SAME classification
// publish uses), so an `origin='automation'`/`'agent'` re-drive also needs the tool name in
// `cerbos/policies/resource_mcp_tool.yaml`'s executable-tool list (D14-13) — added alongside
// `social.publishPost` in this ticket's own pass. Both halves of the D14-13 mirror move together, per
// that file's own doctrine.
//
// ── WHAT THIS TICKET DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────
// It declares the `McpToolDef` in `modules/social/index.ts` (unlike SMM-09's split across two
// tickets) because the dispatch endpoint (`social.controller.ts#sendReply` -> `reply-dispatch.ts`)
// ships in this SAME ticket — there is no "declare later" gap to leave open here.

function socialReplyLockKey(toolArgs: Record<string, unknown>): string {
  return replyLockKey(toolArgs, SOCIAL_REPLY_TOOL);
}

async function socialReplyPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const verdict = await evaluateReplyPrecondition(client, toolArgs);
  if (verdict.ok) return { ok: true };
  return { ok: false, reason: verdict.reason };
}

/**
 * Registers `social.sendReply`. Exported for the same reason `registerSocialExecutableApprovals` is:
 * a test file that calls `resetExecutableApprovals()` and wants this entry back afterward should call
 * this rather than hand-roll a second copy of the lock/precondition.
 */
export function registerSocialReplyExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: SOCIAL_REPLY_TOOL,
    lockKey: socialReplyLockKey,
    precondition: socialReplyPrecondition,
    neverAutoRetry: true,
  });
}


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SMM-35 — `social.createReplyDraft`: closing the assistant's remaining half. NOT publish, NOT send.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// The tracker's own prior SMM-35 pass excluded every social write from `/assistant` for one of two
// reasons: `social.publishPost`/`social.publishPostMetered`/`social.sendReply` on SECURITY grounds
// (a public, irreversible act — "agents draft, never publish" since SMM-26), and
// `social.draftContentBrief` on a STRUCTURAL one (it needs an `ai-agents` AgentDef this ticket's own
// file surface never named). This entry is the genuinely low-blast-radius write that clears BOTH
// bars: `social.createReplyDraft` (`social.controller.ts#createReplyDraft`) only ever INSERTs OUR OWN
// row — never sent, never network-visible, never client-visible — mirroring the reasoning
// `pm.createTask`/`pm.createDoc` already established for `task-filer` (T2, ASST-23): a hub tier of
// `write:true, impact:"low"` (it is our own draft row, in-tenant, reversible) and an AgentDef-level
// `high_write` declaration ANYWAY, because D-A's rule ("every assistant write is a proposal a human
// decides, never a silent commit") answers a DIFFERENT question than the hub's blast-radius tier —
// see `ai-agents/src/specialists.ts`'s `taskFiler` section for the fuller restatement of why that is
// the honest label, not a workaround.
//
// Deliberately NOT exposed in this same pass, and why:
//   - `social.updateReplyDraft`/`social.approveReplyDraft` — a second write per turn multiplies the
//     registry/eval/allowlist surface for no new capability this pass needs to prove; a natural
//     follow-up once `social.createReplyDraft` has a real enrolled provider (see
//     `ai-agents/src/specialists.ts`'s `socialDrafter.evaledProviders`).
//   - `social.sendReply`/`social.publishPost` — unchanged from the prior pass's own "no" (SECURITY,
//     not a file-surface gap): a chat "confirm" click is not a more scrutinized gate than the
//     existing approvals-inbox review for a PUBLIC, irreversible act, and SMM-26's standing invariant
//     forbids it outright regardless.
//
// ── THE PRECONDITION: DELIBERATELY THIN, BECAUSE A DRAFT HAS ALMOST NOTHING TO STALE-CHECK ──────────
// Unlike publish/reply-SEND (whose precondition re-derives a whole gate: scope, hash, single-use,
// budget, retention), a CREATE has no prior state to have gone stale — there is no row yet for an
// edit to have invalidated, no grant to have already been consumed. The only things that can have
// changed between "the model proposed this" and "a human approved it" are: the thread got deleted,
// or the proposal was malformed. Both are checked, server-side, under the lock, same as every other
// entry in this file.
//
// ── WHY `neverAutoRetry: true` — NOT COPIED FROM PUBLISH/REPLY, INDEPENDENTLY DERIVED ──────────────
// Publish/reply set this because an ambiguous failure (`hub_unreachable`/`tool_error`) leaves the
// PUBLIC act's landed-or-not unobservable. A draft create has a different problem: the server mints
// a FRESH `newId()` and unconditionally `INSERT`s (`social.controller.ts#createReplyDraft`) — there
// is no client-supplied or content-derived idempotency key an in-executor auto-retry could check
// before re-sending, so a retry after a lost response would create a SECOND draft row rather than
// re-applying the same one (the exact `pm.comment` shape `ai-agents/src/agent-write-guard.test.ts`'s
// header names as the reason THAT tool stays unregistered). Two duplicate drafts are a much smaller
// blast radius than a duplicate public reply, but still not something to create unattended — a human
// re-driving via D14-07's retry endpoint is the safe form of the same operation, exactly as it is for
// every other `neverAutoRetry` entry in this file.
//
// ── LOCK KEY: THE THREAD, NOT A MESSAGE (THERE IS NO MESSAGE YET) ───────────────────────────────────
// `tool_args.threadId` — the only stable identifier that exists before the row is created. Two
// concurrently-approved create-draft proposals for the SAME thread serialize behind each other; two
// for different threads never contend.

function socialCreateReplyDraftLockKey(toolArgs: Record<string, unknown>): string {
  const threadId = typeof toolArgs.threadId === "string" ? toolArgs.threadId.trim() : "";
  return threadId ? `social.createReplyDraft:${threadId}` : "social.createReplyDraft:(malformed)";
}

async function socialCreateReplyDraftPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  // Self-declared, same idiom every other social precondition in this file uses (D5's own trap:
  // module-owned tables read ZERO ROWS with no error under an unset `app.scopes`).
  await declareSocialModuleScope(client);
  const threadId = typeof toolArgs.threadId === "string" ? toolArgs.threadId.trim() : "";
  if (!threadId) return { ok: false, reason: "reply_thread_missing" };
  const body = typeof toolArgs.body === "string" ? toolArgs.body.trim() : "";
  if (!body) return { ok: false, reason: "empty_body" };
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM social_inbox_threads WHERE id = $1 AND deleted_at IS NULL`,
    [threadId],
  );
  if (!rows[0]) return { ok: false, reason: "reply_thread_not_found" };
  return { ok: true };
}

/**
 * Registers `social.createReplyDraft`. Exported for the same reason the SMM-09/SMM-17 bootstraps
 * are: a test file that calls `resetExecutableApprovals()` and wants this entry back afterward
 * should call this rather than hand-roll a second copy of the lock/precondition.
 */
export function registerSocialReplyDraftExecutableApproval(): void {
  registerExecutableApproval({
    toolName: "social.createReplyDraft",
    lockKey: socialCreateReplyDraftLockKey,
    precondition: socialCreateReplyDraftPrecondition,
    neverAutoRetry: true,
  });
}


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SMM-22 — the config-gated, explicit lift of `social.publishPostMetered`'s bar.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/blueprints/smm-design-addendum-2026-08-12.md — D-9 (the stop-loss chain), D-14
// (the money split), as AMENDED by SMM-22's own ticket row: "makes the metered path real without
// unbarring anything by default."
//
// ── THE DEFAULT POSTURE IS BYTE-IDENTICAL TO BEFORE THIS TICKET ─────────────────────────────────
// `config.social.usage.meteredPublishEnabled` defaults to `false` (config.ts). With it false, this
// section does EXACTLY what SMM-09's `registerSocialExecutableApprovals()` already did: bars
// `SOCIAL_PUBLISH_METERED_TOOL` and registers nothing for it. No deployment that has not explicitly
// set `SOCIAL_METERED_PUBLISH_ENABLED=true` observes ANY behavioural change from this ticket on the
// publish-registry surface.
//
// ── THE LIFT IS EXPLICIT, CONFIGURED, AND REFUSES LOUDLY WHEN THE MONEY GUARD IS ABSENT ─────────
// Flipping the flag on is a deliberate deployment decision. The ONE guard that matters is X's own
// per-post price (`resolveXPricing()`, usage-ledger.ts): an auto-executing money-spending tool with
// no configured price is exactly the "under-count" failure direction this whole ticket exists to
// prevent (a $0-priced post would sail through every stop-loss tier for free). So this section
// THROWS AT MODULE LOAD — a boot failure, not a warning, matching this codebase's own established
// doctrine for this exact class of misconfiguration (platform-nest/CLAUDE.md's "Boot-time
// refusals" section: "a request-time failure happens AFTER a one-shot approval has been spent" — a
// mis-registered auto-executing metered tool is precisely that risk, caught before any approval can
// ever be filed against it) — when the flag is true and the price is unconfigured.
//
// The tenant/global CAPS are deliberately NOT part of this boot guard: `globalMonthlyCapUsd` always
// has a value (config.ts's own `numericEnv` default, $100/mo per design §05) and `tenantMonthlyCapUsd`
// is OPTIONAL BY DESIGN (D-9's own "unset -> tier skipped" convention, mirrored from search) — an
// operator who has deliberately left the tenant tier unset is not misconfigured, they are relying on
// the engagement + global tiers, exactly as the chain's own design permits.
//
// ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────────────────
// It does not touch `cerbos/policies/resource_mcp_tool.yaml`. D14-13's "both halves move together"
// doctrine still applies the day a deployment ALSO wants an `origin='automation'`/`'agent'` re-drive
// of this tool admitted — that is a SEPARATE, manual policy change (the executable-tool list), left
// for the runbook that documents turning `SOCIAL_METERED_PUBLISH_ENABLED` on, deliberately NOT made
// here: this file is code, Cerbos policy is data, and conflating the two would make an env var
// silently rewrite a security policy file. Until that policy change is ALSO made, a human's own
// direct WS4 decide-and-approve of a metered post still auto-executes (this registration is what
// makes the human-approved path complete); only an agent/automation-ORIGINATED metered proposal's
// re-drive stays denied by Cerbos in the interim — fails CLOSED, never open, exactly as D14-13's own
// "drift fails closed" property promises.
//
// ── THE PRECONDITION, LOCK KEY AND RETRY POLICY ARE SMM-09's PATTERN, REUSED VERBATIM ────────────
// Same `publishLockKey` (keyed on `variantId`, mirrors `socialPublishLockKey` above — the variant is
// still the unit of publication regardless of which tool dispatches it), same
// `evaluatePublishPreconditionWithClientReview` composition (SMM-31's client-review gate still runs
// first), same `neverAutoRetry: true` (a metered publish is an outbound public write with the SAME
// unobservable-landed-or-not property SMM-09's own doc names — the reasoning does not become less
// true because money is also involved). The ONLY thing that differs from `socialPublishPrecondition`
// is the tool name threaded through, which is what makes the precondition's own
// `metered_network_requires_metered_tool` / `metered_tool_requires_metered_network` checks resolve
// the OTHER way for this tool.

function socialMeteredPublishLockKey(toolArgs: Record<string, unknown>): string {
  return publishLockKey(toolArgs, SOCIAL_PUBLISH_METERED_TOOL);
}

async function socialMeteredPublishPrecondition(
  client: PoolClient,
  toolArgs: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const verdict = await evaluatePublishPreconditionWithClientReview(client, toolArgs, SOCIAL_PUBLISH_METERED_TOOL);
  if (verdict.ok) return { ok: true };
  return { ok: false, reason: verdict.reason };
}

/**
 * Called once at module load (below). If `config.social.usage.meteredPublishEnabled` is false
 * (the default), this is a no-op — SMM-09's bar, registered a moment ago by
 * `registerSocialExecutableApprovals()`, stands untouched. If true, verifies the money guard and
 * either THROWS (guard absent) or explicitly lifts the bar and registers the metered tool with the
 * SAME lock/precondition/retry discipline the free tool uses.
 *
 * Exported for the same reason every other bootstrap in this file is: a test file that calls
 * `resetExecutableApprovals()` (which also clears the bar `registerSocialExecutableApprovals`
 * re-establishes) and wants THIS ticket's state back afterward should call this rather than
 * hand-roll a second copy of the lock/precondition/guard check.
 */
export function registerSocialMeteredExecutableApprovalIfEnabled(): void {
  if (!config.social.usage.meteredPublishEnabled) return;

  if (!resolveXPricing()) {
    throw new Error(
      "SOCIAL_METERED_PUBLISH_ENABLED is true, but X's per-post price is not configured "
      + "(SOCIAL_X_PER_POST_COST_USD / SOCIAL_X_PER_POST_WITH_LINK_COST_USD are both required). "
      + "Refusing to boot with an auto-executing metered publish tool and no price: an unpriced "
      + "spend is exactly the failure this gate exists to prevent. Either set both price vars, or "
      + "leave SOCIAL_METERED_PUBLISH_ENABLED unset/false to keep social.publishPostMetered barred.",
    );
  }

  liftBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL);
  registerExecutableApproval({
    toolName: SOCIAL_PUBLISH_METERED_TOOL,
    lockKey: socialMeteredPublishLockKey,
    precondition: socialMeteredPublishPrecondition,
    neverAutoRetry: true,
  });
}


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// P2-07 — `hr.hireEmployee` / `hr.transferEmployee` / `hr.terminateEmployee`: JML's registry entries.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// These three exist so an agent-origin JML write actually COMPLETES when a human approves it. Without
// an entry, `getExecutable()` returns undefined, `execution_status` lands `not_applicable`, and the
// approval decides nothing — for a hire, a person approved and never onboarded. Design §9 (P2-07)
// requires the closed loop, and `src/modules/hr/hr-employee-tools.test.ts` refuses to let the tools be
// declared without these.
//
// ── LOCK SCOPE: THE PERSON, NOT THE TENANT AND NOT THE APPROVAL ────────────────────────────────
// Every JML write is about one human being. Two approvals for the SAME person must serialize — a
// transfer and a terminate decided seconds apart would otherwise interleave and leave seats and grants
// disagreeing. Two approvals for DIFFERENT people must not block each other, which rules out keying on
// the tenant (this deployment is nearly one tenant, see pipeline-lock.ts's LOCK SCOPE note). Keying on
// the approval id would be useless: the `pending -> executing` claim already serializes a row against
// itself.
//
// The key is derived from whichever identifier the tool carries — `employeeId` for transfer/terminate,
// `workEmail` for a hire (no employee row exists yet, and the email IS the joiner's natural key per
// design §5.1 / migration 0111). Pure function of `toolArgs`, stable across retries, as the contract
// on `lockKey` requires.
//
// ── PRECONDITIONS: DETECT A FIRST ATTEMPT THAT ALREADY LANDED ──────────────────────────────────
// The verdict is re-derived under the lock, never trusted from the payload the human saw. All three
// checks are ALSO the reason auto-retry is safe here (no `neverAutoRetry`): a retry after a lost
// response re-reads state and refuses rather than hiring the same person twice. That is the
// `deploy.*` property, and it is the difference between these and `social.publishPost`, whose
// landed-or-not is unobservable and which therefore opts out.
//
// An approval can also sit in the inbox for days, so each precondition re-checks the WORLD, not just
// idempotence: a position retired in the meantime must not be filled — the same staleness rule
// `admin/iam-approval-execute.ts` already applies to assignment requests.

/** The one unit of consistency a JML approval contends over: the person. */
function jmlLockKey(toolArgs: Record<string, unknown>, tool: string): string {
  const id =
    (typeof toolArgs?.employeeId === "string" && toolArgs.employeeId) ||
    (typeof toolArgs?.workEmail === "string" && toolArgs.workEmail.toLowerCase()) ||
    "";
  // A missing identifier fails the precondition below, so it never reaches the hub. The key must still
  // be a stable pure function, and it must NOT collapse every malformed payload onto one shared
  // constant (that would serialize unrelated refusals for no benefit) — same reasoning as
  // `extractRunId`'s fallback.
  return id ? `jml:${tool}:${id}` : `jml:${tool}:malformed:${JSON.stringify(toolArgs ?? {})}`;
}

async function hirePrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const email = typeof args?.workEmail === "string" ? args.workEmail.toLowerCase() : "";
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  if (!email || !tenantId) return { ok: false, reason: "missing_work_email" };

  // ALREADY LANDED? `(tenant_id, work_email)` is the joiner's natural key (0111), so an existing live
  // row means a previous attempt — or a human hiring the same person — already did this.
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM employees
      WHERE tenant_id = $1 AND lower(work_email) = $2 AND deleted_at IS NULL`,
    [tenantId, email],
  );
  if (Number(rows[0]?.n ?? "0") > 0) return { ok: false, reason: "employee_already_exists" };

  // STALE? A hire naming a position that has since been retired must refuse rather than seat someone
  // into a dead role.
  const positionId = typeof args?.positionId === "string" ? args.positionId : "";
  if (positionId) {
    const pos = await client.query<{ status: string }>(
      `SELECT status FROM positions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, positionId],
    );
    if (!pos.rows[0]) return { ok: false, reason: "position_not_found" };
    if (pos.rows[0].status !== "active") return { ok: false, reason: "position_not_active" };
  }
  return { ok: true };
}

async function transferPrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const employeeId = typeof args?.employeeId === "string" ? args.employeeId : "";
  const toPositionId = typeof args?.toPositionId === "string" ? args.toPositionId : "";
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  if (!employeeId || !toPositionId || !tenantId) return { ok: false, reason: "missing_transfer_args" };

  const emp = await client.query<{ user_id: string | null; employment_status: string }>(
    `SELECT user_id, employment_status FROM employees WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, employeeId],
  );
  if (!emp.rows[0]) return { ok: false, reason: "employee_not_found" };
  if (emp.rows[0].employment_status === "terminated") return { ok: false, reason: "employee_terminated" };
  if (!emp.rows[0].user_id) return { ok: false, reason: "employee_has_no_principal" };

  const pos = await client.query<{ status: string }>(
    `SELECT status FROM positions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, toPositionId],
  );
  if (!pos.rows[0]) return { ok: false, reason: "position_not_found" };
  if (pos.rows[0].status !== "active") return { ok: false, reason: "position_not_active" };

  // ALREADY LANDED? The person already holds the destination seat.
  const held = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM position_assignments
      WHERE tenant_id = $1 AND user_id = $2 AND position_id = $3 AND valid_to IS NULL`,
    [tenantId, emp.rows[0].user_id, toPositionId],
  );
  if (Number(held.rows[0]?.n ?? "0") > 0) return { ok: false, reason: "already_in_target_position" };
  return { ok: true };
}

async function terminatePrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const employeeId = typeof args?.employeeId === "string" ? args.employeeId : "";
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  if (!employeeId || !tenantId) return { ok: false, reason: "missing_employee_id" };

  const emp = await client.query<{ employment_status: string }>(
    `SELECT employment_status FROM employees WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, employeeId],
  );
  if (!emp.rows[0]) return { ok: false, reason: "employee_not_found" };
  // ALREADY LANDED? Terminating a terminated employee is the retry case, and it must refuse rather
  // than re-run: the flow revokes manual grants and bumps sessions, and doing that twice would look
  // like a second departure in the audit trail.
  if (emp.rows[0].employment_status === "terminated") return { ok: false, reason: "already_terminated" };
  return { ok: true };
}

/**
 * Registers the three JML entries. Exported for the same reason `registerCoreExecutableApprovals` is:
 * a suite that calls `resetExecutableApprovals()` can restore exactly these without re-deriving their
 * locks and preconditions. Called once at module load below, so boot needs no separate wiring.
 */
export function registerJmlExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "hr.hireEmployee",
    // `employees` (and nothing else these preconditions read) is behind the HR module's third wall.
    preconditionModules: ["hr"],
    lockKey: (args) => jmlLockKey(args, "hr.hireEmployee"),
    precondition: hirePrecondition,
  });
  registerExecutableApproval({
    toolName: "hr.transferEmployee",
    // `employees` (and nothing else these preconditions read) is behind the HR module's third wall.
    preconditionModules: ["hr"],
    lockKey: (args) => jmlLockKey(args, "hr.transferEmployee"),
    precondition: transferPrecondition,
  });
  registerExecutableApproval({
    toolName: "hr.terminateEmployee",
    // `employees` (and nothing else these preconditions read) is behind the HR module's third wall.
    preconditionModules: ["hr"],
    lockKey: (args) => jmlLockKey(args, "hr.terminateEmployee"),
    precondition: terminatePrecondition,
  });
}


// ═════════════════════════════════════════════════════════════════════════════════════════════════
// OWNER DECISION 2026-08-20 — the four DIRECT IAM writes become agent-reachable.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `iam.grantRole`, `iam.revokeRoleGrant`, `iam.assignPosition`, `iam.unassignPosition`. Until today
// `src/core/core-tools.ts` deliberately shipped only reads plus two low-impact PROPOSAL tools, and its
// comment recorded why: a role-granting tool is a privilege-escalation surface, and this estate's audit
// attribution still records "Alice" rather than "Alice's agent".
//
// ── WHAT THE OWNER DECIDED, AND ON WHAT BASIS ────────────────────────────────────────────────────
// The owner ruled to proceed on 2026-08-20, on the basis that every employee on the estate is seed/mock
// data except their own account — verified before shipping this: 23 `kind='employee'` memberships, all
// `.test` addresses except `hansel@gaiada.com` (the only account that can log in) and one
// `@gaiada.com` address with no login. The blast radius of an escalation here is therefore mock data.
//
// ⚠ THAT REASONING HAS AN EXPIRY, and it is not the reasoning the original objection raised. The
// attribution gap is unchanged: an agent-origin grant is still indistinguishable in the audit trail from
// one the human made themselves. That was already recorded as pre-staging work
// ([agent-attribution-gate]); it must be closed BEFORE real employee accounts exist, because at that
// point "the data is mock" stops being true and these four tools become a real escalation surface with
// an audit trail that cannot say who used them. Do not read this registration as the objection being
// answered — it is the objection being outranked, temporarily, by a fact about the data.
//
// ── WHAT STILL BOUNDS THESE, INDEPENDENTLY OF THE DECISION ───────────────────────────────────────
// None of the following is relaxed, and none of it depends on the data being mock:
//   * the executor re-drives as the ORIGINAL FILING PRINCIPAL, so an agent can never exceed what the
//     human behind it holds (approval-execute.ts invariant 1);
//   * `GrantWriteService` remains the only writer, so the ceiling arithmetic, the `ui_grantable`
//     allow-list, the sensitive gate and the self-target DENY all still apply;
//   * Cerbos still decides `role_grant · create/revoke` and `position · assign/unassign`;
//   * every one of these is a medium/high write, so it SUSPENDS for a human decision either way — what
//     these entries add is that the approval, once given, actually completes.
//
// ── LOCK SCOPE: THE TARGET PERSON ────────────────────────────────────────────────────────────────
// Same reasoning as JML's: every one of these is about one human's authority, and two approvals for the
// same person must serialize while two for different people must not. Keying on the tenant would
// serialize the whole estate (nearly one tenant); keying on the approval id is what the single-use claim
// already does. Grant/revoke additionally namespace by the GRANT so two different roles for one person
// do not block each other unnecessarily — a revoke is about one artifact, not about the person's whole
// authority.

/** One unit of consistency per (tool, person) — see the LOCK SCOPE note. */
function iamLockKey(toolArgs: Record<string, unknown>, tool: string): string {
  const person =
    (typeof toolArgs?.userId === "string" && toolArgs.userId) ||
    (typeof toolArgs?.targetUserId === "string" && toolArgs.targetUserId) ||
    "";
  // A grant id narrows further for the revoke path, where the artifact IS the unit of work.
  const grant = typeof toolArgs?.grantId === "string" ? toolArgs.grantId : "";
  const key = grant || person;
  return key ? `iam:${tool}:${key}` : `iam:${tool}:malformed:${JSON.stringify(toolArgs ?? {})}`;
}

/**
 * `iam.grantRole` — refuse when the exact grant ALREADY EXISTS.
 *
 * This is the landed-detection that makes auto-retry safe (no `neverAutoRetry`): a retry after a lost
 * response re-reads `user_roles` and stops. It deliberately does NOT re-check the ceiling — that is
 * `GrantWriteService`'s job at the actual write, and duplicating the arithmetic here would create a
 * second implementation of the estate's most security-sensitive rule.
 */
async function grantRolePrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const userId = typeof args?.userId === "string" ? args.userId : "";
  const roleId = typeof args?.roleId === "string" ? args.roleId : "";
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  if (!userId || !roleId || !tenantId) return { ok: false, reason: "missing_grant_args" };

  const scopeType = typeof args?.scopeType === "string" ? args.scopeType : "company";
  // `company` scope stores the TENANT as scope_id (0100's shape), which is what the surface itself does.
  const scopeId = scopeType === "company" ? tenantId : typeof args?.scopeId === "string" ? args.scopeId : null;
  if (scopeType === "org_unit" && !scopeId) return { ok: false, reason: "missing_scope_id" };

  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM user_roles
      WHERE user_id = $1 AND role_id = $2 AND scope_type = $3
        AND (scope_id = $4 OR ($4 IS NULL AND scope_id IS NULL))`,
    [userId, roleId, scopeType, scopeId],
  );
  if (Number(rows[0]?.n ?? "0") > 0) return { ok: false, reason: "grant_already_exists" };
  return { ok: true };
}

/**
 * `iam.revokeRoleGrant` — refuse when the grant is gone, or when it is MANAGED.
 *
 * The managed check is the one that matters: revoking a position- or service-managed grant would be
 * undone by the reconciler on its next pass, so an approval that "succeeded" would leave the access
 * standing. Refusing names the real fix (change the position) instead of producing a silent no-op.
 */
async function revokeGrantPrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const grantId = typeof args?.grantId === "string" ? args.grantId : "";
  if (!grantId) return { ok: false, reason: "missing_grant_id" };

  const { rows } = await client.query<{ managed_by: string | null; managed_by_position: string | null }>(
    `SELECT managed_by, managed_by_position FROM user_roles WHERE id = $1`,
    [grantId],
  );
  const row = rows[0];
  // ALREADY LANDED: a retry after a lost response, or a human who revoked it in the UI meanwhile.
  if (!row) return { ok: false, reason: "grant_not_found" };
  if (row.managed_by_position !== null) return { ok: false, reason: "managed_by_position_not_revocable" };
  if (row.managed_by !== null) return { ok: false, reason: "managed_by_service_not_revocable" };
  return { ok: true };
}

/** `iam.assignPosition` — refuse a stale seat, and refuse a placement that already landed. */
async function assignPositionPrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const positionId = typeof args?.positionId === "string" ? args.positionId : "";
  const userId = typeof args?.userId === "string" ? args.userId : "";
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  if (!positionId || !userId || !tenantId) return { ok: false, reason: "missing_assign_args" };

  const pos = await client.query<{ status: string }>(
    `SELECT status FROM positions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, positionId],
  );
  if (!pos.rows[0]) return { ok: false, reason: "position_not_found" };
  // A seat retired or orphaned while the approval sat in the inbox must not be filled. `orphaned` is
  // included deliberately: its unit is gone from the org chart, so the reconciler has FROZEN grants
  // there and a new placement would inherit that frozen state rather than conferring access.
  if (pos.rows[0].status !== "active") return { ok: false, reason: "position_not_active" };

  const held = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM position_assignments
      WHERE tenant_id = $1 AND position_id = $2 AND user_id = $3 AND valid_to IS NULL`,
    [tenantId, positionId, userId],
  );
  if (Number(held.rows[0]?.n ?? "0") > 0) return { ok: false, reason: "already_assigned" };
  return { ok: true };
}

/** `iam.unassignPosition` — refuse when there is no open placement left to close. */
async function unassignPositionPrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const positionId = typeof args?.positionId === "string" ? args.positionId : "";
  const userId = typeof args?.userId === "string" ? args.userId : "";
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  if (!positionId || !userId || !tenantId) return { ok: false, reason: "missing_assign_args" };

  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM position_assignments
      WHERE tenant_id = $1 AND position_id = $2 AND user_id = $3 AND valid_to IS NULL`,
    [tenantId, positionId, userId],
  );
  // ALREADY LANDED. Re-running would be harmless against the seat but NOT against the audit trail: a
  // second "removed from seat" entry reads as a second decision nobody made.
  if (Number(rows[0]?.n ?? "0") === 0) return { ok: false, reason: "not_assigned" };
  return { ok: true };
}

/**
 * Registers the four. Exported for the same reason the other bootstraps are: a suite that calls
 * `resetExecutableApprovals()` restores exactly these without re-deriving their locks.
 *
 * NOTE: no `preconditionModules`. Every table these read (`user_roles`, `positions`,
 * `position_assignments`) is CORE with a plain tenant policy — `user_roles` is global outright. Adding
 * a scope here would be cargo-culted from the JML entries, which need `hr` because `employees` sits
 * behind that module's wall.
 */
export function registerIamExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "iam.grantRole",
    lockKey: (args) => iamLockKey(args, "iam.grantRole"),
    precondition: grantRolePrecondition,
  });
  registerExecutableApproval({
    toolName: "iam.revokeRoleGrant",
    lockKey: (args) => iamLockKey(args, "iam.revokeRoleGrant"),
    precondition: revokeGrantPrecondition,
  });
  registerExecutableApproval({
    toolName: "iam.assignPosition",
    lockKey: (args) => iamLockKey(args, "iam.assignPosition"),
    precondition: assignPositionPrecondition,
  });
  registerExecutableApproval({
    toolName: "iam.unassignPosition",
    lockKey: (args) => iamLockKey(args, "iam.unassignPosition"),
    precondition: unassignPositionPrecondition,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AD-8 — `agency_intake.convert` becomes agent-reachable through the D14 gate.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §8(b), §6.2.
// `core/core-tools.ts`'s AD-8 section declares `agency_intake.convert` as `write:true, impact:"medium"`
// — that alone is what makes mcp-hub/src/policy.ts SUSPEND an unattended (agent or n8n) call before it
// ever reaches the platform (proven in mcp-hub/src/agency-intake-tools.test.ts). Registering an entry
// HERE is the other half: without it, a human-approved row for this tool would sit at
// `execution_status='not_applicable'` FOREVER (the doctrine at the top of this file) — a human clicking
// Approve on an agent's filed request would believe they authorized the conversion and nothing would
// ever attempt it. That is a worse failure than suspending forever, so this entry exists.
//
// ── WHAT THIS DOES NOT CLAIM ──────────────────────────────────────────────────────────────────────
// Registering the entry makes an approved row ELIGIBLE for the executor to attempt — it is not a claim
// that a full approve-then-executed round trip has been driven for this tool. That needs a reachable
// mcp-hub + Cerbos, which is out of every D14 registry suite's reach in this test harness (see
// d14-09-agent-origin-authority.test.ts's own scope note for the identical gap on `origin='agent'`
// generally). AD-8's own suite therefore proves the SUSPENSION at the mcp-hub tool-call boundary and
// this registration's precondition/lockKey against real Postgres — it does not assert `status:
// "executed"` the way `d14-iam-direct-registry.test.ts`'s "POSITIVE CONTROL" does for the IAM tools,
// because that would be exactly the "pretended completion" design §8(b) asks this ticket not to claim.
//
// ── THE PRECONDITION IS DELIBERATELY SHALLOW ─────────────────────────────────────────────────────
// It answers exactly one question — "did this lead already leave the OPEN set" — because that is the
// one thing a retry needs to know to avoid re-attempting a landed conversion. It does NOT re-derive
// `convertAgencyLead`'s staff-membership checks, delegation-plan resolution or contact-provisioning:
// duplicating that here would be a second, driftable implementation of logic another ticket owns (same
// doctrine as `grantRolePrecondition` above, which does not re-check `GrantWriteService`'s ceiling
// arithmetic either). The REAL correctness guarantee is still `convertAgencyLead`'s own lock + re-check
// + `ux_lead_client` (design §6.2), taken for real when the executor's hub call lands on the platform's
// convert endpoint; this precondition only avoids firing that call needlessly for an already-decided
// lead. `OPEN_STATUSES` is duplicated as a literal rather than imported from
// `agency-lead-convert.service.ts` — that file is another ticket's in-flight work in this checkout, and
// this precondition has no other reason to depend on it.
//
// ── LOCK SCOPE: THE LEAD ──────────────────────────────────────────────────────────────────────────
// One unit of consistency per lead: two approvals racing to convert the SAME lead must serialize, two
// for different leads must not. This is a SEPARATE advisory-lock space from
// `agency-lead-convert.service.ts`'s own `AGENCY_LEAD_LOCK_NS` (a 2-argument
// `pg_advisory_xact_lock(int, int)`, vs. this file's uniform 1-argument
// `pg_advisory_xact_lock(hashtext(lockKey))` — Postgres treats those as distinct lock spaces by
// construction), which is fine: this lock only needs to serialize concurrent EXECUTOR attempts against
// each other, not against the service's own internal lock, which still applies for real inside
// `convertAgencyLead` regardless of what raced to call it.

async function agencyIntakeConvertPrecondition(
  client: PoolClient,
  args: Record<string, unknown>,
): Promise<PreconditionVerdict> {
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  const leadId = typeof args?.leadId === "string" ? args.leadId : "";
  if (!tenantId || !leadId) return { ok: false, reason: "missing_convert_args" };

  const { rows } = await client.query<{ status: string }>(
    `SELECT status FROM agency_leads WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, leadId],
  );
  const row = rows[0];
  // ALREADY LANDED (or never existed): a retry after a lost response, a human converting it by hand
  // in the meantime, or a lead that was declined while the approval sat in the inbox.
  if (!row) return { ok: false, reason: "lead_not_found" };
  if (!["submitted", "in_review", "nurturing"].includes(row.status)) {
    return { ok: false, reason: "lead_not_open_for_conversion" };
  }
  return { ok: true };
}

/**
 * Registers `agency_intake.convert`'s executor entry. Exported for the same reason the other
 * bootstraps are: a suite that calls `resetExecutableApprovals()` can restore exactly this without
 * re-deriving the lock/precondition.
 *
 * No `preconditionModules`: `agency_leads` is a CORE table with a plain tenant wall (design §3.1),
 * not behind any module's third wall.
 */
export function registerAgencyIntakeExecutableApprovals(): void {
  registerExecutableApproval({
    toolName: "agency_intake.convert",
    lockKey: (args) => {
      const leadId = typeof args?.leadId === "string" && args.leadId ? args.leadId : null;
      return leadId ? `agency-intake:convert:${leadId}` : `agency-intake:convert:malformed:${JSON.stringify(args ?? {})}`;
    },
    precondition: agencyIntakeConvertPrecondition,
  });
  // M5-L4 — `agency_intake.createFromWebSubmission` is medium-impact, so an unattended call suspends and
  // an approved row needs an entry or it sits at `not_applicable` forever. The write itself is idempotent
  // on (tenant, submission) (`ux_lead_tenant_submission`), which is why the precondition only checks that
  // the args are well-formed: a retry after a landed attempt returns the existing lead, it never doubles.
  registerExecutableApproval({
    toolName: "agency_intake.createFromWebSubmission",
    lockKey: (args) => {
      const t = typeof args?.tenantId === "string" ? args.tenantId : "";
      const s = typeof args?.submissionId === "string" ? args.submissionId : "";
      return t && s ? `agency-intake:web-lead:${t}:${s}` : `agency-intake:web-lead:malformed:${JSON.stringify(args ?? {})}`;
    },
    precondition: async (_client, args) => {
      const ok = ["tenantId", "siteSlug", "submissionId"].every((k) => typeof args?.[k] === "string" && args[k] !== "");
      return ok ? { ok: true } : { ok: false, reason: "missing_web_lead_args" };
    },
  });
}

// M5-G5 - `agency_privacy.find|export|erase`: BARRED, never auto-executed on approval.
//
// The route itself is the WS4 gate (core/agency-privacy.service.ts): its first call files the approval that
// matters and its approved re-call, by the requester, runs the command once. A D14 re-drive of a hub-filed
// row would reach that route WITHOUT an approvalId and only file a second approval, so registering an
// executor would make an approved hub row look executed while nothing ran. The bar says so positively, and
// keeps core-tools.test.ts's "no medium/high write without an executor or a bar" invariant honest.
//
// M5-G5b: a hub-filed approval now holds only the subject hashes (core/agency-privacy.filing.ts), and the
// requester runs it through the route with just its `approvalId`. That is NOT a D14 execution and this bar stays:
// no auto-run, no re-drive, `execution_status` stays 'not_applicable'; the ledger (`agency_dsr_requests`) is the
// record that it ran.
export const AGENCY_PRIVACY_BARRED_TOOLS = ["agency_privacy.find", "agency_privacy.export", "agency_privacy.erase"] as const;

export function registerAgencyPrivacyBars(): void {
  for (const toolName of AGENCY_PRIVACY_BARRED_TOOLS) {
    registerBarredExecutable({
      toolName,
      reason: "route_ws4_gated",
      note:
        "M5-G5: the privacy route files and consumes its own WS4 approval per call (requester re-calls with the "
        + "approvalId, maker != checker). A hub re-drive cannot carry that approval, so it never auto-executes.",
    });
  }
}

// M5-P2 - `search.conversions.upload`: BARRED, never re-driven through the hub.
//
// An ad-platform conversion upload (a lead's hashed contact data and click id leaving for Google) is planned by the search
// module's `agency.lead.stage_changed` handler and files its OWN WS4 approval (origin `search`, workflow `search.conversions.upload`,
// impact high). decide() executes it IN-BAND, as the decider, under the gate a second time (modules/search/conversions.service.ts):
// the same shape as probe consent, GH-12 and WSK-66. The D14 registry re-drives tool calls through mcp-hub as the FILER, which would
// put personal data on a hub path and let an approved row look executed with no human present. The bar says so positively and makes
// it impossible for a later ticket to register the name. The conversions module is the only owner of the execution.
export const SEARCH_CONVERSION_BARRED_TOOLS = ["search.conversions.upload"] as const;

export function registerSearchConversionBars(): void {
  for (const toolName of SEARCH_CONVERSION_BARRED_TOOLS) {
    registerBarredExecutable({
      toolName,
      reason: "in_band_personal_data",
      note:
        "M5-P2: an ad-platform conversion upload executes in-band at decide(), as the decider, with a second consent and "
        + "suppression gate. A hub re-drive would carry personal data and run with no human present.",
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PV3-06 — `contracts.send`, `contracts.countersign` and `invoicePayments.decide` become agent-reachable
// through the D14 gate.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `core/core-tools.ts`'s PV3-06 section declares all three as writes with impact medium (send) or high
// (countersign, decide), which is what makes mcp-hub SUSPEND an unattended call. An entry HERE is the other
// half: without it an approved row would sit at `execution_status='not_applicable'` forever, a human
// believing they authorized a signature that never happens (this file's doctrine, above).
//
// ── WHAT THE PRECONDITIONS ARE, AND ARE NOT ───────────────────────────────────────────────────────
// Each answers one question: "is the row still in the state the approval was filed against?" That is the
// guard against a retry re-applying a landed action (a re-run after a lost response) or acting on a row a
// human already moved while the approval sat in the inbox (sent, voided, signed, decided).
//
// They deliberately do NOT re-derive authorization. Cerbos is the authority and runs for real when the
// executor's hub call lands on the route: the re-drive runs as the ORIGINAL FILING PRINCIPAL (see
// approval-execute.ts, invariant 1), so `countersign` is still refused for a `company_admin` and
// `decide` is still refused for the person who recorded the payment (maker-checker). Copying either rule
// here would be a second, driftable implementation. That means an approval can be filed and approved for a
// call the route will then refuse; the row lands `failed` with the route's typed 403, loudly, which is the
// correct outcome.
//
// ── THE ONE RULE THE ROUTE CANNOT SEE: WHO APPROVED (2026-10-12) ──────────────────────────────────
// The route's maker-checker check compares `recorded_by` with the principal it is called as, which on a
// re-drive is the FILER. The APPROVER never reaches the route. So the recorder could approve an agent's
// request (filed by someone else) to decide their own payment, and it went through. `invoicePayments.decide`
// therefore declares an `approverCheck` (see `ExecutableApprovalEntry.approverCheck`): the approver must not
// be the payment's `recorded_by`, refused as `approver_recorded_this_payment` at decide time (403, the row
// stays pending) and again at execution against the stored `decided_by`. It covers both decisions, confirm
// and reject, because the route's own rule does: whoever recorded a payment decides neither. This is not a
// copy of an authorization rule; it is the only place the approver's identity exists.
//
// ── LOCK SCOPE: THE ROW ───────────────────────────────────────────────────────────────────────────
// One unit of consistency per contract (send, countersign are separate keys: a send and a countersign of
// the same contract cannot both be valid, but they are different acts) and per payment. Core tables with
// a plain tenant wall (0075): no `preconditionModules`.
//
// Every query pins the tenant explicitly as well as relying on RLS, because the tenant comes from the
// approval's args and the RLS context is the one the executor opened for the approval's own tenant.

function billingArgs(args: Record<string, unknown>, idKey: "contractId" | "paymentId") {
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  const id = typeof args?.[idKey] === "string" ? (args[idKey] as string) : "";
  return { tenantId, id };
}

async function contractSendPrecondition(client: PoolClient, args: Record<string, unknown>): Promise<PreconditionVerdict> {
  const { tenantId, id } = billingArgs(args, "contractId");
  if (!tenantId || !id) return { ok: false, reason: "missing_contract_args" };
  const { rows } = await client.query<{ status: string; file_id: string | null; body_md: string | null }>(
    `SELECT status, file_id, body_md FROM contracts WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  );
  const k = rows[0];
  if (!k) return { ok: false, reason: "contract_not_found" };
  // Already sent (a lost-response retry), signed, or voided while the approval waited.
  if (k.status !== "draft") return { ok: false, reason: "contract_not_draft" };
  if (!k.file_id && !k.body_md) return { ok: false, reason: "contract_has_no_document" };
  return { ok: true };
}

async function contractCountersignPrecondition(client: PoolClient, args: Record<string, unknown>): Promise<PreconditionVerdict> {
  const { tenantId, id } = billingArgs(args, "contractId");
  if (!tenantId || !id) return { ok: false, reason: "missing_contract_args" };
  const { rows } = await client.query<{ status: string; provider_signed: boolean }>(
    `SELECT k.status,
            EXISTS (SELECT 1 FROM contract_signatures s WHERE s.contract_id = k.id AND s.party = 'provider') AS provider_signed
       FROM contracts k WHERE k.tenant_id = $1 AND k.id = $2 AND k.deleted_at IS NULL`,
    [tenantId, id],
  );
  const k = rows[0];
  if (!k) return { ok: false, reason: "contract_not_found" };
  // Our signature already landed (the route would answer `alreadySigned`); refuse rather than re-drive.
  if (k.provider_signed) return { ok: false, reason: "contract_already_countersigned" };
  if (k.status !== "sent") return { ok: false, reason: "contract_not_sent" };
  return { ok: true };
}

async function paymentDecidePrecondition(client: PoolClient, args: Record<string, unknown>): Promise<PreconditionVerdict> {
  const { tenantId, id } = billingArgs(args, "paymentId");
  if (!tenantId || !id) return { ok: false, reason: "missing_payment_args" };
  const decision = args?.decision;
  if (decision !== "confirm" && decision !== "reject") return { ok: false, reason: "payment_decision_invalid" };
  if (decision === "reject" && !(typeof args?.reason === "string" && args.reason.trim())) {
    return { ok: false, reason: "payment_reject_reason_required" };
  }
  const { rows } = await client.query<{ status: string }>(
    `SELECT status FROM invoice_payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  );
  const p = rows[0];
  if (!p) return { ok: false, reason: "payment_not_found" };
  // Already confirmed or rejected: a lost-response retry, or a human decided it first.
  if (p.status !== "pending") return { ok: false, reason: "payment_not_pending" };
  return { ok: true };
}

/** The typed reason an approval of `invoicePayments.decide` by the payment's own recorder is refused with. */
export const APPROVER_RECORDED_THIS_PAYMENT = "approver_recorded_this_payment";

/**
 * Maker-checker for the APPROVER of `invoicePayments.decide` (see this section's 2026-10-12 note). Fails
 * closed: bad args or a payment this tenant's session cannot see refuse rather than pass, because a check
 * that answers "ok" on zero rows is exactly how an RLS mistake would reopen the hole silently. A payment
 * with no `recorded_by` has no maker to exclude.
 */
async function paymentDecideApproverCheck(
  client: PoolClient,
  args: Record<string, unknown>,
  approver: ApprovalApprover,
): Promise<PreconditionVerdict> {
  const { tenantId, id } = billingArgs(args, "paymentId");
  if (!tenantId || !id) return { ok: false, reason: "missing_payment_args" };
  const { rows } = await client.query<{ recorded_by: string | null }>(
    `SELECT recorded_by FROM invoice_payments WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  );
  const p = rows[0];
  if (!p) return { ok: false, reason: "payment_not_found" };
  if (p.recorded_by && (p.recorded_by === approver.userId || p.recorded_by === approver.actForUserId)) {
    return { ok: false, reason: APPROVER_RECORDED_THIS_PAYMENT };
  }
  return { ok: true };
}

/** Registers the three PV3-06 entries. Exported for the same reason the other bootstraps are. */
export function registerContractBillingExecutableApprovals(): void {
  const key = (ns: string, idKey: "contractId" | "paymentId") => (args: Record<string, unknown>): string => {
    const id = typeof args?.[idKey] === "string" && args[idKey] ? (args[idKey] as string) : null;
    return id ? `${ns}:${id}` : `${ns}:malformed:${JSON.stringify(args ?? {})}`;
  };
  registerExecutableApproval({
    toolName: "contracts.send",
    lockKey: key("contract:send", "contractId"),
    precondition: contractSendPrecondition,
  });
  registerExecutableApproval({
    toolName: "contracts.countersign",
    lockKey: key("contract:countersign", "contractId"),
    precondition: contractCountersignPrecondition,
  });
  registerExecutableApproval({
    toolName: "invoicePayments.decide",
    lockKey: key("invoice-payment:decide", "paymentId"),
    precondition: paymentDecidePrecondition,
    approverCheck: paymentDecideApproverCheck,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PV5-12 — `invoices.issue` and `invoices.voidIssued` (HIGH, D14)
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Same doctrine as the PV3-06 section above. The re-drive runs as the ORIGINAL FILING PRINCIPAL (approval-execute.ts,
// invariant 1), so the route's own Cerbos check (`invoice` `issue` / `void_issued`) runs against the human the agent
// acted for, and a `bot` or `automation` principal is refused there (PV5-02). The preconditions do NOT re-derive
// authorization; they answer "is the invoice still in the state the approval was filed against?".
//
//   issue : the invoice is still `approved` and not yet issued, AND it is still READY. Readiness is re-read here from
//           the same function the readiness GET and the issue transaction use, so a profile, period or bank detail
//           that went missing while the approval sat in the inbox refuses the run (`invoice_not_ready:<codes>`)
//           instead of surfacing as a 409 from the route. The issue transaction re-checks it again under the row lock.
//   void  : the invoice is still ISSUED (`sent`) and unpaid. A paid, void or never-issued invoice is refused, and
//           so is a missing or too-short reason (the route needs one; an approval without it could only fail).
//
// Tenant and invoice come from the approval's args and every query pins the tenant as well as relying on RLS.
// Both are core `invoices` reads (plain tenant wall), so no `preconditionModules`; `readIssueReadiness` opens its
// own finance-scoped session.

function invoiceArgs(args: Record<string, unknown>) {
  const tenantId = typeof args?.tenantId === "string" ? args.tenantId : "";
  const id = typeof args?.invoiceId === "string" ? args.invoiceId : "";
  return { tenantId, id };
}

async function invoiceIssuePrecondition(client: PoolClient, args: Record<string, unknown>): Promise<PreconditionVerdict> {
  const { tenantId, id } = invoiceArgs(args);
  if (!tenantId || !id) return { ok: false, reason: "missing_invoice_args" };
  const { rows } = await client.query<{ status: string; issued_at: string | null }>(
    `SELECT status, issued_at FROM invoices WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  );
  const inv = rows[0];
  if (!inv) return { ok: false, reason: "invoice_not_found" };
  // Already issued (a lost-response retry, or a human issued it while the approval waited).
  if (inv.issued_at) return { ok: false, reason: "invoice_already_issued" };
  if (inv.status !== "approved") return { ok: false, reason: "invoice_not_approved" };
  let readiness;
  try {
    readiness = await readIssueReadiness(tenantId, id);
  } catch (e) {
    if (e instanceof NotFoundException) return { ok: false, reason: "invoice_not_found" };
    throw e;
  }
  if (!readiness.ready) {
    return { ok: false, reason: `invoice_not_ready: ${readiness.blockers.map((b) => b.code).join(",")}` };
  }
  return { ok: true };
}

async function invoiceVoidPrecondition(client: PoolClient, args: Record<string, unknown>): Promise<PreconditionVerdict> {
  const { tenantId, id } = invoiceArgs(args);
  if (!tenantId || !id) return { ok: false, reason: "missing_invoice_args" };
  const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
  if (reason.length < 4) return { ok: false, reason: "void_reason_required" };
  const { rows } = await client.query<{ status: string; issued_at: string | null }>(
    `SELECT status, issued_at FROM invoices WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [tenantId, id],
  );
  const inv = rows[0];
  if (!inv) return { ok: false, reason: "invoice_not_found" };
  if (!inv.issued_at) return { ok: false, reason: "invoice_not_issued" };
  // Void already, or paid in the meantime: only an issued, unpaid (`sent`) invoice can be voided.
  if (inv.status !== "sent") return { ok: false, reason: "invoice_not_voidable" };
  return { ok: true };
}

/** Registers the two PV5-12 entries. Exported for the same reason the other bootstraps are. */
export function registerInvoiceIssueExecutableApprovals(): void {
  const key = (ns: string) => (args: Record<string, unknown>): string => {
    const id = typeof args?.invoiceId === "string" && args.invoiceId ? args.invoiceId : null;
    return id ? `${ns}:${id}` : `${ns}:malformed:${JSON.stringify(args ?? {})}`;
  };
  registerExecutableApproval({
    toolName: "invoices.issue",
    lockKey: key("invoice:issue"),
    precondition: invoiceIssuePrecondition,
  });
  registerExecutableApproval({
    toolName: "invoices.voidIssued",
    lockKey: key("invoice:void"),
    precondition: invoiceVoidPrecondition,
  });
}

// PV4-07 — the client-reaching conversation and minutes tools: BARRED, because agents draft and staff send (PV-D23).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// `conversation.post` / `conversation.open` (a message to a client), `conversation.sendDraft` (a drafted message to a client)
// and `meetings.shareMinutes` (minutes to a client) are `impact: "medium"` (core-tools.ts), so an unattended caller's call
// is SUSPENDED for a human to approve. Without a bar, that approval would be the one path by which an agent's words reach a
// client with a human only clicking "approve" on a card. The ruling is stricter: a message is the sender's, and the sender
// is a named person who read it, so it is sent by that person from the conversation screen (or their own MCP client), never
// by a re-drive that runs as the agent's filing principal.
//
// A bar adds nothing to the absence that already fails closed (no entry means the executor marks the row `not_executable`
// and never calls the hub): it makes the decision a fact in code. `registerExecutableApproval` throws for these names, so a
// later ticket cannot make one executable without deleting this registration and saying why in the same change. Cerbos
// independently denies the same actions to `bot`/`automation` principals, and the endpoints answer them with the typed
// `agents_draft_staff_send` refusal (core/agent-refusal.ts).
export const CONVERSATION_BARRED_TOOLS = [
  "conversation.post",
  "conversation.open",
  "conversation.sendDraft",
  "meetings.shareMinutes",
] as const;

/** The reason TOKEN of the bars, the same code the endpoints answer an agent with. */
export const CONVERSATION_BAR_REASON = "agents_draft_staff_send";

export function registerConversationBars(): void {
  for (const toolName of CONVERSATION_BARRED_TOOLS) {
    registerBarredExecutable({
      toolName,
      reason: CONVERSATION_BAR_REASON,
      note: "PV-D23: agents draft, staff send — nothing an agent writes reaches a client until a staff member approves it",
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE production bootstrap — one list, so it cannot go stale
// ═════════════════════════════════════════════════════════════════════════════════════════════════
//
// Each of the nine bootstraps above used to be invoked by its own bare call, inline, next to its
// definition. That left NO single place naming the full set, and the doc on
// `resetExecutableApprovals` listed only three of them. The result was a test seam that silently
// under-restored: `resetExecutableApprovals()` clears all nine, a suite re-registered the two or
// three it knew about, and every LATER suite in the same vitest worker saw a registry missing the
// rest.
//
// That is not hypothetical — it is what broke `platform-nest` on main (2026-08-23). D14-17 (A1)
// asserts every `ASSISTANT_AGENT_WRITE_TOOLS` entry has an executable; SMM-35 added
// `social.createReplyDraft` to that map; `approval-executables.test.ts` and `approval-execute.test.ts`
// both reset the registry and restore only their own entries; so D14-17, running later in the same
// worker, found `social.createReplyDraft` undefined and failed. Production was never affected — the
// entry is registered correctly at boot — but the gate that exists to catch a REAL missing executor
// was firing on test pollution instead, which is exactly how a gate loses its teeth.
//
// So: ONE aggregate, called once below, and used by any suite that needs the registry back. The
// order is byte-identical to the previous inline sequence — it matters, because
// `registerSocialExecutableApprovals` also installs a BAR, and registering an entry for a barred
// tool throws. Add a new bootstrap HERE, not as a fresh bare call.
export function registerAllExecutableApprovals(): void {
  registerCoreExecutableApprovals();
  registerPmExecutableApprovals();
  registerWebdevExecutableApprovals();
  registerWebdeskExecutableApprovals();
  registerSocialExecutableApprovals();
  registerSocialReplyExecutableApprovals();
  registerSocialReplyDraftExecutableApproval();
  registerSocialMeteredExecutableApprovalIfEnabled();
  registerJmlExecutableApprovals();
  registerIamExecutableApprovals();
  registerAgencyIntakeExecutableApprovals();
  registerAgencyPrivacyBars();
  registerSearchConversionBars();
  registerContractBillingExecutableApprovals();
  registerInvoiceIssueExecutableApprovals();
  registerConversationBars();
}

registerAllExecutableApprovals();
