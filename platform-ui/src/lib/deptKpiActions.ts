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
import { parseProposal, splitItemField, type BatchItemInput, type DeptKpiBatchResult, type KpiUnit } from "./deptKpiFormat";

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

// ── DW-10b-2 (BFF §58.2 and §58.3): several months in one write, all or nothing. ─────────────────────────────────────────────────

/** A refusal as the form shows it: the server's sentence, its field (for a batch, `items[3].target`) split into the item and its own field, and the
 *  `failedId` a decide refusal names. Nothing here widens or narrows what the server said. */
function batchFailure(e: PlatformError): DeptKpiBatchResult {
  const at = splitItemField(e.field);
  const failedId = (e.body as { failedId?: unknown } | undefined)?.failedId;
  return {
    ok: false, error: e.message, field: e.field,
    ...(at ? { index: at.index, itemField: at.field } : {}),
    ...(typeof failedId === "string" ? { failedId } : {}),
  };
}

/**
 * Propose a target for each of several months in ONE batch (§58.2). Each item is typed as `ProposeTargetForm` takes it (a percent as a whole percent) and goes
 * out as a fraction. Items are checked here in order first, and the first problem names its item exactly as the server would (`items[2].target`), so a
 * typo costs no round trip; the server then judges all of it again (the unit, the KPI, the month, a duplicate) and stays the authority. All or nothing.
 */
export async function proposeTargetsBatchAction(input: { unitNodeId: string; items: BatchItemInput[] }): Promise<DeptKpiBatchResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!input.unitNodeId) return { ok: false, error: "Choose a department.", field: "unitNodeId" };
  if (!Array.isArray(input.items) || input.items.length === 0) return { ok: false, error: "Choose at least one month.", field: "items" };
  if (input.items.length > 36) return { ok: false, error: "A plan covers at most 36 months at a time.", field: "items" };
  const items = [];
  for (let i = 0; i < input.items.length; i++) {
    const it = input.items[i];
    if (!UNITS.includes(it.unit)) return { ok: false, error: "Unknown KPI unit.", field: `items[${i}].kpiKey`, index: i, itemField: "kpiKey" };
    const parsed = parseProposal(it.unit, { unitNodeId: input.unitNodeId, ...it });
    if (!parsed.ok) return { ok: false, error: parsed.error, field: `items[${i}].${parsed.field}`, index: i, itemField: parsed.field };
    const { kpiKey, effectiveFrom, target, tolerance, note } = parsed.body;
    items.push({ kpiKey, effectiveFrom, target, tolerance, ...(note ? { note } : {}) });
  }
  try {
    const res = await platformFetch<{ ids?: string[] }>(
      `/api/${c.tenant}/dept-kpis/targets/batch`, c.userId,
      { method: "POST", body: JSON.stringify({ unitNodeId: input.unitNodeId, items }) },
    );
    reval();
    return { ok: true, ids: res?.ids ?? [] };
  } catch (e) {
    if (e instanceof PlatformError) return batchFailure(e);
    throw e;
  }
}

/**
 * Approve or reject several open proposals in ONE batch (§58.3). The server refuses the whole set when any one is refused (a missing or already
 * decided proposal, your own proposal for an approval, a unit you may not decide for) and names it in `failedId`; nothing is decided then.
 */
export async function decideTargetsBatchAction(
  input: { decision: "approve" | "reject"; ids: string[]; note?: string },
): Promise<DeptKpiBatchResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (input.decision !== "approve" && input.decision !== "reject") return { ok: false, error: "Choose approve or reject.", field: "decision" };
  const ids = [...new Set((input.ids ?? []).filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return { ok: false, error: "Choose at least one proposal.", field: "ids" };
  if (ids.length > 36) return { ok: false, error: "Decide at most 36 proposals at a time.", field: "ids" };
  const note = input.note?.trim();
  try {
    const res = await platformFetch<{ decided?: { id: string; status: string; superseded: string[] }[] }>(
      `/api/${c.tenant}/dept-kpis/targets/decide-batch`, c.userId,
      { method: "POST", body: JSON.stringify({ decision: input.decision, ids, ...(note ? { note } : {}) }) },
    );
    reval();
    return { ok: true, decided: res?.decided ?? [] };
  } catch (e) {
    if (e instanceof PlatformError) return batchFailure(e);
    throw e;
  }
}
