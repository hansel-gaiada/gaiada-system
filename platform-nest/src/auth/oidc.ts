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
import { applySimulatedStepUp, sessionIdFromClaims, sessionRefFor } from "./step-up";

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
  amr: string[]; // auth methods actually completed, per the IdP's `amr` claim — includes
  // "mfa"/"otp"/"hwk"/"totp" when the IdP stepped the user up. An empty array is a LEGITIMATE
  // weak-auth login (e.g. password-only) once the claim is wired; see `amrClaimPresent` below
  // for the separate "the claim never arrived at all" signal — the two must never be conflated
  // (IAM-MFA-01).
  amrClaimPresent: boolean; // false ONLY when `amr` was entirely absent or not an array on the
  // verified token — i.e. the IdP client has no AMR mapper wired (or emitted garbage). This is
  // the root-cause distinction IAM-MFA-01 fixes: Keycloak's built-in AMR protocol mapper, once
  // attached, ALWAYS sets the claim (as an array — empty for a plain password login, non-empty
  // once a step-up authenticator with a reference value completes); it is never omitted by a
  // correctly-wired client. So an absent claim key is not "the user didn't do MFA", it's "this
  // client/realm was never configured to say so" — see infra/runbooks/enable-mfa.md.
  sessionId: string | null; // PV5-14: the IdP SESSION this token belongs to (`sid`, else `session_state`),
  // read from inside the signature. The simulated step-up (./step-up.ts) is bound to it; null => the token
  // cannot be stepped up at all. The step-up keeps only a hash of it with the user id. DW-7h (BFF §52.3, §52.4)
  // stores it RAW in `security_access_seen` and `security_session_revocations`, because IT must name that exact
  // Keycloak session to sign it out; it is still never logged.
  issuedAt: number | null; // DW-7h (BFF §52.4): the token's `iat`, epoch seconds; null when absent. A "Block login"
  // cuts every token of the user issued before the block.
}

