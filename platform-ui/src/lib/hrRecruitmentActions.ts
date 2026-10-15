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
  INTERVIEW_KINDS, INTERVIEW_STATUSES, INTERVIEW_OUTCOMES, zonedLocalToIso,
  RECOMMENDATIONS, RATE_BASES, OFFER_SET_STATUSES,
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
  /** Convert: the employee record the server created. */
  employeeId?: string;
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

// ═════════════════════════════════════════════════════════ APPLICATIONS ═════════════════════

// POST applications (authorize `create`, manage tier). A candidate on a requisition. 409 "this candidate already
// has a live application for that requisition". The stage defaults to "applied" on the server when none is sent.
export async function createApplication(formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(field(formData, "companyId") || undefined);
  if ("error" in c) return { ok: false, error: c.error };

  const requisitionId = field(formData, "requisitionId");
  const candidateId = field(formData, "candidateId");
  const stageKey = field(formData, "stageKey");
  const appliedOn = field(formData, "appliedOn");
  if (!requisitionId) return { ok: false, error: "No requisition selected." };
  if (!candidateId) return { ok: false, error: "Pick the candidate to add." };
  if (appliedOn && !ISO_DATE.test(appliedOn)) return { ok: false, error: "The applied date must be YYYY-MM-DD." };

  const r = await send<{ id?: string; stageKey?: string; status?: string }>(
    c.tenant, c.userId, "POST", "/applications",
    { requisitionId, candidateId, ...(stageKey ? { stageKey } : {}), ...(appliedOn ? { appliedOn } : {}) },
    "add applications",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication();
  revalRequisition(requisitionId);
  return {
    ok: true, id: str(r.body.id), status: str(r.body.status),
    notice: `Added to the pipeline${r.body.stageKey ? ` at ${r.body.stageKey}` : ""}.`,
  };
}

// POST applications/:id/stage (authorize `update`; a requisition's hiring manager and recruiter also hold it).
// One route for advance, reject and withdraw: the server derives the new status from the stage's own terminal
// kind and says what it set. 400 "application is 'hired' and cannot be moved", 400 "unknown pipeline stage".
// Moving to a terminal stage ends the application. Moving to a `hired` stage does NOT create an employee; that
// is the offer's convert step.
export async function moveApplicationStage(tenantId: string, applicationId: string, formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!applicationId) return { ok: false, error: "No application selected." };

  const stageKey = field(formData, "stageKey");
  if (!stageKey) return { ok: false, error: "Pick the stage to move to." };
  const note = field(formData, "note");
  const rejectionReason = field(formData, "rejectionReason");

  const r = await send<{ from?: string; to?: string; status?: string }>(
    c.tenant, c.userId, "POST", `/applications/${encodeURIComponent(applicationId)}/stage`,
    { stageKey, ...(note ? { note } : {}), ...(rejectionReason ? { rejectionReason } : {}) },
    "move this application",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication(applicationId);
  const status = str(r.body.status);
  return {
    ok: true, id: applicationId, status,
    notice: `Moved${r.body.from ? ` from ${r.body.from}` : ""} to ${str(r.body.to) ?? stageKey}${status && status !== "active" ? `; the application is now ${status}` : ""}.`,
  };
}

// ═════════════════════════════════════════════════════════ INTERVIEWS ═══════════════════════

function checkZone(raw: string): string | undefined {
  try { new Intl.DateTimeFormat("en-US", { timeZone: raw }); return raw; } catch { return undefined; }
}

// POST applications/:id/interviews (authorize `update` with the application's owners, so a hiring manager or
// recruiter can). The server stores the instants as given and only displays the timezone, so the times typed in
// that zone are converted to exact instants here. 400 end not after start. The server notifies each panelist.
export async function scheduleInterview(tenantId: string, applicationId: string, formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!applicationId) return { ok: false, error: "No application selected." };

  const kind = field(formData, "kind") || "interview";
  if (!INTERVIEW_KINDS.includes(kind)) return { ok: false, error: "Pick an interview type from the list." };
  const timezone = field(formData, "timezone") || "Asia/Makassar";
  if (!checkZone(timezone)) return { ok: false, error: "That time zone is not recognised. Use a name such as Asia/Makassar." };
  const start = zonedLocalToIso(field(formData, "scheduledStart"), timezone);
  const end = zonedLocalToIso(field(formData, "scheduledEnd"), timezone);
  if (!start || !end) return { ok: false, error: "A start and an end time are required." };
  if (new Date(end) <= new Date(start)) return { ok: false, error: "The interview must end after it starts." };
  const meetingUrl = field(formData, "meetingUrl");
  if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) return { ok: false, error: "The meeting link must start with http:// or https://." };
  const location = field(formData, "location");
  const panelists = [...new Set(formData.getAll("panelists").map((v) => String(v).trim()).filter(Boolean))];

  const r = await send<{ id?: string }>(
    c.tenant, c.userId, "POST", `/applications/${encodeURIComponent(applicationId)}/interviews`,
    {
      kind, scheduledStart: start, scheduledEnd: end, timezone,
      ...(location ? { location } : {}), ...(meetingUrl ? { meetingUrl } : {}),
      ...(panelists.length ? { panelists: panelists.map((userId) => ({ userId })) } : {}),
    },
    "schedule interviews",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication(applicationId);
  return {
    ok: true, id: str(r.body.id),
    notice: panelists.length ? `Interview scheduled. ${panelists.length} panelist(s) were notified.` : "Interview scheduled.",
  };
}

