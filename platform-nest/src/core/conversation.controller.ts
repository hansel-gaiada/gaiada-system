// PV4-03 — the STAFF side of client Conversation (Cerbos kind `conversation`: read | post | draft | manage).
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-03; design decisions 2, 3, 4, 6, 9).
// BFF contract: docs/FRONTEND-BFF-CONTRACT.md §29.
//
// ── REACH ─────────────────────────────────────────────────────────────────────────────────────────
// Cerbos `conversation` mirrors resource_client.yaml (decision 2): `read` for everyone who reads clients,
// `post`/`draft`/`manage` for company_admin, manager and member. Row reach is the tenant wall (RLS), the
// same as every other staff kind; staff see every client's threads in the tenant they are authorized for.
//
// ── PV-D23: AGENTS DRAFT, STAFF SEND ──────────────────────────────────────────────────────────────
// `post` and `manage` are DENIED to `bot`/`automation` principals by the policy itself (an EFFECT_DENY
// that beats every ALLOW), so an agent reaching POST .../messages or POST drafts/:id/send is refused by
// Cerbos, not by code here. `draft` stays allowed: that is the agent's job (PV4-07's tool calls
// POST .../drafts). Sending a draft creates the message AS THE SENDER (`author_id` = the human who
// pressed Send) with `drafted_by` recording the agent (decision 4), and stamps the draft `sent` in the
// SAME transaction.
//
// ── "CLIENT SEES THIS" COMES FROM THE BACKEND ─────────────────────────────────────────────────────
// Every thread and message row returned here carries `clientVisible` computed in SQL from the
// portal-visibility.ts builders (true for every live message: every message reaches the client), and
// every draft row carries `clientVisible: false` from `staffConversationDraftClientVisible` (plan trap 9).
//
// ── SERVER-DERIVED, NEVER BODY-TRUSTED ────────────────────────────────────────────────────────────
// `author_id` (principal), `author_side` ('staff', this route), `tenant_id` (route) and, on replies,
// `client_id` (the thread row) never come from the body. Opening a thread names a client by `clientId`;
// that is the subject of the request, checked to exist in the tenant (RLS) and not be the internal client.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode,
  NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import {
  staffConversationDraftClientVisible, staffConversationMessageClientVisible, staffConversationThreadClientVisible,
} from "./portal-visibility";
import {
  WITHIN_EDIT_WINDOW_SQL, applyEdit, applyRetract, assertEditable, createProjectThread, findOrCreateGeneralThread,
  insertMessage, isUuid, markRead, prepareAttachments, readMessages, unreadCountSql, validateBody, validateSubject,
} from "./conversation-core";
import { notifyDraftCreated, notifyStaffPosted } from "./conversation-notify";

const THREAD_STATUSES = new Set(["open", "closed"]);
const MAX_IDEMPOTENCY_KEY = 200;

interface ThreadRow {
  id: string;
  client_id: string;
  project_id: string | null;
  status: string;
}

/** Staff thread columns. `awaitingReply`: the last live message is the client's and the thread is open
 *  (the hub's "waiting for our reply" count reads this). */
const THREAD_COLUMNS = `
  t.id, t.client_id AS "clientId", cl.name AS "clientName", t.project_id AS "projectId", p.name AS "projectName",
  (t.project_id IS NULL) AS general, t.subject, t.status, t.created_by AS "createdBy", t.created_side AS "createdSide",
  t.last_message_at AS "lastMessageAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt",
  (COALESCE(lm.author_side = 'client', false) AND t.status = 'open') AS "awaitingReply",
  (SELECT count(*)::int FROM conversation_drafts dd WHERE dd.thread_id = t.id AND dd.status = 'pending') AS "pendingDrafts",
  ${staffConversationThreadClientVisible("t")} AS "clientVisible"`;

