// DW-4e-1 — department KPIs: targets, condition and standing (docs/FRONTEND-BFF-CONTRACT.md §40; plan
// docs/plans/2026-10-13-department-workspaces.md §5.5, owner ruling DW-Q4). Routes only: the catalogue and the
// condition rules are dept-kpis.ts, reads and writes are dept-kpi-targets.ts.
//
//   GET  /api/:t/dept-kpis?unitNodeId=&periodKind&start[&end]   — one unit's KPIs and condition (§40.3)
//   GET  /api/:t/dept-kpis/overview?periodKind&start[&end]      — every department by condition (company-wide tiers)
//   GET  /api/:t/dept-kpis/targets?unitNodeId=                  — each KPI's in-force row, open proposals, history
//   POST /api/:t/dept-kpis/targets                              — the head proposes (201)
//   POST /api/:t/dept-kpis/targets/:id/approve | /reject        — the approver decides (200)
//   GET  /api/:t/dept-kpis/months?unitNodeId=&from=&to=         — DW-10b: the unit's KPIs month by month (§58.1)
//   POST /api/:t/dept-kpis/targets/batch                        — DW-10b: the head proposes up to 36 targets at once (201, §58.2)
//   POST /api/:t/dept-kpis/targets/decide-batch                 — DW-10b: the approver decides up to 36 at once (200, §58.3)
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
//   - a head:  DW-10g (`callerReachesUnit` -> `loadHeadUnits`): the company's own lead seats, and the placement-derived
//              path for a `manager` anchored on this company; never the tenantless `org_unit_lead` grant. DW-10g-2:
//              `authorizeUnitHeadRead` below reads the same company-anchored scope (`loadLedUnitScope(..., principal)`).
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
  HttpException,
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
import { callerReachesUnit, isCompanyWide } from "../../core/unit-reach";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { resolveRange } from "./reports.controller";
import {
  OUT_OF_LINE_MESSAGE,
  loadLedUnitScope,
  loadOrgStructure,
  requiresUnitNarrowing,
  todayIsoInTz,
} from "./person-scope";
import { compareByConditionThenName, departmentUnits, findOrgUnit, workspaceSlugFor, type OrgUnitRef } from "./dept-kpis";
import {
  DEPT_KPI_MODULES,
  assembleTargetsView,
  companyVertical,
  decideTarget,
  decideTargetsAtomically,
  evaluateUnits,
  fetchTarget,
  insertProposal,
  insertProposals,
  listUnitTargets,
  type TargetRow,
  type UnitKpis,
} from "./dept-kpi-targets";
import {
  FieldError,
  MAX_NOTE,
  assembleSeries,
  checkProposalAgainstWorkspace,
  decisionOrder,
  monthWindow,
  parseBatchItems,
  parseDecideBatchBody,
  parseProposalShape,
  validateBatchItems,
} from "./dept-kpi-batch";

/** A FieldError is a 400 that names its input (`{message, field}`: the error filter puts `field` beside `error`). */
function badRequest(err: unknown): never {
  if (err instanceof FieldError) throw new BadRequestException({ message: err.message, field: err.field });
  throw err;
}

/** A 403 from Cerbos, with the row that stopped a batch beside it (`failedId`, §58.3). Everything else it said is kept. */
function forbiddenFor(err: HttpException, failedId: string): ForbiddenException {
  const res = err.getResponse();
  return new ForbiddenException({ ...(typeof res === "string" ? { message: res } : (res as object)), failedId });
}

