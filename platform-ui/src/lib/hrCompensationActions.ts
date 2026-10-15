"use server";
// HR › Compensation write paths (DW-7f-3) — set compensation, allowance types, allowance assignments, benefit
// plans, benefit enrolments and the tax profile. Same convention as lib/hrPayrollActions.ts: `ctx()` + `send()`.
// Backend: platform-nest src/modules/hr/payroll.controller.ts, Cerbos kind `hr_payroll`, action `create` on all six
// routes (the UI mirror is hr.payroll.manage).
//
// THIS IS MONEY. Three rules this file holds:
//   1. Nothing here pre-checks a capability. The screens hide what the mirror says is not offered; the server
//      decides and says why.
//   2. Every refusal is passed back as the server worded it. A 403 gets a sentence naming what was refused; a
//      400/404/409 carries the server's own message (`error ?? message`). "Something went wrong" is only the
//      answer when the server gave no reason at all.
//   3. A result never claims a state the server did not report. A notice is built from the server's reply (the
//      ids and dates it echoed), never from what was typed; the page re-reads after every call.
//
// What the server does that a form must not hide:
//   - POST compensation CLOSES the person's open record the day before `effectiveFrom` and opens a new one, in one
//     transaction. It silently swaps an unknown rate basis, pay frequency or reason for a default, so this file
//     refuses an unknown value instead of letting that happen.
//   - POST allowance-types and POST benefit-plans are UPSERTS BY CODE: a code that already exists is overwritten
//     in place (a plan's currency is the one column an overwrite leaves alone). The notice says "saved", never "created".
//   - A benefit plan's rates are fractions (0 to 1) on the wire. The form takes percent; the conversion is here.
//   - The routes check little (the database CHECK constraints are the wall), so this file validates the sets and
//     ranges the database would refuse, to give a sentence instead of a 500.
//
// This file exports async functions only ("use server" allows nothing else); the value sets are in lib/hrCompensation.ts.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  RATE_BASES, PAY_FREQUENCIES, CHANGE_REASONS, ALLOWANCE_DIRECTIONS, CALC_KINDS, BENEFIT_KINDS, STATUTORY_CODES,
  PTKP_STATUSES, TER_CATEGORIES,
} from "./hrCompensation";

export type CompensationResult = {
  ok: boolean;
  error?: string;
  id?: string;
  /** What happened, in words, built from the server's reply. */
  notice?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const tenant = tenantOverride || (await getActiveTenant(await getMe(userId)));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

function refusal(e: PlatformError, forbiddenVerb: string): string {
  if (e.status === 403) return `You don't have permission to ${forbiddenVerb}.`;
  return serverWords(e) || `The server refused this (${e.status}) without giving a reason.`;
}

/**
 * The server's own sentence. The error filter puts a thrown `{message, field}` on the wire as `{error, field}`, and
 * platformFetch reads `error` into `e.message`. If that came back as the generic "platform 400" (no usable `error`),
 * the raw body is tried as `error ?? message` before giving up.
 */
function serverWords(e: PlatformError): string {
  const generic = `platform ${e.status}`;
  const m = e.message?.trim();
  if (m && m !== generic) return m;
  const b = e.body as { error?: unknown; message?: unknown } | undefined;
  const raw = b?.error ?? b?.message;
  const text = Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "";
  return text.trim() || (m ?? "");
}

async function send<T extends Record<string, unknown>>(
  tenant: string, userId: string, path: string, bodyObj: unknown, forbiddenVerb: string,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const body = await platformFetch<T>(`/api/${tenant}/modules/hr${path}`, userId, {
      method: "POST",
      body: JSON.stringify(bodyObj),
    });
    return { ok: true, body: (body ?? {}) as T };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: refusal(e, forbiddenVerb) };
    throw e;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}
/** An optional number field: "" is absent, anything else must be finite and between `min` and `max`. */
function num(raw: string, what: string, min: number, max?: number, integer = false): { value?: number; error?: string } {
  if (!raw) return {};
  const n = Number(raw);
  const range = max === undefined ? `${min} or more` : `between ${min} and ${max}`;
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max)) return { error: `${what} must be a number ${range}.` };
  if (integer && !Number.isInteger(n)) return { error: `${what} must be a whole number.` };
  return { value: n };
}
function isoDate(raw: string, what: string, required: boolean): string | undefined {
  if (!raw) return required ? `${what} is required (YYYY-MM-DD).` : undefined;
  return ISO_DATE.test(raw) ? undefined : `${what} must be YYYY-MM-DD.`;
}

