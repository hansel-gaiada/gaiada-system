"use server";
// HR › Recruitment write paths (DW-7f-2) — requisitions, candidates, applications, interviews, scorecards,
// offers, the convert-to-employee step and the pipeline stages. Same convention as lib/hrPayrollActions.ts:
// `ctx()` + `send()`, and three rules.
//   1. Nothing here pre-checks a capability. The screens hide what the mirror says is not offered, but the
//      policy has attribute arms (hiring manager, recruiter, panelist) the mirror cannot express, so the
//      server decides and says why.
//   2. Every refusal is passed back as the server worded it. A 403 gets a sentence naming what was refused;
//      a 400/404/409 carries the server's own message. "Something went wrong" is only the answer when the
//      server gave no reason at all.
//   3. A result never claims a state the server did not report. The pages re-read (router.refresh).
//
// Backend: platform-nest src/modules/hr/recruitment.controller.ts, Cerbos kind `hr_recruitment`. It refuses a
// wrong-status call as 400 ("requisition is 'open', not draft"), a duplicate candidate email or live
// application as 409, a missing row as 404.
//
// This file exports async functions only ("use server" allows nothing else); the value sets and helpers
// the forms share are in lib/hrRecruitment.ts.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  EMPLOYMENT_TYPES, WORK_MODES, CANDIDATE_SOURCES, PATCHABLE_REQUISITION_STATUSES,
} from "./hrRecruitment";

