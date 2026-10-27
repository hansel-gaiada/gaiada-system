// SCP-1h — the designer's queue (FRONTEND-BFF-CONTRACT §63.6.6, §63.17 row `design-queue`).
//
//   GET design-queue?cursor=&limit=    work_request · read (every member), each row narrowed by the two facts Cerbos uses for `design`
//
// WHO SEES A POST. The outer gate is `work_request` · `read`, which every member holds: it is only the door. Each row is then
// narrowed by the same two facts the policy reads on `social_post` · `design` (resource_social_post.yaml, SCP-Q2), so the queue lists
// what the caller may act on and nothing else:
//   - a `creatives` post (the engagement's designs come from Creatives): the caller is named on the month request's PM task, the §32
//     assignee computation (`loadAuthFacts`, the very function the post's own authorization feeds `assigneeIds` from);
//   - an `in_team` post: the caller holds `social_designer` (company scope, or global), the derived role's own condition.
// Each surviving row is then confirmed by Cerbos itself (`design` on the post's real resource, one batched call), so a rule the facts
// cannot see (the tenant and level conditions) can only remove a row, never add one. The HoD and the other approvers hold neither fact,
// so they see nothing here as designers: their reach is the post page.
//
// WHICH POSTS. A post in `design`, or in a design `changes` case (`final_design` or `client_design`, the two cases whose holder is the
// designer), not deleted and not archived. A revision shows the note that asked for it (`change_note`), the only place a note's text
// leaves the post. `readyBy` is the cycle's, and `health` is the post's own (schedule-health.ts, the maths the cycle table reads).
//
// PAGING. Narrowing needs the request's assignees and Cerbos, so it cannot be a SQL keyset: the candidate set (the company's posts
// at the designers' steps, a few dozen) is narrowed in memory, ordered by ready-by, then by when the post reached its step, then by
// id, and the opaque cursor is the last item's key in that order.
import { BadRequestException, Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize } from "../../../core/http";
import { loadAuthFacts } from "../../../core/work-requests.service";
import { AuthGuard } from "../../../auth/guards";
import { checkMany } from "../../../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../../../rbac/principal";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { addDays } from "../../hr/working-days";
import { declareSocialModuleScope } from "../module-scope";
import { loadSocialApproverIds, socialPostResource } from "../pipeline-authz";
import {
  HEALTH_LOOKBACK_DAYS, loadCalendarInfo, readApprovalSamples, readEngagements, todayIsoInTz,
  type EngagementRow,
} from "./cycles-data";
import { averageApprovalDays, isClientSlower, looksLikeIsoDate, postHealth, type ApprovalSample, type Health } from "./schedule-health";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DESIGN_QUEUE_DEFAULT_LIMIT = 30;
export const DESIGN_QUEUE_MAX_LIMIT = 100;

export interface DesignQueueItem {
  postId: string;
  clientName: string;
  title: string;
  format: string | null;
  creativeState: string | null;
  /** The note that asked for this revision (the post's `change_note`), or null when the post is not a revision. */
  revisionNote: string | null;
  readyBy: string;
  health: Health;
  thumbFileId: string | null;
}

interface Candidate {
  id: string;
  engagementId: string;
  clientName: string;
  title: string;
  format: string | null;
  status: string;
  changeBy: string | null;
  changeKind: string | null;
  returnTo: string | null;
  changedOnly: boolean;
  blockedFrom: string | null;
  blockWaitingOn: string | null;
  changeNote: string | null;
  creativeSource: "creatives" | "in_team";
  creativeState: string | null;
  statusSince: string;
  readyBy: string;
  ownerId: string;
  authorId: string;
  assigneeIds: string[];
  thumbFileId: string | null;
}

/** Whether `p` holds `social_designer` in `tenantId`: the derived role's own condition (a global grant, or a company grant here). */
export function holdsSocialDesigner(p: Pick<Principal, "roles">, tenantId: string): boolean {
  return (p.roles ?? []).some((g) => g.role === "social_designer" && (g.scopeType === "global" || (g.scopeType === "company" && g.scopeId === tenantId)));
}

/** The order of the queue, and the cursor's key: ready-by, then when the post reached its step, then the id. */
const keyOf = (c: Pick<Candidate, "readyBy" | "statusSince" | "id">): [string, string, string] => [c.readyBy, c.statusSince, c.id];
function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

