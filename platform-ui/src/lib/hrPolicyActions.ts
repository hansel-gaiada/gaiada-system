"use server";
// HR › Reviews and Settings write paths (DW-7f-4, DW-7f-5) — review cycles and their participants, holiday calendars
// and holidays, leave policies and their assignments, pay grades, and the statutory parameter sets. Same convention as
// lib/hrCompensationActions.ts: `ctx()` + `send()`. Backend: platform-nest src/modules/hr/hr-policy.controller.ts,
// Cerbos kind `hr_policy`. Create, update and delete are held by hr_people_ops (hr_manager) and company_admin (the UI
// mirror is hr.policy.manage); RATIFY is its own action, company_admin only, at high assurance (hr.policy.ratify).
//
// Rules this file holds:
//   1. Nothing here pre-checks a capability. The screens hide what the mirror says is not offered; the server decides
//      and says why.
//   2. Every refusal is passed back as the server worded it. A 403 gets a sentence naming what was refused; a
//      400/404/409 carries the server's own message (`error ?? message`).
//   3. A result never claims a state the server did not report. A notice is built from the server's reply; the page
//      re-reads after every call.
//
// What the server does that a form must not hide:
//   - Review cycle PATCH takes a name, a status and the completion window (opensOn, closesOn) only; the period and the
//     kind are fixed at creation. There is NO status machine: any of draft, open, closed, cancelled is accepted from
//     any other. A participant's status is not checked by the route either (the database CHECK is the wall), so this
//     file refuses an unknown one to give a sentence instead of a 500. `submitted_at` is stamped by the server.
//   - Participants are keyed by USER id (not employee id), added in bulk, and ON CONFLICT DO NOTHING: someone already
//     in the cycle is skipped silently, so the notice says how many were added of how many sent.
//   - POST holidays is an UPSERT by (calendar, day): a holiday on a date that already has one is REPLACED.
//   - POST calendars with isDefault demotes the incumbent default; an empty weekend falls back to Sat+Sun on the
//     server, so a calendar with no weekend days cannot be expressed and is refused here.
//   - Leave entitlements are stored in minutes (480 = one working day); the forms take days and convert here.
//   - A statutory parameter set is created UNRATIFIED. Ratifying is refused if it is already ratified. A note given on
//     ratify REPLACES the set's source note.
//
// This file exports async functions only ("use server" allows nothing else); the value sets are in lib/hrPolicy.ts.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  CYCLE_KINDS, CYCLE_STATUSES, PARTICIPANT_STATUSES, PARTICIPANT_OUTCOMES, LEAVE_TYPES, ACCRUAL_METHODS, HOLIDAY_KINDS,
  GRADE_TRACKS, PARAMETER_UNITS, RATE_BASES, MINUTES_PER_DAY,
} from "./hrPolicy";