const LAST_MESSAGE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT lmm.author_side FROM conversation_messages lmm
     WHERE lmm.thread_id = t.id AND lmm.retracted_at IS NULL
     ORDER BY lmm.created_at DESC, lmm.id DESC LIMIT 1
  ) lm ON true`;

const DRAFT_COLUMNS = `
  d.id, d.thread_id AS "threadId", d.body, d.drafted_by AS "draftedBy", du.name AS "draftedByName",
  d.status, d.decided_by AS "decidedBy", d.decided_at AS "decidedAt", d.sent_message_id AS "sentMessageId",
  d.created_at AS "createdAt", ${staffConversationDraftClientVisible("d")} AS "clientVisible"`;

function boolQuery(v: unknown): boolean | null {
  if (v === undefined || v === null || v === "") return null;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new BadRequestException("awaitingReply must be true or false");
}

@Controller("api")
@UseGuards(AuthGuard)
export class ConversationController {
  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────

  /** Threads in the tenant, newest activity first. Filters: `clientId`, `projectId`, `awaitingReply`,
   *  `status`. `unreadCount` = client messages newer than the caller's read marker. */
  @Get(":tenantId/conversation")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string,
    @Query("projectId") projectId?: string,
    @Query("awaitingReply") awaitingReply?: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "conversation", tenantId }, "read");
    if (clientId && !isUuid(clientId)) throw new BadRequestException("clientId must be a uuid");
    if (projectId && !isUuid(projectId)) throw new BadRequestException("projectId must be a uuid");
    if (status && !THREAD_STATUSES.has(status)) throw new BadRequestException("status must be open|closed");
    const awaiting = boolQuery(awaitingReply);
    return withTenants([tenantId], async (c) => {
      const rows = await c.query(
        `SELECT ${THREAD_COLUMNS}, ${unreadCountSql("t", "r", "client")} AS "unreadCount"
           FROM conversation_threads t
           JOIN clients cl ON cl.id = t.client_id
           LEFT JOIN projects p ON p.id = t.project_id
           LEFT JOIN conversation_reads r ON r.thread_id = t.id AND r.user_id = $1
           ${LAST_MESSAGE_JOIN}
          WHERE t.deleted_at IS NULL
            AND ($2::uuid IS NULL OR t.client_id = $2::uuid)
            AND ($3::uuid IS NULL OR t.project_id = $3::uuid)
            AND ($4::text IS NULL OR t.status = $4::text)
            AND ($5::boolean IS NULL OR (COALESCE(lm.author_side = 'client', false) AND t.status = 'open') = $5::boolean)
          ORDER BY t.last_message_at DESC, t.id DESC
          LIMIT 200`,
        [req.principal.userId, clientId || null, projectId || null, status || null, awaiting],
      );
      return { threads: rows.rows };
    });
  }

  /** One thread with its messages; marks it read for the caller. Pending drafts are a separate read. */
  @Get(":tenantId/conversation/:threadId")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("threadId") threadId: string) {
    await authorize(req.principal, { kind: "conversation", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const thread = await this.threadFull(c, threadId);
      const messages = await readMessages(c, threadId, req.principal.userId as string, "staff", { includeDraftedBy: true });
      // The flag is the SAME builder the portal's predicate is made of, evaluated per row, so "Client sees
      // this" cannot be asserted by the UI on its own.
      const flags = await c.query<{ id: string; client_visible: boolean }>(
        `SELECT m.id, ${staffConversationMessageClientVisible("m", "t")} AS client_visible
           FROM conversation_messages m JOIN conversation_threads t ON t.id = m.thread_id
          WHERE m.thread_id = $1`,
        [threadId],
      );
      const vis = new Map(flags.rows.map((f) => [f.id, f.client_visible]));
      await markRead(c, tenantId, threadId, req.principal.userId as string);
      return { thread, messages: messages.map((m) => ({ ...m, clientVisible: vis.get(m.id) === true })) };
    });
  }

  /** Pending drafts on a thread (staff only, never client-visible). `?status=all` includes decided ones. */
  @Get(":tenantId/conversation/:threadId/drafts")
  async drafts(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string,
    @Query("status") status?: string,
  ) {
    await authorize(req.principal, { kind: "conversation", tenantId }, "read");
    if (status && status !== "pending" && status !== "all") throw new BadRequestException("status must be pending|all");
    return withTenants([tenantId], async (c) => {
      await this.thread(c, threadId);
      const rows = await c.query(
        `SELECT ${DRAFT_COLUMNS}
           FROM conversation_drafts d LEFT JOIN users du ON du.id = d.drafted_by
          WHERE d.thread_id = $1 AND ($2::boolean OR d.status = 'pending')
          ORDER BY d.created_at ASC
          LIMIT 200`,
        [threadId, status === "all"],
      );
      return { drafts: rows.rows };
    });
  }

  // ── Writes: threads and messages ──────────────────────────────────────────────────────────────

  /** Open a conversation with a client. With `projectId`: a new thread on that project of that client.
   *  Without: the client's ONE general thread, created on first use. */
  @Post(":tenantId/conversation")
  @HttpCode(201)
  async open(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { clientId?: unknown; projectId?: unknown; subject?: unknown; body?: unknown; attachments?: unknown },
  ) {
    const b = body ?? {};
    await authorize(req.principal, { kind: "conversation", tenantId }, "post");
    if (!isUuid(b.clientId)) throw new BadRequestException("clientId is required");
    const projectId = b.projectId === undefined || b.projectId === null || b.projectId === "" ? null : b.projectId;
    if (projectId !== null && !isUuid(projectId)) throw new BadRequestException("projectId must be a uuid");
    const text = validateBody(b.body);
    const subject = validateSubject(b.subject);
    const files = prepareAttachments(b.attachments);
    const clientId = b.clientId;
    const userId = req.principal.userId as string;

    const out = await withTenants([tenantId], async (c) => {
      const cl = await c.query<{ is_internal: boolean }>(
        `SELECT is_internal FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId],
      );
      if (!cl.rows[0]) throw new NotFoundException("client not found");
      // The internal sentinel client has no portal contacts (portal-scope.ts excludes it), so a thread
      // with it would be a "client" conversation no client could ever read.
      if (cl.rows[0].is_internal) throw new BadRequestException("the internal client has no conversation");
      let threadId: string;
      let created: boolean;
      if (projectId) {
        const p = await c.query<{ client_id: string | null }>(
          `SELECT client_id FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId],
        );
        if (!p.rows[0]) throw new NotFoundException("project not found");
        if (p.rows[0].client_id !== clientId) throw new BadRequestException("that project does not belong to this client");
        threadId = await createProjectThread(c, tenantId, clientId, projectId, subject, userId, "staff");
        created = true;
      } else {
        const g = await findOrCreateGeneralThread(c, tenantId, clientId, userId, "staff");
        threadId = g.id;
        created = g.created;
        if (g.status === "closed") throw new ConflictException("this conversation is closed — reopen it first");
      }
      const msg = await insertMessage(c, { tenantId, threadId, authorId: userId, side: "staff", body: text, attachments: files });
      if (created) {
        await emitEvent(c, tenantId, "conversation", threadId, "conversation.thread.opened", {
          clientId, projectId, threadId, side: "staff", via: "staff",
        });
      }
      await emitEvent(c, tenantId, "conversation", msg.id, "conversation.message.posted", {
        clientId, projectId, threadId, messageId: msg.id, side: "staff", via: "staff",
      });
      return { threadId, messageId: msg.id, created, attachmentIds: msg.attachmentIds };
    });
    await writeActivity(tenantId, userId, "posted", "conversation", out.threadId, { messageId: out.messageId, via: "staff" });
    // PV4-06: tell the in-scope contacts, AFTER the commit; best-effort, never throws.
    await notifyStaffPosted(tenantId, userId, out.threadId);
    return out;
  }

  /** Reply on a thread as the calling staff member. */
  @Post(":tenantId/conversation/:threadId/messages")
  @HttpCode(201)
  async reply(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string,
    @Body() body: { body?: unknown; attachments?: unknown },
  ) {
    const b = body ?? {};
    await authorize(req.principal, { kind: "conversation", tenantId }, "post");
    const text = validateBody(b.body);
    const files = prepareAttachments(b.attachments);
    const userId = req.principal.userId as string;
    const out = await withTenants([tenantId], async (c) => {
      const t = await this.thread(c, threadId, true);
      if (t.status === "closed") throw new ConflictException("this conversation is closed — reopen it first");
      const msg = await insertMessage(c, { tenantId, threadId, authorId: userId, side: "staff", body: text, attachments: files });
      await emitEvent(c, tenantId, "conversation", msg.id, "conversation.message.posted", {
        clientId: t.client_id, projectId: t.project_id, threadId, messageId: msg.id, side: "staff", via: "staff",
      });
      return { id: msg.id, threadId, createdAt: msg.createdAt, attachmentIds: msg.attachmentIds, clientVisible: true };
    });
    await writeActivity(tenantId, userId, "posted", "conversation", threadId, { messageId: out.id, via: "staff" });
    await notifyStaffPosted(tenantId, userId, threadId);
    return out;
  }

  /** Close / reopen a thread, or change its subject (`manage`). */
  @Patch(":tenantId/conversation/:threadId")
  async update(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string,
    @Body() body: { status?: unknown; subject?: unknown },
  ) {
    const b = body ?? {};
    await authorize(req.principal, { kind: "conversation", tenantId }, "manage");
    if (b.status !== undefined && (typeof b.status !== "string" || !THREAD_STATUSES.has(b.status))) {
      throw new BadRequestException("status must be open|closed");
    }
    if (b.status === undefined && b.subject === undefined) throw new BadRequestException("nothing to change");
    const subject = b.subject === undefined ? undefined : validateSubject(b.subject);
    return withTenants([tenantId], async (c) => {
      const t = await this.thread(c, threadId, true);
      const r = await c.query<{ status: string; subject: string | null; updated_at: string }>(
        `UPDATE conversation_threads
            SET status = COALESCE($2, status),
                subject = CASE WHEN $3::boolean THEN $4 ELSE subject END,
                updated_at = now()
          WHERE id = $1
          RETURNING status, subject, updated_at`,
        [threadId, (b.status as string | undefined) ?? null, subject !== undefined, subject ?? null],
      );
      await emitEvent(c, tenantId, "conversation", threadId, "conversation.thread.updated", {
        clientId: t.client_id, projectId: t.project_id, threadId, status: r.rows[0].status, via: "staff",
      });
      return { id: threadId, status: r.rows[0].status, subject: r.rows[0].subject, updatedAt: r.rows[0].updated_at };
    });
  }

  /** Edit one's own message within 15 minutes (`post`: editing one's words is posting them). Someone
   *  else's message: 403 (staff may know it exists). Past the window or retracted: 409. */
  @Patch(":tenantId/conversation/messages/:messageId")
  async editMessage(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("messageId") messageId: string,
    @Body() body: { body?: unknown },
  ) {
    const b = body ?? {};
    await authorize(req.principal, { kind: "conversation", tenantId }, "post");
    const text = validateBody(b.body);
    return withTenants([tenantId], async (c) => {
      const m = await this.ownMessageForUpdate(c, messageId, req.principal.userId as string);
      assertEditable(m);
      const r = await applyEdit(c, messageId, text);
      await emitEvent(c, tenantId, "conversation", messageId, "conversation.message.edited", {
        clientId: m.client_id, projectId: m.project_id, threadId: m.thread_id, messageId, change: "edited", via: "staff",
      });
      return { id: messageId, edited: true, editedAt: r.editedAt };
    });
  }

  /** Retract one's own message within 15 minutes (`manage`, per the policy header). */
  @Delete(":tenantId/conversation/messages/:messageId")
  async retractMessage(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("messageId") messageId: string) {
    await authorize(req.principal, { kind: "conversation", tenantId }, "manage");
    return withTenants([tenantId], async (c) => {
      const m = await this.ownMessageForUpdate(c, messageId, req.principal.userId as string);
      assertEditable(m);
      const r = await applyRetract(c, messageId);
      await emitEvent(c, tenantId, "conversation", messageId, "conversation.message.edited", {
        clientId: m.client_id, projectId: m.project_id, threadId: m.thread_id, messageId, change: "retracted", via: "staff",
      });
      return { id: messageId, retracted: true, retractedAt: r.retractedAt };
    });
  }

  // ── Drafts (staff-only table; PV-D23) ────────────────────────────────────────────────────────────

  /** Create a draft reply (`draft`; allowed to agents). Idempotent on `idempotencyKey` within the tenant:
   *  a replay returns the same draft; the same key on a different thread is a 409. */
  @Post(":tenantId/conversation/:threadId/drafts")
  @HttpCode(201)
  async createDraft(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string,
    @Body() body: { body?: unknown; idempotencyKey?: unknown },
  ) {
    const b = body ?? {};
    await authorize(req.principal, { kind: "conversation", tenantId }, "draft");
    const text = validateBody(b.body);
    let key: string;
    if (b.idempotencyKey === undefined || b.idempotencyKey === null || b.idempotencyKey === "") key = newId();
    else if (typeof b.idempotencyKey === "string" && b.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY) key = b.idempotencyKey;
    else throw new BadRequestException(`idempotencyKey must be a string of at most ${MAX_IDEMPOTENCY_KEY} characters`);
    const userId = req.principal.userId as string;
    const out = await withTenants([tenantId], async (c) => {
      const t = await this.thread(c, threadId);
      if (t.status === "closed") throw new ConflictException("this conversation is closed — reopen it first");
      const id = newId();
      const ins = await c.query<{ id: string }>(
        `INSERT INTO conversation_drafts (id, tenant_id, thread_id, body, drafted_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [id, tenantId, threadId, text, userId, key],
      );
      if (!ins.rows[0]) {
        const prior = await c.query<{ id: string; thread_id: string; status: string }>(
          `SELECT id, thread_id, status FROM conversation_drafts WHERE tenant_id = $1 AND idempotency_key = $2`,
          [tenantId, key],
        );
        const p = prior.rows[0];
        if (!p || p.thread_id !== threadId) throw new ConflictException("idempotencyKey was already used for another conversation");
        return { id: p.id, threadId, status: p.status, replayed: true, clientVisible: false };
      }
      await emitEvent(c, tenantId, "conversation_draft", id, "conversation.draft.created", {
        clientId: t.client_id, projectId: t.project_id, threadId, draftId: id, draftedBy: userId,
      });
      return { id, threadId, status: "pending", replayed: false, clientVisible: false };
    });
    // PV4-06: a NEW draft tells the staff recipients one is waiting (a replay of the same key does not repeat it).
    if (!out.replayed) await notifyDraftCreated(tenantId, userId, threadId);
    return out;
  }

  /** Edit a pending draft's text (`draft`). A sent or discarded draft: 409. */
  @Patch(":tenantId/conversation/drafts/:draftId")
  async editDraft(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("draftId") draftId: string,
    @Body() body: { body?: unknown },
  ) {
    const b = body ?? {};
    await authorize(req.principal, { kind: "conversation", tenantId }, "draft");
    const text = validateBody(b.body);
    return withTenants([tenantId], async (c) => {
      const d = await this.draftForUpdate(c, draftId);
      if (d.status !== "pending") throw new ConflictException(`this draft was already ${d.status}`);
      await c.query(`UPDATE conversation_drafts SET body = $2 WHERE id = $1`, [draftId, text]);
      return { id: draftId, status: "pending", clientVisible: false };
    });
  }

  /** Send a draft (`post` — refused to bots/automation by Cerbos, PV-D23). ONE transaction: lock the
   *  draft, create the message authored by the SENDER with `drafted_by` = the draft's author, stamp the
   *  draft `sent` + `sent_message_id` + `decided_by/at`. Already sent or discarded: 409. */
  @Post(":tenantId/conversation/drafts/:draftId/send")
  @HttpCode(201)
  async sendDraft(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("draftId") draftId: string) {
    await authorize(req.principal, { kind: "conversation", tenantId }, "post");
    const userId = req.principal.userId as string;
    const out = await withTenants([tenantId], async (c) => {
      const d = await this.draftForUpdate(c, draftId);
      if (d.status !== "pending") throw new ConflictException(`this draft was already ${d.status}`);
      const t = await this.thread(c, d.thread_id, true);
      if (t.status === "closed") throw new ConflictException("this conversation is closed — reopen it first");
      const msg = await insertMessage(c, {
        tenantId, threadId: d.thread_id, authorId: userId, side: "staff", body: d.body, attachments: [], draftedBy: d.drafted_by,
      });
      await c.query(
        `UPDATE conversation_drafts
            SET status = 'sent', sent_message_id = $2, decided_by = $3, decided_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [draftId, msg.id, userId],
      );
      await emitEvent(c, tenantId, "conversation", msg.id, "conversation.message.posted", {
        clientId: t.client_id, projectId: t.project_id, threadId: d.thread_id, messageId: msg.id, side: "staff",
        draftId, via: "staff",
      });
      return { id: msg.id, threadId: d.thread_id, draftId, draftedBy: d.drafted_by, createdAt: msg.createdAt, clientVisible: true };
    });
    await writeActivity(tenantId, userId, "sent_draft", "conversation", out.threadId, { messageId: out.id, draftId, via: "staff" });
    await notifyStaffPosted(tenantId, userId, out.threadId);
    return out;
  }

  /** Discard a pending draft (`draft`). */
  @Post(":tenantId/conversation/drafts/:draftId/discard")
  @HttpCode(200)
  async discardDraft(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("draftId") draftId: string) {
    await authorize(req.principal, { kind: "conversation", tenantId }, "draft");
    const userId = req.principal.userId as string;
    return withTenants([tenantId], async (c) => {
      const d = await this.draftForUpdate(c, draftId);
      if (d.status !== "pending") throw new ConflictException(`this draft was already ${d.status}`);
      await c.query(
        `UPDATE conversation_drafts SET status = 'discarded', decided_by = $2, decided_at = now() WHERE id = $1`,
        [draftId, userId],
      );
      return { id: draftId, status: "discarded", clientVisible: false };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────────────────────

  private async thread(c: PoolClient, threadId: string, forUpdate = false): Promise<ThreadRow> {
    if (!isUuid(threadId)) throw new NotFoundException("conversation not found");
    const r = await c.query<ThreadRow>(
      `SELECT id, client_id, project_id, status FROM conversation_threads
        WHERE id = $1 AND deleted_at IS NULL ${forUpdate ? "FOR UPDATE" : ""}`,
      [threadId],
    );
    if (!r.rows[0]) throw new NotFoundException("conversation not found");
    return r.rows[0];
  }

  private async threadFull(c: PoolClient, threadId: string): Promise<Record<string, unknown>> {
    if (!isUuid(threadId)) throw new NotFoundException("conversation not found");
    const r = await c.query(
      `SELECT ${THREAD_COLUMNS}
         FROM conversation_threads t
         JOIN clients cl ON cl.id = t.client_id
         LEFT JOIN projects p ON p.id = t.project_id
         ${LAST_MESSAGE_JOIN}
        WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [threadId],
    );
    if (!r.rows[0]) throw new NotFoundException("conversation not found");
    return r.rows[0];
  }

  private async ownMessageForUpdate(c: PoolClient, messageId: string, userId: string) {
    if (!isUuid(messageId)) throw new NotFoundException("message not found");
    const r = await c.query<{
      id: string; thread_id: string; client_id: string; project_id: string | null; author_id: string;
      author_side: string; retracted_at: string | null; within_window: boolean;
    }>(
      `SELECT m.id, m.thread_id, t.client_id, t.project_id, m.author_id, m.author_side, m.retracted_at,
              ${WITHIN_EDIT_WINDOW_SQL} AS within_window
         FROM conversation_messages m
         JOIN conversation_threads t ON t.id = m.thread_id
        WHERE m.id = $1 AND t.deleted_at IS NULL
        FOR UPDATE OF m`,
      [messageId],
    );
    const m = r.rows[0];
    if (!m) throw new NotFoundException("message not found");
    if (m.author_id !== userId || m.author_side !== "staff") throw new ForbiddenException("you can only change your own messages");
    return m;
  }

  private async draftForUpdate(c: PoolClient, draftId: string) {
    if (!isUuid(draftId)) throw new NotFoundException("draft not found");
    const r = await c.query<{ id: string; thread_id: string; body: string; drafted_by: string; status: string }>(
      `SELECT d.id, d.thread_id, d.body, d.drafted_by, d.status
         FROM conversation_drafts d JOIN conversation_threads t ON t.id = d.thread_id
        WHERE d.id = $1 AND t.deleted_at IS NULL
        FOR UPDATE OF d`,
      [draftId],
    );
    if (!r.rows[0]) throw new NotFoundException("draft not found");
    return r.rows[0];
  }
}