function reval() {
  revalidatePath("/hr/compensation");
}

// ---- Set compensation ----
// POST compensation. The record in force is closed the day before `effectiveFrom`; the server writes the matching
// job-history event in the same transaction. A date at or before the record in force starts cannot be inserted
// without an overlap, and the server says so; this file does not guess the incumbent's date.
export async function setCompensation(tenantId: string, formData: FormData): Promise<CompensationResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const employeeId = field(formData, "employeeId");
  const currency = (field(formData, "currency") || "IDR").toUpperCase();
  const rateBasis = field(formData, "rateBasis") || "monthly";
  const payFrequency = field(formData, "payFrequency") || "monthly";
  const changeReason = field(formData, "changeReason") || "other";
  const effectiveFrom = field(formData, "effectiveFrom");
  const gradeId = field(formData, "gradeId");
  const note = field(formData, "note");

  if (!employeeId) return { ok: false, error: "Pick the employee this compensation is for." };
  const baseRaw = field(formData, "baseAmount");
  if (!baseRaw) return { ok: false, error: "The base amount is required." };
  const base = num(baseRaw, "The base amount", 0);
  if (base.error) return { ok: false, error: base.error };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Currency must be a 3-letter code such as IDR." };
  if (!RATE_BASES.includes(rateBasis)) return { ok: false, error: "Pick a rate basis from the list." };
  if (!PAY_FREQUENCIES.includes(payFrequency)) return { ok: false, error: "Pick a pay frequency from the list." };
  if (!CHANGE_REASONS.includes(changeReason)) return { ok: false, error: "Pick a reason from the list." };
  const fte = num(field(formData, "fte"), "FTE", 0.001, 2);
  if (fte.error) return { ok: false, error: fte.error };
  // numeric(4,3): more than three decimals would be rounded by the database without telling anyone.
  if (fte.value !== undefined && Math.abs(fte.value * 1000 - Math.round(fte.value * 1000)) > 1e-9) {
    return { ok: false, error: "FTE can have at most 3 decimal places." };
  }
  const dateError = isoDate(effectiveFrom, "The effective date", true);
  if (dateError) return { ok: false, error: dateError };

  const r = await send<{ id?: string; effectiveFrom?: string; supersededRows?: number; employeeName?: string }>(
    c.tenant, c.userId, "/compensation",
    {
      employeeId, baseAmount: base.value, currency, rateBasis, payFrequency, changeReason, effectiveFrom,
      ...(fte.value !== undefined ? { fte: fte.value } : {}),
      ...(gradeId ? { gradeId } : {}),
      ...(note ? { note } : {}),
    },
    "set compensation",
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval();
  const who = str(r.body.employeeName) ?? "the employee";
  const from = str(r.body.effectiveFrom) ?? effectiveFrom;
  const closed = typeof r.body.supersededRows === "number" ? r.body.supersededRows : null;
  const tail = closed === null ? "" : closed > 0
    ? ` The record in force was closed the day before (${closed} row${closed === 1 ? "" : "s"}).`
    : " There was no earlier record in force to close.";
  return { ok: true, id: str(r.body.id), notice: `Compensation recorded for ${who} from ${from}.${tail}` };
}

// ---- Allowance type (upsert by code) ----
export async function saveAllowanceType(tenantId: string, formData: FormData): Promise<CompensationResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const code = field(formData, "code");
  const label = field(formData, "label");
  const direction = field(formData, "direction") || "allowance";
  const calcKind = field(formData, "calcKind") || "fixed";
  const taxable = formData.get("taxable") === "on" || formData.get("taxable") === "true";
  const bpjsBase = formData.get("bpjsBase") === "on" || formData.get("bpjsBase") === "true";
  const prorated = formData.get("prorated") === "on" || formData.get("prorated") === "true";

  if (!code) return { ok: false, error: "A code is required." };
  if (!label) return { ok: false, error: "A label is required (it prints on the payslip)." };
  if (!ALLOWANCE_DIRECTIONS.includes(direction)) return { ok: false, error: "Pick a direction from the list." };
  if (!CALC_KINDS.includes(calcKind)) return { ok: false, error: "Pick how it is calculated from the list." };
  const amount = num(field(formData, "defaultAmount"), "The default amount", 0);
  if (amount.error) return { ok: false, error: amount.error };
  const percent = num(field(formData, "defaultPercent"), "The default percent", 0, 100);
  if (percent.error) return { ok: false, error: percent.error };

  const r = await send<{ id?: string; code?: string }>(
    c.tenant, c.userId, "/allowance-types",
    {
      code, label, direction, calcKind, taxable, bpjsBase, prorated,
      ...(amount.value !== undefined ? { defaultAmount: amount.value } : {}),
      ...(percent.value !== undefined ? { defaultPercent: percent.value } : {}),
    },
    "save allowance types",
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval();
  return {
    ok: true, id: str(r.body.id),
    notice: `Allowance type ${str(r.body.code) ?? code} saved. A type that already used this code was updated in place.`,
  };
}

