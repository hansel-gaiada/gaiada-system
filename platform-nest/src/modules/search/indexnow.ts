// M5-P5a — IndexNow: the protocol client and the pure rules around it. This file is an APPROVED EGRESS file
// (egress-inventory.test.ts, class "IndexNow"): it is the ONLY place in the module that talks to
//   (a) https://api.indexnow.org/indexnow   POST a batch of URLs of ONE site, with that site's key, and
//   (b) the property's OWN site, GET https://<host>/<key>.txt, to prove the key file is served before the
//       property may be enabled.
// Everything else in the IndexNow feature (indexnow-service.ts, the controller, the WebDesk resolver) is
// DB or pure code and reaches the network only through the functions below.
//
// DARK BY DEFAULT: SEARCH_INDEXNOW_ENABLED must be exactly "1". Unset, empty ("${SEARCH_INDEXNOW_ENABLED:-}"
// in compose), "true", "0" and anything else are OFF. With the flag off nothing in this feature opens a
// connection, reads a row or sends a byte (the service checks it first, before any DB access).
//
// THE KEY. IndexNow's key is public by protocol design (it is served in clear at /<key>.txt and travels in
// every request; it only proves control of the host), so it is stored in a plain column and is not a secret.
// 8 to 128 characters of [A-Za-z0-9-]; we generate 32 hex characters.
//
// WHAT A SUBMISSION IS. `{ host, key, keyLocation, urlList }`. The host and every URL come from the
// PROPERTY's own site_url (never from a caller), so a submission can only ever name pages of the site the key
// belongs to: there is no way to ping another site's URLs with this property's key. Batched (BATCH_SIZE per
// request; the protocol allows 10,000), sequential, with a rolling daily cap (service).
//
// RESPONSES. 200/202 = accepted (202: key validation pending on their side). 429, 408 and 5xx and any
// network failure are RETRYABLE (backoff, Retry-After honoured). 400/403/422 and other 4xx are REJECTED: a
// retry cannot fix a malformed request, an invalid key or URLs that do not belong to the host. The response
// body is never read into an error or a log line; the typed token is `http_<status>` / `network` / `timeout`.
//
// SSRF FLOOR for the key-file fetch (the one request whose target a staff user influences through site_url):
// https only, no port, a public-looking DNS name (not an IP literal, not localhost / single-label / private
// suffix), and every address the name resolves to must pass `isDeniedAddress`. Redirects are NOT followed (a
// redirect is reported, never chased). This is an accident guard, not a perfect wall: the lookup is made
// before the fetch, so a DNS-rebind between the two is not defeated (same stated limit as
// google/endpoint-guard.ts). The request carries no credentials and the body read is size-capped.
import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { checkPrivateVendorBaseUrl } from "../../search-vendor-baseurl-guard";
import { isDeniedAddress } from "../monitoring/drivers/egress";
// A pure helper from the vocabulary: no I/O, no dependency back on search (so no import cycle).
import { pagePathFor, routePatternProblem } from "../webdev/vocabulary/composition";

export type FetchImpl = typeof fetch;

export const INDEXNOW_ENABLED_ENV = "SEARCH_INDEXNOW_ENABLED";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** URLs per request. The protocol allows 10,000; a smaller batch keeps one failure cheap to retry. */
export const INDEXNOW_BATCH_SIZE = 500;
/** Retries before a row is `gave_up`. */
export const INDEXNOW_MAX_ATTEMPTS = 6;
/** Per request timeout. */
export const INDEXNOW_TIMEOUT_MS = 10_000;
/** The key file is a key; anything larger is not one. */
const KEY_FILE_MAX_BYTES = 1024;
export const MAX_URL_LENGTH = 2048;

/** ON only for the exact string "1". */
export function isIndexNowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INDEXNOW_ENABLED_ENV] === "1";
}

// ── the key ──────────────────────────────────────────────────────────────────────────────────────

const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;
export const isValidIndexNowKey = (k: unknown): k is string => typeof k === "string" && KEY_RE.test(k);
/** 32 hex characters from a CSPRNG. */
export const generateIndexNowKey = (): string => randomBytes(16).toString("hex");
export const keyFileName = (key: string): string => `${key}.txt`;
/** The exact body of the key file: the key. */
export const keyFileBody = (key: string): string => key;

// ── origins and URLs ─────────────────────────────────────────────────────────────────────────────

/** `https://host` (or `http://host`) of a site_url, or null for anything that is not a plain http(s) origin
 *  (userinfo is refused; path, query and fragment are dropped). */
