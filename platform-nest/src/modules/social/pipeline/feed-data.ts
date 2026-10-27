// SCP-1d / SCP-1j — the data side of the Social feed, Messages and Needs you (BFF §63.7). Everything runs on a caller-owned
// `withTenants([tenantId], fn, { modules: ["social", "hr"] })` client: the social tables carry the third wall, and the one holiday read
// goes through the hr scope the same transaction declares (so it needs no second transaction of its own).
//
// THE BAR (§63.7): fast at 600 posts, at most THREE SQL queries and TWO Cerbos calls a page.
//   Q1  `readFeedContext`  one statement: the seat facts `loadSocialApproverIds` reads (the company's vertical, its org tree and every
//                          live lead seat), the default holiday calendar and its holidays, and the client's decided reviews of the
//                          last 90 days for the engagements that have a post with the client. Pure arithmetic follows in JS, with the
//                          helpers `cycles-data.ts` uses.
//   Q2  `readFeedCandidates` one statement: the posts, narrowed by ONE SQL mirror of the relationship facts of §63.3.3 (the officer is
//                          the engagement's owner; a Creatives designer an assignee of the month request's PM task), with their
//                          engagement, client, cycle and the caller's own assignee flag. Health is JS (it needs the calendar), so the
//                          whole narrowed set is read, sorted, and only a page of it is carried on.
//   Q3  `readFeedPageExtras` one statement for the page: each post's thumbnail and each month request's assignees (the Cerbos
//                          resource's `assigneeIds`).
// Plus one Cerbos call: `authorize(read)` is the first, and `checkEach` the second (one request holding the page, each post with the
// action its primary step needs).
//
// Every statement below starts with `FEED_TAG`, so a test counts exactly these queries (the shared auth path issues its own).
import type { PoolClient } from "pg";
import { socialApproverUnitIds } from "../pipeline-authz";
import { declareSocialModuleScope } from "../module-scope";
import { APPROVAL_WINDOW_DAYS, type ApprovalSample } from "./schedule-health";
import type { WorkingCalendar } from "../../hr/working-days";

export const FEED_TAG = "/* scp-feed */";
/** The most candidate posts one feed reads (the narrowed set before health sorts it): far above the 600 of the bar, a guard not a page size. */
export const FEED_CANDIDATE_CAP = 5000;

const tagged = (sql: string): string => `${FEED_TAG} ${sql}`;

// ── Q1: the context ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FeedContext {
  /** The live lead-seat holders of the company's Social Media and GM units: exactly `loadSocialApproverIds`'s answer. */
  approverIds: string[];
  calendar: WorkingCalendar;
  /** The decided reviews of the last 90 days, per engagement (only the engagements with a post with the client). */
  samples: Map<string, ApprovalSample[]>;
}

/** The holiday window: far enough back for a late post's ready-by and the handoff walk behind it, and ahead of the longest ready-by. */
export const FEED_WINDOW_BEHIND_DAYS = 500;
export const FEED_WINDOW_AHEAD_DAYS = 270;

