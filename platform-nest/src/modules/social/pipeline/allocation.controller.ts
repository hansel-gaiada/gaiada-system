// SCP-1a — the client allocation (BFF §63.4; plan §8 row 1a).
//
//   GET   allocation?mine=                                  social_engagement · read     every open engagement with its allocation and this cycle's counts
//   PATCH engagements/:engagementId/allocation             social_engagement · plan     any subset of the allocation fields; the four approvers only
//
// THE FOUR APPROVERS EDIT, NOBODY ELSE (SCP-Q18, SCP-Q19; PERMISSION §53.6). A refusal is 403 `not_a_social_approver`, decided BEFORE the body
// is read (BFF §63.0: a refused caller always gets 403, never 400). The resource's `approverIds` come from the rows (`plan-authz.ts`).
//
// THE OFFICER is `social_engagements.owner_id`, set here and nowhere else (`PATCH engagements/:id` refuses `ownerId`, 63.12). It must be an
// ACTIVE EMPLOYEE MEMBER of the company: an active `company_memberships` row for the company, held by an active `users` row of kind `employee`
// (the same test as `finance/freelancer-bills.service.ts` `activeHuman`: a bot, an automation, a client contact and a member of another company
// all fail it). 409 `officer_not_member`.
//
// THIS CYCLE. `thisCycle` is this month's `social_cycles` row and its counts, read through SCP-1c's `cycles-data.ts` (`readCyclesOfMonth`,
// `readCyclePosts`) and counted by `tallyCounts`: this file holds no second counting rule. "This month" is the company's report month
// (`todayIsoInTz(config.reportsTz)`).
//
// THE MODULE WALL. Every query declares `{ modules: ["social"] }` on its `withTenants`.
import {
  BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize, writeActivity } from "../../../core/http";
import { emitEvent } from "../../../events/outbox.service";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { declareSocialModuleScope } from "../module-scope";
import { NETWORKS, invalidField } from "./brand-book";
import { readCyclePosts, readCyclesOfMonth, todayIsoInTz } from "./cycles-data";
import { authorizePlan, canPlanOf } from "./plan-authz";
import { STEP_KEYS, parseStepEstimates, tallyCounts, type StepEstimates } from "./schedule-health";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ["feed", "carousel", "reel", "story"] as const;
const CREATIVE_SOURCES = ["creatives", "in_team"] as const;

/** One client's allocation row (BFF §63.4 `AllocationRow`). */
export interface AllocationRow {
  engagementId: string;
  clientId: string;
  clientName: string;
  status: string;
  officer: { id: string; name: string } | null;
  postsPerCycle: number | null;
  creativeSource: "creatives" | "in_team";
  deliveryBatch: "A" | "B" | null;
  reportFormat: "email" | "meeting" | null;
  reportDueDay: number | null;
  platforms: string[];
  formats: string[];
  defaultPostTime: string | null;
  stepEstimates: StepEstimates;
  thisCycle: { cycleId: string; month: string; target: number | null; counted: number; extra: number; stories: number } | null;
  canPlan: boolean;
}

/** The validated PATCH: the columns to write, in `social_engagements` terms. */
interface AllocationPatch {
  ownerId?: string | null;
  postsPerCycle?: number | null;
  creativeSource?: (typeof CREATIVE_SOURCES)[number];
  deliveryBatch?: "A" | "B" | null;
  reportFormat?: "email" | "meeting" | null;
  reportDueDay?: number | null;
  platforms?: string[];
  formats?: string[];
  defaultPostTime?: string | null;
  stepEstimates?: StepEstimates;
}
const PATCH_KEYS = [
  "officerId", "postsPerCycle", "creativeSource", "deliveryBatch", "reportFormat", "reportDueDay", "platforms", "formats", "defaultPostTime", "stepEstimates",
] as const;

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** A list of distinct members of `allowed`, in the order sent. */
function pickList(v: unknown, allowed: readonly string[], field: string): string[] {
  if (!Array.isArray(v) || v.length > allowed.length) return invalidField(field);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !allowed.includes(x)) return invalidField(field);
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * PURE. Validates an allocation PATCH body (BFF §63.1 rules). Unknown keys, and the read-only `thisCycle` and `canPlan`, are 400 `unknown_field`;
 * a value outside its rule is 400 `invalid_field`; both carry `field`. An empty body is 400 `no_fields`.
 */