export type PolicyResult = {
  ok: boolean;
  error?: string;
  id?: string;
  /** What happened, in words, built from the server's reply. */
  notice?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HIGH_ASSURANCE = " Ratifying is for company administrators and also needs a high-assurance sign-in.";

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const tenant = tenantOverride || (await getActiveTenant(await getMe(userId)));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

function refusal(e: PlatformError, forbiddenVerb: string, needsHighAssurance: boolean): string {
  if (e.status === 403) return `You don't have permission to ${forbiddenVerb}.${needsHighAssurance ? HIGH_ASSURANCE : ""}`;
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
  tenant: string, userId: string, method: "POST" | "PATCH" | "DELETE", path: string, bodyObj: unknown,
  forbiddenVerb: string, needsHighAssurance = false,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const body = await platformFetch<T>(`/api/${tenant}/modules/hr${path}`, userId, {
      method,
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    return { ok: true, body: (body ?? {}) as T };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: refusal(e, forbiddenVerb, needsHighAssurance) };
    throw e;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}
function flag(formData: FormData, key: string): boolean {
  return formData.get(key) === "on" || formData.get(key) === "true";
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
/** At most `places` decimals, judged on the typed text (a float round-trip would call 0.07 * 100 inexact). */
function tooManyDecimals(raw: string, places: number): boolean {
  const m = /^-?\d+(?:\.(\d+))?$/.exec(raw);
  return !!m && (m[1]?.length ?? 0) > places;
}
function isoDate(raw: string, what: string, required: boolean): string | undefined {
  if (!raw) return required ? `${what} is required (YYYY-MM-DD).` : undefined;
  return ISO_DATE.test(raw) ? undefined : `${what} must be YYYY-MM-DD.`;
}
function currencyCode(raw: string): { value: string; error?: string } {
  const value = (raw || "IDR").toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? { value } : { value, error: "Currency must be a 3-letter code such as IDR." };
}
function countryCode(raw: string): { value: string; error?: string } {
  const value = (raw || "ID").toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? { value } : { value, error: "Country must be a 2-letter code such as ID." };
}

function revalReviews() {
  revalidatePath("/hr/reviews");
  revalidatePath("/hr/reviews/[cycleId]", "page");
}
function revalSettings() {
  revalidatePath("/hr/settings");
  revalidatePath("/hr/settings/statutory/[setId]", "page");
}

// ═══════════════════════════════════════════════════════════ REVIEW CYCLES ══════════════════

// ---- Create a cycle ----
// POST review-cycles (`create`). The period must not end before it starts; the completion window (opens, closes) is
// optional and the database refuses a window that closes before it opens. A new cycle is a draft.
export async function createReviewCycle(tenantId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const name = field(formData, "name");
  const kind = field(formData, "kind") || "periodic";
  const periodStart = field(formData, "periodStart");
  const periodEnd = field(formData, "periodEnd");
  const opensOn = field(formData, "opensOn");
  const closesOn = field(formData, "closesOn");

  if (!name) return { ok: false, error: "A name is required." };
  if (!CYCLE_KINDS.includes(kind)) return { ok: false, error: "Pick a kind from the list." };
  for (const [raw, what, required] of [
    [periodStart, "The period start", true], [periodEnd, "The period end", true],
    [opensOn, "The window opening date", false], [closesOn, "The window closing date", false],
  ] as const) {
    const e = isoDate(raw, what, required);
    if (e) return { ok: false, error: e };
  }
  if (periodEnd < periodStart) return { ok: false, error: "The period must not end before it starts." };
  if (opensOn && closesOn && closesOn < opensOn) return { ok: false, error: "The window must not close before it opens." };

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, "POST", "/review-cycles",
    { name, kind, periodStart, periodEnd, ...(opensOn ? { opensOn } : {}), ...(closesOn ? { closesOn } : {}) },
    "create review cycles",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalReviews();
  return { ok: true, id: str(r.body.id), notice: "Review cycle created as a draft. Open it, and add its participants, when it is ready." };
}

// ---- Edit a cycle ----
// PATCH review-cycles/:id (`update`). Name, status and the window. The form is filled with what the server holds, so
// it sends all four: a blank date clears that date (null), a blank name is refused.
export async function updateReviewCycle(tenantId: string, cycleId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!cycleId) return { ok: false, error: "No review cycle was given." };

  const name = field(formData, "name");
  const status = field(formData, "status");
  const opensOn = field(formData, "opensOn");
  const closesOn = field(formData, "closesOn");

  if (!name) return { ok: false, error: "A name is required." };
  if (!CYCLE_STATUSES.includes(status)) return { ok: false, error: "Pick a status from the list." };
  const o = isoDate(opensOn, "The window opening date", false);
  if (o) return { ok: false, error: o };
  const cl = isoDate(closesOn, "The window closing date", false);
  if (cl) return { ok: false, error: cl };
  if (opensOn && closesOn && closesOn < opensOn) return { ok: false, error: "The window must not close before it opens." };

  const r = await send(
    c.tenant, c.userId, "PATCH", `/review-cycles/${encodeURIComponent(cycleId)}`,
    { name, status, opensOn: opensOn || null, closesOn: closesOn || null },
    "edit review cycles",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalReviews();
  return { ok: true, id: cycleId, notice: "Review cycle saved." };
}

// ---- Add participants ----
// POST review-cycles/:id/participants (`create`). `subjectUserId` repeats (one per person ticked). The ids are USER
// ids. The server skips anyone already in the cycle without saying so, so the notice counts.
export async function addReviewParticipants(tenantId: string, cycleId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!cycleId) return { ok: false, error: "No review cycle was given." };

  const subjects = [...new Set(formData.getAll("subjectUserId").map((v) => String(v).trim()).filter(Boolean))];
  const reviewerUserId = field(formData, "reviewerUserId");
  const dueOn = field(formData, "dueOn");
  if (subjects.length === 0) return { ok: false, error: "Tick at least one person to add." };
  const e = isoDate(dueOn, "The due date", false);
  if (e) return { ok: false, error: e };

  const r = await send<{ cycleId?: string; added?: number }>(
    c.tenant, c.userId, "POST", `/review-cycles/${encodeURIComponent(cycleId)}/participants`,
    {
      participants: subjects.map((subjectUserId) => ({
        subjectUserId,
        ...(reviewerUserId ? { reviewerUserId } : {}),
        ...(dueOn ? { dueOn } : {}),
      })),
    },
    "add review participants",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalReviews();
  const added = typeof r.body.added === "number" ? r.body.added : null;
  const sent = subjects.length;
  const notice = added === null ? "Participants sent; the server did not say how many were added."
    : added === 0 ? `Nobody was added: ${sent === 1 ? "that person is" : "all of them are"} already in this cycle.`
    : added < sent ? `${added} of ${sent} added; the rest were already in this cycle.`
    : `${added} ${added === 1 ? "person" : "people"} added.`;
  return { ok: true, id: cycleId, notice };
}

// ---- Update a participant ----
// PATCH review-participants/:id (`update`). Only what is filled is sent (a blank field leaves the value alone). The
// server stamps `submitted_at` itself when the status becomes `submitted`. Appraisal content is not written here: the
// reports program owns it.
export async function updateReviewParticipant(tenantId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const participantId = field(formData, "participantId");
  const status = field(formData, "status");
  const outcome = field(formData, "outcome");
  const outcomeNote = field(formData, "outcomeNote");
  const reviewerUserId = field(formData, "reviewerUserId");

  if (!participantId) return { ok: false, error: "Pick the participant to update." };
  if (status && !PARTICIPANT_STATUSES.includes(status)) return { ok: false, error: "Pick a status from the list." };
  if (outcome && !PARTICIPANT_OUTCOMES.includes(outcome)) return { ok: false, error: "Pick an outcome from the list." };
  if (!status && !outcome && !outcomeNote && !reviewerUserId) {
    return { ok: false, error: "Change at least one thing: a status, an outcome, a note or the reviewer." };
  }

  const r = await send(
    c.tenant, c.userId, "PATCH", `/review-participants/${encodeURIComponent(participantId)}`,
    {
      ...(status ? { status } : {}),
      ...(outcome ? { outcome } : {}),
      ...(outcomeNote ? { outcomeNote } : {}),
      ...(reviewerUserId ? { reviewerUserId } : {}),
    },
    "update review participants",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalReviews();
  return {
    ok: true, id: participantId,
    notice: status === "submitted" ? "Participant updated. The server records the submission time itself." : "Participant updated.",
  };
}

// ═══════════════════════════════════════════════════════════ CALENDARS ══════════════════════

// ---- Create a calendar ----
// POST calendars (`create`). `weekendDays` repeats (ISO 1 to 7). The server falls back to Sat+Sun when none survives
// its filter, so "no weekend" cannot be saved and is refused here rather than silently changed. `isDefault` demotes
// the current default.
export async function createCalendar(tenantId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const name = field(formData, "name");
  const country = countryCode(field(formData, "countryCode"));
  const days = [...new Set(formData.getAll("weekendDays").map((v) => Number(v)))];
  const isDefault = flag(formData, "isDefault");

  if (!name) return { ok: false, error: "A name is required." };
  if (country.error) return { ok: false, error: country.error };
  if (days.length === 0) {
    return { ok: false, error: "Tick at least one weekend day. The server cannot save a calendar with no weekend and would use Saturday and Sunday instead." };
  }
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { ok: false, error: "Weekend days must be Monday to Sunday." };

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, "POST", "/calendars",
    { name, countryCode: country.value, weekendDays: days.sort((a, b) => a - b), isDefault },
    "create holiday calendars",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  return {
    ok: true, id: str(r.body.id),
    notice: isDefault ? "Calendar created and made the default; the previous default was demoted." : "Calendar created.",
  };
}

// ---- Add a holiday ----
// POST calendars/:id/holidays (`create`), one holiday per call (the route takes a list). Upsert by date: a holiday
// already on that date is REPLACED. `deductsEntitlement` only means something for joint leave; the server stores null
// for the other kinds.
export async function addHoliday(tenantId: string, calendarId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!calendarId) return { ok: false, error: "No calendar was given." };

  const day = field(formData, "day");
  const name = field(formData, "name");
  const kind = field(formData, "kind") || "public";
  const deductsEntitlement = flag(formData, "deductsEntitlement");

  const e = isoDate(day, "The date", true);
  if (e) return { ok: false, error: e };
  if (!name) return { ok: false, error: "A name is required." };
  if (!HOLIDAY_KINDS.includes(kind)) return { ok: false, error: "Pick a kind from the list." };

  const r = await send<{ calendarId?: string; upserted?: number }>(
    c.tenant, c.userId, "POST", `/calendars/${encodeURIComponent(calendarId)}/holidays`,
    { holidays: [{ day, name, kind, ...(kind === "joint_leave" ? { deductsEntitlement } : {}) }] },
    "add holidays",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  return { ok: true, id: calendarId, notice: "Holiday saved. A holiday already on that date was replaced, not duplicated." };
}

// ---- Delete a holiday ----
// DELETE holidays/:id (`delete`). A hard delete: the server keeps no record of the holiday afterwards, and leave
// already charged against it is not restated.
export async function deleteHoliday(tenantId: string, holidayId: string): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!holidayId) return { ok: false, error: "No holiday was given." };

  const r = await send(c.tenant, c.userId, "DELETE", `/holidays/${encodeURIComponent(holidayId)}`, undefined, "delete holidays");
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  return { ok: true, id: holidayId, notice: "Holiday deleted." };
}

// ═══════════════════════════════════════════════════════════ LEAVE POLICIES ═════════════════

type PolicyFields = { body: Record<string, unknown>; error?: string };

/** The numeric and boolean fields the create and edit forms share. Days become minutes here. */
function policyFields(formData: FormData, mode: "create" | "edit"): PolicyFields {
  const body: Record<string, unknown> = {};
  const name = field(formData, "name");
  const accrualMethod = field(formData, "accrualMethod") || (mode === "create" ? "upfront" : "");

  if (!name) return { body, error: "A name is required." };
  body.name = name;
  if (accrualMethod) {
    if (!ACCRUAL_METHODS.includes(accrualMethod)) return { body, error: "Pick an accrual method from the list." };
    body.accrualMethod = accrualMethod;
  } else if (mode === "edit") {
    return { body, error: "Pick an accrual method from the list." };
  }

  const days = (key: string, what: string, min: number): { value?: number; error?: string } => {
    const n = num(field(formData, key), what, min);
    if (n.error || n.value === undefined) return n;
    return { value: Math.round(n.value * MINUTES_PER_DAY) };
  };
  const entitlement = days("annualEntitlementDays", "The annual entitlement", 0);
  if (entitlement.error) return { body, error: entitlement.error };
  const carryover = days("carryoverMaxDays", "The carry-over limit", 0);
  if (carryover.error) return { body, error: carryover.error };
  const waiting = num(field(formData, "waitingPeriodMonths"), "The waiting period", 0, 60, true);
  if (waiting.error) return { body, error: waiting.error };
  const expiry = num(field(formData, "carryoverExpiryMonths"), "The carry-over expiry", 0, 24, true);
  if (expiry.error) return { body, error: expiry.error };
  const notice = num(field(formData, "minNoticeDays"), "The minimum notice", 0, undefined, true);
  if (notice.error) return { body, error: notice.error };
  const escalateRaw = num(field(formData, "escalateOverDays"), "The escalation threshold", 0);
  if (escalateRaw.error) return { body, error: escalateRaw.error };
  const escalateMinutes = escalateRaw.value === undefined ? undefined : Math.round(escalateRaw.value * MINUTES_PER_DAY);
  if (escalateMinutes !== undefined && escalateMinutes < 1) return { body, error: "The escalation threshold must be more than zero days, or blank for no second approver." };

  if (entitlement.value !== undefined) body.annualEntitlementMinutes = entitlement.value;
  if (carryover.value !== undefined) body.carryoverMaxMinutes = carryover.value;
  if (waiting.value !== undefined) body.waitingPeriodMonths = waiting.value;
  if (expiry.value !== undefined) body.carryoverExpiryMonths = expiry.value;
  if (notice.value !== undefined) body.minNoticeDays = notice.value;
  body.prorateFirstYear = flag(formData, "prorateFirstYear");
  body.allowNegativeBalance = flag(formData, "allowNegativeBalance");
  body.excludesHolidays = flag(formData, "excludesHolidays");
  if (mode === "edit") {
    // The edit form is filled with what the server holds, so a blank means "none": null clears the threshold.
    body.escalateOverMinutes = escalateMinutes ?? null;
    body.isActive = flag(formData, "isActive");
    // A blank number on edit would otherwise leave the old value; the form always fills them, so a blank is refused.
    for (const [key, what] of [
      ["annualEntitlementDays", "The annual entitlement"], ["waitingPeriodMonths", "The waiting period"],
      ["carryoverMaxDays", "The carry-over limit"], ["carryoverExpiryMonths", "The carry-over expiry"], ["minNoticeDays", "The minimum notice"],
    ] as const) {
      if (!field(formData, key)) return { body, error: `${what} is required (use 0 for none).` };
    }
  } else if (escalateMinutes !== undefined) {
    body.escalateOverMinutes = escalateMinutes;
  }
  return { body };
}

// ---- Create a policy ----
// POST leave-policies (`create`). The leave type is fixed at creation (it is not an editable field on the server).
export async function createLeavePolicy(tenantId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const leaveType = field(formData, "leaveType");
  if (!LEAVE_TYPES.includes(leaveType)) return { ok: false, error: "Pick a leave type from the list." };
  const parsed = policyFields(formData, "create");
  if (parsed.error) return { ok: false, error: parsed.error };

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, "POST", "/leave-policies", { ...parsed.body, leaveType }, "create leave policies",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  return { ok: true, id: str(r.body.id), notice: "Leave policy created. Assign it to people, a unit or the whole company to put it to use." };
}

// ---- Edit a policy ----
// PATCH leave-policies/:id (`update`). Allow-listed fields only; the form sends every one of them.
export async function updateLeavePolicy(tenantId: string, policyId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!policyId) return { ok: false, error: "No leave policy was given." };

  const parsed = policyFields(formData, "edit");
  if (parsed.error) return { ok: false, error: parsed.error };

  const r = await send(
    c.tenant, c.userId, "PATCH", `/leave-policies/${encodeURIComponent(policyId)}`, parsed.body, "edit leave policies",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  return { ok: true, id: policyId, notice: "Leave policy saved." };
}

// ---- Assign a policy ----
// POST leave-policies/:id/assignments (`create`). One target at most: a person (a USER id), an org unit (the org
// node's id, free text on the server) or neither, the company-wide default. Dated; an end date is optional.
export async function assignLeavePolicy(tenantId: string, policyId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!policyId) return { ok: false, error: "No leave policy was given." };

  const target = field(formData, "target") || "tenant";
  const subjectUserId = field(formData, "subjectUserId");
  const unitNodeId = field(formData, "unitNodeId");
  const effectiveFrom = field(formData, "effectiveFrom");
  const effectiveTo = field(formData, "effectiveTo");

  if (!["tenant", "person", "unit"].includes(target)) return { ok: false, error: "Pick who the policy applies to." };
  if (target === "person" && !subjectUserId) return { ok: false, error: "Pick the person this policy applies to." };
  if (target === "unit" && !unitNodeId) return { ok: false, error: "Give the id of the org unit this policy applies to." };
  const fromError = isoDate(effectiveFrom, "The start date", true);
  if (fromError) return { ok: false, error: fromError };
  const toError = isoDate(effectiveTo, "The end date", false);
  if (toError) return { ok: false, error: toError };
  if (effectiveTo && effectiveTo < effectiveFrom) return { ok: false, error: "The end date must be on or after the start date." };

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, "POST", `/leave-policies/${encodeURIComponent(policyId)}/assignments`,
    {
      effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}),
      ...(target === "person" ? { subjectUserId } : {}),
      ...(target === "unit" ? { unitNodeId } : {}),
    },
    "assign leave policies",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  return { ok: true, id: str(r.body.id), notice: "Assignment saved. The most specific assignment for a person wins." };
}

