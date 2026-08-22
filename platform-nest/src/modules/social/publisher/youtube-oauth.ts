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
// ── STATE: DB-BACKED, ATOMICALLY SINGLE-USE (security follow-up, closes this file's own former gap) ──
// This file used to mint/parse its own HMAC-signed-but-replayable state, byte-for-byte identical to
// `linkedin-oauth.ts`'s own former scheme (see git history / the migration header for the removed
// code). It now mints and consumes state through `./oauth-state.ts` — the ONE shared, DB-backed
// single-use state machine both this file and `linkedin-oauth.ts` use, mirroring
// `core/google-oauth/state.ts`'s own mint/parse/consume split. See that file's header for the full
// mechanism. Google's own authorization `code` being separately single-use at ITS token endpoint is
// UNCHANGED and still true — this closes the independent, pure state-replay window that fact never
// covered.
import type { PoolClient } from "pg";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { emitEvent } from "../../../events/outbox.service";
import { hasRegisteredPlatformApp, loadOrgByClient } from "./provisioning";
import { storeOAuthGrant, registerTokenRefresher } from "./oauth-tokens";
import { mintSocialOAuthState } from "./oauth-state";
import { SocialPublisherError } from "./types";
import {
  exchangeAuthorizationCode, hasYouTubeAppCredentials, refreshWithRefreshToken,
} from "./youtube-client";

const MODULES: { modules: string[] } = { modules: ["social"] };

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

  const state = await mintSocialOAuthState({ tenantId, accountId, network: "youtube", createdBy: input.actorId });
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
      // SMM-38 phase 38e — the SAME gap `linkedin-oauth.ts#completeLinkedInConnect` fixes, same
      // reasoning, network swapped: see that file's own comment on this exact statement shape.
      await c.query(
        `UPDATE social_accounts
            SET status = 'connected', platform_app_id = $2, connected_by = $3, connected_at = now(),
                last_error = NULL, postiz_integration_id = COALESCE(postiz_integration_id, 'direct:youtube'),
                updated_at = now()
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