// ---- Assign an allowance to an employee ----
// Amount and percent are both optional: the server falls back to the type's default when the payroll run is
// calculated. An overlapping holding of the same type is a 409 in the server's words.
export async function assignAllowance(tenantId: string, formData: FormData): Promise<CompensationResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const employeeId = field(formData, "employeeId");
  const allowanceTypeId = field(formData, "allowanceTypeId");
  const effectiveFrom = field(formData, "effectiveFrom");
  const effectiveTo = field(formData, "effectiveTo");
  const note = field(formData, "note");

  if (!employeeId) return { ok: false, error: "Pick the employee this allowance is for." };
  if (!allowanceTypeId) return { ok: false, error: "Pick an allowance type." };
  const fromError = isoDate(effectiveFrom, "The start date", true);
  if (fromError) return { ok: false, error: fromError };
  const toError = isoDate(effectiveTo, "The end date", false);
  if (toError) return { ok: false, error: toError };
  if (effectiveTo && effectiveTo < effectiveFrom) return { ok: false, error: "The end date must be on or after the start date." };
  const amount = num(field(formData, "amount"), "The amount", 0);
  if (amount.error) return { ok: false, error: amount.error };
  const percent = num(field(formData, "percent"), "The percent", 0, 100);
  if (percent.error) return { ok: false, error: percent.error };

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, `/employees/${encodeURIComponent(employeeId)}/allowances`,
    {
      allowanceTypeId, effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}),
      ...(amount.value !== undefined ? { amount: amount.value } : {}),
      ...(percent.value !== undefined ? { percent: percent.value } : {}),
      ...(note ? { note } : {}),
    },
    "assign allowances",
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval();
  return { ok: true, id: str(r.body.id), notice: "Allowance assigned. It is counted the next time a payroll run whose period it covers is calculated." };
}

// ---- Benefit plan (upsert by code) ----
// Rates come in as percent and go out as the fraction the server stores (numeric(6,4): four decimals, so at most two
// decimals of percent; more would be rounded by the database without telling anyone, so it is refused here).
function rate(raw: string, what: string): { value?: number; error?: string } {
  const p = num(raw, what, 0, 100);
  if (p.error || p.value === undefined) return p;
  if (Math.abs(p.value * 100 - Math.round(p.value * 100)) > 1e-9) return { error: `${what} can have at most 2 decimal places.` };
  return { value: Number((p.value / 100).toFixed(4)) };
}

export async function saveBenefitPlan(tenantId: string, formData: FormData): Promise<CompensationResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const code = field(formData, "code");
  const name = field(formData, "name");
  const kind = field(formData, "kind") || "statutory";
  const statutoryCode = field(formData, "statutoryCode");
  const provider = field(formData, "provider");
  const currency = (field(formData, "currency") || "IDR").toUpperCase();

  if (!code) return { ok: false, error: "A code is required." };
  if (!name) return { ok: false, error: "A name is required." };
  if (!BENEFIT_KINDS.includes(kind)) return { ok: false, error: "Pick a kind from the list." };
  if (statutoryCode && !STATUTORY_CODES.includes(statutoryCode)) return { ok: false, error: "Pick a statutory code from the list." };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Currency must be a 3-letter code such as IDR." };
  const employer = rate(field(formData, "employerRate"), "The employer rate");
  if (employer.error) return { ok: false, error: employer.error };
  const employee = rate(field(formData, "employeeRate"), "The employee rate");
  if (employee.error) return { ok: false, error: employee.error };
  const cap = num(field(formData, "wageCap"), "The wage cap", 0);
  if (cap.error) return { ok: false, error: cap.error };
  const floor = num(field(formData, "wageFloor"), "The wage floor", 0);
  if (floor.error) return { ok: false, error: floor.error };
  if (cap.value !== undefined && floor.value !== undefined && cap.value < floor.value) {
    return { ok: false, error: "The wage cap must be at least the wage floor." };
  }

  const r = await send<{ id?: string; code?: string }>(
    c.tenant, c.userId, "/benefit-plans",
    {
      code, name, kind, currency,
      ...(statutoryCode ? { statutoryCode } : {}),
      ...(provider ? { provider } : {}),
      ...(employer.value !== undefined ? { employerRate: employer.value } : {}),
      ...(employee.value !== undefined ? { employeeRate: employee.value } : {}),
      ...(cap.value !== undefined ? { wageCap: cap.value } : {}),
      ...(floor.value !== undefined ? { wageFloor: floor.value } : {}),
    },
    "save benefit plans",
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval();
  return {
    ok: true, id: str(r.body.id),
    notice: `Benefit plan ${str(r.body.code) ?? code} saved. A plan that already used this code was updated in place (its currency is kept).`,
  };
}