const encodeCursor = (k: readonly string[]): string => Buffer.from(JSON.stringify(k), "utf8").toString("base64url");
function decodeCursor(raw: string): [string, string, string] | null {
  try {
    const k = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(k) && k.length === 3 && k.every((x) => typeof x === "string") && looksLikeIsoDate(k[0]) && UUID_RE.test(k[2])) return k as [string, string, string];
  } catch { /* an unreadable cursor is the 400 below */ }
  return null;
}

function invalid(field: string): never {
  throw new BadRequestException({ message: "invalid_field", field });
}

/** `limit` 1 to 100 (default 30) and the opaque `cursor`, read AFTER the decision (BFF §63.0: authorization before validation). */
export function parsePaging(query: { limit?: unknown; cursor?: unknown }): { limit: number; after: [string, string, string] | null } {
  let limit = DESIGN_QUEUE_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== "") {
    const n = typeof query.limit === "string" && /^\d{1,4}$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > DESIGN_QUEUE_MAX_LIMIT) invalid("limit");
    limit = n;
  }
  let after: [string, string, string] | null = null;
  if (query.cursor !== undefined && query.cursor !== "") {
    after = typeof query.cursor === "string" ? decodeCursor(query.cursor) : null;
    if (!after) invalid("cursor");
  }
  return { limit, after };
}

/** Every post at a designer's step in the company, with what Cerbos and the narrowing need, narrowed to the caller's two facts. */
async function loadNarrowedCandidates(tenantId: string, callerId: string, designer: boolean): Promise<{ posts: Candidate[]; approverIds: string[]; engagements: EngagementRow[]; samples: Map<string, ApprovalSample[]>; today: string }> {
  const today = todayIsoInTz(config.reportsTz);
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const { rows } = await c.query<{
      id: string; engagement_id: string; client_name: string; title: string; format: string | null; pipeline_status: string;
      change_by: string | null; change_kind: string | null; return_to: string | null; changed_only: boolean; blocked_from: string | null;
      block_waiting_on: string | null; change_note: string | null; creative_source: string; creative_state: string | null;
      creative_request_id: string | null; status_since: Date | null; ready_by: string; owner_id: string | null; author_id: string | null;
      thumb_file_id: string | null;
    }>(
      `SELECT p.id::text AS id, p.engagement_id::text AS engagement_id, cl.name AS client_name, p.title, p.format, p.pipeline_status,
              p.change_by, p.change_kind, p.return_to, p.changed_only, p.blocked_from, p.block_waiting_on, p.change_note,
              p.creative_source, p.creative_state, p.creative_request_id::text AS creative_request_id, p.status_since,
              to_char(cy.ready_by, 'YYYY-MM-DD') AS ready_by, e.owner_id::text AS owner_id, p.author_id::text AS author_id,
              (SELECT d.file_id::text FROM social_post_designs d
                WHERE d.tenant_id = p.tenant_id AND d.post_id = p.id AND d.removed_at IS NULL AND d.file_id IS NOT NULL
                ORDER BY d.position, d.added_at LIMIT 1) AS thumb_file_id
         FROM social_posts p
         JOIN social_cycles cy ON cy.id = p.cycle_id AND cy.tenant_id = p.tenant_id AND cy.deleted_at IS NULL
         JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
         JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
        WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.pipeline_status IS NOT NULL
          AND (p.pipeline_status = 'design' OR (p.pipeline_status = 'changes' AND p.change_kind = 'design'))
          AND p.creative_source IN ('creatives', 'in_team')`,
      [tenantId],
    );

    // Fact 1: the month request's PM task names the caller. One read per distinct request (a client's cycle has one).
    const assignees = new Map<string, string[]>();
    for (const requestId of new Set(rows.filter((r) => r.creative_source === "creatives" && r.creative_request_id).map((r) => r.creative_request_id as string))) {
      assignees.set(requestId, (await loadAuthFacts(c, tenantId, requestId))?.assigneeIds ?? []);
    }
    const mine = rows.filter((r) =>
      r.creative_source === "in_team"
        ? designer // Fact 2: a holder of social_designer.
        : !!r.creative_request_id && (assignees.get(r.creative_request_id) ?? []).includes(callerId.toLowerCase()));

    const posts: Candidate[] = mine.map((r) => ({
      id: r.id, engagementId: r.engagement_id, clientName: r.client_name, title: r.title, format: r.format, status: r.pipeline_status,
      changeBy: r.change_by, changeKind: r.change_kind, returnTo: r.return_to, changedOnly: r.changed_only === true,
      blockedFrom: r.blocked_from, blockWaitingOn: r.block_waiting_on,
      changeNote: r.pipeline_status === "changes" ? r.change_note : null,
      creativeSource: r.creative_source as "creatives" | "in_team", creativeState: r.creative_state,
      statusSince: r.status_since ? new Date(r.status_since).toISOString() : "", readyBy: r.ready_by,
      ownerId: r.owner_id ?? "", authorId: r.author_id ?? "",
      assigneeIds: r.creative_request_id ? assignees.get(r.creative_request_id) ?? [] : [],
      thumbFileId: r.thumb_file_id,
    }));
    if (posts.length === 0) return { posts, approverIds: [], engagements: [], samples: new Map(), today };

    const approverIds = await loadSocialApproverIds(c, tenantId);
    const engagementIds = [...new Set(posts.map((p) => p.engagementId))];
    const engagements = await readEngagements(c, tenantId, engagementIds, { includeClosed: true });
    const samples = await readApprovalSamples(c, tenantId, engagementIds, today, config.reportsTz);
    return { posts, approverIds, engagements, samples, today };
  }, { modules: ["social"] });
}

