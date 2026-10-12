// M5-P5a — the Bing Webmaster API client. An APPROVED EGRESS file (egress-inventory.test.ts, class "Bing
// Webmaster"): the only place in the module that talks to https://ssl.bing.com/webmaster/api.svc/json/.
// Client-private, $0 per call, per-client credential (the property's connection key): the same class as the
// Google surfaces — it never registers as a SearchDataProvider, never touches search_data_cache, never writes a
// ledger row.
//
// MODE. SEARCH_BING_MODE decides whether this client is ever used: exactly "live" = real calls; anything else
// (unset, empty, "simulate", junk) = SIMULATE, and bing-service.ts then synthesises rows and never calls this
// file at all. So the default deployment makes no Bing request.
//
// THE KEY. The Webmaster API key authenticates as a query parameter (`?apikey=`), which makes it easy to leak
// through a URL in a log or an error. Nothing here builds an error message from the URL or the response body:
// failures are typed tokens only. The key is passed in per call (read from the vault by the caller) and is
// never stored on an object that outlives the call.
//
// UNVERIFIED AGAINST A REAL ACCOUNT (no Bing Webmaster account was available to drive this). The endpoint and
// field names below are from Microsoft's published API reference: GetUserSites, GetQueryStats, GetPageStats,
// GetUrlSubmissionQuota (GET) and SubmitUrlBatch (POST), JSON wrapped as `{ "d": ... }`, dates as
// "/Date(<ms>)/". Every parser is defensive and returns null/skips on a shape it does not recognise rather than
// guessing; the first live pull is the real test and is listed as a follow-up.
export type FetchImpl = typeof fetch;

export const BING_MODE_ENV = "SEARCH_BING_MODE";
export const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
export const BING_TIMEOUT_MS = 15_000;
/** Rows kept per call; the stats endpoints return up to ~6 months of daily rows. */
export const BING_MAX_ROWS = 20_000;

/** "live" only for the exact string "live". */
export function bingMode(env: NodeJS.ProcessEnv = process.env): "live" | "simulate" {
  return env[BING_MODE_ENV] === "live" ? "live" : "simulate";
}

export class BingError extends Error {
  readonly kind: "unreachable" | "rejected" | "bad_response";
  readonly httpStatus: number | null;
  constructor(kind: BingError["kind"], httpStatus: number | null = null) {
    super(`Bing Webmaster ${kind}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
    this.name = "BingError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

export interface BingCallOpts { fetchImpl?: FetchImpl; timeoutMs?: number }

async function call(method: string, apiKey: string, init: { query?: Record<string, string>; body?: unknown }, opts: BingCallOpts): Promise<unknown> {
  const qs = new URLSearchParams({ apikey: apiKey, ...(init.query ?? {}) });
  const url = `${BING_API_BASE}/${method}?${qs.toString()}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? BING_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: ctl.signal,
      redirect: "manual",
    });
  } catch {
    throw new BingError("unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new BingError("rejected", res.status);
  if (res.status === 429 || res.status >= 500) throw new BingError("unreachable", res.status);
  if (!res.ok) throw new BingError("rejected", res.status);
  try {
    return await res.json();
  } catch {
    throw new BingError("bad_response", res.status);
  }
}

const dOf = (body: unknown): unknown => (body !== null && typeof body === "object" ? (body as { d?: unknown }).d : undefined);

// ── parsers (pure) ───────────────────────────────────────────────────────────────────────────────

/** "/Date(1696118400000)/" or "/Date(1696118400000-0700)/" -> "YYYY-MM-DD" (UTC), else null. */
export function parseBingDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\/Date\((-?\d{1,15})(?:[+-]\d{4})?\)\/$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

export interface BingStatRow {
  date: string;
  kind: "query" | "page";
  key: string;
  clicks: number;
  impressions: number;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
}

const nonNegInt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const posOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);

function parseStats(body: unknown, kind: "query" | "page"): BingStatRow[] {
  const rows = dOf(body);
  if (!Array.isArray(rows)) return [];
  const out: BingStatRow[] = [];
  for (const r of rows.slice(0, BING_MAX_ROWS)) {
    if (r === null || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    // GetQueryStats rows carry `Query`; GetPageStats rows carry `Query` too, holding the page URL.
    const key = typeof o.Query === "string" ? o.Query.trim() : "";
    const date = parseBingDate(o.Date);
    const clicks = nonNegInt(o.Clicks);
    const impressions = nonNegInt(o.Impressions);
    if (!key || key.length > 2048 || !date || clicks === null || impressions === null) continue;
    out.push({ date, kind, key, clicks, impressions, avgClickPosition: posOrNull(o.AvgClickPosition), avgImpressionPosition: posOrNull(o.AvgImpressionPosition) });
  }
  return out;
}
export const parseQueryStats = (body: unknown): BingStatRow[] => parseStats(body, "query");
export const parsePageStats = (body: unknown): BingStatRow[] => parseStats(body, "page");

export interface BingSite { url: string; verified: boolean }
export function parseUserSites(body: unknown): BingSite[] {
  const rows = dOf(body);
  if (!Array.isArray(rows)) return [];
  const out: BingSite[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.Url === "string") out.push({ url: o.Url, verified: o.IsVerified === true });
  }
  return out;
}

export interface BingQuota { daily: number; monthly: number }
export function parseQuota(body: unknown): BingQuota | null {
  const d = dOf(body);
  if (d === null || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const daily = nonNegInt(o.DailyQuota);
  const monthly = nonNegInt(o.MonthlyQuota);
  return daily === null ? null : { daily, monthly: monthly ?? daily };
}

// ── calls ────────────────────────────────────────────────────────────────────────────────────────

export async function getUserSites(apiKey: string, opts: BingCallOpts = {}): Promise<BingSite[]> {
  return parseUserSites(await call("GetUserSites", apiKey, {}, opts));
}
export async function getQueryStats(apiKey: string, siteUrl: string, opts: BingCallOpts = {}): Promise<BingStatRow[]> {
  return parseQueryStats(await call("GetQueryStats", apiKey, { query: { siteUrl } }, opts));
}
export async function getPageStats(apiKey: string, siteUrl: string, opts: BingCallOpts = {}): Promise<BingStatRow[]> {
  return parsePageStats(await call("GetPageStats", apiKey, { query: { siteUrl } }, opts));
}
export async function getUrlSubmissionQuota(apiKey: string, siteUrl: string, opts: BingCallOpts = {}): Promise<BingQuota | null> {
  return parseQuota(await call("GetUrlSubmissionQuota", apiKey, { query: { siteUrl } }, opts));
}
/** Bing's URL Submission API: the non-IndexNow route. Up to 500 URLs per batch (their documented cap). */
export async function submitUrlBatch(apiKey: string, siteUrl: string, urls: readonly string[], opts: BingCallOpts = {}): Promise<void> {
  await call("SubmitUrlBatch", apiKey, { body: { siteUrl, urlList: [...urls] } }, opts);
}
export const BING_SUBMIT_BATCH_SIZE = 500;
