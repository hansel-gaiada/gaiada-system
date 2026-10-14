"use server";
// DW-4e-2 — department KPI target write paths (BFF §40.2): a head PROPOSES, the approver APPROVES or REJECTS.
//
// RBAC here is DEFENCE IN DEPTH ONLY. Cerbos decides (`resource_dept_kpi_target.yaml`: propose = org_unit_lead over
// the unit's ancestry or company_admin; approve/reject = company_admin; and the service refuses a proposer approving
// their own proposal with a 409), so this layer never answers for the server. It does not pre-refuse a head: a
// `can()` check cannot see a unit, so the server's 400/403/409 sentence is passed back VERBATIM for the form to show.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { parseProposal, type KpiUnit } from "./deptKpiFormat";

export type DeptKpiActionResult = { ok: boolean; error?: string; field?: string; id?: string; status?: string };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

async function post(
  tenant: string, userId: string, path: string, bodyObj: unknown,
): Promise<DeptKpiActionResult> {
  try {
    const res = await platformFetch<{ id?: string; status?: string }>(
      `/api/${tenant}/dept-kpis/targets${path}`, userId,
      { method: "POST", body: JSON.stringify(bodyObj) },
    );
    return { ok: true, id: res?.id, status: res?.status };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field };
    throw e;
  }
}

function reval() {
  revalidatePath("/appraisals/department");
}

const UNITS: readonly string[] = ["percent", "count", "minutes"];

/**
 * Propose a target. The form carries the KPI's `unit` so a whole percent is sent as a fraction (§40.3a);
 * the server validates the range again and stays the authority.
 */
export async function proposeDeptKpiTarget(formData: FormData): Promise<DeptKpiActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const unit = String(formData.get("unit") ?? "");
  if (!UNITS.includes(unit)) return { ok: false, error: "Unknown KPI unit.", field: "kpiKey" };
  const parsed = parseProposal(unit as KpiUnit, {
    unitNodeId: String(formData.get("unitNodeId") ?? ""),
    kpiKey: String(formData.get("kpiKey") ?? ""),
    effectiveFrom: String(formData.get("effectiveFrom") ?? ""),
    target: String(formData.get("target") ?? ""),
    tolerance: String(formData.get("tolerance") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error, field: parsed.field };
  const r = await post(c.tenant, c.userId, "", parsed.body);
  if (r.ok) reval();
  return r;
}

/** Approve a proposal. A proposer can never approve their own (409 `cannot_approve_own_proposal`). */
export async function approveDeptKpiTarget(id: string, note?: string): Promise<DeptKpiActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!id) return { ok: false, error: "No proposal chosen." };
  const r = await post(c.tenant, c.userId, `/${encodeURIComponent(id)}/approve`, note?.trim() ? { note: note.trim() } : {});
  if (r.ok) reval();
  return r;
}

export async function rejectDeptKpiTarget(id: string, note?: string): Promise<DeptKpiActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!id) return { ok: false, error: "No proposal chosen." };
  const r = await post(c.tenant, c.userId, `/${encodeURIComponent(id)}/reject`, note?.trim() ? { note: note.trim() } : {});
  if (r.ok) reval();
  return r;
}
