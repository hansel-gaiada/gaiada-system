// SCP-5d — the data side of `GET team?month=YYYY-MM`, the Social Media Team dashboard's one read (BFF §63.19). Every statement runs on a
// caller-owned `withTenants([tenantId], fn, { modules: ["social", "hr"] })` client, one transaction per SECTION (the controller's), so a
// failed statement poisons only the section that issued it, and the page can name what failed (`partial`) instead of drawing it empty.
//
// A handful of statements, never one per post or per person:
//   posts group      `readFeedContext`, `readFeedCandidates` (feed-data.ts, unchanged), `readRequestAssignees`, `readRosterFacts`,
//                    `readSimulatedPipelineIds` (only while simulated rows are left out)         -> needs attention (late, at risk, blocked), waits, workload
//   failed + boosts  `readFailedPosts`, `readBoostsWaiting`                                       -> needs attention (failed posts, boosts waiting)
//   reports          `readReportFacts` (two statements)                                           -> needs attention (report due, report to check)
//   steps            `readStepMoves`                                                              -> step averages
//   unit             `readSocialUnitPeople`                                                       -> who is in the Social Media unit (the privacy gate)
// Every statement starts with `TEAM_TAG`, so a test counts exactly these.
//
// SIMULATED ROWS are counted exactly as `GET overview` counts them (overview-data.ts): a post is simulated by its own mark or any live
// variant's (`SIMULATED_SQL`, the very constant the overview reads), a boost by its own; only while the switch is on.
import type { PoolClient } from "pg";
import { departmentUnits, workspaceSlugFor } from "../../reports/dept-kpis";
import { collectUnitSubtree, loadOrgStructure, loadSeatHoldersByNode, loadUnitRoster } from "../../reports/person-scope";
import { declareSocialModuleScope } from "../module-scope";
import { SCP } from "./fixture";
import { SIMULATED_SQL } from "./overview-data";

export const TEAM_TAG = "/* scp-team */";
const tagged = (sql: string): string => `${TEAM_TAG} ${sql}`;

/** The most rows one list of needs-attention items reads. Far above what a team has open; a hit is reported as a partial section, never cut quietly. */
export const TEAM_ROW_CAP = 1000;

const iso = (v: Date | string): string => new Date(v).toISOString();

// ── simulated posts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The pipeline posts that are simulated (the post's mark or a live variant's). Read only while simulated rows are left out. */
export async function readSimulatedPipelineIds(c: PoolClient, tenantId: string): Promise<Set<string>> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string }>(
    tagged(`SELECT p.id::text AS id FROM social_posts p
             WHERE p.tenant_id = $1::uuid AND p.pipeline_status IS NOT NULL AND p.deleted_at IS NULL AND ${SIMULATED_SQL}`),
    [tenantId],
  );
  return new Set(rows.map((r) => r.id));
}

// ── failed posts and boosts waiting (the overview's two rules, listed instead of counted) ───────────────────────────────────

export interface FailedPostRow { postId: string; engagementId: string; clientName: string; title: string; since: string }

/**
 * The posts `GET overview` counts as Failed posts: not deleted, not archived, on an undeleted engagement, with engine status `failed`
 * (a Composer post and a pipeline post alike) or, on a pipeline post, `partially_published`. `since` is when the row last changed.
 */
export async function readFailedPosts(c: PoolClient, tenantId: string, includeSimulated: boolean): Promise<FailedPostRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; engagement_id: string; client_name: string; title: string | null; since: Date }>(
    tagged(`
    SELECT p.id::text AS id, p.engagement_id::text AS engagement_id, cl.name AS client_name, p.title, p.updated_at AS since
      FROM social_posts p
      JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id AND e.deleted_at IS NULL
      JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
     WHERE p.tenant_id = $1::uuid AND p.deleted_at IS NULL AND p.archived_at IS NULL
       AND ($2::boolean OR NOT ${SIMULATED_SQL})
       AND (p.status = 'failed' OR (p.pipeline_status IS NOT NULL AND p.status = 'partially_published'))
     ORDER BY p.updated_at, p.id
     LIMIT ${TEAM_ROW_CAP + 1}`),
    [tenantId, includeSimulated],
  );
  return rows.map((r) => ({ postId: r.id, engagementId: r.engagement_id, clientName: r.client_name, title: r.title ?? "Untitled post", since: iso(r.since) }));
}

