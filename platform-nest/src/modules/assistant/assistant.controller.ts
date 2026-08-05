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
import { assembleContext, persistCompactionUpdate } from "./context";
import { abortForClientDisconnect, relayGeneration, releaseGeneration, reserveGeneration, requestStop, sseLine } from "./stream";

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
const ASSISTANT_THREAD_LOCK_NS = 0x41535401; // 'AST' + 1, distinct from every other lock namespace in the app

async function lockAssistantThread(c: PoolClient, threadId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ASSISTANT_THREAD_LOCK_NS, threadId]);
}

const MAX_MESSAGE_CONTENT_LENGTH = 20_000;

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
        const { rows } = await c.query<MessageRow>(
          `${MESSAGE_SELECT} WHERE thread_id = $1 AND ($2::int IS NULL OR seq < $2)
             ORDER BY seq DESC LIMIT $3`,
          [id, beforeSeq, messageLimit],
        );
        return rows.reverse(); // DESC-then-reverse -> chronological (ascending seq) order for display
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
      params.push(typeof body.brainProvider === "string" ? body.brainProvider.trim().slice(0, 100) || null : null);
      sets.push(`brain_provider = $${params.length}`);
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
    @Body() body: { content?: string },
  ) {
    const thread = await withTenants([tenantId], (c) => fetchThread(c, id), { modules: ["assistant"] });
    if (!thread) throw new NotFoundException("thread not found");
    await authorize(req.principal, { kind: "assistant_thread", id, tenantId, ownerId: thread.ownerUserId }, "message");

    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) throw new BadRequestException("content is required");
    if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
      throw new BadRequestException(`content exceeds max length (${MAX_MESSAGE_CONTENT_LENGTH})`);
    }

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
        // The placeholder — see file header. Reserves seq userSeq+1 for the reply BEFORE the
        // upstream call even starts, so no later sender can ever land a message between the two.
        const assistantId = newId();
        await c.query(
          `INSERT INTO assistant_messages (id, tenant_id, thread_id, seq, role, content, origin_site)
           VALUES ($1, $2, $3, $4, 'assistant', NULL, $5)`,
          [assistantId, tenantId, id, userSeq + 1, config.originSite],
        );
        return assistantId;
      },
      { modules: ["assistant"] },
    );

    return {
      messageId: assistantMessageId,
      streamUrl: `/api/${tenantId}/assistant/threads/${id}/stream?messageId=${assistantMessageId}`,
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

    let placeholder: { id: string; seq: number } | undefined;
    let prompt: string;
    try {
      placeholder = await withTenants(
        [tenantId],
        (c) =>
          c.query<{ id: string; seq: number }>(
            `SELECT id, seq FROM assistant_messages
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

    const result = await relayGeneration(generation, {
      tenantId,
      prompt,
      emit: {
        token: (text) => write(sseLine("token", { text })),
        usage: (tokens, latencyMs) => write(sseLine("usage", { tokens, latencyMs })),
        done: () => write(sseLine("done", {})),
        error: (message, errorKind) => write(sseLine("error", { error: message, errorKind })),
      },
    });

    // Persist the outcome. No lock needed here: this UPDATE is addressed by the placeholder's own
    // id (never re-derives a seq), so it cannot race the seq-allocation section of sendMessage —
    // it can only race a NEW sendMessage() call, which is exactly what "content IS NULL" being
    // cleared here is what UNBLOCKS.
    await withTenants(
      [tenantId],
      async (c) => {
        if (result.outcome === "done") {
          // provider/model are left NULL for a streamed reply — see stream.ts's file header for
          // why the gateway's SSE wire cannot tell us which provider actually served it.
          await c.query(
            `UPDATE assistant_messages SET content = $1, tokens = $2, latency_ms = $3 WHERE id = $4`,
            [result.text, result.tokensEstimate, result.latencyMs, messageId],
          );
        } else {
          await c.query(
            `UPDATE assistant_messages SET content = $1, tokens = $2, latency_ms = $3, error_kind = $4 WHERE id = $5`,
            [result.text, result.tokensEstimate, result.latencyMs, result.errorKind ?? "unknown", messageId],
          );
        }
        await c.query(
          `UPDATE assistant_threads SET total_tokens = total_tokens + $1, last_message_at = now(), updated_at = now() WHERE id = $2`,
          [result.tokensEstimate, id],
        );
      },
      { modules: ["assistant"] },
    );

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
}