export async function verifyToken(token: string): Promise<VerifiedToken> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: config.oidcIssuers, // any listed issuer (jose accepts string[])
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
  // IAM-MFA-01: distinguish "claim absent/malformed" (amrClaimPresent=false, a misconfiguration)
  // from "claim present but empty" (a legitimate weak-auth login) — see the VerifiedToken
  // doc comment. Do NOT collapse both into `[]` without recording which one happened; that
  // collapse is exactly what made "high" assurance structurally unreachable and silent.
  const amrClaimPresent = Array.isArray(p.amr);
  return {
    sub: p.sub,
    email,
    emailVerified: email !== "" && p.email_verified === true,
    name: p.name ?? p.preferred_username ?? email ?? p.sub,
    amr: amrClaimPresent ? (p.amr as string[]) : [],
    amrClaimPresent,
    sessionId: sessionIdFromClaims(p as Record<string, unknown>),
    issuedAt: typeof p.iat === "number" && Number.isFinite(p.iat) ? p.iat : null,
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
    const byEmail = await withGlobal((c) => c.query<{ id: string; kind: string }>(`SELECT id, kind FROM users WHERE email = $1`, [tok.email]));
    if (byEmail.rows[0]) {
      if (!tok.emailVerified) {
        throw new Error("email collides with an existing account but is not IdP-verified — refusing to link");
      }
      // PV5-10 review: only a HUMAN account (users.kind employee, client or, since M5-W1d, contributor) may be claimed by
      // an IdP login. An automation or bot principal (a payment provider's, an n8n workflow's) carries an address nobody
      // should own; an IdP that verified it anyway must not turn a login into that principal. A contributor's first login
      // links here like a client contact's: the accept route created its account email-verified after the person consumed
      // the single-use token; AuthGuard's fence then holds the principal to @ContributorRoute() routes at assurance high.
      if (byEmail.rows[0].kind !== "employee" && byEmail.rows[0].kind !== "client" && byEmail.rows[0].kind !== "contributor") {
        // eslint-disable-next-line no-console
        console.warn(`[oidc] refused to link an IdP login to ${byEmail.rows[0].kind} principal ${byEmail.rows[0].id}`);
        throw new Error(`email belongs to a ${byEmail.rows[0].kind} principal, not a person — refusing to link`);
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

const STRONG_AMR_METHODS = ["mfa", "otp", "hwk", "totp"];

// IAM-MFA-01: counts every verified token whose `amr` claim was absent/malformed — i.e. every
// login `assuranceFor()` was FORCED to cap at "linked" because the IdP client isn't emitting the
// claim it needs, rather than because the user genuinely didn't step up. Before this ticket that
// case was indistinguishable from "no MFA" and silently became "linked" forever, with nothing to
// grep or alert on — the actual defect this ticket closes. A misconfigured client/realm now shows
// up here on the very first login attempt instead of only being found by an audit months later.
// Exported so a boot/health check or metrics scrape can be wired to it later (owner decision —
// out of this ticket's file scope, see the IAM-MFA-01 report).
let amrClaimMissingCount = 0;

/** Introspection for a future boot/health/metrics wire-up; also the test seam's assertion point. */
export function getAmrClaimMissingCount(): number {
  return amrClaimMissingCount;
}

/** Test seam: isolate the counter between test cases/files. */
export function resetAmrClaimMissingCounterForTest(): void {
  amrClaimMissingCount = 0;
}

/** MFA'd IdP session → 'high' assurance (unlocks step-up-gated actions, D4.3).
 *
 *  IAM-MFA-01 root cause: Keycloak never sent an `amr` claim, so every session assembled at
 *  "linked" no matter what the user did, and enrolling in TOTP could never change that — the
 *  claim carrying the fact didn't exist. Wiring Keycloak's built-in AMR protocol mapper (see
 *  `infra/runbooks/enable-mfa.md`) fixes the emission side; THIS function fixes the consumption
 *  side so the same failure mode can't recur invisibly: an absent/malformed claim still fails
 *  CLOSED to "linked" (never invents "high"), but it is now a DISTINCT, loud, countable case
 *  instead of being silently indistinguishable from a legitimate weak-auth login. */
function assuranceFor(tok: VerifiedToken): "high" | "linked" {
  if (!tok.amrClaimPresent) {
    amrClaimMissingCount++;
    console.error(
      `[oidc:amr-claim-missing] verified token for sub=${tok.sub} carries no usable "amr" claim — ` +
        `the IdP client has no AMR protocol mapper wired (or it emitted a non-array value). ` +
        `Assurance is capped at "linked"; the high-assurance tier is UNREACHABLE for this ` +
        `session and will stay that way for every session until the mapper is fixed. ` +
        `See infra/runbooks/enable-mfa.md. (occurrences this process: ${amrClaimMissingCount})`,
    );
    return "linked";
  }
  return tok.amr.some((m) => STRONG_AMR_METHODS.includes(m)) ? "high" : "linked";
}

/** Full path: verify token → provision → assemble principal at the right assurance. */
export async function principalFromToken(token: string): Promise<Principal | null> {
  return (await sessionPrincipalFromToken(token)).principal;
}

/** PV5-14: the same path, plus the opaque reference of the IdP session the token belongs to (null when the
 *  token names none). The AuthGuard keeps the reference on the request so `POST /api/auth/step-up/simulate`
 *  can bind a step-up to THIS session; a principal is raised by a simulated step-up only here, never on the
 *  service-token paths (OBO envelope, agent, D14 re-drive, dev header). Flag off: identical to before. */
export async function sessionPrincipalFromToken(
  token: string,
): Promise<{ principal: Principal | null; sessionRef: string | null }> {
  const tok = await verifyToken(token);
  const userId = await provisionUser(tok);
  const principal = await assemblePrincipal(userId, assuranceFor(tok));
  const sessionRef = tok.sessionId ? sessionRefFor(userId, tok.sessionId) : null;
  if (!principal) return { principal: null, sessionRef };
  const stepped = await applySimulatedStepUp(principal, sessionRef);
  // DW-7h (BFF §52.4): what the request hook needs to refuse a session IT signed out or a login IT blocked. Only this
  // path sets them; see `Principal.sessionId`.
  return {
    principal: { ...stepped, sessionId: tok.sessionId, ...(tok.issuedAt !== null ? { tokenIssuedAt: tok.issuedAt } : {}) },
    sessionRef,
  };
}
