// D14-03 — THE EXECUTOR. Turns an approved automation/agent write into an actually-executed one.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md (D14-03)
// Program: docs/superpowers/plans/2026-08-05-d14-resume-path-plan.md
// Grant contract: §1 of the ticket doc, implemented on the wire by core/hub-client.ts and verified by
// mcp-hub/src/approval-grant.ts (D14-04, shipped).
//
// ── WHAT WAS BROKEN ───────────────────────────────────────────────────────────────────────────────
// `automation_approval.decided` had exactly ONE consumer: HR's leave handler (origin='hr'). For
// origin automation|agent, approving a suspended write flipped `status`, wrote an activity row, and
// executed NOTHING — while the UI, the audit trail and `writeActivity` all agreed a human had
// authorized a change. The failure was not merely silent, it was POSITIVE: it manufactured evidence
// of work that never happened. This file is what makes the approval real.
//
// ── THE FOUR INVARIANTS (each one is a way this file could be catastrophically wrong) ─────────────
// 1. AUTHORITY — the re-drive runs as the ORIGINAL FILING PRINCIPAL, never as the approver.
//    `origin='automation'` => OBO { provider: "n8n", externalId: workflow_id };
//    `origin='agent'`      => OBO the original requester's own verified identity link.
//    Executing as the approver would be privilege amplification, and since superadmin is the standing
//    approver (OQ-1) it would be TOTAL amplification: every approval would silently promote an n8n
//    workflow to superadmin for one call. The D14 gate suspends on IMPACT TIER only — the filing
//    principal was already otherwise authorized — so re-driving as itself is both sufficient and the
//    only honest choice. `executed_by` = who RAN it; `decided_by` = the human who lifted the gate.
//    These are different facts and this file never conflates them.
// 2. SINGLE USE — the authoritative guarantee is the claimed transition
//    `UPDATE … SET execution_status='executing' … WHERE id=$1 AND execution_status='pending'`.
//    Exactly one caller can win it per row, and a grant is minted ONLY inside a won claim. Zero rows
//    claimed => return silently: at-least-once redelivery (and D14-07's retry, and a re-run) must
//    no-op rather than double-execute. The hub's nonce cache is a best-effort second wall only (§5.7).
// 3. TOCTOU — lock AND precondition run in the SAME transaction as the claim. WD-29's lesson is that
//    the lock ALONE fixes nothing: the decision being executed was derived from a snapshot taken when
//    a human clicked Approve, possibly minutes ago. Re-deriving it server-side under the lock is the
//    actual fix. A stale precondition means the hub is NEVER called and the grant is never minted.
// 4. LOUDNESS — with auto-execute-on-approval (OQ-4) nobody is standing by at execution time, so a
//    quiet failure would just replace the old silent no-op with a new one. Both outcomes notify;
//    `failed` notifies at severity `warning` so it reaches the bell AND the MAIL-05 email tap.
//
// ── THE CRASH-WEDGE RULE (scope item 8), STATED PLAINLY ───────────────────────────────────────────
// A row is left at `execution_status='executing'` for the duration of the hub call, and that call is
// deliberately made with NO transaction open (see the TRANSACTION BOUNDARY note below). If the
// process dies mid-flight, the row stays `executing` forever — no timer, no janitor, no automatic
// unwedge. That is intentional, and the recovery mechanism is:
//
//   `updated_at` is stamped at claim time, so an `executing` row's age is exactly how long it has
//   been in flight. D14-07's `POST :tenantId/automation-approvals/:id/retry` accepts a row in
//   `failed`, OR in `executing` whose `updated_at` is older than EXECUTING_STALE_MS (10 min, exported
//   below for that endpoint to import rather than re-declare). Retry puts the row back to `pending`
//   and calls `executeApprovedAutomationWrite` — the SAME entry point, so the same claim, the same
//   lock, the same precondition re-evaluation and a fresh grant. `isExecutionWedged()` below is the
//   single predicate both sides use.
//
// A time-based auto-unwedge is deliberately NOT built: the platform cannot know whether a call whose
// response was lost actually landed, so unwedging automatically would be a coin-flip on
// double-execution. A HUMAN pressing Retry, on a row whose precondition is then re-evaluated
// server-side, is the safe form of the same operation — and if the first attempt DID land, the
// precondition refuses and the row lands `failed` with `precondition_failed:` instead of applying
// twice. Retry is the mechanism; the precondition is what makes it safe.
//
// ── TRANSACTION BOUNDARY: why the hub call is OUTSIDE the claim transaction ────────────────────────
// The claim/lock/precondition transaction COMMITS before the hub call is made. This is deliberate:
//   * Never hold a Postgres advisory lock across network I/O. The hub re-enters this very platform to
//     do the tool's work, and that inbound request can want the same domain lock — holding it here
//     would be a distributed self-deadlock resolved only by a timeout.
//   * There is no atomicity to preserve anyway: the side effect is EXTERNAL (a deploy dispatch). No
//     transaction can make an HTTP call and a row commit atomically, so pretending otherwise by
//     stretching the transaction only adds a deadlock class.
//   * The durable marker is the CLAIM, not the lock. Once `executing` is committed, no redelivery can
//     re-enter, which is the property that actually prevents double-execution.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../db";
import { getExecutable, type ExecutableApprovalEntry } from "./approval-executables";
import {
  ApprovalGrantNotConfiguredError,
  callHubTool,
  mintExecutionGrant,
  type HubCallOutcome,
  type HubObo,
} from "./hub-client";
import { notifyBestEffort } from "./client-notify";
import type { OutboxEvent } from "../events/types";

