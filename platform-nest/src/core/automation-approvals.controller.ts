// WS4 §3 / D14 — automation approvals suspension surface. When the mcp-hub write gate refuses a
// medium+/unclassified write for an n8n automation principal, the workflow calls the hub's
// `approvals.request` tool (OBO), which lands here as a create. A human then reads the pending
// inbox and decides. The store is tenant-scoped (FORCE RLS, 0014) and Cerbos-gated: automation
// service accounts may CREATE, elevated humans READ, and only company_admin/group_executive DECIDE.
//
// v1 records + decides; it does NOT re-drive the approved tool call (that is a Temporal/durable
// concern the spec defers). The approved row is the durable artifact a future resume step reads.
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { notifyBestEffort } from "./client-notify";
import { resolveAutomationApprovalDeciders } from "./approval-deciders";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { getExecutable } from "./approval-executables";
import { EXECUTING_STALE_MS, executeApprovedAutomationWrite, isExecutionWedged, toolArgsOf } from "./approval-execute";
import { computeArgsSha256 } from "./hub-client";

const IMPACTS = new Set(["medium", "high", "unclassified"]);
const ORIGINS = new Set(["automation", "agent"]);

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14-10 — the resolve-and-execute wire contract.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// `ai-agents/src/agent.ts` declares a STRUCTURALLY IDENTICAL `ApprovalResolution` (it cannot import
// from this project — separate standalone projects, not a monorepo). The two must be edited together;
// each side's header names the other.
//
// WHY EVERY BRANCH IS A 200 AND NOT AN HTTP STATUS: the caller is a state machine, not a person. It
// has to distinguish "no decided row exists (file one)" from "a human rejected this (do NOT file
// one)" from "already executed (consume the result)". Mapping those onto 404/409/200 would force the
// runner to infer semantics from status codes, and the single most dangerous inference — treating any
// non-200 as "nothing on file" — is exactly the duplicate-approval generator this ticket exists to
// kill. `match` is therefore always explicit. Genuine FAULTS (bad request, not authorized) remain
// real HTTP errors precisely so the runner can never mistake them for `match: "none"`.
export type ApprovalResolution =
  /** No decided row binds this exact (agent, tool, args). The caller does what it does today: throw
   *  `ApprovalRequiredError` and file a fresh approval. D14's existing path, byte for byte. */
  | { match: "none" }
  /** The write is DONE — either executed by this call, or already executed and now consumed from
   *  `execution_result` without re-calling the tool. `consumed` distinguishes the two for the audit
   *  trail only; the `result` is read from the SAME column either way, so the caller cannot tell (and
   *  therefore cannot diverge) between the two orders of the executor/re-run race. */
  | { match: "executed"; approvalId: string; consumed: boolean; result: string; truncated: boolean }
  /** A human REJECTED this exact call. A typed refusal for the transcript — never a re-file.
   *  `reason` is the row's own `reason` column, i.e. the SUSPENSION reason it was FILED with — there
   *  is no rejection-comment field on `automation_approvals`, and inventing one here would be schema
   *  work. Callers must not present it as the human's grounds for refusing. */
  | { match: "rejected"; approvalId: string; reason: string }
  /** Claimed by another executor and in flight. Loud wait/fail; a later re-run finds `executed`. */
  | { match: "executing"; approvalId: string }
  /** Execution was attempted and failed terminally. A human retries (D14-07) — the agent must not,
   *  because a `tool_error`/`hub_unreachable` failure MAY have partially applied. */
  | { match: "failed"; approvalId: string; error: string }
  /** Approved, but the platform cannot execute it: the tool has no `core/approval-executables.ts`
   *  entry, so `decide()` left `execution_status='not_applicable'`. Fail closed — this is NOT a
   *  licence for the caller to run the tool itself. */
  | { match: "not_executable"; approvalId: string; reason: string };

