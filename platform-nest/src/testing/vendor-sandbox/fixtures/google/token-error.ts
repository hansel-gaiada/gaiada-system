// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// The OAuth 2.0 token-endpoint ERROR envelope (RFC 6749 §5.2): a 400 carrying `{error, error_description}`.
// The error CODES below are the RFC's own registered values, which Google documents using — they are not
// observed Google output, and the real error-code inventory (which code Google emits for which mistake)
// is an SM-41G clause exactly like §A10.5's vendor error-code inventory.
//
// NOTE ON `error_description`: the sandbox emits one because real issuers do, and our client must not
// crash on its presence — but token-endpoint-client.ts deliberately NEVER surfaces it (an issuer can
// echo request material, including a redirect URI or a code, into that field). Only the `error` code
// reaches GoogleTokenEndpointError.
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_token";

export function tokenErrorBody(error: OAuthErrorCode, description: string) {
  return { error, error_description: description };
}
