// GH-01 (docs/blueprints/github-integration-foundation.md §2.3) — GitHub App JWT minting.
//
// Byte-for-byte the same algorithm as the PROVEN reference tools (scripts/github-app/verify-app.mjs,
// inventory-org.mjs — both ARE-verified against the live gaiadabali org, 2026-08-31). Deliberately
// not "improved" or refactored into a JWT library: those two scripts are the empirical evidence that
// this exact shape is accepted by GitHub, and diverging from it (a different claim order, a
// different base64url trim) is exactly the kind of change that passes every local test and then
// fails against the real API — which no test in this repo can observe (hard constraint: no live
// GitHub calls from tests). Pure and synchronous — no network, no filesystem, no clock singleton
// (both are injectable for deterministic tests).
import { createSign } from "node:crypto";

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface MintAppJwtOptions {
  appId: string;
  privateKeyPem: string;
  /** Overridable for tests; defaults to the real clock. */
  now?: () => number;
  /** Requested lifetime in seconds. GitHub's own hard ceiling is 600s (10 min, §2.3's "≤10 min");
   *  anything longer is clamped rather than sent, since a JWT GitHub rejects fails the whole mint
   *  with no clean way to tell "we asked for too much" apart from "the key is bad". Default 540s
   *  (9 min) matches verify-app.mjs's proven value, leaving headroom under the ceiling for clock
   *  skew between this process and GitHub's. */
  ttlSeconds?: number;
}

export const GITHUB_APP_JWT_MAX_TTL_SECONDS = 600;
/** §2.3: "iat backdated 60s (GitHub rejects future iat)". This is not a tunable — GitHub's own stated
 *  tolerance is what verify-app.mjs measured working; a caller wanting a different skew budget should
 *  get a new parameter added deliberately, not silently inherit a knob meant for TTL. */
const IAT_BACKDATE_SECONDS = 60;

/** Mint an RS256 App JWT per §2.3: `iat = now - 60s`, `exp = now + ttl` (capped at 600s), `iss =
 *  appId`. Throws whatever `crypto.createSign(...).sign()` throws on a malformed PEM — deliberately
 *  NOT caught/rewrapped here, because this file must never decide what "malformed private key" means
 *  to a caller (github-app.service.ts's credential loader is the layer that knows whether that's a
 *  503-unconfigured or a corrupt-vault-entry — see errors.ts). */
export function mintAppJwt(opts: MintAppJwtOptions): string {
  const nowSec = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const ttl = Math.min(Math.max(opts.ttlSeconds ?? 540, 1), GITHUB_APP_JWT_MAX_TTL_SECONDS);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - IAT_BACKDATE_SECONDS, iss: opts.appId, exp: nowSec + ttl }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = b64url(signer.sign(opts.privateKeyPem));
  return `${header}.${payload}.${signature}`;
}

/** Decode (NOT verify) a JWT's claims — test/diagnostic use only. Never call this to decide trust;
 *  GitHub is the only verifier that matters. */
export function decodeJwtClaimsForTest(jwt: string): { iat: number; exp: number; iss: string } {
  const [, payloadB64] = jwt.split(".");
  const json = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json) as { iat: number; exp: number; iss: string };
}
