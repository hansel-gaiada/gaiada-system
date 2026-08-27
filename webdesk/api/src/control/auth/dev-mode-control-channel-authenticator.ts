// WSK-21 — DEV-MODE STUB ONLY. This is explicitly NOT design §03's control channel: no mTLS, no
// Keycloak token, no cryptographic WS4 verification. It exists so the command surface behind it
// (impact classes, idempotency, job tracking, audit) can be built and tested before WSK-22 lands
// the real thing. Every header this reads is caller-supplied and UNVERIFIED — this class must
// never be reachable from anywhere but a trusted internal caller (tests, WSK-22's own
// integration harness) until it is replaced outright. See control.module.ts's header comment and
// every controller's own for the "not through the public proxy vhost" rule this exists under.
import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { ControlChannelAuthenticator } from "./control-channel-authenticator";
import type { ControlRequest, ControlContext } from "./control-request";
import type { ControlPrincipal } from "./control-principal";
import type { ControlScope } from "../command-types";

const VALID_SCOPES: ReadonlySet<string> = new Set<ControlScope>([
  "webdesk:read",
  "webdesk:operate",
  "webdesk:promote",
  "webdesk:keys",
]);

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class DevModeControlChannelAuthenticator implements ControlChannelAuthenticator {
  async authenticate(request: ControlRequest): Promise<ControlContext> {
    const subject = firstHeader(request.headers["x-webdesk-control-principal"]);
    if (!subject) {
      // Fail closed, same doctrine as ApiKeyAuthGuard: no caller identity, no access — never
      // "assume a default principal" just because dev mode is otherwise lenient.
      throw new UnauthorizedException(
        "no control-channel principal (dev-mode stub reads x-webdesk-control-principal — " +
          "WSK-22 replaces this with mTLS + Keycloak client-credentials)",
      );
    }

    const scopesRaw = firstHeader(request.headers["x-webdesk-control-scopes"]) ?? "";
    const scopes = scopesRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ControlScope => VALID_SCOPES.has(s));

    const automation = firstHeader(request.headers["x-webdesk-control-automation"]) === "true";
    const ws4ApprovalId = firstHeader(request.headers["x-webdesk-ws4-approval-id"]) || null;

    const principal: ControlPrincipal = { subject, scopes, automation };
    return { principal, ws4ApprovalId };
  }
}
