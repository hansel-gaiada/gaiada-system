// DW-4j-1 — the head is made aware (docs/FRONTEND-BFF-CONTRACT.md §43; PERMISSION-CONTRACT §38b). Routes only: the run, the
// change rule and the alert reads and writes are dept-kpi-watch.ts; the KPI engine is dept-kpi-targets.ts / dept-kpis.ts (§40).
//
//   POST /api/:t/dept-kpis/watch                        — the scheduled run (n8n, daily): evaluate, tell, open and resolve alerts
//   GET  /api/:t/dept-kpis/alerts[?unitNodeId=]         — the caller's open, unacknowledged alerts (Needs you), or one unit's history
//   POST /api/:t/dept-kpis/alerts/:id/acknowledge {note?} — a head records that they saw the alert (200)
//
// ── THE WALLS ────────────────────────────────────────────────────────────────────────────────────
//   1. Cerbos. The run: `report_admin` · `recompute`, the action `POST /reports/facts/recompute` uses (company_admin and
//      platform_admin; the n8n account `wf:reports-kpi-watch` holds company_admin). The reads and the acknowledgement:
//      `dept_kpi_target` · `read` (tenant-wide in Cerbos). No new kind and no new action.
//   2. The handler's narrowing, which Cerbos cannot express. The unit-scoped read is the §40.3a unit read gate (the SAME
//      function the KPI controller calls: `authorizeUnitRead`). The acknowledgement is narrowed to a head of the alert's unit
//      (§43.1's rule: an exact-node, current `org_unit_lead` grant) or the company-wide tier (`isCompanyWide`).
//   3. The tenant choke-point and the `reports` third wall, in dept-kpi-watch.ts.
// Plus `ModuleEnabledGuard("reports")`: 404-dark for a company without the reports module.
//
// ── ORDER OF CHECKS (acknowledge) ────────────────────────────────────────────────────────────────
// Cerbos `read` on the tenant (403), then the alert (404 `alert_not_found`, a malformed id is the same 404), then Cerbos
// `read` with the alert's unit ancestry and the narrowing (403), then the state (409 `resolved`, 409 `already_acknowledged`),
// and only then the body (400 `field: "note"`). So validation never pre-empts a 403 or a 409.
//
// ── THE NEEDS-YOU READ ───────────────────────────────────────────────────────────────────────────
// Without `unitNodeId` the list is personal: the alerts of the units the CALLER heads, and nobody else's. A company-wide
// caller who heads no unit gets 200 `{alerts: []}`, which is true: they have none.
//
// Declared in a controller of its own so the KPI controller's routes are untouched; its `:param` routes (`targets/:id/...`)
// are POSTs under a different literal, so nothing here can be swallowed by them.
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../../core/http";
import { withTenants } from "../../db";
import { isUuidShaped } from "../../core/dept-resolution";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { OUT_OF_LINE_MESSAGE, loadOrgStructure } from "./person-scope";
import { DEPT_KPI_MODULES } from "./dept-kpi-targets";
import { authorizeUnitRead, isCompanyWide, unitAncestorsOf } from "./dept-kpis.controller";
import {
  MAX_ACK_NOTE,
  acknowledgeAlert,
  fetchAlertHead,
  listOpenUnacknowledgedAlerts,
  listUnitAlerts,
  loadUnitLeadUserIds,
  loadUnitsLedExactly,
  runDeptKpiWatch,
} from "./dept-kpi-watch";

@Controller("api/:tenantId/dept-kpis")
@UseGuards(AuthGuard, ModuleEnabledGuard("reports"))
export class DeptKpiWatchController {
  // ---------------- the run (§43.6) ----------------

  /** The scheduled run. Two runs in a row: the second tells nothing. The route takes no body and no date: the period is
   *  always the current month in REPORTS_TZ (the service's `now` is for tests only). */
  @Post("watch")
  @HttpCode(200)
  async watch(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "report_admin", tenantId }, "recompute");
    return runDeptKpiWatch(tenantId);
  }

  // ---------------- the alerts read (§43.5) ----------------

  @Get("alerts")
  async alerts(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("unitNodeId") unitNodeIdRaw?: string) {
    const principal = req.principal;
    if (unitNodeIdRaw !== undefined) {
      if (typeof unitNodeIdRaw !== "string" || unitNodeIdRaw.trim() === "") {
        throw new BadRequestException({ message: "unitNodeId must not be empty", field: "unitNodeId" });
      }
      // One unit's whole history: the unit read gate (§40.3a), the same function the KPI controller calls.
      const { unit, structure } = await authorizeUnitRead(principal, tenantId, unitNodeIdRaw);
      return { alerts: await listUnitAlerts(tenantId, unit.id, structure) };
    }
    // Needs you: Cerbos on the tenant, then the units the caller heads.
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports" }, "read");
    const led = principal.userId ? await loadUnitsLedExactly(tenantId, principal.userId) : [];
    return { alerts: await listOpenUnacknowledgedAlerts(tenantId, led) };
  }

  // ---------------- acknowledge (§43.5) ----------------

  @Post("alerts/:id/acknowledge")
  @HttpCode(200)
  async acknowledge(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { note?: unknown }) {
    const principal = req.principal;
    // (1) a tenant gate before any row is looked up: a caller outside the company learns nothing from 404 vs 409.
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports" }, "read");
    if (!principal.userId) throw new BadRequestException("no principal user");

    // (2) the alert.
    const head = isUuidShaped(id) ? await fetchAlertHead(tenantId, id) : null;
    if (!head) throw new NotFoundException({ message: "alert_not_found", field: "id" });

    // (3) Cerbos `read` with the alert's unit ancestry (resolved from the closure, never from the request), then the
    //     narrowing: a head of that unit, or the company-wide tier.
    const unitAncestors = await unitAncestorsOf(tenantId, head.unitNodeId);
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", unitAncestors }, "read");
    if (!isCompanyWide(principal, tenantId) && !(await loadUnitLeadUserIds(tenantId, head.unitNodeId)).includes(principal.userId)) {
      throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
    }

    // (4) the state.
    if (head.resolved) throw new ConflictException({ message: "resolved" });
    if (head.acknowledged) throw new ConflictException({ message: "already_acknowledged" });

    // (5) the body.
    const noteRaw = body?.note;
    if (noteRaw !== undefined && noteRaw !== null && (typeof noteRaw !== "string" || noteRaw.length > MAX_ACK_NOTE)) {
      throw new BadRequestException({ message: `note must be a string of at most ${MAX_ACK_NOTE} characters`, field: "note" });
    }
    const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null;

    const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
    const outcome = await acknowledgeAlert(tenantId, id, principal.userId, note, structure);
    if (!outcome.ok) {
      // Lost a race since step (4): the alert was resolved or acknowledged in between.
      if (outcome.reason === "not_found") throw new NotFoundException({ message: "alert_not_found", field: "id" });
      throw new ConflictException({ message: outcome.reason });
    }
    // The activity row records who and where, never the note's text.
    await writeActivity(tenantId, principal.userId, "acknowledged", "dept_kpi_alert", id, { unitNodeId: outcome.unitNodeId, kpiKey: outcome.kpiKey });
    return outcome.alert;
  }
}
