// Contract-parity error shape. The Fastify server sent every error as { error: "<message>" }.
// Nest's default HttpException body is { statusCode, message, error }, which would break the UI
// and bot that read `.error`. This filter reshapes all HttpExceptions back to { error: msg }
// with the same status code. A4: also forwards an optional `field` (validation errors that
// name which input was bad, e.g. the bot's own group/config field checks) when the thrown
// exception's response object carries one — purely additive, existing callers never set it.
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
    if (typeof res === "string") {
      error = res;
    } else {
      const r = res as { message?: string | string[]; field?: string };
      const m = r.message;
      error = Array.isArray(m) ? m.join(", ") : m ?? exception.message;
      if (typeof r.field === "string") field = r.field;
    }
    void reply.status(status).send(field ? { error, field } : { error });
  }
}
