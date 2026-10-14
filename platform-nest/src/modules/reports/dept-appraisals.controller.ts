// DW-4e-3 — the department appraisal per cycle (docs/FRONTEND-BFF-CONTRACT.md §41; plan
// docs/plans/2026-10-13-department-workspaces.md §5.3 and §5.5, owner ruling DW-Q4). Routes only: the reads, the writes
// and the pure aggregation are dept-appraisals.ts; the KPI engine is dept-kpi-targets.ts / dept-kpis.ts (§40).
//
//   GET /api/:t/dept-appraisals/cycles                                     — the company's cycles for the picker (no drafts)
//   GET /api/:t/dept-appraisals?cycleId=&unitNodeId=                       — the department's appraisal for a cycle
//   PUT /api/:t/dept-appraisals/:cycleId/:unitNodeId/commentary {text}     — the head's commentary (200)
//   PUT /api/:t/dept-appraisals/:cycleId/:unitNodeId/assessment {text, condition} — the GM's assessment (200)
//
// ── THE WALLS ────────────────────────────────────────────────────────────────────────────────────
//   1. Cerbos — the `dept_kpi_target` kind (cerbos/policies/resource_dept_kpi_target.yaml): the GET uses `read` (tenant-wide
//      in Cerbos, narrowed below), the commentary PUT `appraisal_comment` (company_admin, and an org_unit_lead of the unit or
//      an enclosing one through `unitAncestors`, resolved HERE from the closure, never from the body), the assessment PUT
//      `appraisal_assess` (company_admin; owner through its permission arm).
//   2. The read narrowing (below).
//   3. The tenant choke-point and the `reports` third wall, in dept-appraisals.ts.
// Plus `ModuleEnabledGuard("reports")`: 404-dark for a company without the reports module, like every reports route.
//
// ── WHO MAY READ (§41.3) ─────────────────────────────────────────────────────────────────────────
// The unit's heads (their led scope: `loadLedUnitScope`, grant- and placement-derived subtrees) and the company-wide tiers
// (personAxisTier unrestricted/company_wide, which includes HR's people-reader, plus `owner` of this company). Staff of the
// unit may NOT read it: they read the KPI page (§40.3), not the appraisal. Unlike the KPI read there is no "placed in the
// unit" branch. Order, as §37/§40: Cerbos, then the narrowing (403), then existence: an unknown unit is 404
// `unit_not_found`, an unknown cycle 404 `cycle_not_found`. So a caller who may not read a unit learns nothing about whether
// the unit or the cycle exists.
//
// ── WRITES ───────────────────────────────────────────────────────────────────────────────────────
// Order: the unit's ancestry from the closure, AUTHORIZE (403), the body (400: validation never pre-empts a 403, the DW-5a
// order), the unit's existence (404), then the cycle: unknown 404 `cycle_not_found`, `closed` 409 `cycle_closed` (decided in
// the write's own transaction). Every write records an activity row (the verb and the unit, never the text). No MCP tool
// reaches any of this.
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../../core/http";
import { withTenants } from "../../db";
import { config } from "../../config";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { resolveRange } from "./reports.controller";
import { OUT_OF_LINE_MESSAGE, loadLedUnitScope, loadOrgStructure, requiresUnitNarrowing, todayIsoInTz } from "./person-scope";
import { findOrgUnit, type OrgUnitRef } from "./dept-kpis";
import { DEPT_KPI_MODULES, companyVertical } from "./dept-kpi-targets";
import { authorizeUnitHeadRead, isCompanyWide, unitAncestorsOf } from "./dept-kpis.controller";
import {
  GM_CONDITIONS,
  MAX_TEXT,
  assembleDeptAppraisal,
  fetchCycle,
  listPickableCycles,
  writeAssessment,
  writeCommentary,
  type GmCondition,
} from "./dept-appraisals";

function requireParam(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new BadRequestException({ message: `${field} is required`, field });
  }
  return raw;
}

/** `text` is a string of 1 to MAX_TEXT characters once trimmed; the trimmed text is what is stored. */
function textOf(body: { text?: unknown } | undefined): string {
  const raw = body?.text;
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.trim().length > MAX_TEXT) {
    throw new BadRequestException({ message: `text must be 1 to ${MAX_TEXT} characters`, field: "text" });
  }
  return raw.trim();
}

@Controller("api/:tenantId/dept-appraisals")
@UseGuards(AuthGuard, ModuleEnabledGuard("reports"))
export class DeptAppraisalsController {
  // ---------------- the cycles list (§41.4) ----------------

  /**
   * The cycles the picker offers: the company's, newest first by period end, never `draft`. Company-wide metadata, so no unit.
   * Cerbos `read` (the tenant gate), then the caller must be company-wide (HR's people-reader tier included) or lead a unit
   * today (a non-empty led scope). A plain member or a unit's staff get 403: the list is for those who can read an appraisal.
   * Declared before the unit read so no path parameter can swallow it.
   */
  @Get("cycles")
  async cycles(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    const principal = req.principal;
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports" }, "read");
    if (!isCompanyWide(principal, tenantId)) {
      const asOf = todayIsoInTz(config.reportsTz);
      const leads =
        requiresUnitNarrowing(principal, tenantId) &&
        !!principal.userId &&
        (await withTenants([tenantId], (c) => loadLedUnitScope(c, tenantId, principal.userId!, asOf, principal), { modules: DEPT_KPI_MODULES })).size > 0;
      if (!leads) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
    }
    return { cycles: await listPickableCycles(tenantId) };
  }

