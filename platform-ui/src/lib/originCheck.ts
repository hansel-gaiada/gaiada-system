// Origin allow-list for state-changing requests (B0, docs/plans/2026-10-11-erp-names-on-gaiada-com.md §3).
//
// ── WHY ──────────────────────────────────────────────────────────────────────────────────────────
// The session cookie is `SameSite=Lax`, and Lax only separates SITES. On `erp.gaiada.com` every
// `*.gaiada.com` page (the marketing site and its third-party tags, review and client staging sites) is
// the same site, so a form or `fetch()` from any of them that POSTs to the ERP arrives WITH the user's
// session — a cross-subdomain CSRF against every Server Action and every `app/api/*` write. Next's own
// Server Action check compares `Origin` with the forwarded host, but lets a request with no `Origin`
// through, and covers no route handler at all. So `proxy.ts` checks every POST/PUT/PATCH/DELETE here,
// before anything else runs.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
//   1. `Origin` present  -> allowed iff it is exactly one of the allowed origins. `Origin: null`
//      (sandboxed iframes, some redirects, `data:` documents) is refused.
//   2. no `Origin`, `Sec-Fetch-Site` present -> allowed iff `same-origin` or `none` (a user-typed or
//      bookmarked navigation). `same-site` is refused: that is precisely the sibling-subdomain case.
//   3. neither header -> allowed. Every browser that can be driven into a CSRF sends at least one of
//      them on a POST; a request carrying neither comes from a non-browser client (curl, the
//      report-renderer, scripts/erp-session.sh), which has to hold the cookie to do anything and so
//      is not a CSRF.
//
// Allowed origins: `ALLOWED_ORIGINS` (comma-separated, exact origins), else `PUBLIC_ORIGIN`, else —
// dev and e2e, where neither is set — the request's own origin. Compose passes an unset variable as
// an EMPTY string, so empty counts as unset.
//
// Pure: no Next imports, so it is unit-testable and safe in the proxy.

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Paths a THIRD PARTY's browser legitimately POSTs to (form_post OAuth responses, payment returns,
 *  SAML POST bindings). EXACT paths only, each with a comment naming the caller.
 *
 *  Empty on purpose (verified 2026-10-11): platform-ui has three state-changing route handlers
 *  (`api/admin/bot/actions/[state]`, `api/admin/bot/digests/run/[slot]`, `api/meetings/[id]/audio`),
 *  all called by the ERP's own pages. Every OAuth return it handles (`/auth/callback`,
 *  `/api/search/google/callback`) is a GET. The real webhooks (`/api/webhooks/*`, `/api/mail/*`) are
 *  routed by nginx to platform-nest and never reach this app; server-to-server callers send no
 *  `Origin` and pass under rule 3 anyway. */
export const ORIGIN_CHECK_EXEMPT_PATHS: ReadonlySet<string> = new Set<string>([]);

/** `https://Example.com:443/` -> `https://example.com`; anything unparseable -> null. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function firstListValue(v: string | null | undefined): string | null {
  const first = v?.split(",")[0]?.trim();
  return first ? first : null;
}

/** The origin the browser used to reach us, as far as the request can tell (dev/e2e fallback only).
 *  Behind nginx this comes from `X-Forwarded-Proto`/`X-Forwarded-Host`; under `next dev` from the URL. */
export function requestOwnOrigin(headers: { get(name: string): string | null }, url: string): string | null {
  const u = new URL(url);
  const proto = firstListValue(headers.get("x-forwarded-proto")) ?? u.protocol.replace(/:$/, "");
  const host = firstListValue(headers.get("x-forwarded-host")) ?? firstListValue(headers.get("host")) ?? u.host;
  return normalizeOrigin(`${proto}://${host}`);
}

/** The allow-list for this request. Explicit configuration wins; the request's own origin is used only
 *  when nothing is configured. */
export function allowedOrigins(
  env: { ALLOWED_ORIGINS?: string; PUBLIC_ORIGIN?: string },
  ownOrigin: string | null,
): string[] {
  const configured = env.ALLOWED_ORIGINS?.trim() ? env.ALLOWED_ORIGINS : env.PUBLIC_ORIGIN?.trim() ? env.PUBLIC_ORIGIN : "";
  if (configured) {
    return configured
      .split(",")
      .map((s) => normalizeOrigin(s))
      .filter((s): s is string => s !== null);
  }
  return ownOrigin ? [ownOrigin] : [];
}

export interface OriginCheckInput {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  allowed: readonly string[];
}

/** The decision. `true` = let the request through. Safe methods are never checked. */
export function isOriginAllowed({ method, origin, secFetchSite, allowed }: OriginCheckInput): boolean {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) return true;
  if (origin !== null) {
    if (origin.trim() === "" || origin.trim().toLowerCase() === "null") return false;
    const normalized = normalizeOrigin(origin);
    return normalized !== null && allowed.includes(normalized);
  }
  if (secFetchSite !== null) {
    const site = secFetchSite.trim().toLowerCase();
    return site === "same-origin" || site === "none";
  }
  return true;
}
