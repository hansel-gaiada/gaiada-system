"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { basisError } from "./probeConsent";

// The write half of probe consent: filing a REQUEST. It cannot grant anything — the backend files
// an `automation_approvals` row with `origin='search'`, which the decide path can never
// auto-execute, and the grant happens only when someone with the authority to write
// `search_properties.verified_at` approves it.
//
// Follows this component's standard actions shape (a `ctx()` resolving session → me → tenant, then
// a `{ ok, error? }` result) rather than inventing a new one.

interface Ctx { userId: string; tenant: string }

async function ctx(): Promise<Ctx | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Not signed in." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

export interface RequestConsentResult {
  ok: boolean;
  error?: string;
  approvalId?: string;
}

/**
 * @param deptId only for revalidation — the pages that render consent state live under it.
 */
export async function requestProbeConsentAction(
  deptId: string,
  propertyId: string,
  basis: string,
): Promise<RequestConsentResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  // Re-validated here as well as in the browser AND on the platform. Not belt-and-braces theatre:
  // a Server Action is a public HTTP endpoint, so the client-side check is a courtesy and this is
  // the first place an actual caller can be stopped. The platform is still the authority.
  const bad = basisError(basis);
  if (bad) return { ok: false, error: bad };
  if (!propertyId) return { ok: false, error: "This domain has no SEO property record, so there is nothing to consent yet." };

  try {
    const res = await platformFetch<{ approvalId: string }>(
      `/api/${c.tenant}/modules/webdev/console/probe-consent-requests`,
      c.userId,
      // `body` is a raw RequestInit, so it must be a STRING — platformFetch sets the JSON
      // content-type itself whenever a body is present (and deliberately omits it when there is
      // none, because Fastify 400s a bodyless POST that declares one).
      { method: "POST", body: JSON.stringify({ propertyId, basis: basis.trim() }) },
    );
    revalidatePath(`/departments/${deptId}/sites/portfolio`);
    revalidatePath(`/departments/${deptId}/sites/portfolio/[siteId]`, "page");
    // The approver finds it here.
    revalidatePath("/approvals");
    return { ok: true, approvalId: res.approvalId };
  } catch (e) {
    // The platform's 409s are the useful ones and it words them well ("already has probe consent",
    // "already awaiting a decision"), so they are surfaced verbatim rather than flattened.
    return { ok: false, error: e instanceof PlatformError ? e.message : "Couldn't file the consent request." };
  }
}