/**
 * Which approved row to act on when SEVERAL decided rows bind the identical call. Lower wins.
 *
 * This ordering is a safety rank, not a convenience: duplicate rows for one call are exactly what the
 * pre-D14-10 re-run generated (replay ⇒ re-suspend ⇒ re-file), so they exist in real data. The rule
 * is "any evidence this exact call already reached the hub outranks a fresh claim":
 *
 *   executed   — a result exists; consume it and never claim a second row for the same call.
 *   executing  — in flight; claiming a sibling row would be a SECOND concurrent execution.
 *   failed     — already attempted. `tool_error`/`hub_unreachable` may have partially applied, so
 *                claiming a sibling would risk double-applying. A human's D14-07 retry re-evaluates
 *                the precondition first, which is the safe form of the same operation.
 *   pending    — nothing has been attempted; this is the row to claim.
 *   not_applicable — approved but unexecutable; last, because any of the above is more informative.
 */
const APPROVED_EXECUTION_RANK: Record<string, number> = {
  executed: 0,
  executing: 1,
  failed: 2,
  pending: 3,
  not_applicable: 4,
};

interface DecidedCandidate {
  id: string;
  status: string;
  execution_status: string;
  execution_error: string | null;
  execution_result: { text?: string; truncated?: boolean } | null;
  tool_args: unknown;
  reason: string | null;
  requested_by: string | null;
}

/** Map ONE row's current execution state onto the wire contract. `consumed` is true whenever the
 *  result was read from a prior execution rather than produced by the caller's own claim. */
function resolutionOf(row: DecidedCandidate, consumed: boolean): ApprovalResolution {
  switch (row.execution_status) {
    case "executed":
      return {
        match: "executed",
        approvalId: row.id,
        consumed,
        result: typeof row.execution_result?.text === "string" ? row.execution_result.text : "",
        truncated: row.execution_result?.truncated === true,
      };
    case "executing":
      return { match: "executing", approvalId: row.id };
    case "failed":
      return { match: "failed", approvalId: row.id, error: row.execution_error ?? "execution failed" };
    case "not_applicable":
      return {
        match: "not_executable",
        approvalId: row.id,
        // Typed like a precondition reason (snake_case, contract-stable) because the agent transcript
        // and the UI both surface it verbatim.
        reason: "no_executable_registry_entry",
      };
    default:
      // 'pending' reached here means the row went BACK to pending after our claim was refused (a
      // concurrent D14-07 retry). Reported as in-flight rather than claimed a second time: someone
      // else owns this row's execution right now.
      return { match: "executing", approvalId: row.id };
  }
}

