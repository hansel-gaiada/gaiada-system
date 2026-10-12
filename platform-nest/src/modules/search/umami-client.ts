// M5-A4 — the server-side Umami READ client (WSK-D66). The ONLY file in this module that talks to Umami,
// and the FOURTH approved egress class (egress-inventory.test.ts): the ERP's own web-analytics store,
// reached over WireGuard through a GET-only gate (infra/sumopod/umami, runbook umami-sumopod.md) with a
// team view-only user's API key. It sends nothing but GETs and never writes.
//
// Env (read per call, so a rotated key or a test override takes effect without a restart):
//   UMAMI_BASE_URL  e.g. http://10.88.0.2:18743   UMAMI_API_KEY  the `umami_...` key, sent as Bearer
//   UMAMI_TIMEOUT_MS (optional, default 10000)
// Either of the first two unset => UmamiNotConfiguredError, which callers turn into the plain-words
// "not configured" state (an empty list would be a claim, so we never return one).
//
// Umami v3 read API used (Umami 3.4.0 source, read 2026-10-11):
//   GET /api/websites/:id/stats?startAt&endAt            -> { pageviews, visitors, visits, bounces, totaltime, comparison }
//       (src/app/api/websites/[websiteId]/stats/route.ts, src/queries/sql/getWebsiteStats.ts)
//   GET /api/websites/:id/metrics?type=&startAt&endAt&limit -> [{ x, y }]; type in EVENT_COLUMNS
//       (path, referrer, event, ...) (metrics/route.ts, getPageviewMetrics.ts, lib/constants.ts)
//   GET /api/websites/:id/event-data/values?eventName&propertyName&startAt&endAt -> [{ value, total }]
//       (event-data/values/route.ts, queries/sql/events/getEventDataValues.ts; limit 100, total desc)
// The key is never logged and never placed in an error message.
export type FetchImpl = typeof fetch;

export class UmamiError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "UmamiError";
    this.kind = kind;
  }
}
/** UMAMI_BASE_URL or UMAMI_API_KEY is unset/invalid. */
export class UmamiNotConfiguredError extends UmamiError {
  constructor() { super("not_configured", "Umami is not configured (UMAMI_BASE_URL / UMAMI_API_KEY)"); }
}
/** Network failure, timeout or a 5xx from the gate or Umami. */
export class UmamiUnreachableError extends UmamiError {
  constructor(detail: string) { super("unreachable", `Umami unreachable: ${detail}`); }
}
/** 401/403: the key is wrong, revoked, or the user may not see this website. */
export class UmamiAuthError extends UmamiError {
  readonly status: number;
  constructor(status: number) { super("rejected", `Umami refused the credential (HTTP ${status})`); this.status = status; }
}
/** 404: the website id is not known to Umami (or not visible to this user). */
export class UmamiNotFoundError extends UmamiError {
  constructor() { super("not_found", "Umami website not found"); }
}
/** Any other unexpected status, or a body that is not the JSON we expect. */
export class UmamiBadResponseError extends UmamiError {
  constructor(detail: string) { super("bad_response", `Umami returned an unexpected response: ${detail}`); }
}

export interface UmamiSettings { baseUrl: string; apiKey: string; timeoutMs: number }

export function umamiSettings(env: NodeJS.ProcessEnv = process.env): UmamiSettings | null {
  const baseUrl = (env.UMAMI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (env.UMAMI_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey || !/^https?:\/\//i.test(baseUrl)) return null;
  const t = Number(env.UMAMI_TIMEOUT_MS ?? 10000);
  return { baseUrl, apiKey, timeoutMs: Number.isFinite(t) && t > 0 ? t : 10000 };
}

const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UmamiGetOpts {
  settings?: UmamiSettings | null; // tests; default = from env
  fetchImpl?: FetchImpl;
}

/** One GET against /api/websites/:siteId/<sub>. Returns parsed JSON; throws a typed UmamiError. */
export async function umamiGet(
  siteId: string, sub: string, query: Record<string, string | number | undefined>, opts: UmamiGetOpts = {},
): Promise<unknown> {
  const s = opts.settings === undefined ? umamiSettings() : opts.settings;
  if (!s) throw new UmamiNotConfiguredError();
  if (!SITE_ID_RE.test(siteId)) throw new UmamiBadResponseError("website id is not a UUID");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
  const url = `${s.baseUrl}/api/websites/${siteId}/${sub}?${qs.toString()}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), s.timeoutMs);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${s.apiKey}`, Accept: "application/json" },
      signal: ctl.signal,
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new UmamiUnreachableError(name === "AbortError" ? `timed out after ${s.timeoutMs}ms` : "connection failed");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new UmamiAuthError(res.status);
  if (res.status === 404) throw new UmamiNotFoundError();
  if (res.status >= 500) throw new UmamiUnreachableError(`HTTP ${res.status}`);
  if (!res.ok) throw new UmamiBadResponseError(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new UmamiBadResponseError("body is not JSON");
  }
}
