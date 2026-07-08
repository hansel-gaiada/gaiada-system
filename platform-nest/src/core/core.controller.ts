// Core /api routes (Nest port of server.ts). @Controller("api") + AuthGuard; each handler
// mirrors the Fastify version: authorize() (throws 403/401) → RLS-bound query → activity on
// mutation. Bodies/params/query via Nest decorators; 201s via @HttpCode; 400/404 via throws.
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants, withGlobal } from "../db";
import { config } from "../config";
import { authorize, writeActivity, notify } from "./http";
import { validateCustomFields } from "./custom-fields";
import { recomputeRollups } from "../rollups/engine";
import { AuthGuard } from "../auth/guards";

@Controller("api")
@UseGuards(AuthGuard)
export class CoreController {
  @Get("companies")
  async companies(@Req() req: FastifyRequest) {
    const isAdmin = req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
    const rows = await withGlobal((c) =>
      c.query(
        isAdmin
          ? `SELECT id, name, type, enabled_modules, status FROM companies WHERE deleted_at IS NULL`
          : `SELECT id, name, type, enabled_modules, status FROM companies WHERE deleted_at IS NULL AND id = ANY($1::uuid[])`,
        isAdmin ? [] : [req.principal.companies],
      ),
    );
    return rows.rows;
  }

  @Get("me")
  async me(@Req() req: FastifyRequest) {
    if (!req.principal.userId) throw new UnauthorizedException("no user");
    const profile = await withGlobal((c) =>
      c.query<{ name: string; email: string; title: string | null }>(
        `SELECT name, email, title FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [req.principal.userId],
      ),
    );
    const companies = req.principal.companies.length
      ? await withGlobal((c) =>
          c.query(`SELECT id, name, type FROM companies WHERE deleted_at IS NULL AND id = ANY($1::uuid[])`, [
            req.principal.companies,
          ]),
        )
      : { rows: [] };
    return {
      userId: req.principal.userId,
      assurance: req.principal.assurance,
      name: profile.rows[0]?.name ?? "",
      email: profile.rows[0]?.email ?? "",
      title: profile.rows[0]?.title ?? null,
      companies: companies.rows,
      roles: req.principal.roles,
    };
  }

  @Get(":tenantId/activity")
  async activity(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("limit") limit?: string) {
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    const lim = Math.max(1, Math.min(Number(limit ?? 20) || 20, 100));
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT a.id, a.actor_id, u.name AS actor_name, a.verb, a.target_entity_type,
                a.target_entity_id, a.metadata, a.occurred_at
         FROM activities a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.occurred_at DESC LIMIT $1`,
        [lim],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/tasks")
  async tasks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("assignee") assignee?: string) {
    await authorize(req.principal, { kind: "task", tenantId }, "read");
    const mine = assignee === "me";
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT t.id, t.title, t.status, t.priority, t.assignee_id, t.due_date, t.project_id, p.name AS project_name
         FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NULL ${mine ? "AND t.assignee_id = $1" : ""}
         ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT 100`,
        mine ? [req.principal.userId] : [],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/projects")
  async projects(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "project", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, name, status, client_id, is_internal, owner_id, due_date, custom_fields
               FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC`),
    );
    return rows.rows;
  }

