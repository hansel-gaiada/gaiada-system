"use server";
// SCP-4b, SCP-4c (BFF §63.11): the staff pages' boost writes and the dialog's two reads.
//
//   requestBoost          `POST posts/:postId/boosts`                              the officer, the HoD or GM seat: approved at once within the month's budget, else the client is asked
//   runBoostAction        `POST boosts/:boostId/actions`                           cancel, start, stop, complete (the same people); record the client's approval or decline (the four approvers)
//   loadBoostEstimate     `GET posts/:postId/boosts/estimate`                      the reach estimate as the person types
//   loadBudgetForPost     `GET cycles?month=`, then `GET cycles/:id/boost-budget`  the budget of the cycle the start date falls in (a boost belongs to the cycle of its `starts_on` month)
//   proposeBudget         `POST cycles/:cycleId/boost-budget/proposals`            the four approvers: a proposal for the client to agree in the portal
//   withdrawProposal      `POST boost-budget/proposals/:proposalId/withdraw`       the four approvers
//   recordBudget          `POST cycles/:cycleId/boost-budget/record`               the four approvers: the client agreed outside the portal
//
// The gates here are hints; the server's 403 is the boundary. Every refusal comes back as the contract's own code with the words for it (`boostRefusalText`), and the dialogs show them.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { asBoostBudget, asBoostEstimate, asBoostRow, boostRefusalText, type BoostBudget, type BoostEstimate, type BoostRow, type BudgetForMonth } from "./socialBoosts";
import { asPipelinePost, refusalFromBody, type Refusal } from "./socialPipeline";
import { asCycleTable } from "./socialCycles";

export type BoostWrite<T = object> = ({ ok: true } & T) | { ok: false; refusal: Refusal; message: string };
export interface BoostAnswer { boost: BoostRow | null; remainingMinor: number | null; needsClient: boolean; warnings: string[]; alreadyApplied: boolean }

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (refusal: Refusal): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: boostRefusalText(refusal) });

async function run<T extends object>(fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<BoostWrite<T>> {
  const userId = await getSessionUserId();
  if (!userId) return fail({ status: 401, error: "session_expired" });
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return fail({ status: 400, error: "no_company" });
  try {
    const out = await fn({ userId, tenant });
    revalidatePath("/departments", "layout");
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof PlatformError) return fail(refusalFromBody(e.status, e.message, e.body, e.field, e.reason));
    throw e;
  }
}

/** The writes' answers carry the boost and what remains: read leniently, since only the boost changes what the page shows. */
function boostAnswer(raw: unknown): BoostAnswer {
  const o = isObj(raw) ? raw : {};
  let boost: BoostRow | null = null;
  try { boost = asBoostRow(o.boost); } catch { boost = null; }
  return {
    boost, remainingMinor: typeof o.remainingMinor === "number" ? o.remainingMinor : null, needsClient: o.needsClient === true,
    warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string") : [], alreadyApplied: o.alreadyApplied === true || o.created === false,
  };
}

/** `POST posts/:postId/boosts`. `body.id` is a fresh uuid for this click, so a replay of it is the same boost. */
export async function requestBoost(postId: string, body: Record<string, unknown>): Promise<BoostWrite<BoostAnswer>> {
  return run(async (c) => boostAnswer(await platformFetch<unknown>(`${base(c.tenant)}/posts/${encodeURIComponent(postId)}/boosts`, c.userId, { method: "POST", body: JSON.stringify(body) })));
}

/** `POST boosts/:boostId/actions`: `body` carries the action, the `expectedStatus` the page showed and the action's own params. */
export async function runBoostAction(boostId: string, body: Record<string, unknown>): Promise<BoostWrite<BoostAnswer>> {
  return run(async (c) => boostAnswer(await platformFetch<unknown>(`${base(c.tenant)}/boosts/${encodeURIComponent(boostId)}/actions`, c.userId, { method: "POST", body: JSON.stringify(body) })));
}

/** `GET posts/:postId/boosts/estimate`: null when it cannot be read (the dialog then says so; the request itself is not blocked). */
export async function loadBoostEstimate(postId: string, q: { dailyBudgetMinor: number; days: number; audience: string }): Promise<BoostEstimate | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return null;
  try {
    const qs = new URLSearchParams({ dailyBudgetMinor: String(q.dailyBudgetMinor), days: String(q.days), audience: q.audience });
    return asBoostEstimate(await platformFetch<unknown>(`${base(tenant)}/posts/${encodeURIComponent(postId)}/boosts/estimate?${qs.toString()}`, userId));
  } catch {
    return null;
  }
}

/**
 * The budget of the cycle `month` (YYYY-MM, the month the boost starts in) of the post's client. `{ok: true}` with no cycle is a real answer: the client has no cycle that month, so
 * nothing is agreed and nothing remains. A read that fails is `{ok: false}` (the dialog says it cannot tell, and does not claim the boost is within or over).
 */
export async function loadBudgetForPost(postId: string, month: string): Promise<{ ok: true; budget: BudgetForMonth } | { ok: false }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false };
  try {
    const post = asPipelinePost(await platformFetch<unknown>(`${base(tenant)}/posts/${encodeURIComponent(postId)}/pipeline`, userId));
    const table = asCycleTable(await platformFetch<unknown>(`${base(tenant)}/cycles?month=${encodeURIComponent(month)}`, userId));
    const cycleId = table.rows.find((r) => r.engagementId === post.engagementId)?.cycleId ?? null;
    if (!cycleId) return { ok: true, budget: { cycleId: null, agreedMinor: null, remainingMinor: 0, committedMinor: 0, currency: "IDR", minorUnit: 0, canRecord: false } };
    const b: BoostBudget = asBoostBudget(await platformFetch<unknown>(`${base(tenant)}/cycles/${encodeURIComponent(cycleId)}/boost-budget`, userId));
    return { ok: true, budget: { cycleId, agreedMinor: b.agreed?.amountMinor ?? null, remainingMinor: b.remainingMinor, committedMinor: b.committedMinor, currency: b.currency, minorUnit: b.minorUnit, canRecord: b.canRecord } };
  } catch {
    return { ok: false };
  }
}

/** `POST cycles/:cycleId/boost-budget/proposals`. */
export async function proposeBudget(cycleId: string, body: Record<string, unknown>): Promise<BoostWrite> {
  return run(async (c) => { await platformFetch<unknown>(`${base(c.tenant)}/cycles/${encodeURIComponent(cycleId)}/boost-budget/proposals`, c.userId, { method: "POST", body: JSON.stringify(body) }); return {}; });
}

/** `POST boost-budget/proposals/:proposalId/withdraw`. */
export async function withdrawProposal(proposalId: string): Promise<BoostWrite> {
  return run(async (c) => { await platformFetch<unknown>(`${base(c.tenant)}/boost-budget/proposals/${encodeURIComponent(proposalId)}/withdraw`, c.userId, { method: "POST", body: JSON.stringify({}) }); return {}; });
}

/** `POST cycles/:cycleId/boost-budget/record`: the client agreed outside the portal. */
export async function recordBudget(cycleId: string, body: Record<string, unknown>): Promise<BoostWrite> {
  return run(async (c) => { await platformFetch<unknown>(`${base(c.tenant)}/cycles/${encodeURIComponent(cycleId)}/boost-budget/record`, c.userId, { method: "POST", body: JSON.stringify(body) }); return {}; });
}
