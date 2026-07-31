// SM-57 — maps `GatewayNotConfiguredError` onto HTTP, the same class of bug SM-53 fixed for
// `ProviderDispatchError` (tracker §6aa/§6ad Ruling 2).
//
// `GatewayNotConfiguredError` (providers/gateway-client.ts) is a plain `Error`, not an
// `HttpException`, so `HttpErrorFilter` (`@Catch(HttpException)`) never sees it and Nest's default
// handler turns it into a **message-less 500**. It escapes uncaught from `embedKeywordSet`'s
// sequential per-keyword embed loop (clustering.ts) on `POST keyword-sets/:id/embed` and
// `POST keyword-sets/:id/cluster` — the controller only maps `KeywordSetTooLargeError` there. The
// AI-draft routes are unaffected because they fall back instead of throwing.
//
// Sibling file, not folded into provider-dispatch-error.filter.ts: `GatewayNotConfiguredError` is a
// different class from a different module (gateway-client.ts, not providers/types.ts) with no
// shared hierarchy — cramming it into a filter named and documented for `ProviderDispatchError`
// would blur a file whose whole value (per the architect's ruling) is a type-scoped catch. A second
// small filter keeps each file's `@Catch` legible as "this file maps exactly this error family."
//
// 503, matching SM-53's reasoning: an unconfigured AI gateway (`GATEWAY_URL` unset) is a deployment
// state, not a caller error and not a crash — the module failed closed on purpose (§01/§07: no
// silent fallback to a direct vendor call). Body keeps `{ error }` for contract parity and adds
// `code: "gateway_not_configured"` so callers can branch on the discriminator, exactly like SM-53.
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { GatewayNotConfiguredError } from "./providers/gateway-client";

@Catch(GatewayNotConfiguredError)
export class GatewayNotConfiguredErrorFilter implements ExceptionFilter {
  catch(exception: GatewayNotConfiguredError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(503).send({ error: exception.message, code: "gateway_not_configured" });
  }
}
