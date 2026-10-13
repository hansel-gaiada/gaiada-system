// PV4-03 — the client portal's Conversation surface: threads per project plus one client-wide thread
// per client (PV-D22), replies with inline attachments. Messages are permanent (PV-D34): there is no edit and no retract.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-03; findings 6, 9, 10; decisions 3, 4, 7).
// BFF contract: docs/FRONTEND-BFF-CONTRACT.md §29.
//
// ── THIS IS THE CLIENT-ISOLATION SURFACE ──────────────────────────────────────────────────────────
// A mistake here shows one client's messages to another client. So, on EVERY route:
//   1. authorize `portal` (`read` for GETs, `converse` for writes) BEFORE validating the body;
//   2. resolve the caller's PortalScope (portal-scope.ts) — a revoked / invited contact is refused there;
//   3. admit the thread ONLY through `conversationThreadInPortalScope` (portal-visibility.ts). A message is
//      admitted through its thread, never by its own id alone;
//   4. answer 404, never 403, for anything outside that scope — not-yours and does-not-exist must be
//      indistinguishable, or this controller becomes an existence oracle for other clients' ids.
//
// ── PV-D24: NO `requireSignerFor` ANYWHERE IN THIS FILE ───────────────────────────────────────────
// Every contact who can see a project takes part in its conversation, signers and viewers alike.
// Talking is not signing (the `request_change` precedent). Do not import or call `requireSignerFor` here.
//
// ── DRAFTS NEVER REACH THIS FILE ──────────────────────────────────────────────────────────────────
// Agent drafts live in their own staff-only table (design decision 3). This file and conversation-core.ts
// never name it; `conversation-portal-guard.test.ts` fails if either ever does.
//
// ── SERVER-DERIVED, NEVER BODY-TRUSTED ────────────────────────────────────────────────────────────
// `author_id` (the principal), `author_side` ('client', this route), `client_id` (the admitted project's
// client, or the caller's own single client) and `tenant_id` (the route) never come from the body. A body
// carrying `authorId`, `authorSide`, `clientId` (beyond choosing among the caller's OWN clients), `status`
// or `tenantId` is simply never read for those columns.
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param,
  Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope, scopeValues, type PortalScope } from "./portal-scope";
import { conversationThreadInPortalScope, projectInPortalScope, scopeAt } from "./portal-visibility";
import {
  createProjectThread, findOrCreateGeneralThread,
  insertMessage, isUuid, markRead, prepareAttachments, readMessages, unreadCountSql, validateBody, validateSubject,
} from "./conversation-core";
import { notifyClientPosted } from "./conversation-notify";

interface ThreadRow {
  id: string;
  clientId: string;
  projectId: string | null;
  status: string;
}

/** The columns the portal sees on a thread, camelCased once so the list and the detail cannot drift. */
const THREAD_COLUMNS = `
  t.id, t.client_id AS "clientId", cl.name AS "clientName", t.project_id AS "projectId", p.name AS "projectName",
  (t.project_id IS NULL) AS general, t.subject, t.status, t.created_side AS "createdSide",
  t.last_message_at AS "lastMessageAt", t.created_at AS "createdAt"`;

