import "server-only";
// PV5-09 — the reader behind `/finance/settings/billing-profile`. See `billingProfile.ts` for the types.
//
//   GET /api/:t/billing-profile -> BillingProfile, or 404 before one exists (BFF §30). Not module-gated.
//
// A 404 is a real answer here ("this company has no billing profile yet": the form then creates one), so it becomes `null`.
// A 403 and everything else THROW, and the page wraps this in `readResult()`: a refused read is rendered as a refusal in
// words, never as "no profile yet", which would invite someone to save a blank profile over the real one.
import { platformFetch, PlatformError } from "./platform";
import type { BillingProfile } from "./billingProfile";

export async function getBillingProfile(userId: string, tenant: string): Promise<BillingProfile | null> {
  try {
    return await platformFetch<BillingProfile>(`/api/${tenant}/billing-profile`, userId);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) return null;
    throw e;
  }
}
