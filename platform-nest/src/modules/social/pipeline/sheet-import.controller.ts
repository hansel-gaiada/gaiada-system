// SCP-6a — the one-off sheet import (BFF §63.23; plan §8 SCP-6, SCP-D10): the Social Media team's sheet read once, when the team moves over.
//
//   POST import/parse        social_engagement · plan     a file or pasted text into tabs of text cells (`sheet-parse.ts`); writes nothing
//   POST import/allocation   social_engagement · plan     one row per client: the allocation. `dryRun: true` previews, `dryRun: false` writes
//   POST import/plan         social_engagement · plan     one month's posts. The same two modes
//
// THE FOUR APPROVERS ONLY (SCP-Q18, SCP-Q19; PERMISSION §53.6). Every route starts with `authorizePlan` (`plan-authz.ts`), which reads only the path
// ids, so a refused caller gets 403 `not_a_social_approver` whatever the body holds (BFF §63.0: authorization before validation). There is no new
// Cerbos kind or action and no migration. Each imported post is still the machine's `create` (63.6.1): the four hold `approve` on any would-be
// post, so its extra check passes for them.
//
// ONE TRANSACTION, ALL OR NOTHING. Apply runs the preview AGAIN inside one `withTenants` transaction. It writes only when no row outside `skip` is
// refused; otherwise it writes nothing and answers 409 `import_rows_refused` with the preview's answer as `detail`. What the transaction cannot ask for
// is asked BEFORE it: the company's working calendar (the pre-fill of a missing cycle, through `loadCalendarInfo`, which declares the hr scope itself)
// and Cerbos's `create` answers, one per distinct officer (`cerbosDecisionsFor` on the would-be resource, exactly as `createPipelinePost` does).
//
// THE WRITES ARE THE EXISTING ONES, NOT COPIES OF THEM:
//   - allocation: `applyAllocationPatchInTx` (allocation.controller.ts), the PATCH's UPDATE and its `allocation_changed` event;
//   - a missing cycle: `writeCycleInTx` (cycles-data.ts), `PUT cycles`' upsert and the content-month task, the deadline from `prefillDeadline`;
//   - a post: `createPostInTx` (pipeline.service.ts), the machine's `create` with the row's planning and copy columns in the same INSERT, and
//     `syncContentMonthProgress` once per touched cycle.
// The activity rows come after the commit, as the PATCH and the create write theirs, each carrying `{via: "sheet_import", importId}`.
//
// THE MODULE WALL. Every query on a `social_*` table runs inside `withTenants(..., { modules: ["social"] })` (and the readers declare the scope).
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, HttpCode, Logger, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { writeActivity } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { declareSocialModuleScope } from "../module-scope";
import { loadSocialApproverIds } from "../pipeline-authz";
import { applyAllocationPatchInTx, parseAllocationPatch, readAllocation, type AllocationRow } from "./allocation.controller";
import {
  READY_BY_LOOKBACK_DAYS, loadCalendarInfo, readCyclePosts, readCyclesOfMonth, readSettings, todayIsoInTz, writeCycleInTx,
} from "./cycles-data";
import { syncContentMonthProgress } from "./content-month-progress";
import { cerbosActionsToAsk } from "./machine";
import { authorizePlan } from "./plan-authz";
import { authorizeStage, cerbosDecisionsFor, createPostInTx, isAutomationPrincipal } from "./pipeline.service";
import { prefillDeadline, previousMonth, readyByFor } from "./schedule-health";
import {
  cyclesToCreate, finishPlan, parseImportBody, previewAllocation, stagePlanRows,
  type AllocationEngagement, type AllocationRowAnswer, type ImportAnswer, type ImportBody, type Member, type PlanEngagement, type PlanLookups,
  type PlanRowAnswer, type PlanWrite, type Summary,
} from "./sheet-import";
import { parseSheetBody } from "./sheet-parse";
import type { Resource } from "../../../rbac/cerbos";
import type { Principal } from "../../../rbac/principal";

/** The body limit of the two writing routes (BFF §63.23.1): `upload-body-limits.ts` derives the Fastify `bodyLimit` from it. */
export const MAX_IMPORT_BODY_BYTES = 4 * 1024 * 1024;

const SOCIAL = { modules: ["social"] };
const log = new Logger("SocialSheetImport");

// ── what the rows are matched against ────────────────────────────────────────────────────────────────────────────────────