// PATCH interviews/:id (authorize `update` with the application's owners). Status, outcome and the times; the
// server does not move an interview's timezone. Times are sent only when both are given, in the interview's own zone.
// `applicationId` is only for revalidating the page; the route does not take it.
export async function updateInterview(tenantId: string, applicationId: string, interviewId: string, formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!interviewId) return { ok: false, error: "No interview selected." };

  const body: Record<string, unknown> = {};
  const status = field(formData, "status");
  if (status) {
    if (!INTERVIEW_STATUSES.includes(status)) return { ok: false, error: "Pick a status from the list." };
    body.status = status;
  }
  const outcome = field(formData, "outcome");
  if (outcome) {
    if (!INTERVIEW_OUTCOMES.includes(outcome)) return { ok: false, error: "Pick an outcome from the list." };
    body.outcome = outcome;
  }
  const rawStart = field(formData, "scheduledStart");
  const rawEnd = field(formData, "scheduledEnd");
  if (rawStart || rawEnd) {
    const timezone = field(formData, "timezone") || "Asia/Makassar";
    if (!checkZone(timezone)) return { ok: false, error: "That time zone is not recognised." };
    const start = zonedLocalToIso(rawStart, timezone);
    const end = zonedLocalToIso(rawEnd, timezone);
    if (!start || !end) return { ok: false, error: "Give both a start and an end time, or neither." };
    if (new Date(end) <= new Date(start)) return { ok: false, error: "The interview must end after it starts." };
    body.scheduledStart = start;
    body.scheduledEnd = end;
  }
  if (Object.keys(body).length === 0) return { ok: false, error: "Change at least one field." };

  const r = await send(c.tenant, c.userId, "PATCH", `/interviews/${encodeURIComponent(interviewId)}`, body, "edit this interview");
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication(applicationId || undefined);
  return { ok: true, id: interviewId, notice: "Interview updated." };
}

// ═════════════════════════════════════════════════════════ PIPELINE STAGES ══════════════════

// POST pipeline-stages (authorize `create`, manage tier). An upsert by key: it adds a stage or updates the label,
// order, terminal kind and interview flag of the one with that key. It cannot deactivate or delete a stage. 400
// "stage 'x' is terminal and needs terminalKind (hired|rejected|withdrawn)".
export async function upsertPipelineStage(formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(field(formData, "companyId") || undefined);
  if ("error" in c) return { ok: false, error: c.error };

  const key = field(formData, "key");
  const label = field(formData, "label");
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    return { ok: false, error: "The stage key is its stable handle: lowercase letters, digits and underscores, starting with a letter." };
  }
  if (!label) return { ok: false, error: "A label is required." };
  const order = num(field(formData, "sortOrder"), "The order", 0, true);
  if (order.error) return { ok: false, error: order.error };
  const terminalKind = field(formData, "terminalKind");
  if (terminalKind && !["hired", "rejected", "withdrawn"].includes(terminalKind)) {
    return { ok: false, error: "Pick a terminal kind from the list, or leave it blank for an ordinary stage." };
  }
  const requiresInterview = formData.get("requiresInterview") === "on" || formData.get("requiresInterview") === "true";

  const r = await send<{ upserted?: number }>(
    c.tenant, c.userId, "POST", "/pipeline-stages",
    { stages: [{
      key, label, sortOrder: order.value ?? 0, isTerminal: !!terminalKind,
      ...(terminalKind ? { terminalKind } : {}), requiresInterview,
    }] },
    "change the pipeline stages",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication();
  revalidatePath("/hr/settings");
  return { ok: true, id: key, notice: `Stage ${label} saved.` };
}

