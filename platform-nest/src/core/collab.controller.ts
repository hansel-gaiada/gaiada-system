// Collaboration routes (Nest port of core/collab.ts): threaded comments + per-user
// notifications. Notifications raised on mention + comment-on-assigned-task via notify().
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
// NOTE: Nest defaults POST → 201; non-create POSTs carry @HttpCode(200) to match the
// Fastify server's 200 responses exactly (contract parity).
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity, notify } from "./http";
import { AuthGuard } from "../auth/guards";

// P3-08: closed reaction emoji set — matches the P3-09 frontend's fixed reaction bar and the
// migration 0043 CHECK constraint (kept in sync deliberately; the DB constraint is the fail-closed
// backstop if this list and the constraint ever drift).
const REACTION_EMOJIS = new Set(["👍", "❤️", "🎉", "👀", "✅", "💡", "🙏", "🔥"]);

@Controller("api")
@UseGuards(AuthGuard)
export class CollabController {
  @Get(":tenantId/comments")
  async listComments(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("entityType") entityType?: string, @Query("entityId") entityId?: string) {
    if (!entityType || !entityId) throw new BadRequestException("entityType and entityId required");
    await authorize(req.principal, { kind: "comment", tenantId }, "read");
    // P3-08: `reactions` is an ADDITIVE field (aggregated per comment, viewer-scoped `mine`) —
    // every other field/shape here is unchanged, so existing consumers (project "Discussion",
    // lib/entities.postComment) are unaffected by fields they don't read.
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT co.id, co.author_id, u.name AS author_name, co.body, co.parent_comment_id, co.created_at,
                COALESCE(react.reactions, '[]'::json) AS reactions
         FROM comments co
         LEFT JOIN users u ON u.id = co.author_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('emoji', cr.emoji, 'count', cr.cnt, 'mine', cr.mine) ORDER BY cr.emoji) AS reactions
           FROM (
             SELECT emoji, COUNT(*)::int AS cnt, bool_or(user_id = $3) AS mine
             FROM comment_reactions WHERE comment_id = co.id
             GROUP BY emoji
           ) cr
         ) react ON true
         WHERE co.target_entity_type = $1 AND co.target_entity_id = $2 AND co.deleted_at IS NULL
         ORDER BY co.created_at`,
        [entityType, entityId, req.principal.userId],
      ),
    );
    return rows.rows;
  }

  // ---------------- Reactions (P3-08) ----------------
  @Post(":tenantId/comments/:commentId/reactions")
  @HttpCode(201)
  async addReaction(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("commentId") commentId: string,
    @Body() body: { emoji?: string },
  ) {
    const emoji = body?.emoji;
    if (!emoji || !REACTION_EMOJIS.has(emoji)) throw new BadRequestException("invalid emoji");
    // Same gate as posting a comment — reacting is a comment-thread write, not a separate resource.
    await authorize(req.principal, { kind: "comment", tenantId }, "create");
    const actorId = req.principal.userId;
    await withTenants([tenantId], async (c) => {
      const exists = await c.query(`SELECT 1 FROM comments WHERE id = $1 AND deleted_at IS NULL`, [commentId]);
      if (!exists.rows[0]) throw new NotFoundException("comment not found");
      // Idempotent: re-adding the same (comment, user, emoji) is a no-op, never a 409/500 —
      // the PK IS the idempotency key.
      await c.query(
        `INSERT INTO comment_reactions (tenant_id, comment_id, user_id, emoji, origin_site)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, comment_id, user_id, emoji) DO NOTHING`,
        [tenantId, commentId, actorId, emoji, config.originSite],
      );
    });
    return { ok: true };
  }

  @Delete(":tenantId/comments/:commentId/reactions/:emoji")
  @HttpCode(200)
  async removeReaction(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("commentId") commentId: string,
    @Param("emoji") emoji: string,
  ) {
    await authorize(req.principal, { kind: "comment", tenantId }, "create");
    // SELF-ROW delete only: user_id is always the calling principal, never client-supplied —
    // there is no way to reach another user's reaction row through this endpoint.
    await withTenants([tenantId], (c) =>
      c.query(
        `DELETE FROM comment_reactions WHERE tenant_id = $1 AND comment_id = $2 AND user_id = $3 AND emoji = $4`,
        [tenantId, commentId, req.principal.userId, emoji],
      ),
    );
    return { ok: true };
  }

  @Post(":tenantId/comments")
  @HttpCode(201)
  async createComment(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { entityType?: string; entityId?: string; body?: string; parentCommentId?: string; mentions?: string[] }) {
    const { entityType, entityId, body: text, parentCommentId, mentions = [] } = body ?? {};
    if (!entityType || !entityId || !text) throw new BadRequestException("entityType, entityId and body required");
    await authorize(req.principal, { kind: "comment", tenantId }, "create");
    const id = newId();
    const actorId = req.principal.userId;
    try {
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, parent_comment_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, tenantId, actorId, entityType, entityId, text, parentCommentId ?? null, config.originSite],
        ),
      );
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    await writeActivity(tenantId, actorId, "commented", entityType, entityId, { commentId: id });
    // Deep-link target for the notification bell (payload.href) — tasks resolve to their page.
    const href = entityType === "task" ? `/tasks/${entityId}` : undefined;
    // P3-08 fan-out dedup: mentions ∪ assignee ∪ followers collapse into ONE "already notified"
    // set so nobody gets two notifications for this one comment (e.g. a follower who is also
    // @mentioned, or is the task's assignee). Mentions are processed first — an explicit @mention
    // is the most specific fact, so it wins the single notify() call for that recipient.
    // notify() itself auto-skips the actor (recipientId === actorId, verified in core/http.ts).
    const alreadyNotified = new Set<string>();
    for (const m of Array.from(new Set(mentions)).slice(0, 50)) {
      alreadyNotified.add(m);
      await notify(tenantId, m, actorId, "mention", {
        title: "You were mentioned in a comment", severity: "info", entityType, entityId, commentId: id, href,
      });
    }
    if (entityType === "task") {
      const [assigneeRow, followerRows] = await Promise.all([
        withTenants([tenantId], (c) =>
          c.query<{ assignee_id: string | null }>(`SELECT assignee_id FROM tasks WHERE id = $1`, [entityId]),
        ),
        // pm_task_followers.task_id references pm_tasks — a harmless zero-row lookup for
        // entityId values backed by the base `tasks` table instead.
        withTenants([tenantId], (c) =>
          c.query<{ user_id: string }>(`SELECT user_id FROM pm_task_followers WHERE task_id = $1`, [entityId]),
        ),
      ]);
      const commentRecipients = new Set<string>();
      const a = assigneeRow.rows[0]?.assignee_id;
      if (a) commentRecipients.add(a);
      for (const f of followerRows.rows) commentRecipients.add(f.user_id);
      for (const recipient of commentRecipients) {
        if (alreadyNotified.has(recipient)) continue;
        alreadyNotified.add(recipient);
        await notify(tenantId, recipient, actorId, "comment", {
          title: "New comment on your task", severity: "info", entityType, entityId, commentId: id, href,
        });
      }
    }
    return { id };
  }

  // Raise an in-app notification for another member (5c.3 + WS4 §3): used by elevated actors
  // and scoped automation service accounts (e.g. wf:new-client-seed) to push a notice into a
  // user's inbox. `notify()` is best-effort and skips self / non-members. Cerbos gates "create"
  // to company_admin/manager (+ platform_admin); a low-assurance chat session cannot reach it.
  // Callers SHOULD pass the typed payload {title, href, body?, entityType?, entityId?, severity?}
  // (WSUX-4 / FRONTEND-BFF-CONTRACT §9(c)) — notify() supplies a humanized fallback `title`
  // derived from `type` for callers that don't, so no notification ever ships title-less.
  @Post(":tenantId/notifications")
  @HttpCode(201)
  async createNotification(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { recipientId?: string; type?: string; payload?: Record<string, unknown> },
  ) {
    const { recipientId, type, payload = {} } = body ?? {};
    if (!recipientId || !type) throw new BadRequestException("recipientId and type required");
    await authorize(req.principal, { kind: "notification", tenantId }, "create");
    await notify(tenantId, recipientId, req.principal.userId, type, payload);
    return { ok: true };
  }

  @Get(":tenantId/notifications")
  async listNotifications(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("unread") unread?: string) {
    await authorize(req.principal, { kind: "notification", tenantId }, "read");
    const unreadOnly = unread === "true";
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, type, payload, read_at, created_at FROM notifications
         WHERE user_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 100`,
        [req.principal.userId],
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/notifications/:notificationId/read")
  @HttpCode(200)
  async markRead(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("notificationId") notificationId: string) {
    await authorize(req.principal, { kind: "notification", tenantId }, "update");
    const res = await withTenants([tenantId], (c) =>
      c.query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`, [notificationId, req.principal.userId]),
    );
    if (res.rowCount === 0) throw new NotFoundException("notification not found or already read");
    return { id: notificationId, read: true };
  }

  @Post(":tenantId/notifications/read-all")
  @HttpCode(200)
  async markAllRead(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "notification", tenantId }, "update");
    const res = await withTenants([tenantId], (c) =>
      c.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.principal.userId]),
    );
    return { marked: res.rowCount ?? 0 };
  }
}
