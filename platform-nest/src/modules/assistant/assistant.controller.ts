// Assistant module routes (ASST-05). Mounted at /api/:tenantId/assistant/* (no "/modules/"
// segment — matches the literal BFF contract in docs/blueprints/assistant-foundation.md's
// "Proposed BFF contract" table and docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md
// §5, same top-level-prefix convention as PmController/ItController rather than HrController's
// "/modules/hr" mount). Gated by AuthGuard + ModuleEnabledGuard("assistant").
//
// ── AUTHORIZATION MODEL (blueprint §6, ASST-02's live Cerbos policy) ──────────────────────────────
// `assistant_thread` is OWNER-ONLY end to end, with NO company_admin/group_executive/superadmin
// bypass (deliberate — see resource_assistant_thread.yaml's header). Every authorize() call below
// passes `ownerId`:
//   - list: the caller's OWN id (the query is inherently self-scoped — WHERE owner_user_id =
//     principal — so this is the same "am I this thread's owner" check every other action makes,
//     not a widening of it).
//   - create: the caller's own id (they are about to become the new thread's owner).
//   - read/update/delete: the FETCHED row's owner_user_id — never trusted from the request.
// A thread that exists but belongs to someone else in the SAME tenant is visible to a plain SELECT
// scoped only by tenant+module RLS (RLS does not know about "owner"), so it is authorize() —
// Cerbos's `owns` variable — that turns that into a 403, matching the codebase's established
// fetch-then-authorize idiom (see core/integrations.controller.ts's owner-vs-manager pattern).
//
// ── THE TWO-SIDED MODULE WALL ──────────────────────────────────────────────────────────────────────
// Every DB access below passes `{ modules: ["assistant"] }` to withTenants — omitting it reads/
// writes ZERO rows even for the correct tenant (app_module_allowed('assistant'), migration 0079).
//
// ── NO writeActivity()/notify() HERE, ON PURPOSE ──────────────────────────────────────────────────
// core.controller.ts's `GET :tenantId/activity` is readable by every plain tenant member
// (resource_activity.yaml grants "read" to company_admin/manager/member/viewer/team_lead). Writing
// thread create/update/delete into that shared feed would leak a private thread's EXISTENCE (and,
// via the verb/metadata bag, its title) to people who have no Cerbos grant to read the thread
// itself — exactly the class of admin-adjacent backdoor ASST-02's policy header says not to build.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { assembleContext, persistCompactionUpdate, type ContextCitation } from "./context";
import {
  abortForClientDisconnect, citationParts, estimateTokens, persistGenerationOutcome, relayGeneration, releaseGeneration, reserveGeneration, requestStop, sessionResumeMismatchParts, sseLine, usageMetaParts,
} from "./stream";
import {
  ASSISTANT_AGENT_TOOLS, DEFAULT_TOOL_AGENT, persistToolCalls, readTurnMode, runToolTurn, turnModePart, type ToolTurnResult,
} from "./broker";
import { assembleCapabilities } from "./capabilities";
import { resolveCitation } from "./citations";
import { createHandoff, fetchEpisodicHistory, fetchRoster, listHandoffsForThread } from "./handoffs";
import { confirmWriteIntent, dismissWriteIntent, reapExpiredIntents, type ToolCallIntent } from "./write-intents";
import { notifyApprovalFiled } from "../../core/approval-filing";
import { deriveServerThreadTitle } from "./thread-title";
import { lockAssistantThread } from "./thread-lock";

// ── ASST-06 — the send->stream engine ────────────────────────────────────────────────────────────
//
// ── THE "PENDING PLACEHOLDER" DESIGN (no schema change needed) ────────────────────────────────────
// `assistant_messages` has no `status` column. Instead, "there is an in-flight generation for this
// thread" is represented STRUCTURALLY: `POST .../messages` inserts the user's message AND an
// assistant-role placeholder (content=NULL, error_kind=NULL) in the SAME transaction, at seq N and
// N+1. That placeholder row IS the reservation:
//   - its EXISTENCE is what `GET .../stream?messageId=<placeholder id>` looks up to know what to
//     generate and where to write the answer;
//   - its `content IS NULL AND error_kind IS NULL` state is what the precondition check in
//     `sendMessage` reads to refuse (409) a SECOND concurrent send to the same thread — exactly the
//     D14 lesson this ticket calls out ("a lock alone is insufficient without a server-side
//     precondition re-check", pipeline-lock.ts's header): the advisory lock only serializes the
//     two racing transactions' turns, the precondition re-read INSIDE the lock is what makes the
//     loser actually refuse instead of both proceeding.
//   - it is ALWAYS finalized (content set to a real string, possibly empty; error_kind set on any
//     non-`done` outcome) by the stream/stop code paths below, which is what releases the thread
//     for a new send.
//
// ── ADVISORY LOCK: OWN NAMESPACE, SAME IDIOM AS pipeline-lock.ts ─────────────────────────────────
// `lockAssistantThread` is the same `pg_advisory_xact_lock(NS, hashtext(id))` idiom
// `core/pipeline-lock.ts` established for WD-29 (DEF-2) — xact-scoped, released on COMMIT/ROLLBACK,
// taken as the FIRST statement inside the transaction so the read-then-write it protects is
// atomic against a second racing sender. A NEW, distinct namespace constant is used (not
// PIPELINE_RUN_LOCK_NS) for the same reason search's own two namespaces are distinct from
// pipeline's: an assistant thread id and a pipeline run id must never hash-collide into shared
// contention across two unrelated domains.
//
// Extracted into `thread-lock.ts` (still this exact namespace + function) so `handoffs.ts`'s
// handoff-suspension harvest can take the SAME lock without a controller<->handoffs import cycle —
// see that file's header.

const MAX_MESSAGE_CONTENT_LENGTH = 20_000;
const MAX_MEMORY_CONTENT_LENGTH = 2_000;
const MEMORY_SCOPES = new Set(["user", "company"]);
const DEFAULT_MEMORY_LIST_LIMIT = 100;
const MAX_MEMORY_LIST_LIMIT = 500;

const THREAD_STATUSES = new Set(["active", "archived"]);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

