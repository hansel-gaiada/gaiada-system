// SM-53 — maps the search module's typed dispatch refusals onto HTTP.
//
// Why this exists: `ProviderDispatchError` and its subclasses are plain Errors, not HttpExceptions,
// so `HttpErrorFilter` (which is `@Catch(HttpException)`) never saw them and they fell through to
// Nest's default handler — a **500 with no message**. Found by SM-16 while driving a scope refusal
// live, and it also affected SM-14's single-keyword rank-pull route.
//
// That is worse than a cosmetic status-code problem. These refusals exist specifically to be
// HUMAN-ACTIONABLE: `ScopeDisabledError`'s whole contract is that it names the toggle to enable
// ("enable the 'ai_visibility' tool in this engagement's scope config"), and `PillarDisabledError`
// names the env switch. Surfacing them as an empty 500 discards precisely the part that was designed
// to tell an operator what to do, and reads to a caller as "the platform broke" rather than "the
// platform deliberately refused". Someone would reasonably file it as a bug against dispatch.
//
// Note the engagement-level batch routes already degraded gracefully on their own (returning
// `{status:"skipped", reason:"scope_disabled"}` per item), so this gap only ever surfaced on the
// single-subject routes — which is exactly why it survived: the common path looked correct.
//
// The body keeps `{ error }` for contract parity with every other error in this codebase (the UI and
// bot read `.error`), and ADDS `code` — the typed discriminator — so a caller can branch on the
// refusal kind without string-matching a human-readable sentence that is free to change.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ProviderDispatchError } from "./providers/types";

/** Status per refusal kind. Chosen so a caller can tell "you must change configuration" from
 *  "this capability is unavailable right now", because those need different human responses:
 *
 *  - `scope_disabled` / `budget_exceeded` → **409 Conflict**. The request is well-formed; the
 *    engagement's own configuration (a disabled tool, an exhausted budget) forbids it. The operator
 *    resolves it by changing that configuration, so it is not a 4xx-input error and definitely not a
 *    server fault.
 *  - `pillar_disabled` → **503**. A platform-wide operator brake, intended to be temporary; nothing
 *    the caller can change.
 *  - `global_ceiling_unavailable` / `provider_ceiling_unavailable` → **503**. A spend control we
 *    could not evaluate, so we refused rather than proceeding (§4d). Genuinely "try later", and
 *    deliberately NOT 500: the platform worked exactly as designed by refusing.
 *  - `no_capable_provider` / `unknown_provider` → **503**. The capability is not available in this
 *    deployment (no driver registered, e.g. keyless dev or an unfunded vendor). Not the caller's
 *    fault and not a crash.
 *
 *  None of these is a 500, because none of them is an unexpected failure — every one is a decision
 *  the module made on purpose. Reserving 500 for genuine faults is what keeps it meaningful. */
const STATUS_BY_CODE: Record<string, number> = {
  scope_disabled: 409,
  budget_exceeded: 409,
  pillar_disabled: 503,
  global_ceiling_unavailable: 503,
  provider_ceiling_unavailable: 503,
  no_capable_provider: 503,
  unknown_provider: 503,
};

@Catch(ProviderDispatchError)
export class ProviderDispatchErrorFilter implements ExceptionFilter {
  catch(exception: ProviderDispatchError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    // An unmapped code defaults to 503, not 500: a new refusal kind added later is still a
    // deliberate refusal, and defaulting to 500 would silently recreate the exact bug this filter
    // fixes for anything added after it.
    const status = STATUS_BY_CODE[exception.code] ?? 503;
    void reply.status(status).send({ error: exception.message, code: exception.code });
  }
}