/** How long an `executing` row must have sat un-updated before D14-07's retry may reclaim it. Long
 *  enough that a slow-but-live attempt is never stolen (HUB_CALL_TIMEOUT_MS is 30s, and an
 *  auto-retrying invocation is bounded by 1 + MAX_AUTO_RETRY_COUNT attempts), short enough that a
 *  crashed release is recoverable inside one working session. */
export const EXECUTING_STALE_MS = 10 * 60 * 1000;

/** Advisory-lock namespace for approval execution: 'AE' + 1. Deliberately distinct from
 *  `PIPELINE_RUN_LOCK_NS` (core/pipeline-lock.ts) and the search module's namespaces so an approval
 *  lock key can never collide with a pipeline-run or cache-key hash in the shared lock space.
 *
 *  Same two-int `pg_advisory_xact_lock($ns, hashtext($key))` idiom as pipeline-lock.ts — the platform
 *  has exactly one advisory-lock spelling and this file does not invent a second.
 *
 *  NOTE FOR REGISTRY AUTHORS (D14-05+): because this namespace is distinct, holding it does NOT
 *  serialize against `lockPipelineRun()`. An entry that needs to be serialized against the pipeline's
 *  own state machine should call `lockPipelineRun(client, runId)` as the FIRST statement of its
 *  `precondition` — it runs on this transaction's client, before any read the verdict depends on,
 *  which is exactly the ordering pipeline-lock.ts requires. */
export const APPROVAL_EXEC_LOCK_NS = 0x41450001;

/** Ceiling on `companies.settings.automation.approvalRetry.autoRetryCount` (D14-07 validates 0..3 on
 *  the write path; this clamp is the read-path twin, so a value edited straight into the jsonb — or a
 *  future settings writer that forgets to validate — can never turn one approval into 50 tool calls). */
export const MAX_AUTO_RETRY_COUNT = 3;

/** `execution_result` is an audit artifact, not a data store: cap it so a chatty tool cannot bloat the
 *  approvals table (and the list endpoint that returns this column) unboundedly. */
export const EXECUTION_RESULT_MAX_CHARS = 4000;

/** Typed `execution_error` prefixes. These are read by the UI (D14-08) and by D14-09's assertions, so
 *  treat them as a contract: add a class rather than reword an existing one. */
export const EXEC_ERROR = {
  /** The server-side re-evaluation refused: the state the approval was filed against is gone. */
  preconditionFailed: "precondition_failed",
  /** The precondition itself threw (a bug or a DB error), so staleness is UNKNOWN — fail closed. */
  preconditionError: "precondition_error",
  /** The hub refused the call: assurance, workflow scope, Cerbos, or a rejected grant. Tool never ran. */
  hubDenied: "hub_denied",
  /** The hub allowed the call and the tool itself threw. May have partially applied. */
  toolError: "tool_error",
  /** No verdict was obtained (unreachable/timeout/non-2xx). The call may or may not have landed. */
  hubUnreachable: "hub_unreachable",
  /** Missing APPROVAL_GRANT_SECRET / HUB_URL / HUB_SERVICE_TOKEN — an unfinished deployment. */
  notConfigured: "not_configured",
  /** The row's original principal could not be reconstructed, so there is no authority to run as. */
  principalUnresolvable: "principal_unresolvable",
  /** The row was claimed but its tool is no longer in the executable registry (or the entry is
   *  incomplete). Fail closed — never fall back to "call it anyway". */
  notExecutable: "not_executable",
} as const;

