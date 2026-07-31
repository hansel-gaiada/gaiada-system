// SM-51 — §A10.4's repointed-base-URL boot guard, EXTENDED to the Google endpoint seams
// (design addendum §A12.3: "Endpoints come from `config.search.google.*` seams; §A10.4's boot guard
// extends to them in live mode").
//
// THE HAZARD, in Google's own terms: the whole reason config.search.google.* is a set of seams is so
// the authorization-code round trip can be driven against the local Keycloak realm or SM-51's
// in-process sandbox. That same seam, left unguarded, means a DEPLOYED stack could run with
// `GOOGLE_OAUTH_TOKEN_URL=http://keycloak:8080/...` and mint `linked` connection rows — with sealed
// tokens in the credential vault — from an issuer that is not Google. Those rows would then be read by
// SM-25b/c ingestion as if they authorized a client's real Search Console property.
//
// WHY THIS IS A SEPARATE FUNCTION RATHER THAN A WIDENED `assertLiveVendorBaseUrlsAreNotPrivate`:
// that function's `VendorBaseUrls` shape is the three-vendor money path (SM-49, landed, and under a QA
// gate at the time of writing). Widening its signature would churn a landed file and its pinned tests
// for no behavioural gain. The LEXICAL PREDICATE is reused verbatim — `checkPrivateVendorBaseUrl` is
// imported, not re-implemented — so there is exactly one definition of "looks private" in the estate
// and a future fix to it applies to both call sites at once.
//
// SAME HONESTY AS THE ORIGINAL, restated rather than assumed: this is an ACCIDENT GUARD, NOT AN
// AUTHORIZATION CONTROL. It is a lexical check on a hostname string, performs no DNS resolution, and a
// public-looking name that resolves privately sails through. Its job is to make a deployment typo (or
// a dev config left in place) loud at boot, not to defeat an adversary.
//
// SIMULATE MODE IS UNTOUCHED, exactly as §A10.4 rules for the vendor guard: main.ts's simulate branch
// never calls this. A simulate-mode stack pointed at a dev issuer is a demo stack, and the honesty
// carrier there is the per-connection issuer host recorded on every connection row plus the
// `simulated` stamp on search_google_oauth_states (§A12.2/§A12.3) — not a boot refusal.
import { checkPrivateVendorBaseUrl } from "../../../search-vendor-baseurl-guard";
import { config } from "../../../config";

/** Thrown by assertLiveGoogleEndpointsAreNotPrivate — a distinct class from
 *  `PrivateVendorBaseUrlError` so a boot failure names which egress class refused. */
export class PrivateGoogleEndpointError extends Error {
  constructor(
    readonly seam: string,
    readonly url: string,
    readonly reason: string,
  ) {
    super(
      `[search/google] BOOT ERROR: SEARCH_PROVIDER_MODE=live but the Google '${seam}' endpoint ('${url}') ` +
        `looks private (${reason}) — a live deployment must not point a Google OAuth issuer or API base ` +
        "at a private/loopback/internal host: it would mint `linked` credential-vault rows, and " +
        "client-private GSC/GA4/Ads rows, from an issuer that is not Google (design addendum §A12.3). " +
        `Set ${ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV}=1 to override for a genuine proxy/tunnel deployment or ` +
        "for deliberate local experimentation against the Keycloak `google-dev` client. This is an " +
        "ACCIDENT guard, not an authz control — it is lexical and performs no DNS resolution.",
    );
    this.name = "PrivateGoogleEndpointError";
  }
}

/** Deliberately a SEPARATE override from SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL. Someone running the
 *  vendor sandbox against a private DataForSEO host has not thereby decided that client OAuth
 *  credentials may be issued by a non-Google issuer — those are different risks with different blast
 *  radii (fabricated market data vs. a credential-vault row that misrepresents a client's account), so
 *  they get different switches. */
export const ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV = "SEARCH_ALLOW_PRIVATE_GOOGLE_ENDPOINT";

export interface GoogleEndpointSeams {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  searchConsoleBaseUrl: string;
  analyticsDataBaseUrl: string;
  adsBaseUrl: string;
}

/** Read the live seam values straight off config — used by main.ts so the call site cannot drift from
 *  the config shape, and by tests to assert the DEFAULTS pass (a guard that rejects the real Google
 *  hosts would be worse than no guard: it would push operators straight to the override). */
export function googleEndpointSeamsFromConfig(): GoogleEndpointSeams {
  const g = config.search.google;
  return {
    authorizeUrl: g.authorizeUrl,
    tokenUrl: g.tokenUrl,
    revokeUrl: g.revokeUrl,
    searchConsoleBaseUrl: g.searchConsoleBaseUrl,
    analyticsDataBaseUrl: g.analyticsDataBaseUrl,
    adsBaseUrl: g.adsBaseUrl,
  };
}

/** The whole guard as ONE call from main.ts's live branch, alongside the vendor one (SM-49 AC 9's
 *  pattern). Unconditional across all six seams — NOT gated on whether the OAuth client happens to be
 *  configured — because the override is explicitly meant to also cover local experimentation, which by
 *  definition may have no client id set yet. */
export function assertLiveGoogleEndpointsAreNotPrivate(seams: GoogleEndpointSeams, allowOverride: boolean): void {
  if (allowOverride) return;
  const entries: Array<[string, string]> = [
    ["authorizeUrl", seams.authorizeUrl],
    ["tokenUrl", seams.tokenUrl],
    ["revokeUrl", seams.revokeUrl],
    ["searchConsoleBaseUrl", seams.searchConsoleBaseUrl],
    ["analyticsDataBaseUrl", seams.analyticsDataBaseUrl],
    ["adsBaseUrl", seams.adsBaseUrl],
  ];
  for (const [seam, url] of entries) {
    const check = checkPrivateVendorBaseUrl(url);
    if (check.isPrivate) throw new PrivateGoogleEndpointError(seam, url, check.reason ?? "unspecified");
  }
}
