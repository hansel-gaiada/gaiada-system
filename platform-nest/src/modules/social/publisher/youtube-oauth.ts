// SMM-38 phase 38d (design addendum §PD) — YouTube's OAuth GRANT flow: the authorization-code
// exchange, and the START half of the callback route. Tokens land via
// `oauth-tokens.ts#storeOAuthGrant`, exactly as that file's own header instructed, and exactly the
// shape `linkedin-oauth.ts` (38c) already built for LinkedIn — "Follow that shape; YouTube is Google
// OAuth" was this ticket's own instruction, and this file follows it almost verbatim.
//
// ── WHY THIS IS A STANDALONE SUBSYSTEM, NOT `SocialPublisher.connectUrl` ────────────────────────────
// Identical reasoning to `linkedin-oauth.ts`'s own header: `direct.ts`'s `connectUrl(org: OrgHandle,
// network, redirect)` still refuses `capability_unsupported`. The port's signature carries neither a
// tenantId nor an accountId, and a real per-account OAuth flow needs both. So YouTube's OAuth flow
// lives here, reached through its own controller (`youtube-oauth.controller.ts`), and ends by calling
// `storeOAuthGrant` and stamping the SAME `social_accounts` row Postiz's own connect flow would have
// stamped `connected`.
//
// ── STATE: SIGNED, NOT DB-BACKED — THE SAME NAMED, DELIBERATE SIMPLIFICATION AS 38c ─────────────────
// Mirrors `linkedin-oauth.ts`'s own state scheme byte-for-byte: an HMAC-signed, time-boxed token
// carrying (tenantId, accountId, nonce, exp), keyed from `config.integrationTokenKey` under the SAME
// domain-separation label 38c already uses (`"gaiada:social-oauth-state:v1"` — this label is
// deliberately NOT per-network; the (tenantId, accountId, nonce, exp) payload shape is identical
// across every `direct`-driver network, and cross-network confusion is prevented by the
// network-specific `STATE_PREFIX` — `"yts1"` here vs. LinkedIn's `"lis1"` — which is itself inside the
// signed input, so a LinkedIn state token can never verify against this file's parser or vice versa
// even though both derive the SAME HMAC key). No live YouTube credential exists to attack today
// (D-23), and the sole value a stolen, unused state+code pair unlocks is "start someone else's OAuth
// exchange on their behalf", which still needs the CSRF-bound Cerbos check in
// `youtube-oauth.controller.ts` to complete against the SAME principal that started it — identical
// reasoning to 38c's own. A future pass wanting full parity with the Google *search* flow's DB-backed
// single-use guarantee (`core/google-oauth/state.ts`) would add a small state table — flagged as a
// follow-up, not silently decided as unnecessary, same as 38c left it.
import type { PoolClient } from "pg";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { emitEvent } from "../../../events/outbox.service";
import { hasRegisteredPlatformApp, loadOrgByClient } from "./provisioning";
import { storeOAuthGrant, registerTokenRefresher, OAuthTokenError } from "./oauth-tokens";
import { SocialPublisherError } from "./types";
import {
  exchangeAuthorizationCode, hasYouTubeAppCredentials, refreshWithRefreshToken,
} from "./youtube-client";

const MODULES: { modules: string[] } = { modules: ["social"] };
const STATE_PREFIX = "yts1";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — a human OAuth consent round trip, not a long-lived link.

// ── Signed state ────────────────────────────────────────────────────────────────────────────────────

export type YouTubeOAuthStateFailureReason = "malformed" | "bad_signature" | "expired";

