// Contract-parity error shape. The Fastify server sent every error as { error: "<message>" }.
// Nest's default HttpException body is { statusCode, message, error }, which would break the UI
// and bot that read `.error`. This filter reshapes all HttpExceptions back to { error: msg }
// with the same status code. A4: also forwards an optional `field` (validation errors that
// name which input was bad, e.g. the bot's own group/config field checks) when the thrown
// exception's response object carries one — purely additive, existing callers never set it.
//
// MI-03: also forwards an optional `existing` OBJECT, for the one error class where the error itself
// has to carry a usable result. The webdev triage endpoint's 409 ("this change request was already
// triaged") must hand the loser of a race the artifact that already exists, so a double-click / retry
// / concurrent decider can navigate to the run or task instead of being told only that it failed. The
// `{error}` reshape above would otherwise DROP that field silently — an error shape quietly eating a
// contract field is exactly the kind of thing a 409's status code alone makes look fine. Same additive
// rule as `field`: only present when the thrown exception set it, so no existing caller changes.
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply } from "fastify";

@Catch(HttpException)
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = exception.getStatus();
    const res = exception.getResponse();
    let error: string;
    let field: string | undefined;
    let existing: Record<string, unknown> | undefined;
    if (typeof res === "string") {
      error = res;
    } else {
      const r = res as { message?: string | string[]; field?: string; existing?: unknown };
      const m = r.message;
      error = Array.isArray(m) ? m.join(", ") : m ?? exception.message;
      if (typeof r.field === "string") field = r.field;
      if (r.existing && typeof r.existing === "object" && !Array.isArray(r.existing)) {
        existing = r.existing as Record<string, unknown>;
      }
    }
    void reply.status(status).send({
      error,
      ...(field ? { field } : {}),
      ...(existing ? { existing } : {}),
    });
  }
}
