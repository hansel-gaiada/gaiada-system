// OIDC verification (5b.1). AUTH_MODE=oidc verifies a Bearer JWT against the IdP's JWKS
// (issuer + audience checked), resolves it to a platform user (auto-provisioning on first
// login, joined by the stable `sub`), and assembles the principal. AUTH_MODE=dev keeps the
// x-user-id header path for local/tests. The platform is the sole identity authority (D4):
// a surface never asserts who a user is — it either presents a verified IdP token here or
// an OBO envelope resolved via identity_links.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { newId, withGlobal } from "../db";
import { config } from "../config";
import { assemblePrincipal, type Principal } from "../rbac/principal";

// jwtVerify's key-getter type (works for both remote and local JWKS factories).
type KeyGetter = Parameters<typeof jwtVerify>[1];

let jwks: KeyGetter | null = null;
function getJwks(): KeyGetter {
  if (!jwks) jwks = createRemoteJWKSet(new URL(config.oidcJwksUri));
  return jwks;
}

/** Test seam: inject a local key set (in-test signing) without a running IdP. */
export function setJwksForTest(fn: KeyGetter): void {
  jwks = fn;
}

export interface VerifiedToken {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  amr: string[]; // auth methods — includes "mfa"/"otp" when the IdP stepped the user up
}

export async function verifyToken(token: string): Promise<VerifiedToken> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: config.oidcIssuer,
    audience: config.oidcAudience,
  });
  const p = payload as JWTPayload & {
    email?: string;
    email_verified?: boolean;
    name?: string;
    preferred_username?: string;
    amr?: string[];
  };
  if (!p.sub) throw new Error("token has no subject");
  // Only a real, IdP-VERIFIED email may ever be used to link to a pre-existing account
  // (account-takeover guard). preferred_username is NOT an email and is never verified.
  const email = typeof p.email === "string" ? p.email : "";
  return {
    sub: p.sub,
    email,
    emailVerified: email !== "" && p.email_verified === true,
    name: p.name ?? p.preferred_username ?? email ?? p.sub,
    amr: Array.isArray(p.amr) ? p.amr : [],
  };
}

/** Auto-provision (or update) the platform user for a verified IdP subject; return its id. */
export async function provisionUser(tok: VerifiedToken): Promise<string> {
  const existing = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM users WHERE idp_subject = $1`, [tok.sub]),
  );
  if (existing.rows[0]) return existing.rows[0].id;

  // First login: link to a pre-existing (invited) account by email ONLY when the IdP has
  // verified that email — otherwise anyone who registers an unverified address matching a
  // colleague's could hijack their account. An unverified email that collides is refused.
  if (tok.email) {
    const byEmail = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [tok.email]));
    if (byEmail.rows[0]) {
      if (!tok.emailVerified) {
        throw new Error("email collides with an existing account but is not IdP-verified — refusing to link");
      }
      await withGlobal((c) => c.query(`UPDATE users SET idp_subject = $1 WHERE id = $2`, [tok.sub, byEmail.rows[0].id]));
      return byEmail.rows[0].id;
    }
  }
  // No collision → create a fresh user. Store the email only if verified; otherwise use a
  // subject-derived placeholder so an unverified address can't later be claimed by matching.
  const id = newId();
  await withGlobal((c) =>
    c.query(`INSERT INTO users (id, email, name, idp_subject, origin_site) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      tok.emailVerified && tok.email ? tok.email : `${tok.sub}@idp.local`,
      tok.name,
      tok.sub,
      config.originSite,
    ]),
  );
  return id;
}

/** MFA'd IdP session → 'high' assurance (unlocks step-up-gated actions, D4.3). */
function assuranceFor(tok: VerifiedToken): "high" | "linked" {
  return tok.amr.some((m) => ["mfa", "otp", "hwk", "totp"].includes(m)) ? "high" : "linked";
}

/** Full path: verify token → provision → assemble principal at the right assurance. */
export async function principalFromToken(token: string): Promise<Principal | null> {
  const tok = await verifyToken(token);
  const userId = await provisionUser(tok);
  return assemblePrincipal(userId, assuranceFor(tok));
}
