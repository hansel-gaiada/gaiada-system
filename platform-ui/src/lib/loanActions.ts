"use server";
// Employee-loan write paths (wave E). Same ctx()/send() convention as lib/hrActions.ts.
//
// RBAC checks here are DEFENCE IN DEPTH ONLY — Cerbos + RLS on platform-nest is the real boundary.
// They exist so the UI fails with a sentence instead of a raw 403, and they mirror the server rules:
//   request/cancel  a member may act for THEMSELVES; acting for someone else needs hr.manage
//   repayment       staff only (hr_case:update, which `member` does not hold) — an employee must
//                   never be able to declare their own loan repaid
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import type { RepaymentMethod } from "./loans";

export type LoanResult = { ok: boolean; error?: string; id?: string };

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = tenantOverride ?? (await getActiveTenant(me));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

async function send(tenant: string, userId: string, path: string, method: string, bodyObj?: unknown): Promise<LoanResult> {
  try {
    const res = await platformFetch<{ id?: string }>(`/api/${tenant}${path}`, userId, {
      method,
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { ok: true, id: res?.id };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message };
    throw e;
  }
}

function revalLoans(loanId?: string) {
  revalidatePath("/me", "layout");
  revalidatePath("/me/loans");
  if (loanId) revalidatePath(`/me/loans/${loanId}`);
  // The decider sees the new request in their inbox.
  revalidatePath("/approvals");
}

export async function requestLoan(formData: FormData): Promise<LoanResult> {
  const companyId = String(formData.get("companyId") ?? "");
  const c = await ctx(companyId || undefined);
  if ("error" in c) return { ok: false, error: c.error };

  const subjectUserId = String(formData.get("subjectUserId") ?? "").trim() || c.userId;
  if (subjectUserId !== c.userId && !can(c.me, "hr.manage", c.tenant)) {
    return { ok: false, error: "You can only request a loan on your own behalf." };
  }

  const principalAmount = Number(formData.get("principalAmount") ?? 0);
  const termMonths = Math.trunc(Number(formData.get("termMonths") ?? 0));
  const rateRaw = String(formData.get("annualInterestRate") ?? "").trim();
  const annualInterestRate = rateRaw === "" ? 0 : Number(rateRaw);
  const currency = String(formData.get("currency") ?? "IDR").trim().toUpperCase() || "IDR";
  const purpose = String(formData.get("purpose") ?? "").trim() || undefined;

  if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
    return { ok: false, error: "Enter a loan amount greater than zero." };
  }
  if (!Number.isFinite(termMonths) || termMonths < 1 || termMonths > 120) {
    return { ok: false, error: "Term must be between 1 and 120 months." };
  }
  if (!Number.isFinite(annualInterestRate) || annualInterestRate < 0 || annualInterestRate > 100) {
    return { ok: false, error: "Interest rate must be between 0 and 100." };
  }

  const r = await send(c.tenant, c.userId, `/modules/hr/loans`, "POST", {
    subjectUserId, principalAmount, termMonths, annualInterestRate, currency, purpose,
  });
  revalLoans();
  return r;
}

export async function cancelLoan(tenantId: string, loanId: string): Promise<LoanResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  const r = await send(c.tenant, c.userId, `/modules/hr/loans/${loanId}/cancel`, "POST");
  revalLoans(loanId);
  return r;
}

export async function recordRepayment(formData: FormData): Promise<LoanResult> {
  const companyId = String(formData.get("companyId") ?? "");
  const loanId = String(formData.get("loanId") ?? "");
  if (!loanId) return { ok: false, error: "Missing loan." };
  const c = await ctx(companyId || undefined);
  if ("error" in c) return { ok: false, error: c.error };
  // Mirrors the server's hr_case:update gate. The employee who owes the money cannot record a
  // payment against it, no matter whose loan it is.
  if (!can(c.me, "hr.manage", c.tenant)) {
    return { ok: false, error: "Only HR staff can record a loan repayment." };
  }

  const amount = Number(formData.get("amount") ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." };
  const method = String(formData.get("method") ?? "transfer") as RepaymentMethod;
  const paidOn = String(formData.get("paidOn") ?? "").trim() || undefined;
  const note = String(formData.get("note") ?? "").trim() || undefined;

  const r = await send(c.tenant, c.userId, `/modules/hr/loans/${loanId}/repayments`, "POST", {
    amount, method, paidOn, note,
  });
  revalLoans(loanId);
  return r;
}