@Controller("api")
@UseGuards(AuthGuard)
export class AutomationApprovalsController {
  // Record a suspended automation write for human review. Called by scoped n8n service accounts
  // via the hub `approvals.request` tool after the hub gate returned a `suspend:` reason.
  @Post(":tenantId/automation-approvals")
  @HttpCode(201)
  async create(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { workflowId?: string; toolName?: string; toolArgs?: Record<string, unknown>; impact?: string; reason?: string; origin?: string; agentName?: string },
  ) {
    const { workflowId, toolName, toolArgs = {}, impact = "unclassified", reason, origin = "automation", agentName } = body ?? {};
    if (!workflowId || !toolName) throw new BadRequestException("workflowId and toolName required");
    if (!IMPACTS.has(impact)) throw new BadRequestException("impact must be medium|high|unclassified");
    if (!ORIGINS.has(origin)) throw new BadRequestException("origin must be automation|agent");
    await authorize(req.principal, { kind: "automation_approval", tenantId }, "create");
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason, requested_by, origin, agent_name, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, tenantId, workflowId, toolName, JSON.stringify(toolArgs), impact, reason ?? null, req.principal.userId, origin, agentName ?? null, config.originSite],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "suspended", "automation_approval", id, { workflowId, toolName, impact, origin, agentName });
    // MAIL-06 (F1 fix): notify the resolved decider set — this is what gives the row a bell (and,
    // via the MAIL-05 tap, an email) for the FIRST time; previously nobody was told an approval was
    // filed. `origin` is constrained to automation|agent by ORIGINS above (never 'hr' through this
    // endpoint — hr-origin rows are created directly by hr.controller.ts's fileLeave()), so the
    // module param below is always undefined here; it is passed through defensively rather than
    // hardcoded because resolveAutomationApprovalDeciders() is the SAME helper hr.controller.ts calls.
    const deciders = await resolveAutomationApprovalDeciders(tenantId, origin === "hr" ? "hr" : undefined);
    await notifyBestEffort(tenantId, req.principal.userId, deciders, "approval.requested", {
      title: reason ?? `${toolName} (${workflowId})`,
      // APPR-01: was the bare list (`/approvals`) — a decider clicking the email had to hunt for
      // the row. `entityId` above is `id`, the row this notification is actually about; the
      // per-approval detail route (`platform-ui` `/approvals/[id]`) resolves it against BOTH
      // `GET :tenantId/automation-approvals/:id` (below) and the agency equivalent, so this same
      // shape works for every origin this controller files (automation/agent/hr).
      href: `/approvals/${id}`,
      entityType: "automation_approval",
      entityId: id,
      origin,
      impact,
      tool: toolName,
      severity: impact === "high" ? "warning" : "info",
    });
    return { id, status: "pending" };
  }

  // APPR-01 — single-row read backing `platform-ui`'s `/approvals/[id]` detail page. Fetch BEFORE
  // authorize (mirrors `decide()` below, WSD-4): the row's real `origin` decides whether the
  // module=='hr' branch of `resource_automation_approval.yaml` applies, and RLS (withTenants) has
  // already made a cross-tenant id invisible, so "not found for this tenant" is a genuine 404 with
  // no information disclosed — never weaker than the list endpoint's own gate.
  @Get(":tenantId/automation-approvals/:id")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const { rows } = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT a.id, a.workflow_id AS "workflowId", a.tool_name AS "toolName", a.tool_args AS "toolArgs",
                a.impact, a.reason, a.status, a.origin, a.agent_name AS "agentName",
                a.requested_by AS "requestedBy", ru.name AS "requestedByName",
                a.decided_by AS "decidedBy", du.name AS "decidedByName",
                a.decided_at AS "decidedAt", a.created_at AS "createdAt",
                a.execution_status AS "executionStatus", a.executed_at AS "executedAt", a.executed_by AS "executedBy",
                a.execution_error AS "executionError", a.execution_result AS "executionResult", a.execution_attempts AS "executionAttempts"
         FROM automation_approvals a
         LEFT JOIN users ru ON ru.id = a.requested_by
         LEFT JOIN users du ON du.id = a.decided_by
         WHERE a.id = $1 AND a.deleted_at IS NULL`,
        [id],
      ),
    );
    const row = rows[0] as { origin: string } | undefined;
    if (!row) throw new NotFoundException("approval not found");
    const module = row.origin === "hr" ? "hr" : undefined;
    await authorize(req.principal, { kind: "automation_approval", id, tenantId, module }, "read");
    return row;
  }

  @Get(":tenantId/automation-approvals")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    // WSD-4: an optional origin filter. origin='hr' additionally passes resource.attr.module
    // so an hr_manager (module_manager, no company_admin grant) can read the served company's
    // leave-approval slice of the unified inbox — the module_manager rule in
    // resource_automation_approval.yaml is scoped tightly to module=='hr' (WSD-2), so this
    // never widens visibility for any other origin.
    @Query("origin") origin?: string,
  ) {
    await authorize(req.principal, { kind: "automation_approval", tenantId, module: origin === "hr" ? "hr" : undefined }, "read");
    const filterPending = status === undefined || status === "pending";
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (filterPending) clauses.push("status = 'pending'");
    else if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (origin) { params.push(origin); clauses.push(`origin = $${params.length}`); }
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        // D14-02: execution_status/executed_at/executed_by/execution_error/execution_result/
        // execution_attempts (0078) — an approved-but-unexecuted row must be visibly distinguishable
        // from a done one (the resume-path program's whole point; see 0078's header).
        `SELECT id, workflow_id, tool_name, tool_args, impact, reason, status, origin, agent_name, requested_by, decided_by, decided_at, created_at,
                execution_status, executed_at, executed_by, execution_error, execution_result, execution_attempts
         FROM automation_approvals
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC LIMIT 200`,
        params,
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/automation-approvals/:id/decide")
  @HttpCode(200)
  async decide(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { decision?: "approved" | "rejected" },
  ) {
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "rejected") throw new BadRequestException("decision must be approved|rejected");
    // WSD-4: fetch the row's origin BEFORE authorizing, so an hr-origin approval carries
    // resource.attr.module='hr' — the ONLY way the module_manager derived role (the
    // providing unit's hr_manager, who is not necessarily the served company's admin) can
    // decide (resource_automation_approval.yaml, WSD-2). Every other origin is unaffected
    // (module stays "").  404s here (not 403) when the id doesn't exist/isn't visible, same
    // as before this change — no new information disclosed to a non-authorized caller.
    const existing = await withTenants([tenantId], (c) =>
      c.query<{ origin: string; tool_name: string }>(`SELECT origin, tool_name FROM automation_approvals WHERE id = $1 AND deleted_at IS NULL`, [id]),
    );
    if (!existing.rows[0]) throw new NotFoundException("approval not found or already decided");
    const rowOrigin = existing.rows[0].origin;
    const rowToolName = existing.rows[0].tool_name;
    const module = rowOrigin === "hr" ? "hr" : undefined;
    await authorize(req.principal, { kind: "automation_approval", id, tenantId, module }, "decide");
    // D14-02: the executor is REGISTRY-scoped, not origin-scoped (approval-executables.ts's own
    // doctrine + migration 0078's header). execution_status is computed here and flipped in the
    // SAME UPDATE that flips `status` below — never a second statement — so a crash between the two
    // transitions is impossible. The origin check runs BEFORE the registry lookup (not merely
    // implied by an absent registration) so origin='hr' and any future origin outside
    // {automation, agent} can never become auto-executable even if its tool_name were mistakenly
    // registered — that is what keeps HR's own decided-event handler (modules/hr/leave-decision.ts)
    // safe from double-application. Rejected decisions and unregistered tools (incl. every
    // money-spending search.* apply tool, permanently barred from this registry) fall through to
    // 'not_applicable', same as today.
    const executable = decision === "approved" && (rowOrigin === "automation" || rowOrigin === "agent")
      ? getExecutable(rowToolName)
      : undefined;
    const executionStatus: "pending" | "not_applicable" = executable ? "pending" : "not_applicable";
    const res = await withTenants([tenantId], async (c) => {
      const upd = await c.query<{ origin: string; tool_args: unknown; workflow_id: string; tool_name: string }>(
        `UPDATE automation_approvals
           SET status = $2, decided_by = $3, decided_at = now(), updated_at = now(), execution_status = $4
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
         RETURNING origin, tool_args, workflow_id, tool_name`,
        [id, decision, req.principal.userId, executionStatus],
      );
      if (upd.rowCount === 0) return null;
      // Outbox event so module eventHandlers (WSD-4: HR's leave-decision handler) can react.
      // entityType "automation_approval" — see startConsumerLoop's watched streams in main.ts.
      await emitEvent(c, tenantId, "automation_approval", id, "automation_approval.decided", {
        decision,
        origin: upd.rows[0].origin,
        toolArgs: upd.rows[0].tool_args,
        workflowId: upd.rows[0].workflow_id,
        toolName: upd.rows[0].tool_name,
        decidedBy: req.principal.userId,
      });
      return upd.rows[0];
    });
    if (!res) throw new NotFoundException("approval not found or already decided");
    await writeActivity(tenantId, req.principal.userId, decision, "automation_approval", id);
    return { id, status: decision };
  }

  // D14-07 — re-drive execution for a row the executor left in a terminal `failed` state, or
  // wedged in `executing` by a process that died mid-flight (approval-execute.ts's crash-wedge
  // rule). This does NOT re-decide anything: `status` (approved/rejected) is untouched, only
  // `execution_status` moves back to `pending` so `executeApprovedAutomationWrite` — the SAME
  // entry point D14-03 registers for the decided event — can re-claim it. No second executor.
  @Post(":tenantId/automation-approvals/:id/retry")
  @HttpCode(200)
  async retry(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    // Fetch BEFORE authorize (same WSD-4 reason `decide()` above documents): an hr-origin row
    // needs resource.attr.module='hr' for the module_manager rule to even apply — though that
    // rule grants 'decide' only, never 'retry' (resource_automation_approval.yaml, D14-06), so an
    // hr row can never actually be retried by anyone but company_admin/group_executive/superadmin.
    // hr rows also never reach `failed`/`executing` in the first place (D14-02's origin gate keeps
    // them 'not_applicable' forever) — this is defence in depth, not a load-bearing branch.
    const existing = await withTenants([tenantId], (c) =>
      c.query<{ origin: string; execution_status: string; updated_at: Date }>(
        `SELECT origin, execution_status, updated_at FROM automation_approvals WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    const row = existing.rows[0];
    if (!row) throw new NotFoundException("approval not found");
    const module = row.origin === "hr" ? "hr" : undefined;
    await authorize(req.principal, { kind: "automation_approval", id, tenantId, module }, "retry");

    // Eligibility (D14-03.8's crash-wedge rule, imported rather than re-derived): `failed`, or
    // `executing` whose `updated_at` is older than EXECUTING_STALE_MS. `isExecutionWedged` is used
    // here purely to shape the 409's message; the ATOMIC guard is the UPDATE's own WHERE clause
    // below (using the same imported constant) so a state change between this read and that write
    // can never sneak a fresh `executing` row — or an already-`executed`/`pending` one — through.
    if (row.execution_status !== "failed" && !isExecutionWedged(row.execution_status, row.updated_at)) {
      throw new ConflictException(`cannot retry: execution_status='${row.execution_status}'`);
    }
    const staleCutoff = new Date(Date.now() - EXECUTING_STALE_MS);
    const claimed = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(
        `UPDATE automation_approvals
            SET execution_status = 'pending', updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
            AND (execution_status = 'failed' OR (execution_status = 'executing' AND updated_at < $2))
          RETURNING id`,
        [id, staleCutoff],
      ),
    );
    if (claimed.rowCount === 0) {
      // Lost the race between the read above and this UPDATE (a concurrent retry, or the executor
      // itself moved the row) — same 409 a caller would have gotten from a fresh read.
      throw new ConflictException(`cannot retry: execution_status='${row.execution_status}'`);
    }
    await writeActivity(tenantId, req.principal.userId, "retried", "automation_approval", id);
    // Same entry point D14-03's own event handler calls: same claim, same advisory lock, same
    // precondition re-evaluation, a freshly minted grant. Awaited so the caller (a human clicking
    // Retry, or D14-09's tests) observes the terminal outcome synchronously rather than polling.
    const outcome = await executeApprovedAutomationWrite(tenantId, id);
    return { id, ...outcome };
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // D14-10 — the approval-aware AGENT RE-RUN surface. What makes the owner's locked D14-b decision
  // (resume a suspended agent goal by RE-RUNNING IT FROM THE TOP) make forward progress instead of
  // looping.
  //
  // THE DEFECT THIS CLOSES: `ai-agents/src/agent.ts` threw `ApprovalRequiredError` on a `high_write`
  // UNCONDITIONALLY, with no knowledge of an already-decided row. So a re-run replayed steps 1..N-1,
  // re-suspended at N, and filed a SECOND approval plus a SECOND notification email — a duplicate
  // generator that could never pass its own suspension point.
  //
  // ── THE BINDING (why an approval can never pre-authorize a different call) ───────────────────────
  // A row matches only on (origin='agent', workflow_id = agentName, tool_name, argsSha256) where the
  // digest is the SAME canonical-JSON SHA-256 the execution grant binds (§1 of the ticket doc,
  // implemented once in `core/hub-client.ts` and mirrored byte-for-byte by
  // `mcp-hub/src/approval-grant.ts`). One field different in `toolArgs` ⇒ a different digest ⇒ NO
  // match ⇒ the caller suspends anew. There is deliberately no fuzzy/subset matching: "approved
  // deploy of run A" must never authorize "deploy run B", and a human who approved a specific set of
  // arguments approved exactly those.
  //
  // ── AUTHORITY (§1: the ORIGINAL requester, never the approver) ───────────────────────────────────
  // Two independent gates, and they check DIFFERENT things:
  //   1. Cerbos `create` on `automation_approval` — the same right needed to FILE this suspension in
  //      the first place (the agent reaches both surfaces through the hub under the triggering
  //      human's OBO envelope). Deliberately not `decide`: the decider set is the standing-superadmin
  //      approver population (OQ-1), and gating execution on `decide` would invite exactly the
  //      privilege amplification `approval-execute.ts`'s invariant 1 forbids — the approver's
  //      authority is spent on lifting the gate, never on running the write.
  //   2. `requested_by == principal.id`. The row must be YOURS. Another user's approval — including
  //      the approver's own view of it — is not resolvable here.
  // A caller who matches a row that is not theirs gets a 403, NOT `match: "none"`. That distinction
  // is load-bearing: `none` means "file one", so answering an authority failure with `none` would
  // turn a permission problem back into the duplicate-approval generator.
  //
  // ── SINGLE USE ACROSS BOTH CLAIM ORDERS ─────────────────────────────────────────────────────────
  // No new execution path and NO change to D14-03's claim. This endpoint drives
  // `executeApprovedAutomationWrite` — the same entry point the decided-event handler and D14-07's
  // retry call — whose `WHERE execution_status = 'pending'` claim exactly one caller can win.
  //   * executor first, then re-run  ⇒ executor wins the claim; the re-run finds `executed` and
  //                                    consumes `execution_result`. ONE hub call.
  //   * re-run first, then redelivery ⇒ the re-run wins the claim; the redelivered event's claim
  //                                    returns zero rows and no-ops. ONE hub call.
  // Whoever claims first executes; the loser consumes. Both orders are asserted, with the hub call
  // COUNTED, in `approval-resolve-execute.test.ts`.
  @Post(":tenantId/automation-approvals/resolve-and-execute")
  @HttpCode(200)
  async resolveAndExecute(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { agentName?: string; toolName?: string; toolArgs?: Record<string, unknown> },
  ): Promise<ApprovalResolution> {
    const agentName = body?.agentName;
    const toolName = body?.toolName;
    if (!agentName || !toolName) throw new BadRequestException("agentName and toolName required");
    // Normalized through the SAME coercion the executor applies before hashing and sending
    // (`toolArgsOf`), so the digest compared here is the digest of the args that would actually go on
    // the wire — not of a shape that only exists in this request body.
    const toolArgs = toolArgsOf(body?.toolArgs);
    await authorize(req.principal, { kind: "automation_approval", tenantId }, "create");

    const wanted = computeArgsSha256(toolArgs);
    // Candidate set: this tenant (RLS), this agent, this tool, DECIDED. Bounded — a single agent/tool
    // pair accumulating more than this many decided rows is itself the pathology, and the digest
    // filter below is applied in TS because the digest is canonical JSON, not a Postgres expression
    // (re-implementing the canonicalization in SQL would be a third encoding of the contract).
    const candidates = await withTenants([tenantId], (c) =>
      c.query<DecidedCandidate>(
        `SELECT id, status, execution_status, execution_error, execution_result, tool_args, reason, requested_by
           FROM automation_approvals
          WHERE origin = 'agent' AND workflow_id = $1 AND tool_name = $2
            AND status IN ('approved', 'rejected') AND deleted_at IS NULL
          ORDER BY decided_at DESC NULLS LAST, created_at DESC
          LIMIT 200`,
        [agentName, toolName],
      ),
    );
    const matching = candidates.rows.filter((r) => computeArgsSha256(toolArgsOf(r.tool_args)) === wanted);
    if (!matching.length) return { match: "none" };

    // Authority gate 2. A decided row for this exact call EXISTS but belongs to someone else: loud
    // 403, never a silent `none` (see the header — `none` would make the caller file a duplicate).
    const mine = matching.filter((r) => r.requested_by === req.principal.userId);
    if (!mine.length) {
      throw new ForbiddenException(
        "not authorized: an approved execution may be resolved only by the principal that filed it",
      );
    }

    const approved = mine
      .filter((r) => r.status === "approved")
      .sort(
        (a, b) =>
          (APPROVED_EXECUTION_RANK[a.execution_status] ?? 9) - (APPROVED_EXECUTION_RANK[b.execution_status] ?? 9),
      );
    if (!approved.length) {
      // Every matching row of mine was REJECTED. Typed refusal; the caller must NOT re-file the
      // identical call (that is what asking a human twice for the same already-refused write is).
      // `mine` is already ordered decided_at DESC, so this is the most recent decision.
      const rejected = mine[0];
      return { match: "rejected", approvalId: rejected.id, reason: rejected.reason ?? "" };
    }

    const row = approved[0];
    if (row.execution_status !== "pending") {
      // Nothing to claim: consume / report whatever the row already says. `consumed: true` on the
      // `executed` branch is the executor-won-the-race half of the pair.
      const resolution = resolutionOf(row, true);
      if (resolution.match === "executed") {
        await writeActivity(tenantId, req.principal.userId, "consumed", "automation_approval", row.id, {
          agentName,
          toolName,
        });
      }
      return resolution;
    }

    // `pending` — try to claim it. Same claim, same advisory lock, same server-side precondition
    // re-evaluation, a freshly minted grant: `executeApprovedAutomationWrite` is the ONE executor.
    const outcome = await executeApprovedAutomationWrite(tenantId, row.id);
    if (outcome.status === "failed") return { match: "failed", approvalId: row.id, error: outcome.error };
    if (outcome.status === "executed") {
      await writeActivity(tenantId, req.principal.userId, "resumed", "automation_approval", row.id, {
        agentName,
        toolName,
      });
      return await currentResolution(tenantId, row.id, false);
    }
    // `skipped` — the row left `pending` between our SELECT and our claim: the decided-event executor
    // (or a D14-07 retry) won it. That is the race working correctly, so re-read and consume whatever
    // the winner produced instead of racing them for a second execution.
    return await currentResolution(tenantId, row.id, true);
  }
}

/**
 * Re-read ONE row and map its post-execution state. Used for both the we-executed-it and the
 * we-lost-the-claim paths so the `result` a caller receives comes from the SAME column in both — the
 * property that makes the two claim orders indistinguishable to the runner, and therefore impossible
 * for it to handle differently.
 *
 * `consumed` cannot be derived from the row (an `executed` row looks identical whoever wrote it), so
 * the caller passes it: false when this request's own claim produced the result, true when the claim
 * was lost and we are reading someone else's. A missing row (deleted mid-flight) reads as `none`
 * rather than throwing: there is nothing to consume and nothing to blame.
 */
async function currentResolution(tenantId: string, approvalId: string, consumed: boolean): Promise<ApprovalResolution> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<DecidedCandidate>(
      `SELECT id, status, execution_status, execution_error, execution_result, tool_args, reason, requested_by
         FROM automation_approvals WHERE id = $1 AND deleted_at IS NULL`,
      [approvalId],
    ),
  );
  const row = rows[0];
  if (!row) return { match: "none" };
  return resolutionOf(row, consumed);
}
