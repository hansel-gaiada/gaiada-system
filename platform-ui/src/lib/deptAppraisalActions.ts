"use server";
// DW-4e-3 — the department appraisal write paths (BFF §41.4): the head's COMMENTARY and the GM's ASSESSMENT, each a PUT.
//
// RBAC here is DEFENCE IN DEPTH ONLY. Cerbos decides (`resource_dept_kpi_target.yaml`: `appraisal_comment` = org_unit_lead
// over the unit's ancestry or company_admin; `appraisal_assess` = company_admin, which owner mirrors), and the service ends
// both writes when the cycle is closed (409 `cycle_closed`). This layer never answers for the server: a `can()` check cannot
// see a unit, so it does not pre-refuse a head, and the server's 400/403/409 sentence is passed back for the form to show.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { explainAppraisalWriteError, parseAppraisalText, parseAssessment } from "./deptAppraisalFormat";

export type DeptAppraisalActionResult = { ok: boolean; error?: string; field?: string };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

async function put(tenant: string, userId: string, cycleId: string, unitId: string, half: "commentary" | "assessment", body: unknown): Promise<DeptAppraisalActionResult> {
  try {
    await platformFetch(
      `/api/${tenant}/dept-appraisals/${encodeURIComponent(cycleId)}/${encodeURIComponent(unitId)}/${half}`, userId,
      { method: "PUT", body: JSON.stringify(body) },
    );
    revalidatePath("/appraisals/department");
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: explainAppraisalWriteError(e.message), field: e.field };
    throw e;
  }
}

/** Save the head's commentary for (cycle, unit). The server decides who may and refuses a closed cycle. */
export async function saveDeptAppraisalCommentary(formData: FormData): Promise<DeptAppraisalActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const cycleId = String(formData.get("cycleId") ?? "");
  const unitId = String(formData.get("unitNodeId") ?? "");
  if (!cycleId || !unitId) return { ok: false, error: "No cycle or department chosen." };
  const parsed = parseAppraisalText(String(formData.get("text") ?? ""));
  if (!parsed.ok) return { ok: false, error: parsed.error, field: parsed.field };
  return put(c.tenant, c.userId, cycleId, unitId, "commentary", { text: parsed.text });
}

/** Save the GM's assessment and judged condition for (cycle, unit). */
export async function saveDeptAppraisalAssessment(formData: FormData): Promise<DeptAppraisalActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const cycleId = String(formData.get("cycleId") ?? "");
  const unitId = String(formData.get("unitNodeId") ?? "");
  if (!cycleId || !unitId) return { ok: false, error: "No cycle or department chosen." };
  const parsed = parseAssessment({ text: String(formData.get("text") ?? ""), condition: String(formData.get("condition") ?? "") });
  if (!parsed.ok) return { ok: false, error: parsed.error, field: parsed.field };
  return put(c.tenant, c.userId, cycleId, unitId, "assessment", parsed.body);
}