/** What one invocation did, for D14-07's endpoint and for tests. `skipped` means the claim was not
 *  won — the normal, expected outcome of a redelivery. */
export type ExecutionOutcome =
  | { status: "skipped"; reason: "not_pending" }
  | { status: "executed" }
  | { status: "failed"; error: string };

interface ApprovalRow {
  id: string;
  tenant_id: string;
  workflow_id: string | null;
  tool_name: string;
  tool_args: unknown;
  origin: string;
  requested_by: string | null;
  decided_by: string | null;
  execution_attempts: number;
}

const CLAIM_RETURNING =
  "id, tenant_id, workflow_id, tool_name, tool_args, origin, requested_by, decided_by, execution_attempts";

/** `execution_status='executing'` + untouched for longer than the staleness threshold = wedged by a
 *  dead process. THE crash-wedge predicate; D14-07's retry endpoint imports this instead of
 *  re-deriving the rule (two copies of a staleness threshold is how they drift). */
export function isExecutionWedged(executionStatus: string, updatedAt: Date | string, now = Date.now()): boolean {
  if (executionStatus !== "executing") return false;
  const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(ts) && now - ts > EXECUTING_STALE_MS;
}

/**
 * The core event handler registered for `automation_approval.decided` (main.ts). Mirrors
 * `applyLeaveDecision`'s shape: every event that is not an approved automation/agent write is a
 * harmless no-op, and the row's own state — not the payload — is what authorizes execution.
 *
 * Never throws for a tool/hub/precondition failure: those are recorded terminally on the row and
 * notified, and throwing would only leave the stream entry un-acked to be redelivered into a claim
 * that can no longer succeed (5 useless redeliveries, then a dead-letter that means nothing). It DOES
 * propagate an infrastructure error raised before the claim commits — there, redelivery is exactly
 * the right behaviour because nothing was claimed.
 */
export async function automationApprovalExecutorHandler(event: OutboxEvent): Promise<void> {
  if (event.eventType !== "automation_approval.decided") return;
  const payload = event.payload as { decision?: string; origin?: string };
  if (payload.decision !== "approved") return;
  if (payload.origin !== "automation" && payload.origin !== "agent") return;
  await executeApprovedAutomationWrite(event.tenantId, event.entityId);
}

/**
 * Claim, verify, re-drive, record, notify — for ONE approval row.
 *
 * Also the entry point D14-07's retry endpoint calls after flipping a `failed`/wedged row back to
 * `pending`: same claim, same lock, same precondition, fresh grant. There is deliberately no second
 * implementation of any of it.
 */
