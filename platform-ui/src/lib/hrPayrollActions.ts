"use server";
// HR › Payroll write paths (DW-7f-1) — create, calculate, approve, publish and mark paid.
// Mirrors lib/hrActions.ts's `ctx()` + `send()` convention. Backend: platform-nest
// src/modules/hr/payroll.controller.ts (kind `hr_payroll`).
//
// THIS IS MONEY. Three rules this file holds:
//   1. Nothing here pre-checks a capability. The UI hides what the mirror says is not offered, but a
//      mirror that is narrower than the policy would otherwise block a real holder from inside the
//      action. The server decides and says why.
//   2. Every refusal is passed back as the server worded it. A 403 gets a sentence naming what was
//      refused; a 400/404/409/422 carries the server's own message. "Something went wrong" is only
//      ever the answer when the server gave no reason at all.
//   3. A result never claims a state. `status` is whatever the server's response body said; the page
//      re-reads the run (router.refresh) and the table shows what the server holds.
//
// The backend refuses wrong-status calls as 400 (not 409): "run is 'approved' — only a calculated run
// can be approved". 409 appears on create only (duplicate regular period / duplicate reference).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";

export type PayrollResult = {
  ok: boolean;
  error?: string;
  id?: string;
  /** The run status the server reported in its response body, when it reported one. */
  status?: string;
  /** What happened, in words, taken from the server's response (calculate: totals, skips, warning). */
  notice?: string;
};

const RUN_KINDS: readonly string[] = ["regular", "thr", "bonus", "final", "correction"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const tenant = tenantOverride || (await getActiveTenant(await getMe(userId)));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

const HIGH_ASSURANCE = " Approving, publishing and marking paid also need a high-assurance sign-in.";

function refusal(e: PlatformError, forbiddenVerb: string, needsHighAssurance: boolean): string {
  if (e.status === 403) {
    return `You don't have permission to ${forbiddenVerb}.${needsHighAssurance ? HIGH_ASSURANCE : ""}`;
  }
  return e.message?.trim() || `The server refused this (${e.status}) without giving a reason.`;
}

async function send<T extends Record<string, unknown>>(
  tenant: string, userId: string, path: string, bodyObj: unknown, forbiddenVerb: string, needsHighAssurance: boolean,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const body = await platformFetch<T>(`/api/${tenant}/modules/hr${path}`, userId, {
      method: "POST",
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { ok: true, body: (body ?? {}) as T };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: refusal(e, forbiddenVerb, needsHighAssurance) };
    throw e;
  }
}

function reval(runId?: string) {
  revalidatePath("/hr/payroll");
  if (runId) revalidatePath(`/hr/payroll/${runId}`); // the run's own page (DW-7f-1b)
  revalidatePath("/hr"); // the Pulse tile reads the latest run
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---- Create ----
export async function createPayrollRun(formData: FormData): Promise<PayrollResult> {
  const c = await ctx(String(formData.get("companyId") ?? "") || undefined);
  if ("error" in c) return { ok: false, error: c.error };

  const reference = String(formData.get("reference") ?? "").trim();
  const kind = String(formData.get("kind") ?? "regular") || "regular";
  const periodStart = String(formData.get("periodStart") ?? "").trim();
  const periodEnd = String(formData.get("periodEnd") ?? "").trim();
  const payDate = String(formData.get("payDate") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim().toUpperCase();

  if (!reference) return { ok: false, error: "A run reference is required." };
  if (!RUN_KINDS.includes(kind)) return { ok: false, error: "Pick a run kind from the list." };
  if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd)) return { ok: false, error: "Period start and end are required (YYYY-MM-DD)." };
  if (periodEnd < periodStart) return { ok: false, error: "The period must end on or after the day it starts." };
  if (payDate && !ISO_DATE.test(payDate)) return { ok: false, error: "The pay date must be YYYY-MM-DD." };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Currency must be a 3-letter code such as IDR." };

  const r = await send<{ id?: string; status?: string }>(
    c.tenant, c.userId, "/payroll-runs",
    { reference, kind, periodStart, periodEnd, currency, ...(payDate ? { payDate } : {}) },
    "create payroll runs", false,
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval();
  return { ok: true, id: str(r.body.id), status: str(r.body.status), notice: `Run ${reference} created as a draft. Calculate it next.` };
}

// ---- Calculate ----
export async function calculatePayrollRun(tenantId: string, runId: string): Promise<PayrollResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!runId) return { ok: false, error: "No payroll run selected." };

  const r = await send<{
    status?: string; employeeCount?: number; statutoryRatified?: boolean; statutoryWarning?: string | null;
    skipped?: { name?: string; reason?: string }[];
  }>(c.tenant, c.userId, `/payroll-runs/${encodeURIComponent(runId)}/calculate`, undefined, "calculate payroll runs", false);
  if (!r.ok) return { ok: false, error: r.error };
  reval(runId);

  // The server's own account of what it did. Skipped employees are NOT a footnote: a skipped person
  // gets no payslip, and the owner has to see that before approving.
  const parts: string[] = [];
  if (typeof r.body.employeeCount === "number") parts.push(`Calculated ${r.body.employeeCount} employee(s).`);
  else parts.push("Calculated.");
  const skipped = Array.isArray(r.body.skipped) ? r.body.skipped : [];
  if (skipped.length) {
    parts.push(`${skipped.length} skipped: ${skipped.map((s) => `${s.name ?? "unnamed"} (${s.reason ?? "no reason given"})`).join("; ")}.`);
  }
  if (r.body.statutoryWarning) parts.push(r.body.statutoryWarning);
  return { ok: true, id: runId, status: str(r.body.status), notice: parts.join(" ") };
}

