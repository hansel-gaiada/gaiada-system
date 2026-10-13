"use server";
// DW-6h UI (contract §35.5): server actions for review rounds. Each forwards to the platform, which is the authority; a
// refusal comes back as plain words (`creativeErrorSentence`: a 403 is the calm "You can't do this on this asset", the
// 409/400 tokens get their sentences), never as a thrown error the page crashes on.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { creativeErrorSentence } from "./creativeReviews";

export interface ReviewActionResult { ok: boolean; error?: string; round?: number }

async function run(path: (tenant: string) => string, body?: unknown): Promise<ReviewActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  try {
    const r = await platformFetch<{ round?: number }>(path(encodeURIComponent(tenant)), userId, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
    revalidatePath("/departments/[deptId]/assets", "layout");
    return { ok: true, round: r?.round };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: creativeErrorSentence(e) };
    return { ok: false, error: e instanceof Error ? e.message : "That didn't work. Try again." };
  }
}

const base = (t: string, assetId: string) => `/api/${t}/creative/assets/${encodeURIComponent(assetId)}/reviews`;

/** Open a round on the latest version. */
export async function requestReview(assetId: string, note?: string): Promise<ReviewActionResult> {
  const n = note?.trim();
  return run((t) => base(t, assetId), n ? { note: n } : {});
}

/** Decide an open round. `changes_requested` needs a comment (checked here for a quick answer; the server checks too). */
export async function decideReview(
  assetId: string,
  round: number,
  decision: "approved" | "changes_requested",
  comment?: string,
): Promise<ReviewActionResult> {
  const c = comment?.trim();
  if (decision === "changes_requested" && !c) return { ok: false, error: creativeErrorSentence({ message: "comment_required" }) };
  if (!Number.isInteger(round) || round < 1) return { ok: false, error: creativeErrorSentence({ message: "review_not_found" }) };
  return run((t) => `${base(t, assetId)}/${round}/decision`, c ? { decision, comment: c } : { decision });
}

/** Withdraw an open round. */
export async function withdrawReview(assetId: string, round: number): Promise<ReviewActionResult> {
  if (!Number.isInteger(round) || round < 1) return { ok: false, error: creativeErrorSentence({ message: "review_not_found" }) };
  return run((t) => `${base(t, assetId)}/${round}/withdraw`);
}
