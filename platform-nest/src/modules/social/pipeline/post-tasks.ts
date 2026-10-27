// SCP-1n — the PM tasks that point at one post (`pm_tasks.linked_type = 'social_post'`, FRONTEND-BFF-CONTRACT §63.13), for `GET posts/:postId/pipeline`'s
// `tasks`. The tasks are PM rows (plain tenant wall), so the post's audience is not the tasks' audience: each task is listed only when the caller may read
// it as a PM task (`pm_task` · `read`, and the person they act for, when they act for one: the intersection `authorize()` applies). The list is the
// post's own: a content-month task points at a cycle, never at a post, so it is not here.
import type { PoolClient } from "pg";
import type { Principal } from "../../../rbac/principal";
import { assemblePrincipal } from "../../../rbac/principal";
import { checkMany, type Resource } from "../../../rbac/cerbos";

/** At most this many tasks are listed on a post (an ordinary post has a handful). */
export const POST_TASKS_LIMIT = 50;

export interface PostTask {
  id: string;
  title: string;
  /** The task's status id in its own project's registry. */
  status: string;
  progress: number;
  dueDate: string | null;
  projectId: string;
  ball: { id: string; name: string } | null;
}

async function readAllowed(principal: Principal, resources: readonly Resource[]): Promise<boolean[]> {
  const own = await checkMany(principal, resources, "read");
  if (!principal.actFor || principal.actFor.userId === principal.userId) return own;
  const onBehalfOf = await assemblePrincipal(principal.actFor.userId, principal.assurance);
  if (!onBehalfOf) return resources.map(() => false);
  const delegated = await checkMany({ ...onBehalfOf, via: principal.via }, resources, "read");
  return own.map((a, i) => a && delegated[i]);
}

/** The live tasks linked to `postId`, oldest first, that the caller may read. The caller owns the transaction and its tenant scope. */
export async function listPostTasks(c: PoolClient, principal: Principal, tenantId: string, postId: string): Promise<PostTask[]> {
  const { rows } = await c.query<{
    id: string; title: string; status: string; progress: number; due_date: string | null; project_id: string;
    ball_id: string | null; ball_name: string | null;
  }>(
    `SELECT t.id, t.title, t.status, t.progress, to_char(t.due_date, 'YYYY-MM-DD') AS due_date, t.project_id,
            t.assignee->>'refId' AS ball_id, t.assignee->>'refName' AS ball_name
       FROM pm_tasks t
      WHERE t.tenant_id = $1 AND t.linked_type = 'social_post' AND t.linked_id = $2 AND t.deleted_at IS NULL
      ORDER BY t.created_at, t.id
      LIMIT ${POST_TASKS_LIMIT}`,
    [tenantId, postId],
  );
  if (rows.length === 0) return [];
  const allowed = await readAllowed(principal, rows.map((r) => ({ kind: "pm_task", tenantId, id: r.id, projectId: r.project_id })));
  return rows.filter((_, i) => allowed[i]).map((r) => ({
    id: r.id, title: r.title, status: r.status, progress: Number(r.progress), dueDate: r.due_date, projectId: r.project_id,
    ball: r.ball_id ? { id: r.ball_id, name: r.ball_name ?? r.ball_id } : null,
  }));
}