export interface BoostWaitingRow { boostId: string; postId: string; engagementId: string; clientName: string; title: string; since: string }

/**
 * The boosts that wait, for the dashboard's month. Orchestrator ruling for `GET team?month=M` (the contract left it open; the UI and demo follow it):
 * only the boosts whose CYCLE is M's (`social_boosts.cycle_id` -> the cycle whose `month` is M, which is the month the boost starts in, BFF §63.11), with
 * status `requested`, or `approved` and not started. A boost with no cycle belongs to no month and is listed in none. The rest of the rule is
 * `GET overview`'s `boostsWaiting` (undeleted, unarchived posts; simulated boosts only while the switch is on), which counts the whole company, so the
 * overview's number is the sum of the months' lists plus the boosts that have no cycle.
 */
export async function readBoostsWaiting(c: PoolClient, tenantId: string, includeSimulated: boolean, month: string): Promise<BoostWaitingRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; post_id: string; engagement_id: string; client_name: string; title: string | null; since: Date }>(
    tagged(`
    SELECT b.id::text AS id, b.post_id::text AS post_id, p.engagement_id::text AS engagement_id, cl.name AS client_name, p.title,
           CASE WHEN b.status = 'approved' THEN coalesce(b.approved_at, b.requested_at) ELSE b.requested_at END AS since
      FROM social_boosts b
      JOIN social_cycles cy ON cy.id = b.cycle_id AND cy.tenant_id = b.tenant_id AND cy.deleted_at IS NULL AND cy.month = $3::date
      JOIN social_posts p ON p.id = b.post_id AND p.tenant_id = b.tenant_id AND p.deleted_at IS NULL AND p.archived_at IS NULL
      JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
      JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
     WHERE b.tenant_id = $1::uuid AND ($2::boolean OR NOT b.simulated)
       AND (b.status = 'requested' OR (b.status = 'approved' AND b.started_at IS NULL))
     ORDER BY 6, b.id
     LIMIT ${TEAM_ROW_CAP + 1}`),
    [tenantId, includeSimulated, `${month}-01`],
  );
  return rows.map((r) => ({
    boostId: r.id, postId: r.post_id, engagementId: r.engagement_id, clientName: r.client_name, title: r.title ?? "Untitled post", since: iso(r.since),
  }));
}

// ── reports ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReportDueRow { engagementId: string; clientName: string; reportDueDay: number; reportId: string | null }
export interface ReportToCheckRow { reportId: string; engagementId: string; clientName: string; kind: string; period: string | null; since: string }

/**
 * Report due: every engagement of the company that is not closed, has a `report_due_day`, and whose client is not the internal sentinel
 * (no report is ever delivered for it, SMM-23), where the MONTHLY report of `period` (the month BEFORE the dashboard's) is not `delivered` (or does not
 * exist). `reportId` is the row when there is one (draft, in review or ready). Whether the due DAY has been reached is `reportAttention`'s (team.ts).
 * Report to check: reports `in_review`, of any kind. Only the existing `social_reports` columns.
 */