export function parseAllocationPatch(body: unknown): AllocationPatch {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalidField("body");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!(PATCH_KEYS as readonly string[]).includes(k)) throw new BadRequestException({ message: "unknown_field", field: k });
  }
  if (Object.keys(b).length === 0) throw new BadRequestException({ message: "no_fields" });
  const out: AllocationPatch = {};
  if (b.officerId !== undefined) {
    if (b.officerId !== null && (typeof b.officerId !== "string" || !UUID_RE.test(b.officerId))) invalidField("officerId");
    out.ownerId = b.officerId === null ? null : (b.officerId as string).toLowerCase();
  }
  if (b.postsPerCycle !== undefined) {
    if (b.postsPerCycle !== null && !isInt(b.postsPerCycle, 0, 200)) invalidField("postsPerCycle");
    out.postsPerCycle = b.postsPerCycle as number | null;
  }
  if (b.creativeSource !== undefined) {
    if (typeof b.creativeSource !== "string" || !(CREATIVE_SOURCES as readonly string[]).includes(b.creativeSource)) invalidField("creativeSource");
    out.creativeSource = b.creativeSource as (typeof CREATIVE_SOURCES)[number];
  }
  if (b.deliveryBatch !== undefined) {
    if (b.deliveryBatch !== null && b.deliveryBatch !== "A" && b.deliveryBatch !== "B") invalidField("deliveryBatch");
    out.deliveryBatch = b.deliveryBatch as "A" | "B" | null;
  }
  if (b.reportFormat !== undefined) {
    if (b.reportFormat !== null && b.reportFormat !== "email" && b.reportFormat !== "meeting") invalidField("reportFormat");
    out.reportFormat = b.reportFormat as "email" | "meeting" | null;
  }
  if (b.reportDueDay !== undefined) {
    if (b.reportDueDay !== null && !isInt(b.reportDueDay, 1, 31)) invalidField("reportDueDay");
    out.reportDueDay = b.reportDueDay as number | null;
  }
  if (b.platforms !== undefined) out.platforms = pickList(b.platforms, NETWORKS, "platforms");
  if (b.formats !== undefined) out.formats = pickList(b.formats, FORMATS, "formats");
  if (b.defaultPostTime !== undefined) {
    if (b.defaultPostTime !== null && (typeof b.defaultPostTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.defaultPostTime))) invalidField("defaultPostTime");
    out.defaultPostTime = b.defaultPostTime as string | null;
  }
  if (b.stepEstimates !== undefined) {
    const s = b.stepEstimates;
    if (s === null || typeof s !== "object" || Array.isArray(s)) return invalidField("stepEstimates");
    const est: StepEstimates = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (!(STEP_KEYS as readonly string[]).includes(k) || !isInt(v, 0, 30)) return invalidField("stepEstimates");
      est[k as keyof StepEstimates] = v;
    }
    // The whole object is the value: a key left out is cleared (the same rule as the arrays above).
    out.stepEstimates = est;
  }
  return out;
}

interface AllocationDbRow {
  id: string; client_id: string; client_name: string; status: string; owner_id: string | null; officer_name: string | null;
  posts_per_cycle: number | null; creative_source: string; delivery_batch: string | null; report_format: string | null;
  report_due_day: number | null; platforms: string[]; formats: string[]; default_post_time: string | null; step_estimates: unknown;
}

/**
 * The allocation rows of the company's engagements, in the caller's transaction. `engagementId` narrows to one (closed ones answer too);
 * without it, closed engagements are left out. `officerId` keeps one officer's clients.
 */
async function readAllocation(
  c: PoolClient, tenantId: string, today: string, canPlan: boolean, opts: { engagementId?: string; officerId?: string } = {},
): Promise<AllocationRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<AllocationDbRow>(
    `SELECT e.id, e.client_id, cl.name AS client_name, e.status, e.owner_id, u.name AS officer_name,
            e.posts_per_cycle, e.creative_source, e.delivery_batch, e.report_format, e.report_due_day,
            e.platforms, e.formats, to_char(e.default_post_time, 'HH24:MI') AS default_post_time, e.step_estimates
       FROM social_engagements e
       JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
       LEFT JOIN users u ON u.id = e.owner_id
      WHERE e.tenant_id = $1 AND e.deleted_at IS NULL
        AND ($2::uuid IS NOT NULL OR e.status <> 'closed')
        AND ($2::uuid IS NULL OR e.id = $2::uuid)
        AND ($3::uuid IS NULL OR e.owner_id = $3::uuid)
      ORDER BY lower(cl.name), cl.name, e.id`,
    [tenantId, opts.engagementId ?? null, opts.officerId ?? null],
  );
  if (rows.length === 0) return [];
  // This month's cycles and their counts: SCP-1c's reads and SCP-1c's counting rule.
  const month = today.slice(0, 7);
  const cycles = await readCyclesOfMonth(c, tenantId, month);
  const cycleOf = new Map(cycles.map((x) => [x.engagementId, x]));
  const posts = await readCyclePosts(c, tenantId, cycles.map((x) => x.id));
  return rows.map((r): AllocationRow => {
    const cycle = cycleOf.get(r.id) ?? null;
    const target = r.posts_per_cycle === null ? null : Number(r.posts_per_cycle);
    const counts = cycle ? tallyCounts(posts.filter((p) => p.cycleId === cycle.id)) : null;
    return {
      engagementId: r.id,
      clientId: r.client_id,
      clientName: r.client_name,
      status: r.status,
      officer: r.owner_id ? { id: r.owner_id, name: r.officer_name ?? "" } : null,
      postsPerCycle: target,
      creativeSource: r.creative_source === "in_team" ? "in_team" : "creatives",
      deliveryBatch: r.delivery_batch === "A" || r.delivery_batch === "B" ? r.delivery_batch : null,
      reportFormat: r.report_format === "email" || r.report_format === "meeting" ? r.report_format : null,
      reportDueDay: r.report_due_day === null ? null : Number(r.report_due_day),
      platforms: r.platforms ?? [],
      formats: r.formats ?? [],
      defaultPostTime: r.default_post_time,
      stepEstimates: parseStepEstimates(r.step_estimates),
      thisCycle: cycle && counts ? { cycleId: cycle.id, month, target, counted: counts.counted, extra: counts.extra, stories: counts.stories } : null,
      canPlan,
    };
  });
}