export async function executeApprovedAutomationWrite(
  tenantId: string,
  approvalId: string,
): Promise<ExecutionOutcome> {
  // ── Phase 1: ONE transaction — claim, then lock, then re-evaluate the precondition. ──────────────
  const claim = await withTenants([tenantId], async (c) => {
    // Invariant 2. The WHERE clause is the whole single-use guarantee; `RETURNING` gives us the
    // authoritative row (never the event payload — the payload is a copy that could predate an edit,
    // and the grant must bind what is STORED).
    const upd = await c.query<ApprovalRow>(
      `UPDATE automation_approvals
          SET execution_status = 'executing',
              execution_attempts = execution_attempts + 1,
              updated_at = now()
        WHERE id = $1 AND execution_status = 'pending' AND deleted_at IS NULL
        RETURNING ${CLAIM_RETURNING}`,
      [approvalId],
    );
    const row = upd.rows[0];
    if (!row) return { kind: "not_claimed" as const };

    // Defence in depth. Both decide surfaces already refuse to mark anything outside
    // {automation, agent} `pending` (automation-approvals.controller.ts), so reaching this is a bug
    // upstream — but 'hr' auto-executing would DOUBLE-APPLY against modules/hr/leave-decision.ts, so
    // it is re-checked on the authoritative row rather than trusted from two hops away.
    if (row.origin !== "automation" && row.origin !== "agent") {
      const error = `${EXEC_ERROR.notExecutable}: origin '${row.origin}' is not auto-executable`;
      await markFailedInTx(c, approvalId, row, error);
      return { kind: "failed" as const, row, error };
    }

    const entry = getExecutable(row.tool_name);
    if (!entry) {
      // Registered at decide time, gone now (a release that removed the entry, or a row retried
      // afterwards). Fail closed: an unregistered tool has no precondition, and "call it anyway"
      // is precisely the unattended-dispatcher failure this program exists to prevent.
      const error = `${EXEC_ERROR.notExecutable}: no executable registry entry for '${row.tool_name}'`;
      await markFailedInTx(c, approvalId, row, error);
      return { kind: "failed" as const, row, error };
    }

    const args = toolArgsOf(row.tool_args);

    // Invariant 3: lock FIRST, then re-read. Same idiom as core/pipeline-lock.ts.
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [APPROVAL_EXEC_LOCK_NS, entry.lockKey(args)]);

    let verdict: Awaited<ReturnType<ExecutableApprovalEntry["precondition"]>>;
    try {
      verdict = await entry.precondition(c, args);
    } catch (err) {
      // A throw is NOT a pass. It may also have aborted this transaction (any failed PG statement
      // does), so we must not try to write the terminal row here — phase 1b does it on a clean
      // connection, tolerating either outcome of this rollback.
      return { kind: "precondition_threw" as const, row, message: (err as Error)?.message ?? "unknown" };
    }
    if (!verdict.ok) {
      const error = `${EXEC_ERROR.preconditionFailed}: ${verdict.reason}`;
      await markFailedInTx(c, approvalId, row, error);
      return { kind: "failed" as const, row, error };
    }

    // Invariant: retry policy is read at EXECUTION time, never cached at boot (constraint 10). Same
    // connection, same instant as the claim, so a change made in the approvals-settings UI a second
    // ago is already in force with no restart.
    const autoRetryCount = await readAutoRetryCount(c, row.tenant_id);
    return { kind: "claimed" as const, row, args, entry, autoRetryCount };
  });

  if (claim.kind === "not_claimed") {
    // Redelivery, a concurrent executor, an already-executed row, or a row a human decided again.
    // Silence is the specified behaviour — there is nothing wrong here.
    return { status: "skipped", reason: "not_pending" };
  }

  if (claim.kind === "precondition_threw") {
    // Phase 1b — the claim may or may not have survived the rollback, so accept either state.
    const error = `${EXEC_ERROR.preconditionError}: ${claim.message}`;
    await markFailedAfterTx(tenantId, approvalId, claim.row, error);
    await notifyOutcome(tenantId, claim.row, { ok: false, error });
    return { status: "failed", error };
  }

  if (claim.kind === "failed") {
    await notifyOutcome(tenantId, claim.row, { ok: false, error: claim.error });
    return { status: "failed", error: claim.error };
  }

  const { row, args, entry, autoRetryCount } = claim;

  // ── Phase 2: authority. Reconstruct the ORIGINAL filing principal (invariant 1). ─────────────────
  const obo = await resolveRedrivePrincipal(row);
  if (!obo.ok) {
    await markFailedAfterTx(tenantId, approvalId, row, obo.error);
    await notifyOutcome(tenantId, row, { ok: false, error: obo.error });
    return { status: "failed", error: obo.error };
  }

  // ── Phase 3: re-drive, with a bounded in-invocation retry policy. ────────────────────────────────
  //
  // `execution_attempts` after the claim counts THIS attempt, so the number of retries already spent
  // is `attempts - 1`. `autoRetryCount` is the number of ADDITIONAL attempts allowed (0 = manual only,
  // D14-07's own default), which is why the comparison is against the PREVIOUS-attempt count: with
  // autoRetryCount=1 the first failure must be allowed exactly one retry, and reading
  // `execution_attempts < autoRetryCount` off the post-increment value would make 1 mean "no retries"
  // and the setting's lowest non-zero value inert.
  let attempts = row.execution_attempts;
  let outcome = await attemptRedrive(row, args, obo.obo);

  while (outcome.kind !== "ok" && attempts - 1 < autoRetryCount) {
    // A retry is a NEW decision to act, so it re-earns the right: lock + precondition again, on a
    // fresh transaction. This is what makes retrying a `transport` failure safe — if the lost-response
    // attempt actually landed, the precondition now refuses and we stop instead of double-applying.
    const re = await withTenants([row.tenant_id], async (c) => {
      await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [APPROVAL_EXEC_LOCK_NS, entry.lockKey(args)]);
      let verdict: Awaited<ReturnType<ExecutableApprovalEntry["precondition"]>>;
      try {
        verdict = await entry.precondition(c, args);
      } catch (err) {
        return { ok: false as const, reason: `${EXEC_ERROR.preconditionError}: ${(err as Error)?.message ?? "unknown"}` };
      }
      if (!verdict.ok) return { ok: false as const, reason: `${EXEC_ERROR.preconditionFailed}: ${verdict.reason}` };
      const bump = await c.query<{ execution_attempts: number }>(
        `UPDATE automation_approvals
            SET execution_attempts = execution_attempts + 1, updated_at = now()
          WHERE id = $1 AND execution_status = 'executing'
          RETURNING execution_attempts`,
        [row.id],
      );
      // Someone else moved the row out of `executing` (a retry endpoint, a manual fix) — stop rather
      // than race them.
      if (!bump.rows[0]) return { ok: false as const, reason: `${EXEC_ERROR.notExecutable}: row left 'executing' mid-retry` };
      return { ok: true as const, attempts: bump.rows[0].execution_attempts };
    });
    if (!re.ok) {
      // Record the ORIGINAL failure alongside the refusal: "the retry was refused" is only half the
      // story a human needs.
      const error = `${re.reason} (after ${describeOutcome(outcome)})`;
      await markFailedAfterTx(tenantId, approvalId, row, error);
      await notifyOutcome(tenantId, row, { ok: false, error });
      return { status: "failed", error };
    }
    attempts = re.attempts;
    outcome = await attemptRedrive(row, args, obo.obo);
  }

  // ── Phase 4: terminal transition + loud notification (invariant 4). ──────────────────────────────
  if (outcome.kind === "ok") {
    await withTenants([row.tenant_id], (c) =>
      c.query(
        `UPDATE automation_approvals
            SET execution_status = 'executed', executed_at = now(), executed_by = $2,
                execution_error = NULL, execution_result = $3, updated_at = now()
          WHERE id = $1 AND execution_status = 'executing'`,
        [row.id, row.requested_by, JSON.stringify(executionResultOf(outcome))],
      ),
    );
    await notifyOutcome(tenantId, row, { ok: true });
    return { status: "executed" };
  }

  const error = describeOutcome(outcome);
  await markFailedAfterTx(tenantId, approvalId, row, error, executionResultOf(outcome));
  await notifyOutcome(tenantId, row, { ok: false, error });
  return { status: "failed", error };
}