// ═════════════════════════════════════════════════════════ SCORECARDS ═══════════════════════

// POST applications/:id/scorecards (authorize `create` with the application's panel: a panelist can, and so can the
// manage tier). The reviewer is the signed-in person; the server pins it and never reads it from the body. Filing
// again for the same interview replaces your earlier scorecard, but a scorecard with NO interview is not
// de-duplicated by the database (a NULL does not collide), so each filing without one is a new row: the form asks
// for the interview. 400 recommendation not one of the five, overall outside 0 to 5.
export async function fileScorecard(tenantId: string, applicationId: string, formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!applicationId) return { ok: false, error: "No application selected." };

  const interviewId = field(formData, "interviewId");
  const recommendation = field(formData, "recommendation");
  const notes = field(formData, "notes");
  if (recommendation && !RECOMMENDATIONS.includes(recommendation)) return { ok: false, error: "Pick a recommendation from the list." };
  const overall = num(field(formData, "overall"), "The overall score", 0);
  if (overall.error) return { ok: false, error: overall.error };
  if (overall.value !== undefined && overall.value > 5) return { ok: false, error: "The overall score must be between 0 and 5." };
  if (overall.value === undefined && !recommendation && !notes) {
    return { ok: false, error: "Give an overall score, a recommendation or notes." };
  }

  const r = await send<{ id?: string; applicationRating?: string | null }>(
    c.tenant, c.userId, "POST", `/applications/${encodeURIComponent(applicationId)}/scorecards`,
    {
      ...(interviewId ? { interviewId } : {}),
      ...(overall.value !== undefined ? { overall: overall.value } : {}),
      ...(recommendation ? { recommendation } : {}),
      ...(notes ? { notes } : {}),
    },
    "file scorecards on this application",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication(applicationId);
  const rating = r.body.applicationRating;
  return {
    ok: true, id: str(r.body.id),
    notice: rating ? `Scorecard filed. The application's rating is now ${Number(rating).toFixed(2)}.` : "Scorecard filed.",
  };
}

// ═════════════════════════════════════════════════════════ OFFERS ═══════════════════════════

// POST applications/:id/offers (authorize `create`, manage tier). Always a draft. The server refuses an offer above
// the requisition's approved maximum, in words ("offer of X exceeds the requisition's approved maximum of Y — raise
// the requisition band first"), and the database allows one live offer per application and an expiry on or before the
// start date, so the screen checks the latter and offers the form only when no live offer exists.
export async function createOffer(tenantId: string, applicationId: string, formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!applicationId) return { ok: false, error: "No application selected." };

  const baseAmount = num(field(formData, "baseAmount"), "The base amount", 0);
  if (baseAmount.error) return { ok: false, error: baseAmount.error };
  if (baseAmount.value === undefined || baseAmount.value <= 0) return { ok: false, error: "The base amount must be more than zero." };
  const currency = (field(formData, "currency") || "IDR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Currency must be a 3-letter code such as IDR." };
  const rateBasis = field(formData, "rateBasis") || "monthly";
  if (!RATE_BASES.includes(rateBasis)) return { ok: false, error: "Pick a rate basis from the list." };
  const employmentType = field(formData, "employmentType");
  if (employmentType && !EMPLOYMENT_TYPES.includes(employmentType)) return { ok: false, error: "Pick an employment type from the list." };
  const probation = num(field(formData, "probationMonths"), "Probation months", 0, true);
  if (probation.error) return { ok: false, error: probation.error };
  if (probation.value !== undefined && probation.value > 12) return { ok: false, error: "Probation months must be between 0 and 12." };
  const contract = num(field(formData, "contractMonths"), "Contract months", 1, true);
  if (contract.error) return { ok: false, error: contract.error };
  if (contract.value !== undefined && contract.value > 60) return { ok: false, error: "Contract months must be between 1 and 60." };
  const startOn = field(formData, "startOn");
  const expiresOn = field(formData, "expiresOn");
  if (startOn && !ISO_DATE.test(startOn)) return { ok: false, error: "The start date must be YYYY-MM-DD." };
  if (expiresOn && !ISO_DATE.test(expiresOn)) return { ok: false, error: "The expiry date must be YYYY-MM-DD." };
  if (startOn && expiresOn && expiresOn > startOn) return { ok: false, error: "The offer must expire on or before the start date." };

  const r = await send<{ id?: string; status?: string }>(
    c.tenant, c.userId, "POST", `/applications/${encodeURIComponent(applicationId)}/offers`,
    {
      baseAmount: baseAmount.value, currency, rateBasis,
      ...(employmentType ? { employmentType } : {}),
      ...(probation.value !== undefined ? { probationMonths: probation.value } : {}),
      ...(contract.value !== undefined ? { contractMonths: contract.value } : {}),
      ...(startOn ? { startOn } : {}), ...(expiresOn ? { expiresOn } : {}),
    },
    "make offers",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication(applicationId);
  return { ok: true, id: str(r.body.id), status: str(r.body.status), notice: "Offer drafted. Mark it as sent when it goes to the candidate." };
}