interface ThreadRow {
  id: string;
  ownerUserId: string;
  title: string | null;
  brainProvider: string | null;
  brainModel: string | null;
  hermesSessionId: string | null;
  status: string;
  pinned: boolean;
  lastMessageAt: string | null;
  totalTokens: number;
  totalCostUsd: string;
  compactionSummary: string | null;
  compactionSummaryUptoSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

const THREAD_SELECT = `
  SELECT id, owner_user_id AS "ownerUserId", title, brain_provider AS "brainProvider", brain_model AS "brainModel",
         hermes_session_id AS "hermesSessionId", status, pinned, last_message_at AS "lastMessageAt",
         total_tokens AS "totalTokens", total_cost_usd AS "totalCostUsd",
         compaction_summary AS "compactionSummary", compaction_summary_upto_seq AS "compactionSummaryUptoSeq",
         created_at AS "createdAt", updated_at AS "updatedAt"
  FROM assistant_threads`;

async function fetchThread(c: PoolClient, id: string): Promise<ThreadRow | undefined> {
  const r = await c.query<ThreadRow>(`${THREAD_SELECT} WHERE id = $1`, [id]);
  return r.rows[0];
}

interface MessageRow {
  id: string;
  seq: number;
  role: string;
  content: string | null;
  parts: unknown;
  provider: string | null;
  model: string | null;
  tokens: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  createdAt: string;
}

const MESSAGE_SELECT = `
  SELECT id, seq, role, content, parts, provider, model, tokens, latency_ms AS "latencyMs",
         error_kind AS "errorKind", created_at AS "createdAt"
  FROM assistant_messages`;

// ── ASST-23 (§2.5/§7.4, T3a) — the card-state join: GET thread additionally returns, per message,
// the tool calls it made, each joined to whatever `automation_approvals` row it is waiting on (if
// any). The join itself needs no new Cerbos/module wiring: `assistant_tool_calls` is already read
// under `withTenants([tenantId], …, {modules:["assistant"]})` (the enclosing query), and
// `automation_approvals` is a CORE tenant-gated table with NO module conjunct in its own RLS policy
// (migration 0014 — `tenant_id = ANY(app_current_tenants())` only) — so it is readable in the SAME
// transaction/GUC state without widening anything: the approver's own `/approvals/:id` read is a
// SEPARATE, differently-authorized surface (their own Cerbos grant), this join only ever surfaces the
// row's STATUS/EXECUTION fields back into a thread the caller already owns. `assistant_tool_calls.args`
// is already redacted at rest (broker.ts's `redactToolArgs`) — this join selects it as-is, never the
// approval row's OWN (real) `tool_args`, so no raw argument value reaches this response.
//
// Card states this makes derivable on the FE (not computed here — this endpoint hands back the raw
// facts, per the "select the columns you assert on explicitly" discipline): a row with `approvalId`
// NULL is a plain read (`succeeded`/`failed`/`denied`); one with an approval joined reads
// `approval.status` ('pending'|'approved'|'rejected'|'cancelled') and, once approved,
// `approval.executionStatus` ('pending'|'executing'|'executed'|'failed'|'not_applicable') +
// `approval.executionError` for the failed/not_executable detail.
interface ToolCallRow {
  id: string;
  messageId: string;
  toolName: string;
  mcpServer: string | null;
  args: unknown;
  resultSummary: string | null;
  status: string;
  approvalId: string | null;
  durationMs: number | null;
  createdAt: string;
  approvalStatus: string | null;
  approvalExecutionStatus: string | null;
  approvalExecutionError: string | null;
  // T3b (§7.2.7) — the confirm-chip's own state, LEFT JOINed by `tool_call_id`. NULL for every call
  // that was never a suspended write, exactly like the approval columns above. `intentApprovalId` is
  // the intent row's OWN `approval_id` (set only once the owner confirms) — the confirm-chip path
  // never writes `tc.approval_id` at turn time (nothing was filed yet), so THIS is where a confirmed
  // call's approval id actually comes from; `COALESCE`d against `tc.approval_id` in the query below
  // so the one legacy/defensive filed-at-turn-time shape (`RunnerGoalDetail.approvalId`) still works.
  intentStatus: string | null;
  intentExpiresAt: string | null;
  intentApprovalId: string | null;
}

export interface ThreadToolCall {
  id: string;
  toolName: string;
  mcpServer: string | null;
  args: unknown;
  resultSummary: string | null;
  status: string;
  approvalId: string | null;
  durationMs: number | null;
  createdAt: string;
  /** `null` when this call was never a suspended write (a plain read, or a wall-1/step-0.5 refusal
   *  that never reached the runner). Explicit-column SELECT below — an approval row that genuinely
   *  has no matching id (should never happen; `approvalId` is only ever set from a row that just was
   *  read, broker.ts) would ALSO read as `null` here, which is the same honest "nothing to join"
   *  answer as "there was no approval to begin with" — never conflated with a real decided state. */
  approval: { status: string; executionStatus: string; executionError: string | null } | null;
  /** T3b (§7.2.7) — `null` once `approvalId` is set (filed) or for a call that was never a suspended
   *  write; otherwise `{status, expiresAt}` for a still-`draft`/`dismissed`/`expired` intent. A card
   *  reads `awaiting confirmation` from `intent.status === 'draft'`, `dismissed`/`expired` from the
   *  matching value, and `sent for approval`+ from `approval` once `approvalId` is non-null — never
   *  both at once, by construction (the confirm claim nulls nothing here, it sets `approvalId`, which
   *  is what flips which of the two fields this row reports). */
  intent: ToolCallIntent | null;
}

/** One SELECT for every tool call belonging to the given messages, LEFT JOINed to its approval row
 *  (if `approval_id` is set) AND its write-intent row (if one was ever drafted for it). Grouped by
 *  message id for the caller to zip back onto its own message list. Empty `messageIds`
 *  short-circuits to an empty map — no query for a thread with no messages.
 *
 *  Callers MUST run `reapExpiredIntents(c, threadId)` first (same transaction) so a past-expiry draft
 *  reads as `expired` here, not as a stale `draft` — see `getThread` below. */
async function fetchToolCallsByMessage(c: PoolClient, messageIds: string[]): Promise<Map<string, ThreadToolCall[]>> {
  const out = new Map<string, ThreadToolCall[]>();
  if (messageIds.length === 0) return out;
  const { rows } = await c.query<ToolCallRow>(
    `SELECT tc.id, tc.message_id AS "messageId", tc.tool_name AS "toolName", tc.mcp_server AS "mcpServer",
            tc.args, tc.result_summary AS "resultSummary", tc.status, tc.approval_id AS "approvalId",
            tc.duration_ms AS "durationMs", tc.created_at AS "createdAt",
            wi.status AS "intentStatus", wi.expires_at AS "intentExpiresAt", wi.approval_id AS "intentApprovalId",
            aa.status AS "approvalStatus", aa.execution_status AS "approvalExecutionStatus",
            aa.execution_error AS "approvalExecutionError"
       FROM assistant_tool_calls tc
       LEFT JOIN assistant_write_intents wi ON wi.tool_call_id = tc.id
       LEFT JOIN automation_approvals aa ON aa.id = COALESCE(tc.approval_id, wi.approval_id)
      WHERE tc.message_id = ANY($1::uuid[])
      ORDER BY tc.created_at ASC`,
    [messageIds],
  );
  for (const r of rows) {
    // The EFFECTIVE approval id: `tc.approval_id` (legacy/defensive, filed-at-turn-time) OR the
    // intent row's OWN `approval_id` (the confirm-chip path — filed only once the owner confirms).
    // Never both meaningfully at once (a legacy-filed call never has an intent row at all).
    const approvalId = r.approvalId ?? r.intentApprovalId;
    const call: ThreadToolCall = {
      id: r.id,
      toolName: r.toolName,
      mcpServer: r.mcpServer,
      args: r.args,
      resultSummary: r.resultSummary,
      status: r.status,
      approvalId,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
      approval: approvalId
        ? { status: r.approvalStatus ?? "unknown", executionStatus: r.approvalExecutionStatus ?? "unknown", executionError: r.approvalExecutionError }
        : null,
      // Once filed (approvalId set), the approval join above takes over — intent goes to null rather
      // than reporting 'filed' redundantly, matching §7.2.1's "the approval join takes over" ruling.
      intent: r.intentStatus && !approvalId ? { status: r.intentStatus as ToolCallIntent["status"], expiresAt: r.intentExpiresAt ?? "" } : null,
    };
    const bucket = out.get(r.messageId);
    if (bucket) bucket.push(call);
    else out.set(r.messageId, [call]);
  }
  return out;
}

// ASST-19 — durable user memory (blueprint §4.1, memory #2 of 4). See this file's memory-section
// header (below, right above the endpoints) for the propose/confirm/quarantine model.
interface MemoryRow {
  id: string;
  ownerUserId: string;
  scope: string;
  content: string;
  provenance: string;
  trust: string;
  pinned: boolean;
  confirmedAt: string | null;
  sourceThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

const MEMORY_SELECT = `
  SELECT id, owner_user_id AS "ownerUserId", scope, content, provenance, trust, pinned,
         confirmed_at AS "confirmedAt", source_thread_id AS "sourceThreadId",
         created_at AS "createdAt", updated_at AS "updatedAt"
  FROM assistant_memory`;

async function fetchMemory(c: PoolClient, id: string): Promise<MemoryRow | undefined> {
  const r = await c.query<MemoryRow>(`${MEMORY_SELECT} WHERE id = $1`, [id]);
  return r.rows[0];
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("assistant"))
export class AssistantController {
  // ================================================================== THREADS ==================
  @Get(":tenantId/assistant/threads")
  async listThreads(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("q") q?: string,
    @Query("limit") limitQ?: string,
    @Query("offset") offsetQ?: string,
    @Query("status") status?: string,
  ) {
    const ownerId = req.principal.userId;
    if (!ownerId) throw new BadRequestException("an authenticated user is required");
    if (status !== undefined && !THREAD_STATUSES.has(status)) {
      throw new BadRequestException(`status must be one of ${[...THREAD_STATUSES].join(",")}`);
    }
    // See file header: the list's own ownerId IS the caller's id — this is the self-scoping check,
    // not a widening of the owner-only rule.
    await authorize(req.principal, { kind: "assistant_thread", tenantId, ownerId }, "read");

    const limit = clampInt(limitQ, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = clampInt(offsetQ, 0, 0, Number.MAX_SAFE_INTEGER);
    const search = q?.trim() || null;

    return withTenants(
      [tenantId],
      async (c) => {
        const filterParams = [ownerId, status ?? null, search];
        const { rows } = await c.query<ThreadRow>(
          `${THREAD_SELECT}
             WHERE owner_user_id = $1
               AND ($2::text IS NULL OR status = $2)
               AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%')
             ORDER BY pinned DESC, last_message_at DESC NULLS LAST, created_at DESC
             LIMIT $4 OFFSET $5`,
          [...filterParams, limit, offset],
        );
        const { rows: countRows } = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM assistant_threads
             WHERE owner_user_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%')`,
          filterParams,
        );
        return { items: rows, total: countRows[0]?.n ?? 0 };
      },
      { modules: ["assistant"] },
    );
  }

