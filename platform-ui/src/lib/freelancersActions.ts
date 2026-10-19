"use server";
// DW-10f-4b — the write path of Finance > Payables > Freelancers (BFF §61.7, §61.8, as built §61.18): rates, the vendor link,
// drafting and discarding a freelancer bill.
//
// Same `ctx()` convention as `financeActions.ts` (session -> tenant -> platformFetch), and the same result shape plus the two
// fields this surface needs: `blockers` (a 409 `bill_blocked` lists EVERY missing prerequisite at once) and `field`.
//
// ── THE SERVER IS THE BOUNDARY, THIS FILE ONLY PUTS ITS ANSWERS IN WORDS ───────────────────────────────────────
// Cerbos `finance_ap` decides: `vendor_master` (rates and the link: money terms and payees, high assurance) and `bill_entry`
// (drafting and discarding; `approve` is a different grant, so the duty split holds). A 403 is said as "You don't have
// permission to ...", or, when only the assurance tier stands in the way, as a second-factor refusal carrying the machine
// `reason` so the form offers the (simulated, dev stage) step-up. Every other refusal is a machine `reason` (rate_overlap,
// rate_used, person_has_vendor, ...) that `refusalSentence` turns into a sentence; an unknown one passes the server's own words.
//
// The checks made here are only the shape ones the server makes first, so a blank form never costs a round trip. No amount is
// computed: the hourly rate goes as the text typed (the server parses it into `numeric`, never through a float).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { isAssuranceRefusal } from "./stepUp";
import {
  isIsoDate, isReady, periodProblem, refusalSentence,
  type DraftedBill, type FlIssue, type FlPreview, type FlRate, type PreviewFreelancer,
} from "./freelancers";

const PAGE = "/finance/payables/freelancers";

export type FlActionResult<T = undefined> = {
  ok: boolean; error?: string; reason?: string; field?: string; blockers?: FlIssue[]; result?: T;
};

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

/** A refusal in words. A 403 names assurance when only the second factor stands in the way, else the missing permission. */
function refusal(e: PlatformError, what: string): FlActionResult<never> {
  if (e.status === 403) {
    return {
      ok: false,
      error: isAssuranceRefusal(e.reason) ? `You need a second factor before you can ${what}.` : `You don't have permission to ${what}.`,
      ...(e.reason ? { reason: e.reason } : {}),
    };
  }
  const blockers = (e.body as { blockers?: unknown } | undefined)?.blockers;
  return {
    ok: false,
    error: refusalSentence(e.reason, e.message),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.field ? { field: e.field } : {}),
    ...(Array.isArray(blockers) ? { blockers: blockers as FlIssue[] } : {}),
  };
}

async function call<T>(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown, what: string): Promise<FlActionResult<T>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const result = await platformFetch<T>(`/api/${c.tenant}${path}`, c.userId, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Every figure is re-read from the server after a write; none is carried over from this answer.
    revalidatePath(PAGE);
    revalidatePath("/finance/payables");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) return refusal(e, what);
    throw e;
  }
}

const AMOUNT_RE = /^\d{1,16}(\.\d+)?$/;

// ── Rates (§61.7; `vendor_master`) ──────────────────────────────────────────────────────────────────────────────

/**
 * Adds a rate: `POST finance/freelancers/:userId/rates`. An open rate that started before `validFrom` is closed the day before,
 * in the same transaction (`closedRate` says which). `hourlyRate` is the typed text, sent as text.
 */
export async function addRateAction(
  userId: string,
  input: { hourlyRate: string; validFrom: string; expenseAccountCode: string; note?: string },
): Promise<FlActionResult<FlRate & { closedRate: { id: string; validTo: string } | null }>> {
  if (!userId) return { ok: false, error: "Choose the person this rate is for.", field: "userId" };
  const hourlyRate = (input.hourlyRate ?? "").trim();
  if (!AMOUNT_RE.test(hourlyRate) || !/[1-9]/.test(hourlyRate)) {
    return { ok: false, error: "Enter an hourly rate above zero, in digits (for example 150000).", field: "hourlyRate" };
  }
  if (!isIsoDate(input.validFrom)) return { ok: false, error: "Choose the date the rate starts.", field: "validFrom" };
  const expenseAccountCode = (input.expenseAccountCode ?? "").trim();
  if (!expenseAccountCode) return { ok: false, error: "Choose the expense account the hours are booked to.", field: "expenseAccountCode" };
  const note = (input.note ?? "").trim();
  return call(
    "POST",
    `/finance/freelancers/${encodeURIComponent(userId)}/rates`,
    { hourlyRate, validFrom: input.validFrom, expenseAccountCode, ...(note ? { note } : {}) },
    "add a freelancer rate",
  );
}

/** Ends a rate on a date: `PATCH …/rates/:rateId {validTo}`. A rate that priced billed hours cannot end before them (409 `rate_used`). */
export async function endRateAction(userId: string, rateId: string, validTo: string): Promise<FlActionResult<FlRate>> {
  if (!userId || !rateId) return { ok: false, error: "Choose a rate to end." };
  if (!isIsoDate(validTo)) return { ok: false, error: "Pick the last day this rate applies.", field: "validTo" };
  return call("PATCH", `/finance/freelancers/${encodeURIComponent(userId)}/rates/${encodeURIComponent(rateId)}`, { validTo }, "end a freelancer rate");
}

