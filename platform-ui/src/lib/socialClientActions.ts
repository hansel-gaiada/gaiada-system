"use server";
// SCP-1k / SCP-1m (BFF §63.6.1, §63.6.7): the client page's server actions.
//
//   createClientPost   `POST cycles/:cycleId/posts`   (social_post · create, with author or approve: the cycle's officer or one of the four)
//   bulkPostAction     `POST posts/actions`           ('send_to_proofread' | 'approve_copy', 1 to 50 items; each item decided on its own)
//
// The gates here are hints; the server's 403 is the boundary. Every refusal comes back as the contract's own code in `error` (and its `field`),
// plus the words for it in `message`; the screens show the words.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { asBulkResults, createRefusalText, type BulkAction, type BulkItem, type BulkResult, type NewPostInput } from "./socialClient";

export type ClientActionResult<T> = ({ ok: true } & T) | { ok: false; error: string; field?: string; message: string };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
/** The most items the bulk route takes in one call (BFF §63.6.7). */
const BULK_MAX = 50;

async function run<T>(
  words: (code: string, field?: string) => string, fn: (c: { userId: string; tenant: string }) => Promise<T>,
): Promise<ClientActionResult<T>> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "session_expired", message: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "no_company", message: "No active company selected." };
  try {
    return { ok: true, ...(await fn({ userId, tenant })) };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field, message: words(e.message, e.field) };
    throw e;
  }
}

/** Adds a post to a cycle: planned, in the cycle's client, outside the target when `isExtra`. Answers the new post's id. */
export async function createClientPost(cycleId: string, body: NewPostInput): Promise<ClientActionResult<{ postId: string; created: boolean }>> {
  return run(createRefusalText, async (c) => {
    const raw = await platformFetch<{ post?: { id?: unknown }; created?: unknown }>(`${base(c.tenant)}/cycles/${encodeURIComponent(cycleId)}/posts`, c.userId, {
      method: "POST", body: JSON.stringify(body),
    });
    revalidatePath("/departments", "layout");
    return { postId: typeof raw?.post?.id === "string" ? raw.post.id : body.id, created: raw?.created !== false };
  });
}

/** Runs one bulk action over the items, 50 at a time, and answers each item's result in order. One item's refusal never undoes another. */
export async function bulkPostAction(action: BulkAction, items: readonly BulkItem[]): Promise<ClientActionResult<{ results: BulkResult[] }>> {
  return run((code) => code, async (c) => {
    const results: BulkResult[] = [];
    for (let i = 0; i < items.length; i += BULK_MAX) {
      const raw = await platformFetch<unknown>(`${base(c.tenant)}/posts/actions`, c.userId, {
        method: "POST", body: JSON.stringify({ action, items: items.slice(i, i + BULK_MAX) }),
      });
      results.push(...asBulkResults(raw));
    }
    revalidatePath("/departments", "layout");
    return { results };
  });
}
