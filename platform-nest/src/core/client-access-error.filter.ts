// W0-4 follow-up — maps the client-access error families (Keycloak admin + invite tokens) onto HTTP.
//
// WHY THIS FILE EXISTS: `keycloak-admin.ts`'s header claimed "KeycloakAdminErrorFilter maps the
// family", and that filter did not exist. The errors extend `Error`, not `HttpException`, so
// `HttpErrorFilter` (`@Catch(HttpException)`) never saw them and they fell through to
// `LastResortExceptionFilter`, which answers an unconditional
// `500 { error: "internal error", code: "internal_error" }`. So every one of them surfaced as a
// message-less 500: `.status`, `.code` and the `missing` env-var list all discarded.
//
// That is the SAME bug this estate has now shipped four times — SM-53 (`ProviderDispatchError`),
// SM-57 (`GatewayNotConfiguredError`), the Google OAuth family, and this one. A doc comment asserting
// a mapping is not a mapping; only a registered filter is. Registered in main.ts alongside its
// siblings.
//
// Statuses come from the errors themselves so the two can't drift:
//   503 not-configured — a DEPLOYMENT state. The operator needs to know WHICH env vars are missing,
//                        which is exactly what a bare 500 destroys.
//   409 user-exists    — reconcilable: the caller can adopt the existing account.
//   502 admin error    — the realm refused or answered unusably; it arrived from across a network
//                        boundary, so blaming the caller would be a lie.
//   400 invalid invite — the token is unusable. Deliberately coarse and identical for
//                        unknown/expired/already-used, so an unauthenticated route offers no oracle.
import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { KeycloakAdminError, KeycloakNotConfiguredError, KeycloakUserExistsError } from "./keycloak-admin";
import { ClientInviteError } from "./client-invites";

// `ClientInviteError` is caught HERE TOO, and finding it was the point of writing this file. It has the
// same shape problem: it extends Error with a `.status`, so a malformed/expired/replayed invite token
// would have surfaced as a generic 500 instead of the coarse 400 it is designed to be — on the ONE route
// in this app that is deliberately unauthenticated, where a useful client-facing status matters most.
// Two error families, one filter, because they are one concern (typed core refusal -> honest HTTP) and
// they are thrown by the same request.
type ClientAccessFamily =
  | KeycloakNotConfiguredError
  | KeycloakAdminError
  | KeycloakUserExistsError
  | ClientInviteError;

@Catch(KeycloakNotConfiguredError, KeycloakAdminError, KeycloakUserExistsError, ClientInviteError)
export class ClientAccessErrorFilter implements ExceptionFilter {
  catch(err: ClientAccessFamily, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    // The missing-variable list is the whole point of the 503: without it an operator sees "not
    // configured" and has to go read config.ts to find out what to set.
    if (err instanceof KeycloakNotConfiguredError) body.missing = err.missing;
    void reply.status(err.status).send(body);
  }
}