/** Withdraws a rate that priced nothing billed: `DELETE …/rates/:rateId`. A used rate is 409 `rate_used`: end it instead. */
export async function withdrawRateAction(userId: string, rateId: string): Promise<FlActionResult<{ deleted: true }>> {
  if (!userId || !rateId) return { ok: false, error: "Choose a rate to withdraw." };
  return call("DELETE", `/finance/freelancers/${encodeURIComponent(userId)}/rates/${encodeURIComponent(rateId)}`, undefined, "withdraw a freelancer rate");
}

/** Links a vendor to the person it pays: `PATCH finance/ap/vendors/:vendorId/person {userId}`. `vendor_master`. */
export async function linkVendorAction(vendorId: string, userId: string): Promise<FlActionResult<{ vendorId: string; userId: string | null }>> {
  if (!vendorId) return { ok: false, error: "Choose the vendor that pays this person.", field: "vendorId" };
  if (!userId) return { ok: false, error: "Choose a person to link.", field: "userId" };
  return call("PATCH", `/finance/ap/vendors/${encodeURIComponent(vendorId)}/person`, { userId }, "link a vendor to a person");
}

// ── Bills (§61.8; `bill_entry`) ─────────────────────────────────────────────────────────────────────────────────

/** Drafts one person's bill for a period: `POST finance/freelancer-bills`. A replay answers the live draft with `deduped: true`. */
export async function draftBillAction(userId: string, periodStart: string, periodEnd: string): Promise<FlActionResult<DraftedBill>> {
  if (!userId) return { ok: false, error: "Choose a freelancer to bill." };
  const problem = periodProblem(periodStart, periodEnd);
  if (problem) return { ok: false, error: problem };
  return call("POST", "/finance/freelancer-bills", { userId, periodStart, periodEnd }, "draft a freelancer bill");
}

export interface DraftAllOutcome {
  userId: string; name: string; ok: boolean; billNo?: string; deduped?: boolean; error?: string; blockers?: FlIssue[];
}

/**
 * Drafts a bill for every freelancer who is READY right now. It re-reads the preview on the server, so "all ready" means ready at
 * the click and not at the render, then drafts one person at a time (each is its own transaction with row locks; running them
 * together would only race). One refusal does not stop the others, and every outcome is returned so the screen can say which.
 */
export async function draftAllReadyAction(periodStart: string, periodEnd: string): Promise<FlActionResult<DraftAllOutcome[]>> {
  const problem = periodProblem(periodStart, periodEnd);
  if (problem) return { ok: false, error: problem };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  let ready: PreviewFreelancer[];
  try {
    const p = await platformFetch<FlPreview>(
      `/api/${c.tenant}/finance/freelancer-bills/preview?${new URLSearchParams({ periodStart, periodEnd }).toString()}`, c.userId,
    );
    if (!p || !Array.isArray(p.freelancers)) return { ok: false, error: "The preview could not be read, so nothing was drafted." };
    ready = p.freelancers.filter(isReady);
  } catch (e) {
    if (e instanceof PlatformError) return refusal(e, "read the freelancer preview");
    throw e;
  }
  if (ready.length === 0) return { ok: false, error: "Nobody is ready to bill in this period." };

  const outcomes: DraftAllOutcome[] = [];
  for (const f of ready) {
    try {
      const r = await platformFetch<DraftedBill>(`/api/${c.tenant}/finance/freelancer-bills`, c.userId, {
        method: "POST",
        body: JSON.stringify({ userId: f.user.id, periodStart, periodEnd }),
      });
      outcomes.push({ userId: f.user.id, name: f.user.name, ok: true, billNo: r.billNo, ...(r.deduped ? { deduped: true } : {}) });
    } catch (e) {
      if (!(e instanceof PlatformError)) throw e;
      const x = refusal(e, "draft a freelancer bill");
      outcomes.push({ userId: f.user.id, name: f.user.name, ok: false, error: x.error, ...(x.blockers ? { blockers: x.blockers } : {}) });
      // A refused permission is the same for everyone: stop instead of repeating it for each person.
      if (e.status === 403) break;
    }
  }
  revalidatePath(PAGE);
  revalidatePath("/finance/payables");
  return { ok: outcomes.some((o) => o.ok), result: outcomes, ...(outcomes.every((o) => !o.ok) ? { error: outcomes[0]?.error } : {}) };
}

/** Discards a draft, releasing its hours: `DELETE finance/freelancer-bills/:billId`. Drafts only (409 `bill_not_draft`). */
export async function discardBillAction(billId: string): Promise<FlActionResult<{ billId: string; discarded: true; releasedEntries: number }>> {
  if (!billId) return { ok: false, error: "Choose a bill to discard." };
  return call("DELETE", `/finance/freelancer-bills/${encodeURIComponent(billId)}`, undefined, "discard a freelancer bill");
}