export async function readFeedContext(
  c: PoolClient, tenantId: string, a: { today: string; from: string; to: string; tz: string },
): Promise<FeedContext> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{
    vertical: string | null; structure: unknown; seats: Array<{ unit: string; user: string }> | null;
    weekend_days: number[] | null; has_calendar: boolean; holidays: Array<{ day: string; kind: "public" | "joint_leave" | "company" }> | null;
    samples: Array<{ e: string; r: string; d: string }> | null;
  }>(
    tagged(`
    WITH cal AS (
      SELECT id, weekend_days FROM hr_holiday_calendars WHERE tenant_id = $1::uuid AND is_default AND deleted_at IS NULL LIMIT 1
    )
    SELECT
      (SELECT vertical FROM companies WHERE id = $1::uuid) AS vertical,
      (SELECT structure FROM company_org_structure WHERE tenant_id = $1::uuid) AS structure,
      (SELECT coalesce(json_agg(json_build_object('unit', s.unit, 'user', s.user_id)), '[]'::json)
         FROM (SELECT DISTINCT p.unit_node_id AS unit, pa.user_id::text AS user_id
                 FROM positions p
                 JOIN position_assignments pa ON pa.position_id = p.id AND pa.tenant_id = p.tenant_id
                 JOIN position_roles pr ON pr.position_id = p.id AND pr.tenant_id = p.tenant_id AND pr.scope_kind = 'own_unit'
                 JOIN roles r ON r.id = pr.role_id AND r.name = 'org_unit_lead' AND (r.company_id IS NULL OR r.company_id = p.tenant_id)
                WHERE p.tenant_id = $1::uuid AND p.status = 'active' AND pa.valid_to IS NULL) s) AS seats,
      (SELECT weekend_days FROM cal) AS weekend_days,
      EXISTS (SELECT 1 FROM cal) AS has_calendar,
      (SELECT coalesce(json_agg(json_build_object('day', to_char(h.day, 'YYYY-MM-DD'), 'kind', h.kind)), '[]'::json)
         FROM hr_holidays h
        WHERE h.tenant_id = $1::uuid AND h.calendar_id = (SELECT id FROM cal) AND h.day BETWEEN $2::date AND $3::date) AS holidays,
      (SELECT coalesce(json_agg(json_build_object('e', x.engagement_id, 'r', x.requested_on, 'd', x.decided_on)), '[]'::json)
         FROM (SELECT p.engagement_id::text AS engagement_id,
                      to_char((r.requested_at AT TIME ZONE $4), 'YYYY-MM-DD') AS requested_on,
                      to_char((r.decided_at AT TIME ZONE $4), 'YYYY-MM-DD') AS decided_on
                 FROM social_post_client_reviews r
                 JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
                 JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
                WHERE r.tenant_id = $1::uuid
                  AND p.engagement_id IN (SELECT w.engagement_id FROM social_posts w
                                           WHERE w.tenant_id = $1::uuid AND w.pipeline_status = 'client'
                                             AND w.deleted_at IS NULL AND w.archived_at IS NULL)
                  AND r.status IN ('approved', 'changes_requested') AND r.decided_at IS NOT NULL
                  AND (r.decided_at AT TIME ZONE $4)::date > ($5::date - ${APPROVAL_WINDOW_DAYS})
                  AND (r.decided_at AT TIME ZONE $4)::date <= $5::date) x) AS samples`),
    [tenantId, a.from, a.to, a.tz, a.today],
  );
  const r = rows[0];
  const units = new Set(socialApproverUnitIds(r?.structure ?? null, r?.vertical ?? null));
  const approverIds = [...new Set((r?.seats ?? []).filter((s) => units.has(s.unit)).map((s) => s.user.toLowerCase()))].sort();
  // `loadWorkingCalendar` answers `{}` for a company with no default calendar: the same here.
  const calendar: WorkingCalendar = r?.has_calendar
    ? { weekendDays: r.weekend_days ?? undefined, holidays: (r.holidays ?? []).map((h) => ({ day: h.day, kind: h.kind })) }
    : {};
  const samples = new Map<string, ApprovalSample[]>();
  for (const s of r?.samples ?? []) {
    const list = samples.get(s.e) ?? [];
    list.push({ requestedOn: s.r, decidedOn: s.d });
    samples.set(s.e, list);
  }
  return { approverIds, calendar, samples };
}

// ── Q2: the candidates ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface FeedCandidate {
  id: string;
  engagementId: string;
  clientId: string;
  clientName: string;
  title: string;
  format: string | null;
  isExtra: boolean;
  pipelineStatus: string;
  statusSince: string;
  scheduledAt: string | null;
  authorId: string | null;
  ownerId: string | null;
  simulated: boolean;
  creativeSource: string | null;
  creativeState: string | null;
  creativeRequestId: string | null;
  scheduleVia: string | null;
  changeBy: string | null;
  changeKind: string | null;
  returnTo: string | null;
  changedOnly: boolean;
  blockedFrom: string | null;
  blockWaitingOn: string | null;
  cycleId: string | null;
  readyBy: string | null;
  stepEstimates: unknown;
  /** The caller is an assignee of the post's month request's PM task (a Creatives designer's relationship fact). */
  iAmAssignee: boolean;
}

export interface FeedNarrowing {
  /** `your_turn`: only the posts a relationship to the caller could make theirs. `waiting`: the caller's own clients. `all`: none. */
  view: "your_turn" | "waiting" | "all";
  callerId: string | null;
  isCopywriter: boolean;
  isSeatApprover: boolean;
  isInTeamDesigner: boolean;
  engagementId?: string;
  cycleId?: string;
  officerId?: string;
}

/** The SQL mirror of "is the caller an assignee": §63.3.3 `assigneeIds` (the PM task's responsible person, its ball person, and every open assignee row). */
const I_AM_ASSIGNEE_SQL = `(p.creative_request_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM work_requests wr JOIN pm_tasks t ON t.id = wr.pm_task_id AND t.deleted_at IS NULL
   WHERE wr.id = p.creative_request_id AND wr.deleted_at IS NULL
     AND ($2::text <> '' AND (lower(t.assignee->>'responsibleId') = $2
          OR (t.assignee->>'kind' = 'person' AND lower(t.assignee->>'refId') = $2)
          OR EXISTS (SELECT 1 FROM pm_task_assignees a WHERE a.tenant_id = $1::uuid AND a.task_id = t.id AND a.user_id::text = $2 AND a.valid_to IS NULL)))))`;

