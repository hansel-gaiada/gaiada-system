// Cost governance (P5d): a hard GLOBAL daily call cap AND a per-tenant daily cap. On breach
// the Gateway degrades (429 + audited alert) instead of incurring unbounded spend. In-memory —
// restarting resets the day's counts (acceptable at this cap size; persist later).
import { config } from "./config";

let day = "";
let globalCount = 0;
const tenantCounts = new Map<string, number>();

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function rollDay(now: number): void {
  const d = today(now);
  if (d !== day) {
    day = d;
    globalCount = 0;
    tenantCounts.clear();
  }
}

export type BudgetResult = { ok: true } | { ok: false; scope: "global" | "tenant" };

/** Try to spend one call. Charges the global cap and (if a tenant is given) that tenant's cap.
 *  Returns which cap was hit on refusal so the caller can alert with the right scope. */
export function takeBudget(tenant?: string, now: number = Date.now()): BudgetResult {
  rollDay(now);
  if (globalCount >= config.dailyCallCap) return { ok: false, scope: "global" };
  if (tenant) {
    const used = tenantCounts.get(tenant) ?? 0;
    if (used >= config.perTenantDailyCallCap) return { ok: false, scope: "tenant" };
    tenantCounts.set(tenant, used + 1);
  }
  globalCount++;
  return { ok: true };
}

export function budgetState(now: number = Date.now()): { used: number; cap: number; tenants: number; perTenantCap: number } {
  const sameDay = today(now) === day;
  return {
    used: sameDay ? globalCount : 0,
    cap: config.dailyCallCap,
    tenants: sameDay ? tenantCounts.size : 0,
    perTenantCap: config.perTenantDailyCallCap,
  };
}

export function resetBudgetForTest(): void {
  day = "";
  globalCount = 0;
  tenantCounts.clear();
}
