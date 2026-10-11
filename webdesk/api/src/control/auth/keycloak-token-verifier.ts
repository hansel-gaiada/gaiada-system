// WSK-22 — §03 Layer 2: the Keycloak client-credentials service token, verified OFFLINE. "Zone B
// must need NO Zone A credential to verify" is the crux design calls out explicitly — this file
// only ever performs a GET against the issuer's PUBLIC JWKS endpoint (key material, not a secret)
// and does local signature verification; it never calls Keycloak's admin API, never holds a
// client secret, and never needs one to do its job.
//
// `jose`'s `createRemoteJWKSet` gives us the three things design §03 names by name:
//   - "cached"     — in-memory cache with a cooldown between refetches (default cooldown 30s,
//                    default max-age 10min here — se W below), so a hot path never
//                    re-fetches per request.
//   - "kid-pinned" — jose resolves the JWT header's own `kid` to exactly one JWK in the set and
//                    verifies against THAT key only; an unknown kid fails closed
//                    (JWKSNoMatchingKey), it is never "try every key in the set".
//   - "offline"    — after the JWKS is cached, verification is pure local crypto; no per-request
//                    network call to Zone A.
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTVerifyGetKey } from "jose";
import type { ControlScope } from "../command-types";

const VALID_SCOPES: ReadonlySet<string> = new Set<ControlScope>([
  "webdesk:read",
  "webdesk:operate",
  "webdesk:promote",
  "webdesk:keys",
]);

export interface TokenClaims {
  subject: string;
  scopes: ControlScope[];
}

export type TokenVerificationResult = { ok: true; claims: TokenClaims } | { ok: false; reason: string };

/** A malformed issuer list is a configuration error: fail loudly at construction, never at first request. */
export class ControlIssuerConfigError extends Error {
  constructor(message: string) {
    super(`[webdesk:api] WEBDESK_CONTROL_OIDC_ISSUER ${message}`);
    this.name = "ControlIssuerConfigError";
  }
}

/**
 * Parses a comma-separated issuer list (whitespace around entries trimmed). During an issuer move
 * (e.g. erp.gaiada.online -> erp.gaiada.com) list `old,new` so both verify.
 */
export function parseIssuerList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim());
}

/** Validates issuers: non-empty list, no empty entry, no duplicate, each an absolute https URL (http only for localhost/127.0.0.1). */
export function validateIssuers(issuers: readonly string[]): string[] {
  if (issuers.length === 0) throw new ControlIssuerConfigError("is an empty list: at least one issuer is required. Refusing to boot.");
  const seen = new Set<string>();
  for (const entry of issuers) {
    if (entry.trim() === "") throw new ControlIssuerConfigError("contains an empty entry (stray comma?). Refusing to boot.");
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ControlIssuerConfigError(`entry ${JSON.stringify(entry)} is not an absolute URL. Refusing to boot.`);
    }
    const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) {
      throw new ControlIssuerConfigError(
        `entry ${JSON.stringify(entry)} must be an absolute https: URL (http: is allowed only for localhost/127.0.0.1). Refusing to boot.`,
      );
    }
    if (seen.has(entry)) throw new ControlIssuerConfigError(`lists ${JSON.stringify(entry)} more than once. Refusing to boot.`);
    seen.add(entry);
  }
  return [...issuers];
}

export interface OfflineJwksVerifierOptions {
  /**
   * Accepted `iss` claim(s) — the public issuer URL, e.g. `https://erp.gaiada.com/idp/realms/gaiada`.
   * A string or a list: a token whose `iss` equals ANY listed issuer verifies (issuer-move window).
   * Give this or `issuers`.
   */
  issuer?: string | string[];
  /** Alias of `issuer`, list form. */
  issuers?: string[];
  /**
   * JWKS endpoint to fetch from. Defaults to the OIDC-conventional path under the FIRST listed issuer:
   * during an issuer move both hostnames front the same Keycloak realm, so the keys are identical.
   */
  jwksUri?: string;
  /** Expected `aud` claim — design §03: audience `webdesk-control-plane`. */
  audience: string;
  /** Allowed clock skew, seconds. Default 5. */
  clockToleranceSec?: number;
}

/**
 * Wraps a single cached remote JWKS + the fixed issuer/audience this control channel expects.
 * One instance is meant to live for the process lifetime (that's what makes the cache useful) —
 * `real-control-channel-authenticator.ts` owns the singleton.
 */
export class OfflineJwksVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuers: string[];
  private readonly audience: string;
  private readonly clockTolerance: number;

  constructor(opts: OfflineJwksVerifierOptions) {
    const given = opts.issuers ?? opts.issuer;
    this.issuers = validateIssuers(given === undefined ? [] : typeof given === "string" ? [given] : given);
    this.audience = opts.audience;
    this.clockTolerance = opts.clockToleranceSec ?? 5;
    const jwksUri = opts.jwksUri ?? `${this.issuers[0].replace(/\/+$/, "")}/protocol/openid-connect/certs`;
    this.jwks = createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: 10 * 60 * 1000, // 10 min — matches design §03's "cached"
      cooldownDuration: 30 * 1000, // don't hammer the issuer if a burst of unknown kids arrives
    });
  }

  async verify(bearerToken: string): Promise<TokenVerificationResult> {
    try {
      const { payload } = await jwtVerify(bearerToken, this.jwks, {
        issuer: this.issuers,
        audience: this.audience,
        clockTolerance: this.clockTolerance,
      });

      const subject = typeof payload.azp === "string" ? payload.azp : (payload.sub ?? "");
      if (!subject) {
        return { ok: false, reason: "token has neither azp nor sub — cannot attribute a principal" };
      }

      const scopeClaim = typeof payload.scope === "string" ? payload.scope : "";
      const scopes = scopeClaim
        .split(/\s+/)
        .filter((s): s is ControlScope => VALID_SCOPES.has(s));

      return { ok: true, claims: { subject, scopes } };
    } catch (err) {
      return { ok: false, reason: describeJoseError(err) };
    }
  }
}

function describeJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return "token expired (exp claim)";
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return `token claim validation failed: ${err.claim} (${err.reason ?? "mismatch"})`;
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "token signature verification failed (tampered or wrong key)";
  if (err instanceof joseErrors.JWKSNoMatchingKey) return "token's kid does not match any key in the issuer's published JWKS (unknown kid)";
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return "token is structurally invalid";
  return `token verification failed: ${(err as Error)?.message ?? String(err)}`;
}