// POST offers/:id/status (authorize `update` with no attribute arm, so the manage tier). sent, accepted, declined,
// expired or withdrawn. The server does not check the move (any of those from any status except converted), so the
// screen offers only the sensible ones. `converted` is only reachable through convertOffer. 404 "offer not found (or
// already converted)". A decline reason is stored when given.
export async function setOfferStatus(
  tenantId: string, applicationId: string, offerId: string, status: string, declineReason?: string,
): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!offerId) return { ok: false, error: "No offer selected." };
  if (!OFFER_SET_STATUSES.includes(status)) return { ok: false, error: "Pick a status from the list. Converting an offer is its own step." };
  const reason = (declineReason ?? "").trim();

  const r = await send<{ status?: string }>(
    c.tenant, c.userId, "POST", `/offers/${encodeURIComponent(offerId)}/status`,
    { status, ...(status === "declined" && reason ? { declineReason: reason } : {}) },
    "change this offer's status",
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication(applicationId || undefined);
  return { ok: true, id: offerId, status: str(r.body.status) ?? status, notice: `Offer marked ${status}.` };
}

// POST offers/:id/convert (authorize `convert`: the manage tier AND a high-assurance sign-in; the UI mirror is
// hr.recruitment.approve). THIS CREATES AN EMPLOYEE. In one transaction the server inserts the employee (status
// pending_start), the opening `hire` job event, a compensation record from the offer's amount, marks the offer
// converted, the application hired and counts the requisition's filled seats. 400 "offer is 'sent' — only an accepted
// offer can be converted", 400 "hireDate required (the offer carries no startOn)", 409 "offer is already converted".
export async function convertOffer(tenantId: string, applicationId: string, offerId: string, formData: FormData): Promise<RecruitmentResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (!offerId) return { ok: false, error: "No offer selected." };

  const hireDate = field(formData, "hireDate");
  const workEmail = field(formData, "workEmail");
  if (hireDate && !ISO_DATE.test(hireDate)) return { ok: false, error: "The hire date must be YYYY-MM-DD." };
  if (workEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail)) return { ok: false, error: "That work email does not look right." };

  const r = await send<{ employeeId?: string; hireDate?: string; employmentStatus?: string }>(
    c.tenant, c.userId, "POST", `/offers/${encodeURIComponent(offerId)}/convert`,
    { ...(hireDate ? { hireDate } : {}), ...(workEmail ? { workEmail } : {}) },
    "convert offers into employees", true,
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalApplication(applicationId || undefined);
  revalidatePath("/hr/people");
  revalidatePath("/hr");
  const when = str(r.body.hireDate);
  return {
    ok: true, id: offerId, employeeId: str(r.body.employeeId), status: str(r.body.employmentStatus),
    notice: `Employee record created${when ? `, starting ${when.slice(0, 10)}` : ""}, with the status ${(str(r.body.employmentStatus) ?? "pending_start").replace("_", " ")}. `
      + "The offer's pay is recorded as their opening compensation.",
  };
}
