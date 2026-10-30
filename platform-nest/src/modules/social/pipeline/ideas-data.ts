// SCP-5 W5-B2 — the rows of "Ideas for next month" (FRONTEND-BFF-CONTRACT §63.25; table `social_ideas`, migration 202610301100). Every
// function takes the caller's client: the caller owns the transaction, its tenant scope and its row locks. `social_ideas` carries the
// third wall, so each caller runs inside `withTenants([tenantId], …, { modules: ["social"] })` and each reader declares the scope itself.
//
// The writes keep the table's CHECKs true by construction (they are the second line, not the first):
//   planned ⇔ post_id ⇔ cycle_id ⇔ planned_at ⇔ planned_by;  shared_at ⇔ shared_by;  deleted_at ⇔ deleted_by;
//   a shared idea has shared_at; a planned idea is never deleted.
import type { PoolClient } from "pg";
import { config } from "../../../config";
import { declareSocialModuleScope } from "../module-scope";
import { userNames } from "./pipeline-data";
import type { IdeaAnswer, type IdeaPatch, type IdeaStatus } from "./ideas";

/** A `social_ideas` row, the columns the routes read. Dates are ISO strings. */
export interface IdeaRow {
  id: string;
  engagement_id: string;
  saw: string;
  metric: string | null;
  suggestion: string;
  status: IdeaStatus;
  report_id: string | null;
  cycle_id: string | null;
  post_id: string | null;
  shared_at: string | null;
  shared_by: string | null;
  planned_at: string | null;
  planned_by: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

const IDEA_COLUMNS = `i.id::text AS id, i.engagement_id::text AS engagement_id, i.saw, i.metric, i.suggestion, i.status,
  i.report_id::text AS report_id, i.cycle_id::text AS cycle_id, i.post_id::text AS post_id,
  to_char(i.shared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS shared_at, i.shared_by::text AS shared_by,
  to_char(i.planned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS planned_at, i.planned_by::text AS planned_by,
  i.created_by::text AS created_by,
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(i.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deleted_at`;

/** The idea, LIVE (not deleted), or null. `lock` takes the row lock "Add to next plan", share, edit and delete hold for their decision. */
export async function loadIdea(c: PoolClient, tenantId: string, ideaId: string, lock = false): Promise<IdeaRow | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<IdeaRow>(
    `SELECT ${IDEA_COLUMNS} FROM social_ideas i WHERE i.tenant_id = $1 AND i.id = $2 AND i.deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, ideaId],
  );
  return rows[0] ?? null;
}

/** The idea by id, deleted or not: the create's replay test ("an `id` used for another client is 400"). */
export async function loadIdeaAnyState(c: PoolClient, tenantId: string, ideaId: string): Promise<IdeaRow | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<IdeaRow>(`SELECT ${IDEA_COLUMNS} FROM social_ideas i WHERE i.tenant_id = $1 AND i.id = $2`, [tenantId, ideaId]);
  return rows[0] ?? null;
}

/** Whether `reportId` is a live MONTHLY report of this client (63.25.3: 400 `{field: 'reportId'}` otherwise). */
export async function isMonthlyReportOf(c: PoolClient, tenantId: string, engagementId: string, reportId: string): Promise<boolean> {
  await declareSocialModuleScope(c);
  const r = await c.query(
    `SELECT 1 FROM social_reports WHERE tenant_id = $1 AND id = $2 AND engagement_id = $3 AND kind = 'monthly' AND deleted_at IS NULL`,
    [tenantId, reportId, engagementId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** INSERT; `created` is false when the id already existed (a racing replay). */
export async function insertIdea(
  c: PoolClient, a: { tenantId: string; id: string; engagementId: string; saw: string; metric: string | null; suggestion: string; reportId: string | null; actorId: string },
): Promise<boolean> {
  await declareSocialModuleScope(c);
  const r = await c.query(
    `INSERT INTO social_ideas (id, tenant_id, engagement_id, saw, metric, suggestion, status, report_id, created_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
    [a.id, a.tenantId, a.engagementId, a.saw, a.metric, a.suggestion, a.reportId, a.actorId, config.originSite],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The patch's columns, on a LIVE idea the caller holds locked and has found not planned. */
export async function updateIdeaText(c: PoolClient, tenantId: string, ideaId: string, patch: IdeaPatch): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [tenantId, ideaId];
  for (const [k, v] of Object.entries(patch)) {
    vals.push(v);
    cols.push(`${k} = $${vals.length}`);
  }
  if (!cols.length) return;
  await c.query(`UPDATE social_ideas SET ${cols.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, vals);
}

/** proposed → shared. */
export async function markIdeaShared(c: PoolClient, tenantId: string, ideaId: string, actorId: string): Promise<void> {
  await c.query(
    `UPDATE social_ideas SET status = 'shared', shared_at = now(), shared_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, ideaId, actorId],
  );
}

/** A soft delete of a LIVE idea that is not planned (the CHECK refuses a planned one). */
export async function softDeleteIdea(c: PoolClient, tenantId: string, ideaId: string, actorId: string): Promise<void> {
  await c.query(
    `UPDATE social_ideas SET deleted_at = now(), deleted_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, ideaId, actorId],
  );
}

/** "Add to next plan": the idea becomes `planned` with its cycle, post and planner, in the caller's transaction (the post was just inserted in it). */
export async function markIdeaPlanned(
  c: PoolClient, a: { tenantId: string; ideaId: string; cycleId: string; postId: string; actorId: string },
): Promise<void> {
  await c.query(
    `UPDATE social_ideas SET status = 'planned', cycle_id = $3, post_id = $4, planned_at = now(), planned_by = $5, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [a.tenantId, a.ideaId, a.cycleId, a.postId, a.actorId],
  );
}

/**
 * THE DISCARD EFFECT `release_idea` (63.25.1; fixture, both twins): the discarded post's idea goes back to `shared` when it had been shared, else
 * `proposed`, with its post, cycle and planned fields cleared; and the post's own `idea_id` is cleared, because `ux_social_posts_idea` counts
 * a soft-deleted row too and would otherwise refuse to plan the idea again. Runs in the stage action's own transaction, with the post row
 * already locked. A post with no idea is a no-op. Returns the released idea's id, or null.
 */
export async function releaseIdeaOfPost(c: PoolClient, tenantId: string, postId: string): Promise<string | null> {
  await declareSocialModuleScope(c);
  const r = await c.query<{ id: string }>(
    `UPDATE social_ideas
        SET status = CASE WHEN shared_at IS NULL THEN 'proposed' ELSE 'shared' END,
            post_id = NULL, cycle_id = NULL, planned_at = NULL, planned_by = NULL, updated_at = now()
      WHERE tenant_id = $1 AND post_id = $2
      RETURNING id::text AS id`,
    [tenantId, postId],
  );
  await c.query(`UPDATE social_posts SET idea_id = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND idea_id IS NOT NULL`, [tenantId, postId]);
  return r.rows[0]?.id ?? null;
}

/** The client's live ideas, newest first, at most 200, each with its post and cycle month. */
export async function readIdeas(
  c: PoolClient, tenantId: string, engagementId: string, f: { status: IdeaStatus | null; reportId: string | null },
): Promise<IdeaAnswer[]> {
  await declareSocialModuleScope(c);
  const vals: unknown[] = [tenantId, engagementId];
  let where = "";
  if (f.status) { vals.push(f.status); where += ` AND i.status = $${vals.length}`; }
  if (f.reportId) { vals.push(f.reportId); where += ` AND i.report_id = $${vals.length}`; }
  const { rows } = await c.query<IdeaRow & { post_title: string | null; post_pipeline_status: string | null; cycle_month: string | null }>(
    `SELECT ${IDEA_COLUMNS}, p.title AS post_title, p.pipeline_status AS post_pipeline_status, to_char(sc.month, 'YYYY-MM') AS cycle_month
       FROM social_ideas i
       LEFT JOIN social_posts p ON p.id = i.post_id AND p.tenant_id = i.tenant_id
       LEFT JOIN social_cycles sc ON sc.id = i.cycle_id AND sc.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1 AND i.engagement_id = $2 AND i.deleted_at IS NULL${where}
      ORDER BY i.created_at DESC, i.id DESC LIMIT 200`,
    vals,
  );
  return answersOf(c, rows);
}

/** One idea as the routes answer it. */
export async function readIdea(c: PoolClient, tenantId: string, ideaId: string): Promise<IdeaAnswer | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<IdeaRow & { post_title: string | null; post_pipeline_status: string | null; cycle_month: string | null }>(
    `SELECT ${IDEA_COLUMNS}, p.title AS post_title, p.pipeline_status AS post_pipeline_status, to_char(sc.month, 'YYYY-MM') AS cycle_month
       FROM social_ideas i
       LEFT JOIN social_posts p ON p.id = i.post_id AND p.tenant_id = i.tenant_id
       LEFT JOIN social_cycles sc ON sc.id = i.cycle_id AND sc.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1 AND i.id = $2 AND i.deleted_at IS NULL`,
    [tenantId, ideaId],
  );
  return rows.length ? (await answersOf(c, rows))[0] : null;
}

