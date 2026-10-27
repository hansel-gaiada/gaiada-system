import "server-only";
// SCP-1d (BFF §63.7, §63.4, §63.5): the Social Media Home's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else: "cannot tell", never an empty list.
// Waiting, allocation and the deadline table already have readers (`getWaiting`, `getAllocation`, `getCycleTable`); this file adds the feed and the open tasks.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { listMyTasks, type AgendaTaskRow } from "./agenda";
import { isFinishedStatus } from "./myTasks";
import { asFeedPage, type FeedPage } from "./socialHome";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** The server clamps a page to 50 (one Cerbos batch). The Home asks for the most it may, once, and shows the first few. */
export const HOME_FEED_LIMIT = 50;

/** `GET feed?view=your_turn` (social_post · read): the posts whose holder is the caller, health first, each with its `nextAction` decided by one `checkMany`. */
export function getYourTurn(userId: string, tenantId: string): Promise<ReadResult<FeedPage>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/feed?view=your_turn&limit=${HOME_FEED_LIMIT}`, userId).then(asFeedPage));
}

/** The caller's open tasks in this company (`GET /api/tasks/mine`, the My tasks page's own read), soonest due first, undated last. `unavailable` is a read that
 *  could not be made, which is not "you have no tasks". */
export async function getMyOpenTasks(userId: string, tenantId: string): Promise<ReadResult<AgendaTaskRow[]>> {
  const r = await listMyTasks(userId, { scope: tenantId });
  if (r.unavailable) return { kind: "unavailable", reason: "The task list could not be read." };
  const open = r.envelope.items.filter((t) => !isFinishedStatus(t.status));
  open.sort((a, b) => (a.dueDate === b.dueDate ? 0 : a.dueDate === null ? 1 : b.dueDate === null ? -1 : a.dueDate < b.dueDate ? -1 : 1));
  return { kind: "ok", data: open };
}
