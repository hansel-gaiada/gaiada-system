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
import { CYCLE_KINDS, CYCLE_STATUSES, PARTICIPANT_STATUSES, PARTICIPANT_OUTCOMES } from "./hrPolicy";

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
function isoDate(raw: string, what: string, required: boolean): string | undefined {
  if (!raw) return required ? `${what} is required (YYYY-MM-DD).` : undefined;
  return ISO_DATE.test(raw) ? undefined : `${what} must be YYYY-MM-DD.`;
}
function revalReviews() {
  revalidatePath("/hr/reviews");
  revalidatePath("/hr/reviews/[cycleId]", "page");
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