@Controller("api")
@UseGuards(AuthGuard)
export class PortalConversationController {
  /** The caller's threads, newest activity first, with an unread count (messages from STAFF newer than
   *  the caller's read marker). `?projectId=` narrows to one project. A thread outside the caller's
   *  scope is simply absent. */
  @Get(":tenantId/portal/conversation")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("projectId") projectId?: string,
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    if (projectId !== undefined && projectId !== "" && !isUuid(projectId)) throw new BadRequestException("projectId must be a uuid");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const rows = await c.query(
        `SELECT ${THREAD_COLUMNS},
                ${unreadCountSql("t", "r", "staff")} AS "unreadCount"
           FROM conversation_threads t
           JOIN clients cl ON cl.id = t.client_id
           LEFT JOIN projects p ON p.id = t.project_id
           LEFT JOIN conversation_reads r ON r.thread_id = t.id AND r.user_id = $4
          WHERE ${conversationThreadInPortalScope("t", scopeAt(1))}
            AND ($5::uuid IS NULL OR t.project_id = $5::uuid)
          ORDER BY t.last_message_at DESC, t.id DESC
          LIMIT 200`,
        [...scopeValues(scope), req.principal.userId, projectId || null],
      );
      return {
        threads: rows.rows,
        // Whether this caller may post to (and so lazily create) a client-wide thread: only a client-wide
        // contact may (PV4-Q1). The UI shows the "General" entry from this, not by guessing.
        // Portal scope per client (2026-10-13): it is PER CLIENT. `generalClientIds` names the clients whose
        // General thread the caller may use (those they reach client-wide); `canUseGeneral` is true when there
        // is at least one. A contact limited to some projects of a client never gets that client's General.
        canUseGeneral: scope.wideClientIds.length > 0,
        generalClientIds: scope.wideClientIds,
      };
    });
  }

  /** One thread with its messages (oldest first). Viewing marks the thread read for the caller. */
  @Get(":tenantId/portal/conversation/:threadId")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("threadId") threadId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const thread = await this.ownedThreadFull(c, scope, threadId);
      const messages = await readMessages(c, threadId, req.principal.userId as string, "client", { includeDraftedBy: false });
      await markRead(c, tenantId, threadId, req.principal.userId as string);
      return { thread, messages };
    });
  }

  /** Start a conversation.
   *  - With `projectId` (one of the caller's projects): opens a NEW thread on that project.
   *  - Without: posts to the client's ONE general thread, creating it on first use. Only a client-wide
   *    contact OF THAT CLIENT may (PV4-Q1, per client since 2026-10-13); for anyone else the general thread
   *    does not exist (404). A caller who is a client-wide contact of several clients names which with
   *    `clientId`, validated against `wideClientIds`. */
  @Post(":tenantId/portal/conversation")
  @HttpCode(201)
  async open(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { projectId?: unknown; clientId?: unknown; subject?: unknown; body?: unknown; attachments?: unknown },
  ) {
    const b = body ?? {};
    // AUTHORIZE BEFORE VALIDATE: nothing below the call depends on the body.
    await authorize(req.principal, { kind: "portal", tenantId }, "converse");
    const text = validateBody(b.body);
    const subject = validateSubject(b.subject);
    const files = prepareAttachments(b.attachments);
    if (b.projectId !== undefined && b.projectId !== null && b.projectId !== "" && !isUuid(b.projectId)) {
      throw new NotFoundException("project not found");
    }
    const userId = req.principal.userId as string;

    const out = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      let threadId: string;
      let clientId: string;
      let projectId: string | null = null;
      let created: boolean;
      if (typeof b.projectId === "string" && b.projectId) {
        // The project must be one the caller may see; its client is read from THAT row, never the body.
        const p = await c.query<{ client_id: string }>(
          `SELECT p.client_id FROM projects p WHERE p.id = $1 AND ${projectInPortalScope("p", scopeAt(2))}`,
          [b.projectId, ...scopeValues(scope)],
        );
        if (!p.rows[0]) throw new NotFoundException("project not found");
        clientId = p.rows[0].client_id;
        projectId = b.projectId;
        threadId = await createProjectThread(c, tenantId, clientId, projectId, subject, userId, "client");
        created = true;
      } else {
        clientId = this.pickGeneralClient(scope, b.clientId);
        const g = await findOrCreateGeneralThread(c, tenantId, clientId, userId, "client");
        threadId = g.id;
        created = g.created;
        if (g.status === "closed") throw new ConflictException("this conversation is closed");
      }
      const msg = await insertMessage(c, { tenantId, threadId, authorId: userId, side: "client", body: text, attachments: files });
      if (created) {
        await emitEvent(c, tenantId, "conversation", threadId, "conversation.thread.opened", {
          clientId, projectId, threadId, side: "client", via: "portal",
        });
      }
      await emitEvent(c, tenantId, "conversation", msg.id, "conversation.message.posted", {
        clientId, projectId, threadId, messageId: msg.id, side: "client", via: "portal",
      });
      return { threadId, messageId: msg.id, created, attachmentIds: msg.attachmentIds };
    });
    await writeActivity(tenantId, userId, "posted", "conversation", out.threadId, { messageId: out.messageId, via: "portal" });
    // PV4-06: tell the staff recipients, AFTER the commit; best-effort, never throws.
    await notifyClientPosted(tenantId, userId, out.threadId);
    return out;
  }

  /** Reply on a thread in scope. 404 outside scope; 409 on a closed thread. */
  @Post(":tenantId/portal/conversation/:threadId/messages")
  @HttpCode(201)
  async reply(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("threadId") threadId: string,
    @Body() body: { body?: unknown; attachments?: unknown },
  ) {
    const b = body ?? {};
    await authorize(req.principal, { kind: "portal", tenantId }, "converse");
    const text = validateBody(b.body);
    const files = prepareAttachments(b.attachments);
    const userId = req.principal.userId as string;
    const out = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const thread = await this.ownedThread(c, scope, threadId, true);
      if (thread.status === "closed") throw new ConflictException("this conversation is closed");
      const msg = await insertMessage(c, { tenantId, threadId, authorId: userId, side: "client", body: text, attachments: files });
      await emitEvent(c, tenantId, "conversation", msg.id, "conversation.message.posted", {
        clientId: thread.clientId, projectId: thread.projectId, threadId, messageId: msg.id, side: "client", via: "portal",
      });
      return { id: msg.id, threadId, createdAt: msg.createdAt, attachmentIds: msg.attachmentIds };
    });
    await writeActivity(tenantId, userId, "posted", "conversation", threadId, { messageId: out.id, via: "portal" });
    await notifyClientPosted(tenantId, userId, threadId);
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Ownership — every helper applies the thread predicate; none takes an id on trust
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  /** The client whose GENERAL thread the caller posts to. Per client (2026-10-13): it must be a client the
   *  caller reaches CLIENT-WIDE (`wideClientIds`), because the general thread does not exist for a contact
   *  limited to some of that client's projects (PV4-Q1).
   *   - Named one of the caller's clients that they are NOT client-wide on: 404, exactly as if the thread
   *     did not exist (no oracle, and no way to reach it through a sibling grant on another client).
   *   - Client-wide on none: 404.
   *   - Otherwise: the one they name, or their only client-wide client; several and no valid choice is 400. */
  private pickGeneralClient(scope: PortalScope, bodyClientId: unknown): string {
    const named = typeof bodyClientId === "string" && scope.clientIds.includes(bodyClientId) ? bodyClientId : null;
    if (named !== null) {
      if (!scope.wideClientIds.includes(named)) throw new NotFoundException("conversation not found");
      return named;
    }
    if (scope.wideClientIds.length === 0) throw new NotFoundException("conversation not found");
    if (scope.wideClientIds.length === 1) return scope.wideClientIds[0];
    throw new BadRequestException("select which of your accounts this conversation is for");
  }

  private async ownedThread(c: PoolClient, scope: PortalScope, threadId: string, forUpdate = false): Promise<ThreadRow> {
    if (!isUuid(threadId)) throw new NotFoundException("conversation not found");
    const r = await c.query<ThreadRow>(
      `SELECT t.id, t.client_id AS "clientId", t.project_id AS "projectId", t.status
         FROM conversation_threads t
        WHERE t.id = $1 AND ${conversationThreadInPortalScope("t", scopeAt(2))}
        ${forUpdate ? "FOR UPDATE" : ""}`,
      [threadId, ...scopeValues(scope)],
    );
    if (!r.rows[0]) throw new NotFoundException("conversation not found");
    return r.rows[0];
  }

  private async ownedThreadFull(c: PoolClient, scope: PortalScope, threadId: string): Promise<Record<string, unknown>> {
    if (!isUuid(threadId)) throw new NotFoundException("conversation not found");
    const r = await c.query(
      `SELECT ${THREAD_COLUMNS}
         FROM conversation_threads t
         JOIN clients cl ON cl.id = t.client_id
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1 AND ${conversationThreadInPortalScope("t", scopeAt(2))}`,
      [threadId, ...scopeValues(scope)],
    );
    if (!r.rows[0]) throw new NotFoundException("conversation not found");
    return r.rows[0];
  }
}