  @Post(":tenantId/projects")
  @HttpCode(201)
  async createProject(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; clientId?: string; customFields?: Record<string, unknown> },
  ) {
    const { name, clientId, customFields = {} } = body ?? {};
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "project", tenantId }, "create");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const cfError = await validateCustomFields(c, tenantId, "project", customFields);
      if (cfError) throw new BadRequestException(cfError);
      await c.query(
        `INSERT INTO projects (id, tenant_id, name, client_id, owner_id, custom_fields, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, name, clientId ?? null, req.principal.userId, JSON.stringify(customFields), config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "created", "project", id, { name });
    return { id };
  }

  @Get(":tenantId/projects/:projectId/tasks")
  async projectTasks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "task", tenantId, projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(`SELECT id, title, status, priority, assignee_id, due_date FROM tasks
               WHERE project_id = $1 AND deleted_at IS NULL ORDER BY sort_order, created_at`, [projectId]),
    );
    return rows.rows;
  }

  @Post(":tenantId/projects/:projectId/tasks")
  @HttpCode(201)
  async createTask(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() body: { title?: string; customFields?: Record<string, unknown> },
  ) {
    const { title, customFields = {} } = body ?? {};
    if (!title) throw new BadRequestException("title required");
    await authorize(req.principal, { kind: "task", tenantId, projectId }, "create");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const cfError = await validateCustomFields(c, tenantId, "task", customFields);
      if (cfError) throw new BadRequestException(cfError);
      await c.query(
        `INSERT INTO tasks (id, tenant_id, project_id, title, custom_fields, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, projectId, title, JSON.stringify(customFields), config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "created", "task", id, { title });
    return { id };
  }

  @Get(":tenantId/tasks/:taskId")
  async taskDetail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "task", tenantId, id: taskId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT t.id, t.title, t.status, t.priority, t.assignee_id, u.name AS assignee_name,
                t.due_date, t.project_id, p.name AS project_name, t.custom_fields
         FROM tasks t JOIN projects p ON p.id = t.project_id
         LEFT JOIN users u ON u.id = t.assignee_id
         WHERE t.id = $1 AND t.deleted_at IS NULL`,
        [taskId],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("task not found");
    return rows.rows[0];
  }

  @Patch(":tenantId/tasks/:taskId")
  async updateTask(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("taskId") taskId: string,
    @Body() b: { title?: string; status?: string; priority?: string; assigneeId?: string | null; dueDate?: string | null; customFields?: Record<string, unknown> },
  ) {
    await authorize(req.principal, { kind: "task", tenantId, id: taskId }, "update");
    let newlyAssigned: string | null = null;
    await withTenants([tenantId], async (c) => {
      if (b.customFields) {
        const cfError = await validateCustomFields(c, tenantId, "task", b.customFields);
        if (cfError) throw new BadRequestException(cfError);
      }
      const prev = await c.query<{ assignee_id: string | null }>(
        `SELECT assignee_id FROM tasks WHERE id = $1 AND deleted_at IS NULL`, [taskId],
      );
      if (!prev.rows[0]) throw new NotFoundException("task not found");
      await c.query(
        `UPDATE tasks SET title = COALESCE($2, title), status = COALESCE($3, status), priority = COALESCE($4, priority),
           assignee_id = COALESCE($5, assignee_id), due_date = COALESCE($6, due_date),
           custom_fields = COALESCE($7, custom_fields), updated_at = now()
         WHERE id = $1`,
        [taskId, b.title ?? null, b.status ?? null, b.priority ?? null, b.assigneeId ?? null,
         b.dueDate ?? null, b.customFields ? JSON.stringify(b.customFields) : null],
      );
      if (b.assigneeId && b.assigneeId !== prev.rows[0].assignee_id) newlyAssigned = b.assigneeId;
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "task", taskId, { status: b.status });
    if (newlyAssigned) await notify(tenantId, newlyAssigned, req.principal.userId, "assignment", { entityType: "task", entityId: taskId });
    return { id: taskId };
  }

  @Get(":tenantId/projects/:projectId")
  async projectDetail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "project", tenantId, id: projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT p.id, p.name, p.status, p.client_id, cl.name AS client_name, p.is_internal,
                p.owner_id, u.name AS owner_name, p.start_date, p.due_date, p.custom_fields
         FROM projects p LEFT JOIN clients cl ON cl.id = p.client_id LEFT JOIN users u ON u.id = p.owner_id
         WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [projectId],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("project not found");
    return rows.rows[0];
  }

  @Patch(":tenantId/projects/:projectId")
  async updateProject(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { name?: string; status?: string; clientId?: string | null; startDate?: string | null; dueDate?: string | null; customFields?: Record<string, unknown> },
  ) {
    await authorize(req.principal, { kind: "project", tenantId, id: projectId }, "update");
    await withTenants([tenantId], async (c) => {
      if (b.customFields) {
        const cfError = await validateCustomFields(c, tenantId, "project", b.customFields);
        if (cfError) throw new BadRequestException(cfError);
      }
      const res = await c.query(
        `UPDATE projects SET name = COALESCE($2, name), status = COALESCE($3, status), client_id = COALESCE($4, client_id),
           start_date = COALESCE($5, start_date), due_date = COALESCE($6, due_date), custom_fields = COALESCE($7, custom_fields),
           updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [projectId, b.name ?? null, b.status ?? null, b.clientId ?? null, b.startDate ?? null, b.dueDate ?? null,
         b.customFields ? JSON.stringify(b.customFields) : null],
      );
      if (res.rowCount === 0) throw new NotFoundException("project not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "project", projectId, {});
    return { id: projectId };
  }

  @Get(":tenantId/members")
  async members(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "member", tenantId }, "read");
    const rows = await withTenants([tenantId], async (c) => {
      // Reset a possibly-stale principal_user_id GUC before the RLS'd read (see Fastify note).
      await c.query("SELECT set_config('app.principal_user_id', NULL, true)");
      return c.query(
        `SELECT m.user_id, u.name, u.email, u.title FROM company_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'active' ORDER BY u.name`,
      );
    });
    return rows.rows;
  }

  @Post(":tenantId/rollups/recompute")
  @HttpCode(200)
  async recompute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: { period?: string }) {
    const period = body?.period ?? new Date().toISOString().slice(0, 10);
    await authorize(req.principal, { kind: "rollup_recompute", tenantId }, "create");
    const written = await recomputeRollups(tenantId, period);
    return { period, written };
  }

  @Get("rollups")
  async rollups(@Req() req: FastifyRequest, @Query("period") period?: string) {
    await authorize(req.principal, { kind: "rollup" }, "read");
    const p = period ?? new Date().toISOString().slice(0, 10);
    const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`));
    const all = companies.rows.map((r) => r.id);
    if (all.length === 0) return [];
    const rows = await withTenants(all, (c) =>
      c.query(
        `SELECT r.tenant_id, co.name AS company, r.module, r.metric_key, r.numerator, r.denominator,
                r.currency, r.dimensions, r.period, r.as_of
         FROM rollup_metrics r JOIN companies co ON co.id = r.tenant_id
         WHERE r.period = $1 ORDER BY co.name, r.metric_key`,
        [p],
      ),
    );
    return rows.rows;
  }
}
