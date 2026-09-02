// GH-02 — maps the `GithubSurfaceError` family onto HTTP, mirroring
// modules/search/google/google-oauth-error.filter.ts exactly (same precedent, same reasoning: see
// errors.ts's header). ONE filter for the whole family — every error carries its own status/code, so
// a new GitHub refusal added later is mapped by construction, never by editing a switch here.
//
// Registered in main.ts's `useGlobalFilters` list. Type-scoped (`@Catch(GithubSurfaceError)`), so its
// position among the other type-scoped filters does not matter — only `LastResortExceptionFilter`'s
// position (first argument) is load-bearing, per that file's own ORDER NOTE.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { GithubSurfaceError } from "./errors";

@Catch(GithubSurfaceError)
export class GithubErrorFilter implements ExceptionFilter {
  catch(exception: GithubSurfaceError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    // `{ error }` for contract parity with every other error body in this app (UI/bot read `.error`).
    // This is the exact rename HttpErrorFilter performs for HttpException — done explicitly here
    // because this family bypasses HttpException entirely (see errors.ts's trap note).
    void reply.status(exception.status).send({
      error: exception.message,
      code: exception.code,
      ...(exception.detail ? { detail: exception.detail } : {}),
    });
  }
}