const toAllocationEngagement = (r: AllocationRow): AllocationEngagement => ({
  engagementId: r.engagementId, clientName: r.clientName, officer: r.officer, postsPerCycle: r.postsPerCycle, creativeSource: r.creativeSource,
  deliveryBatch: r.deliveryBatch, reportFormat: r.reportFormat, reportDueDay: r.reportDueDay, platforms: r.platforms, formats: r.formats,
  defaultPostTime: r.defaultPostTime,
});

/** The company's active employee members (the allocation's officer test, BFF §63.4): an active membership held by an active `employee` user. */
async function readMembers(c: PoolClient, tenantId: string): Promise<Member[]> {
  const { rows } = await c.query<{ id: string; name: string; email: string }>(
    `SELECT u.id::text AS id, u.name, COALESCE(u.email, '') AS email
       FROM company_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.deleted_at IS NULL AND m.status = 'active'
        AND u.deleted_at IS NULL AND u.status = 'active' AND u.kind = 'employee'
      ORDER BY lower(u.name), u.id`,
    [tenantId],
  );
  return rows;
}

/** The person's picks must be this company's: a client pick an open engagement, an officer pick an active employee member (400 `<map>.<sheetName>`). */
function checkPicks(body: ImportBody, engagementIds: ReadonlySet<string>, members: readonly Member[] | null): void {
  for (const [name, id] of body.clientPicks) {
    if (!engagementIds.has(id)) throw new BadRequestException({ message: "invalid_field", field: `clientMatches.${name}` });
  }
  if (members) {
    const ids = new Set(members.map((m) => m.id));
    for (const [name, id] of body.officerPicks) {
      if (!ids.has(id)) throw new BadRequestException({ message: "invalid_field", field: `officerMatches.${name}` });
    }
  }
}

/** 409 `import_rows_refused`: nothing was written, and the preview's answer says which rows and why. */
function refused(answer: object): ConflictException {
  return new ConflictException({ message: "import_rows_refused", detail: { dryRun: false, importId: null, ...answer } });
}

const hasRefused = (rows: ReadonlyArray<{ outcome: string }>): boolean => rows.some((r) => r.outcome === "refused");

