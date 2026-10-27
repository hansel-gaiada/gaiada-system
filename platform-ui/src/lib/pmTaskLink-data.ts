import "server-only";
// SCP-1n (BFF §63.13): the task drawer's link to the social post or the client's content month. One egress per fact, every answer a `ReadResult`
// folded to "no link" on anything but ok: a link that cannot be resolved is simply not offered (the page never claims a link that is not there).
//   - the Social Media department comes from the org structure (`listDepartmentBriefs`, memoised with the shell's own read);
//   - a content-month task's client comes from `GET cycles/:cycleId/health` (BFF §63.5; `social_post` · `read`), whose answer names the engagement.
import { platformFetch } from "./platform";
import { listDepartmentBriefs } from "./departments";
import { readResult } from "./readResult";
import { pickSocialDeptId, taskLinkTarget, type TaskLink, type TaskLinkTarget } from "./pmTaskLink";

export async function readTaskSocialLink(
  userId: string, tenantId: string, vertical: string | null | undefined, task: TaskLink,
): Promise<TaskLinkTarget | null> {
  if (!task.linkedType || !task.linkedId) return null;
  const depts = await readResult(listDepartmentBriefs(userId, tenantId));
  if (depts.kind !== "ok") return null;
  const deptId = pickSocialDeptId(depts.data, vertical);
  if (!deptId) return null;
  let engagementId: string | null = null;
  if (task.linkedType === "social_cycle") {
    const health = await readResult(
      platformFetch<{ engagementId?: unknown }>(`/api/${encodeURIComponent(tenantId)}/modules/social/cycles/${encodeURIComponent(task.linkedId)}/health`, userId),
    );
    if (health.kind !== "ok") return null;
    engagementId = typeof health.data?.engagementId === "string" ? health.data.engagementId : null;
  }
  return taskLinkTarget(task, { deptId, engagementId });
}
