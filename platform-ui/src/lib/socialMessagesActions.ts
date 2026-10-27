"use server";
// SCP-1j (BFF §63.5, §63.14): the Messages page's one write, `follow_up` on `POST posts/:postId/actions`. The body carries `expectedStatus` (the status the
// officer was looking at), a fresh `actionId` (so a double click is one follow-up, not two) and an optional `note`. The server refuses with the contract's
// own codes: 409 `follow_up_too_soon` (with `retryAfterSeconds`), 409 `nobody_to_follow_up`, 409 `status_changed`. They come back in `error`, with the
// words for them in `message`; the page shows the words and, for the wait, counts it.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { followUpRefusalText } from "./socialMessages";

export type FollowUpResult =
  | { ok: true; alreadyApplied: boolean }
  | { ok: false; error: string; retryAfterSeconds?: number; message: string };

const NOTE_MAX = 500;

export async function followUpAction(postId: string, expectedStatus: string, note?: string): Promise<FollowUpResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "session_expired", message: followUpRefusalText({ error: "session_expired" }) };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "no_company", message: "No active company selected." };
  const trimmed = typeof note === "string" ? note.trim().slice(0, NOTE_MAX) : "";
  try {
    const out = await platformFetch<{ alreadyApplied?: boolean }>(
      `/api/${encodeURIComponent(tenant)}/modules/social/posts/${encodeURIComponent(postId)}/actions`,
      userId,
      { method: "POST", body: JSON.stringify({ action: "follow_up", expectedStatus, actionId: randomUUID(), ...(trimmed ? { note: trimmed } : {}) }) },
    );
    revalidatePath("/departments", "layout");
    return { ok: true, alreadyApplied: out?.alreadyApplied === true };
  } catch (e) {
    if (e instanceof PlatformError) {
      const raw = e.body as { retryAfterSeconds?: unknown } | undefined;
      const retryAfterSeconds = typeof raw?.retryAfterSeconds === "number" ? raw.retryAfterSeconds : undefined;
      return { ok: false, error: e.message, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}), message: followUpRefusalText({ error: e.message, retryAfterSeconds }) };
    }
    throw e;
  }
}
