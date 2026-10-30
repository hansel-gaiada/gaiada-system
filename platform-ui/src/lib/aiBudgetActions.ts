"use server";
// AIP-17b and AIP-18 (BFF §66.9 and §66.11): the owner's budget and allowance writes, and the lift. RBAC here is DEFENCE IN DEPTH ONLY: the server decides
// (`manage` on `ai_usage` for the budgets and allowances, `manage` or `lift_stop` on that unit for a lift), and its 400 (with its sentence), 403 and 404
// come back as the form's error (`budgetErrorText`). The company is the session's own, resolved here and never taken from the browser. A refusal is
// returned, never thrown. Every write revalidates the screens that show the figures.
//
// Every action answers `{ ok: true, changed }` or `{ ok: false, error, field? }`. `changed` is the server's own: false means nothing moved (for
// example removing a figure that was not there).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { budgetErrorText, type BudgetMode } from "./aiBudget";
import { COMPANY_AI_USAGE_PATH, DEPARTMENT_AI_USAGE_PATH } from "./aiUsage";

export type BudgetActionResult = { ok: true; changed: boolean } | { ok: false; error: string; field?: string };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

const base = (tenant: string): string => `/api/${encodeURIComponent(tenant)}/ai-usage`;

function revalidate(): void {
  revalidatePath(COMPANY_AI_USAGE_PATH);
  revalidatePath(DEPARTMENT_AI_USAGE_PATH);
}

async function send(
  path: (tenant: string) => string,
  method: "PUT" | "POST",
  body: Record<string, unknown> | undefined,
  what: "budget" | "allowance" | "lift",
): Promise<BudgetActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ changed?: unknown }>(path(c.tenant), c.userId, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    revalidate();
    return { ok: true, changed: r?.changed !== false };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: budgetErrorText({ status: e.status, message: e.message }, what), ...(e.field ? { field: e.field } : {}) };
    throw e;
  }
}

/** Set, change or (with `null`) remove the company's alert figure. `monthlyUsd` is the decimal string as typed; the server canonicalises it. */
export async function setCompanyBudgetAction(monthlyUsd: string | null): Promise<BudgetActionResult> {
  return send((t) => `${base(t)}/budgets/company`, "PUT", { monthlyUsd }, "budget");
}

/** Set, change or remove (`monthlyUsd` null: no mode then) a department's budget. A new budget is Report only unless `mode` says otherwise. */
export async function setUnitBudgetAction(unitNodeId: string, monthlyUsd: string | null, mode?: BudgetMode): Promise<BudgetActionResult> {
  if (!unitNodeId) return { ok: false, error: "No department chosen.", field: "unitNodeId" };
  return send((t) => `${base(t)}/budgets/units/${encodeURIComponent(unitNodeId)}`, "PUT", monthlyUsd === null ? { monthlyUsd: null } : { monthlyUsd, ...(mode ? { mode } : {}) }, "budget");
}

/** Set a person's daily reply allowance, or (with `null`) put them back on the default. */
export async function setAllowanceAction(userId: string, dailyReplies: number | null): Promise<BudgetActionResult> {
  if (!userId) return { ok: false, error: "No person chosen.", field: "userId" };
  return send((t) => `${base(t)}/allowances/${encodeURIComponent(userId)}`, "PUT", { dailyReplies }, "allowance");
}

/** Lift a department's soft stop for the rest of the current UTC month (AIP-18). No body. */
export async function liftStopAction(unitNodeId: string): Promise<BudgetActionResult> {
  if (!unitNodeId) return { ok: false, error: "No department chosen.", field: "unitNodeId" };
  return send((t) => `${base(t)}/budgets/units/${encodeURIComponent(unitNodeId)}/lift`, "POST", undefined, "lift");
}
