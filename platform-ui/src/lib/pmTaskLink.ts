// SCP-1n (BFF §63.13) — where a PM task's link points, in the Social Media department. Pure and client-safe: no fetch, no server-only.
//
// A task can point at a social post (`linkedType` `social_post`, set by the PM routes) and the content-month task of a cycle points at that cycle
// (`social_cycle`, set by the pipeline). The task drawer shows the way back:
//   a post         {D}/posts/[postId]             the post page (a drawer over any list, BFF §63.17)
//   a content month {D}/profile/[engagementId]    the client's page (Profile), the cycle's engagement
// where `{D}` is `/departments/[deptId]` of the company's Social Media department. The pages are built by the other SCP tickets; this file only
// names their URLs. The server's links are data; nothing here grants anything.
import { workspaceFor } from "@/lib/workspaces";

export type PmLinkType = "social_post" | "social_cycle";

/** What a task carries (additive on `PmTask`): the pair is both set or both null. */
export interface TaskLink {
  linkedType?: PmLinkType | null;
  linkedId?: string | null;
}

export interface TaskLinkTarget {
  href: string;
  label: string;
}

/** The department of `briefs` whose workspace is Social Media (the shell's own name match, `workspaceFor`), or null when the company has none. The first
 *  one when a company has more than one. */
export function pickSocialDeptId(briefs: ReadonlyArray<{ id: string; name: string }>, vertical: string | null | undefined): string | null {
  for (const d of briefs) if (workspaceFor(vertical, d.name).key === "social-media") return d.id;
  return null;
}

/** The link's target, or null when the task has no link, the department is unknown, or (for a content month) the cycle's client is not known. */
export function taskLinkTarget(
  task: TaskLink,
  where: { deptId: string | null; engagementId?: string | null },
): TaskLinkTarget | null {
  if (!task.linkedType || !task.linkedId || !where.deptId) return null;
  const dept = `/departments/${encodeURIComponent(where.deptId)}`;
  if (task.linkedType === "social_post") return { href: `${dept}/posts/${encodeURIComponent(task.linkedId)}`, label: "Social post" };
  if (task.linkedType === "social_cycle") {
    return where.engagementId ? { href: `${dept}/profile/${encodeURIComponent(where.engagementId)}`, label: "Client's content month" } : null;
  }
  return null;
}