export type RecruitmentResult = {
  ok: boolean;
  error?: string;
  id?: string;
  /** The status the server reported in its response body, when it reported one. */
  status?: string;
  /** What happened, in words, from the server's response. */
  notice?: string;
  /** Submit: the approval the server raised, so the screen can link to the approvals queue. */
  approvalId?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function ctx(tenantOverride?: string): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const tenant = tenantOverride || (await getActiveTenant(await getMe(userId)));
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

const HIGH_ASSURANCE = " Converting an offer also needs a high-assurance sign-in.";

function refusal(e: PlatformError, forbiddenVerb: string, needsHighAssurance: boolean): string {
  if (e.status === 403) {
    return `You don't have permission to ${forbiddenVerb}.${needsHighAssurance ? HIGH_ASSURANCE : ""}`;
  }
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
  tenant: string, userId: string, method: "POST" | "PATCH", path: string, bodyObj: unknown,
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
/** An optional number field: "" is absent, anything else must be a finite number of at least `min`. */
function num(raw: string, what: string, min: number, integer = false): { value?: number; error?: string } {
  if (!raw) return {};
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return { error: `${what} must be a number, ${min === 0 ? "zero" : `${min}`} or more.` };
  if (integer && !Number.isInteger(n)) return { error: `${what} must be a whole number.` };
  return { value: n };
}

// Revalidation. A requisition's page and the list both show its status and counts. An application action also
// touches the requisition page (its applications table), whose id the action does not know: the dynamic route
// is revalidated as a pattern.
function revalRequisition(requisitionId?: string) {
  revalidatePath("/hr/recruitment");
  if (requisitionId) revalidatePath(`/hr/recruitment/${requisitionId}`);
  else revalidatePath("/hr/recruitment/[requisitionId]", "page");
}
function revalApplication(applicationId?: string) {
  revalidatePath("/hr/recruitment");
  revalidatePath("/hr/recruitment/[requisitionId]", "page");
  if (applicationId) revalidatePath(`/hr/recruitment/applications/${applicationId}`);
  else revalidatePath("/hr/recruitment/applications/[applicationId]", "page");
}

// ═══════════════════════════════════════════════════════════ REQUISITIONS ═══════════════════

type RequisitionFields = {
  body: Record<string, unknown>;
  error?: string;
};

/**
 * The fields a requisition form carries, validated and shaped the way the controller reads them (numbers as
 * numbers). Only non-empty fields are included: a PATCH sets every key it is given, so an empty text field
 * must not overwrite a value, and a blank date would break the column. A value therefore cannot be cleared
 * from this form.
 */
function requisitionBody(formData: FormData): RequisitionFields {
  const body: Record<string, unknown> = {};
  const title = field(formData, "title");
  if (title) body.title = title;

  const employmentType = field(formData, "employmentType");
  if (employmentType) {
    if (!EMPLOYMENT_TYPES.includes(employmentType)) return { body, error: "Pick an employment type from the list." };
    body.employmentType = employmentType;
  }
  const workMode = field(formData, "workMode");
  if (workMode) {
    if (!WORK_MODES.includes(workMode)) return { body, error: "Pick a work mode from the list." };
    body.workMode = workMode;
  }
  const openings = num(field(formData, "openings"), "Openings", 1, true);
  if (openings.error) return { body, error: openings.error };
  if (openings.value !== undefined) body.openings = openings.value;

  const contract = num(field(formData, "contractMonths"), "Contract months", 1, true);
  if (contract.error) return { body, error: contract.error };
  if (contract.value !== undefined) {
    if (contract.value > 60) return { body, error: "Contract months must be between 1 and 60." };
    body.contractMonths = contract.value;
  }
  const salaryMin = num(field(formData, "salaryMin"), "The salary minimum", 0);
  if (salaryMin.error) return { body, error: salaryMin.error };
  const salaryMax = num(field(formData, "salaryMax"), "The salary maximum", 0);
  if (salaryMax.error) return { body, error: salaryMax.error };
  if (salaryMin.value !== undefined && salaryMax.value !== undefined && salaryMax.value < salaryMin.value) {
    return { body, error: "The salary maximum must be at least the minimum." };
  }
  if (salaryMin.value !== undefined) body.salaryMin = salaryMin.value;
  if (salaryMax.value !== undefined) body.salaryMax = salaryMax.value;

  const targetStartOn = field(formData, "targetStartOn");
  if (targetStartOn) {
    if (!ISO_DATE.test(targetStartOn)) return { body, error: "The target start date must be YYYY-MM-DD." };
    body.targetStartOn = targetStartOn;
  }
  for (const key of ["location", "description", "hiringManagerUserId", "recruiterUserId"]) {
    const v = field(formData, key);
    if (v) body[key] = v;
  }
  return { body };
}

// ---- Create ----
// POST requisitions (authorize hr_recruitment `create`; the UI mirror is hr.recruitment.manage). Always a draft;
// it needs submitting and approval before it opens. 400 reference/title missing, salaryMax < salaryMin.
export async function createRequisition(formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(field(formData, "companyId") || undefined);
  if ("error" in c) return { ok: false, error: c.error };

  const reference = field(formData, "reference");
  if (!reference) return { ok: false, error: "A requisition reference is required." };
  if (!field(formData, "title")) return { ok: false, error: "A title is required." };
  const currency = (field(formData, "currency") || "IDR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Currency must be a 3-letter code such as IDR." };
  const parsed = requisitionBody(formData);
  if (parsed.error) return { ok: false, error: parsed.error };

  const r = await send<{ id?: string; status?: string }>(
    c.tenant, c.userId, "POST", "/requisitions", { reference, currency, ...parsed.body }, "create requisitions",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalRequisition();
  return {
    ok: true, id: str(r.body.id), status: str(r.body.status),
    notice: `Requisition ${reference} created as a draft. Submit it for approval when it is ready.`,
  };
}

// ---- Edit ----
// PATCH requisitions/:id (authorize `update`, which a requisition's hiring manager and recruiter also hold).
// The server does not allow the reference or currency to change, and it does not re-check the salary range:
// the range is checked here.
export async function updateRequisition(tenantId: string, requisitionId: string, formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!requisitionId) return { ok: false, error: "No requisition selected." };

  const parsed = requisitionBody(formData);
  if (parsed.error) return { ok: false, error: parsed.error };
  if (Object.keys(parsed.body).length === 0) return { ok: false, error: "Change at least one field." };

  const r = await send(c.tenant, c.userId, "PATCH", `/requisitions/${encodeURIComponent(requisitionId)}`, parsed.body, "edit this requisition");
  if (!r.ok) return { ok: false, error: r.error };
  revalRequisition(requisitionId);
  return { ok: true, id: requisitionId, notice: "Requisition updated." };
}

// ---- Status (hold, close, cancel, back to draft) ----
// The same PATCH. The server refuses `open` and `pending_approval` here (the approval flow owns them): 400.
export async function setRequisitionStatus(tenantId: string, requisitionId: string, status: string): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!requisitionId) return { ok: false, error: "No requisition selected." };
  if (!PATCHABLE_REQUISITION_STATUSES.includes(status)) {
    return { ok: false, error: "Pick a status from the list. A requisition opens only through approval." };
  }
  const r = await send(c.tenant, c.userId, "PATCH", `/requisitions/${encodeURIComponent(requisitionId)}`, { status }, "change this requisition's status");
  if (!r.ok) return { ok: false, error: r.error };
  revalRequisition(requisitionId);
  return { ok: true, id: requisitionId, status, notice: `Requisition set to ${status.replace("_", " ")}.` };
}