/** An active employee member of the company (see the header). */
async function isActiveEmployeeMember(c: PoolClient, tenantId: string, userId: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1
       FROM company_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.user_id = $2
        AND m.deleted_at IS NULL AND m.status = 'active' AND u.deleted_at IS NULL AND u.status = 'active' AND u.kind = 'employee'`,
    [tenantId, userId],
  );
  return rows.length > 0;
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialAllocationController {
  // ==================================================================== GET allocation
  @Get("allocation")
  async getAllocation(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("mine") mineQ?: string): Promise<{ items: AllocationRow[] }> {
    await authorize(req.principal, { kind: "social_engagement", tenantId, module: "social" }, "read");
    let mine = false;
    if (mineQ !== undefined && mineQ !== "") {
      if (mineQ === "1" || mineQ === "true") mine = true;
      else if (mineQ !== "0" && mineQ !== "false") return invalidField("mine");
    }
    const callerId = req.principal.userId ?? null;
    const today = todayIsoInTz(config.reportsTz);
    const canPlan = await canPlanOf(req, tenantId);
    // `mine=1` with no caller identity keeps nobody: it never widens to every client.
    if (mine && !callerId) return { items: [] };
    const items = await withTenants(
      [tenantId],
      (c) => readAllocation(c, tenantId, today, canPlan, mine && callerId ? { officerId: callerId } : {}),
      { modules: ["social"] },
    );
    return { items };
  }

  // ==================================================================== PATCH engagements/:engagementId/allocation
  @Patch("engagements/:engagementId/allocation")
  async patchAllocation(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string, @Body() body: unknown,
  ): Promise<AllocationRow> {
    // The decision first: it reads only the path ids. A refused caller gets 403 whatever the body holds.
    await authorizePlan(req, tenantId, UUID_RE.test(engagementId) ? engagementId.toLowerCase() : undefined);
    const patch = parseAllocationPatch(body);
    if (!UUID_RE.test(engagementId)) throw new NotFoundException({ message: "engagement_not_found" });
    const id = engagementId.toLowerCase();
    const today = todayIsoInTz(config.reportsTz);

    const row = await withTenants(
      [tenantId],
      async (c) => {
        await declareSocialModuleScope(c);
        const locked = await c.query(
          `SELECT 1 FROM social_engagements WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [tenantId, id],
        );
        if (locked.rows.length === 0) throw new NotFoundException({ message: "engagement_not_found" });
        if (patch.ownerId !== undefined && patch.ownerId !== null && !(await isActiveEmployeeMember(c, tenantId, patch.ownerId))) {
          throw new ConflictException({ message: "officer_not_member" });
        }
        const sets: string[] = [];
        const params: unknown[] = [tenantId, id];
        const set = (col: string, val: unknown, cast = ""): void => {
          params.push(val);
          sets.push(`${col} = $${params.length}${cast}`);
        };
        if (patch.ownerId !== undefined) set("owner_id", patch.ownerId);
        if (patch.postsPerCycle !== undefined) set("posts_per_cycle", patch.postsPerCycle);
        if (patch.creativeSource !== undefined) set("creative_source", patch.creativeSource);
        if (patch.deliveryBatch !== undefined) set("delivery_batch", patch.deliveryBatch);
        if (patch.reportFormat !== undefined) set("report_format", patch.reportFormat);
        if (patch.reportDueDay !== undefined) set("report_due_day", patch.reportDueDay);
        if (patch.platforms !== undefined) set("platforms", patch.platforms, "::text[]");
        if (patch.formats !== undefined) set("formats", patch.formats, "::text[]");
        if (patch.defaultPostTime !== undefined) set("default_post_time", patch.defaultPostTime, "::time");
        if (patch.stepEstimates !== undefined) set("step_estimates", JSON.stringify(patch.stepEstimates), "::jsonb");
        await c.query(`UPDATE social_engagements SET ${sets.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
        const fields = Object.keys(body as Record<string, unknown>);
        await emitEvent(c, tenantId, "social_engagement", id, "social.engagement.allocation_changed", { fields });
        const [out] = await readAllocation(c, tenantId, today, true, { engagementId: id });
        return out;
      },
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "social_engagement", id, { allocation: Object.keys(body as Record<string, unknown>) });
    return row;
  }
}
