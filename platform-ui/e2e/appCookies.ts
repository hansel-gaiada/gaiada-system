import type { BrowserContext } from "@playwright/test";

type AddableCookie = Parameters<BrowserContext["addCookies"]>[0][number];

/**
 * The tenant-context cookie, named the way the app under test names it (src/lib/cookieNames.ts, ERP names
 * Phase B0). Under `next start` (CI=1, so NODE_ENV=production) the app reads `__Host-gaiada_tenant`; under
 * `next dev` the plain `gaiada_tenant`. A spec that planted the plain name against `next start` silently lost
 * its company context.
 *
 * A `__Host-` cookie must be Secure, Path=/ and host-only. Chromium keeps a Secure cookie on http://localhost,
 * but Playwright's `addCookies` refuses `secure: true` together with an http `url` ("Invalid cookie fields"),
 * so the prefixed form uses `domain` + `path` (host-only for a bare host name). Verified on the Playwright
 * 1.62.1 image, 2026-10-11.
 */
export function tenantCookie(at: string, value = "co-agency"): AddableCookie {
  const u = new URL(at);
  if (!process.env.CI) return { name: "gaiada_tenant", value, url: new URL("/", u).toString() };
  return { name: "__Host-gaiada_tenant", value, domain: u.hostname, path: "/", secure: true, sameSite: "Lax" };
}

/**
 * A person who CHOSE the classic layout (avatar menu "Back to the classic layout"): `gaiada_prefs` with
 * `shellChosen`, the flag that makes a stored `shell` count (src/lib/prefs.ts). Since DW-9d-1 the workspace shell
 * is the default, so a spec that tests a classic-shell element (the classic sidebar, its floating assistant
 * button) plants this. Classic until DW-9d-2 removes it.
 */
export function classicLayoutCookie(at: string): AddableCookie {
  return { name: "gaiada_prefs", value: encodeURIComponent(JSON.stringify({ shell: "classic", shellChosen: true })), url: new URL("/", at).toString() };
}
