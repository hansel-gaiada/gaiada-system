// SMM-38 phase 38c (design addendum §PD) — the two HTTP edges of LinkedIn's OAuth grant flow.
// `linkedin-oauth.ts` owns the logic; this file is routing + authz only, mirroring
// `social-client-review-portal.controller.ts`/`social-reports.controller.ts`'s own precedent for
// sharing `SocialController`'s route prefix from a SEPARATE controller class (that file is
// off-limits/read-only this ticket, and several other seats hold it this wave).
//
// TWO CONTROLLERS, because the two routes have fundamentally different callers:
//
// 1. `LinkedInOAuthController` — TENANT-SCOPED, under the normal `:tenantId` + Cerbos + RLS chain.
//    A staff member's browser, authenticated, asking to START a connect ceremony for one client.
//
// 2. `LinkedInOAuthCallbackController` — TENANT-AGNOSTIC, at a FIXED path, exactly
//    `SearchGoogleOauthCallbackController`'s own shape and for the identical reason: LinkedIn, like
//    Google, permits no wildcard `redirect_uri` — the OAuth client's redirect must be ONE fixed,
//    exactly-registered string, so a per-tenant callback path is not an option. The tenant AND the
//    account travel inside the signed `state` (linkedin-oauth.ts's own design). Who calls this route:
//    LinkedIn's own redirect is a plain top-level browser navigation carrying only `code`/`state`/
//    `error` — it cannot attach an Authorization header, so the URL registered as LinkedIn's
//    `redirect_uri` must point at a fixed, tenant-agnostic FRONT-END page (a UI-wiring decision, out
//    of this backend contract) that reads those query params off its own URL and calls THIS endpoint
//    as an ordinary authenticated BFF request — `AuthGuard` is therefore correct and sufficient here
//    even though the route itself needs no `:tenantId`.
//
// WHAT STOPS A FORGED OR REPLAYED CALLBACK, mirroring the Google callback's own three-point defence
// (that file's header) with the ONE difference `linkedin-oauth.ts`'s header names explicitly (no
// DB-backed single-use state row — a deliberate, named simplification):
//   1. FORGERY: `parseLinkedInOAuthState` recomputes the HMAC over the canonical re-encoding and
//      rejects anything that does not match, via `timingSafeEqual`, BEFORE any database read.
//   2. CSRF / login-CSRF: the ordinary Cerbos check below (`social_account`/`connect`, scoped to the
//      state's OWN tenant) runs before `completeLinkedInConnect` — a principal whose access to that
//      tenant's social module was revoked after starting the flow is refused here.
//   3. LinkedIn's own `code` is single-use at ITS token endpoint — a replayed callback still fails
//      the exchange with `invalid_grant`, surfaced as a typed `SocialPublisherError`.
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import {
  checkLinkedInConnectReadiness, completeLinkedInConnect, parseLinkedInOAuthState, startLinkedInConnect,
} from "./publisher/linkedin-oauth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api/:tenantId/modules/social")
export class LinkedInOAuthController {
  /** Read-only readiness — same shape as `social.controller.ts`'s own `connectReadiness` for the
   *  Postiz flow, so a console can explain a disabled "Connect LinkedIn" button honestly. */
  @Get("publisher-orgs/:clientId/linkedin/connect")
  async readiness(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
  ) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "read");
    return checkLinkedInConnectReadiness(tenantId, clientId);
  }

  /** Start — or RESUME — the LinkedIn connect ceremony. Same `connect` action `social.controller.ts`'s
   *  own Postiz-flow `connectAccount` gates (`resource_social_account.yaml`'s existing manager-tier
   *  action — no new Cerbos policy needed for this route). */
  @Post("publisher-orgs/:clientId/linkedin/connect")
  @HttpCode(200)
  async connect(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Body() body: { handle?: string },
  ) {
    await authorize(req.principal, { kind: "social_account", tenantId, module: "social" }, "connect");
    if (!UUID_RE.test(clientId)) throw new BadRequestException("invalid_client");
    const handle = (body?.handle ?? "").trim();
    if (!handle) throw new BadRequestException("missing_handle");
    return startLinkedInConnect(tenantId, { clientId, handle, actorId: req.principal.userId });
  }
}

@Controller("api/social/linkedin/oauth")
@UseGuards(AuthGuard)
export class LinkedInOAuthCallbackController {
  @Get("callback")
  async callback(
    @Req() req: FastifyRequest,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("error") error?: string,
    @Query("error_description") errorDescription?: string,
  ) {
    // LinkedIn's own consent-denial path: no `code`, nothing here touches the database — the
    // pending `social_accounts` row is simply left `pending` (a human can retry the connect button).
    if (error) {
      return { status: "denied" as const, error, errorDescription: errorDescription ?? null };
    }
    if (!code || typeof code !== "string") {
      throw new BadRequestException("code is required (or error, if the user declined at LinkedIn)");
    }
    if (!state || typeof state !== "string") {
      throw new BadRequestException("state is required");
    }
    // Verify the signature FIRST (cheap, no DB) so the tenantId used for the Cerbos check below is
    // trustworthy — mirrors SearchGoogleOauthCallbackController's own ordering exactly.
    const parsed = parseLinkedInOAuthState(state);
    await authorize(req.principal, { kind: "social_account", tenantId: parsed.tenantId, module: "social" }, "connect");
    return await completeLinkedInConnect(parsed.tenantId, parsed.accountId, { code, actorId: req.principal.userId });
  }
}
