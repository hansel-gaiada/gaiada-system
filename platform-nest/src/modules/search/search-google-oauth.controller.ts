// SM-25a — the tenant-agnostic Google OAuth callback (design addendum §A12; tracker §6ao "owed").
//
// WHY THIS CANNOT LIVE ON SearchController: that controller's @Controller() prefix is
// `api/:tenantId/modules/search`, baked into every route it serves. Real Google permits NO wildcard
// redirect URIs — the OAuth client's `redirect_uri` must be ONE fixed, exactly-registered string — so
// a per-tenant callback path (e.g. `.../api/<tenantId>/modules/search/google/oauth/callback`) is not
// an option. The tenant therefore travels INSIDE the signed `state` parameter (oauth-state.ts's own
// design — `gs1.<stateId>.<tenantId>.<HMAC>`), and this route is mounted at a fixed, tenant-agnostic
// path instead: `GET api/search/google/oauth/callback`. Registered on its OWN controller in
// app.module.ts (not SearchController) for exactly this reason.
//
// WHAT STOPS A FORGED OR REPLAYED CALLBACK, STATED EXPLICITLY — this is the one route in the module
// that cannot lean on the usual :tenantId + Cerbos + RLS chain for its authority, because none of the
// three exist until the state is decoded:
//   1. FORGERY / tenant pivot (oauth-state.ts's attack A2): `parseStateToken` recomputes the HMAC
//      over the CANONICAL re-encoding of the decoded (stateId, tenantId) pair and rejects anything
//      that does not match via `timingSafeEqual` — BEFORE any database read. A token that merely
//      looks like ours (right shape, wrong signature, or a tenant id spliced in from elsewhere) is
//      refused here, at zero DB cost, mapped to 400 by the globally-registered GoogleOAuthErrorFilter.
//   2. REPLAY (attack A3): `consumeAuthorizationState`'s `UPDATE … WHERE consumed_at IS NULL …
//      RETURNING` (inside `completeAuthorization`) is one atomic statement — a second presentation of
//      an already-spent (or concurrently-being-spent) state matches zero rows. This route calls it
//      exactly once and never retries a failed exchange against the same state.
//   3. CSRF / login-CSRF (attack A1): the state row's `created_by` must equal the CALLING PRINCIPAL —
//      `req.principal.userId`, populated by `AuthGuard` below. An attacker who drives a victim's
//      browser to this route with the ATTACKER's own `code`+`state` cannot complete anything as the
//      victim: the victim's principal will not match the `created_by` the attacker's own `/authorize`
//      call stamped.
//   4. TENANT-ROLE DEFENSE IN DEPTH (not one of oauth-state.ts's named attacks, added here): once the
//      state's signature verifies — so its `tenantId` claim is trustworthy — this route runs the
//      ORDINARY Cerbos check (`resource_search_property` + `update`, scoped to that tenant) BEFORE
//      calling `completeAuthorization`. This is not load-bearing for the callback's core security
//      (A1-A3 above already close it) but it closes a real gap: a principal whose `search` role was
//      revoked AFTER starting the flow but before completing it is refused here, rather than silently
//      allowed to finish a credential link the platform would no longer grant them permission to
//      start. A denial throws BEFORE the state is consumed, so a legitimately re-permissioned retry
//      still works.
//
// WHO CALLS THIS ROUTE, stated so the design is not misread: Google's own redirect is a plain
// top-level browser navigation carrying only `code`/`state`/`error` in the query string — it cannot
// attach an Authorization header, and `AuthGuard` below requires one. The URL registered as Google's
// `redirect_uri` therefore points at a fixed, tenant-agnostic page the FRONT END owns (a UI-wiring
// decision, out of this ticket's backend contract); that page reads `code`/`state`/`error` off its
// own URL and calls THIS endpoint as an ordinary authenticated BFF request — exactly like every other
// route in this codebase — passing `provider` from its own client-side flow context (Google's
// redirect never carries it; see oauth.ts's `CompleteAuthorizationInput.provider` and attack A6 in
// oauth-state.ts). `AuthGuard` is therefore both correct and sufficient here even though this route is
// "tenant-agnostic" — it does not require `:tenantId`, unlike `ModuleEnabledGuard`
// (module-enabled.guard.ts reads `req.params.tenantId` directly), which structurally cannot run on
// this route and is deliberately NOT applied. The third wall (module-sliced RLS) still fires deep
// inside `consumeAuthorizationState`/`createConnection` — that is where `search_google_oauth_states`'s
// `app_module_allowed('search')` policy actually lives, so a tenant that has not enabled `search`
// still reads/writes zero rows here, fail-closed, exactly like every other route in this module.
import { BadRequestException, Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { completeAuthorization } from "./google/oauth";
import { isGoogleProvider, parseStateToken } from "./google/oauth-state";

@Controller("api/search/google/oauth")
@UseGuards(AuthGuard)
export class SearchGoogleOauthCallbackController {
  @Get("callback")
  async callback(
    @Req() req: FastifyRequest,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("provider") provider?: string,
    @Query("error") error?: string,
    @Query("error_description") errorDescription?: string,
  ) {
    // Google's own consent-denial path: no `code`, and nothing here touches the database — the
    // in-flight state row is simply left to expire on its own TTL (oauth-state.ts's A8). Reported as
    // a clean, non-throwing outcome: the user declining consent is not a refusal of THIS route, it is
    // a documented outcome of a real OAuth flow, and forcing it through the error-filter path would
    // mislabel a normal user choice as a security refusal.
    if (error) {
      return { status: "denied" as const, error, errorDescription: errorDescription ?? null };
    }
    if (!code || typeof code !== "string") {
      throw new BadRequestException("code is required (or error, if the user declined at the issuer)");
    }
    if (!state || typeof state !== "string") {
      throw new BadRequestException("state is required");
    }
    if (!provider || !isGoogleProvider(provider)) {
      throw new BadRequestException("provider must be one of google_search_console|google_analytics|google_ads");
    }

    // Verify the signature FIRST (cheap, no DB) so the tenantId used for the Cerbos check below is
    // trustworthy — see point 4 in this file's header. Throws GoogleOAuthStateError (400, mapped by
    // GoogleOAuthErrorFilter) on a malformed token or a bad signature; it does NOT consume the state
    // (that happens once, inside completeAuthorization below).
    const parsed = parseStateToken(state);
    await authorize(req.principal, { kind: "resource_search_property", tenantId: parsed.tenantId, module: "search" }, "update");

    // The actual consume+exchange+seal. Every GoogleSurfaceError this can throw (unknown/expired/
    // already-consumed state, redirect/principal/provider mismatch, issuer refusal) is mapped by the
    // globally-registered GoogleOAuthErrorFilter — no catch/rethrow needed here. Returns the MASKED
    // GoogleConnectionView (token material structurally absent).
    return await completeAuthorization({ stateToken: state, code, principalUserId: req.principal.userId, provider });
  }
}
