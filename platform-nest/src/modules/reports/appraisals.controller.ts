// TR-24 — the appraisal engine's HTTP surface (§6.2's "Appraisals" table). Thin HTTP shell, same
// house split as reports.controller.ts / checkins.controller.ts: validation + Cerbos + row-scoping
// live here; the actual generate/submit/ack/finalize/banding logic is appraisal-engine.ts's job.
//
// ─────────────────────────────── THREE WALLS (same shape as every module surface) ───────────────
//   1. Cerbos — `appraisal` resource kind (cerbos/policies/resource_appraisal.yaml). Ships the
//      tiers §8 actually names; TR-25 owns the full four-resource parity matrix. See that file's
//      own header for the exact mapping.
//   2. The tenant choke-point — every query in appraisal-engine.ts runs inside
//      `withTenants([tenantId], …)`.
//   3. Module-sliced RLS — `report_appraisal_*` sit behind the `reports` third wall (0068); every
//      call declares `{modules:['reports']}` (appraisal-engine.ts's `APPRAISAL_MODULES`).
// Plus the per-tenant `ModuleEnabledGuard("reports")` gate, same as every other reports surface.
//
// ─────────────────────────────── KNOWN CERBOS APPROXIMATION, NARROWED HERE ───────────────────────
// Cerbos's `manager`/`team_lead` derived roles are company/project-scoped, not "manager of THIS
// specific person" — the SAME gap TR-09/TR-13 already flagged for TR-25. Unlike those two
// surfaces, `report_appraisals.manager_user_id` is a REAL per-row column assigned at generate
// time, so write/submit/single-row-read here are narrowed to an EXACT
// `principal.userId === row.managerUserId` match, inline at each route below (`getOneRoute`,
// `patchRoute`, `submitRoute`) — a strictly TIGHTER in-app narrowing than the org-unit
// approximation those two files use, not a weaker one. `platform_admin` is exempt from the
// exact-match narrowing (it already holds an unconditional Cerbos wildcard everywhere else in
// this codebase).
//
// ─────────────────────────────── DELIBERATELY NOT EXPOSED OVER MCP (§9.2, standing ruling) ───────
// No route here is registered in `ModuleContract.mcpTools` (index.ts), and none ever will be —
// appraisal read/write is human-only. Nothing in this file needs an OBO/assurance carve-out
// because no MCP tool reaches it to carve out.
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
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize, notify, writeActivity } from "../../core/http";
import { withTenants } from "../../db";
import { config } from "../../config";
import { loadUnitAncestors } from "../../core/org-unit-closure";
import type { Principal } from "../../rbac/principal";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  APPRAISAL_AXES,
  MIN_COMMENTARY_LENGTH,
  ackAppraisal,
  createCycle,
  fetchAppraisalRow,
  finalizeAppraisal,
  generateCycleAppraisals,
  getCycle,
  hydrateAppraisalPack,
  isValidCommentary,
  listAppraisalRows,
  listCycles,
  patchAppraisal,
  patchCycle,
  submitAppraisal,
  type GenerateSubjectInput,
} from "./appraisal-engine";
import type { AppraisalAxis } from "./appraisal-document";
import { PERSON_SCOPE_MODULES, personAxisTier, resolveSubjectUnit, todayIsoInTz } from "./person-scope";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────── in-app tier detection (mirrors checkins.controller.ts's
// isManagerTierOnly — a small, deliberate duplication: that function is private to that file and
// the brief scopes edits to checkins.controller.ts to the TR-39 fix only, so it cannot be exported
// from there. Same reasoning, same shape.) ─────────────────────────────────────────────────────

// TR-25 CONSOLIDATION. TR-24 hand-rolled the two tier detectors below because
// `checkins.controller.ts`'s equivalent (`isManagerTierOnly`) was private to that file. All three now
// delegate to `person-scope.ts`'s `personAxisTier` — the single implementation. They HAD diverged in
// ways that mattered: this file counted `team_lead` as a coarse manager tier and the check-in one did
// not (so a `team_lead`-only principal was narrowed differently on two surfaces), and neither counted
// the reconciler-materialized served-company module grants at all.
//
// ⚠ REVIEW NOTE on `company_wide` vs finding ②: `personAxisTier` returns `company_wide` for `hr_staff`
// as well as `hr_manager`, because on the PERSON axis both HR tiers legitimately read person-grain
// reports. That does NOT re-open finding ②'s over-grant in this file, because an `hr_staff` principal
// can no longer get past CERBOS on ANY `appraisal` action — `resource_appraisal.yaml` admits only
// `hr_people_ops` (= `hr_manager` alone). Every route below calls `authorize(...)` first, so by the
// time `hasBroadAppraisalReadTier` is consulted an `hr_staff` caller has already been 403'd. Cerbos
// bounds WHICH TIER may act; these helpers only decide HOW TO NARROW inside a tier Cerbos admitted.
// Stated explicitly because "this tier check looks too broad for appraisals" is exactly the review
// comment it deserves — and the answer is that the narrowing layer is not where that bound lives.

function isPlatformAdmin(principal: Principal): boolean {
  return principal.roles.some((g) => g.role === "platform_admin" && g.scopeType === "global");
}

/** §8's "HR-appraisal role" / "Exec group" columns — the tiers this file's policy grants
 *  UNCONDITIONAL company-wide (or global) read, never narrowed to a specific manager/subject. */
function hasBroadAppraisalReadTier(principal: Principal, tenantId: string): boolean {
  const tier = personAxisTier(principal, tenantId);
  return tier === "unrestricted" || tier === "company_wide";
}

/** True when the caller's ONLY relevant grant is the coarse company/project/team-scoped
 *  `manager`/`team_lead` tier — i.e. Cerbos will have allowed `read`/`write`/`submit` on the
 *  strength of that grant alone, and this controller must narrow the rest of the way to the
 *  specific row's `manager_user_id`.
 *
 *  Kept as a NAMED wrapper rather than calling `requiresUnitNarrowing` inline, because on THIS
 *  resource the narrowing target is different: `report_appraisals.manager_user_id` is a real per-row
 *  column assigned at generate time, so this file narrows to an EXACT manager match rather than to an
 *  org-unit subtree. Same tier, strictly TIGHTER boundary — see this file's header. */
function isManagerCoarseOnly(principal: Principal, tenantId: string): boolean {
  return personAxisTier(principal, tenantId) === "unit_scoped";
}

/** HIER-2 (DR-9/DR-11) — the SUBJECT's current unit ancestor chain (IAM-09's closure), so
 *  org_unit_lead's own Cerbos rule (derived_roles.yaml, resource_appraisal.yaml) has an ancestor
 *  list to match a dept-lead grant against. Appraisal has no separate department grain the way
 *  report_document does — the "unit" this resource reasons about is the subject's OWN placement,
 *  resolved the identical way person-scope.ts resolves it elsewhere in this program. Returns `[]`
 *  when the subject has no resolvable current unit (pre-adoption history, offboarded) — fail
 *  closed by construction, same as every other consumer of `loadUnitAncestors`. */
async function subjectUnitAncestors(tenantId: string, subjectUserId: string): Promise<string[]> {
  const asOf = todayIsoInTz(config.reportsTz);
  return withTenants(
    [tenantId],
    async (c) => {
      const unit = await resolveSubjectUnit(c, tenantId, subjectUserId, asOf);
      return unit ? loadUnitAncestors(c, tenantId, unit) : [];
    },
    { modules: PERSON_SCOPE_MODULES },
  );
}

/** Does `principal` hold an `org_unit`-scoped `org_unit_lead` grant covering the subject (i.e.
 *  its scopeId appears in `unitAncestors`)? Re-derives the SAME containment Cerbos's org_unit_lead
 *  rule just evaluated to reach ALLOW — belt-and-suspenders, matching every other in-app
 *  confirmation in this program (e.g. `assertPersonInLedScope` re-checking after Cerbos already
 *  allowed). Never widens: a principal without a qualifying grant was already denied by
 *  `authorize()` above, before this is ever consulted. */
function isOrgUnitLeadForSubject(principal: Principal, unitAncestors: string[]): boolean {
  return principal.roles.some(
    (g) => g.role === "org_unit_lead" && g.scopeType === "org_unit" && !!g.scopeId && unitAncestors.includes(g.scopeId),
  );
}

function assertDate(value: string | undefined, field: string): string {
  if (!value || !DATE_RE.test(value)) throw new BadRequestException({ message: `${field} must be a YYYY-MM-DD date`, field });
  return value;
}

function assertWeights(raw: unknown, field: string): Record<AppraisalAxis, number> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) throw new BadRequestException({ message: `${field} must be an object`, field });
  const obj = raw as Record<string, unknown>;
  for (const axis of APPRAISAL_AXES) {
    if (obj[axis] !== undefined && typeof obj[axis] !== "number") {
      throw new BadRequestException({ message: `${field}.${axis} must be a number`, field });
    }
  }
  return raw as Record<AppraisalAxis, number>;
}

