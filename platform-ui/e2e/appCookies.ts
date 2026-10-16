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
