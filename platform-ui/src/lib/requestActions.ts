"use server";
// DW-5c UI: server actions behind the request form and the request page (BFF §32.5 writes).
//
// The platform is the authority on every one of these: Cerbos `work_request` create / deliver / decline / cancel, then
// the lifecycle rules (409 with a machine `reason`). Nothing here widens or pre-empts that. Every action returns a value,
// never a thrown refusal, so the UI can say what happened in words. The tenant is the caller's ACTIVE company, never a
// value from the browser.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  LIMITS, checkDeclineReason, checkDeliverIds, detailOf, requestErrorText,
  type RequestBody, type RequestResult,
} from "./requests";

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

function fail(e: unknown): { ok: false; error: string; reason?: string; field?: string } {
  if (e instanceof PlatformError) {
    return {
      ok: false,
      error: requestErrorText({ status: e.status, reason: e.reason, message: e.message, field: e.field, detail: detailOf(e.body) }),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.field ? { field: e.field } : {}),
    };
  }
  throw e;
}

const base = (t: string) => `/api/${t}/requests`;

/** A request page, the lists and every department page that shows requests re-read after a write. */
function refresh(id?: string) {
  revalidatePath("/requests");
  if (id) revalidatePath(`/requests/${id}`);
  revalidatePath("/departments", "layout");
}

/** `POST requests` (gate: `create`). Answers the new request's id: the form then goes to `/requests/<id>`. */
export async function createRequestAction(body: RequestBody): Promise<RequestResult<{ id: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ id: string }>(base(c.tenant), c.userId, { method: "POST", body: JSON.stringify(body) });
    refresh(r.id);
    return { ok: true, id: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** `POST requests/:id/deliver` (gate: `deliver`; assets only). On a delivered request it only adds assets. */
export async function deliverRequestAction(id: string, assetIds: string[]): Promise<RequestResult> {
  const bad = checkDeliverIds(assetIds);
  if (bad) return { ok: false, error: bad };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}/deliver`, c.userId, {
      method: "POST",
      body: JSON.stringify({ assetIds: [...new Set(assetIds)].slice(0, LIMITS.assetIds) }),
    });
    refresh(id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** `POST requests/:id/decline` (gate: `decline`; assets only; open only). */
export async function declineRequestAction(id: string, reason: string): Promise<RequestResult> {
  const bad = checkDeclineReason(reason);
  if (bad) return { ok: false, error: bad };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}/decline`, c.userId, {
      method: "POST",
      body: JSON.stringify({ reason: reason.trim() }),
    });
    refresh(id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** `POST requests/:id/cancel` (gate: `cancel`; open only; an engineering request only while its change request is `new`). */
export async function cancelRequestAction(id: string): Promise<RequestResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}/cancel`, c.userId, { method: "POST" });
    refresh(id);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