export async function readFeedCandidates(c: PoolClient, tenantId: string, n: FeedNarrowing): Promise<FeedCandidate[]> {
  await declareSocialModuleScope(c);
  const caller = (n.callerId ?? "").toLowerCase();
  // The narrowing, on the inner columns. `i_am_assignee` is computed once per row and reused by the outer filter.
  const { rows } = await c.query<{
    id: string; engagement_id: string; client_id: string; client_name: string; title: string; format: string | null; is_extra: boolean; pipeline_status: string;
    status_since: Date; scheduled_at: Date | null; author_id: string | null; owner_id: string | null; simulated: boolean;
    creative_source: string | null; creative_state: string | null; creative_request_id: string | null; schedule_via: string | null;
    change_by: string | null; change_kind: string | null; return_to: string | null; changed_only: boolean; blocked_from: string | null;
    block_waiting_on: string | null; cycle_id: string | null; ready_by: string | null; step_estimates: unknown; i_am_assignee: boolean;
  }>(
    tagged(`
    SELECT * FROM (
      SELECT p.id::text AS id, p.engagement_id::text AS engagement_id, cl.name AS client_name, p.title, p.format, p.is_extra,
             p.pipeline_status, p.status_since, p.scheduled_at, p.author_id::text AS author_id, e.owner_id::text AS owner_id, e.client_id::text AS client_id,
             p.simulated, p.creative_source, p.creative_state, p.creative_request_id::text AS creative_request_id, p.schedule_via,
             p.change_by, p.change_kind, p.return_to, p.changed_only, p.blocked_from, p.block_waiting_on,
             p.cycle_id::text AS cycle_id, to_char(c.ready_by, 'YYYY-MM-DD') AS ready_by, e.step_estimates,
             ${I_AM_ASSIGNEE_SQL} AS i_am_assignee
        FROM social_posts p
        JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id AND e.deleted_at IS NULL
        JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
        LEFT JOIN social_cycles c ON c.id = p.cycle_id AND c.tenant_id = p.tenant_id AND c.deleted_at IS NULL
       WHERE p.tenant_id = $1::uuid AND p.pipeline_status IS NOT NULL AND p.deleted_at IS NULL AND p.archived_at IS NULL
         AND ($3::uuid IS NULL OR p.engagement_id = $3::uuid)
         AND ($4::uuid IS NULL OR p.cycle_id = $4::uuid)
         AND ($5::uuid IS NULL OR e.owner_id = $5::uuid)
         AND ($6::text <> 'waiting' OR e.owner_id::text = $2)
    ) x
     WHERE ($6::text <> 'your_turn'
            OR x.owner_id = $2::text
            OR $7::boolean OR $8::boolean
            OR ($9::boolean AND x.creative_source = 'in_team')
            OR x.i_am_assignee)
     ORDER BY x.id
     LIMIT ${FEED_CANDIDATE_CAP}`),
    [tenantId, caller, n.engagementId ?? null, n.cycleId ?? null, n.officerId ?? null, n.view, n.isCopywriter, n.isSeatApprover, n.isInTeamDesigner],
  );
  return rows.map((r) => ({
    id: r.id, engagementId: r.engagement_id, clientId: r.client_id, clientName: r.client_name, title: r.title, format: r.format, isExtra: r.is_extra,
    pipelineStatus: r.pipeline_status, statusSince: new Date(r.status_since).toISOString(),
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null, authorId: r.author_id, ownerId: r.owner_id,
    simulated: r.simulated, creativeSource: r.creative_source, creativeState: r.creative_state, creativeRequestId: r.creative_request_id,
    scheduleVia: r.schedule_via, changeBy: r.change_by, changeKind: r.change_kind, returnTo: r.return_to, changedOnly: r.changed_only === true,
    blockedFrom: r.blocked_from, blockWaitingOn: r.block_waiting_on, cycleId: r.cycle_id, readyBy: r.ready_by,
    stepEstimates: r.step_estimates, iAmAssignee: r.i_am_assignee === true,
  }));
}

// ── Q3: the page's extras ────────────────────────────────────────────────────────────────────────────────────────────────

export interface FeedPageExtras {
  /** post id -> the file of its first stored design (materialized at the final check), or absent. */
  thumbs: Map<string, string>;
  /** month request id -> the people on its PM task (§63.3.3 `assigneeIds`). */
  assignees: Map<string, string[]>;
}