// ═══════════════════════════════════════════════════════════ PAY GRADES ═════════════════════

// ---- Create a pay grade ----
// POST pay-grades (`create`). The band must satisfy min <= mid <= max (a database CHECK); amounts are numeric(14,2),
// so a third decimal would be rounded without telling anyone and is refused here.
export async function createPayGrade(tenantId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const code = field(formData, "code");
  const name = field(formData, "name");
  const track = field(formData, "track") || "individual";
  const rateBasis = field(formData, "rateBasis") || "monthly";
  const currency = currencyCode(field(formData, "currency"));

  if (!code) return { ok: false, error: "A code is required." };
  if (!name) return { ok: false, error: "A name is required." };
  if (!GRADE_TRACKS.includes(track)) return { ok: false, error: "Pick a track from the list." };
  if (!RATE_BASES.includes(rateBasis)) return { ok: false, error: "Pick a rate basis from the list." };
  if (currency.error) return { ok: false, error: currency.error };
  const level = num(field(formData, "level"), "The level", 1, undefined, true);
  if (level.error) return { ok: false, error: level.error };

  const minRaw = field(formData, "minAmount");
  const maxRaw = field(formData, "maxAmount");
  const midRaw = field(formData, "midAmount");
  if (!minRaw) return { ok: false, error: "The band minimum is required." };
  if (!maxRaw) return { ok: false, error: "The band maximum is required." };
  const min = num(minRaw, "The band minimum", 0);
  if (min.error) return { ok: false, error: min.error };
  const max = num(maxRaw, "The band maximum", 0);
  if (max.error) return { ok: false, error: max.error };
  const mid = num(midRaw, "The band midpoint", 0);
  if (mid.error) return { ok: false, error: mid.error };
  for (const [raw, what] of [[minRaw, "The band minimum"], [maxRaw, "The band maximum"], [midRaw, "The band midpoint"]] as const) {
    if (raw && tooManyDecimals(raw, 2)) return { ok: false, error: `${what} can have at most 2 decimal places.` };
  }
  if ((max.value as number) < (min.value as number)) return { ok: false, error: "The band maximum must be at least the minimum." };
  if (mid.value !== undefined && (mid.value < (min.value as number) || mid.value > (max.value as number))) {
    return { ok: false, error: "The midpoint must sit between the minimum and the maximum." };
  }

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, "POST", "/pay-grades",
    {
      code, name, track, currency: currency.value, rateBasis, minAmount: min.value, maxAmount: max.value,
      ...(level.value !== undefined ? { level: level.value } : {}),
      ...(mid.value !== undefined ? { midAmount: mid.value } : {}),
    },
    "create pay grades",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/hr/settings");
  revalidatePath("/hr/compensation");
  return { ok: true, id: str(r.body.id), notice: "Pay grade created. Compensation outside its band is refused for anyone on this grade." };
}

