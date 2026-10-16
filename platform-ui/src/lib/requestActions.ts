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
  type OutboundRequestBody, type RequestBody, type RequestResult,
} from "./requests";
import { readRequestRoutes } from "./requests-data";

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
function refresh(id?: string, outbound = false) {
  revalidatePath("/requests");
  if (id) revalidatePath(outbound ? `/requests/outbound/${id}` : `/requests/${id}`);
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

// ── DW-10e: requests across group companies (BFF §60.5) ────────────────────────────────────────────────────────────────────────────
// The tenant is the ASKING company (the caller's active one), exactly as for `createRequestAction`: the URL names the requesting
// company, and the route (an id the server resolves in that company's scope) names where the request goes.

/** The refusals that name the other company in words: its name is looked up from the caller's own routes, never taken from the browser. */
const NAMES_THE_COMPANY = new Set(["route_inactive", "route_unit_unavailable", "group_client_missing", "group_client_ambiguous"]);

async function failOutbound(e: unknown, userId: string, tenant: string, routeId?: string) {
  if (!(e instanceof PlatformError)) throw e;
  let company: string | undefined;
  if (routeId && e.reason && NAMES_THE_COMPANY.has(e.reason)) {
    const routes = await readRequestRoutes(userId, tenant);
    company = routes.kind === "ok" ? routes.data.routes.find((r) => r.routeId === routeId)?.company.name : undefined;
  }
  return {
    ok: false as const,
    error: requestErrorText({ status: e.status, reason: e.reason, message: e.message, field: e.field, detail: detailOf(e.body) }, { company }),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.field ? { field: e.field } : {}),
  };
}

/** `POST requests/outbound` (gate: `send_across`, on the asking company). Answers the new request's id and the company that took it:
 *  the form then goes to `/requests/outbound/<id>`. 400 `{field}`, 403, 404 and 409 (`route_inactive`, `group_client_missing`,
 *  `request_routes_disabled` and the rest of §60.5) come back as a sentence, never a throw. */
export async function createOutboundRequestAction(
  body: OutboundRequestBody,
): Promise<RequestResult<{ id: string; receivingCompany: { id: string; name: string } | null }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ id: string; receivingCompany?: { id?: string; name?: string } }>(
      `${base(c.tenant)}/outbound`, c.userId, { method: "POST", body: JSON.stringify(body) },
    );
    refresh(r.id, true);
    const rc = r.receivingCompany;
    return { ok: true, id: r.id, receivingCompany: rc && typeof rc.id === "string" ? { id: rc.id, name: typeof rc.name === "string" ? rc.name : "Another company" } : null };
  } catch (e) {
    return failOutbound(e, c.userId, c.tenant, body.routeId);
  }
}

/** `POST requests/outbound/:id/cancel` (gate: `cancel`, on the asking company). 409 `request_not_open`, `already_in_progress` and
 *  `price_agreement_open` (a live price agreement) are sentences. */
export async function cancelOutboundRequestAction(id: string): Promise<RequestResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant)}/outbound/${encodeURIComponent(id)}/cancel`, c.userId, { method: "POST" });
    refresh(id, true);
    return { ok: true };
  } catch (e) {
    return failOutbound(e, c.userId, c.tenant);
  }
}
