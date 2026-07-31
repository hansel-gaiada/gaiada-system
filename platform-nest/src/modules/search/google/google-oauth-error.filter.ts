// SM-25a — maps the `GoogleSurfaceError` family onto HTTP. The THIRD instance of a bug class this
// module has already fixed twice, closed in the same diff that introduces the errors rather than in a
// follow-up ticket.
//
// The precedent, verbatim from the two fixes it follows: `ProviderDispatchError` (SM-53) and
// `GatewayNotConfiguredError` (SM-57) were plain `Error`s, so `HttpErrorFilter` (`@Catch(HttpException)`)
// never saw them and Nest's default handler turned each into a MESSAGE-LESS 500 — discarding exactly
// the human-actionable content the refusal existed to deliver. SM-58 then added
// `LastResortExceptionFilter` as the app-wide floor. That floor is a backstop, not a mapping: it
// cannot know that "Google OAuth is not configured" is a 503 deployment state while "this callback
// does not verify" is a 400. This filter supplies that knowledge.
//
// ONE filter for the whole family (unlike SM-53/SM-57's two sibling filters, which caught two
// unrelated classes from two different modules): every error here descends from `GoogleSurfaceError`
// and CARRIES ITS OWN `status` + `code`, so `@Catch(GoogleSurfaceError)` stays a single legible
// type-scoped catch and a newly-added error in errors.ts is mapped the moment it is constructed —
// there is no per-error branch here to forget to update.
//
// Registered in main.ts's `useGlobalFilters` list. ORDER NOTE (main.ts documents this at length):
// `RouterExceptionFilters` REVERSES the array, so `LastResortExceptionFilter` must stay the FIRST
// argument; this filter is type-scoped and its position among the other type-scoped filters does not
// matter.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { GoogleSurfaceError } from "./errors";

@Catch(GoogleSurfaceError)
export class GoogleOAuthErrorFilter implements ExceptionFilter {
  catch(exception: GoogleSurfaceError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    // `{ error }` for contract parity with every other error body in this app (the UI/bot read
    // `.error`), plus the `code` discriminator SM-53 established so callers branch on a stable token
    // instead of matching on prose. `detail` is present only when the error carried non-secret
    // context — errors.ts's own constructors are the single place that decides what is safe to expose.
    void reply.status(exception.status).send({
      error: exception.message,
      code: exception.code,
      ...(exception.detail ? { detail: exception.detail } : {}),
    });
  }
}