export async function readReportFacts(c: PoolClient, tenantId: string, period: string): Promise<{ due: ReportDueRow[]; toCheck: ReportToCheckRow[] }> {
  await declareSocialModuleScope(c);
  const due = await c.query<{ id: string; client_name: string; report_due_day: number; report_id: string | null }>(
    tagged(`
    SELECT e.id::text AS id, cl.name AS client_name, e.report_due_day, r.id::text AS report_id
      FROM social_engagements e
      JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id AND NOT cl.is_internal
      LEFT JOIN LATERAL (
        SELECT sr.id, sr.status FROM social_reports sr
         WHERE sr.tenant_id = e.tenant_id AND sr.engagement_id = e.id AND sr.kind = 'monthly' AND sr.period = $2 AND sr.deleted_at IS NULL
         ORDER BY (sr.status = 'delivered') DESC, sr.updated_at DESC, sr.id LIMIT 1
      ) r ON true
     WHERE e.tenant_id = $1::uuid AND e.deleted_at IS NULL AND e.status <> 'closed' AND e.report_due_day IS NOT NULL
       AND (r.status IS NULL OR r.status <> 'delivered')
     ORDER BY lower(cl.name), e.id
     LIMIT ${TEAM_ROW_CAP + 1}`),
    [tenantId, period],
  );
  const check = await c.query<{ id: string; engagement_id: string; client_name: string; kind: string; period: string | null; since: Date }>(
    tagged(`
    SELECT sr.id::text AS id, sr.engagement_id::text AS engagement_id, cl.name AS client_name, sr.kind, sr.period, sr.updated_at AS since
      FROM social_reports sr
      JOIN social_engagements e ON e.id = sr.engagement_id AND e.tenant_id = sr.tenant_id AND e.deleted_at IS NULL
      JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
     WHERE sr.tenant_id = $1::uuid AND sr.status = 'in_review' AND sr.deleted_at IS NULL
     ORDER BY sr.updated_at, sr.id
     LIMIT ${TEAM_ROW_CAP + 1}`),
    [tenantId],
  );
  return {
    due: due.rows.map((r) => ({ engagementId: r.id, clientName: r.client_name, reportDueDay: Number(r.report_due_day), reportId: r.report_id })),
    toCheck: check.rows.map((r) => ({ reportId: r.id, engagementId: r.engagement_id, clientName: r.client_name, kind: r.kind, period: r.period, since: iso(r.since) })),
  };
}

// ── who holds what: the roster's facts ──────────────────────────────────────────────────────────────────────────────────────

/** Month request id -> the people on its PM task (§63.3.3 `assigneeIds`): the same facts `readFeedPageExtras` reads, for every request at once. */
export async function readRequestAssignees(c: PoolClient, tenantId: string, requestIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (requestIds.length === 0) return out;
  const { rows } = await c.query<{ a: string; b: string }>(
    tagged(`
    SELECT wr.id::text AS a, u.user_id AS b
      FROM work_requests wr
      JOIN pm_tasks t ON t.id = wr.pm_task_id AND t.deleted_at IS NULL
      CROSS JOIN LATERAL unnest(
        array_remove(
          ARRAY[lower(t.assignee->>'responsibleId'), CASE WHEN t.assignee->>'kind' = 'person' THEN lower(t.assignee->>'refId') END]
          || coalesce((SELECT array_agg(DISTINCT a.user_id::text) FROM pm_task_assignees a
                        WHERE a.tenant_id = $1::uuid AND a.task_id = t.id AND a.user_id IS NOT NULL AND a.valid_to IS NULL), ARRAY[]::text[]),
          NULL)
      ) AS u(user_id)
     WHERE wr.id = ANY($2::uuid[]) AND wr.deleted_at IS NULL`),
    [tenantId, [...requestIds]],
  );
  for (const r of rows) out.set(r.a, [...new Set([...(out.get(r.a) ?? []), r.b.toLowerCase()])]);
  return out;
}

/** The officers of the company: the owners of its engagements that are not closed (a person who has no post held yet still has a row). */
export async function readRosterFacts(c: PoolClient, tenantId: string): Promise<{ officerIds: string[] }> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string }>(
    tagged(`SELECT DISTINCT e.owner_id::text AS id FROM social_engagements e
             WHERE e.tenant_id = $1::uuid AND e.deleted_at IS NULL AND e.status <> 'closed' AND e.owner_id IS NOT NULL`),
    [tenantId],
  );
  return { officerIds: rows.map((r) => r.id.toLowerCase()).sort() };
}

/** Display names for `ids` (id and name only: nothing else of a person is ever read for this page). */
export async function readNames(c: PoolClient, ids: readonly string[]): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const { rows } = await c.query<{ id: string; name: string | null }>(tagged(`SELECT id::text AS id, name FROM users WHERE id = ANY($1::uuid[])`), [list]);
  return new Map(rows.map((r) => [r.id.toLowerCase(), r.name && r.name.trim() ? r.name : "Someone"]));
}

// ── step averages ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StepMove { step: string; enteredOn: string; leftOn: string }

