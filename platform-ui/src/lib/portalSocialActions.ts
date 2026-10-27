"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActivePortalCompany } from "./portal-company";
import { getPortalSocialPost } from "./portal-data";
import {
  describeDecideError, type PortalSocialBulkAnswer, type PortalSocialDecided, type PortalSocialPost,
} from "./portalSocial";
import type { CommentAnchor } from "./pm";

// SCP-2 (BFF §63.9) — the client's WRITES on the post approval page: decide one post, approve all that wait, undo a decision, and re-read one post
// after the server said it changed.
//
// RESULT SHAPE: `{ok, code?, error?, field?, data?}`, like `portalActions.ts`, with the server's refusal CODE carried as well as the words. The page
// branches on the code (`content_changed` reloads that post, `post_not_with_client` refreshes the list); `error` is what the client reads, written
// from the code by `describeDecideError`, never a raw token.
//
// NOTHING HERE DECIDES ANYTHING: the server checks the contact, the post's client, the status, the hash and the body. This file only carries the call
// and tells the truth about the answer.
export interface PortalSocialResult<T = undefined> {
  ok: boolean;
  /** The server's refusal code (`content_changed`, `post_not_with_client`, ...). */
  code?: string;
  error?: string;
  field?: string;
  data?: T;
}

async function ctx(): Promise<{ userId: string; tenant: string } | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  return tenant ? { userId, tenant } : null;
}

const SESSION_ENDED: PortalSocialResult<never> = { ok: false, code: "session_expired", error: "Your session has expired. Sign in again." };

function failed(e: unknown): PortalSocialResult<never> {
  if (e instanceof PlatformError) return { ok: false, code: e.message, error: describeDecideError(e.message, e.field), field: e.field };
  throw e;
}

/** Everything a decision can change: this page, its post page, and the portal's front page. Broad on purpose, as `portalActions.revalidatePortal`. */
function revalidateSocial(postId?: string): void {
  revalidatePath("/portal/social");
  if (postId) revalidatePath(`/portal/social/${postId}`);
  revalidatePath("/portal");
}

export interface DecideInput {
  postId: string;
  decision: "approve" | "change";
  /** The `reviewHash` the client was shown: the server refuses (409 `content_changed`) when it is no longer the post's. */
  seenHash: string;
  changeKind?: "copy" | "design";
  note?: string;
  anchor?: CommentAnchor;
}

/** `POST portal/social/posts/:postId/decide`: one decision for every variant of the post. */
export async function portalSocialDecide(input: DecideInput): Promise<PortalSocialResult<PortalSocialDecided>> {
  const c = await ctx();
  if (!c) return SESSION_ENDED;
  if (!input.postId) return { ok: false, error: "Missing post." };
  const body: Record<string, unknown> = { decision: input.decision, seenHash: input.seenHash };
  if (input.decision === "change") {
    body.changeKind = input.changeKind;
    body.note = input.note?.trim();
    if (input.anchor) body.anchor = input.anchor;
  }
  try {
    const data = await platformFetch<PortalSocialDecided>(
      `/api/${c.tenant}/portal/social/posts/${encodeURIComponent(input.postId)}/decide`, c.userId,
      { method: "POST", body: JSON.stringify(body) },
    );
    revalidateSocial(input.postId);
    return { ok: true, data };
  } catch (e) {
    // The list or the post moved under the client: let the page re-read, whatever the words are.
    if (e instanceof PlatformError && (e.message === "post_not_with_client" || e.message === "content_changed")) revalidateSocial(input.postId);
    return failed(e);
  }
}

/** `POST portal/social/posts/approve-all`: exactly the listed posts that still wait with an unchanged hash. A skipped post is not an error. */
export async function portalSocialApproveAll(items: Array<{ postId: string; seenHash: string }>): Promise<PortalSocialResult<PortalSocialBulkAnswer>> {
  const c = await ctx();
  if (!c) return SESSION_ENDED;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) return { ok: false, code: "invalid_field", field: "items", error: describeDecideError("invalid_field", "items") };
  try {
    const data = await platformFetch<PortalSocialBulkAnswer>(`/api/${c.tenant}/portal/social/posts/approve-all`, c.userId, {
      method: "POST", body: JSON.stringify({ items }),
    });
    revalidateSocial();
    return { ok: true, data };
  } catch (e) {
    return failed(e);
  }
}

/** `POST portal/social/decisions/:decisionId/undo`: the contact's own decision, inside the window. */
export async function portalSocialUndo(decisionId: string, postId?: string): Promise<PortalSocialResult> {
  const c = await ctx();
  if (!c) return SESSION_ENDED;
  if (!decisionId) return { ok: false, error: "Missing decision." };
  try {
    await platformFetch(`/api/${c.tenant}/portal/social/decisions/${encodeURIComponent(decisionId)}/undo`, c.userId, { method: "POST", body: "{}" });
    revalidateSocial(postId);
    return { ok: true };
  } catch (e) {
    // A refused undo means the post is no longer where the client left it: re-read, whatever the words are.
    revalidateSocial(postId);
    return failed(e);
  }
}

/** One post, re-read after `content_changed`: the client is shown the new version (and its new hash) before they decide again. */
export async function portalSocialReloadPost(postId: string): Promise<PortalSocialResult<{ post: PortalSocialPost | null }>> {
  const c = await ctx();
  if (!c) return SESSION_ENDED;
  try {
    return { ok: true, data: { post: await getPortalSocialPost(c.userId, c.tenant, postId) } };
  } catch (e) {
    return failed(e);
  }
}