  @Post(":tenantId/assistant/threads")
  @HttpCode(201)
  async createThread(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { title?: string; brainProvider?: string; brainModel?: string },
  ) {
    const ownerId = req.principal.userId;
    if (!ownerId) throw new BadRequestException("an authenticated user is required");
    await authorize(req.principal, { kind: "assistant_thread", tenantId, ownerId }, "create");

    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 500) || null : null;
    const brainProvider = typeof body?.brainProvider === "string" ? body.brainProvider.trim().slice(0, 100) || null : null;
    const brainModel = typeof body?.brainModel === "string" ? body.brainModel.trim().slice(0, 200) || null : null;
    const id = newId();
    await withTenants(
      [tenantId],
      (c) => c.query(
        `INSERT INTO assistant_threads (id, tenant_id, owner_user_id, title, brain_provider, brain_model, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, tenantId, ownerId, title, brainProvider, brainModel, config.originSite],
      ),
      { modules: ["assistant"] },
    );
    return { id };
  }

  @Get(":tenantId/assistant/threads/:id")
  async getThread(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Query("messageLimit") messageLimitQ?: string,
    @Query("beforeSeq") beforeSeqQ?: string,
  ) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "read");

    const messageLimit = clampInt(messageLimitQ, DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT);
    let beforeSeq: number | null = null;
    if (beforeSeqQ !== undefined) {
      beforeSeq = Number(beforeSeqQ);
      if (!Number.isInteger(beforeSeq) || beforeSeq <= 0) throw new BadRequestException("beforeSeq must be a positive integer");
    }

    const messages = await withTenants(
      [tenantId],
      async (c) => {
        // T3b (§7.2.3's "lazy reap" idiom) — BEFORE the card-state join reads `assistant_write_intents`,
        // flip any past-expiry 'draft' on THIS thread to 'expired' + scrub its `tool_args`, in one
        // UPDATE. Same transaction as the join below, so the read that follows can never observe a
        // stale draft this same request just decided was expired.
        await reapExpiredIntents(c, id);
        const { rows } = await c.query<MessageRow>(
          `${MESSAGE_SELECT} WHERE thread_id = $1 AND ($2::int IS NULL OR seq < $2)
             ORDER BY seq DESC LIMIT $3`,
          [id, beforeSeq, messageLimit],
        );
        const ordered = rows.reverse(); // DESC-then-reverse -> chronological (ascending seq) order
        // ASST-23 (§2.5/§7.4, T3a) — the card-state join, additive. Same transaction/GUC state as the
        // message SELECT above, so the "readable without a module conjunct" reasoning in this file's
        // own header (right above `fetchToolCallsByMessage`) applies without a second withTenants call.
        const byMessage = await fetchToolCallsByMessage(c, ordered.map((m) => m.id));
        return ordered.map((m) => ({ ...m, toolCalls: byMessage.get(m.id) ?? [] }));
      },
      { modules: ["assistant"] },
    );

    return { thread, messages, hasMoreMessages: messages.length === messageLimit };
  }

  @Patch(":tenantId/assistant/threads/:id")
  @HttpCode(200)
  async patchThread(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { title?: string | null; pinned?: boolean; status?: string; brainProvider?: string | null; brainModel?: string | null },
  ) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "update");

    if (body?.status !== undefined && !THREAD_STATUSES.has(body.status)) {
      throw new BadRequestException(`status must be one of ${[...THREAD_STATUSES].join(",")}`);
    }

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
    if (has("title")) {
      params.push(typeof body.title === "string" ? body.title.trim().slice(0, 500) || null : null);
      sets.push(`title = $${params.length}`);
    }
    if (typeof body?.pinned === "boolean") {
      params.push(body.pinned);
      sets.push(`pinned = $${params.length}`);
    }
    if (body?.status !== undefined) {
      params.push(body.status);
      sets.push(`status = $${params.length}`);
    }
    if (has("brainProvider")) {
      const nextBrainProvider = typeof body.brainProvider === "string" ? body.brainProvider.trim().slice(0, 100) || null : null;
      params.push(nextBrainProvider);
      sets.push(`brain_provider = $${params.length}`);
      // ASST-16 — switching brains mid-thread starts a FRESH provider session, without touching
      // ERP thread history: `hermes_session_id` is Hermes' OWN resume token, meaningless (and
      // actively wrong) once the thread is routed at a different provider — the ERP transcript
      // itself is entirely independent of it (assistant_messages is never touched here). Cleared
      // whenever `brainProvider` actually changes (including a change AWAY from hermes to anything
      // else, and a change TO hermes from anything else — either direction must not resume a stale
      // session that belonged to a different routing decision). Left untouched on a PATCH that
      // doesn't mention brainProvider at all (e.g. a plain rename/pin), and left untouched when the
      // new value is IDENTICAL to what's already stored (re-picking the same brain must not throw
      // away an in-progress Hermes conversation).
      if (nextBrainProvider !== thread.brainProvider) {
        sets.push(`hermes_session_id = NULL`);
      }
    }
    if (has("brainModel")) {
      params.push(typeof body.brainModel === "string" ? body.brainModel.trim().slice(0, 200) || null : null);
      sets.push(`brain_model = $${params.length}`);
    }

    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE assistant_threads SET ${sets.join(", ")} WHERE id = $1`, params),
      { modules: ["assistant"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("thread not found");
    return { id };
  }

  @Delete(":tenantId/assistant/threads/:id")
  @HttpCode(200)
  async deleteThread(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "delete");

    // Hard delete — CASCADEs to assistant_messages -> assistant_tool_calls, and SETs NULL (row
    // survives) on assistant_memory.source_thread_id, per migration 0079's composite FKs.
    const res = await withTenants(
      [tenantId],
      (c) => c.query(`DELETE FROM assistant_threads WHERE id = $1`, [id]),
      { modules: ["assistant"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("thread not found");
    return { ok: true };
  }

  // ================================================================== SEND -> STREAM ============
  // POST .../messages: the "POST" half of the POST-then-GET pair (EventSource cannot POST, per
  // blueprint §5). Persists the user's message AND reserves the assistant's reply slot (the
  // pending placeholder, see file header) in one transaction, then hands back the placeholder's
  // own id as `messageId` plus the URL to open the SSE stream on.
  @Post(":tenantId/assistant/threads/:id/messages")
  @HttpCode(201)
  async sendMessage(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { content?: string; mode?: string; agent?: string },
  ) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "message");

    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) throw new BadRequestException("content is required");
    if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
      throw new BadRequestException(`content exceeds max length (${MAX_MESSAGE_CONTENT_LENGTH})`);
    }

    // ASST-17 — is this a TOOL turn? Recorded on the placeholder row at send time; the stream route
    // reads it back from the ROW, never from its own query string (see broker.ts's `readTurnMode`
    // header for why that distinction is load-bearing). `mode` is a per-turn preference the user
    // expresses for their OWN turn — it is not an authority claim, and it cannot widen anything: the
    // tools the turn may use are decided by the hub under the user's own Cerbos principal, twice.
    if (body?.mode !== undefined && body.mode !== "chat" && body.mode !== "tools") {
      throw new BadRequestException("mode must be 'chat' or 'tools'");
    }
    const toolMode = body?.mode === "tools";
    const agent = typeof body?.agent === "string" && body.agent ? body.agent : DEFAULT_TOOL_AGENT;
    if (toolMode && !ASSISTANT_AGENT_TOOLS[agent]) {
      throw new BadRequestException(`agent must be one of ${Object.keys(ASSISTANT_AGENT_TOOLS).join(",")}`);
    }
    const placeholderParts = toolMode ? JSON.stringify([turnModePart(agent)]) : "[]";

    const assistantMessageId = await withTenants(
      [tenantId],
      async (c) => {
        // FIRST statement in the transaction (see file header) — everything below is atomic with
        // respect to any concurrent sendMessage() call on the SAME thread.
        await lockAssistantThread(c, id);

        // Re-verify existence + the precondition INSIDE the lock. The lock only serializes turns;
        // this re-read is what makes the loser of the race actually refuse.
        const stillThere = await fetchThread(c, id);
        if (!stillThere) throw new NotFoundException("thread not found");
        const pending = await c.query(
          `SELECT 1 FROM assistant_messages WHERE thread_id = $1 AND role = 'assistant' AND content IS NULL AND error_kind IS NULL LIMIT 1`,
          [id],
        );
        if (pending.rows.length > 0) {
          throw new ConflictException("a response is already streaming for this thread — stop it or wait for it to finish");
        }

        const seqRes = await c.query<{ next: number }>(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM assistant_messages WHERE thread_id = $1`,
          [id],
        );
        const userSeq = seqRes.rows[0].next;
        const userMessageId = newId();
        await c.query(
          `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
           VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
          [userMessageId, tenantId, id, userSeq, content, config.originSite],
        );
        // 2026-08-07 owner fix, AUTHORITATIVE half (see thread-title.ts's header for the FE-only
        // half this supersedes) — title the thread from its first user message, in the SAME
        // transaction as that message's own INSERT, so no caller (this endpoint is the ONLY place
        // assistant_messages rows are ever inserted, per this file's header) can create a thread
        // that stays "New chat" forever. `userSeq === 1` is the load-bearing proxy for "this INSERT
        // is the very first message this thread has ever had": `userSeq` was computed just above as
        // `COALESCE(MAX(seq),0)+1` BEFORE this INSERT ran, so `=== 1` means no row existed yet.
        // Guarded on `title IS NULL` so a manual rename — via PATCH, including the FE's own
        // fire-and-forget optimistic PATCH that this same request may be racing — always wins and is
        // never overwritten.
        if (userSeq === 1 && stillThere.title === null) {
          const derivedTitle = deriveServerThreadTitle(content);
          if (derivedTitle) {
            await c.query(`UPDATE assistant_threads SET title = $1, updated_at = now() WHERE id = $2`, [derivedTitle, id]);
          }
        }
        // The placeholder — see file header. Reserves seq userSeq+1 for the reply BEFORE the
        // upstream call even starts, so no later sender can ever land a message between the two.
        const assistantId = newId();
        await c.query(
          `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, parts, origin_site)
           VALUES ($1, $2, $3, $4, 'assistant', NULL, $5::jsonb, $6)`,
          [assistantId, tenantId, id, userSeq + 1, placeholderParts, config.originSite],
        );
        return assistantId;
      },
      { modules: ["assistant"] },
    );

    return {
      messageId: assistantMessageId,
      streamUrl:
        `/api/${tenantId}/assistant/threads/${id}/stream?messageId=${assistantMessageId}` +
        // Convenience for the client only — the SERVER reads the mode off the placeholder row.
        (toolMode ? "&mode=tools" : ""),
    };
  }