// ---- Submit for approval ----
// POST requisitions/:id/submit (authorize `update`, with no attribute arm, so only the manage tier). Draft only:
// 400 "requisition is 'open', not draft". The server raises an automation approval and notifies the deciders;
// approving it is on the approvals queue, not here.
export async function submitRequisition(tenantId: string, requisitionId: string): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!requisitionId) return { ok: false, error: "No requisition selected." };

  const r = await send<{ approvalId?: string; status?: string }>(
    c.tenant, c.userId, "POST", `/requisitions/${encodeURIComponent(requisitionId)}/submit`, undefined, "submit requisitions",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalRequisition(requisitionId);
  return {
    ok: true, id: requisitionId, status: str(r.body.status), approvalId: str(r.body.approvalId),
    notice: "Submitted for approval. It opens when someone who can decide approvals approves it.",
  };
}

// ═══════════════════════════════════════════════════════════ CANDIDATES ═════════════════════

// POST candidates (authorize `create`, manage tier). 400 fullName missing; 409 "a candidate with this email
// already exists in the pool".
export async function createCandidate(formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(field(formData, "companyId") || undefined);
  if ("error" in c) return { ok: false, error: c.error };

  const fullName = field(formData, "fullName");
  if (!fullName) return { ok: false, error: "The candidate's full name is required." };
  const source = field(formData, "source") || "direct";
  if (!CANDIDATE_SOURCES.includes(source)) return { ok: false, error: "Pick a source from the list." };
  const email = field(formData, "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email address does not look right." };
  const consentGivenAt = field(formData, "consentGivenAt");
  const retentionUntil = field(formData, "retentionUntil");
  if (consentGivenAt && !ISO_DATE.test(consentGivenAt)) return { ok: false, error: "The consent date must be YYYY-MM-DD." };
  if (retentionUntil && !ISO_DATE.test(retentionUntil)) return { ok: false, error: "The retention date must be YYYY-MM-DD." };

  const body: Record<string, unknown> = { fullName, source };
  for (const key of ["email", "phone", "headline", "location", "sourceDetail", "notes"]) {
    const v = field(formData, key);
    if (v) body[key] = v;
  }
  if (consentGivenAt) body.consentGivenAt = consentGivenAt;
  if (retentionUntil) body.retentionUntil = retentionUntil;

  const r = await send<{ id?: string }>(c.tenant, c.userId, "POST", "/candidates", body, "add candidates");
  if (!r.ok) return { ok: false, error: r.error };
  revalRequisition();
  return { ok: true, id: str(r.body.id), notice: `${fullName} added to the talent pool.` };
}

// POST candidates/:id/erasure-request (authorize `update`, manage tier). It stamps the row; it is not an
// immediate delete. A purge sweep acts on it later. Asking twice is harmless (the first stamp is kept).
export async function requestCandidateErasure(tenantId: string, candidateId: string): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!candidateId) return { ok: false, error: "No candidate selected." };

  const r = await send(c.tenant, c.userId, "POST", `/candidates/${encodeURIComponent(candidateId)}/erasure-request`, undefined, "request erasure of candidate data");
  if (!r.ok) return { ok: false, error: r.error };
  revalRequisition();
  return { ok: true, id: candidateId, notice: "Erasure requested. The candidate's data is purged by the retention sweep, not deleted now." };
}
