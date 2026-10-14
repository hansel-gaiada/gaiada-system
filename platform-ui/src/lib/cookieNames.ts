// The ONE place the app's session, auth and tenant-context cookies are named, written, read and
// cleared (B0, docs/plans/2026-10-11-erp-names-on-gaiada-com.md §3).
//
// ── WHY `__Host-` ────────────────────────────────────────────────────────────────────────────────
// On `erp.gaiada.com` the ERP is SAME-SITE with every `*.gaiada.com` site (the marketing site and its
// third-party tags, review and client staging sites), and it already is with `*.gaiada.online`. Any of
// them can write a cookie with `Domain=.gaiada.com` that the browser then sends to the ERP under the
// same name as ours ("cookie tossing"): a planted `gaiada_tenant` switches someone's company, a
// planted `gaiada_session` logs them in as the attacker. A `__Host-` cookie can only be set by the
// host itself, over HTTPS, with `Secure`, `Path=/` and NO `Domain`, so a sibling cannot forge or
// shadow it. Under `next dev` (plain http://localhost, NODE_ENV != production) the browser would
// refuse a `__Host-` cookie, so the prefix — and `Secure` — apply in production only; e2e specs that
// `addCookies({ name: "gaiada_tenant" })` keep working there.
//
// ── RULES FOR CALL SITES ─────────────────────────────────────────────────────────────────────────
// * Never type one of these names as a string literal. Go through `setHostCookie`/`readHostCookie`/
//   `clearHostCookie`, which resolve the name and the attributes together.
// * There is deliberately NO fallback read of the unprefixed name in production: accepting the old
//   name would accept exactly the tossed cookie the prefix exists to refuse. The cost is one sign-in
//   after the release that introduces the prefix.
// * A `__Host-` cookie is only replaced by a write that again carries `Secure` and `Path=/`; a
//   `maxAge: 0` without them is silently ignored by the browser, so logout would quietly fail. Clear
//   through `clearHostCookie`, never `jar.delete()` (which sends neither).
//
// Kept free of `next/headers`, `node:crypto` and `server-only`: `proxy.ts` and plain vitest import it.

/** Base (unprefixed) names. UI-preference cookies (`gaiada_prefs`, `gaiada_sidebar`, `dtview:*`, …)
 *  are intentionally NOT here: a tossed preference changes a layout, not who you are or which company
 *  you act in, and `gaiada_sidebar` is written from client-side JavaScript. */
export const HOST_COOKIES = {
  session: "gaiada_session",
  pkce: "oidc_pkce",
  googleOAuthPending: "sm_google_oauth_pending",
  driveOAuthPending: "sm_drive_oauth_pending",
  tenant: "gaiada_tenant",
  portalTenant: "gaiada_portal_tenant",
  portalClient: "gaiada_portal_client",
  pmScope: "gaiada_pm_scope",
} as const;

export type HostCookieBase = (typeof HOST_COOKIES)[keyof typeof HOST_COOKIES];

/** True in production. Evaluated per call (not cached at module load) so tests can stub NODE_ENV;
 *  Next inlines `process.env.NODE_ENV` at build time, so this costs nothing in the real build. */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The wire name: `__Host-<base>` in production, `<base>` everywhere else. */
export function cookieName(base: HostCookieBase): string {
  return secureCookies() ? `__Host-${base}` : base;
}

export interface HostCookieOptions {
  httpOnly: boolean;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge?: number;
}

/** Set options for one of these cookies. `extra` can only add a lifetime or relax httpOnly; it can
 *  never change `path`, `secure` or add a `domain` — those are what make `__Host-` valid at all. */
export function hostCookieOptions(extra: { maxAge?: number; httpOnly?: boolean } = {}): HostCookieOptions {
  return {
    httpOnly: extra.httpOnly ?? true,
    sameSite: "lax",
    path: "/",
    secure: secureCookies(),
    ...(extra.maxAge !== undefined ? { maxAge: extra.maxAge } : {}),
  };
}

/** Options that actually REMOVE the cookie: same name, `maxAge: 0`, and the same `Secure` + `Path=/`
 *  the cookie was set with (see the header for why a bare `maxAge: 0` is not enough). */
export function clearedHostCookieOptions(): HostCookieOptions {
  return { ...hostCookieOptions(), maxAge: 0 };
}

// Structural types so the helpers accept both `await cookies()` (server actions / route handlers)
// and `NextResponse#cookies` / `NextRequest#cookies`, without importing `next/headers` here.
interface CookieWriter {
  set(name: string, value: string, options: HostCookieOptions): unknown;
}
interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export function setHostCookie(
  jar: CookieWriter,
  base: HostCookieBase,
  value: string,
  extra: { maxAge?: number; httpOnly?: boolean } = {},
): void {
  jar.set(cookieName(base), value, hostCookieOptions(extra));
}

export function readHostCookie(jar: CookieReader, base: HostCookieBase): string | undefined {
  return jar.get(cookieName(base))?.value;
}

export function clearHostCookie(jar: CookieWriter, base: HostCookieBase): void {
  jar.set(cookieName(base), "", clearedHostCookieOptions());
}
