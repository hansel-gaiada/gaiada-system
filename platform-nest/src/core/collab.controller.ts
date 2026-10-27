// Collaboration routes (Nest port of core/collab.ts): threaded comments + per-user
// notifications. Notifications raised on mention + comment-on-assigned-task via notify().
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
// NOTE: Nest defaults POST → 201; non-create POSTs carry @HttpCode(200) to match the
// Fastify server's 200 responses exactly (contract parity).
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity, notify } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import {
  SOCIAL_POST_ENTITY, assertAnchorOnPostFile, authorizeReactionTarget, authorizeSocialPostThread, loadReplyParent, mentionsWhoCanRead,
  parseAnchor, requireRecordClient, resolveReplyVisibility,
} from "../modules/social/pipeline/post-comments";

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
    // SCP-1l (BFF §63.8): a social_post thread has the post's audience: `social_post` · `read`, or `design`.
    // Every other entity type is untouched.
    if (entityType === SOCIAL_POST_ENTITY) await authorizeSocialPostThread(req.principal, tenantId, entityId);
    // P3-08: `reactions` is an ADDITIVE field (aggregated per comment, viewer-scoped `mine`) —
    // every other field/shape here is unchanged, so existing consumers (project "Discussion",
    // lib/entities.postComment) are unaffected by fields they don't read.
    // SCP-1l: `visibility` and `anchor` are ADDITIVE the same way ('team' and null for every thread but a social_post's).
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT co.id, co.author_id, u.name AS author_name, co.body, co.parent_comment_id, co.created_at,
                co.visibility, co.anchor,
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
    // SCP-1t (BFF §63.8): on a social_post thread a reaction also needs the post's audience (`read`, or `design`), as the thread itself does.
    await authorizeReactionTarget(req.principal, tenantId, commentId);
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
    // SCP-1t: the same audience gate as adding one, so a person the post's audience excludes learns nothing from the answer.
    await authorizeReactionTarget(req.principal, tenantId, commentId);
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
  async createComment(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { entityType?: string; entityId?: string; body?: string; parentCommentId?: string; mentions?: string[]; visibility?: unknown; anchor?: unknown },
  ) {
    const { entityType, entityId, body: text, parentCommentId, mentions = [] } = body ?? {};
    if (!entityType || !entityId || !text) throw new BadRequestException("entityType, entityId and body required");
    await authorize(req.principal, { kind: "comment", tenantId }, "create");
    // SCP-1l (BFF §63.8). Authorization first, validation second: a refused caller never reads a 400.
    const isSocialPost = entityType === SOCIAL_POST_ENTITY;
    const access = isSocialPost ? await authorizeSocialPostThread(req.principal, tenantId, entityId) : null;
    // A client-visible comment speaks to the client: `record_client` as well (403 not_officer_or_approver). Only a value that
    // IS 'client' asks for it; any other value is judged below, after authorization.
    if (access && body?.visibility === "client") await requireRecordClient(req.principal, tenantId, access);
    // SCP-1t: a reply answers a comment of THIS post's thread (400 {field: "parentCommentId"} otherwise) and takes its visibility.
    const parent = isSocialPost ? await loadReplyParent(tenantId, entityId, parentCommentId) : null;
    // `visibility` and `anchor` belong to a social_post thread only; on any other thread either field is 400 {field}.
    if (!isSocialPost) {
      if (body?.visibility !== undefined) throw new BadRequestException({ message: "visibility_not_allowed", field: "visibility" });
      if (body?.anchor !== undefined) throw new BadRequestException({ message: "anchor_not_allowed", field: "anchor" });
    }
    // SCP-1t: no visibility given takes the parent's; a `client` reply to a `team` comment is 400 {field: "visibility"}.
    const visibility = isSocialPost ? resolveReplyVisibility(body?.visibility, parent) : "team";
    // A client-visible reply that INHERITED its visibility speaks to the client too: it needs `record_client` as an explicit `client` does.
    if (access && visibility === "client" && body?.visibility !== "client") await requireRecordClient(req.principal, tenantId, access);
    const anchor = isSocialPost ? parseAnchor(body?.anchor) : null;
    if (anchor) await assertAnchorOnPostFile(tenantId, entityId, anchor);
    const id = newId();
    const actorId = req.principal.userId;
    try {
      await withTenants([tenantId], (c) =>
        c.query(
          `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, parent_comment_id, origin_site, visibility, anchor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [id, tenantId, actorId, entityType, entityId, text, parentCommentId ?? null, config.originSite, visibility, anchor ? JSON.stringify(anchor) : null],
        ),
      );
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    await writeActivity(tenantId, actorId, "commented", entityType, entityId, isSocialPost ? { commentId: id, visibility } : { commentId: id });
    // TR-05: pm->work_activity evidence feed. entityType "task" is shared across subsystems (see
    // the pm_task_followers vs. `tasks` lookup below) — only emit onto the pm_task stream when
    // entityId genuinely resolves to a live pm_tasks row, so a comment on a non-PM "task" never
    // mints a bogus source='pm' activity row. Reuses the SAME "pm_task" stream the task lifecycle
    // events already emit on (not a new stream) — the consumer's generic eventType-tail verb
    // derivation naturally yields "commented" for "pm.task.commented", no special-casing needed.
    if (entityType === "task") {
      const pmTask = await withTenants([tenantId], (c) =>
        c.query<{ project_id: string }>(`SELECT project_id FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [entityId]),
      );
      if (pmTask.rows[0]) {
        // TR-31: actorId is the commenting user — the outbox consumer maps it straight into
        // work_activity.actor_user_id (and work-activity-linker.ts rule a mints an EXACT person
        // link from it), which is what the person-grain `comments_authored` metric reads. Without
        // it this row's actor silently comes back null and the metric silently reads zero.
        await withTenants([tenantId], (c) =>
          emitEvent(c, tenantId, "pm_task", entityId, "pm.task.commented", {
            taskId: entityId, projectId: pmTask.rows[0].project_id, commentId: id, actorId,
          }),
        );
      }
    }
    // Deep-link target for the notification bell (payload.href) — tasks resolve to their page.
    const href = entityType === "task" ? `/tasks/${entityId}` : undefined;
    // P3-08 fan-out dedup: mentions ∪ assignee ∪ followers collapse into ONE "already notified"
    // set so nobody gets two notifications for this one comment (e.g. a follower who is also
    // @mentioned, or is the task's assignee). Mentions are processed first — an explicit @mention
    // is the most specific fact, so it wins the single notify() call for that recipient.
    // notify() itself auto-skips the actor (recipientId === actorId, verified in core/http.ts).
    const alreadyNotified = new Set<string>();
    // SCP-1t (BFF §63.8): on a social_post thread an @mention only reaches a person who can read the post. The others are dropped, and the
    // answer says which (`mentionsNotNotified`, additive), so the author knows who was not told.
    let toNotify = Array.from(new Set(mentions)).slice(0, 50);
    let notNotified: string[] = [];
    if (access) {
      const audience = await mentionsWhoCanRead(access.resource, toNotify);
      toNotify = audience.readers;
      notNotified = audience.dropped;
    }
    for (const m of toNotify) {
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
    return notNotified.length > 0 ? { id, mentionsNotNotified: notNotified } : { id };
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
