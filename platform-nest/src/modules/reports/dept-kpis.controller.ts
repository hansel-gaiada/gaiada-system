// DW-4e-1 — department KPIs: targets, condition and standing (docs/FRONTEND-BFF-CONTRACT.md §40; plan
// docs/plans/2026-10-13-department-workspaces.md §5.5, owner ruling DW-Q4). Routes only: the catalogue and the
// condition rules are dept-kpis.ts, reads and writes are dept-kpi-targets.ts.
//
//   GET  /api/:t/dept-kpis?unitNodeId=&periodKind&start[&end]   — one unit's KPIs and condition (§40.3)
//   GET  /api/:t/dept-kpis/overview?periodKind&start[&end]      — every department by condition (company-wide tiers)
//   GET  /api/:t/dept-kpis/targets?unitNodeId=                  — each KPI's in-force row, open proposals, history
//   POST /api/:t/dept-kpis/targets                              — the head proposes (201)
//   POST /api/:t/dept-kpis/targets/:id/approve | /reject        — the approver decides (200)
//
// ── THE WALLS ────────────────────────────────────────────────────────────────────────────────────
//   1. Cerbos — `dept_kpi_target` (cerbos/policies/resource_dept_kpi_target.yaml). `read` is tenant-wide in Cerbos;
//      `propose` is company_admin plus org_unit_lead over the unit (`unitAncestors`, resolved HERE from the closure,
//      never from the body); `approve`/`reject` are company_admin (owner through its permission arm).
//   2. The unit narrowing on reads (below) — Cerbos cannot read placements, so the handler applies it.
//   3. The tenant choke-point and the `reports` third wall, in dept-kpi-targets.ts.
// Plus `ModuleEnabledGuard("reports")`: the surface is 404-dark for a company without the reports module, the same as
// every other reports route.
//
// ── WHO MAY READ A UNIT (§40.3) ──────────────────────────────────────────────────────────────────
// The people placed in the unit (the staff's "quiet strip"), its heads, and the company-wide tiers. Anyone else gets
// 403: a department's KPIs are never shown to another department's staff (§5.5, no league table for staff).
//   - placed:  the caller's primary unit TODAY (REPORTS_TZ) is in the unit's subtree (a division's staff see their
//              department; never the reverse). Today, not the range end: the TR-25 rule, so choosing a past range
//              cannot widen what someone sees.
//   - a head:  a caller in the `unit_scoped` person-axis tier (an org_unit_lead grant, or a lead's company-wide
//              `manager`) whose led scope (`loadLedUnitScope`, grant- and placement-derived subtrees) holds the unit.
//   - company-wide: `personAxisTier` unrestricted or company_wide (platform_admin, company_admin, the HR tiers, the
//              served reports tiers), plus `owner` of this company: owner mirrors company_admin (§40.2) but is
//              deliberately absent from personAxisTier (person-scope.ts), so it is named here.
// Order, as §37 and §38: Cerbos, then the narrowing (403), then existence (404 `unit_not_found`). So a caller who may
// not read a unit learns nothing about whether it exists.
//
// ── PROPOSE / APPROVE / REJECT ORDER ────────────────────────────────────────────────────────────
// Propose: resolve the unit's ancestry, AUTHORIZE, and only then validate the body (validation never pre-empts a 403:
// the DW-5a order), then existence (404) and KPI membership (400). Approve: Cerbos `read` (a tenant gate before any
// row is looked up), then the row (404), then "never your own proposal" (409 `cannot_approve_own_proposal`), then
// Cerbos `approve` with the row's unit ancestry (403), then the decision under the family lock (409 `not_proposed`).
// The self-check precedes the approve check on purpose: §40's proof has the head who proposed meet the 409, and a
// proposer is refused whoever they are. Reject has no self-check (withdrawing one's own proposal harms nothing).
// Every proposal and decision writes an activity row. No MCP tool reaches any of this (none is registered).
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
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../../core/http";
import { withTenants } from "../../db";
import { config } from "../../config";
import { loadUnitAncestors } from "../../core/org-unit-closure";
import { isUuidShaped } from "../../core/dept-resolution";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { resolveRange } from "./reports.controller";
import {
  OUT_OF_LINE_MESSAGE,
  collectUnitSubtree,
  loadLedUnitScope,
  loadOrgStructure,
  personAxisTier,
  requiresUnitNarrowing,
  resolveSubjectUnit,
  todayIsoInTz,
} from "./person-scope";
import { compareByConditionThenName, departmentUnits, findOrgUnit, kpiDefFor, workspaceSlugFor, type OrgUnitRef } from "./dept-kpis";
import {
  DEPT_KPI_MODULES,
  assembleTargetsView,
  companyVertical,
  decideTarget,
  evaluateUnits,
  fetchTarget,
  insertProposal,
  listUnitTargets,
} from "./dept-kpi-targets";