export class YouTubeOAuthStateError extends Error {
  readonly status = 400;
  readonly code = "youtube_oauth_state_invalid";
  constructor(readonly reason: YouTubeOAuthStateFailureReason) {
    super("this YouTube connect attempt is not usable — start a new one");
    this.name = "YouTubeOAuthStateError";
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Domain-separated from every OTHER HMAC this estate derives off the same root key — see the file
 *  header for why this label is shared with `linkedin-oauth.ts` (the payload shape is identical; the
 *  network-specific `STATE_PREFIX` inside the signed input is what keeps the two apart). */
function signingKey(): Buffer {
  const b64 = config.integrationTokenKey;
  if (!b64) {
    // Reuses oauth-tokens.ts's own vocabulary, same as linkedin-oauth.ts does: the underlying fact is
    // identical — `INTEGRATION_TOKEN_KEY` unset — whether it is this state-signing step or
    // `storeOAuthGrant`'s own sealing step that discovers it.
    throw new OAuthTokenError(
      "oauth_vault_not_configured",
      "INTEGRATION_TOKEN_KEY is unset — it signs the YouTube OAuth state token (client-invites.ts's "
      + "own pattern, reused via linkedin-oauth.ts) and seals the resulting grant (secret-box.ts)",
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

function signingInput(p: StatePayload): string {
  return [STATE_PREFIX, ...[p.tenantId, p.accountId, p.nonce, String(p.exp)].map((s) => b64url(Buffer.from(s, "utf8")))].join(".");
}

export function mintYouTubeOAuthState(tenantId: string, accountId: string): string {
  const payload: StatePayload = { tenantId, accountId, nonce: b64url(randomBytes(12)), exp: Date.now() + STATE_TTL_MS };
  const input = signingInput(payload);
  const mac = createHmac("sha256", signingKey()).update(input).digest();
  return `${input}.${b64url(mac)}`;
}

export interface ParsedYouTubeOAuthState {
  tenantId: string;
  accountId: string;
}

/** Verify signature + expiry, `timingSafeEqual` throughout (mirrors `linkedin-oauth.ts`'s own
 *  parser). Does NOT consume anything — see the header. */
export function parseYouTubeOAuthState(token: string): ParsedYouTubeOAuthState {
  const parts = token.split(".");
  if (parts.length !== 6) throw new YouTubeOAuthStateError("malformed");
  const [prefix, tenantIdB64, accountIdB64, nonceB64, expB64, macB64] = parts as [string, string, string, string, string, string];
  void nonceB64;
  if (prefix !== STATE_PREFIX) throw new YouTubeOAuthStateError("malformed");
  let tenantId: string;
  let accountId: string;
  let exp: number;
  try {
    tenantId = fromB64url(tenantIdB64).toString("utf8");
    accountId = fromB64url(accountIdB64).toString("utf8");
    exp = Number(fromB64url(expB64).toString("utf8"));
    if (!tenantId || !accountId || !Number.isFinite(exp)) throw new Error("empty");
  } catch {
    throw new YouTubeOAuthStateError("malformed");
  }
  const canonicalInput = parts.slice(0, 5).join(".");
  const expected = createHmac("sha256", signingKey()).update(canonicalInput).digest();
  let given: Buffer;
  try {
    given = fromB64url(macB64);
  } catch {
    throw new YouTubeOAuthStateError("malformed");
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new YouTubeOAuthStateError("bad_signature");
  }
  if (Date.now() > exp) throw new YouTubeOAuthStateError("expired");
  return { tenantId, accountId };
}

// ── Readiness (reuses SMM-07's exact vocabulary, per the ticket's own instruction) ───────────────────

export interface YouTubeConnectReadiness {
  ok: boolean;
  reason?: "network_disabled" | "client_connect_requires_signoff" | "connect_redirect_not_configured"
    | "platform_app_not_registered" | "org_not_provisioned";
  detail?: string;
}

/** THE precondition, checked before minting any state or touching Google. Mirrors
 *  `linkedin-oauth.ts#checkLinkedInConnectReadiness`'s ORDER and EXACT refusal vocabulary. */
export async function checkYouTubeConnectReadiness(tenantId: string, clientId: string): Promise<YouTubeConnectReadiness> {
  if (!config.social.publisher.enabledNetworks.includes("youtube")) {
    return { ok: false, reason: "network_disabled", detail: "'youtube' is disabled in this deployment (SOCIAL_NETWORKS_ENABLED)" };
  }
  if (!config.social.publisher.ownBrandClientIds.includes(clientId)) {
    return {
      ok: false, reason: "client_connect_requires_signoff",
      detail: "client account connects wait for AGPL counsel sign-off (design addendum OQ-3); own-brand accounts proceed",
    };
  }
  if (!config.social.direct.youtube.redirectUri) {
    return { ok: false, reason: "connect_redirect_not_configured", detail: "SOCIAL_YOUTUBE_REDIRECT_URI is unset" };
  }
  if (!(await hasRegisteredPlatformApp("youtube")) || !hasYouTubeAppCredentials()) {
    return {
      ok: false, reason: "platform_app_not_registered",
      detail: "no YouTube/Google Cloud platform app is registered/configured yet (design addendum OQ-1 / "
        + "app-review dossier §6 — Google OAuth app verification is weeks-long and non-code)",
    };
  }
  const org = await loadOrgByClient(tenantId, clientId);
  if (!org) {
    return { ok: false, reason: "org_not_provisioned", detail: "provision a publisher org for this client before connecting an account" };
  }
  return { ok: true };
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────────

export interface StartYouTubeConnectResult {
  accountId: string;
  authorizeUrl: string;
  resumed: boolean;
}

/** dossier §6.2 items (a) and (b) only — upload + comment read/write. Deliberately NOT the broad
 *  `.../auth/youtube` manage scope, and NOT any analytics/DM scope: this phase's own scope is
 *  "resumable upload + pullComments", nothing broader. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

/** Start (or RESUME) the YouTube connect ceremony for one (client, handle) — the SAME idempotent
 *  upsert key `linkedin-oauth.ts#startLinkedInConnect` uses. */
export async function startYouTubeConnect(
  tenantId: string,
  input: { clientId: string; handle: string; actorId: string | null },
): Promise<StartYouTubeConnectResult> {
  const readiness = await checkYouTubeConnectReadiness(tenantId, input.clientId);
  if (!readiness.ok) {
    throw new SocialPublisherError(
      readiness.reason!,
      readiness.detail ?? `YouTube connect refused: ${readiness.reason}`,
    );
  }
  const org = await loadOrgByClient(tenantId, input.clientId);
  /* istanbul ignore next — checkYouTubeConnectReadiness just proved this row exists */
  if (!org) throw new SocialPublisherError("org_not_provisioned", "publisher org vanished after the readiness check");
  const handle = input.handle.trim();

  const { accountId, resumed } = await withTenants(
    [tenantId],
    async (c: PoolClient) => {
      const id = newId();
      const { rows } = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site)
         VALUES ($1,$2,$3,$4,'youtube',$5,'pending',$6)
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
        { clientId: input.clientId, network: "youtube", handle, driver: "direct" },
      );
      return { accountId: row.id, resumed: !wasInserted };
    },
    MODULES,
  );

  const state = mintYouTubeOAuthState(tenantId, accountId);
  const authorizeUrl = buildYouTubeAuthorizeUrl(state);
  return { accountId, authorizeUrl, resumed };
}

export function buildYouTubeAuthorizeUrl(state: string): string {
  const c = config.social.direct.youtube;
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    state,
    scope: YOUTUBE_SCOPES.join(" "),
    // Ask for a refresh token, and ask the consent screen to re-appear so one is actually re-issued
    // on a re-link — Google-specific, harmless-if-ignored extras (mirrors
    // `core/google-oauth/token-endpoint-client.ts#buildAuthorizeUrl`'s own reasoning, reproduced here
    // rather than imported since this is a DIFFERENT OAuth client — see the file header).
    access_type: "offline",
    prompt: "consent",
  });
  return `${c.authorizeUrl}?${qs.toString()}`;
}

// ── Complete ────────────────────────────────────────────────────────────────────────────────────────

export interface CompleteYouTubeConnectResult {
  accountId: string;
  status: "connected";
}

/** Exchange the code, seal the grant via `storeOAuthGrant`, and promote the pending
 *  `social_accounts` row to `connected` — mirrors `linkedin-oauth.ts#completeLinkedInConnect`
 *  exactly, network swapped. */
export async function completeYouTubeConnect(
  tenantId: string,
  accountId: string,
  args: { code: string; actorId: string | null; fetchImpl?: typeof fetch },
): Promise<CompleteYouTubeConnectResult> {
  // Cheapest / most structural check FIRST, before ever spending Google's single-use authorization
  // `code` on an exchange — same doctrine as `linkedin-oauth.ts`'s own ordering.
  const owns = await withTenants(
    [tenantId],
    (c: PoolClient) => c.query<{ id: string; network: string }>(
      `SELECT id, network FROM social_accounts WHERE id = $1 AND deleted_at IS NULL`,
      [accountId],
    ),
    MODULES,
  );
  const ownedRow = owns.rows[0];
  if (!ownedRow || ownedRow.network !== "youtube") {
    throw new SocialPublisherError("org_not_provisioned", `no pending YouTube account ${accountId} found for this tenant`);
  }

  const tokens = await exchangeAuthorizationCode(
    { code: args.code, redirectUri: config.social.direct.youtube.redirectUri },
    { fetchImpl: args.fetchImpl },
  );

  await withTenants(
    [tenantId],
    async (c: PoolClient) => {
      await storeOAuthGrant(c, {
        tenantId, accountId, network: "youtube",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : YOUTUBE_SCOPES,
        expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
        refreshExpiresAt: tokens.refreshTokenExpiresInSeconds
          ? new Date(Date.now() + tokens.refreshTokenExpiresInSeconds * 1000) : null,
        grantedBy: args.actorId,
      });
      const platformApp = await c.query<{ id: string }>(
        `SELECT id FROM social_platform_apps WHERE network = 'youtube' AND deleted_at IS NULL
           AND review_status <> 'rejected' ORDER BY updated_at DESC LIMIT 1`,
      );
      await c.query(
        `UPDATE social_accounts
            SET status = 'connected', platform_app_id = $2, connected_by = $3, connected_at = now(),
                last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [accountId, platformApp.rows[0]?.id ?? null, args.actorId],
      );
      await emitEvent(c, tenantId, "social_account", accountId, "social.account.connected", { network: "youtube", driver: "direct" });
    },
    MODULES,
  );

  return { accountId, status: "connected" };
}

// ── Refresh-ahead wiring (SMM-38b's seam) ─────────────────────────────────────────────────────────────

/** Register YouTube's real token-endpoint client with `oauth-tokens.ts`'s refresh-ahead seam. Called
 *  once from `boot.ts`, alongside `registerLinkedInTokenRefresher()`. Same "pure Map insert, verified
 *  inert until a real grant exists" property 38b/38c already established. */
export function registerYouTubeTokenRefresher(): void {
  registerTokenRefresher("youtube", async ({ refreshToken }) => {
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