async function answersOf(
  c: PoolClient, rows: Array<IdeaRow & { post_title: string | null; post_pipeline_status: string | null; cycle_month: string | null }>,
): Promise<IdeaAnswer[]> {
  const names = await userNames(c, rows.flatMap((r) => [r.created_by, r.shared_by]));
  const person = (id: string) => ({ id, name: names.get(id) ?? "Someone" });
  return rows.map((r) => ({
    id: r.id,
    engagementId: r.engagement_id,
    saw: r.saw,
    metric: r.metric,
    suggestion: r.suggestion,
    status: r.status,
    reportId: r.report_id,
    post: r.post_id ? { id: r.post_id, title: r.post_title ?? "", pipelineStatus: r.post_pipeline_status, cycleMonth: r.cycle_month } : null,
    sharedAt: r.shared_at,
    sharedBy: r.shared_by ? person(r.shared_by) : null,
    createdBy: person(r.created_by),
    createdAt: r.created_at,
  }));
}

/** The post's idea for the post read (63.25.4): `{id, saw, metric, suggestion}` or null. Reads through the post's own pointer. */
export async function readPostIdea(c: PoolClient, tenantId: string, postId: string): Promise<{ id: string; saw: string; metric: string | null; suggestion: string } | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; saw: string; metric: string | null; suggestion: string }>(
    `SELECT i.id::text AS id, i.saw, i.metric, i.suggestion
       FROM social_posts p JOIN social_ideas i ON i.id = p.idea_id AND i.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [tenantId, postId],
  );
  return rows[0] ?? null;
}
