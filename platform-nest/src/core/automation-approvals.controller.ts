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
import { emitEvent } from "../events/outbox.service";
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
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    // WSD-4: an optional origin filter. origin='hr' additionally passes resource.attr.module
    // so an hr_manager (module_manager, no company_admin grant) can read the served company's
    // leave-approval slice of the unified inbox — the module_manager rule in
    // resource_automation_approval.yaml is scoped tightly to module=='hr' (WSD-2), so this
    // never widens visibility for any other origin.
    @Query("origin") origin?: string,
  ) {
    await authorize(req.principal, { kind: "automation_approval", tenantId, module: origin === "hr" ? "hr" : undefined }, "read");
    const filterPending = status === undefined || status === "pending";
    const params: unknown[] = [];
    const clauses = ["deleted_at IS NULL"];
    if (filterPending) clauses.push("status = 'pending'");
    else if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    if (origin) { params.push(origin); clauses.push(`origin = $${params.length}`); }
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, workflow_id, tool_name, tool_args, impact, reason, status, origin, agent_name, requested_by, decided_by, decided_at, created_at
         FROM automation_approvals
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC LIMIT 200`,
        params,
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
    // WSD-4: fetch the row's origin BEFORE authorizing, so an hr-origin approval carries
    // resource.attr.module='hr' — the ONLY way the module_manager derived role (the
    // providing unit's hr_manager, who is not necessarily the served company's admin) can
    // decide (resource_automation_approval.yaml, WSD-2). Every other origin is unaffected
    // (module stays "").  404s here (not 403) when the id doesn't exist/isn't visible, same
    // as before this change — no new information disclosed to a non-authorized caller.
    const existing = await withTenants([tenantId], (c) =>
      c.query<{ origin: string }>(`SELECT origin FROM automation_approvals WHERE id = $1 AND deleted_at IS NULL`, [id]),
    );
    if (!existing.rows[0]) throw new NotFoundException("approval not found or already decided");
    const module = existing.rows[0].origin === "hr" ? "hr" : undefined;
    await authorize(req.principal, { kind: "automation_approval", id, tenantId, module }, "decide");
    const res = await withTenants([tenantId], async (c) => {
      const upd = await c.query<{ origin: string; tool_args: unknown; workflow_id: string; tool_name: string }>(
        `UPDATE automation_approvals SET status = $2, decided_by = $3, decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
         RETURNING origin, tool_args, workflow_id, tool_name`,
        [id, decision, req.principal.userId],
      );
      if (upd.rowCount === 0) return null;
      // Outbox event so module eventHandlers (WSD-4: HR's leave-decision handler) can react.
      // entityType "automation_approval" — see startConsumerLoop's watched streams in main.ts.
      await emitEvent(c, tenantId, "automation_approval", id, "automation_approval.decided", {
        decision,
        origin: upd.rows[0].origin,
        toolArgs: upd.rows[0].tool_args,
        workflowId: upd.rows[0].workflow_id,
        toolName: upd.rows[0].tool_name,
        decidedBy: req.principal.userId,
      });
      return upd.rows[0];
    });
    if (!res) throw new NotFoundException("approval not found or already decided");
    await writeActivity(tenantId, req.principal.userId, decision, "automation_approval", id);
    return { id, status: decision };
  }
}