// DW-10a: `isCompanyWide` and the "placed, leads, or company-wide" predicate moved to core/unit-reach.ts, which the notice board
// shares. Re-exported so the appraisal and watch controllers keep importing it from here.
export { isCompanyWide };

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
  const asOf = todayIsoInTz(config.reportsTz);
  return withTenants(
    [tenantId],
    async (c) => {
      const structure = await loadOrgStructure(c, tenantId);
      if (!(await callerReachesUnit(c, principal, tenantId, structure, unitNodeId, asOf))) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
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

  /**
   * DW-10b (§58.1): one unit's KPIs month by month, oldest first. The read gate is `GET /dept-kpis`' own (the shared
   * `authorizeUnitRead`); the window is checked AFTER it, so a caller who may not read the unit gets 403 whatever the window.
   * Each month is one `evaluateUnits` call judged against the target in force at that month's start, and the months run one
   * after another, never together: one request must not fan the readers out across a year on the 2-vCPU box.
   */
  @Get("months")
  async months(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("unitNodeId") unitNodeIdRaw?: string,
    @Query("from") fromRaw?: string,
    @Query("to") toRaw?: string,
  ) {
    const unitNodeId = requireUnitParam(unitNodeIdRaw);
    const { unit, structure } = await this.authorizeUnitRead(req.principal, tenantId, unitNodeId);
    const today = todayIsoInTz(config.reportsTz);
    let slots;
    try {
      slots = monthWindow(fromRaw, toRaw, today);
    } catch (err) {
      return badRequest(err);
    }
    const vertical = await companyVertical(tenantId);
    const departments = departmentUnits(structure);
    const perMonth: UnitKpis[] = [];
    for (const slot of slots) {
      const [read] = await evaluateUnits(tenantId, vertical, [unit], departments, { periodKind: "month", start: slot.start, end: slot.end }, slot.start, today);
      perMonth.push(read);
    }
    return assembleSeries(unit, perMonth[0].workspace, slots, perMonth);
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
    let shape;
    try {
      shape = parseProposalShape(body as Record<string, unknown>);
    } catch (err) {
      return badRequest(err);
    }
    const { kpiKey, effectiveFrom, target, tolerance, note } = shape;

    // (4) the unit exists, and the KPI is one of its workspace's set.
    const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
    const unit = findOrgUnit(structure, unitNodeId);
    if (!unit) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });
    const workspace = workspaceSlugFor(await companyVertical(tenantId), unit.name);
    try {
      checkProposalAgainstWorkspace(workspace, { kpiKey, target, tolerance });
    } catch (err) {
      return badRequest(err);
    }

    const row = await insertProposal(tenantId, { unitNodeId, kpiKey, effectiveFrom, target, tolerance, note }, principal.userId);
    await writeActivity(tenantId, principal.userId, "proposed", "dept_kpi_target", row.id, {
      unitNodeId, kpiKey, effectiveFrom, target, tolerance, ...(note ? { note } : {}),
    });
    return { id: row.id, status: row.status };
  }

  /**
   * DW-10b (§58.2): the head proposes up to 36 targets for one unit in one request. The single propose's order, with the
   * authorization ONCE before any item is looked at: the unit's ancestry, Cerbos `propose`, then the body (each item exactly
   * as a single proposal, the first invalid one naming its index), then the unit's existence. All proposals are inserted in one
   * transaction, or none; each writes its own `proposed` activity row.
   */
  @Post("targets/batch")
  @HttpCode(201)
  async proposeBatch(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() rawBody: { unitNodeId?: unknown; items?: unknown }) {
    const principal = req.principal;
    const body = rawBody ?? {};
    const unitNodeId = typeof body.unitNodeId === "string" ? body.unitNodeId : "";
    // (1) the unit's ancestry from the closure, (2) authorize: before any body validation.
    const unitAncestors = await unitAncestorsOf(tenantId, unitNodeId);
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", unitAncestors }, "propose");
    if (!principal.userId) throw new BadRequestException("no principal user");

    // (3) the body: the unit, the list, then each item in order.
    if (!unitNodeId.trim()) throw new BadRequestException({ message: "unitNodeId is required", field: "unitNodeId" });
    let items: unknown[];
    try {
      items = parseBatchItems(body.items);
    } catch (err) {
      return badRequest(err);
    }
    // The unit is looked up BEFORE the items are judged, because "a KPI of the unit's workspace" needs its name; its absence
    // is only answered (404) once every item's shape is sound, the single propose's order (shape, unit, workspace).
    const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
    const unit = findOrgUnit(structure, unitNodeId);
    const workspace = unit ? workspaceSlugFor(await companyVertical(tenantId), unit.name) : null;
    let proposals;
    try {
      proposals = validateBatchItems(items, workspace);
    } catch (err) {
      return badRequest(err);
    }
    if (!unit) throw new NotFoundException({ message: "unit_not_found", field: "unitNodeId" });

    const rows = await insertProposals(tenantId, proposals.map((p) => ({ unitNodeId, ...p })), principal.userId);
    for (const [i, row] of rows.entries()) {
      const p = proposals[i];
      await writeActivity(tenantId, principal.userId, "proposed", "dept_kpi_target", row.id, {
        unitNodeId, kpiKey: p.kpiKey, effectiveFrom: p.effectiveFrom, target: p.target, tolerance: p.tolerance, ...(p.note ? { note: p.note } : {}),
      });
    }
    return { ids: rows.map((r) => r.id) };
  }

  /**
   * DW-10b (§58.3): the approver decides up to 36 proposals together, all or none. The tenant `read` gate runs once before any
   * row is looked up; then each id in the order given: it exists (404), it is `proposed` (409 `not_proposed`), an approval is
   * not of the caller's own proposal (409 `cannot_approve_own_proposal`), Cerbos allows `approve`/`reject` with that row's unit
   * ancestry (403). Every refusal carries `failedId`. The decisions then run in ONE transaction (`decideTargetsAtomically`).
   */
  @Post("targets/decide-batch")
  @HttpCode(200)
  async decideBatch(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() rawBody: Record<string, unknown>) {
    const principal = req.principal;
    await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports" }, "read");
    if (!principal.userId) throw new BadRequestException("no principal user");
    let parsed;
    try {
      parsed = parseDecideBatchBody(rawBody ?? {});
    } catch (err) {
      return badRequest(err);
    }
    const { decision, ids, note } = parsed;

    const rows: TargetRow[] = [];
    const ancestry = new Map<string, string[]>();
    for (const id of ids) {
      const existing = isUuidShaped(id) ? await fetchTarget(tenantId, id) : null;
      if (!existing) throw new NotFoundException({ message: "target not found", failedId: id });
      if (existing.status !== "proposed") throw new ConflictException({ message: "not_proposed", failedId: id });
      if (decision === "approve" && existing.proposedBy === principal.userId) {
        throw new ConflictException({ message: "cannot_approve_own_proposal", failedId: id });
      }
      let unitAncestors = ancestry.get(existing.unitNodeId);
      if (!unitAncestors) {
        unitAncestors = await unitAncestorsOf(tenantId, existing.unitNodeId);
        ancestry.set(existing.unitNodeId, unitAncestors);
      }
      try {
        await authorize(principal, { kind: "dept_kpi_target", tenantId, module: "reports", id, unitAncestors }, decision);
      } catch (err) {
        throw err instanceof ForbiddenException ? forbiddenFor(err, id) : err;
      }
      rows.push(existing);
    }

    const result = await decideTargetsAtomically(tenantId, decisionOrder(rows).map((r) => r.id), decision, principal.userId);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException({ message: "target not found", failedId: result.failedId });
      throw new ConflictException({ message: "not_proposed", failedId: result.failedId });
    }
    const decided: Array<{ id: string; status: TargetRow["status"]; superseded: string[] }> = [];
    for (const id of ids) {
      const { row, superseded } = result.outcomes.get(id)!;
      await writeActivity(tenantId, principal.userId, decision === "approve" ? "approved" : "rejected", "dept_kpi_target", id, {
        unitNodeId: row.unitNodeId,
        kpiKey: row.kpiKey,
        effectiveFrom: row.effectiveFrom,
        ...(superseded.length ? { superseded } : {}),
        ...(note ? { note } : {}),
      });
      decided.push({ id, status: row.status, superseded });
    }
    return { decided };
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
