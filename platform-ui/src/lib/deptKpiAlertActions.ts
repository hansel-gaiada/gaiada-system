"use server";
// DW-4j-2 — the one write path of the KPI alerts: a head ACKNOWLEDGES an off-track alert (BFF §43.5, `POST dept-kpis/alerts/:id/acknowledge
// {note?}`). It takes the company as an argument, because the Needs-you list spans every company the person can reach and each row says
// which one it is from (the same shape as `decideQueueItem`).
//
// RBAC here is DEFENCE IN DEPTH ONLY. The server decides (Cerbos `read` with the alert's unit ancestry, then "a head of that unit or the
// company-wide tier", else 403) and orders its refusals 403, 404, then 409 `resolved` / `already_acknowledged`, then 400 on the note. This layer
// refuses nothing a head could do: a refusal is the server's sentence, passed back as sent (the two 409 codes are worded by
// `explainAckError`, which leaves every other message untouched).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import { ALERT_NOTE_MAX, explainAckError } from "./deptKpiAlertFormat";

export type KpiAlertActionResult = { ok: boolean; error?: string; field?: string };

/** Acknowledge one alert, with an optional note (at most 1000 characters). The alert leaves Needs you; it stays open until the run resolves it. */
export async function acknowledgeKpiAlert(tenantId: string, alertId: string, note?: string): Promise<KpiAlertActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  if (!tenantId) return { ok: false, error: "No active company selected." };
  if (!alertId) return { ok: false, error: "No alert chosen." };
  const trimmed = (note ?? "").trim();
  if (trimmed.length > ALERT_NOTE_MAX) return { ok: false, error: `A note is at most ${ALERT_NOTE_MAX} characters.`, field: "note" };
  try {
    await platformFetch(
      `/api/${tenantId}/dept-kpis/alerts/${encodeURIComponent(alertId)}/acknowledge`, userId,
      { method: "POST", body: JSON.stringify(trimmed ? { note: trimmed } : {}) },
    );
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: explainAckError(e.message), field: e.field };
    throw e;
  }
  // The pages that show the list: the home, the department consoles, the Overviews (the same set `decideQueueItem` refreshes) and the KPI page.
  revalidatePath("/");
  revalidatePath("/departments");
  revalidatePath("/departments/[deptId]", "page");
  revalidatePath("/hr");
  revalidatePath("/finance");
  revalidatePath("/it");
  revalidatePath("/appraisals/department");
  return { ok: true };
}
