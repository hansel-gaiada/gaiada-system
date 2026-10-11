// WSK-46 (owner ruling WSK-D52, docs/blueprints/webdesk-design-v2.md §14) — the ERP half of draft preview:
// where the preview page lives, whether it exists, and what the link looks like.
//
// A preview is an INSTANT page on the site itself (`<staging>/preview/`), which fetches the draft from
// WebDesk's public `GET /v1/t/:tenant/preview/:token` and renders it with the site's own components. The ERP
// mints the token (a MEDIUM editorial command, see `WebdeskContentService.previewItem`) and hands the editor a
// link. This file is the part of that which is not authorization and not Zone B:
//
//   * `stagingOriginOf(site)` — the staging base. NOT a second configuration: it is the SAME source the editor's
//     "View on staging" link uses (`platform-ui/src/lib/webdeskContent.ts#stagingBaseUrl`), the site's
//     `environments[]` entry named "staging" with a domain, as WebDesk reports it through `tenant.list`. The one
//     difference is hygiene: this side makes a request to it, so the domain must be a bare public hostname
//     (no scheme, port, path or userinfo, and not an IP literal), else it is treated as "not configured".
//   * `previewPageState(origin)` — does `<origin>/preview/` exist? A HEAD, from the server, cached 5 minutes. A
//     link to a page that is not there is a dead tab, so the BFF asks BEFORE it mints anything.
//   * `previewUrlFor(origin, token)` — `<origin>/preview/#t=<token>`. THE TOKEN IS IN THE FRAGMENT, never a query
//     string: a browser never sends a fragment to any server, never puts it in a Referer, and a proxy or an
//     access log never sees it. (The site's page reads `location.hash`, then calls the API itself.)
//
// ── WHAT THE HEAD ANSWER MEANS ───────────────────────────────────────────────────────────────────────
//   404 / 410                  → "missing": the site has no preview page (cached, 5 min)
//   2xx / 3xx                  → "present"  (cached, 5 min)
//   any other 4xx (401/403/405…) → "present": a refusal is not a 404, and a staging site behind basic auth or a
//                                  host that dislikes HEAD still has the page. We only claim "missing" for a 404.
//   5xx, a timeout, no answer  → "unknown": NOT cached. The caller refuses with 502 `preview_site_unreachable`
//                                  rather than mint a link that may open onto an error page.
//
// This file originates outbound HTTP and is listed in egress-inventory.test.ts.

const PAGE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;

/** A public DNS name: dot-separated labels, an alphabetic TLD. Rules out IP literals, `localhost`, and anything that
 *  is not a bare host (a scheme, a port, a path, userinfo, whitespace). */
const PUBLIC_HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export type PreviewPageState = "present" | "missing" | "unknown";

interface Deps {
  fetchImpl: typeof fetch | null;
  now: () => number;
}
const deps: Deps = { fetchImpl: null, now: Date.now };

/** origin → a DEFINITE answer and when it was learned. "unknown" is never stored. */
const pageCache = new Map<string, { at: number; state: "present" | "missing" }>();

/** Tests: replace the HTTP client and/or the clock (null restores), and drop the cache. */
export function setPreviewProbeForTests(o: { fetchImpl?: typeof fetch | null; now?: (() => number) | null } | null): void {
  deps.fetchImpl = o?.fetchImpl ?? null;
  deps.now = o?.now ?? Date.now;
  pageCache.clear();
}

/** The site's staging origin (`https://<domain>`), or null when it has no usable staging environment. The same
 *  rule as the editor's `stagingBaseUrl`: the first environment named "staging" (any case) that has a domain. */
export function stagingOriginOf(site: { environments: readonly unknown[] }): string | null {
  for (const e of site.environments) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    const env = e as Record<string, unknown>;
    if (typeof env.name !== "string" || env.name.toLowerCase() !== "staging") continue;
    if (typeof env.domain !== "string" || env.domain === "") continue;
    return PUBLIC_HOST_RE.test(env.domain) ? `https://${env.domain.toLowerCase()}` : null;
  }
  return null;
}

/** `<origin>/preview/#t=<token>`. The token is a fragment, so it never reaches a server, a log or a Referer. */
export function previewUrlFor(origin: string, token: string): string {
  return `${origin}/preview/#t=${encodeURIComponent(token)}`;
}

/** Does `<origin>/preview/` exist? Cached for 5 minutes (definite answers only). Never throws. */
export async function previewPageState(origin: string): Promise<PreviewPageState> {
  const hit = pageCache.get(origin);
  if (hit && deps.now() - hit.at < PAGE_TTL_MS) return hit.state;

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let status: number;
  try {
    const res = await doFetch(`${origin}/preview/`, { method: "HEAD", redirect: "manual", signal: controller.signal });
    status = res.status;
    await res.body?.cancel().catch(() => undefined);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }

  if (status >= 500) return "unknown";
  const state = status === 404 || status === 410 ? "missing" : "present";
  pageCache.set(origin, { at: deps.now(), state });
  return state;
}
