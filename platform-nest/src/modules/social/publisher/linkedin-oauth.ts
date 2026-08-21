// SMM-38 phase 38c (design addendum §PD) — LinkedIn's OAuth GRANT flow: the authorization-code
// exchange, and the START half of the callback route 38b deliberately left out of scope. Tokens
// land via `oauth-tokens.ts#storeOAuthGrant`, exactly as that file's own header instructed.
//
// ── WHY THIS IS A STANDALONE SUBSYSTEM, NOT `SocialPublisher.connectUrl` ────────────────────────
// `direct.ts`'s `connectUrl(org: OrgHandle, network, redirect)` still refuses `capability_unsupported`
// — see that file's header. The port's signature carries neither a tenantId nor an accountId, and a
// real per-account OAuth flow needs both: to create/resume the pending `social_accounts` row (the
// SAME resumability property SMM-07's own `initiateAccountConnect` gives Postiz-driven connects) and
// to mint a CSRF-bound, tenant/account-scoped state. Retrofitting that context into the port's
// existing signature would silently redefine the port's contract — an architecture change this
// ticket does not make unilaterally. So `direct`'s LinkedIn OAuth flow lives here, reached through
// its own controller (`linkedin-oauth.controller.ts`), and ends by calling `storeOAuthGrant` and
// stamping the SAME `social_accounts` row Postiz's own connect flow would have stamped `connected`.
//
// ── STATE: SIGNED, NOT DB-BACKED — A DELIBERATE, NAMED SIMPLIFICATION ───────────────────────────
// `core/google-oauth/state.ts` (the estate's other real OAuth-callback precedent) persists its state
// in a DB table with atomic single-use consumption. This file instead mirrors `core/client-invites.ts`'s
// LIGHTER pattern: an HMAC-signed, time-boxed token carrying (tenantId, accountId, nonce, exp), keyed
// from `config.integrationTokenKey` under its OWN domain-separation label — "derived from the
// credential-vault key rather than adding a second secret to configure" (client-invites.ts's own
// reasoning, reused verbatim). There is deliberately NO database row and NO atomic single-use
// enforcement of the state token itself. This is safe in the one way that matters most — LinkedIn's
// own authorization `code` is single-use at ITS token endpoint (a replayed `code` fails there with
// `invalid_grant`, surfaced by this file as a typed `SocialPublisherError`) — but it does NOT close a
// pure state-replay window before the code is ever exchanged, the way a DB-backed
// `UPDATE ... WHERE consumed_at IS NULL` would. Named here as a considered, deliberate scope choice
// (no live LinkedIn credential exists to attack today — D-23 — and the sole value a stolen, unused
// state+code pair unlocks is "start someone else's OAuth exchange on their behalf", which still needs
// the CSRF-bound Cerbos check in `linkedin-oauth.controller.ts` to complete against the SAME
// principal that started it). A future pass that wants full parity with the Google flow's DB-backed
// single-use guarantee would add a small state table — flagged as a follow-up, not silently decided
// as unnecessary.
import type { PoolClient } from "pg";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { emitEvent } from "../../../events/outbox.service";
import { hasRegisteredPlatformApp, loadOrgByClient } from "./provisioning";
import { storeOAuthGrant, registerTokenRefresher, OAuthTokenError } from "./oauth-tokens";
import { SocialPublisherError } from "./types";
import {
  exchangeAuthorizationCode, hasLinkedInAppCredentials, refreshWithRefreshToken,
} from "./linkedin-client";

const MODULES: { modules: string[] } = { modules: ["social"] };
const STATE_PREFIX = "lis1";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — a human OAuth consent round trip, not a long-lived link.

// ── Signed state ────────────────────────────────────────────────────────────────────────────────

export type LinkedInOAuthStateFailureReason = "malformed" | "bad_signature" | "expired";

