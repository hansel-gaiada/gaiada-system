// AIP-17b (docs/plans/2026-10-27-ai-plan.md §6.3 item 6; docs/FRONTEND-BFF-CONTRACT.md §66.4; docs/PERMISSION-CONTRACT.md §58) — the owner's edits:
//   PUT /api/:tenantId/ai-usage/budgets/company            { monthlyUsd: string | null }                     null removes the company figure
//   PUT /api/:tenantId/ai-usage/budgets/units/:unitNodeId  { monthlyUsd: string | null, mode?: 'report'|'soft_stop' }
//   GET /api/:tenantId/ai-usage/allowances                 the per-person overrides, with names, and the default
//   PUT /api/:tenantId/ai-usage/allowances/:userId         { dailyReplies: number | null }                   null returns the person to the default
// Every one needs `manage` on the Cerbos kind `ai_usage` (the owner and the superadmin; bots and automation are denied by the policy).
//
// ── THE ORDER OF CHECKS (the "validation pre-empts authz on create" trap) ────────────────────────────────────────────────────────
//   (1) AUTHORIZE `manage`, before the body or the path is looked at: a refused caller always gets 403 and learns nothing about the body;
//   (2) VALIDATE the body (and the person's id shape): 400;
//   (3) EXISTENCE, inside the one transaction: the unit must be a node of this company's org tree (closure rows, computed WITH the tenant), else
//       404 `unit_not_found`; the person must be an ACTIVE member of this company, else 404 `person_not_found`;
//   (4) the write and its one activity row, in that same transaction.
// The tenant comes from the route (validated by the router) and the actor from the principal, never from the body.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Put, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../db";
import { AuthGuard } from "../../auth/guards";
import { authorize } from "../../core/http";
import { config } from "../../config";
import { loadUnitAncestors } from "../../core/org-unit-closure";
import { loadOrgStructure } from "../reports/person-scope";
import { aiUsageResource } from "./authz";
import { parseMonth } from "./reads.service";
import * as svc from "./budgets.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function mapBody<T>(fn: () => T): Promise<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof svc.BudgetBodyError) throw new BadRequestException({ message: e.message, ...(e.field ? { field: e.field } : {}) });
    throw e;
  }
}

@Controller("api/:tenantId/ai-usage")
@UseGuards(AuthGuard)
export class AiUsageBudgetsController {
  /** (1) of the order above. `manage` reads no unit and no GM seat, so the resource carries only the company. */
  private async authorizeManage(req: FastifyRequest, tenantId: string): Promise<string> {
    const principal = req.principal;
    await authorize(principal, aiUsageResource(tenantId), "manage");
    if (!principal.userId) throw new BadRequestException("no principal user");
    return principal.userId;
  }

  @Put("budgets/company")
  @HttpCode(200)
  async putCompany(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    const actorId = await this.authorizeManage(req, tenantId);
    const input = await mapBody(() => svc.parseCompanyBudgetBody(body));
    const month = parseMonth(undefined);
    return withTenants([tenantId], async (c) => {
      const out = await svc.putCompanyBudget(c, tenantId, actorId, input.monthlyUsd);
      const budgets = await svc.readBudgets(c, tenantId, month, await loadOrgStructure(c, tenantId));
      return { month: month.month, changed: out.changed, budget: budgets.company };
    });
  }

  @Put("budgets/units/:unitNodeId")
  @HttpCode(200)
  async putUnit(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("unitNodeId") unitNodeId: string, @Body() body: unknown) {
    const actorId = await this.authorizeManage(req, tenantId);
    const input = await mapBody(() => svc.parseUnitBudgetBody(body));
    const month = parseMonth(undefined);
    return withTenants([tenantId], async (c) => {
      // (3): the unit is a node of this company's tree. The closure is read WITH the tenant: node ids repeat across companies.
      if ((await loadUnitAncestors(c, tenantId, unitNodeId)).length === 0) {
        throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
      }
      const out = await svc.putUnitBudget(c, tenantId, actorId, unitNodeId, input.monthlyUsd, input.mode);
      const budget = await svc.readUnitBudget(c, tenantId, month, await loadOrgStructure(c, tenantId), unitNodeId);
      return { month: month.month, changed: out.changed, budget };
    });
  }

  @Get("allowances")
  async allowances(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await this.authorizeManage(req, tenantId);
    const overrides = await withTenants([tenantId], (c) => svc.readAllowances(c, tenantId));
    return { defaultDailyReplies: config.aiUsage.dailyReplyAllowance, overrides };
  }

  @Put("allowances/:userId")
  @HttpCode(200)
  async putAllowance(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Body() body: unknown) {
    const actorId = await this.authorizeManage(req, tenantId);
    const input = await mapBody(() => svc.parseAllowanceBody(body));
    if (!UUID_RE.test(userId)) throw new BadRequestException({ message: "userId must be a uuid", field: "userId" });
    const person = userId.toLowerCase();
    return withTenants([tenantId], async (c) => {
      // (3): only an active member of this company has an allowance here, so a removal for a stranger is also a 404 (it names no one).
      if (!(await svc.isActiveMember(c, tenantId, person))) throw new NotFoundException({ message: "person_not_found", field: "userId" });
      const out = await svc.putAllowance(c, tenantId, actorId, person, input.dailyReplies);
      return { userId: person, changed: out.changed, dailyReplies: out.dailyReplies ?? config.aiUsage.dailyReplyAllowance, isDefault: out.dailyReplies === null };
    });
  }
}