export function siteOriginOf(siteUrl: unknown): string | null {
  if (typeof siteUrl !== "string") return null;
  let u: URL;
  try { u = new URL(siteUrl.trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || !u.hostname) return null;
  return `${u.protocol}//${u.host}`;
}

export const hostOfOrigin = (origin: string): string => new URL(origin).host;

export type PageSkipReason = "no_route_pattern" | "bad_route_pattern" | "slug_not_routable" | "locale_not_routable";

/** What a content change tells us about one item. `routePattern` is the collection's `ui.routePattern`. */
export interface ChangedItem {
  slug: string;
  locale: string;
  defaultLocale: string;
  routePattern: unknown;
  /** The collection is localized (default true): a non-default language needs `{locale}` in the pattern. */
  localized?: boolean;
  /** The version that went live / came down; part of the idempotency key. */
  version?: number | null;
}

/** item -> public page path, or why it has none. Same rules as the writer dashboard's `resolvePagePath`
 *  (kept in step by hand: that file imports search, so search cannot import it back). */
export function pagePathOf(item: ChangedItem): { path: string } | { reason: PageSkipReason } {
  const pattern = item.routePattern;
  if (pattern === undefined || pattern === null || pattern === "") return { reason: "no_route_pattern" };
  if (routePatternProblem(pattern) !== null) return { reason: "bad_route_pattern" };
  const hasLocale = /(^|\/)\{locale\}(\/|$)/.test(pattern as string);
  if (item.localized !== false && item.locale !== item.defaultLocale && !hasLocale) return { reason: "locale_not_routable" };
  const path = pagePathFor(pattern, { slug: item.slug, locale: item.locale, defaultLocale: item.defaultLocale });
  if (path !== null) return { path };
  return pagePathFor(pattern, { slug: "x", locale: item.locale, defaultLocale: item.defaultLocale }) === null
    ? { reason: "locale_not_routable" }
    : { reason: "slug_not_routable" };
}

export interface BuiltUrls {
  /** Absolute, de-duplicated, in input order. `itemIndex` is the first item that produced it. */
  urls: Array<{ url: string; itemIndex: number; version: number | null }>;
  skipped: Array<{ itemIndex: number; reason: PageSkipReason }>;
}

/** The affected page URLs of a content change: `origin` + the item's page path. An item with no route
 *  pattern (or one that cannot be applied) is skipped WITH a reason, never guessed. */
export function buildPageUrls(origin: string, items: readonly ChangedItem[]): BuiltUrls {
  const out: BuiltUrls = { urls: [], skipped: [] };
  const seen = new Set<string>();
  items.forEach((item, itemIndex) => {
    const p = pagePathOf(item);
    if ("reason" in p) { out.skipped.push({ itemIndex, reason: p.reason }); return; }
    const url = origin + p.path;
    if (url.length > MAX_URL_LENGTH) { out.skipped.push({ itemIndex, reason: "slug_not_routable" }); return; }
    if (seen.has(url)) return;
    seen.add(url);
    out.urls.push({ url, itemIndex, version: item.version ?? null });
  });
  return out;
}

export type SubmitUrlRejection = "not_a_url" | "wrong_host" | "too_long" | "bad_scheme";

/** Manual submit: each input is a path ("/blog/x/") or an absolute URL whose origin IS the property's. A
 *  fragment is dropped. Returns what to send and what was refused (and why), never throws. */
export function normalizeSubmitUrls(origin: string, inputs: readonly unknown[]): { urls: string[]; rejected: Array<{ index: number; reason: SubmitUrlRejection }> } {
  const urls: string[] = [];
  const rejected: Array<{ index: number; reason: SubmitUrlRejection }> = [];
  const seen = new Set<string>();
  inputs.forEach((raw, index) => {
    if (typeof raw !== "string" || raw.trim() === "") { rejected.push({ index, reason: "not_a_url" }); return; }
    const s = raw.trim();
    let u: URL;
    try { u = s.startsWith("/") && !s.startsWith("//") ? new URL(s, origin) : new URL(s); } catch { rejected.push({ index, reason: "not_a_url" }); return; }
    if (u.protocol !== "https:" && u.protocol !== "http:") { rejected.push({ index, reason: "bad_scheme" }); return; }
    if (`${u.protocol}//${u.host}` !== origin) { rejected.push({ index, reason: "wrong_host" }); return; }
    u.hash = "";
    const url = u.toString();
    if (url.length > MAX_URL_LENGTH) { rejected.push({ index, reason: "too_long" }); return; }
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  });
  return { urls, rejected };
}

export const hashUrl = (url: string): string => createHash("sha256").update(url).digest("hex");

/** The idempotency `version` of one submission: `<transition>:v<N>:<event ref>`. The event ref is whatever
 *  names the event stably (an approval id, a Zone B event id); with none, `-`. */
export function versionTag(transition: "publish" | "unpublish" | "manual", version: number | null | undefined, ref: string | null | undefined): string {
  return `${transition}:v${version ?? 0}:${ref && ref.trim() !== "" ? ref.trim() : "-"}`.slice(0, 128);
}

export function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** 60s, 120s, 240s ... capped at 6h. `attempts` is the number of attempts ALREADY made (>= 1). The service applies the same schedule
 *  in SQL (indexnow-service.ts finishRows: 60000 * 2^attempts, cap 21600000 ms) from each row's own attempt count; this is the
 *  reference the unit test pins. */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(60_000 * 2 ** (n - 1), 6 * 3600_000);
}