const MONTH_START_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const MAX_NOTE = 2000;

/** The company-wide tiers of this surface (see the header): personAxisTier's two top tiers, plus `owner` of this
 *  company. Reads only `principal.roles` (server-assembled at auth time), never request input. */
export function isCompanyWide(principal: Principal, tenantId: string): boolean {
  const tier = personAxisTier(principal, tenantId);
  if (tier === "unrestricted" || tier === "company_wide") return true;
  return principal.roles.some((g) => g.role === "owner" && g.scopeType === "company" && g.scopeId === tenantId);
}

function requireUnitParam(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new BadRequestException({ message: "unitNodeId is required", field: "unitNodeId" });
  }
  return raw;
}

export async function unitAncestorsOf(tenantId: string, unitNodeId: string): Promise<string[]> {
  if (!unitNodeId) return [];
  return withTenants([tenantId], (c) => loadUnitAncestors(c, tenantId, unitNodeId), { modules: DEPT_KPI_MODULES });
}

/**
 * The read gate for one unit (KPIs, targets and, from DW-4j, the unit's alerts): Cerbos `read` with the unit's ancestry, then
 * the unit narrowing (403), then existence (404). Returns the unit's node, the company's org tree being read once for both
 * checks. Exported so the watch controller (dept-kpi-watch.controller.ts) applies this exact gate, never a copy of it.
 */
export async function authorizeUnitRead(principal: Principal, tenantId: string, unitNodeId: string): Promise<{ unit: OrgUnitRef; structure: unknown }> {
  const unitAncestors = await unitAncestorsOf(tenantId, unitNodeId);
  await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", unitAncestors }, "read");
  const companyWide = isCompanyWide(principal, tenantId);
  const asOf = todayIsoInTz(config.reportsTz);
  return withTenants(
    [tenantId],
    async (c) => {
      const structure = await loadOrgStructure(c, tenantId);
      if (!companyWide) {
        const own = principal.userId ? await resolveSubjectUnit(c, tenantId, principal.userId, asOf) : null;
        const placed = !!own && collectUnitSubtree(structure, unitNodeId).includes(own);
        const leads =
          !placed &&
          requiresUnitNarrowing(principal, tenantId) &&
          (await loadLedUnitScope(c, tenantId, principal.userId, asOf, principal)).has(unitNodeId);
        if (!placed && !leads) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
      }
      const unit = findOrgUnit(structure, unitNodeId);
      if (!unit) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
      return { unit, structure };
    },
    { modules: DEPT_KPI_MODULES },
  );
}

/**
 * The HEAD-ONLY read gate for one unit (DW-4e-3's department appraisal, §41.3; DW-4j-3's "behind the miss" drivers, §43.8,
 * PERMISSION-CONTRACT §38b): Cerbos `read` with the unit's ancestry, then the narrowing (403), then existence (404). Unlike
 * `authorizeUnitRead` there is NO placed-staff branch: a unit's staff get 403 `outside your reporting line`. Only the
 * company-wide tiers (`isCompanyWide`) and a caller whose led scope (`loadLedUnitScope`) holds the unit pass. Extracted from
 * the appraisal controller, which now calls this exact function, so the two surfaces cannot drift apart.
 */
