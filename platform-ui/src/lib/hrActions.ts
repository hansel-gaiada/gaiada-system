"use server";
// HR module write paths — server actions backing the leave/attendance/onboarding/
// cases UI. Mirrors the lib/pmActions.ts `ctx()` + `send()` convention. RBAC
// gating here is defence-in-depth only; Cerbos/RLS on platform-nest is the real
// boundary (see hr module design §2.2 — module_staff/module_manager/company_admin
// for others' records, `member` self-service for own leave/case rows).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import type { HrCaseKind, LeaveType, AttendanceStatus } from "./hr";

export type HrResult = { ok: boolean; error?: string; id?: string };

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = tenantOverride ?? (await getActiveTenant(me));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

async function send(tenant: string, userId: string, path: string, method: string, bodyObj?: unknown): Promise<HrResult> {
  try {
    const res = await platformFetch<{ id?: string; ok?: boolean }>(`/api/${tenant}${path}`, userId, {
      method,
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { ok: true, id: res?.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

function revalHr(companyId: string) {
  revalidatePath(`/hr`, "layout");
  revalidatePath(`/hr/leave`);
  revalidatePath(`/hr/attendance`);
  revalidatePath(`/hr/onboarding`);
  revalidatePath(`/hr/cases`);
  void companyId;
}

// ---- Leave ----
export async function fileLeave(formData: FormData): Promise<HrResult> {
  const companyId = String(formData.get("companyId") ?? "");
  const c = await ctx(companyId || undefined);
  if ("error" in c) return { ok: false, error: c.error };

  const subjectUserId = String(formData.get("subjectUserId") ?? "").trim() || c.userId;
  // Filing for someone else requires hr.manage; filing your own leave never does.
  if (subjectUserId !== c.userId && !can(c.me, "hr.manage", c.tenant)) {
    return { ok: false, error: "You can only file leave on your own behalf." };
  }
  const leaveType = String(formData.get("leaveType") ?? "") as LeaveType;
  const startsOn = String(formData.get("startsOn") ?? "");
  const endsOn = String(formData.get("endsOn") ?? startsOn);
  const halfDay = formData.get("halfDay") === "on";
  const days = Math.max(1, Number(formData.get("days") ?? 1));
  const note = String(formData.get("note") ?? "").trim() || undefined;
  if (!leaveType || !startsOn) return { ok: false, error: "Leave type and start date are required." };

  const minutes = Math.round(days * (halfDay ? 240 : 480));
  const r = await send(c.tenant, c.userId, `/modules/hr/leave`, "POST", {
    subjectUserId, leaveType, startsOn, endsOn, minutes, note,
  });
  revalHr(c.tenant);
  return r;
}

export async function cancelLeave(tenantId: string, leaveId: string): Promise<HrResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  const r = await send(c.tenant, c.userId, `/modules/hr/leave/${leaveId}/cancel`, "POST");
  revalHr(c.tenant);
  return r;
}

// Deciding leave rides the EXISTING generic decide endpoint — no forked HR decide
// path (contract §10). `approvalId` is the automation_approvals row the leave
// request carries (`origin:'hr'`), not the leave request's own id.
export async function decideHrLeave(
  tenantId: string, approvalId: string, decision: "approved" | "rejected", note?: string,
): Promise<HrResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "approvals.decide", c.tenant) && !can(c.me, "hr.manage", c.tenant)) {
    return { ok: false, error: "You don't have permission to decide this request." };
  }
  const r = await send(c.tenant, c.userId, `/automation-approvals/${approvalId}/decide`, "POST", { decision, note });
  revalHr(c.tenant);
  revalidatePath("/approvals");
  return r;
}

// ---- Attendance ----
export async function upsertAttendance(formData: FormData): Promise<HrResult> {
  const companyId = String(formData.get("companyId") ?? "");
  const c = await ctx(companyId || undefined);
  if ("error" in c) return { ok: false, error: c.error };
  const subjectUserId = String(formData.get("subjectUserId") ?? "").trim() || c.userId;
  const day = String(formData.get("day") ?? "");
  const status = String(formData.get("status") ?? "") as AttendanceStatus;
  const note = String(formData.get("note") ?? "").trim() || undefined;
  if (!day || !status) return { ok: false, error: "Day and status are required." };
  if (subjectUserId !== c.userId && !can(c.me, "hr.manage", c.tenant) && !can(c.me, "hr.view", c.tenant)) {
    return { ok: false, error: "You can only log your own attendance." };
  }
  const r = await send(c.tenant, c.userId, `/modules/hr/attendance`, "POST", { subjectUserId, day, status, note });
  revalHr(c.tenant);
  return r;
}

// ---- Onboarding / cases ----
export async function instantiateOnboarding(tenantId: string, subjectUserId: string, kind: "onboarding" | "offboarding"): Promise<HrResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "hr.manage", c.tenant)) return { ok: false, error: "You don't have permission to start onboarding/offboarding." };
  const r = await send(c.tenant, c.userId, `/modules/hr/onboarding/instantiate`, "POST", { subjectUserId, kind });
  revalHr(c.tenant);
  return r;
}