// ═══════════════════════════════════════════════════════════ STATUTORY PARAMETERS ═══════════

// ---- Create a parameter set ----
// POST statutory-parameters (`create`). Created UNRATIFIED. Each parameter needs a key and exactly one of a number or
// a JSON value (the server and a CHECK both say so); keys are unique within a set; a number is numeric(18,6). The
// database refuses a set that overlaps another set of the same country in time: that comes back in the server's words.
// The parameter rows come in as parallel lists (paramKey, paramValueNum, paramValueJson, paramUnit, paramNote).
export async function createParameterSet(tenantId: string, formData: FormData): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };

  const name = field(formData, "name");
  const country = countryCode(field(formData, "countryCode"));
  const effectiveFrom = field(formData, "effectiveFrom");
  const effectiveTo = field(formData, "effectiveTo");
  const sourceNote = field(formData, "sourceNote");

  if (!name) return { ok: false, error: "A name is required." };
  if (country.error) return { ok: false, error: country.error };
  const fromError = isoDate(effectiveFrom, "The effective date", true);
  if (fromError) return { ok: false, error: fromError };
  const toError = isoDate(effectiveTo, "The end date", false);
  if (toError) return { ok: false, error: toError };
  if (effectiveTo && effectiveTo < effectiveFrom) return { ok: false, error: "The end date must be on or after the effective date." };

  const keys = formData.getAll("paramKey").map((v) => String(v).trim());
  const nums = formData.getAll("paramValueNum").map((v) => String(v).trim());
  const jsons = formData.getAll("paramValueJson").map((v) => String(v).trim());
  const units = formData.getAll("paramUnit").map((v) => String(v).trim());
  const notes = formData.getAll("paramNote").map((v) => String(v).trim());

  const parameters: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const rawNum = nums[i] ?? "";
    const rawJson = jsons[i] ?? "";
    const unit = units[i] ?? "";
    const note = notes[i] ?? "";
    if (!key && !rawNum && !rawJson && !unit && !note) continue; // an unused row
    const row = `Parameter ${i + 1}`;
    if (!key) return { ok: false, error: `${row} needs a key.` };
    if (seen.has(key)) return { ok: false, error: `The key "${key}" is used twice; a key can appear once in a set.` };
    seen.add(key);
    if (!!rawNum === !!rawJson) return { ok: false, error: `"${key}" needs exactly one of a number or a JSON value.` };
    if (unit && !PARAMETER_UNITS.includes(unit)) return { ok: false, error: `"${key}": pick a unit from the list.` };
    const entry: Record<string, unknown> = { key };
    if (rawNum) {
      const n = Number(rawNum);
      if (!Number.isFinite(n)) return { ok: false, error: `"${key}": the number is not valid.` };
      if (tooManyDecimals(rawNum, 6)) return { ok: false, error: `"${key}": a number can have at most 6 decimal places.` };
      if (Math.abs(n) >= 1e12) return { ok: false, error: `"${key}": the number is too large (at most 12 digits before the point).` };
      entry.valueNum = n;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        return { ok: false, error: `"${key}": the JSON value is not valid JSON.` };
      }
      if (parsed === null) return { ok: false, error: `"${key}": a JSON value cannot be null.` };
      entry.valueJson = parsed;
    }
    if (unit) entry.unit = unit;
    if (note) entry.note = note;
    parameters.push(entry);
  }

  const r = await send<{ id?: string; ratified?: boolean }>(
    c.tenant, c.userId, "POST", "/statutory-parameters",
    {
      name, countryCode: country.value, effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}),
      ...(sourceNote ? { sourceNote } : {}),
      parameters,
    },
    "create statutory parameter sets",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  const unratified = r.body.ratified !== true;
  return {
    ok: true, id: str(r.body.id),
    notice: `Parameter set created with ${parameters.length} parameter${parameters.length === 1 ? "" : "s"}${unratified ? ", UNRATIFIED" : ""}. ${unratified
      ? "Approving a payroll run against it needs an explicit override until a company administrator ratifies it."
      : ""}`.trim(),
  };
}

// ---- Ratify a parameter set ----
// POST statutory-parameters/:id/ratify (`ratify`): company_admin only, at high assurance. Refused when already
// ratified (the first signature is the one that counts). The optional note REPLACES the set's source note.
export async function ratifyParameterSet(tenantId: string, setId: string, note?: string): Promise<PolicyResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!setId) return { ok: false, error: "No parameter set was given." };

  const text = (note ?? "").trim();
  const r = await send<{ ok?: boolean; ratified?: boolean; ratifiedAt?: string }>(
    c.tenant, c.userId, "POST", `/statutory-parameters/${encodeURIComponent(setId)}/ratify`,
    text ? { note: text } : {},
    "ratify statutory parameters", true,
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalSettings();
  if (r.body.ratified !== true) {
    return { ok: true, id: setId, notice: "The server answered but did not confirm the ratification. Check the set's status below." };
  }
  const when = typeof r.body.ratifiedAt === "string" ? ` on ${r.body.ratifiedAt.slice(0, 10)}` : "";
  return { ok: true, id: setId, notice: `Parameter set ratified${when}. Payroll will use these parameters without an override from now on.` };
}
