// OIDC_ISSUER parsing + boot validation. Kept free of imports so config.ts can use it.
//
// OIDC_ISSUER is a comma-separated list (entries trimmed). During an issuer move (e.g. the
// erp.gaiada.online -> erp.gaiada.com hostname change) list "new,old": a token is accepted when
// its `iss` equals ANY entry; the FIRST entry is the one used wherever a single URL is needed.
export const DEFAULT_OIDC_ISSUER = "http://localhost:8080/realms/gaiada";

// http is allowed only for loopback and the internal compose service name (dev default is
// http://keycloak:8080/realms/gaiada). Everything else must be https.
const HTTP_OK_HOSTS = new Set(["localhost", "127.0.0.1", "keycloak"]);

/** Parse + validate the raw OIDC_ISSUER value. Unset or blank => the default (compose's
 *  `${VAR:-}` passes ""), anything else is validated strictly and THROWS on a bad config. */
export function parseOidcIssuers(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [DEFAULT_OIDC_ISSUER];
  const entries = raw.split(",").map((s) => s.trim());
  const fail = (why: string): never => {
    throw new Error(
      `OIDC_ISSUER="${raw}" is invalid: ${why}. Expected a comma-separated list of absolute issuer ` +
        `URLs (during an issuer move list "new,old"; the first is used to build URLs). Leave it ` +
        `unset to accept the default (${DEFAULT_OIDC_ISSUER}).`,
    );
  };
  const seen = new Set<string>();
  for (const e of entries) {
    if (e === "") fail("it contains an empty entry");
    let u: URL;
    try {
      u = new URL(e);
    } catch {
      return fail(`"${e}" is not an absolute URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") fail(`"${e}" is not an http(s) URL`);
    if (u.protocol === "http:" && !HTTP_OK_HOSTS.has(u.hostname)) {
      fail(`"${e}" is plain http; http is allowed only for localhost, 127.0.0.1 and the internal "keycloak" host`);
    }
    if (seen.has(e)) fail(`"${e}" is listed twice`);
    seen.add(e);
  }
  return entries;
}
