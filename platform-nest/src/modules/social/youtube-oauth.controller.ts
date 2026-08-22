// SMM-38 phase 38d (design addendum §PD) — the two HTTP edges of YouTube's OAuth grant flow.
// `publisher/youtube-oauth.ts` owns the logic; this file is routing + authz only — mirrors
// `linkedin-oauth.controller.ts` (38c) exactly, which itself mirrors
// `social-client-review-portal.controller.ts`/`social-reports.controller.ts`'s precedent for sharing
// `SocialController`'s route prefix from a SEPARATE controller class.
//
// TWO CONTROLLERS, for the identical reason 38c's own header gives:
//
// 1. `YouTubeOAuthController` — TENANT-SCOPED, under the normal `:tenantId` + Cerbos + RLS chain. A
//    staff member's browser, authenticated, asking to START a connect ceremony for one client.
//
// 2. `YouTubeOAuthCallbackController` — TENANT-AGNOSTIC, at a FIXED path, exactly
//    `SearchGoogleOauthCallbackController`'s own shape (and `LinkedInOAuthCallbackController`'s):
//    Google, like LinkedIn, permits no wildcard `redirect_uri` — the OAuth client's redirect must be
//    ONE fixed, exactly-registered string. The tenant AND the account travel inside the signed
//    `state` (`youtube-oauth.ts`'s own design). Google's own redirect is a plain top-level browser
//    navigation carrying only `code`/`state`/`error` — it cannot attach an Authorization header, so
//    the URL registered as Google's `redirect_uri` must point at a fixed, tenant-agnostic FRONT-END
//    page (a UI-wiring decision, out of this backend contract) that reads those query params off its
//    own URL and calls THIS endpoint as an ordinary authenticated BFF request — `AuthGuard` is
//    therefore correct and sufficient here even though the route itself needs no `:tenantId`.
//
// WHAT STOPS A FORGED OR REPLAYED CALLBACK — identical three-point defence to
// `linkedin-oauth.controller.ts`'s own header (see it for the full reasoning, including the named,
// not-yet-closed `created_by` principal-binding gap): `parseSocialOAuthStateToken`'s HMAC check before
// any DB read; the ordinary Cerbos check scoped to the state's own tenant, which runs BEFORE the state
// is consumed; and, as of the security follow-up that added `./publisher/oauth-state.ts`,
// `consumeSocialOAuthState`'s atomic single-use claim — a replayed or cross-network state is refused
// with a typed, distinguishable `SocialOAuthStateError`, never a generic 500. Google's own
// authorization `code` being single-use at its token endpoint remains a real, independent defence.
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import {
  checkYouTubeConnectReadiness, completeYouTubeConnect, startYouTubeConnect,
} from "./publisher/youtube-oauth";
import { consumeSocialOAuthState, parseSocialOAuthStateToken } from "./publisher/oauth-state";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api/:tenantId/modules/social")
export class YouTubeOAuthController {
  /** Read-only readiness — same shape as `LinkedInOAuthController`'s own, so a console can explain a
   *  disabled "Connect YouTube" button honestly. */
  @Get("publisher-orgs/:clientId/youtube/connect")
  async readiness(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
  ) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "read");
    return checkYouTubeConnectReadiness(tenantId, clientId);
  }

  /** Start — or RESUME — the YouTube connect ceremony. Same `connect` action
   *  `resource_social_account.yaml`'s existing manager-tier action already gates for the Postiz flow
   *  and for LinkedIn's own start route — no new Cerbos policy needed for this route either. */
  @Post("publisher-orgs/:clientId/youtube/connect")
  @HttpCode(200)
  async connect(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Body() body: { handle?: string },
  ) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "connect");
    if (!UUID_RE.test(clientId)) throw new BadRequestException("invalid_client");
    const handle = (body?.handle ?? "").trim();
    if (!handle) throw new BadRequestException("missing_handle");
    return startYouTubeConnect(tenantId, { clientId, handle, actorId: req.principal.userId });
  }
}

@Controller("api/social/youtube/oauth")
@UseGuards(AuthGuard)
export class YouTubeOAuthCallbackController {
  @Get("callback")
  async callback(
    @Req() req: FastifyRequest,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("error") error?: string,
    @Query("error_description") errorDescription?: string,
  ) {
    // Google's own consent-denial path: no `code`, nothing here touches the database — the pending
    // `social_accounts` row is simply left `pending` (a human can retry the connect button).
    if (error) {
      return { status: "denied" as const, error, errorDescription: errorDescription ?? null };
    }
    if (!code || typeof code !== "string") {
      throw new BadRequestException("code is required (or error, if the user declined at Google)");
    }
    if (!state || typeof state !== "string") {
      throw new BadRequestException("state is required");
    }
    // Verify the signature FIRST (cheap, no DB) so the tenantId used for the Cerbos check below is
    // trustworthy — mirrors SearchGoogleOauthCallbackController's / LinkedInOAuthCallbackController's
    // own ordering exactly. Does NOT consume the state; a principal who fails the Cerbos check below
    // must not have spent it.
    const parsed = parseSocialOAuthStateToken(state);
    await authorize(req.principal, { kind: "social_account", tenantId: parsed.tenantId, module: "social" }, "connect");
    // THE atomic single-use claim — see this file's own header.
    const consumed = await consumeSocialOAuthState(state, { network: "youtube" });
    return await completeYouTubeConnect(consumed.tenantId, consumed.accountId, { code, actorId: req.principal.userId });
  }
}
