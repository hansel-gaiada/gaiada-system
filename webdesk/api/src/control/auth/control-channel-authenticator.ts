import type { ControlRequest, ControlContext } from "./control-request";

export const CONTROL_CHANNEL_AUTHENTICATOR = Symbol("CONTROL_CHANNEL_AUTHENTICATOR");

/**
 * §03's real control channel is FOUR layers: synccert mTLS, an offline-JWKS-verified Keycloak
 * client-credentials token, Cerbos command-scope authorization, and (on irreversible commands) a
 * single-use HMAC WS4 assertion. None of that exists yet — WSK-22 owns building it. This
 * interface is the seam: bind a real implementation to `CONTROL_CHANNEL_AUTHENTICATOR` in
 * `control.module.ts` and nothing in `control/**`'s controllers or guards changes.
 */
export interface ControlChannelAuthenticator {
  authenticate(request: ControlRequest): Promise<ControlContext>;
}