export class LinkedInOAuthStateError extends Error {
  readonly status = 400;
  readonly code = "linkedin_oauth_state_invalid";
  constructor(readonly reason: LinkedInOAuthStateFailureReason) {
    super("this LinkedIn connect attempt is not usable — start a new one");
    this.name = "LinkedInOAuthStateError";
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Domain-separated from every OTHER HMAC this estate derives off the same root key
 *  (`client-invites.ts`'s own label, the Google OAuth state key's label) so this key can never
 *  coincide with theirs even though all three derive from the SAME `INTEGRATION_TOKEN_KEY`. */
function signingKey(): Buffer {
  const b64 = config.integrationTokenKey;
  if (!b64) {
    // Reuses oauth-tokens.ts's own vocabulary (this file's sibling in `Yours`) rather than inventing
    // a fourth: the underlying fact is identical — `INTEGRATION_TOKEN_KEY` unset — whether it is
    // this state-signing step or `storeOAuthGrant`'s own sealing step that discovers it.
    throw new OAuthTokenError(
      "oauth_vault_not_configured",
      "INTEGRATION_TOKEN_KEY is unset — it signs the LinkedIn OAuth state token (client-invites.ts's "
      + "own pattern, reused) and seals the resulting grant (secret-box.ts)",
    );
  }
  return createHmac("sha256", Buffer.from(b64, "base64")).update("gaiada:social-oauth-state:v1").digest();
}

interface StatePayload {
  tenantId: string;
  accountId: string;
  nonce: string;
  exp: number; // epoch ms
}

/** `STATE_PREFIX` is prepended LITERALLY, never through `b64url` — mirrors `client-invites.ts`'s own
 *  `signingInput` exactly (`${TOKEN_PREFIX}.${b64url(...)}...`). Every other field IS b64url-encoded
 *  so an arbitrary tenant/account id (which may itself contain characters outside the base64url
 *  alphabet) can never introduce a stray `.` that would desynchronize the split. */
function signingInput(p: StatePayload): string {
  return [STATE_PREFIX, ...[p.tenantId, p.accountId, p.nonce, String(p.exp)].map((s) => b64url(Buffer.from(s, "utf8")))].join(".");
}

export function mintLinkedInOAuthState(tenantId: string, accountId: string): string {
  const payload: StatePayload = { tenantId, accountId, nonce: b64url(randomBytes(12)), exp: Date.now() + STATE_TTL_MS };
  const input = signingInput(payload);
  const mac = createHmac("sha256", signingKey()).update(input).digest();
  return `${input}.${b64url(mac)}`;
}

export interface ParsedLinkedInOAuthState {
  tenantId: string;
  accountId: string;
}

/** Verify signature + expiry, `timingSafeEqual` throughout (mirrors client-invites.ts /
 *  oauth-state.ts's own attack-A1 defence). Does NOT consume anything — see the header. */
export function parseLinkedInOAuthState(token: string): ParsedLinkedInOAuthState {
  const parts = token.split(".");
  // 6 segments: prefix, tenantId, accountId, nonce, exp, mac (signingInput's own 5 + the mac mint appends).
  if (parts.length !== 6) throw new LinkedInOAuthStateError("malformed");
  const [prefix, tenantIdB64, accountIdB64, nonceB64, expB64, macB64] = parts as [string, string, string, string, string, string];
  void nonceB64;
  if (prefix !== STATE_PREFIX) throw new LinkedInOAuthStateError("malformed");
  let tenantId: string;
  let accountId: string;
  let exp: number;
  try {
    tenantId = fromB64url(tenantIdB64).toString("utf8");
    accountId = fromB64url(accountIdB64).toString("utf8");
    exp = Number(fromB64url(expB64).toString("utf8"));
    if (!tenantId || !accountId || !Number.isFinite(exp)) throw new Error("empty");
  } catch {
    throw new LinkedInOAuthStateError("malformed");
  }
  const canonicalInput = parts.slice(0, 5).join(".");
  const expected = createHmac("sha256", signingKey()).update(canonicalInput).digest();
  let given: Buffer;
  try {
    given = fromB64url(macB64);
  } catch {
    throw new LinkedInOAuthStateError("malformed");
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new LinkedInOAuthStateError("bad_signature");
  }
  if (Date.now() > exp) throw new LinkedInOAuthStateError("expired");
  return { tenantId, accountId };
}

// ── Readiness (reuses SMM-07's exact vocabulary, per the ticket's own instruction) ───────────────

export interface LinkedInConnectReadiness {
  ok: boolean;
  reason?: "network_disabled" | "client_connect_requires_signoff" | "connect_redirect_not_configured"
    | "platform_app_not_registered" | "org_not_provisioned";
  detail?: string;
}

/** THE precondition, checked before minting any state or touching LinkedIn. Deliberately mirrors
 *  `provisioning.ts#checkConnectReadiness`'s ORDER (cheapest/most structural first) and its EXACT
 *  refusal vocabulary — the ticket's own instruction ("the honest failure for a missing app
 *  credential is already built... reuse it") applied to every check in this list, not just the one
 *  it named. Not a call INTO that function (its own driver resolution is Postiz-shaped and would
 *  refuse `direct` outright) — a parallel check against the SAME facts for `direct`'s own flow. */
export async function checkLinkedInConnectReadiness(tenantId: string, clientId: string): Promise<LinkedInConnectReadiness> {
  if (!config.social.publisher.enabledNetworks.includes("linkedin")) {
    return { ok: false, reason: "network_disabled", detail: "'linkedin' is disabled in this deployment (SOCIAL_NETWORKS_ENABLED)" };
  }
  if (!config.social.publisher.ownBrandClientIds.includes(clientId)) {
    return {
      ok: false, reason: "client_connect_requires_signoff",
      detail: "client account connects wait for AGPL counsel sign-off (design addendum OQ-3); own-brand accounts proceed",
    };
  }
  if (!config.social.direct.linkedin.redirectUri) {
    return { ok: false, reason: "connect_redirect_not_configured", detail: "SOCIAL_LINKEDIN_REDIRECT_URI is unset" };
  }
  // Both halves of the SAME administrative fact must hold: `social_platform_apps` says an app is
  // registered for 'linkedin' AND the env actually carries a usable client id/secret. Either one
  // missing means there is nothing to start an OAuth round trip against — SMM-07's own reasoning
  // ("a connect button that dead-ends... is worse than one that says so up front"), reused verbatim.
  if (!(await hasRegisteredPlatformApp("linkedin")) || !hasLinkedInAppCredentials()) {
    return {
      ok: false, reason: "platform_app_not_registered",
      detail: "no LinkedIn platform app is registered/configured yet (design addendum OQ-1 — the "
        + "review is weeks-long and non-code; nothing here can shortcut it)",
    };
  }
  const org = await loadOrgByClient(tenantId, clientId);
  if (!org) {
    return { ok: false, reason: "org_not_provisioned", detail: "provision a publisher org for this client before connecting an account" };
  }
  return { ok: true };
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────

export interface StartLinkedInConnectResult {
  accountId: string;
  authorizeUrl: string;
  /** Same resumability signal SMM-07's own `initiateAccountConnect` returns. */
  resumed: boolean;
}

export const LINKEDIN_SCOPES = ["w_organization_social", "r_organization_social_feed"];

/** Start (or RESUME) the LinkedIn connect ceremony for one (client, handle) — the SAME idempotent
 *  upsert key (`tenant_id, client_id, network, handle`) 0105's own UNIQUE constraint and SMM-07's
 *  `initiateAccountConnect` already use, so a resumed attempt reuses the SAME `social_accounts` row
 *  rather than accumulating a second one. */
export async function startLinkedInConnect(
  tenantId: string,
  input: { clientId: string; handle: string; actorId: string | null },
): Promise<StartLinkedInConnectResult> {
  const readiness = await checkLinkedInConnectReadiness(tenantId, input.clientId);
  if (!readiness.ok) {
    throw new SocialPublisherError(
      readiness.reason!,
      readiness.detail ?? `LinkedIn connect refused: ${readiness.reason}`,
    );
  }
  const org = await loadOrgByClient(tenantId, input.clientId);
  /* istanbul ignore next — checkLinkedInConnectReadiness just proved this row exists */
  if (!org) throw new SocialPublisherError("org_not_provisioned", "publisher org vanished after the readiness check");
  const handle = input.handle.trim();

  const { accountId, resumed } = await withTenants(
    [tenantId],
    async (c: PoolClient) => {
      const id = newId();
      const { rows } = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site)
         VALUES ($1,$2,$3,$4,'linkedin',$5,'pending',$6)
         ON CONFLICT (tenant_id, client_id, network, handle) DO UPDATE
            SET publisher_org_id = EXCLUDED.publisher_org_id,
                deleted_at = NULL,
                status = CASE WHEN social_accounts.postiz_integration_id IS NULL
                                AND social_accounts.status <> 'connected'
                              THEN 'pending' ELSE social_accounts.status END,
                updated_at = now()
           RETURNING id, (xmax = 0) AS inserted`,
        [id, tenantId, input.clientId, org.id, handle, config.originSite],
      );
      const row = rows[0] as { id: string; inserted?: boolean };
      const wasInserted = row.inserted === true;
      await emitEvent(
        c, tenantId, "social_account", row.id,
        wasInserted ? "social.account.connect_initiated" : "social.account.connect_resumed",
        { clientId: input.clientId, network: "linkedin", handle, driver: "direct" },
      );
      return { accountId: row.id, resumed: !wasInserted };
    },
    MODULES,
  );

  const state = mintLinkedInOAuthState(tenantId, accountId);
  const authorizeUrl = buildLinkedInAuthorizeUrl(state);
  return { accountId, authorizeUrl, resumed };
}

export function buildLinkedInAuthorizeUrl(state: string): string {
  const c = config.social.direct.linkedin;
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(" "),
  });
  return `${c.authorizeUrl}?${qs.toString()}`;
}

// ── Complete ────────────────────────────────────────────────────────────────────────────────────

export interface CompleteLinkedInConnectResult {
  accountId: string;
  status: "connected";
}

/** Exchange the code, seal the grant via `storeOAuthGrant`, and promote the pending
 *  `social_accounts` row to `connected` — the SAME promotion SMM-07's `syncConnectorRegistry` would
 *  eventually make for a Postiz-driven account, done here directly since `direct` has no separate
 *  sync sweep to converge through. */
export async function completeLinkedInConnect(
  tenantId: string,
  accountId: string,
  args: { code: string; actorId: string | null; fetchImpl?: typeof fetch },
): Promise<CompleteLinkedInConnectResult> {
  // Cheapest / most structural check FIRST (`publish-precondition.ts`'s own stated doctrine, reused
  // here): confirm the account is really ours and really 'linkedin' BEFORE ever spending LinkedIn's
  // authorization `code` on an exchange — a state signature can name a real tenant/account pair, but
  // the row itself is the last word, and there is no reason to burn a single-use code checking that.
  const owns = await withTenants(
    [tenantId],
    (c: PoolClient) => c.query<{ id: string; network: string }>(
      `SELECT id, network FROM social_accounts WHERE id = $1 AND deleted_at IS NULL`,
      [accountId],
    ),
    MODULES,
  );
  const ownedRow = owns.rows[0];
  if (!ownedRow || ownedRow.network !== "linkedin") {
    throw new SocialPublisherError("org_not_provisioned", `no pending LinkedIn account ${accountId} found for this tenant`);
  }

  const tokens = await exchangeAuthorizationCode(
    { code: args.code, redirectUri: config.social.direct.linkedin.redirectUri },
    { fetchImpl: args.fetchImpl },
  );

  await withTenants(
    [tenantId],
    async (c: PoolClient) => {
      await storeOAuthGrant(c, {
        tenantId, accountId, network: "linkedin",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : LINKEDIN_SCOPES,
        expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
        refreshExpiresAt: tokens.refreshTokenExpiresInSeconds
          ? new Date(Date.now() + tokens.refreshTokenExpiresInSeconds * 1000) : null,
        grantedBy: args.actorId,
      });
      const platformApp = await c.query<{ id: string }>(
        `SELECT id FROM social_platform_apps WHERE network = 'linkedin' AND deleted_at IS NULL
           AND review_status <> 'rejected' ORDER BY updated_at DESC LIMIT 1`,
      );
      // SMM-38 phase 38e — a gap found while wiring Gap 1's live dispatch path, fixed HERE at the
      // source rather than relaxed generically in `provisioning.ts#assertDispatchChain`: that
      // function refuses `account_not_connected` for ANY account whose `postiz_integration_id` is
      // NULL, and this UPDATE never set it. A `direct`-connected LinkedIn account has no Postiz-
      // mirrored integration id to put there (there is no Postiz involvement in this flow at all) —
      // `'direct:linkedin'` is a self-describing, non-NULL sentinel, never mistaken for a real
      // Postiz-issued opaque id (which never contains a `:`), satisfying the SAME generic "is this
      // account provably connected" gate every driver's account rows are held to, honestly rather
      // than by weakening that gate for this one driver.
      await c.query(
        `UPDATE social_accounts
            SET status = 'connected', platform_app_id = $2, connected_by = $3, connected_at = now(),
                last_error = NULL, postiz_integration_id = COALESCE(postiz_integration_id, 'direct:linkedin'),
                updated_at = now()
          WHERE id = $1`,
        [accountId, platformApp.rows[0]?.id ?? null, args.actorId],
      );
      await emitEvent(c, tenantId, "social_account", accountId, "social.account.connected", { network: "linkedin", driver: "direct" });
    },
    MODULES,
  );

  return { accountId, status: "connected" };
}

// ── Refresh-ahead wiring (SMM-38b's seam) ─────────────────────────────────────────────────────────

/** Register LinkedIn's real token-endpoint client with `oauth-tokens.ts`'s refresh-ahead seam.
 *  Called once from `boot.ts`, alongside registering the `direct` driver itself. Registering this
 *  does NOT make a network call by itself (`registerTokenRefresher` is a pure Map insert) — it only
 *  becomes reachable when SMM-36's retention sweep finds a `linkedin` grant within its refresh-ahead
 *  window, which requires a LIVE grant to already exist (none does in an unconfigured/dev
 *  deployment) — the same "verified inert until a real grant exists" property 38b's own empty
 *  registry had, now populated with LinkedIn's real client instead of nothing. */
export function registerLinkedInTokenRefresher(): void {
  registerTokenRefresher("linkedin", async ({ refreshToken }) => {
    const tokens = await refreshWithRefreshToken(refreshToken);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      refreshExpiresAt: tokens.refreshTokenExpiresInSeconds
        ? new Date(Date.now() + tokens.refreshTokenExpiresInSeconds * 1000) : null,
    };
  });
}
