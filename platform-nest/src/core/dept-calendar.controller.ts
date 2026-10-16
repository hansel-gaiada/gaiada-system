// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59; PERMISSION-CONTRACT §48; owner ruling DW-D33) — the department calendar:
//   GET /api/:tenantId/departments/:unitNodeId/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// Four legs (holidays, away, deadlines, events), each `{included, items}` or `{included: false, reason}`; the legs, their SQL and the
// window rule are in dept-calendar.service.ts. This file is the gate and the answer's assembly.
//
// ── THE GATE, IN THIS ORDER (§59.1) ──────────────────────────────────────────────────────────────
//   (1) Cerbos `org_structure · read_calendar` on the company (tenant-wide; a client contact and a company with the key withheld stop here),
//   (2) the window and the unit id's shape (400 naming the field; after (1), so a refused caller never learns which part was wrong),
//   (3) the unit narrowing, `callerReachesUnit` from core/unit-reach.ts (the SAME predicate `GET /dept-kpis` and the notice board use,
//       never a copy): placed in the unit's subtree today, a head whose led scope holds it, or a company-wide tier. 403
//       `outside your reporting line`,
//   (4) existence, 404 `unit_not_found` (after the narrowing, so a caller who may not read a unit learns nothing about whether it exists).
// No leg is read before the gate has passed. Authorization (an HTTP call to Cerbos) is never done inside a transaction.
//
// ── WHAT THE AWAY LEG DISCLOSES (DW-D33) ─────────────────────────────────────────────────────────
// A colleague's APPROVED leave, with its type, to anyone who passed the gate. It widens no HR route: `GET /modules/hr/leave` keeps its own
// rules and this controller never calls it.
import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { config } from "../config";
import { AuthGuard } from "../auth/guards";
import { authorize } from "./http";
import { callerReachesUnit, loadUnitReach, type UnitReach } from "./unit-reach";
import { findOrgUnit } from "../modules/reports/dept-kpis";
import { OUT_OF_LINE_MESSAGE, loadOrgStructure, todayIsoInTz } from "../modules/reports/person-scope";
import * as svc from "./dept-calendar.service";

const KIND = "org_structure";
const ACTION = "read_calendar";

@Controller("api/:tenantId/departments/:unitNodeId/calendar")
@UseGuards(AuthGuard)
export class DeptCalendarController {
  @Get()
  async calendar(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("unitNodeId") unitNodeIdRaw: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    const principal = req.principal;
    // (1) Cerbos, tenant-wide.
    await authorize(principal, { kind: KIND, tenantId }, ACTION);

    // (2) the shape of the window and of the unit id.
    let window: svc.CalendarWindow;
    let unitNodeId: string;
    try {
      window = svc.parseWindow(rawQuery ?? {});
      unitNodeId = svc.checkUnitParam(unitNodeIdRaw);
    } catch (e) {
      if (e instanceof svc.DeptCalendarRuleError) throw new BadRequestException({ message: e.message, field: e.field });
      throw e;
    }

    // (3) the unit narrowing, then (4) existence. Placement is as of TODAY in the company's report zone, never the window.
    const asOf = todayIsoInTz(config.reportsTz);
    const gate = await withTenants([tenantId], async (c) => {
      const structure = await loadOrgStructure(c, tenantId);
      if (!(await callerReachesUnit(c, principal, tenantId, structure, unitNodeId, asOf))) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
      const unit = findOrgUnit(structure, unitNodeId);
      if (!unit) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
      // The batch form of the SAME predicate, for the events leg (a unit above this one is filtered by what the caller reaches).
      const reach: UnitReach = await loadUnitReach(c, principal, tenantId, structure, asOf);
      return { unit, structure, reach };
    });

    // The four legs are independent: each isolates its own failure (`read_failed`), so they run together.
    const [holidays, away, deadlines, events] = await Promise.all([
      svc.holidaysLeg(tenantId, unitNodeId, window),
      svc.awayLeg(tenantId, unitNodeId, gate.structure, asOf, window),
      svc.deadlinesLeg(principal, tenantId, unitNodeId, window),
      svc.eventsLeg(principal, tenantId, unitNodeId, gate.reach, window),
    ]);

    return {
      unit: { id: gate.unit.id, name: gate.unit.name },
      from: window.from,
      to: window.to,
      holidays,
      away,
      deadlines,
      events,
    };
  }
}
