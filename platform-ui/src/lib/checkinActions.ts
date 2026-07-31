"use server";
// TR-10 — the check-in write path. Mirrors lib/hrActions.ts's convention (session -> tenant ->
// platformFetch, PlatformError message surfaced verbatim to the form). RBAC gating here is
// defence-in-depth only; the real boundary is Cerbos's `member`-self-only `checkin` submit rule on
// platform-nest (subjectUserId is ALWAYS the caller's own principal server-side — there is no
// subject field in this body for exactly that reason, so nothing client-supplied here can submit
// on someone else's behalf).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import type { CheckinSubmitResult } from "./checkins";

export type CheckinActionResult = { ok: boolean; error?: string; result?: CheckinSubmitResult };

// `<form action={submitCheckin}>` (FormData, matching LeaveForm/CaseForm's own pattern) rather than
// a plain typed-args function: CheckinCard needs the native progressive-enhancement form submit
// (works without JS having hydrated yet) for a flow whose whole design point is speed.
export async function submitCheckin(formData: FormData): Promise<CheckinActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const tenantId = String(formData.get("tenantId") ?? "").trim();
  if (!tenantId) return { ok: false, error: "No active company selected." };

  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return { ok: false, error: "Add a line about today before submitting." };
  const blockersRaw = String(formData.get("blockers") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim() || undefined;

  try {
    const result = await platformFetch<CheckinSubmitResult>(`/api/${tenantId}/checkins`, userId, {
      method: "POST",
      body: JSON.stringify({ date, summary, blockers: blockersRaw || undefined, source: "ui" }),
    });
    revalidatePath("/");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}
