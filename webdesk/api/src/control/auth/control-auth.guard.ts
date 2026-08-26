// ============================================================================================
// LOUD WARNING (mirrors ../../api-keys/api-keys.controller.ts's own): every route behind this
// guard is a Zone B CONTROL-PLANE command (design §03/§07). The real control channel — synccert
// mTLS + an offline-verified Keycloak client-credentials token + a single-use WS4 assertion — is
// WSK-22's build, not this ticket's. This guard's authenticator (ControlChannelAuthenticator) is
// bound to a DEV-MODE STUB with NO cryptographic verification of anything
// (dev-mode-control-channel-authenticator.ts). Nothing behind this guard may be reachable
// through the public proxy vhost (webdesk/proxy/Caddyfile) until WSK-22 lands.
// ============================================================================================
import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { CONTROL_CHANNEL_AUTHENTICATOR, type ControlChannelAuthenticator } from "./control-channel-authenticator";
import type { ControlRequest } from "./control-request";

@Injectable()
export class ControlAuthGuard implements CanActivate {
  constructor(@Inject(CONTROL_CHANNEL_AUTHENTICATOR) private readonly authenticator: ControlChannelAuthenticator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ControlRequest>();
    request.control = await this.authenticator.authenticate(request);
    return true;
  }
}