/** `design` on each post's real resource: the caller's decision, and for a delegated call the person's too (`authorize()`'s intersection). */
async function designAllowed(principal: Principal, tenantId: string, posts: readonly Candidate[], approverIds: string[]): Promise<boolean[]> {
  const resources = posts.map((p) => socialPostResource(tenantId, {
    postId: p.id, engagementId: p.engagementId, pipelineStatus: p.status, ownerId: p.ownerId, creatorId: p.authorId,
    approverIds, assigneeIds: p.assigneeIds, creativeSource: p.creativeSource,
  }));
  const mine = await checkMany(principal, resources, "design");
  if (principal.actFor && principal.actFor.userId !== principal.userId) {
    const theirs = await assemblePrincipal(principal.actFor.userId, principal.assurance);
    const other = theirs ? await checkMany({ ...theirs, via: principal.via }, resources, "design") : resources.map(() => false);
    return mine.map((v, i) => v && other[i]);
  }
  return mine;
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialDesignQueueController {
  @Get("design-queue")
  async designQueue(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() query: { limit?: unknown; cursor?: unknown },
  ): Promise<{ items: DesignQueueItem[]; nextCursor: string | null }> {
    // The door: every member holds `read` on a work request. The rows are narrowed below.
    await authorize(req.principal, { kind: "work_request", tenantId }, "read");
    const { limit, after } = parsePaging(query ?? {});
    const callerId = req.principal.userId;
    if (!callerId) return { items: [], nextCursor: null };

    const data = await loadNarrowedCandidates(tenantId, callerId, holdsSocialDesigner(req.principal, tenantId));
    const allowed = data.posts.length ? await designAllowed(req.principal, tenantId, data.posts, data.approverIds) : [];
    const queue = data.posts.filter((_, i) => allowed[i]).sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
    const rest = after ? queue.filter((p) => compareKeys(keyOf(p), after) > 0) : queue;
    const page = rest.slice(0, limit);
    const nextCursor = rest.length > limit ? encodeCursor(keyOf(page[page.length - 1])) : null;
    if (page.length === 0) return { items: [], nextCursor: null };

    // Health for the page only: the cycle table's own maths on each post's step, ready-by and its client's estimates.
    const byEngagement = new Map(data.engagements.map((e) => [e.id, e]));
    const info = await loadCalendarInfo(tenantId, [data.today, ...page.map((p) => p.readyBy), addDays(data.today, -100)], HEALTH_LOOKBACK_DAYS);
    const items = page.map((p): DesignQueueItem => {
      const e = byEngagement.get(p.engagementId);
      const estimates = e?.stepEstimates ?? {};
      const clientSlower = isClientSlower(averageApprovalDays(data.samples.get(p.engagementId) ?? [], info.calendar), estimates.client);
      return {
        postId: p.id, clientName: p.clientName, title: p.title, format: p.format, creativeState: p.creativeState,
        revisionNote: p.changeNote, readyBy: p.readyBy,
        health: postHealth({
          today: data.today, readyBy: p.readyBy, calendar: info.calendar, estimates, clientSlower,
          post: {
            status: p.status, changeBy: p.changeBy, changeKind: p.changeKind, returnTo: p.returnTo, changedOnly: p.changedOnly,
            blockedFrom: p.blockedFrom, blockWaitingOn: p.blockWaitingOn,
          },
        }),
        thumbFileId: p.thumbFileId,
      };
    });
    return { items, nextCursor };
  }
}
