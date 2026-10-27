"use server";
// SCP-1e to 1j (BFF §63.6.3 to §63.6.6): the post page's writes. The server decides every one (Cerbos, then the stage machine's order of checks, §63.3.2);
// the gate and the labels on the page are hints. Every answer is a `WriteResult`: the post as the server reads it after the write, with the warnings, or a
// refusal with the contract's own code and the words for it (`refusalText`), including a 409's `detail`, `blockers` and `retryAfterSeconds`.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { asPipelinePost, refusalFromBody, refusalText, type PipelinePost, type Refusal } from "./socialPipeline";
import { asPostMetrics, asStoredMetrics, type PostMetrics, type StoredMetrics } from "./socialMetrics";

export type WriteResult =
  | { ok: true; post: PipelinePost | null; applied: { action: string; from: string | null; to: string | null } | null; warnings: string[]; alreadyApplied: boolean; designId: string | null }
  | { ok: false; refusal: Refusal; message: string };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const failed = (refusal: Refusal, message: string): WriteResult => ({ ok: false, refusal, message });

async function run(fn: (c: { userId: string; tenant: string }) => Promise<unknown>): Promise<WriteResult> {
  const userId = await getSessionUserId();
  if (!userId) return failed({ status: 401, error: "session_expired" }, "Session expired — sign in again.");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return failed({ status: 400, error: "no_company" }, "No active company selected.");
  try {
    const raw = await fn({ userId, tenant });
    revalidatePath("/departments", "layout");
    return answer(raw);
  } catch (e) {
    if (e instanceof PlatformError) {
      const refusal = refusalFromBody(e.status, e.message, e.body, e.field, e.reason);
      return failed(refusal, refusalText(refusal));
    }
    throw e;
  }
}

/** A write's answer is `{post, applied, warnings}`; `post` is null when the caller may no longer read the post (a discarded one). */
function answer(raw: unknown): WriteResult {
  const o = isObj(raw) ? raw : {};
  const applied = isObj(o.applied) && typeof o.applied.action === "string"
    ? { action: o.applied.action, from: typeof o.applied.from === "string" ? o.applied.from : null, to: typeof o.applied.to === "string" ? o.applied.to : null }
    : null;
  return {
    ok: true, post: isObj(o.post) ? asPipelinePost(o.post) : null, applied,
    warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string") : [],
    alreadyApplied: o.alreadyApplied === true, designId: typeof o.designId === "string" ? o.designId : null,
  };
}

/** `POST posts/:postId/actions`: `expectedStatus` is the step the page showed, `actionId` a fresh uuid for this click (a replay of it answers `alreadyApplied`). */
export async function runPostAction(postId: string, body: { action: string; expectedStatus: string; actionId: string } & Record<string, unknown>): Promise<WriteResult> {
  return run((c) => platformFetch<unknown>(`${base(c.tenant)}/posts/${encodeURIComponent(postId)}/actions`, c.userId, { method: "POST", body: JSON.stringify(body) }));
}

/** `PATCH posts/:postId/pipeline`: the fields the post's status allows (409 `field_locked` for any other). */
export async function savePostFields(postId: string, expectedStatus: string, fields: Record<string, unknown>): Promise<WriteResult> {
  return run((c) => platformFetch<unknown>(`${base(c.tenant)}/posts/${encodeURIComponent(postId)}/pipeline`, c.userId, { method: "PATCH", body: JSON.stringify({ expectedStatus, fields }) }));
}

/** `PUT posts/:postId/suggestions/:field`: the Copywriter's suggestion on one copy field, while the post is in proofread. */
export async function saveSuggestion(postId: string, field: string, expectedStatus: string, value: unknown): Promise<WriteResult> {
  return run((c) => platformFetch<unknown>(`${base(c.tenant)}/posts/${encodeURIComponent(postId)}/suggestions/${encodeURIComponent(field)}`, c.userId, { method: "PUT", body: JSON.stringify({ expectedStatus, value }) }));
}

/** `DELETE posts/:postId/suggestions/:field`: drops one suggestion (no body, so no `expectedStatus`). */
export async function dropSuggestion(postId: string, field: string): Promise<WriteResult> {
  return run((c) => platformFetch<unknown>(`${base(c.tenant)}/posts/${encodeURIComponent(postId)}/suggestions/${encodeURIComponent(field)}`, c.userId, { method: "DELETE" }));
}

export interface DesignInput { assetGroupId?: string; linkUrl?: string; linkSource?: string; linkAiNote?: string; position?: number }

/** `POST posts/:postId/designs`: an Asset Library asset by its version group, or a link with its source (and the AI note when the source is ai). */
export async function addPostDesign(postId: string, expectedStatus: string, input: DesignInput): Promise<WriteResult> {
  return run((c) => platformFetch<unknown>(`${base(c.tenant)}/posts/${encodeURIComponent(postId)}/designs`, c.userId, { method: "POST", body: JSON.stringify({ expectedStatus, ...input }) }));
}

/** `DELETE posts/:postId/designs/:designId`: marks the design removed (404 `design_not_found`). */
export async function removePostDesign(postId: string, designId: string): Promise<WriteResult> {
  return run((c) => platformFetch<unknown>(`${base(c.tenant)}/posts/${encodeURIComponent(postId)}/designs/${encodeURIComponent(designId)}`, c.userId, { method: "DELETE" }));
}

// ── SCP-3c: a post's metrics (BFF §63.10) ──────────────────────────────────────────────────────────────────────────────────────────────

export type MetricsResult = { ok: true; stored: StoredMetrics } | { ok: false; refusal: Refusal; message: string };

/**
 * `POST variants/:variantId/metrics` (`social_post` · `schedule`): types one snapshot in for one variant (one network of the post). The server judges the body again; a 400
 * names its `field`, which the form puts beside that input. 409 `post_not_live` while the post is not live.
 */
export async function enterPostMetrics(variantId: string, body: Record<string, unknown>): Promise<MetricsResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, refusal: { status: 401, error: "session_expired" }, message: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, refusal: { status: 400, error: "no_company" }, message: "No active company selected." };
  try {
    const raw = await platformFetch<unknown>(`${base(tenant)}/variants/${encodeURIComponent(variantId)}/metrics`, userId, { method: "POST", body: JSON.stringify(body) });
    revalidatePath("/departments", "layout");
    return { ok: true, stored: asStoredMetrics(raw) };
  } catch (e) {
    if (e instanceof PlatformError) {
      const refusal = refusalFromBody(e.status, e.message, e.body, e.field, e.reason);
      return { ok: false, refusal, message: refusalText(refusal) };
    }
    throw e;
  }
}

/** `GET posts/:postId/metrics` again, after a save: the page shows the server's own aggregate (the rate and the boost mark are the server's), or null when it cannot be read. */
export async function loadPostMetrics(postId: string): Promise<PostMetrics | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return null;
  try {
    return asPostMetrics(await platformFetch<unknown>(`${base(tenant)}/posts/${encodeURIComponent(postId)}/metrics`, userId));
  } catch (e) {
    if (e instanceof PlatformError) return null;
    throw e;
  }
}
