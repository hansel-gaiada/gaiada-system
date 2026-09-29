"use server";
// Client Centre — WRITE actions. Both PATCH routes in the plan (`clients/:id/centre` for staff,
// `portal/centre/:id` for a client contact) funnel through here, following the repo's documented
// actions shape (`ctx()` -> optional capability gate -> `{ ok, error?, field? }`).
//
// The backend's `{error}` body is surfaced VERBATIM (same call as `portalActions.ts`'s `fail()`):
// these messages are written to be read by whoever is filling the form in — "value looks like a
// secret" names the exact field via `PlatformError.field`, and replacing that with a generic
// "something went wrong" would throw away the one actionable part.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";
import type { CentrePatch, CentreProfile } from "./clientCentre";

export interface CentreActionResult {
  ok: boolean;
  error?: string;
  field?: string;
  profile?: CentreProfile;
}

async function ctx(): Promise<{ userId: string; tenant: string; me: Me } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant, me };
}

function fail(e: unknown): CentreActionResult {
  if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field };
  throw e;
}

/** Staff PATCH: `PATCH /api/:t/clients/:clientId/centre`. Cerbos `client` update is the real
 *  authority — this action holds no capability gate of its own, matching `clientWorkActions.ts`'s
 *  precedent of trusting the BFF for anything already gated server-side. */
export async function patchClientCentreAction(clientId: string, patch: CentrePatch): Promise<CentreActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const profile = await platformFetch<CentreProfile>(`/api/${c.tenant}/clients/${clientId}/centre`, c.userId, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    revalidatePath(`/client-centre/${clientId}`, "layout");
    revalidatePath("/client-centre");
    return { ok: true, profile };
  } catch (e) {
    return fail(e);
  }
}

/** Staff client switcher (the workspace's own dropdown, distinct from the `/client-centre` list):
 *  the client id is already in the staff URL, so switching is a plain redirect — no cookie needed. */
export async function switchStaffCentreClient(formData: FormData): Promise<void> {
  const clientId = String(formData.get("clientId") ?? "");
  redirect(`/client-centre/${clientId}`);
}

/** Portal PATCH: `PATCH /api/:t/portal/centre/:clientId`. CC-D4: the BFF enforces
 *  `portal.edit_company_profile` (active, client-wide, `signer` contact only) — a view-only contact's
 *  attempt comes back as a `PlatformError` here, surfaced as `error` rather than assumed away by a
 *  client-side `canEdit` check the caller may not have re-verified. */
export async function patchPortalCentreAction(clientId: string, patch: CentrePatch): Promise<CentreActionResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const profile = await platformFetch<CentreProfile>(`/api/${c.tenant}/portal/centre/${clientId}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    revalidatePath(`/portal/company/${clientId}`, "layout");
    revalidatePath("/portal/company");
    return { ok: true, profile };
  } catch (e) {
    return fail(e);
  }
}