  // GET .../stream: the "GET" half. Owner-only (Cerbos action "stream", ASST-02). Uses @Res()
  // + reply.raw directly — same pattern as core/portal-stream.controller.ts — because this
  // response deliberately never resolves the way a normal Nest handler's return value would:
  // it holds the socket open, writing SSE frames, until the generation ends or the client leaves.
  // Guards/authorize() run BEFORE `reply.raw` is touched, so a 403/404/400 from any of the checks
  // below still comes back as Nest's normal JSON error response (proven by portal-stream's own
  // "refuses a stream for a non-client" test using plain app.inject — no real socket needed for
  // the negative-auth cases; see assistant-stream.test.ts).
  //
  // SSE-BEHIND-A-PROXY WARNING (not this file's job to fix — devops note for ASST-09/deploy): nginx
  // buffers SSE by default and the portal's own stream needed a hand-applied
  // `proxy_buffering off` / `X-Accel-Buffering: no` vhost block. THIS route needs the identical
  // treatment before it is exposed through the production proxy, or it will work in dev and look
  // silently dead in prod (see docs/FRONTEND-BFF-CONTRACT.md §18).
  @Get(":tenantId/assistant/threads/:id/stream")
  async stream(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Query("messageId") messageId?: string,
  ) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "stream");

    if (!messageId) throw new BadRequestException("messageId is required");
    // Reserve the "one active generation per thread" slot SYNCHRONOUSLY, before the first `await`
    // below — see stream.ts's `reserveGeneration` header for why this must not be a plain
    // check-then-later-register (a real TOCTOU window across the awaited placeholder fetch +
    // context assembly otherwise). The DB precondition on sendMessage's placeholder row is the
    // cross-process backstop; this closes the same-process race.
    const generation = reserveGeneration(id, messageId);
    if (!generation) throw new ConflictException("a stream is already active for this thread");