export async function createCase(formData: FormData): Promise<HrResult> {
  const companyId = String(formData.get("companyId") ?? "");
  const c = await ctx(companyId || undefined);
  if ("error" in c) return { ok: false, error: c.error };
  const kind = String(formData.get("kind") ?? "") as HrCaseKind;
  const title = String(formData.get("title") ?? "").trim();
  const subjectUserId = String(formData.get("subjectUserId") ?? "").trim() || undefined;
  if (!kind || !title) return { ok: false, error: "Kind and title are required." };
  // Anyone may open a case about themselves (member self-service, §2.2); on
  // someone else's behalf requires hr.manage.
  if (subjectUserId && subjectUserId !== c.userId && !can(c.me, "hr.manage", c.tenant)) {
    return { ok: false, error: "You don't have permission to open a case for someone else." };
  }
  const r = await send(c.tenant, c.userId, `/modules/hr/cases`, "POST", { kind, title, subjectUserId });
  revalHr(c.tenant);
  return r;
}

export async function cancelCase(tenantId: string, caseId: string): Promise<HrResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  const r = await send(c.tenant, c.userId, `/modules/hr/cases/${caseId}/cancel`, "POST");
  revalHr(c.tenant);
  revalidatePath(`/hr/cases/${caseId}`);
  return r;
}

export async function toggleChecklistItem(tenantId: string, caseId: string, items: { label: string; done: boolean }[]): Promise<HrResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  const r = await send(c.tenant, c.userId, `/modules/hr/cases/${caseId}/checklist`, "PATCH", { items });
  revalidatePath(`/hr/cases/${caseId}`);
  revalidatePath(`/hr/onboarding`);
  return r;
}

export async function createChecklistTemplate(formData: FormData): Promise<HrResult> {
  const companyId = String(formData.get("companyId") ?? "");
  const c = await ctx(companyId || undefined);
  if ("error" in c) return { ok: false, error: c.error };
  if (!can(c.me, "hr.manage", c.tenant)) return { ok: false, error: "You don't have permission to manage checklist templates." };
  const kind = String(formData.get("kind") ?? "onboarding") as "onboarding" | "offboarding";
  const name = String(formData.get("name") ?? "").trim();
  const rawItems = String(formData.get("items") ?? "");
  const items = rawItems.split("\n").map((l) => l.trim()).filter(Boolean).map((label) => ({ label }));
  if (!name || items.length === 0) return { ok: false, error: "Name and at least one checklist item are required." };
  const r = await send(c.tenant, c.userId, `/modules/hr/checklist-templates`, "POST", { kind, name, items });
  revalHr(c.tenant);
  return r;
}
