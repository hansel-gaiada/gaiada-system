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
 *  {searchconsole,analyticsdata,googleads}.googleapis.com (the three data surfaces), and (DW-6i) www.googleapis.com
 *  (Drive v3; see `isDriveApiUrl` at the foot of this file for the narrower predicate that gates the actual call). */
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

// DW-6i — Google Drive's API host, allowed DELIBERATELY and by name.
//
// `isGoogleHost` above already recognises `www.googleapis.com` (a `.googleapis.com` subdomain), but that predicate only
// decides a provenance LABEL. Drive's `files.get` is an outbound call that carries a person's access token, so it gets its
// own, much narrower predicate: an exact host, HTTPS only, and the one path prefix the client uses. `core/google-drive/
// client.ts` refuses to send a request that fails it, and egress.test.ts pins both the host and its look-alikes.
// Source (read 2026-10-14): https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get
// ("GET https://www.googleapis.com/drive/v3/files/{fileId}").
export const GOOGLE_DRIVE_API_HOST = "www.googleapis.com";
export const GOOGLE_DRIVE_API_PATH_PREFIX = "/drive/v3/";

/** True iff `url` is HTTPS, on exactly `www.googleapis.com`, under `/drive/v3/`, with no userinfo and the default port. */
export function isDriveApiUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname.toLowerCase() === GOOGLE_DRIVE_API_HOST &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    u.pathname.startsWith(GOOGLE_DRIVE_API_PATH_PREFIX)
  );
}