function resummarize(rows: ReadonlyArray<{ outcome: string }>): Summary {
  const s: Summary = { rows: rows.length, ready: 0, unchanged: 0, refused: 0, skipped: 0 };
  for (const r of rows) s[r.outcome as keyof Omit<Summary, "rows">] += 1;
  return s;
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialSheetImportController {
  // ==================================================================== POST import/parse
  @Post("import/parse")
  @HttpCode(200)
  async parse(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown): Promise<{ tabs: Array<{ name: string; rows: string[][] }> }> {
    await authorizePlan(req, tenantId);
    return parseSheetBody(body);
  }

  // ==================================================================== POST import/allocation
  @Post("import/allocation")
  @HttpCode(200)
  async importAllocation(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() raw: unknown): Promise<ImportAnswer<AllocationRowAnswer>> {
    await authorizePlan(req, tenantId);
    const today = todayIsoInTz(config.reportsTz);
    const body = parseImportBody("allocation", raw, today);
    const callerId = req.principal.userId ?? null;
    const importId = newId();

    const result = await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const engagements = (await readAllocation(c, tenantId, today, true)).map(toAllocationEngagement);
        const members = await readMembers(c, tenantId);
        checkPicks(body, new Set(engagements.map((e) => e.engagementId)), members);
        const { answer, writes } = previewAllocation(body, engagements, members);
        if (body.dryRun) return { answer, written: [] as string[][] };
        if (hasRefused(answer.rows)) throw refused(answer);
        if (!callerId) throw new ForbiddenException("not authorized: an authenticated user is required");
        const written: string[][] = [];
        for (const w of writes) {
          const fields = Object.keys(w.patch);
          await applyAllocationPatchInTx(c, tenantId, w.engagementId, parseAllocationPatch(w.patch), fields);
          written.push([w.engagementId, ...fields]);
        }
        return { answer, written };
      },
      SOCIAL,
    );

    // The activity rows, after the commit, as the PATCH writes its own (BFF §63.4): one `updated` per engagement the import changed.
    for (const [engagementId, ...fields] of result.written) {
      await writeActivity(tenantId, callerId, "updated", "social_engagement", engagementId, { allocation: fields, via: "sheet_import", importId })
        .catch((e: unknown) => log.warn(`activity for engagement ${engagementId} not written: ${e instanceof Error ? e.message : String(e)}`));
    }
    return { dryRun: body.dryRun, importId: body.dryRun ? null : importId, ...result.answer };
  }

  // ==================================================================== POST import/plan
  @Post("import/plan")
  @HttpCode(200)
  async importPlan(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() raw: unknown): Promise<ImportAnswer<PlanRowAnswer>> {
    await authorizePlan(req, tenantId);
    const principal = req.principal;
    const today = todayIsoInTz(config.reportsTz);
    const body = parseImportBody("plan", raw, today);
    const plan = body.plan!;
    const callerId = principal.userId ?? null;
    const importId = newId();

    // BEFORE the transaction, 1: which engagements the rows reach, and who the officers and the four are (for Cerbos).
    const pre = await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const engagements = (await readAllocation(c, tenantId, today, true)).map(toAllocationEngagement);
        checkPicks(body, new Set(engagements.map((e) => e.engagementId)), null);
        return { engagements, approverIds: await loadSocialApproverIds(c, tenantId) };
      },
      SOCIAL,
    );
    const planEngagements = (list: readonly AllocationEngagement[]): PlanEngagement[] =>
      list.map((e) => ({
        engagementId: e.engagementId, clientName: e.clientName, defaultPostTime: e.defaultPostTime,
        deliveryBatch: e.deliveryBatch === "A" || e.deliveryBatch === "B" ? e.deliveryBatch : null,
      }));

    // 2: the working calendar the pre-fill of a missing cycle (and its ready-by) walks over. It declares the hr scope itself, so it is read here.
    const info = await loadCalendarInfo(tenantId, [`${previousMonth(plan.month)}-01`, `${plan.month}-01`], READY_BY_LOOKBACK_DAYS);

    // 3: Cerbos's `create` answers, one per distinct officer of the engagements the rows reach (apply only: a preview writes nothing).
    const decisions = new Map<string, { resource: Resource; cerbos: Record<string, boolean> }>();
    if (!body.dryRun) {
      const stage = stagePlanRows(body, { tenantId, today, engagements: planEngagements(pre.engagements) });
      const reached = new Set(stage.drafts.filter((d) => d.engagement && !d.skipped).map((d) => d.engagement!.engagementId));
      for (const e of pre.engagements) {
        if (!reached.has(e.engagementId)) continue;
        const ownerId = e.officer?.id ?? "";
        if (decisions.has(ownerId)) continue;
        const resource: Resource = {
          kind: "social_post", tenantId, module: "social", ownerId, creatorId: "", approverIds: pre.approverIds, assigneeIds: [], creativeSource: "",
        };
        decisions.set(ownerId, { resource, cerbos: await cerbosDecisionsFor(principal, resource, cerbosActionsToAsk("create", null)) });
      }
    }

    const result = await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const engagementRows = (await readAllocation(c, tenantId, today, true));
        const engagements = engagementRows.map(toAllocationEngagement);
        checkPicks(body, new Set(engagements.map((e) => e.engagementId)), null);
        const stage = stagePlanRows(body, { tenantId, today, engagements: planEngagements(engagements) });

        // What exists: the month's cycles, their live posts, and which of the rows' ids are taken (deleted ones too).
        const cycles = await readCyclesOfMonth(c, tenantId, plan.month);
        const posts = await readCyclePosts(c, tenantId, cycles.map((x) => x.id));
        const taken = stage.postIds.length === 0
          ? { rows: [] as Array<{ id: string; deleted: boolean }> }
          : await c.query<{ id: string; deleted: boolean }>(
            `SELECT id::text AS id, (deleted_at IS NOT NULL) AS deleted FROM social_posts WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
            [tenantId, stage.postIds],
          );
        const lookups: PlanLookups = {
          cycles: new Map(cycles.map((x) => [x.engagementId, { cycleId: x.id, deadline: x.deadline }])),
          cyclePosts: new Map(cycles.map((x) => [x.id, posts.filter((p) => p.cycleId === x.id).map((p) => ({ id: p.id, title: p.title }))])),
          existing: new Map(taken.rows.map((r) => [r.id, { deleted: r.deleted }])),
          prefillFor: (batch) => prefillDeadline(plan.month, batch, info.calendar),
        };
        const { answer, writes } = finishPlan(stage, lookups);
        if (body.dryRun) return { answer, created: [] as Created[] };
        if (hasRefused(answer.rows)) throw refused(answer);
        if (!callerId) throw new ForbiddenException("not authorized: an authenticated user is required");

        const created = await applyPlan(c, { tenantId, principal, callerId, month: plan.month, calendar: info, writes, engagementRows, decisions });
        // The answer names what was written: the cycles' ids, and a post another writer had just made is `unchanged`.
        const byRow = new Map(created.map((x) => [x.row, x]));
        const rows = answer.rows.map((r): PlanRowAnswer => {
          const w = byRow.get(r.row);
          if (!w || r.cycle === null) return r;
          const cycle = { ...r.cycle, cycleId: w.cycleId };
          return w.created ? { ...r, cycle } : { ...r, outcome: "unchanged", cycle };
        });
        return { answer: { ...answer, rows, summary: resummarize(rows) }, created };
      },
      SOCIAL,
    );

    // The activity rows of the new posts, after the commit, as `create` writes its own (BFF §63.14), each carrying the import.
    for (const x of result.created) {
      if (!x.created) continue;
      await writeActivity(tenantId, callerId, "create", "social_post", x.postId, {
        from: null, to: x.to, cycleId: x.cycleId, engagementId: x.engagementId, viaPortal: false, via: "sheet_import", importId,
      }).catch((e: unknown) => log.warn(`activity for post ${x.postId} not written: ${e instanceof Error ? e.message : String(e)}`));
    }
    return { dryRun: body.dryRun, importId: body.dryRun ? null : importId, ...result.answer };
  }
}

interface Created { row: number; postId: string; created: boolean; cycleId: string; engagementId: string; to: string | null }

/**
 * Apply's writes, on the caller's client: the cycles that do not exist (once per client), then each ready row's post through the machine's `create`,
 * then each touched cycle's content-month progress once. A refusal of the machine (Cerbos, the cycle gone) throws, which rolls the whole import back.
 */
async function applyPlan(
  c: PoolClient,
  a: {
    tenantId: string; principal: Principal; callerId: string; month: string; calendar: Awaited<ReturnType<typeof loadCalendarInfo>>;
    writes: readonly PlanWrite[]; engagementRows: readonly AllocationRow[]; decisions: ReadonlyMap<string, { resource: Resource; cerbos: Record<string, boolean> }>;
  },
): Promise<Created[]> {
  const { tenantId, principal, callerId, month } = a;
  const byId = new Map(a.engagementRows.map((e) => [e.engagementId, e]));

  const buffer = (await readSettings(c, tenantId)).bufferWorkingDays;
  const madeCycles = new Map<string, string>();
  for (const [engagementId, deadline] of cyclesToCreate(a.writes)) {
    const readyBy = readyByFor(deadline, buffer, a.calendar.calendar);
    madeCycles.set(engagementId, (await writeCycleInTx(c, { tenantId, engagementId, month, deadline, readyBy, actorId: callerId })).cycleId);
  }

  const out: Created[] = [];
  const touched = new Set<string>();
  for (const w of a.writes) {
    const cycleId = w.cycle.cycleId ?? madeCycles.get(w.engagementId)!;
    const eng = byId.get(w.engagementId)!;
    const ownerId = eng.officer?.id ?? "";
    const d = a.decisions.get(ownerId);
    // The engagement's officer changed between the question to Cerbos and the lock: the answer is stale, so the import is too.
    if (!d) throw new ConflictException({ message: "status_changed" });
    const base = {
      action: "create", params: w.params, cerbos: d.cerbos,
      principal: { userId: callerId, isAutomation: isAutomationPrincipal(principal), isAuthor: false, isOfficer: eng.officer?.id === callerId },
    };
    const r = await createPostInTx(c, { tenantId, cycleId, callerId, base, extra: w.extra, syncProgress: false });
    if ("refusal" in r) return authorizeStage(principal, d.resource, "create", r.refusal);
    out.push({ row: w.row, postId: r.id, created: r.created, cycleId, engagementId: w.engagementId, to: r.applied.to });
    if (r.created) touched.add(cycleId);
  }
  // A new counted post that is not approved yet reopens a done content-month task (SCP-1n): once per cycle, after its posts.
  for (const cycleId of touched) await syncContentMonthProgress(c, tenantId, cycleId, callerId);
  return out;
}