// ── the request ──────────────────────────────────────────────────────────────────────────────────

export function buildIndexNowBody(a: { host: string; key: string; keyLocation: string; urls: readonly string[] }): { host: string; key: string; keyLocation: string; urlList: string[] } {
  return { host: a.host, key: a.key, keyLocation: a.keyLocation, urlList: [...a.urls] };
}

export type PingOutcome =
  | { outcome: "sent"; httpStatus: number }
  | { outcome: "retry"; httpStatus: number | null; errorCode: string; retryAfterMs: number | null }
  | { outcome: "rejected"; httpStatus: number; errorCode: string };

function retryAfterOf(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 24 * 3600_000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 24 * 3600_000) : null;
}

/** One POST. Never throws; the outcome says what to do with the rows. */
export async function pingIndexNow(
  a: { origin: string; key: string; urls: readonly string[] },
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<PingOutcome> {
  const body = buildIndexNowBody({ host: hostOfOrigin(a.origin), key: a.key, keyLocation: `${a.origin}/${keyFileName(a.key)}`, urls: a.urls });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? INDEXNOW_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", accept: "*/*", "user-agent": "Gaiada-ERP-IndexNow/1" },
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: "manual",
    });
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return { outcome: "retry", httpStatus: null, errorCode: aborted ? "timeout" : "network", retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
  const s = res.status;
  if (s === 200 || s === 202) return { outcome: "sent", httpStatus: s };
  if (s === 429 || s === 408 || s >= 500) return { outcome: "retry", httpStatus: s, errorCode: `http_${s}`, retryAfterMs: retryAfterOf(res) };
  return { outcome: "rejected", httpStatus: s, errorCode: `http_${s}` };
}

// ── the key-file proof ───────────────────────────────────────────────────────────────────────────

export type KeyFileRefusal =
  | "site_url_not_https" | "host_not_public" | "host_unresolvable" | "unreachable" | "timeout" | "redirected"
  | "not_found" | "bad_status" | "too_large" | "key_mismatch";

export type KeyFileResult = { ok: true } | { ok: false; reason: KeyFileRefusal; httpStatus?: number };

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address);

/** Lexical + resolved public-host check for the site we are about to fetch from. */
export async function assertPublicHttpsOrigin(origin: string, resolve: Resolver = defaultResolver): Promise<KeyFileRefusal | null> {
  let u: URL;
  try { u = new URL(origin); } catch { return "host_not_public"; }
  if (u.protocol !== "https:") return "site_url_not_https";
  if (u.port !== "") return "host_not_public";
  if (checkPrivateVendorBaseUrl(origin).isPrivate) return "host_not_public";
  if (/^\d+(\.\d+){3}$/.test(u.hostname) || u.hostname.includes(":")) return "host_not_public"; // an IP literal is not a site
  let addrs: string[];
  try { addrs = await resolve(u.hostname); } catch { return "host_unresolvable"; }
  if (addrs.length === 0) return "host_unresolvable";
  if (addrs.some((a) => isDeniedAddress(a))) return "host_not_public";
  return null;
}

/** Fetch https://<host>/<key>.txt and require its body (trimmed) to equal the key. */
export async function verifyKeyFile(
  a: { origin: string; key: string },
  opts: { fetchImpl?: FetchImpl; resolve?: Resolver; timeoutMs?: number } = {},
): Promise<KeyFileResult> {
  const refused = await assertPublicHttpsOrigin(a.origin, opts.resolve);
  if (refused) return { ok: false, reason: refused };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? INDEXNOW_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(`${a.origin}/${keyFileName(a.key)}`, {
        method: "GET",
        headers: { accept: "text/plain,*/*", "user-agent": "Gaiada-ERP-IndexNow/1" },
        signal: ctl.signal,
        redirect: "manual",
      });
    } catch (e) {
      return { ok: false, reason: (e as { name?: string })?.name === "AbortError" ? "timeout" : "unreachable" };
    }
    if (res.status >= 300 && res.status < 400) return { ok: false, reason: "redirected", httpStatus: res.status };
    if (res.status === 404 || res.status === 410) return { ok: false, reason: "not_found", httpStatus: res.status };
    if (res.status !== 200) return { ok: false, reason: "bad_status", httpStatus: res.status };
    const len = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > KEY_FILE_MAX_BYTES) return { ok: false, reason: "too_large" };
    const text = await res.text();
    if (text.length > KEY_FILE_MAX_BYTES) return { ok: false, reason: "too_large" };
    return text.trim() === a.key ? { ok: true } : { ok: false, reason: "key_mismatch" };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