export async function authorizeUnitHeadRead(principal: Principal, tenantId: string, unitNodeId: string): Promise<{ unit: OrgUnitRef; structure: unknown }> {
  const unitAncestors = await unitAncestorsOf(tenantId, unitNodeId);
  await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", unitAncestors }, "read");
  const companyWide = isCompanyWide(principal, tenantId);
  const asOf = todayIsoInTz(config.reportsTz);
  return withTenants(
    [tenantId],
    async (c) => {
      const structure = await loadOrgStructure(c, tenantId);
      if (!companyWide) {
        const leads =
          requiresUnitNarrowing(principal, tenantId) &&
          !!principal.userId &&
          (await loadLedUnitScope(c, tenantId, principal.userId, asOf, principal)).has(unitNodeId);
        if (!leads) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
      }
      const unit = findOrgUnit(structure, unitNodeId);
      if (!unit) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
      return { unit, structure };
    },
    { modules: DEPT_KPI_MODULES },
  );
}

@Controller("api/:tenantId/dept-kpis")
@UseGuards(AuthGuard, ModuleEnabledGuard("reports"))
export class DeptKpisController {
  private authorizeUnitRead(principal: Principal, tenantId: string, unitNodeId: string): Promise<{ unit: OrgUnitRef; structure: unknown }> {
    return authorizeUnitRead(principal, tenantId, unitNodeId);
  }

  // ---------------- reads (§40.3) ----------------

  @Get()
  async unitKpis(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("unitNodeId") unitNodeIdRaw?: string,
    @Query("periodKind") periodKindRaw?: string,
    @Query("start") start?: string,
    @Query("end") end?: string,
  ) {
    const unitNodeId = requireUnitParam(unitNodeIdRaw);
    const range = resolveRange(periodKindRaw, start, end);
    const { unit, structure } = await this.authorizeUnitRead(req.principal, tenantId, unitNodeId);
    const vertical = await companyVertical(tenantId);
    const [read] = await evaluateUnits(tenantId, vertical, [unit], departmentUnits(structure), range);
    return { unit: read.unit, workspace: read.workspace, period: range, condition: read.condition, kpis: read.kpis };
  }

  /** Standing (GM and HR only): every department of the company with its condition, worst first, then by name. */
  @Get("overview")
  async overview(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("periodKind") periodKindRaw?: string,
    @Query("start") start?: string,
    @Query("end") end?: string,
  ) {
    const range = resolveRange(periodKindRaw, start, end);
    await authorize(req.principal, { kind: "dept_kpi_target", tenantId, module: "reports" }, "read");
    if (!isCompanyWide(req.principal, tenantId)) {
      throw new ForbiddenException("the departments' standing is for the company-wide tiers only");
    }
    const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
    const departments = departmentUnits(structure);
    const vertical = await companyVertical(tenantId);
    const reads = await evaluateUnits(tenantId, vertical, departments, departments, range);
    return { period: range, departments: reads.sort(compareByConditionThenName) };
  }

  // ---------------- targets (§40.2) ----------------

  @Get("targets")
  async listTargets(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("unitNodeId") unitNodeIdRaw?: string) {
    const unitNodeId = requireUnitParam(unitNodeIdRaw);
    const { unit } = await this.authorizeUnitRead(req.principal, tenantId, unitNodeId);
    const vertical = await companyVertical(tenantId);
    const asOf = `${todayIsoInTz(config.reportsTz).slice(0, 7)}-01`;
    return assembleTargetsView(unit, workspaceSlugFor(vertical, unit.name), asOf, await listUnitTargets(tenantId, unit.id));
  }

