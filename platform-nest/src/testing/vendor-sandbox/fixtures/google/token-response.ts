// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// The OAuth 2.0 token-endpoint success envelope (RFC 6749 §5.1 + Google's documented fields), as our
// parser reads it (token-endpoint-client.ts's RawTokenBody: access_token / expires_in / refresh_token /
// scope / token_type).
//
// WHAT IS MODELLED FROM DOCS AND MUST NOT BE READ AS OBSERVED GOOGLE BEHAVIOUR:
//   * `expires_in: 3599` — Google's documented access-token lifetime is ~1 hour. Real values vary.
//   * whether `refresh_token` is present on a REFRESH response. Google historically returns none
//     (the caller keeps the existing one); Keycloak rotates and returns a new one. The sandbox can do
//     EITHER (see `rotateRefreshTokens` in google-server.ts) precisely because we do not know which
//     Google does, and our persistence must be correct under both.
//   * `id_token` is deliberately absent: we request no OIDC scopes, so nothing in this module parses one.
export interface TokenResponseParams {
  accessToken: string;
  expiresInSeconds?: number;
  refreshToken?: string | null;
  scope: string;
}

export function tokenResponseBody({ accessToken, expiresInSeconds = 3599, refreshToken, scope }: TokenResponseParams) {
  return {
    access_token: accessToken,
    expires_in: expiresInSeconds,
    scope,
    token_type: "Bearer",
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}
