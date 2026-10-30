// AIP-15 (docs/plans/2026-10-27-ai-plan.md §6.3 item 3; owner rulings AIP-D6, AIP-D18; docs/FRONTEND-BFF-CONTRACT.md §66;
// docs/PERMISSION-CONTRACT.md §58) — the three AI usage reads, by UTC calendar month (`?month=YYYY-MM`, default the current UTC month):
//   GET /api/:tenantId/ai-usage/me                       read_own: the caller's OWN rows only (`user_id = caller`): totals, by surface, by day
//   GET /api/:tenantId/ai-usage/units/:unitNodeId        read_people or read_unit: the unit's subtree with `people[]`;
//                                                        else read_company: the same WITHOUT a `people` key; else 403
//   GET /api/:tenantId/ai-usage/company                  read_company or read_people: totals by department, model, surface and day
// Every answer carries `capabilities` { canSeePeople, canManage, canLiftStop } for the screens. Counts and money only, never any text.
// The Cerbos kind is `ai_usage` (resource_ai_usage.yaml); the facts it sees are built in authz.ts, the SQL and shapes are in reads.service.ts.
//
// ── THE ORDER OF CHECKS (the dept-notices trap) ──────────────────────────────────────────────────
//   (1) the facts, read in ONE withTenants([tenantId]) transaction: the org tree, the GM seats (`gmIds`) and, on the unit route, the unit's
//       ancestry from the per-tenant closure (WITH the tenant: node ids repeat across companies), before anything is looked at;
//   (2) AUTHORIZE: one advisory `checkActions` over the kind's actions, then `authorize()` on the action that decides (so the denial, the
//       audit row and the act-for intersection are the house ones). Cerbos is never called inside a transaction;
//   (3) the month (a refused caller always gets 403, never a 400);
//   (4) unit route only: the unit must be a node of this company's org tree (closure rows), else 404 `unit_not_found`. A head never gets
//       here for an unknown unit: an id with no closure rows has ancestors [], so no lead grant matches and (2) refused it first;
//   (5) the reads, one withTenants([tenantId]) transaction (FORCE RLS).
import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../db";
import { AuthGuard } from "../../auth/guards";
import { checkActions } from "../../rbac/cerbos";
import type { Principal } from "../../rbac/principal";
import { authorize } from "../../core/http";
import { AI_USAGE_ACTIONS, aiUsageResource, loadAiUsageFacts, type AiUsageAction } from "./authz";
import * as svc from "./reads.service";

type Decisions = Record<AiUsageAction, boolean>;

async function decide(principal: Principal, tenantId: string, facts: { unitAncestors?: string[]; gmIds?: string[] }): Promise<Decisions> {
  return (await checkActions(principal, aiUsageResource(tenantId, facts), AI_USAGE_ACTIONS)) as Decisions;
}

/** Map the service's refusals to HTTP; let everything else through. */
async function mapRules<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof svc.UsageRuleError) {
      const body = { message: e.message, ...(e.field ? { field: e.field } : {}) };
      throw e.httpStatus === 404 ? new NotFoundException(body) : new BadRequestException(body);
    }
    throw e;
  }
}

@Controller("api/:tenantId/ai-usage")
@UseGuards(AuthGuard)
export class AiUsageReadsController {
  @Get("me")
  async me(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("month") monthRaw?: unknown) {
    const principal = req.principal;
    // No unit and no GM seat matter here: read_own, read_people and manage read neither attribute, so no facts are loaded.
    const resource = aiUsageResource(tenantId);
    const d = await decide(principal, tenantId, {});
    await authorize(principal, resource, "read_own");
    if (!principal.userId) throw new BadRequestException("no principal user");
    const userId = principal.userId;
    const month = await mapRules(() => svc.parseMonth(monthRaw));
    const scope: svc.UsageScope = { kind: "own", userId };
    const out = await withTenants([tenantId], async (c) => ({
      totals: await svc.readTotals(c, tenantId, month, scope),
      bySurface: await svc.readBySurface(c, tenantId, month, scope),
      byDay: await svc.readByDay(c, tenantId, month, scope),
    }));
    return {
      month: month.month,
      ...out,
      capabilities: { canSeePeople: d.read_people, canManage: d.manage, canLiftStop: d.manage } satisfies svc.Capabilities,
    };
  }

  @Get("units/:unitNodeId")
  async unit(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("unitNodeId") unitNodeId: string,
    @Query("month") monthRaw?: unknown,
  ) {
    const principal = req.principal;
    const facts = await withTenants([tenantId], (c) => loadAiUsageFacts(c, tenantId, unitNodeId));
    const resource = aiUsageResource(tenantId, facts);
    const d = await decide(principal, tenantId, facts);
    // People first (the owner's read_people, then the head's read_unit), else the company tier's totals, else a 403 on read_unit.
    const action: AiUsageAction = d.read_people ? "read_people" : d.read_unit ? "read_unit" : d.read_company ? "read_company" : "read_unit";
    await authorize(principal, resource, action);
    const withPeople = action === "read_people" || action === "read_unit";
    const month = await mapRules(() => svc.parseMonth(monthRaw));
    if (facts.unitAncestors.length === 0) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
    // Name and count the unit by the id the closure holds (the raw param is that id: the closure matched it exactly).
    const scope: svc.UsageScope = { kind: "unit", unitNodeId };
    const out = await withTenants([tenantId], async (c) => ({
      totals: await svc.readTotals(c, tenantId, month, scope),
      bySurface: await svc.readBySurface(c, tenantId, month, scope),
      byModel: await svc.readByModel(c, tenantId, month, scope),
      byDay: await svc.readByDay(c, tenantId, month, scope),
      ...(withPeople ? { people: await svc.readPeople(c, tenantId, month, scope) } : {}),
    }));
    return {
      month: month.month,
      unit: { unitNodeId, name: svc.unitName(facts.structure, unitNodeId) },
      ...out,
      capabilities: { canSeePeople: withPeople, canManage: d.manage, canLiftStop: d.manage || d.lift_stop } satisfies svc.Capabilities,
    };
  }

  @Get("company")
  async company(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("month") monthRaw?: unknown) {
    const principal = req.principal;
    const facts = await withTenants([tenantId], (c) => loadAiUsageFacts(c, tenantId));
    const resource = aiUsageResource(tenantId, facts);
    const d = await decide(principal, tenantId, facts);
    await authorize(principal, resource, d.read_company ? "read_company" : d.read_people ? "read_people" : "read_company");
    const month = await mapRules(() => svc.parseMonth(monthRaw));
    const scope: svc.UsageScope = { kind: "company" };
    const out = await withTenants([tenantId], async (c) => ({
      totals: await svc.readTotals(c, tenantId, month, scope),
      byDepartment: await svc.readByDepartment(c, tenantId, month, facts.structure),
      noPerson: await svc.readNoPerson(c, tenantId, month),
      byModel: await svc.readByModel(c, tenantId, month, scope),
      bySurface: await svc.readBySurface(c, tenantId, month, scope),
      byDay: await svc.readByDay(c, tenantId, month, scope),
    }));
    return {
      month: month.month,
      ...out,
      capabilities: { canSeePeople: d.read_people, canManage: d.manage, canLiftStop: d.manage } satisfies svc.Capabilities,
    };
  }
}
