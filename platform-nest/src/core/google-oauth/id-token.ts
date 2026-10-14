// DW-6i — reading the account identity out of a Google OpenID Connect ID token. PURE: no network, no config, no token store.
//
// ── WHY CLAIMS ARE CHECKED AND THE SIGNATURE IS NOT ──────────────────────────────────────────────
// Google's own guidance (https://developers.google.com/identity/openid-connect/openid-connect, "Validating an ID token"):
// a token must be validated "unless you know that they came directly from Google", and one received straight from the token
// endpoint, over HTTPS, in a request that carried the client secret, can be trusted as authentic without verifying its
// signature. That is the ONLY way a token reaches this function: `exchangeAuthorizationCode` (token-endpoint-client.ts) hands
// over what the issuer's token endpoint answered to OUR authenticated POST, and the id token is read once, in the callback,
// and dropped. It is never accepted from a browser, a query string or a request body. If a future caller ever has a token
// from anywhere else, it must verify the signature against Google's JWKS first; this file does not do that and says so.
//
// What IS checked, because Google lists it and because it costs nothing:
//   * `iss` is `https://accounts.google.com` or `accounts.google.com`;
//   * `aud` is OUR client id (a string equal to it, or an array containing it): a token minted for another app is refused;
//   * `exp` is in the future;
//   * `sub` is present (Google: "Always use the `sub` field" as the unique identifier; `email` is for display only).
// The email comes from the `email` claim, present only when the `email` scope was granted; `email_verified` is reported.
//
// A failure here throws `IdTokenError` with a short reason token and NEVER the token or any claim value.

export class IdTokenError extends Error {
  constructor(readonly reason: "malformed" | "bad_issuer" | "bad_audience" | "expired" | "no_subject" | "no_email") {
    super(`id token refused: ${reason}`);
    this.name = "IdTokenError";
  }
}

export interface GoogleIdentity {
  /** Google's stable account identifier. */
  sub: string;
  email: string;
  emailVerified: boolean;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

function payloadOf(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new IdTokenError("malformed");
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw new IdTokenError("malformed");
    return json as Record<string, unknown>;
  } catch (e) {
    if (e instanceof IdTokenError) throw e;
    throw new IdTokenError("malformed");
  }
}

/** The identity in `idToken`, after the claim checks above. `now` is injectable for tests. */
export function readGoogleIdentity(idToken: string, expectedClientId: string, now: number = Date.now()): GoogleIdentity {
  const p = payloadOf(idToken);
  if (typeof p.iss !== "string" || !GOOGLE_ISSUERS.includes(p.iss)) throw new IdTokenError("bad_issuer");
  const aud = p.aud;
  const audOk = typeof aud === "string" ? aud === expectedClientId : Array.isArray(aud) && aud.includes(expectedClientId);
  if (!expectedClientId || !audOk) throw new IdTokenError("bad_audience");
  if (typeof p.exp !== "number" || p.exp * 1000 <= now) throw new IdTokenError("expired");
  if (typeof p.sub !== "string" || !p.sub) throw new IdTokenError("no_subject");
  if (typeof p.email !== "string" || !p.email.includes("@")) throw new IdTokenError("no_email");
  return { sub: p.sub, email: p.email.trim().toLowerCase(), emailVerified: p.email_verified === true };
}