export async function readFeedPageExtras(c: PoolClient, tenantId: string, postIds: string[], requestIds: string[]): Promise<FeedPageExtras> {
  const thumbs = new Map<string, string>();
  const assignees = new Map<string, string[]>();
  if (postIds.length === 0) return { thumbs, assignees };
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ k: string; a: string; b: string }>(
    tagged(`
    SELECT 'thumb' AS k, d.post_id::text AS a, d.file_id::text AS b
      FROM (SELECT DISTINCT ON (post_id) post_id, file_id
              FROM social_post_designs
             WHERE tenant_id = $1::uuid AND post_id = ANY($2::uuid[]) AND removed_at IS NULL AND file_id IS NOT NULL
             ORDER BY post_id, position) d
    UNION ALL
    SELECT 'assignee' AS k, wr.id::text AS a, u.user_id AS b
      FROM work_requests wr
      JOIN pm_tasks t ON t.id = wr.pm_task_id AND t.deleted_at IS NULL
      CROSS JOIN LATERAL unnest(
        array_remove(
          ARRAY[lower(t.assignee->>'responsibleId'), CASE WHEN t.assignee->>'kind' = 'person' THEN lower(t.assignee->>'refId') END]
          || coalesce((SELECT array_agg(DISTINCT a.user_id::text) FROM pm_task_assignees a
                        WHERE a.tenant_id = $1::uuid AND a.task_id = t.id AND a.user_id IS NOT NULL AND a.valid_to IS NULL), ARRAY[]::text[]),
          NULL)
      ) AS u(user_id)
     WHERE wr.id = ANY($3::uuid[]) AND wr.deleted_at IS NULL`),
    [tenantId, postIds, requestIds],
  );
  for (const r of rows) {
    if (r.k === "thumb") thumbs.set(r.a, r.b);
    else assignees.set(r.a, [...new Set([...(assignees.get(r.a) ?? []), r.b.toLowerCase()])]);
  }
  return { thumbs, assignees };
}

// ── Messages and Needs you ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The latest follow-up of each (post, holder role): the `follow_up` activity rows (`metadata.holder` is the role the post was held by when the
 * follow-up was sent, written by the action route). Keyed `<postId>|<holder role>`; ISO timestamps. Not part of the feed's bar.
 */
export async function readLastFollowUps(c: PoolClient, tenantId: string, postIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (postIds.length === 0) return out;
  const { rows } = await c.query<{ post_id: string; holder: string | null; at: Date }>(
    tagged(`
    SELECT target_entity_id::text AS post_id, metadata->>'holder' AS holder, max(occurred_at) AS at
      FROM activities
     WHERE tenant_id = $1::uuid AND target_entity_type = 'social_post' AND verb = 'follow_up' AND target_entity_id = ANY($2::uuid[])
     GROUP BY 1, 2`),
    [tenantId, postIds],
  );
  for (const r of rows) out.set(`${r.post_id}|${r.holder ?? ""}`, new Date(r.at).toISOString());
  return out;
}

export interface MetricsMissingRow { id: string; engagementId: string; clientName: string; title: string; wentLiveAt: string }

/** The officer's posts live for two days or more with no metrics snapshot on any of their variants (plan §6.4 "metrics missing"). */
export async function readMetricsMissing(c: PoolClient, tenantId: string, officerId: string): Promise<MetricsMissingRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; engagement_id: string; client_name: string; title: string; went_live_at: Date }>(
    tagged(`
    SELECT p.id::text AS id, p.engagement_id::text AS engagement_id, cl.name AS client_name, p.title, p.went_live_at
      FROM social_posts p
      JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id AND e.deleted_at IS NULL
      JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
     WHERE p.tenant_id = $1::uuid AND p.pipeline_status = 'live' AND p.deleted_at IS NULL AND p.archived_at IS NULL
       AND e.owner_id::text = $2 AND p.went_live_at IS NOT NULL AND p.went_live_at <= now() - interval '2 days'
       AND NOT EXISTS (SELECT 1 FROM social_post_metrics m
                         JOIN social_post_variants v ON v.id = m.variant_id AND v.tenant_id = m.tenant_id
                        WHERE v.post_id = p.id AND v.tenant_id = p.tenant_id)
     ORDER BY p.went_live_at, p.id
     LIMIT 200`),
    [tenantId, officerId.toLowerCase()],
  );
  return rows.map((r) => ({ id: r.id, engagementId: r.engagement_id, clientName: r.client_name, title: r.title, wentLiveAt: new Date(r.went_live_at).toISOString() }));
}
