// SM-51/SM-25a — "is this URL Google's own host?" (design addendum §A12.2/§A12.3).
//
// THIS PREDICATE DECIDES A PROVENANCE STAMP, so its failure direction matters more than its
// cleverness. It is used for exactly two things:
//   1. the `simulated` column on search_google_oauth_states (§A12.2: a row asserting descent from a
//      client's real Google account may exist only where a real Google connection exists, or in a
//      throwaway per-file test database);
//   2. the issuer-host disclosure recorded on every connection (§A12.3's honesty rule: "any
//      connections surface renders the issuer host whenever it is not Google's — a dev-issuer
//      connection must be readable as one at a glance").
//
// FAIL-SAFE DIRECTION, deliberate: anything this function cannot positively recognize as a Google
// host is reported NOT-Google, which stamps `simulated = true` and shows the issuer host. Over-
// claiming "simulated" is a cosmetic error; under-claiming it is the §A10.2 defect class — an
// unlabelled row whose bytes did not come from where it says they did. So the allowlist below is
// EXACT-SUFFIX matching against Google's documented OAuth/API hostnames, never a substring search
// ("accounts.google.com.evil.test" must not pass, and a bare `includes("google")` would let it).
//
// This is NOT a security control and does not pretend to be one: it is a lexical hostname check with
// no DNS resolution, exactly like the §A10.4 base-URL boot guard it sits beside (endpoint-guard.ts).
// Its job is labelling honesty, not authorization.

/** Registrable Google domains whose subdomains host the OAuth issuer + the API surfaces we call:
 *  accounts.google.com (authorize), oauth2.googleapis.com (token/revoke),
 *  {searchconsole,analyticsdata,googleads}.googleapis.com (the three data surfaces). */
const GOOGLE_SUFFIXES = [".google.com", ".googleapis.com"];
const GOOGLE_EXACT = ["google.com", "googleapis.com"];

/** True iff `url`'s hostname is exactly a Google host or a subdomain of one. An unparseable URL is
 *  NOT Google (fail-safe direction — see file header). */
export function isGoogleHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (GOOGLE_EXACT.includes(host)) return true;
  return GOOGLE_SUFFIXES.some((s) => host.endsWith(s));
}

/** The hostname to record on a connection / state row, for the §A12.3 disclosure. Returns the raw
 *  string when it will not parse, so the surface shows the operator what is actually configured
 *  rather than an empty field that reads like "nothing unusual here". */
export function hostLabel(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}