// ---- Approve ----
export async function approvePayrollRun(
  tenantId: string, runId: string, opts: { overrideUnratified?: boolean; overrideReason?: string } = {},
): Promise<PayrollResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!runId) return { ok: false, error: "No payroll run selected." };

  const override = opts.overrideUnratified === true;
  const reason = (opts.overrideReason ?? "").trim();
  // The override is recorded permanently on the run, and the reason is the record. No reason, no call.
  if (override && !reason) return { ok: false, error: "Give a reason for approving against unratified statutory parameters." };

  const r = await send<{ status?: string; overrodeUnratified?: boolean }>(
    c.tenant, c.userId, `/payroll-runs/${encodeURIComponent(runId)}/approve`,
    override ? { overrideUnratified: true, overrideReason: reason } : { overrideUnratified: false },
    "approve payroll runs", true,
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval(runId);
  return {
    ok: true, id: runId, status: str(r.body.status),
    notice: r.body.overrodeUnratified
      ? "Approved against unratified statutory parameters. The override and your reason are now recorded on the run."
      : "Approved. Payslips are final but not yet visible to employees — publish them when ready.",
  };
}

// ---- Publish ----
export async function publishPayrollRun(tenantId: string, runId: string): Promise<PayrollResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!runId) return { ok: false, error: "No payroll run selected." };

  const r = await send<{ published?: number }>(
    c.tenant, c.userId, `/payroll-runs/${encodeURIComponent(runId)}/publish`, undefined, "publish payslips", true,
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval(runId);
  const n = typeof r.body.published === "number" ? r.body.published : null;
  return { ok: true, id: runId, notice: n === null ? "Payslips published." : `${n} payslip(s) published to their employees.` };
}

// ---- Mark paid ----
export async function markPayrollRunPaid(tenantId: string, runId: string): Promise<PayrollResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!runId) return { ok: false, error: "No payroll run selected." };

  const r = await send<{ status?: string }>(
    c.tenant, c.userId, `/payroll-runs/${encodeURIComponent(runId)}/paid`, undefined, "mark payroll runs paid", true,
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval(runId);
  return { ok: true, id: runId, status: str(r.body.status), notice: "Marked paid." };
}

// ---- Payroll input (DW-7f-1b) ----
// POST payroll-inputs (payroll.controller.ts addPayrollInput, authorize hr_payroll `create`; the UI
// mirror is hr.payroll.manage). An input belongs to an EMPLOYEE and a PERIOD, not to a run: the next
// calculate of any run whose period contains the input's period (and that has not consumed it)
// picks it up. The server does not check the run's status; the page only offers the form while the
// run can still be calculated (draft, calculated), because that is the only time it can be consumed.
// Not exported: a "use server" file may export only async functions (`next build` refuses anything else).
const INPUT_CATEGORIES: readonly string[] = [
  "overtime", "bonus", "commission", "reimbursement", "deduction", "advance", "leave_encashment", "other",
];

function money(raw: string, what: string): { value?: number; error?: string } {
  if (!raw) return {};
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { error: `${what} must be a number, zero or more.` };
  return { value: n };
}

export async function addPayrollInput(tenantId: string, runId: string, formData: FormData): Promise<PayrollResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!runId) return { ok: false, error: "No payroll run selected." };

  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  const periodStart = String(formData.get("periodStart") ?? "").trim();
  const periodEnd = String(formData.get("periodEnd") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const taxable = formData.get("taxable") === "on" || formData.get("taxable") === "true";

  if (!employeeId) return { ok: false, error: "Pick the employee this input is for." };
  if (!INPUT_CATEGORIES.includes(category)) return { ok: false, error: "Pick a category from the list." };
  if (!label) return { ok: false, error: "A label is required (it prints on the payslip)." };
  if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd)) return { ok: false, error: "The period is required (YYYY-MM-DD)." };
  if (periodEnd < periodStart) return { ok: false, error: "The period must end on or after the day it starts." };
  const amount = money(String(formData.get("amount") ?? "").trim(), "The amount");
  if (amount.error) return { ok: false, error: amount.error };
  const quantity = money(String(formData.get("quantity") ?? "").trim(), "The quantity");
  if (quantity.error) return { ok: false, error: quantity.error };
  if (amount.value === undefined && quantity.value === undefined) {
    return { ok: false, error: "Give an amount, or a quantity (hours, for overtime)." };
  }

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, "/payroll-inputs",
    {
      employeeId, category, label, periodStart, periodEnd, taxable,
      ...(code ? { code } : {}),
      ...(note ? { note } : {}),
      ...(amount.value !== undefined ? { amount: amount.value } : {}),
      ...(quantity.value !== undefined ? { quantity: quantity.value } : {}),
    },
    "add payroll inputs", false,
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval(runId);
  return {
    ok: true, id: str(r.body.id),
    notice: "Input recorded. It is counted the next time this run is calculated (recalculate to include it).",
  };
}