@Controller("api/:tenantId/appraisals")
@UseGuards(AuthGuard, ModuleEnabledGuard("reports"))
export class AppraisalsController {
  // ---------------- cycle CRUD (§6.2, HR-appraisal role only) ----------------

  @Post("cycles")
  @HttpCode(200)
  async createCycleRoute(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; periodStart?: string; periodEnd?: string; defaultWeights?: unknown; roleWeights?: Record<string, unknown> },
  ) {
    await authorize(req.principal, { kind: "appraisal", tenantId }, "cycle_admin");
    if (!req.principal.userId) throw new BadRequestException("no principal user");

    const name = body?.name?.trim();
    if (!name) throw new BadRequestException({ message: "name is required", field: "name" });
    const periodStart = assertDate(body?.periodStart, "periodStart");
    const periodEnd = assertDate(body?.periodEnd, "periodEnd");
    if (periodEnd < periodStart) throw new BadRequestException({ message: "periodEnd must be on or after periodStart", field: "periodEnd" });
    const defaultWeights = assertWeights(body?.defaultWeights, "defaultWeights");
    const roleWeights: Record<string, Record<AppraisalAxis, number>> = {};
    if (body?.roleWeights) {
      for (const [role, w] of Object.entries(body.roleWeights)) {
        roleWeights[role] = assertWeights(w, `roleWeights.${role}`) ?? (w as Record<AppraisalAxis, number>);
      }
    }

    const cycle = await createCycle(tenantId, { name, periodStart, periodEnd, defaultWeights, roleWeights: Object.keys(roleWeights).length ? roleWeights : undefined }, req.principal.userId);
    await writeActivity(tenantId, req.principal.userId, "created", "report_appraisal_cycle", cycle.id, { name, periodStart, periodEnd });
    return cycle;
  }

  @Get("cycles")
  async listCyclesRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "appraisal", tenantId }, "cycle_admin");
    return { cycles: await listCycles(tenantId) };
  }

  @Get("cycles/:id")
  async getCycleRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "appraisal", tenantId, id }, "cycle_admin");
    const cycle = await getCycle(tenantId, id);
    if (!cycle) throw new NotFoundException("cycle not found");
    return cycle;
  }

  @Patch("cycles/:id")
  async patchCycleRoute(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { name?: string; periodStart?: string; periodEnd?: string; status?: string; defaultWeights?: unknown; roleWeights?: Record<string, unknown> },
  ) {
    await authorize(req.principal, { kind: "appraisal", tenantId, id }, "cycle_admin");

    if (body?.periodStart !== undefined) assertDate(body.periodStart, "periodStart");
    if (body?.periodEnd !== undefined) assertDate(body.periodEnd, "periodEnd");
    const status = body?.status;
    if (status !== undefined && !["draft", "open", "in_review", "closed"].includes(status)) {
      throw new BadRequestException({ message: "status must be one of draft, open, in_review, closed", field: "status" });
    }
    const defaultWeights = assertWeights(body?.defaultWeights, "defaultWeights");
    let roleWeights: Record<string, Record<AppraisalAxis, number>> | undefined;
    if (body?.roleWeights) {
      roleWeights = {};
      for (const [role, w] of Object.entries(body.roleWeights)) roleWeights[role] = (assertWeights(w, `roleWeights.${role}`) ?? (w as Record<AppraisalAxis, number>));
    }

    const cycle = await patchCycle(tenantId, id, {
      name: body?.name?.trim(),
      periodStart: body?.periodStart,
      periodEnd: body?.periodEnd,
      status: status as "draft" | "open" | "in_review" | "closed" | undefined,
      defaultWeights,
      roleWeights,
    });
    if (!cycle) throw new NotFoundException("cycle not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "report_appraisal_cycle", id, { status: cycle.status });
    return cycle;
  }

  // ---------------- generate (§6.2, §0057 rule 2 / §15) ----------------

  @Post("cycles/:id/generate")
  @HttpCode(200)
  async generateRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { subjects?: unknown }) {
    await authorize(req.principal, { kind: "appraisal", tenantId, id }, "cycle_admin");

    const cycle = await getCycle(tenantId, id);
    if (!cycle) throw new NotFoundException("cycle not found");

    const rawSubjects = Array.isArray(body?.subjects) ? body.subjects : [];
    if (rawSubjects.length === 0) throw new BadRequestException({ message: "subjects must be a non-empty array of {subjectUserId, managerUserId, roleKey?}", field: "subjects" });
    const roster: GenerateSubjectInput[] = rawSubjects.map((s, i) => {
      const entry = s as { subjectUserId?: string; managerUserId?: string; roleKey?: string };
      if (!entry?.subjectUserId || !entry?.managerUserId) {
        throw new BadRequestException({ message: `subjects[${i}] requires subjectUserId and managerUserId`, field: "subjects" });
      }
      return { subjectUserId: entry.subjectUserId, managerUserId: entry.managerUserId, roleKey: entry.roleKey };
    });

    const outcome = await generateCycleAppraisals(tenantId, cycle, roster);
    if (!outcome.ok) {
      if (outcome.reason === "custom_overlap") {
        // §0057 rule 2 / §15: never a silent skip — a pinned ad-hoc range overlapping the cycle
        // window fails loud, not quiet.
        throw new UnprocessableEntityException({
          message: "an ad-hoc (custom) period overlaps this cycle's window; appraisal generation requires sealed calendar periods only",
          field: "periodEnd",
        });
      }
      // Same shared-filter constraint as above: bake the unsealed windows into the message itself
      // rather than a third JSON key, which HttpErrorFilter would silently drop.
      const unsealed = (outcome.detail as Array<{ periodStart: string; periodEnd: string; status: string }>)
        .map((p) => `${p.periodStart}..${p.periodEnd} (${p.status})`)
        .join(", ");
      throw new ConflictException({ message: `one or more calendar periods covering this cycle's window are not sealed yet: ${unsealed}`, field: "cycleId" });
    }

    await writeActivity(tenantId, req.principal.userId, "generated", "report_appraisal_cycle", id, {
      generated: outcome.result.generated.length,
      skippedExisting: outcome.result.skippedExisting.length,
    });
    for (const s of roster) {
      if (outcome.result.generated.length === 0) break;
      await notify(tenantId, s.managerUserId, req.principal.userId, "reports.appraisal.generated", {
        title: "A new appraisal is ready to score",
        href: `/appraisals?cycleId=${id}`,
        entityType: "report_appraisal_cycle",
        entityId: id,
      });
    }
    return outcome.result;
  }

  // ---------------- read: list / mine / single ----------------

  // ⚠ HIER-2 BOUNDARY, stated rather than silently missed: this endpoint's `managerCoarse` branch
  // (via `isManagerCoarseOnly` -> `personAxisTier`) now also classifies an `org_unit_lead`-only
  // caller as `unit_scoped`, but the query below filters by an EXACT `managerUserId` match — the
  // `manager`/`team_lead` tier's own semantic, not org_unit_lead's ancestor-based one. An
  // org_unit_lead-only caller (no manager/team_lead grant) therefore fails CLOSED here: the coarse
  // `authorize()` call below carries no `unitAncestors` (there is no single subject to resolve one
  // for on a bulk list), so org_unit_lead's own Cerbos rule cannot fire and this throws a 403 —
  // correctly denying, just via a less specific path than `getOneRoute`'s dedicated wiring. Listing
  // is NOT part of this ticket's landing surface (only `getOneRoute` resolves and passes
  // `unitAncestors`); wiring the list query to the subtree scope is left for the ticket that wants
  // it, same "ship what you need, flag the boundary" posture this file's header already uses.
  @Get()
  async listRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("cycleId") cycleId?: string, @Query("subjectId") subjectId?: string) {
    const principal = req.principal;
    const broad = hasBroadAppraisalReadTier(principal, tenantId);
    const managerCoarse = !broad && isManagerCoarseOnly(principal, tenantId);

    if (broad) {
      await authorize(principal, { kind: "appraisal", tenantId }, "read");
      return { appraisals: (await listAppraisalRows(tenantId, { cycleId, subjectUserId: subjectId })).map((r) => ({ id: r.id, cycleId: r.cycleId, subjectUserId: r.subjectUserId, managerUserId: r.managerUserId, status: r.status, composite: r.composite === null ? null : Number(r.composite) })) };
    }
    if (managerCoarse) {
      await authorize(principal, { kind: "appraisal", tenantId }, "read");
      if (!principal.userId) throw new BadRequestException("no principal user");
      return { appraisals: (await listAppraisalRows(tenantId, { cycleId, subjectUserId: subjectId, managerUserId: principal.userId })).map((r) => ({ id: r.id, cycleId: r.cycleId, subjectUserId: r.subjectUserId, managerUserId: r.managerUserId, status: r.status, composite: r.composite === null ? null : Number(r.composite) })) };
    }
    if (!principal.userId) throw new BadRequestException("no principal user");
    await authorize(principal, { kind: "appraisal", tenantId, subjectUserId: principal.userId }, "read");
    const rows = await listAppraisalRows(tenantId, { cycleId, subjectUserId: principal.userId, minStatus: "submitted" });
    return { appraisals: rows.map((r) => ({ id: r.id, cycleId: r.cycleId, subjectUserId: r.subjectUserId, managerUserId: r.managerUserId, status: r.status, composite: r.composite === null ? null : Number(r.composite) })) };
  }

  /** `GET /appraisals/mine` — MUST be declared before `:id` (both are single path segments; Nest
   *  matches routes in declaration order, and `:id` would otherwise swallow "mine"). */
  @Get("mine")
  async mineRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("cycleId") cycleId?: string) {
    const principal = req.principal;
    if (!principal.userId) throw new BadRequestException("no principal user");
    await authorize(principal, { kind: "appraisal", tenantId, subjectUserId: principal.userId }, "read");
    const rows = await listAppraisalRows(tenantId, { cycleId, subjectUserId: principal.userId, minStatus: "submitted" });
    return { appraisals: await Promise.all(rows.map((r) => hydrateAppraisalPack(tenantId, r))) };
  }

  @Get(":id")
  async getOneRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const principal = req.principal;
    const row = await fetchAppraisalRow(tenantId, id);
    if (!row) throw new NotFoundException("appraisal not found");

    // HIER-2: the subject's unit ancestor chain, so org_unit_lead's own rule has something to
    // match a dept-lead grant against (see subjectUnitAncestors' own comment).
    const unitAncestors = await subjectUnitAncestors(tenantId, row.subjectUserId);

    // Cerbos is the PRIMARY gate, always consulted first (so every decision — allow or deny — is
    // audited): self only for `subjectUserId == principal.id`, hr_people_ops/group_executive/
    // platform_admin unconditionally, manager/team_lead COARSE company-scoped (the known
    // approximation — see file header), org_unit_lead via unit-ancestor containment (HIER-2). A
    // plain member reading someone else's row is already denied HERE by Cerbos itself (no rule
    // matches), with no further controller logic needed.
    await authorize(principal, { kind: "appraisal", tenantId, id, subjectUserId: row.subjectUserId, unitAncestors }, "read");

    // Narrowings Cerbos cannot express, applied only for the tiers its own rules leave coarse:
    if (!hasBroadAppraisalReadTier(principal, tenantId)) {
      const isSelf = principal.userId === row.subjectUserId;
      if (isSelf && row.status === "draft") throw new ForbiddenException("this appraisal has not been submitted yet");
      const isExactManager = principal.userId === row.managerUserId;
      const isDeptLead = isOrgUnitLeadForSubject(principal, unitAncestors);
      if (!isSelf && !isExactManager && !isDeptLead) throw new ForbiddenException("not your assigned subject");
    }

    return hydrateAppraisalPack(tenantId, row);
  }

  // ---------------- write: PATCH scores/commentary/confirmEvidence (draft-only for scores) ------

  @Patch(":id")
  async patchRoute(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { scores?: Partial<Record<AppraisalAxis, { manager?: number | null; note?: string }>>; commentary?: string; confirmEvidence?: boolean },
  ) {
    const principal = req.principal;
    const row = await fetchAppraisalRow(tenantId, id);
    if (!row) throw new NotFoundException("appraisal not found");

    const admin = isPlatformAdmin(principal);
    const hr = hasBroadAppraisalReadTier(principal, tenantId); // hr_people_ops/exec/platform_admin
    const wantsScoreEdit = body?.scores !== undefined || body?.commentary !== undefined;
    const wantsConfirm = !!body?.confirmEvidence;
    if (!wantsScoreEdit && !wantsConfirm) throw new BadRequestException("nothing to update — pass scores, commentary, or confirmEvidence");

    if (!admin) {
      if (wantsScoreEdit) {
        // Cerbos "write" is manager/team_lead-coarse only (resource_appraisal.yaml never grants
        // hr_people_ops/group_executive "write") — narrowed here to the EXACT assigned manager.
        await authorize(principal, { kind: "appraisal", tenantId, id }, "write");
        if (principal.userId !== row.managerUserId) throw new ForbiddenException("not your assigned subject");
      }
      if (wantsConfirm) {
        // "confirm_evidence" is granted to the SAME manager/team_lead-coarse tier PLUS
        // hr_people_ops (§15's re-confirm path is not "scores" — see resource_appraisal.yaml).
        await authorize(principal, { kind: "appraisal", tenantId, id }, "confirm_evidence");
        if (!hr && principal.userId !== row.managerUserId) throw new ForbiddenException("not your assigned subject");
      }
    }

    const actorIsManager = admin || principal.userId === row.managerUserId;
    const actorIsHr = admin || hr;
    const result = await patchAppraisal(tenantId, id, { scores: body?.scores, commentary: body?.commentary, confirmEvidence: body?.confirmEvidence }, actorIsManager, actorIsHr);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("appraisal not found");
      if (result.reason === "invalid_score") throw new BadRequestException({ message: "each axis score must be an integer 1-5", field: "scores" });
      if (result.reason === "finalized") throw new ConflictException("a finalized appraisal cannot be edited");
      throw new ConflictException("scores/commentary can only be edited while the appraisal is in draft");
    }
    await writeActivity(tenantId, req.principal.userId, "updated", "report_appraisal", id, { confirmEvidence: !!body?.confirmEvidence });
    return hydrateAppraisalPack(tenantId, result.row);
  }

  // ---------------- submit ----------------

  @Post(":id/submit")
  @HttpCode(200)
  async submitRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { commentary?: string }) {
    const principal = req.principal;
    const row = await fetchAppraisalRow(tenantId, id);
    if (!row) throw new NotFoundException("appraisal not found");

    if (!isPlatformAdmin(principal)) {
      await authorize(principal, { kind: "appraisal", tenantId, id }, "submit");
      if (principal.userId !== row.managerUserId) throw new ForbiddenException("not your assigned subject");
    }

    const result = await submitAppraisal(tenantId, id, body?.commentary);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("appraisal not found");
      if (result.reason === "not_draft") throw new ConflictException("this appraisal is not in draft");
      if (result.reason === "commentary_too_short") throw new BadRequestException({ message: `commentary must be at least ${MIN_COMMENTARY_LENGTH} characters`, field: "commentary" });
      if (result.reason === "scores_incomplete") throw new BadRequestException({ message: `axis "${result.detail}" must be scored before submit`, field: "scores" });
      // The shared HttpErrorFilter reshapes every HttpException to {error, field} only (see
      // reports.controller.ts's identical documented deviation on its own 422 body) — a third
      // key (e.g. `axes: string[]`) would never reach the wire, so the offending axis names are
      // baked directly into the message string instead.
      const axes = (result.detail as string[]).join(", ");
      throw new BadRequestException({ message: `axis "${axes}" deviates from the computed band by more than one and requires a written note`, field: "scores" });
    }

    await writeActivity(tenantId, req.principal.userId, "submitted", "report_appraisal", id, { composite: result.row.composite });
    await notify(tenantId, row.subjectUserId, req.principal.userId, "reports.appraisal.submitted", {
      title: "Your appraisal is ready to review",
      href: `/appraisals/${id}`,
      entityType: "report_appraisal",
      entityId: id,
    });
    return hydrateAppraisalPack(tenantId, result.row);
  }

  // ---------------- ack (subject only; append-only trail) ----------------

  @Post(":id/ack")
  @HttpCode(200)
  async ackRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: { action?: string; comment?: string }) {
    const principal = req.principal;
    if (!principal.userId) throw new BadRequestException("no principal user");
    const row = await fetchAppraisalRow(tenantId, id);
    if (!row) throw new NotFoundException("appraisal not found");

    await authorize(principal, { kind: "appraisal", tenantId, id, subjectUserId: row.subjectUserId }, "ack");

    const action = body?.action;
    if (action !== "acknowledged" && action !== "disputed") {
      throw new BadRequestException({ message: 'action must be "acknowledged" or "disputed"', field: "action" });
    }

    const result = await ackAppraisal(tenantId, id, principal.userId, action, body?.comment);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("appraisal not found");
      throw new ConflictException("this appraisal cannot be acknowledged in its current state");
    }

    await notify(tenantId, row.managerUserId, principal.userId, `reports.appraisal.${action}`, {
      title: action === "disputed" ? "An appraisal was disputed" : "An appraisal was acknowledged",
      body: body?.comment,
      href: `/appraisals/${id}`,
      entityType: "report_appraisal",
      entityId: id,
      severity: action === "disputed" ? "warning" : "info",
    });
    return hydrateAppraisalPack(tenantId, result.row);
  }

  // ---------------- finalize (HR only; blocked while evidence_stale) ----------------

  @Post(":id/finalize")
  @HttpCode(200)
  async finalizeRoute(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const principal = req.principal;
    if (!principal.userId) throw new BadRequestException("no principal user");
    const row = await fetchAppraisalRow(tenantId, id);
    if (!row) throw new NotFoundException("appraisal not found");

    await authorize(principal, { kind: "appraisal", tenantId, id }, "finalize");

    const result = await finalizeAppraisal(tenantId, id, principal.userId);
    if (!result.ok) {
      if (result.reason === "not_found") throw new NotFoundException("appraisal not found");
      if (result.reason === "evidence_stale") {
        throw new ConflictException({
          message: "this appraisal's evidence has been amended since it was generated — a manager or HR must re-confirm (PATCH {confirmEvidence:true}) before it can be finalized",
        });
      }
      throw new ConflictException("this appraisal cannot be finalized in its current state");
    }

    await writeActivity(tenantId, principal.userId, "finalized", "report_appraisal", id, {});
    await notify(tenantId, row.subjectUserId, principal.userId, "reports.appraisal.finalized", {
      title: "Your appraisal has been finalized",
      href: `/appraisals/${id}`,
      entityType: "report_appraisal",
      entityId: id,
    });
    await notify(tenantId, row.managerUserId, principal.userId, "reports.appraisal.finalized", {
      title: "An appraisal you scored has been finalized",
      href: `/appraisals/${id}`,
      entityType: "report_appraisal",
      entityId: id,
    });
    return hydrateAppraisalPack(tenantId, result.row);
  }
}
