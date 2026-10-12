"use server";
// M5-V5-d — the Experiments tab's writes, as server actions. Each returns words (`message`); a raw token or error text
// never reaches the page. The BFF's Cerbos `update` on the search property is the authority; the page's `can()` only keeps
// the buttons off the screen. Bodies carry only what the API takes (it 400s unknown members).
import { expCall, expCtx, type CallResult } from "./experiments";
import {
  buildRegistration, diffWords, parseExperimentBody, ExperimentShapeError, refusalWords, SYNC_WORDS,
  type RegisterForm,
} from "./experimentsModel";

export type ActionResult = { ok: true; message: string; id?: string } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noSession: ActionResult = { ok: false, message: "Your session has ended. Sign in again." };
const refused = (r: Extract<CallResult<unknown>, { ok: false }>): ActionResult => ({ ok: false, message: refusalWords(r.token, r.status, r.existing) });
const badIds = (propertyId: string, experimentId?: string) => !UUID.test(propertyId) || (experimentId !== undefined && !UUID.test(experimentId));
const badRef: ActionResult = { ok: false, message: "That test could not be found." };

export async function registerExperimentAction(propertyId: string, scope: { tenantSlug: string; siteId: string }, form: RegisterForm): Promise<ActionResult> {
  if (badIds(propertyId)) return badRef;
  const built = buildRegistration(form, scope);
  if (!built.ok) return { ok: false, message: built.message };
  const ctx = await expCtx(); if (!ctx) return noSession;
  const r = await expCall<unknown>(ctx, propertyId, "", built.body);
  if (!r.ok) return refused(r);
  try {
    const e = parseExperimentBody(r.data);
    return { ok: true, id: e.id, message: `Registered "${e.key}" as a draft. It needs about ${e.preRegistration.nPerArm} visitors per variant, roughly ${e.preRegistration.projectedDays} days.` };
  } catch (e) {
    if (e instanceof ExperimentShapeError) return { ok: true, message: "Registered as a draft." };
    throw e;
  }
}

export async function syncExperimentAction(propertyId: string, experimentId: string): Promise<ActionResult> {
  if (badIds(propertyId, experimentId)) return badRef;
  const ctx = await expCtx(); if (!ctx) return noSession;
  const r = await expCall<{ state?: string; differences?: string[] }>(ctx, propertyId, `/${experimentId}/sync`, {});
  if (!r.ok) return refused(r);
  const state = typeof r.data?.state === "string" ? r.data.state : "";
  const words = SYNC_WORDS[state];
  if (!words) return { ok: false, message: "The page answered in a way this screen does not understand. Reload and check the status." };
  const diffs = Array.isArray(r.data.differences) ? r.data.differences.filter((d): d is string => typeof d === "string") : [];
  return { ok: state === "started" || state === "already_running", message: words + (state === "plan_mismatch" ? diffWords(diffs) : "") };
}

export async function stopExperimentAction(propertyId: string, experimentId: string): Promise<ActionResult> {
  if (badIds(propertyId, experimentId)) return badRef;
  const ctx = await expCtx(); if (!ctx) return noSession;
  const r = await expCall<unknown>(ctx, propertyId, `/${experimentId}/stop`, {});
  if (!r.ok) return refused(r);
  return { ok: true, message: "The test is stopped. Remove the block from the page (or merge the winner), then record the decision." };
}

export async function abortExperimentAction(propertyId: string, experimentId: string): Promise<ActionResult> {
  if (badIds(propertyId, experimentId)) return badRef;
  const ctx = await expCtx(); if (!ctx) return noSession;
  const r = await expCall<unknown>(ctx, propertyId, `/${experimentId}/abort`, {});
  if (!r.ok) return refused(r);
  return { ok: true, message: "The test is aborted. No result is recorded. Remove the block from the page if it is live." };
}

export async function decideExperimentAction(propertyId: string, experimentId: string, note: string): Promise<ActionResult> {
  if (badIds(propertyId, experimentId)) return badRef;
  const clean = (note ?? "").trim();
  if (clean.length > 500) return { ok: false, message: "The note can be at most 500 characters." };
  const ctx = await expCtx(); if (!ctx) return noSession;
  const r = await expCall<unknown>(ctx, propertyId, `/${experimentId}/decide`, clean ? { note: clean } : {});
  if (!r.ok) return refused(r);
  return { ok: true, message: "The decision is recorded and the test is closed." };
}
