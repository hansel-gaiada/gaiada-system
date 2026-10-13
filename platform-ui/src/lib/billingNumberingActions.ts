"use server";
// PV5-04b — the writes behind the "Service lines" and "Number codes" sections of the billing profile page (BFF §30):
//
//   saveServiceLineAction   PUT /api/:t/billing/service-lines/:key   add one, rename, link or unlink a department,
//                           switch on or off. Cerbos `finance_config` update.
//   preassignCodeAction     POST /api/:t/billing/number-codes        give a (service line, business type) pair its code before
//                           the first invoice. The code is generated unless one is typed. A pair that already has one is
//                           never changed: the server answers it back, or refuses with a 409.
//
// A refusal is shown in words next to the control, never as a bare "Forbidden". Cerbos and the table's own constraints are
// the authority; the checks here only save a round trip.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { BILLING_PROFILE_PATH, type ProfileSaveResult } from "./billingProfile";
import { numberingErrorText, validatePreassign, validateServiceLine } from "./billingNumbering";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

export async function saveServiceLineAction(_prev: ProfileSaveResult | null, formData: FormData): Promise<ProfileSaveResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const key = str(formData, "key");
  const name = str(formData, "name");
  // `active` and `departmentId` are sent only when the form carries them: a rename form must not switch a line back on, and a
  // switch-off button must not clear the department.
  const body: Record<string, unknown> = {};
  if (formData.has("name")) {
    const bad = validateServiceLine({ key, name });
    if (bad) return { ok: false, error: bad.message, field: bad.field };
    body.name = name;
  }
  if (formData.has("departmentId")) body.departmentId = str(formData, "departmentId") || null;
  if (formData.has("active")) body.active = str(formData, "active") === "true";
  try {
    await platformFetch(`/api/${c.tenant}/billing/service-lines/${encodeURIComponent(key)}`, c.userId, { method: "PUT", body: JSON.stringify(body) });
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: numberingErrorText(e.status, e.reason, e.message), ...(e.field ? { field: e.field } : {}) };
    throw e;
  }
  revalidatePath(BILLING_PROFILE_PATH);
  return { ok: true, notice: "Saved. Invoices not yet issued can now use it." };
}

export async function preassignCodeAction(_prev: ProfileSaveResult | null, formData: FormData): Promise<ProfileSaveResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const v = { serviceLineKey: str(formData, "serviceLineKey"), businessType: str(formData, "businessType"), code: str(formData, "code").toUpperCase() };
  const bad = validatePreassign(v);
  if (bad) return { ok: false, error: bad.message, field: bad.field };
  let out: { code: string; alreadyAssigned: boolean };
  try {
    out = await platformFetch<{ code: string; alreadyAssigned: boolean }>(`/api/${c.tenant}/billing/number-codes`, c.userId, {
      method: "POST", body: JSON.stringify({ serviceLineKey: v.serviceLineKey, businessType: v.businessType, ...(v.code ? { code: v.code } : {}) }),
    });
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: numberingErrorText(e.status, e.reason, e.message), ...(e.field ? { field: e.field } : {}) };
    throw e;
  }
  revalidatePath(BILLING_PROFILE_PATH);
  return {
    ok: true,
    notice: out.alreadyAssigned
      ? `That pair already has the code ${out.code}. A code is never changed.`
      : `Assigned the code ${out.code}. It is used from the first invoice of this pair.`,
  };
}