// ────────────────────────────────────── authority resolution ─────────────────────────────────────

/**
 * Rebuild the OBO envelope of the ORIGINAL filing principal (invariant 1). There is deliberately NO
 * fallback: if the original principal cannot be reconstructed we refuse, because every available
 * fallback (the approver, the platform service token, a bare `x-user-id`) would execute the write
 * with authority the filer never had.
 */
async function resolveRedrivePrincipal(
  row: ApprovalRow,
): Promise<{ ok: true; obo: HubObo } | { ok: false; error: string }> {
  if (row.origin === "automation") {
    // The workflow id IS the automation principal's external id (mcp-hub/src/automation-policy.ts:
    // `{ provider: "n8n", externalId: "wf:<name>" }`), which is also the key its AUTOMATION_ALLOWLIST
    // scope is looked up under — so a workflow de-scoped between decide and execute is denied at the
    // hub, exactly as the plan requires.
    if (!row.workflow_id) {
      return { ok: false, error: `${EXEC_ERROR.principalUnresolvable}: automation row has no workflow_id` };
    }
    return { ok: true, obo: { provider: "n8n", externalId: row.workflow_id } };
  }
  // origin='agent': re-drive as the user the row was filed by — the same user the agent itself was
  // acting for (ai-agents carries the triggering human's envelope; an agent can never act with more
  // authority than the human it serves). The hub can only mint a principal from a (provider,
  // externalId) pair, so we resolve the requester's own VERIFIED identity link — the same link the
  // AuthGuard resolved when the row was filed. Unverified links are ignored: an unverified link mints
  // an anonymous principal, and silently executing as anonymous would be a different bug.
  if (!row.requested_by) {
    return { ok: false, error: `${EXEC_ERROR.principalUnresolvable}: agent row has no requested_by` };
  }
  const link = await withGlobal((c) =>
    c.query<{ provider: string; external_id: string }>(
      `SELECT provider, external_id FROM identity_links
        WHERE user_id = $1 AND verified_at IS NOT NULL
        ORDER BY verified_at DESC, provider, external_id
        LIMIT 1`,
      [row.requested_by],
    ),
  );
  const found = link.rows[0];
  if (!found) {
    return {
      ok: false,
      error: `${EXEC_ERROR.principalUnresolvable}: requester has no verified identity link to re-drive as`,
    };
  }
  return { ok: true, obo: { provider: found.provider, externalId: found.external_id } };
}