    let placeholder: { id: string; seq: number; parts: unknown } | undefined;
    let prompt: string;
    // ASST-18 — whatever the RAG retrieval found for THIS generation (possibly empty; see
    // context.ts's `AssembledContext.citations` header for why empty is not distinguished from
    // "the knowledge service degraded" at this layer). Hoisted out of the `try` below so both the
    // SSE emit and the later persistence code (well past that block) can read it.
    let citations: ContextCitation[] = [];
    try {
      placeholder = await withTenants(
        [tenantId],
        (c) =>
          c.query<{ id: string; seq: number; parts: unknown }>(
            `SELECT id, seq, parts FROM assistant_messages
               WHERE id = $1 AND thread_id = $2 AND role = 'assistant' AND content IS NULL AND error_kind IS NULL`,
            [messageId, id],
          ).then((r) => r.rows[0]),
        { modules: ["assistant"] },
      );
      if (!placeholder) {
        throw new NotFoundException("no pending generation for this messageId (already completed, stopped, or unknown)");
      }

      const assembled = await withTenants(
        [tenantId],
        (c) => assembleContext(c, id, thread, placeholder!.seq, { tenantId }),
        { modules: ["assistant"] },
      );
      prompt = assembled.prompt;
      citations = assembled.citations;
      if (assembled.compactionUpdate) {
        await withTenants([tenantId], (c) => persistCompactionUpdate(c, id, assembled.compactionUpdate!), { modules: ["assistant"] });
      }
    } catch (err) {
      // Nothing was ever handed to relayGeneration (whose own `finally` normally releases the
      // reservation) — release it here so a 404/transport failure during context assembly can
      // never leave the thread permanently wedged as "generating" in this process's registry.
      releaseGeneration(id);
      throw err;
    }

    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (line: string): void => {
      if (!raw.destroyed) raw.write(line);
    };
    // Mirrors portal-stream.controller.ts: a client that leaves mid-generation must not leave the
    // upstream gateway call running (and DLP/budget/audit spend accruing) into the void.
    raw.on("close", () => abortForClientDisconnect(id));

    // ASST-18 — citations are known BEFORE any generation starts (context assembly already ran, in
    // the try block above), so they render the instant the stream opens rather than only after
    // `done` — the same "don't make the user wait for a fact we already have" reasoning ASST-12's
    // early `meta` frame used for the brain badge. Fires for BOTH branches below (tool turn and
    // plain chat) since `assembled.citations` is common to both.
    if (citations.length > 0) {
      write(sseLine("citations", { items: citations.map((h) => ({ sourceRef: h.sourceRef, text: h.text })) }));
    }

    // ── ASST-17 — THE TOOL-TURN BRANCH ───────────────────────────────────────────────────────────
    // Routed here, and only here, when the PLACEHOLDER ROW says this is a tool turn (never the query
    // string — see broker.ts's `readTurnMode`). Everything below this block is ASST-06/12/16's plain
    // chat path, untouched.
    //
    // The authority handed to the broker is `req.principal.userId` — the chatting user, the same
    // principal `authorize(... "stream")` just cleared as this thread's owner. There is no other
    // authority input, and `broker.oboEnvelopeFor` refuses anything that is not a real user id.
    const turnMode = readTurnMode(placeholder.parts);
    if (turnMode) {
      const authorityUserId = req.principal.userId;
      if (!authorityUserId) {
        // Unreachable behind the owner check (an owner is a user), but fail LOUD rather than let a
        // tool turn proceed with an unnamed authority.
        releaseGeneration(id);
        write(sseLine("error", { error: "an authenticated user is required for a tool turn", errorKind: "no_authority" }));
        if (!raw.destroyed) raw.end();
        return;
      }
      let turn: ToolTurnResult;
      try {
        turn = await runToolTurn({
          user: { userId: authorityUserId, tenantId },
          prompt,
          agent: turnMode.agent,
          signal: generation.controller.signal,
          emit: {
            toolCall: (c) => write(sseLine("tool_call", c)),
            toolResult: (r) => write(sseLine("tool_result", r)),
            approvalRequired: (a) => write(sseLine("approval_required", a)),
            // T3b (§7.2.7) — the confirm-chip's own frame. Redacted args only (broker.ts's own doc on
            // this emitter); the REAL args are persisted server-side below, keyed by the SAME
            // `intentId` this frame carries, never sent to the browser.
            confirmRequired: (a) => write(sseLine("confirm_required", a)),
          },
        });
      } finally {
        // `relayGeneration`'s own `finally` is what releases the registry slot on the chat path; the
        // broker never touches that registry, so this branch must release it itself or `POST .../stop`
        // stays wedged for this thread until the process restarts.
        releaseGeneration(id);
      }

      // The runner is a QUEUED service with no incremental output (ai-agents design §3.2), so the
      // answer arrives whole. It is emitted as ONE `token` frame rather than chopped into a fake
      // cadence — presenting a non-streamed answer as if it had streamed would be the same class of
      // dishonesty as ASST-12's estimate-labelled-as-a-measurement.
      if (turn.provider) write(sseLine("meta", { provider: turn.provider, model: "" }));
      if (turn.text) write(sseLine("token", { text: turn.text }));
      const toolTokens = estimateTokens(turn.text);
      write(sseLine("usage", { tokens: toolTokens, latencyMs: 0, source: "estimate" }));
      if (turn.outcome === "answered") write(sseLine("done", {}));
      else write(sseLine("error", { error: turn.text, errorKind: turn.errorKind ?? "runner_error" }));

      // Persist the message AND its tool-call ledger in ONE transaction: a visible tool chip whose
      // row never landed (or vice versa) is a transcript that lies about what ran.
      const toolParts = JSON.stringify([
        turnModePart(turnMode.agent),
        ...usageMetaParts({ usageSource: "estimate" }),
        ...citationParts(citations),
      ]);
      await withTenants(
        [tenantId],
        async (c) => {
          await c.query(
            `UPDATE assistant_messages
               SET content = $1, tokens = $2, provider = $3, error_kind = $4, parts = $5::jsonb
               WHERE id = $6`,
            [
              turn.text,
              toolTokens,
              turn.provider ?? null,
              turn.outcome === "answered" ? null : (turn.errorKind ?? "runner_error"),
              toolParts,
              messageId,
            ],
          );
          await persistToolCalls(c, {
            tenantId,
            messageId,
            // THE Phase-3 gate: every row's authority is the chatting user, never a service id.
            authorityUserId,
            calls: turn.toolCalls,
          });
          // T3b (§7.2.1/§7.2.4) — the draft write-intent row, in the SAME transaction as the ledger
          // row it belongs to, and AFTER `persistToolCalls` above so `tool_call_id`'s composite FK
          // (migration 0085) resolves against a row that already exists. `tool_args` here are the
          // REAL (unredacted) args from `turn.intent` — the ONLY durable pre-filing home for them
          // (§7.2.4's custody-chain step 2); the ledger row `persistToolCalls` just wrote carries only
          // the redacted copy. `owner_user_id` is `authorityUserId` — the SAME chatting-user id every
          // other row in this transaction is attributed to, never read off anything client-supplied.
          if (turn.intent) {
            await c.query(
              `INSERT INTO assistant_write_intents
                 (id, tenant_id, thread_id, message_id, tool_call_id, owner_user_id, agent, tool_name,
                  tool_args, impact, status, expires_at, origin_site)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'draft',$11,$12)`,
              [
                turn.intent.id,
                tenantId,
                id,
                messageId,
                turn.intent.toolCallId,
                authorityUserId,
                turn.intent.agent,
                turn.intent.toolName,
                JSON.stringify(turn.intent.args ?? {}),
                turn.intent.impact,
                turn.intent.expiresAt,
                config.originSite,
              ],
            );
          }
          await c.query(
            `UPDATE assistant_threads SET total_tokens = total_tokens + $1, last_message_at = now(), updated_at = now() WHERE id = $2`,
            [toolTokens, id],
          );
        },
        { modules: ["assistant"] },
      );

      if (!raw.destroyed) raw.end();
      return;
    }

