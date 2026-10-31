"use server";
// SCP-5 W5-C5 (BFF §63.30.4): the company rules' writes, the preview and the history read.
//
//   saveRules          `PUT rules/:section`            `{expectedVersion, value}`: version + 1, the other sections unchanged; answers the read
//   resetRules         `POST rules/:section/reset`     `{expectedVersion}`: a new version whose section is the seed's
//   previewRules       `POST rules/preview`            `{section, value, engagementId?}`: what the unsaved value would do; saves nothing
//   loadRulesHistory   `GET rules/versions`            one section's history, newest first, a page at a time
//
// The gates here are hints; the server's refusal is the boundary (the four only). Every refusal comes back as the contract's own code in `refusal.error` with the words for it in `message`.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import {
  asHistory, asPreview, asRulesAnswer, previewBody, rulesRefusalText, type RulesAnswer, type RulesHistoryItem, type RulesPreview, type RulesSection, type RulesWrite,
} from "./socialRules";

export type RulesActionResult<T = object> = ({ ok: true } & T) | { ok: false; refusal: Refusal; message: string };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const fail = (refusal: Refusal, kind: RulesWrite): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: rulesRefusalText(refusal, kind) });

async function run<T extends object>(kind: RulesWrite, fn: (c: { userId: string; tenant: string }) => Promise<T>, refresh = true): Promise<RulesActionResult<T>> {
  const userId = await getSessionUserId();
  if (!userId) return fail({ status: 401, error: "session_expired" }, kind);
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return fail({ status: 400, error: "no_company" }, kind);
  try {
    const out = await fn({ userId, tenant });
    if (refresh) revalidatePath("/departments", "layout");
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof PlatformError) return fail(refusalFromBody(e.status, e.message, e.body, e.field, e.reason), kind);
    throw e;
  }
}

/** `PUT rules/:section`: one section, whole, against the version the person was looking at. */
export async function saveRules(section: RulesSection, expectedVersion: number, value: unknown): Promise<RulesActionResult<{ answer: RulesAnswer }>> {
  return run("save", async (c) => ({
    answer: asRulesAnswer(await platformFetch<unknown>(`${base(c.tenant)}/rules/${encodeURIComponent(section)}`, c.userId, { method: "PUT", body: JSON.stringify({ expectedVersion, value }) })),
  }));
}

/** `POST rules/:section/reset`: the section back to the seed, as a new version. */
export async function resetRules(section: RulesSection, expectedVersion: number): Promise<RulesActionResult<{ answer: RulesAnswer }>> {
  return run("reset", async (c) => ({
    answer: asRulesAnswer(await platformFetch<unknown>(`${base(c.tenant)}/rules/${encodeURIComponent(section)}/reset`, c.userId, { method: "POST", body: JSON.stringify({ expectedVersion }) })),
  }));
}

/** `POST rules/preview`: saves nothing, so nothing is revalidated. */
export async function previewRules(section: RulesSection, value: unknown, engagementId: string | null): Promise<RulesActionResult<{ preview: RulesPreview }>> {
  return run("preview", async (c) => ({
    preview: asPreview(await platformFetch<unknown>(`${base(c.tenant)}/rules/preview`, c.userId, { method: "POST", body: JSON.stringify(previewBody(section, value, engagementId)) })),
  }), false);
}

/** `GET rules/versions?section=&cursor=`: a page of the section's history (`plan`: the four). */
export async function loadRulesHistory(section: RulesSection, cursor: string | null): Promise<RulesActionResult<{ items: RulesHistoryItem[]; nextCursor: string | null }>> {
  return run("history", async (c) => {
    const q = new URLSearchParams({ section, limit: "10", ...(cursor ? { cursor } : {}) });
    return asHistory(await platformFetch<unknown>(`${base(c.tenant)}/rules/versions?${q.toString()}`, c.userId));
  }, false);
}