// ─────────────────────────────────────────── one attempt ─────────────────────────────────────────

/** Mint a FRESH grant (new nonce — the hub burns one per accepted use) and make one hub call. A
 *  missing secret is reported as the configuration failure it is, never as a signature failure. */
async function attemptRedrive(
  row: ApprovalRow,
  args: Record<string, unknown>,
  obo: HubObo,
): Promise<HubCallOutcome> {
  let grantHeader: string;
  try {
    grantHeader = mintExecutionGrant({
      approvalId: row.id,
      tenantId: row.tenant_id,
      toolName: row.tool_name,
      // The SAME value that is sent as `arguments` (hub-client.ts hashes and sends one object) — if
      // these ever diverge the hub rejects every grant as `args_mismatch`.
      args,
    }).header;
  } catch (err) {
    if (err instanceof ApprovalGrantNotConfiguredError) {
      return { kind: "transport", text: `${EXEC_ERROR.notConfigured}: APPROVAL_GRANT_SECRET is unset` };
    }
    throw err;
  }
  return callHubTool({ toolName: row.tool_name, args, obo, grantHeader });
}

/** Map a hub outcome onto the typed `execution_error` contract. */
function describeOutcome(outcome: HubCallOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return "";
    case "denied":
      // The hub's own reason, verbatim — it is the only place a human learns WHICH wall stopped the
      // call (workflow de-scoped, assurance, Cerbos policy, or a rejected grant).
      //
      // HISTORICAL NOTE (do not re-derive): this used to say that under Cerbos-ON an
      // `origin='automation'` re-drive always landed here, because `resource_mcp_tool.yaml` encoded the
      // impact gate independently of the in-code branch D14-04 lifted. **D14-13 closed that** — the
      // policy now admits a verified-grant call for a tool in its executable list, so a correctly
      // granted automation re-drive reaches the tool. A deny arriving here today is therefore a REAL
      // wall (de-scoped workflow, revoked role, tool off the executable list, bad grant), not an
      // expected window — treat it as information, not noise.
      return `${EXEC_ERROR.hubDenied}: ${outcome.text}`;
    case "tool_error":
      return `${EXEC_ERROR.toolError}: ${outcome.text}`;
    case "transport":
      // hub-client already prefixes a configuration failure; don't double-label it.
      return outcome.text.startsWith(EXEC_ERROR.notConfigured)
        ? outcome.text
        : `${EXEC_ERROR.hubUnreachable}: ${outcome.text}`;
  }
}

// ──────────────────────────────────── terminal row transitions ───────────────────────────────────

/** Terminal `failed` inside the caller's transaction (used when the refusal is decided there, so the
 *  claim and the failure commit together and the row is never briefly `executing` for no reason). */
async function markFailedInTx(c: PoolClient, approvalId: string, row: ApprovalRow, error: string): Promise<void> {
  await c.query(
    `UPDATE automation_approvals
        SET execution_status = 'failed', executed_at = now(), executed_by = $3,
            execution_error = $2, updated_at = now()
      WHERE id = $1`,
    [approvalId, error, row.requested_by],
  );
}

/** Terminal `failed` on a fresh connection. Accepts `pending` OR `executing` because a rolled-back
 *  claim leaves the row `pending` again — both are states this invocation is entitled to close out,
 *  and neither can clobber a terminal one. */
async function markFailedAfterTx(
  tenantId: string,
  approvalId: string,
  row: ApprovalRow,
  error: string,
  result?: Record<string, unknown>,
): Promise<void> {
  await withTenants([row.tenant_id || tenantId], (c) =>
    c.query(
      `UPDATE automation_approvals
          SET execution_status = 'failed', executed_at = now(), executed_by = $3,
              execution_error = $2, execution_result = COALESCE($4::jsonb, execution_result),
              updated_at = now()
        WHERE id = $1 AND execution_status IN ('pending', 'executing')`,
      [approvalId, error, row.requested_by, result ? JSON.stringify(result) : null],
    ),
  );
}

