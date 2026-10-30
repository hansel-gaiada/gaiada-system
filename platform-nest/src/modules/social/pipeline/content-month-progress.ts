// SCP-1n — the content-month task's PROGRESS (FRONTEND-BFF-CONTRACT §63.13). The pipeline writes it; nothing else does. One direction only: a post
// moves the task, and moving the task never moves a post (no PM route reaches the pipeline, and this file never reads a task to decide on a post).
//
// THE FIGURES come from `tallyCounts` (schedule-health.ts), the same counts the deadline table shows: the cycle's live pipeline posts, a story and
// an extra post left out. A post is PAST CLIENT APPROVAL when it is approved, scheduled or live.
//   progress = past ÷ the engagement's target (`posts_per_cycle`), or ÷ the counted posts when it has no target. 0 when there is nothing to divide
//   by. Kept at 99 or below until the task is done (100 is what done means in PM).
//   done     = the cycle has counted posts, every counted post is past client approval, and the target (when there is one) is met. The last clause is
//   this file's reading of §63.13's "done when every counted post is approved": with a target of 12 and 3 posts all approved, the month is not done,
//   and a task that flipped done at the first approval would reopen at the next post it was handed.
//   reopen   = a counted post that goes back to the client (reschedule, client undo, a Composer edit of an approved post) or a new post that is not
//   yet approved makes `done` false, and the PM task is reopened by `setLinkedTaskProgressInTx`.
//
// Called inside the stage action's ONE transaction (the `content_month_progress` effect, after the post's row was written), on a
// `withTenants([tenantId], fn, { modules: ["social"] })` client. A cycle with no content-month task (no project, or planned before SCP-1n) is a no-op.
import type { PoolClient } from "pg";
import { setLinkedTaskProgressInTx } from "../../pm/pm.controller";
import { declareSocialModuleScope } from "../module-scope";
import { readCyclePosts } from "./cycles-data";
import { tallyCounts, type CycleCounts } from "./schedule-health";

export interface ContentMonthFigures { progress: number; done: boolean; counted: number; past: number; target: number | null }

/** PURE. The task's progress and done from the cycle's counts and the engagement's target. */
export function contentMonthFigures(counts: CycleCounts, target: number | null): ContentMonthFigures {
  const past = counts.approved + counts.scheduled + counts.live;
  const goal = target !== null && target > 0 ? target : null;
  const denominator = goal ?? counts.counted;
  const progress = denominator > 0 ? Math.min(100, Math.round((past / denominator) * 100)) : 0;
  const done = counts.counted > 0 && past === counts.counted && (goal === null || counts.counted >= goal);
  return { progress: done ? 100 : Math.min(progress, 99), done, counted: counts.counted, past, target: goal };
}

/** Recompute one cycle's content-month task from its posts. Answers what PM did (`gone` when the cycle has no live task). */
export async function syncContentMonthProgress(
  c: PoolClient, tenantId: string, cycleId: string, actorId: string | null,
): Promise<{ outcome: string; figures: ContentMonthFigures | null }> {
  await declareSocialModuleScope(c);
  // SCP-5f (BFF §63.27.3, the lock order): the task is locked BEFORE the posts are read, so two stage actions on posts of one cycle queue
  // here and the second counts what the first committed. The post (the action's own lock) comes first, this task second, the cycle's
  // step tasks third (`cycle-steps.ts`).
  const task = await c.query<{ id: string }>(
    `SELECT id FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle' AND linked_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [tenantId, cycleId],
  );
  if (!task.rows[0]) return { outcome: "gone", figures: null };
  const target = await c.query<{ posts_per_cycle: number | null }>(
    `SELECT e.posts_per_cycle FROM social_cycles cy JOIN social_engagements e ON e.id = cy.engagement_id AND e.tenant_id = cy.tenant_id
      WHERE cy.tenant_id = $1 AND cy.id = $2`,
    [tenantId, cycleId],
  );
  const raw = target.rows[0]?.posts_per_cycle;
  const figures = contentMonthFigures(tallyCounts(await readCyclePosts(c, tenantId, [cycleId])), raw === null || raw === undefined ? null : Number(raw));
  const r = await setLinkedTaskProgressInTx(c, tenantId, actorId, task.rows[0].id, { progress: figures.progress, done: figures.done });
  return { outcome: r.outcome, figures };
}