    const result = await relayGeneration(generation, {
      tenantId,
      prompt,
      // ASST-16 — route this generation with the thread's chosen brain, and resume its Hermes
      // session if one is already open. `provider` is a HINT only (OQ-6: "fail over and label") —
      // a down/unavailable hermes silently falls through to the gateway's normal failover chain,
      // never a hard error; `result.provider`/`result.model` (persisted below) always name the
      // ACTUAL server, never the requested one, which is what makes the ASST-12 badge truthful.
      provider: thread.brainProvider ?? undefined,
      providerSession: thread.hermesSessionId ?? undefined,
      emit: {
        token: (text) => write(sseLine("token", { text })),
        // ASST-12/15: relayed the instant `meta` arrives (before `done`) so a live-streaming
        // client can show "served by <provider>" without waiting for the reply to finish — the
        // "silent failover is invisible" gap ASST-12 closed. ASST-15: never carries
        // `providerSession` anymore (see `session` below) — this is now the SAME shape for every
        // provider, hermes included.
        meta: (provider, model) => write(sseLine("meta", { provider, model })),
        // `source`/`promptTokens`/`completionTokens` are ASST-12's additions to this frame's shape
        // (see docs/FRONTEND-BFF-CONTRACT.md §18) — `source` is what lets the UI's cost meter
        // label whether `tokens` is a real measurement or the ~4-chars/token estimate.
        usage: (tokens, latencyMs, source, promptTokens, completionTokens) =>
          write(sseLine("usage", {
            tokens, latencyMs, source,
            ...(promptTokens !== undefined ? { promptTokens } : {}),
            ...(completionTokens !== undefined ? { completionTokens } : {}),
          })),
        // ASST-16/15: the terminal `event: session` is NOT relayed onto our own browser-facing
        // wire (the UI never needs the raw Hermes token — it is internal routing plumbing,
        // persisted below and threaded back on the NEXT turn). Capturing it here is enough; no
        // new frame on the BFF's own SSE contract was needed for this ticket's acceptance bar.
        session: () => {},
        done: () => write(sseLine("done", {})),
        error: (message, errorKind) => write(sseLine("error", { error: message, errorKind })),
      },
    });

    // Persist the outcome. No lock needed here: this UPDATE is addressed by the placeholder's own
    // id (never re-derives a seq), so it cannot race the seq-allocation section of sendMessage —
    // it can only race a NEW sendMessage() call, which is exactly what "content IS NULL" being
    // cleared here is what UNBLOCKS.
    //
    // ASST-12: `provider`/`model` are filled from `result.provider`/`result.model` — non-null only
    // when ASST-11's `meta` frame arrived (undefined -> NULL otherwise, the same honest "unknown
    // provider" state ASST-06 left these columns in; see stream.ts's file header). `usageSource` +
    // the real prompt/completion breakdown (when present) go into `parts` via `usageMetaParts` —
    // an existing jsonb column (migration 0079, default `[]`, never written to before this ticket),
    // so no schema change was needed to record which kind of token count `tokens` actually is.
    // ASST-24: appends a `session_resume_mismatch` part in the SAME `parts` array whenever
    // `result.sessionResumed === false` (a real, known mismatch) — `[]` for every other case
    // (true, or absent on an older gateway), so an ordinary turn's persisted shape is byte-
    // identical to before this ticket.
    // Persist the outcome. Extracted to stream.ts so `orchestrator.ask` shares it rather than
    // copying two UPDATEs whose column list, error-kind fallback and COALESCE(hermes_session_id)
    // semantics all have to stay identical. No lock needed: this UPDATE is addressed by the
    // placeholder's own id (never re-derives a seq), so it cannot race sendMessage's seq allocation
    // — only a NEW sendMessage, which clearing `content IS NULL` here is what unblocks.
    await persistGenerationOutcome({ tenantId, threadId: id, messageId, result, citations });

    if (!raw.destroyed) raw.end();
  }

  // POST .../stop: owner-only (Cerbos action "stop"). Two paths, in order:
  //   1. This process is running the generation -> abort it via the in-memory registry (stream.ts);
  //      the stream handler's own persistence code (above) records `error_kind='stopped'`.
  //   2. Nothing found in-process (never opened yet, or already finished elsewhere) -> a direct,
  //      single UPDATE closes any still-pending placeholder so the thread is never left wedged for
  //      a future send. Both paths converge on the same "content IS NULL AND error_kind IS NULL"
  //      predicate that sendMessage's precondition check reads.
  @Post(":tenantId/assistant/threads/:id/stop")
  @HttpCode(200)
  async stop(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "stop");

    if (requestStop(id)) return { ok: true, stopped: true };