/** Size-capped, redacted audit copy of what the tool returned. */
function executionResultOf(outcome: HubCallOutcome): Record<string, unknown> {
  const text = redactForAudit(outcome.text ?? "");
  return {
    outcome: outcome.kind,
    text: text.slice(0, EXECUTION_RESULT_MAX_CHARS),
    truncated: text.length > EXECUTION_RESULT_MAX_CHARS,
  };
}

/**
 * Blunt secret-shaped-substring redaction before a tool's return payload is persisted into a column
 * the approvals list endpoint returns. It is a backstop, not a guarantee: the real rule is that tools
 * must not return credentials. Cheap insurance against a deploy tool echoing a token in its output
 * and turning an audit column into a credential store.
 */
export function redactForAudit(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/("?\b(?:secret|token|password|passwd|api[_-]?key|authorization)\b"?\s*[:=]\s*"?)[^"\s,}]{4,}/gi, "$1[redacted]");
}

// ───────────────────────────────────────── retry policy read ─────────────────────────────────────

/**
 * `companies.settings -> 'automation' -> 'approvalRetry' ->> 'autoRetryCount'`, read FRESH on every
 * execution (constraint 10 — never cached at boot, never memoized). Absent/unparsable/negative => 0,
 * i.e. manual retry only, which is the safe default: an automatic retry of a write whose response was
 * lost is the one place this file could double-apply, so an operator opts INTO it explicitly.
 * `companies` carries no RLS policy, so this reads correctly on the tenant-scoped connection.
 */
async function readAutoRetryCount(c: PoolClient, tenantId: string): Promise<number> {
  const res = await c.query<{ v: string | null }>(
    `SELECT settings -> 'automation' -> 'approvalRetry' ->> 'autoRetryCount' AS v
       FROM companies WHERE id = $1`,
    [tenantId],
  );
  const raw = res.rows[0]?.v;
  const n = raw === null || raw === undefined ? 0 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_AUTO_RETRY_COUNT);
}

// ──────────────────────────────────────────── notification ───────────────────────────────────────

/**
 * Invariant 4. BOTH outcomes notify, and both recipients are told: the human who lifted the gate
 * (`decided_by`) and the principal that filed it (`requested_by`, so an automation account's
 * notification is visible to whoever monitors that account's inbox). `failed` is `warning` — that is
 * what puts it on the bell and through the MAIL-05 email tap rather than into a log line nobody reads.
 *
 * `notifyBestEffort` per house convention: a notification failure must never fail (or roll back) the
 * execution transition it is announcing, and `actorId: null` is deliberate — `notify()` skips a
 * recipient equal to the actor, and the approver must still be told about the execution they approved.
 */
async function notifyOutcome(
  tenantId: string,
  row: ApprovalRow,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const recipients = [...new Set([row.decided_by, row.requested_by].filter((id): id is string => !!id))];
  if (!recipients.length) return;
  const type = result.ok ? "automation_approval.executed" : "automation_approval.execution_failed";
  await notifyBestEffort(tenantId || row.tenant_id, null, recipients, type, {
    title: result.ok
      ? `Approved automation write executed: ${row.tool_name}`
      : `Approved automation write FAILED to execute: ${row.tool_name}`,
    body: result.ok ? undefined : result.error,
    href: `/approvals/${row.id}`,
    entityType: "automation_approval",
    entityId: row.id,
    severity: result.ok ? "info" : "warning",
    origin: row.origin,
    tool: row.tool_name,
    ...(result.ok ? {} : { executionError: result.error }),
  });
}

// ─────────────────────────────────────────────── misc ────────────────────────────────────────────

/** `tool_args` is `jsonb NOT NULL DEFAULT '{}'`, but a null/array/scalar value must not become the
 *  arguments object of a real tool call — coerce to `{}` so the grant digest and the sent arguments
 *  agree on one well-formed value.
 *
 *  EXPORTED for D14-10 (`automation-approvals.controller.ts`'s `resolve-and-execute`), which must
 *  digest a stored row's args with the EXACT same coercion this file will use when it sends them.
 *  Two copies of this one-liner would be two encodings of "what the grant actually binds": a row
 *  whose `tool_args` is `null` would match one side's `{}` digest and not the other's, and the
 *  mismatch would surface as an unexplainable no-match (re-file) or, worse, a match on args that are
 *  not the args sent. One function, one rule. */
export function toolArgsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}
