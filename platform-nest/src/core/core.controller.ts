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
import { clientFilterSql, parseClientFilter } from "./client-filter";
import { recomputeRollups } from "../rollups/engine";
import { AuthGuard } from "../auth/guards";
import { getServiceScopes } from "./service-scopes";
import { deriveUniqueShortCode } from "./project-short-codes";

@Controller("api")
@UseGuards(AuthGuard)
export class CoreController {
  @Get("companies")
  async companies(@Req() req: FastifyRequest) {
    const isAdmin = req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
    const rows = await withGlobal((c) =>
      c.query(
        isAdmin
          ? `SELECT id, name, type, enabled_modules, status, parent_company_id FROM companies WHERE deleted_at IS NULL`
          : `SELECT id, name, type, enabled_modules, status, parent_company_id FROM companies WHERE deleted_at IS NULL AND id = ANY($1::uuid[])`,
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
    // ORG-7b: serviceScopes is ADDITIVE to the Me shape — existing consumers that don't read it
    // are unaffected; [] whenever the release-train flag is off (default) or there is none.
    const serviceScopes = await getServiceScopes(req.principal.userId, req.principal.companies);
    return {
      userId: req.principal.userId,
      assurance: req.principal.assurance,
      name: profile.rows[0]?.name ?? "",
      email: profile.rows[0]?.email ?? "",
      title: profile.rows[0]?.title ?? null,
      companies: companies.rows,
      roles: req.principal.roles,
      serviceScopes,
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

  // CC-1: `?clientId=<uuid>` narrows to one client, `?clientId=internal` to projects with no client.
  // Omitted is unchanged behaviour — every project — so no existing caller is affected.
  @Get(":tenantId/projects")
  async projects(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("clientId") clientId?: string,
  ) {
    await authorize(req.principal, { kind: "project", tenantId }, "read");
    const filter = clientFilterSql(parseClientFilter(clientId), "client_id", 1);
    const rows = await withTenants([tenantId], (c) =>
      // P4-H2: `start_date` was selected ONLY by the single-project detail read, so every LIST
      // consumer could show a project's target but never the start of its authored range — and the
      // authored-vs-derived slippage signal (decision 12) needs both ends. One extra column on a
      // query that already reads the row.
      c.query(
        `SELECT id, name, status, client_id, is_internal, owner_id, start_date, due_date, custom_fields, department_id, short_code AS "shortCode"
               FROM projects WHERE deleted_at IS NULL AND ${filter.sql} ORDER BY created_at DESC`,
        filter.params,
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/projects")
  @HttpCode(201)
  async createProject(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; clientId?: string; departmentId?: string; customFields?: Record<string, unknown> },
  ) {
    const { name, clientId, departmentId, customFields = {} } = body ?? {};
    if (!name) throw new BadRequestException("name required");
    // The controller always sets owner_id = the creating user on insert (below) — pass that same
    // intended ownerId into the authz check so Cerbos's member "create own project" rule
    // (resource_project.yaml's `owns` condition) can actually be satisfied. Without this, a brand
    // new resource's ownerId attr was always "" (never equal to principal.id), so the member rule
    // was structurally unreachable and only company_admin/manager/team_lead could ever create.
    await authorize(req.principal, { kind: "project", tenantId, ownerId: req.principal.userId ?? undefined }, "create");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const cfError = await validateCustomFields(c, tenantId, "project", customFields);
      if (cfError) throw new BadRequestException(cfError);
      // WD-28: every new project gets a unique short_code up front (not just the 0050 backfill's
      // one-time pass over pre-existing rows) so pm_tasks created under it can always display
      // CODE-SEQ. `projects_short_code_uidx` is the hard backstop if this probe ever loses a race.
      const shortCode = await deriveUniqueShortCode(c, tenantId, name);
      await c.query(
        `INSERT INTO projects (id, tenant_id, name, client_id, owner_id, custom_fields, department_id, short_code, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, name, clientId ?? null, req.principal.userId, JSON.stringify(customFields), departmentId ?? null, shortCode, config.originSite],
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
    if (newlyAssigned) {
      await notify(tenantId, newlyAssigned, req.principal.userId, "assignment", {
        title: "You were assigned a task", severity: "info", entityType: "task", entityId: taskId, href: `/tasks/${taskId}`,
      });
    }
    return { id: taskId };
  }

  @Get(":tenantId/projects/:projectId")
  async projectDetail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "project", tenantId, id: projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT p.id, p.name, p.status, p.client_id, cl.name AS client_name, p.is_internal,
                p.owner_id, u.name AS owner_name, p.start_date, p.due_date, p.custom_fields, p.department_id
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
    @Body() b: { name?: string; status?: string; clientId?: string | null; startDate?: string | null; dueDate?: string | null; departmentId?: string | null; customFields?: Record<string, unknown> },
  ) {
    // Fetch the REAL owner from the row (never trust a client-asserted ownerId) so Cerbos's member
    // "update own project" `owns` rule can be evaluated against the actual resource, mirroring
    // client-work.controller.ts's updateTime pattern.
    const existing = await withTenants([tenantId], (c) =>
      c.query<{ owner_id: string | null }>(`SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]),
    );
    if (!existing.rows[0]) throw new NotFoundException("project not found");
    await authorize(req.principal, { kind: "project", tenantId, id: projectId, ownerId: existing.rows[0].owner_id ?? undefined }, "update");
    await withTenants([tenantId], async (c) => {
      if (b.customFields) {
        const cfError = await validateCustomFields(c, tenantId, "project", b.customFields);
        if (cfError) throw new BadRequestException(cfError);
      }
      const res = await c.query(
        `UPDATE projects SET name = COALESCE($2, name), status = COALESCE($3, status), client_id = COALESCE($4, client_id),
           start_date = COALESCE($5, start_date), due_date = COALESCE($6, due_date), custom_fields = COALESCE($7, custom_fields),
           department_id = COALESCE($8, department_id), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [projectId, b.name ?? null, b.status ?? null, b.clientId ?? null, b.startDate ?? null, b.dueDate ?? null,
         b.customFields ? JSON.stringify(b.customFields) : null, b.departmentId ?? null],
      );
      if (res.rowCount === 0) throw new NotFoundException("project not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "project", projectId, {});
    return { id: projectId };
  }

  @Get(":tenantId/members")
  async members(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("includeService") includeServiceRaw?: string,
    // WSD-4: the HR-workspace directory view passes ?module=hr so a served-company hr_staff grant
    // (module_staff, resource_member.yaml) can read this tenant's directory — module_staff self-
    // gates on `module != ""` and matches no other resource kind, so every OTHER caller of this
    // endpoint (which never sends `module`) is completely unaffected by this addition.
    @Query("module") moduleQ?: string,
  ) {
    await authorize(req.principal, { kind: "member", tenantId, module: moduleQ || undefined }, "read");
    // ORG-7b service-row badging: gated behind the release-train flag so this stays exactly the
    // pre-existing behavior (no kind filtering, no `kind`/`isService` fields) while
    // SERVICE_ASSIGNMENTS_ENABLED is off — the default, and true today for every deployed
    // consumer of this endpoint. Once the flag is on: default filters to kind='employee' (hides
    // reconciler-materialized service rows from the ordinary directory); `?includeService=1`
    // includes both kinds and marks each row so the UI can badge service members (matches ORG-12's
    // planned "served-company badging" consumption).
    const includeService = config.serviceAssignmentsEnabled && includeServiceRaw === "1";
    const filterEmployeeOnly = config.serviceAssignmentsEnabled && !includeService;
    // ⚠ PK-02: NON-HUMANS ARE EXCLUDED REGARDLESS OF THE FLAG, and that is a fix for a live defect.
    // Everything above this line is about SERVICE ASSIGNMENTS — "is this row a reconciler-
    // materialized placement?" — and it is correctly gated on the release-train flag. But whether a
    // row is a PERSON was never that question, and with the flag off (the default, and true for
    // every deployed consumer today) this endpoint applied no filter at all: `/members` listed the
    // 17 n8n service accounts alongside real staff, which is the same defect that once made HR
    // report 36 people when 19 were people.
    //
    // `users.kind` can finally ask it directly, so the two dimensions are now separated:
    //   u.kind = 'employee'  -> is this a person?              (always, flag-independent)
    //   m.kind = 'employee'  -> is this placement ordinary?     (unchanged, still flag-gated)
    // Deliberately NOT folded together: when the flag is on, the ordinary directory hides
    // reconciler-materialized rows by default, and those rows are HUMANS placed into the served
    // company. Whether the served company's directory should show them (badged, per ORG-12) is a
    // product decision, not this ticket's — so that behaviour is left exactly as it was.
    const includeNonHuman = includeServiceRaw === "1";
    const rows = await withTenants([tenantId], async (c) => {
      // Reset a possibly-stale principal_user_id GUC before the RLS'd read (see Fastify note).
      await c.query("SELECT set_config('app.principal_user_id', NULL, true)");
      return c.query<{ user_id: string; name: string; email: string; title: string | null; kind?: string }>(
        `SELECT m.user_id, u.name, u.email, u.title${config.serviceAssignmentsEnabled ? ", m.kind" : ""}
         FROM company_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'active'
           ${includeNonHuman ? "" : "AND u.kind = 'employee'"}
           ${filterEmployeeOnly ? "AND m.kind = 'employee'" : ""}
         ORDER BY u.name`,
      );
    });
    if (!config.serviceAssignmentsEnabled) return rows.rows;
    return rows.rows.map((r) => ({ ...r, isService: r.kind === "service" }));
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
    // ⚠ MON-00c FOLLOW-UP: THIS AUTHORIZE CALL MUST CARRY A TENANT, and until now it did not.
    //
    // `resource_rollup.yaml`'s group_executive rule is gated on `variables.inRoot`, which evaluates
    // `request.resource.attr.tenantId in request.principal.attr.rootCompanies`. This endpoint passed
    // `{ kind: "rollup" }` with NO tenantId, so that expression had no attribute to read, the
    // condition could not evaluate, and the rule never matched — a group_executive was denied
    // outright on the one endpoint that exists to serve them. The symptom was not a clean 403 either:
    // callers received an error object where they expected an array (agency.test.ts's
    // "rows.find is not a function").
    //
    // The tenant is the caller's OWN ROOT COMPANY. That is the right anchor for a listing that spans
    // several companies: `rootCompanies` is the expanded set of every company in the caller's root
    // subtree (rbac/principal.ts), and a root company's own `root_company_id` is itself, so the root
    // id is always a member of that set. `inRoot` therefore holds exactly when the caller is reading
    // the root they belong to, and fails for any other — which is the guarantee this endpoint needs
    // now that more than one company, under more than one root, uses the platform.
    //
    // Resolved BEFORE the authorize call rather than reusing the SQL below, because a decision must
    // not depend on data the decision is supposed to gate.
    //
    // The alternative — relaxing the policy to allow when no tenantId is present — was rejected. It
    // would make "omit the attribute" a way to skip a boundary check, and that shape becomes a leak
    // the first time another caller authorizes this kind without a tenant.
    const rootId = (
      await withGlobal((c) =>
        c.query<{ id: string | null }>(
          `SELECT c2.root_company_id AS id
             FROM users u JOIN companies c2 ON c2.id = u.home_company_id
            WHERE u.id = $1`,
          [req.principal.userId],
        ),
      )
    ).rows[0]?.id;
    // A caller with no resolvable root passes no tenant, which only the UNCONDITIONAL platform_admin
    // rule can satisfy — the SaaS operator, who legitimately spans every root and has no single one
    // of their own. Every other principal is denied, which is the correct direction: an unresolvable
    // anchor must fail closed, exactly as the company-scoping below already does.
    await authorize(req.principal, { kind: "rollup", tenantId: rootId ?? undefined }, "read");
    const p = period ?? new Date().toISOString().slice(0, 10);
    // MON-00b. This previously selected EVERY company in the database and handed the lot to
    // withTenants — the one request in the estate that touched all roots at once. Harmless while a
    // single holding existed; a cross-customer read the moment a second root does. Now bounded to the
    // caller's own root, derived from users.home_company_id (MON-00a).
    //
    // A global platform_admin — the SaaS operator — keeps the estate-wide view on purpose; that is the
    // one principal class entitled to it. Everyone else is confined to their own root, and a caller
    // whose home company cannot be resolved gets NOTHING rather than everything: an unresolvable
    // anchor must fail closed, since the failure mode of the other choice is a cross-customer read.
    // The operator is identified by an EXPLICIT global platform_admin grant — never by a missing
    // home company. Inferring "operator" from a null anchor would grant the whole estate to any
    // principal that simply has no memberships, which is the shape of the leak being closed here.
    const isOperator = req.principal.roles.some(
      (g) => g.role === "platform_admin" && g.scopeType === "global",
    );
    const companies = await withGlobal((c) =>
      isOperator
        ? c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`)
        : c.query<{ id: string }>(
            `SELECT co.id FROM companies co
              WHERE co.deleted_at IS NULL
                AND co.root_company_id = (
                  SELECT c2.root_company_id FROM users u
                    JOIN companies c2 ON c2.id = u.home_company_id
                   WHERE u.id = $1)`,
            [req.principal.userId],
          ),
    );
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
