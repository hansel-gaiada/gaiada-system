"use server";
// DW-7j-5 — the GM's revenue plan write paths (BFF §40.6.4): set a month (`PUT revenue-plan/:month {amountMinor, note?}`) and clear it
// (`DELETE revenue-plan/:month`).
//
// Mirrors the `ctx()`/`send()` convention of the other actions files (session -> tenant -> platformFetch, PlatformError surfaced).
//
// RBAC here is DEFENCE IN DEPTH ONLY. Cerbos decides (`dept_kpi_target` `approve`: company_admin, which owner mirrors), so the page's
// `company.manage` mirror also lets a `manager` try, and the server refuses (403): this layer words that refusal and never answers for
// the server. The currency is never sent: the server writes the company's base currency, and the typed amount (in major units) is
// converted with the `minorUnit` the server itself reports, read here rather than trusted from the browser.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { NOTE_MAX, NO_BASE_CURRENCY_WORDS, explainRevenuePlanError, parseAmountInput, type RevenuePlanRead } from "./revenuePlan";

export type RevenuePlanActionResult = { ok: boolean; error?: string; field?: string };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

async function send(c: { userId: string; tenant: string }, method: "PUT" | "DELETE", month: string, body?: unknown): Promise<RevenuePlanActionResult> {
  try {
    await platformFetch(`/api/${c.tenant}/revenue-plan/${encodeURIComponent(month)}`, c.userId, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: explainRevenuePlanError(e.status, e.message), field: e.field };
    throw e;
  }
  revalidatePath("/departments/[deptId]/revenue-plan", "page");
  // the GM's KPI reads the plan
  revalidatePath("/appraisals/department");
  revalidatePath("/departments/[deptId]", "page");
  return { ok: true };
}

/** Set one month's plan. `amountText` is what the GM typed, in MAJOR units; the server stores minor units in the company's base currency. */
export async function setRevenuePlanMonth(month: string, amountText: string, note?: string): Promise<RevenuePlanActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!MONTH_RE.test(month)) return { ok: false, error: "Choose a month.", field: "month" };
  const trimmed = (note ?? "").trim();
  if (trimmed.length > NOTE_MAX) return { ok: false, error: `A note is at most ${NOTE_MAX} characters.`, field: "note" };

  // The currency's decimals, from the server (the same read the grid shows). A refusal here is the same 403 the write would meet.
  let minorUnit: number | null;
  try {
    const plan = await platformFetch<RevenuePlanRead>(`/api/${c.tenant}/revenue-plan?from=${month}&to=${month}`, c.userId);
    minorUnit = typeof plan?.minorUnit === "number" ? plan.minorUnit : null;
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: explainRevenuePlanError(e.status, e.message), field: e.field };
    throw e;
  }
  if (minorUnit === null) return { ok: false, error: NO_BASE_CURRENCY_WORDS };

  const parsed = parseAmountInput(amountText, minorUnit);
  if (!parsed.ok) return { ok: false, error: parsed.error, field: "amount" };
  return send(c, "PUT", month, { amountMinor: parsed.minor, ...(trimmed ? { note: trimmed } : {}) });
}

/** Clear one month's plan (a cleared month reads "no plan", and makes the KPI "no data" for any window that includes it). */
export async function clearRevenuePlanMonth(month: string): Promise<RevenuePlanActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  if (!MONTH_RE.test(month)) return { ok: false, error: "Choose a month.", field: "month" };
  return send(c, "DELETE", month);
}
