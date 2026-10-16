"use server";
// DW-10a-2 (BFF §57.4): the notice board's writes. Every action returns `{ok, error?, field?, id?}`, never a thrown refusal. RBAC here is
// DEFENCE IN DEPTH ONLY: Cerbos decides (`resource_dept_notice.yaml`: a head posts to their own unit, a company admin to any unit and
// company-wide), so this layer never answers for the server and does not pre-refuse a head. The server's 400 `{field}`, 403, 404 and 409
// `pin_limit` come back as the form's error (`noticeErrorText`). The company is the page's own, checked here against the caller's
// companies, so a tampered id cannot reach a company the caller is not in (the backend would refuse it anyway).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { accessibleCompanies } from "./rbac";
import { checkNoticeForm, noticeErrorText, type NoticeActionResult, type NoticeFormInput, type NoticeScope } from "./notices";

async function ctx(tenantId: string): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  if (!tenantId || !accessibleCompanies(me).some((c) => c.id === tenantId)) return { error: "Select a company first." };
  return { userId, tenant: tenantId };
}

const base = (t: string) => `/api/${encodeURIComponent(t)}/notices`;

function refused(e: unknown, scope: NoticeScope): NoticeActionResult {
  if (e instanceof PlatformError) {
    return { ok: false, error: noticeErrorText({ status: e.status, message: e.message, field: e.field, reason: e.reason }, scope), ...(e.field ? { field: e.field } : {}) };
  }
  throw e;
}

/** A notice changes what the unit's page, the company page and the Overview blocks say. */
function refresh() {
  revalidatePath("/departments/[deptId]/notices", "page");
  revalidatePath("/departments/[deptId]", "page");
  revalidatePath("/notices");
  revalidatePath("/");
}

/** Post a notice. `unitNodeId` is the unit's page's own node for a unit notice and is not sent for a company-wide one (§57.3: the scope is
 *  the caller's to choose and the server never widens it). */
export async function postNoticeAction(
  tenantId: string, target: { scope: "company" } | { scope: "unit"; unitNodeId: string }, input: NoticeFormInput,
): Promise<NoticeActionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (target.scope === "unit" && !target.unitNodeId) return { ok: false, error: "Choose the unit this notice is for.", field: "unitNodeId" };
  const v = checkNoticeForm(input);
  if (!v.ok) return { ok: false, error: v.error, field: v.field };
  const payload = {
    scope: target.scope,
    ...(target.scope === "unit" ? { unitNodeId: target.unitNodeId } : {}),
    title: v.title, body: v.body, pinned: v.pinned, ...(v.endsOn ? { endsOn: v.endsOn } : {}),
  };
  try {
    const row = await platformFetch<{ id: string }>(base(c.tenant), c.userId, { method: "POST", body: JSON.stringify(payload) });
    refresh();
    return { ok: true, id: row?.id };
  } catch (e) {
    return refused(e, target.scope);
  }
}

/** Change a notice (title, body, pin, end date). `endsOn: null` clears the end date. Sends no new notification. `scope` only words the refusal. */
export async function editNoticeAction(tenantId: string, id: string, input: NoticeFormInput, scope: NoticeScope = "unit"): Promise<NoticeActionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!id) return { ok: false, error: "No notice chosen." };
  const v = checkNoticeForm(input);
  if (!v.ok) return { ok: false, error: v.error, field: v.field };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}`, c.userId, {
      method: "PATCH", body: JSON.stringify({ title: v.title, body: v.body, pinned: v.pinned, endsOn: v.endsOn }),
    });
    refresh();
    return { ok: true, id };
  } catch (e) {
    return refused(e, scope);
  }
}

/** Withdraw a notice: it leaves every list and every read, and the row stays for the record. Sends no notification. */
export async function withdrawNoticeAction(tenantId: string, id: string, scope: NoticeScope = "unit"): Promise<NoticeActionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!id) return { ok: false, error: "No notice chosen." };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}/withdraw`, c.userId, { method: "POST" });
    refresh();
    return { ok: true, id };
  } catch (e) {
    return refused(e, scope);
  }
}