// ---- Enrol an employee in a benefit plan ----
export async function enrolBenefit(tenantId: string, formData: FormData): Promise<CompensationResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const employeeId = field(formData, "employeeId");
  const planId = field(formData, "planId");
  const memberNumber = field(formData, "memberNumber");
  const effectiveFrom = field(formData, "effectiveFrom");
  const effectiveTo = field(formData, "effectiveTo");

  if (!employeeId) return { ok: false, error: "Pick the employee to enrol." };
  if (!planId) return { ok: false, error: "Pick a benefit plan." };
  const fromError = isoDate(effectiveFrom, "The start date", true);
  if (fromError) return { ok: false, error: fromError };
  const toError = isoDate(effectiveTo, "The end date", false);
  if (toError) return { ok: false, error: toError };
  if (effectiveTo && effectiveTo < effectiveFrom) return { ok: false, error: "The end date must be on or after the start date." };
  const dependants = num(field(formData, "dependants"), "Dependants", 0, undefined, true);
  if (dependants.error) return { ok: false, error: dependants.error };

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, `/employees/${encodeURIComponent(employeeId)}/benefits`,
    {
      planId, effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}),
      ...(memberNumber ? { memberNumber } : {}),
      ...(dependants.value !== undefined ? { dependants: dependants.value } : {}),
    },
    "enrol employees in benefit plans",
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval();
  return { ok: true, id: str(r.body.id), notice: "Employee enrolled." };
}

// ---- Tax profile ----
// POST employees/:id/tax-profile closes the profile in force the day before `effectiveFrom` and opens a new one. The
// TER category is left to the server unless one is chosen: the PTKP-to-TER mapping is regulated and is not mirrored here.
export async function setTaxProfile(tenantId: string, formData: FormData): Promise<CompensationResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const employeeId = field(formData, "employeeId");
  const npwp = field(formData, "npwp");
  const ptkpStatus = field(formData, "ptkpStatus") || "TK/0";
  const terCategory = field(formData, "terCategory");
  const effectiveFrom = field(formData, "effectiveFrom");
  const taxResident = formData.get("taxResident") === "on" || formData.get("taxResident") === "true";

  if (!employeeId) return { ok: false, error: "Pick the employee this tax profile is for." };
  if (!PTKP_STATUSES.includes(ptkpStatus)) return { ok: false, error: "Pick a PTKP status from the list." };
  if (terCategory && !TER_CATEGORIES.includes(terCategory)) return { ok: false, error: "Pick a TER category from the list." };
  const dateError = isoDate(effectiveFrom, "The effective date", true);
  if (dateError) return { ok: false, error: dateError };

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, `/employees/${encodeURIComponent(employeeId)}/tax-profile`,
    {
      ptkpStatus, effectiveFrom, taxResident,
      ...(npwp ? { npwp } : {}),
      ...(terCategory ? { terCategory } : {}),
    },
    "set tax profiles",
  );
  if (!r.ok) return { ok: false, error: r.error };
  reval();
  return {
    ok: true, id: str(r.body.id),
    notice: `Tax profile recorded from ${effectiveFrom}. ${npwp ? "An NPWP was recorded." : "No NPWP was recorded, so the employee is treated as having none."}`,
  };
}