  // ---------------- the read (§41.4) ----------------

  @Get()
  async read(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("cycleId") cycleIdRaw?: string,
    @Query("unitNodeId") unitNodeIdRaw?: string,
  ) {
    const principal = req.principal;
    const cycleId = requireParam(cycleIdRaw, "cycleId");
    const unitNodeId = requireParam(unitNodeIdRaw, "unitNodeId");

    const { unit, structure } = await this.authorizeRead(principal, tenantId, unitNodeId);
    const cycle = await fetchCycle(tenantId, cycleId);
    if (!cycle) throw new NotFoundException({ message: "cycle_not_found", field: "cycleId" });
    // The cycle as one custom range: the 400-day cap of every report range applies (422 `range_too_large`).
    const range = resolveRange("custom", cycle.periodStart, cycle.periodEnd);
    const vertical = await companyVertical(tenantId);
    return assembleDeptAppraisal(tenantId, vertical, cycle, unit, structure, range);
  }

  /** Cerbos `read` with the unit's ancestry, then the narrowing (403), then the unit's existence (404). */
  private authorizeRead(principal: Principal, tenantId: string, unitNodeId: string): Promise<{ unit: OrgUnitRef; structure: unknown }> {
    // DW-4j-3: the gate is now an exported function (dept-kpis.controller.ts), shared with the drivers read; behaviour unchanged.
    return authorizeUnitHeadRead(principal, tenantId, unitNodeId);
  }

  // ---------------- the writes (§41.4) ----------------

  @Put(":cycleId/:unitNodeId/commentary")
  @HttpCode(200)
  async commentary(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("cycleId") cycleId: string,
    @Param("unitNodeId") unitNodeId: string,
    @Body() body: { text?: unknown },
  ) {
    const userId = await this.authorizeWrite(req.principal, tenantId, unitNodeId, "appraisal_comment");
    const text = textOf(body);
    await this.assertUnitAndCycle(tenantId, cycleId, unitNodeId);
    const out = await writeCommentary(tenantId, cycleId, unitNodeId, text, userId);
    if (!out.ok) return this.refuse(out.reason);
    await writeActivity(tenantId, userId, "commented", "dept_appraisal", out.id, { cycleId, unitNodeId });
    return { hodCommentary: out.value };
  }

  @Put(":cycleId/:unitNodeId/assessment")
  @HttpCode(200)
  async assessment(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("cycleId") cycleId: string,
    @Param("unitNodeId") unitNodeId: string,
    @Body() body: { text?: unknown; condition?: unknown },
  ) {
    const userId = await this.authorizeWrite(req.principal, tenantId, unitNodeId, "appraisal_assess");
    const text = textOf(body);
    const condition = body?.condition;
    if (typeof condition !== "string" || !(GM_CONDITIONS as readonly string[]).includes(condition)) {
      throw new BadRequestException({ message: `condition must be one of ${GM_CONDITIONS.join(", ")}`, field: "condition" });
    }
    await this.assertUnitAndCycle(tenantId, cycleId, unitNodeId);
    const out = await writeAssessment(tenantId, cycleId, unitNodeId, text, condition as GmCondition, userId);
    if (!out.ok) return this.refuse(out.reason);
    await writeActivity(tenantId, userId, "assessed", "dept_appraisal", out.id, { cycleId, unitNodeId, condition });
    return { gmAssessment: out.value };
  }

  /** The unit's ancestry from the closure, then Cerbos for `action` (403), before anything else is looked at. */
  private async authorizeWrite(principal: Principal, tenantId: string, unitNodeId: string, action: "appraisal_comment" | "appraisal_assess"): Promise<string> {
    const unitAncestors = await unitAncestorsOf(tenantId, unitNodeId);
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", unitAncestors }, action);
    if (!principal.userId) throw new BadRequestException("no principal user");
    return principal.userId;
  }

  /** The unit exists in the company's org tree (404 `unit_not_found`) and the cycle is this company's (404 `cycle_not_found`). */
  private async assertUnitAndCycle(tenantId: string, cycleId: string, unitNodeId: string): Promise<void> {
    const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
    if (!findOrgUnit(structure, unitNodeId)) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
    if (!(await fetchCycle(tenantId, cycleId))) throw new NotFoundException({ message: "cycle_not_found", field: "cycleId" });
  }

  private refuse(reason: "cycle_not_found" | "cycle_closed"): never {
    if (reason === "cycle_closed") throw new ConflictException({ message: "cycle_closed" });
    throw new NotFoundException({ message: "cycle_not_found", field: "cycleId" });
  }
}