    const rowCount = await withTenants(
      [tenantId],
      async (c) => {
        const r = await c.query(
          `UPDATE assistant_messages SET content = COALESCE(content, ''), error_kind = 'stopped'
             WHERE thread_id = $1 AND role = 'assistant' AND content IS NULL AND error_kind IS NULL`,
          [id],
        );
        return r.rowCount ?? 0;
      },
      { modules: ["assistant"] },
    );
    return { ok: true, stopped: rowCount > 0 };
  }

  // ================================================================== CONFIRM WRITE (T3b) ========
  // The owner's confirm chip. NOT a flag on `sendMessage` (this file's own T3b design note): a
  // confirm is not a message, and overloading send would entangle the placeholder/stream lifecycle
  // for no reason. Owner-only via Cerbos `confirm_write` (resource_assistant_thread.yaml, same rule,
  // same condition as every other thread action) — gates BOTH confirm and dismiss.
  //
  // The confirm REQUEST carries NO args (§7.2.4's whole point): a tampered confirm must not be able
  // to file user-authored args wearing model provenance. The server files exactly what
  // `assistant_write_intents.tool_args` holds, claimed atomically inside `confirmWriteIntent`.
  @Post(":tenantId/assistant/threads/:id/tool-calls/:callId/confirm")
  @HttpCode(200)
  async confirmWrite(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Param("callId") callId: string,
  ) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "confirm_write");

    const requestedBy = req.principal.userId;
    if (!requestedBy) throw new BadRequestException("an authenticated user is required");

    const result = await withTenants(
      [tenantId],
      (c) => confirmWriteIntent(c, { tenantId, threadId: id, toolCallId: callId, requestedBy }),
      { modules: ["assistant"] },
    );
    // `write-intents.ts`'s own header explains why the transaction NEVER throws: any DB write a
    // `not_found`/`conflict` outcome carries (the lazy reap-on-expiry, in particular) must survive
    // regardless of the eventual HTTP status — which it now can, because that status is decided HERE,
    // strictly AFTER `withTenants(...)` has already committed.
    if (result.outcome === "not_found") throw new NotFoundException("no write proposal found for this tool call");
    if (result.outcome === "conflict") throw new ConflictException(`cannot confirm: this write proposal is '${result.status}'`);

    // The decider notification (MAIL-06) runs AFTER this transaction commits, and only on the
    // request that ACTUALLY won the claim (`justFiled`) — never on an idempotent double-click/replay,
    // which would otherwise double-notify every decider for the SAME filing. Best-effort, same as
    // `create()`'s own notify step; a failure here must never turn an already-committed filing into
    // an error response.
    if (result.justFiled && result.notifyInput) {
      await notifyApprovalFiled(result.approvalId!, result.notifyInput);
    }
    const { outcome, justFiled, notifyInput, ...publicResult } = result;
    void outcome;
    void justFiled;
    void notifyInput;
    return publicResult;
  }

  @Post(":tenantId/assistant/threads/:id/tool-calls/:callId/dismiss")
  @HttpCode(200)
  async dismissWrite(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Param("callId") callId: string,
  ) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "confirm_write");

    const result = await withTenants(
      [tenantId],
      (c) => dismissWriteIntent(c, { threadId: id, toolCallId: callId }),
      { modules: ["assistant"] },
    );
    if (result.outcome === "not_found") throw new NotFoundException("no write proposal found for this tool call");
    if (result.outcome === "conflict") throw new ConflictException(`cannot dismiss: this write proposal is '${result.status}'`);

    // Dismiss never files, so `justFiled`/`notifyInput` are always absent/false here — stripped
    // anyway so the internal discriminant never leaks onto the wire.
    const { outcome, justFiled, notifyInput, ...publicResult } = result;
    void outcome;
    void justFiled;
    void notifyInput;
    return publicResult;
  }

  // ================================================================== HANDOFF (ASST-21) ==========
  // "Hand off a longer task to a specialist" — one Hermes front door + a visible agent roster
  // (blueprint §8's D-B), not per-department personas. Owner-only, same Cerbos resource + condition
  // as every other thread action (resource_assistant_thread.yaml's additive "handoff" action) — see
  // handoffs.ts's file header for why the run this creates is later safe for the SAME owner to read
  // back (it executes under their own OBO envelope, never a service principal).
  @Post(":tenantId/assistant/threads/:id/handoff")
  @HttpCode(201)
  async handoff(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { agent?: string; goal?: string },
  ) {
    const ownerId = req.principal.userId;
    if (!ownerId) throw new BadRequestException("an authenticated user is required");
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "handoff");

    const agent = typeof body?.agent === "string" ? body.agent.trim() : "";
    const goal = typeof body?.goal === "string" ? body.goal : "";
    if (!agent) throw new BadRequestException("agent is required");

    return withTenants(
      [tenantId],
      (c) => createHandoff(c, { tenantId, threadId: id, ownerId, agent, goal }),
      { modules: ["assistant"] },
    );
  }

  // Owner-only run-watch read: the thread's handoffs, lazily refreshed from the runner (status,
  // outcome, and — once the runner reports one — the runId a caller can then read the full
  // transcript of via `GET :tenantId/agents/runs/:runId`, which now recognizes THIS owner via
  // resource_agent_run.yaml's additive rule).
  @Get(":tenantId/assistant/threads/:id/handoffs")
  async listHandoffs(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "read");

    return withTenants([tenantId], (c) => listHandoffsForThread(c, id), { modules: ["assistant"] });
  }

  // ================================================================== ROSTER (ASST-21) ============
  // The right-rail roster panel's ONE read: the REAL specialist registry (never a hardcoded mirror —
  // see handoffs.ts's `fetchRoster`) plus THIS caller's own episodic run history. Self-scoped by
  // construction (same reasoning as `capabilities()` below: there is no parameter here a caller could
  // vary to widen whose history comes back) — `runIds` is derived from THIS user's own
  // `assistant_handoffs` rows, never a bare tenant-wide history request.
  @Get(":tenantId/assistant/agents")
  async roster(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    const userId = req.principal.userId;
    if (!userId) throw new BadRequestException("an authenticated user is required");

    const [roster, ownRunIds] = await Promise.all([
      fetchRoster(),
      withTenants(
        [tenantId],
        (c) =>
          c.query<{ runId: string }>(
            `SELECT run_id AS "runId" FROM assistant_handoffs WHERE tenant_id = $1 AND owner_user_id = $2 AND run_id IS NOT NULL`,
            [tenantId, userId],
          ).then((r) => r.rows.map((row) => row.runId)),
        { modules: ["assistant"] },
      ),
    ]);
    const episodicHistory = await fetchEpisodicHistory(tenantId, ownRunIds);
    return { agents: roster.agents, supervisor: roster.supervisor, runnerConfigured: roster.runnerConfigured, episodicHistory };
  }

  // ================================================================== MEMORY (ASST-19) ==========
  // Durable user memory (blueprint §4.1, memory #2 of 4). `assistant_memory` is OWNER-ONLY end to
  // end (resource_assistant_memory.yaml, ASST-02) with exactly FOUR Cerbos actions —
  // `list`/`propose`/`confirm`/`delete` — and deliberately NO `update`/`edit`/`pin` action, so
  // every mutating call below authorizes against one of those four names verbatim; an unlisted
  // action name is a SILENT DENY (ASST-02's header), not a 500, so getting the name wrong here
  // reads exactly like a broken owner check.
  //
  // ── PROPOSE vs CONFIRM ARE KEPT DISTINCT (this ticket's central design point) ────────────────────
  //   - `POST .../memory` = PROPOSE: inserts a NEW row with `confirmed_at = NULL`,
  //     `trust = 'untrusted'` (the column defaults from migration 0079). This HTTP path is always
  //     `provenance = 'user'` — a human explicitly asking to remember something (via the panel's
  //     "add memory" affordance, or answering the assistant's own "remember this?" prompt once
  //     ASST-17 wires that surface — deferred, this ticket's dependency line names it explicitly).
  //     A proposal is recorded for audit/the confirm UI and is otherwise COMPLETELY INERT: see
  //     context.ts's `fetchConfirmedMemory` — it is invisible to every assembled prompt until
  //     confirmed.
  //   - `POST .../memory/:id/confirm` = CONFIRM: the ONLY way `confirmed_at` and `trust` ever
  //     change. Idempotent on the confirmation timestamp itself (`COALESCE(confirmed_at, now())`
  //     — re-confirming an already-confirmed row does not reset WHEN it was confirmed) but this is
  //     ALSO the one remaining verb Cerbos gives an owner to mutate an EXISTING row's `content`/
  //     `pinned` — there is no separate "update" action, so editing text or toggling pin on an
  //     already-confirmed memory reuses `confirm` with the field(s) to change and no-op on the
  //     confirmation state (the owner re-affirming/adjusting their own already-trusted memory is
  //     exactly the same authority as confirming it the first time).
  //
  // `scope` ('user'|'company', 0079) is accepted and stored but NOT a visibility switch in v1 —
  // per resource_assistant_memory.yaml's header, EVERY row stays owner-private regardless of
  // `scope`; it only records what the fact is ABOUT (a personal preference vs. something about the
  // company the user chose to have remembered), not who else may read it. A future shared-company-
  // memory feature would need its own Cerbos rule and its own ticket, not a `scope` read here.
  @Get(":tenantId/assistant/memory")
  async listMemory(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("scope") scope?: string,
    @Query("pinned") pinnedQ?: string,
    @Query("confirmed") confirmedQ?: string,
    @Query("limit") limitQ?: string,
    @Query("offset") offsetQ?: string,
  ) {
    const ownerId = req.principal.userId;
    if (!ownerId) throw new BadRequestException("an authenticated user is required");
    if (scope !== undefined && !MEMORY_SCOPES.has(scope)) {
      throw new BadRequestException(`scope must be one of ${[...MEMORY_SCOPES].join(",")}`);
    }
    // Self-scoped by construction (WHERE owner_user_id = the caller) — same non-widening pattern
    // as listThreads's own "list" authorize() call above.
    await authorize(req.principal, { kind: "assistant_memory", tenantId, ownerId }, "list");

    const limit = clampInt(limitQ, DEFAULT_MEMORY_LIST_LIMIT, 1, MAX_MEMORY_LIST_LIMIT);
    const offset = clampInt(offsetQ, 0, 0, Number.MAX_SAFE_INTEGER);
    const pinnedFilter = pinnedQ === undefined ? null : pinnedQ === "true";
    const confirmedFilter = confirmedQ === undefined ? null : confirmedQ === "true";

    return withTenants(
      [tenantId],
      async (c) => {
        const filterParams = [ownerId, scope ?? null, pinnedFilter, confirmedFilter];
        const { rows } = await c.query<MemoryRow>(
          `${MEMORY_SELECT}
             WHERE owner_user_id = $1
               AND ($2::text IS NULL OR scope = $2)
               AND ($3::boolean IS NULL OR pinned = $3)
               AND ($4::boolean IS NULL OR ($4 AND confirmed_at IS NOT NULL) OR (NOT $4 AND confirmed_at IS NULL))
             ORDER BY pinned DESC, confirmed_at DESC NULLS FIRST, created_at DESC
             LIMIT $5 OFFSET $6`,
          [...filterParams, limit, offset],
        );
        const { rows: countRows } = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM assistant_memory
             WHERE owner_user_id = $1
               AND ($2::text IS NULL OR scope = $2)
               AND ($3::boolean IS NULL OR pinned = $3)
               AND ($4::boolean IS NULL OR ($4 AND confirmed_at IS NOT NULL) OR (NOT $4 AND confirmed_at IS NULL))`,
          filterParams,
        );
        return { items: rows, total: countRows[0]?.n ?? 0 };
      },
      { modules: ["assistant"] },
    );
  }

  @Post(":tenantId/assistant/memory")
  @HttpCode(201)
  async proposeMemory(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { content?: string; scope?: string; sourceThreadId?: string },
  ) {
    const ownerId = req.principal.userId;
    if (!ownerId) throw new BadRequestException("an authenticated user is required");
    await authorize(req.principal, { kind: "assistant_memory", tenantId, ownerId }, "propose");

    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) throw new BadRequestException("content is required");
    if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
      throw new BadRequestException(`content exceeds max length (${MAX_MEMORY_CONTENT_LENGTH})`);
    }
    const scope = body?.scope ?? "user";
    if (!MEMORY_SCOPES.has(scope)) throw new BadRequestException(`scope must be one of ${[...MEMORY_SCOPES].join(",")}`);
    const sourceThreadId = typeof body?.sourceThreadId === "string" && body.sourceThreadId ? body.sourceThreadId : null;

    const id = newId();
    await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `INSERT INTO assistant_memory (id, tenant_id, owner_user_id, scope, content, provenance, source_thread_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'user', $6, $7)`,
          [id, tenantId, ownerId, scope, content, sourceThreadId, config.originSite],
        ),
      { modules: ["assistant"] },
    );
    // `trust`/`confirmed_at` are left at their column defaults ('untrusted' / NULL, migration
    // 0079) — this row is a PROPOSAL and is invisible to context.ts's quarantine gate until a
    // separate `confirm` call.
    return { id };
  }

  @Post(":tenantId/assistant/memory/:id/confirm")
  @HttpCode(200)
  async confirmMemory(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { content?: string; pinned?: boolean },
  ) {
    const memory = await withTenants([tenantId], (c) => fetchMemory(c, id), { modules: ["assistant"] });
    if (!memory) throw new NotFoundException("memory not found");
    await authorize(req.principal, { kind: "assistant_memory", id, tenantId, ownerId: memory.ownerUserId }, "confirm");

    const sets: string[] = ["updated_at = now()", "confirmed_at = COALESCE(confirmed_at, now())", "trust = 'trusted'"];
    const params: unknown[] = [id];
    if (typeof body?.content === "string") {
      const trimmed = body.content.trim();
      if (!trimmed) throw new BadRequestException("content cannot be empty");
      if (trimmed.length > MAX_MEMORY_CONTENT_LENGTH) {
        throw new BadRequestException(`content exceeds max length (${MAX_MEMORY_CONTENT_LENGTH})`);
      }
      params.push(trimmed);
      sets.push(`content = $${params.length}`);
    }
    if (typeof body?.pinned === "boolean") {
      params.push(body.pinned);
      sets.push(`pinned = $${params.length}`);
    }

    const res = await withTenants(
      [tenantId],
      (c) => c.query(`UPDATE assistant_memory SET ${sets.join(", ")} WHERE id = $1`, params),
      { modules: ["assistant"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("memory not found");
    return { id };
  }

  @Delete(":tenantId/assistant/memory/:id")
  @HttpCode(200)
  async deleteMemory(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const memory = await withTenants([tenantId], (c) => fetchMemory(c, id), { modules: ["assistant"] });
    if (!memory) throw new NotFoundException("memory not found");
    await authorize(req.principal, { kind: "assistant_memory", id, tenantId, ownerId: memory.ownerUserId }, "delete");

    const res = await withTenants(
      [tenantId],
      (c) => c.query(`DELETE FROM assistant_memory WHERE id = $1`, [id]),
      { modules: ["assistant"] },
    );
    if (res.rowCount === 0) throw new NotFoundException("memory not found");
    return { ok: true };
  }

  // ================================================================== CAPABILITIES (ASST-18) =====
  // blueprint §8's right-rail "capabilities" list AND the empty-state capability cards — BOTH fed
  // from this ONE endpoint (the ticket's own discoverability requirement: the empty state must
  // never be a hand-maintained list that can drift from what this user can actually do).
  //
  // `visibleToolsFor(user) ∩ tenant's module gates` — see capabilities.ts's header. No
  // `authorize()` call here, unlike threads/memory: there is no per-row resource to fetch-then-
  // authorize against — the result is INHERENTLY self-scoped (always and only THIS caller's own
  // OBO envelope, wall 1 of ASST-17's broker) and Cerbos re-authorizes every tool again at the hub
  // (wall 2) before anything actually runs. There is no parameter here a caller could vary to widen
  // whose capabilities come back.
  @Get(":tenantId/assistant/capabilities")
  async capabilities(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    const userId = req.principal.userId;
    if (!userId) throw new BadRequestException("an authenticated user is required");
    return assembleCapabilities({ userId, tenantId }, tenantId);
  }

  // ================================================================== CITATIONS (ASST-18) ========
  // Resolves ONE knowledge-chunk `sourceRef` (as returned in a `citations` SSE frame / a message's
  // persisted `parts`) to a navigable {kind,label,href} — or a 404, on purpose, when this file has
  // no honest destination for it (see citations.ts's header: "a chip that 404s is worse than no
  // chip" means the FRONTEND must never render a link for an unresolvable ref, not that this
  // endpoint should invent one).
  //
  // Gated the SAME way `admin/intelligence.controller.ts`'s `knowledgeSources` proxy is (broad
  // "any tenant member may read" — resource_activity.yaml's company_admin/manager/member/viewer/
  // team_lead grant): resolving a citation is the same sensitivity as seeing that a knowledge
  // source exists at all, not a new authorization surface that needs its own Cerbos resource kind.
  @Get(":tenantId/assistant/citations/:sourceRef")
  async resolveCitationRoute(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("sourceRef") sourceRefParam: string,
  ) {
    const userId = req.principal.userId;
    if (!userId) throw new BadRequestException("an authenticated user is required");
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    const sourceRef = decodeURIComponent(sourceRefParam);
    const resolved = await withTenants([tenantId], (c) => resolveCitation(c, tenantId, sourceRef), { modules: ["assistant"] });
    if (!resolved) throw new NotFoundException("this citation has no resolvable destination");
    return resolved;
  }
}
