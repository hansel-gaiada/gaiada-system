// SMM-05 — maps the social publisher's typed refusals onto HTTP.
//
// Same shape and the same reasoning as its search-module sibling
// (modules/search/provider-dispatch-error.filter.ts): `SocialPublisherError` is a plain Error, not
// an HttpException, so `HttpErrorFilter` (which is `@Catch(HttpException)`) never sees it and it
// would otherwise fall through to Nest's default handler as a **body-less 500**. platform-nest's
// own CLAUDE.md names that as the same bug four times over: "a plain Error thrown from a module
// escapes as a body-less 500 unless a filter maps it — add the error to a typed family rather than
// a one-off try/catch".
//
// That matters more here than a status code usually does, because these refusals exist to be
// ACTED ON: `cross_client_account` is a security control reporting that it fired,
// `org_key_unresolved` names a deployment misconfiguration a human must fix, and
// `publisher_not_configured` is the difference between "the feature is off in this deployment" and
// "the platform is broken". Rendering any of them as an empty 500 discards exactly the part that
// was designed to say what to do.
//
// ── ON `message` vs `error` ─────────────────────────────────────────────────────────────────────
// The trap documented in src/http-error.filter.ts (a token passed as `error` is silently replaced
// by Nest's constructor-derived string) applies to HttpException PAYLOADS. This filter builds the
// response body itself, so it is not in play — and the body keeps `{ error }` for contract parity
// with every other error in this codebase (the UI and the bot read `.error`), plus `code`, the
// typed discriminator an agent branches on without string-matching prose.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { SocialPublisherError } from "./publisher/types";

/** Status per refusal kind, chosen so a caller can tell the four genuinely different situations
 *  apart, because each needs a different human response:
 *
 *  - `publisher_not_configured` / `org_key_unresolved` / `unknown_publisher` → **503**. This
 *    deployment cannot do it: no engine wired, no key for the alias, a driver nobody registered.
 *    Nothing the caller can change and not a crash — the same answer the search module gives for an
 *    unfunded vendor.
 *  - `publisher_unreachable` → **503**. The engine did not answer (a downed WireGuard tunnel is the
 *    expected cause). Genuinely "try later".
 *  - `publisher_http_error` → **502**. The engine answered, and answered badly. A distinct status
 *    from 503 on purpose: 502 means the upstream is alive and disagreeing, which is a different
 *    investigation from an unreachable host.
 *  - `capability_unsupported` → **501**. Deliberately NOT 503, and this is the one deviation from
 *    the search filter's table. 503 invites a retry; this condition is permanent until a DIFFERENT
 *    DRIVER is deployed. Postiz has no inbound engagement surface for any network and no
 *    org-creation route, and neither will exist however long anyone waits — the honest status for
 *    "this implementation does not have this capability" is 501.
 *  - `cross_client_account` / `account_not_connected` / `network_disabled` / `org_conflict` /
 *    `org_not_provisioned` / `approval_required` → **409**. The request is well-formed; the state of
 *    the data or the configuration forbids it. Not a 4xx-input error, definitely not a server fault,
 *    and emphatically not a 500 — every one of these is a decision the module made on purpose.
 *    `cross_client_account` in particular is a control REPORTING SUCCESS at refusing.
 *  - SMM-07's connect-flow refusals join the same two families rather than inventing a third:
 *    `platform_app_not_registered` / `client_connect_requires_signoff` → **409** (well-formed
 *    request; a non-code review or a legal sign-off — not this deployment's config — is what is
 *    missing, same shape as `org_not_provisioned`). `connect_redirect_not_configured` → **503**
 *    (a deployment configuration gap, same shape as `publisher_not_configured`/`org_key_unresolved`
 *    — nothing the caller can fix by retrying). */
const STATUS_BY_CODE: Record<string, number> = {
  publisher_not_configured: 503,
  publisher_unreachable: 503,
  unknown_publisher: 503,
  org_key_unresolved: 503,
  publisher_http_error: 502,
  capability_unsupported: 501,
  cross_client_account: 409,
  account_not_connected: 409,
  network_disabled: 409,
  org_conflict: 409,
  org_not_provisioned: 409,
  approval_required: 409,
  platform_app_not_registered: 409,
  client_connect_requires_signoff: 409,
  connect_redirect_not_configured: 503,
};

@Catch(SocialPublisherError)
export class SocialPublisherErrorFilter implements ExceptionFilter {
  catch(exception: SocialPublisherError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    // An unmapped code defaults to 503, not 500: a refusal kind added later is still a DELIBERATE
    // refusal, and defaulting to 500 would silently recreate the exact bug this filter exists to
    // fix for anything added after it. Pinned by a test so the default is relied on knowingly.
    const status = STATUS_BY_CODE[exception.code] ?? 503;
    void reply.status(status).send({ error: exception.message, code: exception.code });
  }
}