/**
 * The month's stage moves. A stage action writes one `activities` row (verb = the action, `metadata.from` / `metadata.to` = the statuses; the
 * machine's own record, pipeline.service.ts `afterCommit`), so a post's time in a step is the gap between the row that took it in and the row that
 * took it out. The row that took it in is the post's previous status-changing row, found over the post's WHOLE history (a post may have entered
 * its step long before the month). Only moves that LEFT a step inside `[from, to]` (company days in `tz`) are returned; a post whose first row is
 * not its creation has no known entry and no move for its first step. Simulated posts are left out while the switch is off.
 */
export async function readStepMoves(
  c: PoolClient, tenantId: string, a: { tz: string; from: string; to: string; includeSimulated: boolean },
): Promise<StepMove[]> {
  await declareSocialModuleScope(c);
  const statuses = [...SCP.statuses];
  const { rows } = await c.query<{ step: string; entered_on: string; left_on: string }>(
    tagged(`
    WITH moved AS (
      SELECT x.target_entity_id AS post_id, x.id, x.occurred_at, x.metadata->>'from' AS from_status
        FROM activities x
       WHERE x.tenant_id = $1::uuid AND x.target_entity_type = 'social_post'
         AND (x.metadata->>'to') = ANY($2::text[])
         AND (x.metadata->>'from' IS NULL OR ((x.metadata->>'from') = ANY($2::text[]) AND (x.metadata->>'from') <> (x.metadata->>'to')))
         AND x.target_entity_id IN (SELECT m.target_entity_id FROM activities m
                                     WHERE m.tenant_id = $1::uuid AND m.target_entity_type = 'social_post'
                                       AND (m.occurred_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date)
    ), steps AS (
      SELECT post_id, from_status, occurred_at AS left_at,
             lag(occurred_at) OVER (PARTITION BY post_id ORDER BY occurred_at, id) AS entered_at
        FROM moved
    )
    SELECT s.from_status AS step,
           to_char(s.entered_at AT TIME ZONE $3, 'YYYY-MM-DD') AS entered_on,
           to_char(s.left_at AT TIME ZONE $3, 'YYYY-MM-DD') AS left_on
      FROM steps s
      JOIN social_posts p ON p.id = s.post_id AND p.tenant_id = $1::uuid AND p.pipeline_status IS NOT NULL
     WHERE s.from_status IS NOT NULL AND s.entered_at IS NOT NULL
       AND (s.left_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date
       AND ($6::boolean OR NOT ${SIMULATED_SQL})`),
    [tenantId, statuses, a.tz, a.from, a.to, a.includeSimulated],
  );
  return rows.map((r) => ({ step: r.step, enteredOn: r.entered_on, leftOn: r.left_on }));
}

// ── the Social Media unit's people (the privacy gate) ──────────────────────────────────────────────────────────────────────

/** PURE. The node ids of the company's Social Media unit(s): the departments whose workspace slug is `social-media` (never a hard-coded id, PV-D13). */
export function socialMediaUnitIds(structure: unknown, vertical: string | null): string[] {
  return departmentUnits(structure).filter((u) => workspaceSlugFor(vertical, u.name) === "social-media").map((u) => u.id).sort();
}

/**
 * Who is IN the Social Media unit (BFF §63.19): every person placed there, or in a unit under it, today (the primary membership, DW-4b's roster),
 * and the holders of a live lead seat on those units (a head is in the unit they head, placed or not). Lower-case user ids. The four count as
 * that unit's heads on this read, so these rows are shown to them; anybody else is judged by the DW-4 person-axis gate.
 */
export async function readSocialUnitPeople(c: PoolClient, tenantId: string, today: string): Promise<Set<string>> {
  const vertical = (await c.query<{ vertical: string | null }>(tagged(`SELECT vertical FROM companies WHERE id = $1::uuid`), [tenantId])).rows[0]?.vertical ?? null;
  const structure = await loadOrgStructure(c, tenantId);
  const subtree = new Set<string>();
  for (const unit of socialMediaUnitIds(structure, vertical)) for (const id of collectUnitSubtree(structure, unit)) subtree.add(id);
  const people = new Set<string>();
  if (subtree.size === 0) return people;
  for (const id of await loadUnitRoster(c, tenantId, [...subtree], today)) people.add(id.toLowerCase());
  for (const holders of (await loadSeatHoldersByNode(c, tenantId, [...subtree])).values()) for (const id of holders) people.add(id.toLowerCase());
  return people;
}
