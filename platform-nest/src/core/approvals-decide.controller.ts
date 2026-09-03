// WSUX-2 (UX-2 daily-work spec, contract §9a) — `POST /api/:tenantId/approvals/:id/decide`: the
// unified decide façade. A THIN dispatcher over the three EXISTING per-origin decide handlers —
// agency (`AgencyController.decide`), pipeline (`PipelineController.decideGate`), and
// automation/agent/hr (`AutomationApprovalsController.decide`). It does not reimplement any
// origin's decision rules or authorization: it calls the origin's own controller method directly
// (same class, same code path WSUX-1's read documents), so the SAME authorize()/Cerbos check, the
// SAME SQL transition, and the SAME outbox event (`agency approval status update`,
// `pipeline.gate.decided`, `automation_approval.decided`) fire exactly as they do from the native
// endpoint. This file's only two jobs:
//   1. Validate `origin` is one of WSUX-1's taxonomy (agency|pipeline|hr|automation|agent) — 400
//      otherwise (never silently default to a guess).
//   2. For `agency` — the one module-gated origin — replicate the SAME
//      `ModuleEnabledGuard("agency")` check the native route enforces via Nest's guard chain.
//      Calling the origin controller's method directly (a plain function call, not a fresh HTTP
//      round-trip through Nest's routing) bypasses that class-level guard, so skipping this check
//      here would be a widening (agency approvals decidable through the façade even when the
//      tenant has the module disabled, when they're not decidable through the native route). No
//      other origin here is module-gated, so no other origin needs an equivalent replica.
// D-UX-2 guardrail: the façade introduces NO new authorization model and NO new widened scope —
// it is a per-tenant, per-id delegate, never a fan-out, so there is nothing here for the A1
// withTenants() lint to flag.
import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { isModuleEnabled } from "../modules/registry";
import { AgencyController } from "../modules/agency/agency.controller";
import { PipelineController } from "./pipeline.controller";
import { AutomationApprovalsController } from "./automation-approvals.controller";
import type { ApprovalOrigin } from "./approvals-urgency";

// `search` (probe consent, 2026-09-03) rides the automation_approvals branch below: it is an
// `automation_approvals` row like automation/agent/hr, so the same controller decides it, and that
// controller applies the probe-consent authority gate. Listing it here is not cosmetic — the guard
// above 400s any origin absent from this array, so without it the inbox can SHOW the request and
// then refuse every attempt to decide it.
const ORIGINS: ApprovalOrigin[] = ["agency", "pipeline", "hr", "automation", "agent", "search"];

// None of the three origin controllers take constructor dependencies (their helpers — withTenants,
// authorize, writeActivity, notify, emitEvent, config — are module-level imports, not injected), so
// a plain `new` here is a faithful stand-in for Nest's own instance: identical method bodies,
// identical behaviour, zero reimplementation.
const agencyController = new AgencyController();
const pipelineController = new PipelineController();
const automationApprovalsController = new AutomationApprovalsController();

@Controller("api")
@UseGuards(AuthGuard)
export class ApprovalsDecideController {
  @Post(":tenantId/approvals/:id/decide")
  @HttpCode(200)
  async decide(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { origin?: string; decision?: string; note?: string },
  ): Promise<{ ok: true }> {
    const { origin, decision, note } = body ?? {};
    if (!origin || !ORIGINS.includes(origin as ApprovalOrigin)) {
      throw new BadRequestException(`origin must be one of ${ORIGINS.join(",")}`);
    }

    switch (origin as ApprovalOrigin) {
      case "agency": {
        // Replica of ModuleEnabledGuard("agency") — see file header. Same NotFoundException shape
        // the native route's guard throws, so a disabled-module tenant sees identical behaviour
        // through either path.
        if (!(await isModuleEnabled(tenantId, "agency"))) {
          throw new NotFoundException("module agency not enabled for this company");
        }
        await agencyController.decide(req, tenantId, id, { decision: decision as "approved" | "rejected" });
        break;
      }
      case "pipeline": {
        await pipelineController.decideGate(req, tenantId, id, { decision, note });
        break;
      }
      case "automation":
      case "agent":
      case "hr":
      case "search": {
        // automation-approvals.controller.ts's own decide() re-derives the row's REAL origin from
        // the DB before authorizing (WSD-4) — so whichever of these four the caller believes the
        // item is, the underlying handler still authorizes against the row's true origin. The
        // façade's job is only to route "this id lives in automation_approvals" to the right
        // controller, not to pre-judge which of the sub-origins it is. That property is what makes
        // adding `search` here safe: a caller cannot claim `automation` to dodge the probe-consent
        // property gate, because the gate is chosen from the stored row, not from this body.
        await automationApprovalsController.decide(req, tenantId, id, { decision: decision as "approved" | "rejected" });
        break;
      }
    }

    return { ok: true };
  }
}
