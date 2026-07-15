// WS4 §3 / D14 — automation approvals suspension surface. When the mcp-hub write gate refuses a
// medium+/unclassified write for an n8n automation principal, the workflow calls the hub's
// `approvals.request` tool (OBO), which lands here as a create. A human then reads the pending
// inbox and decides. The store is tenant-scoped (FORCE RLS, 0014) and Cerbos-gated: automation
// service accounts may CREATE, elevated humans READ, and only company_admin/group_executive DECIDE.
//
// v1 records + decides; it does NOT re-drive the approved tool call (that is a Temporal/durable
// concern the spec defers). The approved row is the durable artifact a future resume step reads.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";

const IMPACTS = new Set(["medium", "high", "unclassified"]);
const ORIGINS = new Set(["automation", "agent"]);

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
    return { id, status: "pending" };
  }

  @Get(":tenantId/automation-approvals")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("status") status?: string) {
    await authorize(req.principal, { kind: "automation_approval", tenantId }, "read");
    const filterPending = status === undefined || status === "pending";
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, workflow_id, tool_name, tool_args, impact, reason, status, origin, agent_name, requested_by, decided_by, decided_at, created_at
         FROM automation_approvals
         WHERE deleted_at IS NULL ${filterPending ? "AND status = 'pending'" : status ? "AND status = $1" : ""}
         ORDER BY created_at DESC LIMIT 200`,
        filterPending || !status ? [] : [status],
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
    await authorize(req.principal, { kind: "automation_approval", id, tenantId }, "decide");
    const res = await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE automation_approvals SET status = $2, decided_by = $3, decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL`,
        [id, decision, req.principal.userId],
      ),
    );
    if (res.rowCount === 0) throw new NotFoundException("approval not found or already decided");
    await writeActivity(tenantId, req.principal.userId, decision, "automation_approval", id);
    return { id, status: decision };
  }
}
