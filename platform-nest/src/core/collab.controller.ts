// Collaboration routes (Nest port of core/collab.ts): threaded comments + per-user
// notifications. Notifications raised on mention + comment-on-assigned-task via notify().
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
// NOTE: Nest defaults POST → 201; non-create POSTs carry @HttpCode(200) to match the
// Fastify server's 200 responses exactly (contract parity).
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity, notify } from "./http";
import { AuthGuard } from "../auth/guards";

@Controller("api")
@UseGuards(AuthGuard)
export class CollabController {
  @Get(":tenantId/comments")
  async listComments(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("entityType") entityType?: string, @Query("entityId") entityId?: string) {
    if (!entityType || !entityId) throw new BadRequestException("entityType and entityId required");
    await authorize(req.principal, { kind: "comment", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT co.id, co.author_id, u.name AS author_name, co.body, co.parent_comment_id, co.created_at
         FROM comments co LEFT JOIN users u ON u.id = co.author_id
         WHERE co.target_entity_type = $1 AND co.target_entity_id = $2 AND co.deleted_at IS NULL
         ORDER BY co.created_at`,
        [entityType, entityId],
      ),
    );
    return rows.rows;
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
    for (const m of Array.from(new Set(mentions)).slice(0, 50)) {
      await notify(tenantId, m, actorId, "mention", { entityType, entityId, commentId: id });
    }
    if (entityType === "task") {
      const assignee = await withTenants([tenantId], (c) =>
        c.query<{ assignee_id: string | null }>(`SELECT assignee_id FROM tasks WHERE id = $1`, [entityId]),
      );
      const a = assignee.rows[0]?.assignee_id;
      if (a && !mentions.includes(a)) await notify(tenantId, a, actorId, "comment", { entityType, entityId, commentId: id });
    }
    return { id };
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