  @Post("targets")
  @HttpCode(201)
  async propose(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() rawBody: { unitNodeId?: unknown; kpiKey?: unknown; effectiveFrom?: unknown; target?: unknown; tolerance?: unknown; note?: unknown },
  ) {
    const principal = req.principal;
    const body = rawBody ?? {};
    const unitNodeId = typeof body.unitNodeId === "string" ? body.unitNodeId : "";
    // (1) the unit's ancestry from the closure, (2) authorize — before any body validation.
    const unitAncestors = await unitAncestorsOf(tenantId, unitNodeId);
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", unitAncestors }, "propose");
    if (!principal.userId) throw new BadRequestException("no principal user");

    // (3) the body.
    if (!unitNodeId.trim()) throw new BadRequestException({ message: "unitNodeId is required", field: "unitNodeId" });
    const kpiKey = typeof body.kpiKey === "string" ? body.kpiKey : "";
    if (!kpiKey) throw new BadRequestException({ message: "kpiKey is required", field: "kpiKey" });
    const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : "";
    if (!MONTH_START_RE.test(effectiveFrom)) {
      throw new BadRequestException({ message: "effectiveFrom must be the first day of a month (YYYY-MM-01)", field: "effectiveFrom" });
    }
    const target = body.target;
    if (typeof target !== "number" || !Number.isFinite(target)) throw new BadRequestException({ message: "target must be a number", field: "target" });
    const tolerance = body.tolerance;
    if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) {
      throw new BadRequestException({ message: "tolerance must be a number of at least 0", field: "tolerance" });
    }
    let note: string | null = null;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== "string" || body.note.length > MAX_NOTE) {
        throw new BadRequestException({ message: `note must be a string of at most ${MAX_NOTE} characters`, field: "note" });
      }
      note = body.note.trim() || null;
    }

    // (4) the unit exists, and the KPI is one of its workspace's set.
    const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
    const unit = findOrgUnit(structure, unitNodeId);
    if (!unit) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
    const workspace = workspaceSlugFor(await companyVertical(tenantId), unit.name);
    const def = kpiDefFor(workspace, kpiKey);
    if (!def) throw new BadRequestException({ message: `kpiKey is not a KPI of this unit's workspace (${workspace})`, field: "kpiKey" });
    if (def.unit === "percent" && (target < 0 || target > 1 || tolerance > 1)) {
      throw new BadRequestException({ message: "a percent target and tolerance are fractions between 0 and 1 (0.85 = 85%)", field: "target" });
    }
    if (def.unit !== "percent" && target < 0) throw new BadRequestException({ message: "target must not be negative", field: "target" });

    const row = await insertProposal(tenantId, { unitNodeId, kpiKey, effectiveFrom, target, tolerance, note }, principal.userId);
    await writeActivity(tenantId, principal.userId, "proposed", "dept_kpi_target", row.id, {
      unitNodeId, kpiKey, effectiveFrom, target, tolerance, ...(note ? { note } : {}),
    });
    return { id: row.id, status: row.status };
  }

  @Post("targets/:id/approve")
  @HttpCode(200)
  async approve(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { note?: unknown }) {
    return this.decide(req.principal, tenantId, id, "approve", body?.note);
  }

  @Post("targets/:id/reject")
  @HttpCode(200)
  async reject(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { note?: unknown }) {
    return this.decide(req.principal, tenantId, id, "reject", body?.note);
  }

  private async decide(principal: Principal, tenantId: string, id: string, decision: "approve" | "reject", noteRaw: unknown) {
    // A tenant gate before any row is looked up: a caller outside the company learns nothing from 404 vs 409.
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports" }, "read");
    if (!principal.userId) throw new BadRequestException("no principal user");
    if (noteRaw !== undefined && noteRaw !== null && (typeof noteRaw !== "string" || noteRaw.length > MAX_NOTE)) {
      throw new BadRequestException({ message: `note must be a string of at most ${MAX_NOTE} characters`, field: "note" });
    }
    const note = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null;

    const existing = isUuidShaped(id) ? await fetchTarget(tenantId, id) : null;
    if (!existing) throw new NotFoundException("target not found");
    if (decision === "approve" && existing.proposedBy === principal.userId) {
      throw new ConflictException({ message: "cannot_approve_own_proposal" });
    }
    const unitAncestors = await unitAncestorsOf(tenantId, existing.unitNodeId);
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", id, unitAncestors }, decision);

    const outcome = await decideTarget(tenantId, id, decision, principal.userId);
    if (!outcome.ok) {
      if (outcome.reason === "not_found") throw new NotFoundException("target not found");
      throw new ConflictException({ message: "not_proposed" });
    }
    await writeActivity(tenantId, principal.userId, decision === "approve" ? "approved" : "rejected", "dept_kpi_target", id, {
      unitNodeId: outcome.row.unitNodeId,
      kpiKey: outcome.row.kpiKey,
      effectiveFrom: outcome.row.effectiveFrom,
      ...(outcome.superseded.length ? { superseded: outcome.superseded } : {}),
      ...(note ? { note } : {}),
    });
    return { ...outcome.row, superseded: outcome.superseded };
  }
}
