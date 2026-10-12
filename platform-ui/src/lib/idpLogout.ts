// B0 sweep — "Sign out" cleared only the ERP cookie. Keycloak's SSO session survived, so the next /auth/login
// signed the user straight back in without a password: on a shared machine, sign-out did not sign anyone out.
//
// This ends the Keycloak session server-side with the refresh token the session already holds: a POST to the
// realm's `openid-connect/logout` with `client_id` + `refresh_token`. `gaiada-ui` is a PUBLIC client (PKCE, no
// secret; see app/auth/refresh/route.ts), so no credential is involved, and no browser round-trip through
// Keycloak's logout page is needed (that one needs an `id_token_hint` the session does not keep, or it asks the
// user to confirm).
//
// Fail-soft on purpose: the caller clears the ERP cookie whatever this returns. A hung or failing IdP must not
// keep a user signed in to the ERP, and it is bounded so it cannot hold the sign-out open.
export async function endIdpSession(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const tokenUrl =
    process.env.OIDC_TOKEN_URL ?? "http://localhost:8080/realms/gaiada/protocol/openid-connect/token";
  const logoutUrl = process.env.OIDC_LOGOUT_URL ?? tokenUrl.replace(/\/token$/, "/logout");
  const clientId = process.env.OIDC_CLIENT_ID ?? "gaiada-ui";
  try {
    const res = await fetchImpl(logoutUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, refresh_token: refreshToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok; // Keycloak answers 204
  } catch {
    return false;
  }
}
