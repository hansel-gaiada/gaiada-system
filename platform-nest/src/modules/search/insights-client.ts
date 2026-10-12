// M5-V3-e — the client for the insights collector's ops API (design 2026-10-12 §4.4; collector side is V3-b). The
// ONLY file in this module that talks to the collector, and the SEVENTH approved egress class
// (egress-inventory.test.ts): the ERP's own consented-event buffer on sumopod, reached over WireGuard through the
// `read-gate` (`/ops/v1/*` -> collector:8081). Two calls and nothing else:
//   GET  /ops/v1/events?website&after&limit   read key    -> {events:[...], next}   (next = last id returned, or `after`)
//        The collector only returns rows older than 15 s (a bigserial can commit after a larger one) and pages by id.
//   POST /ops/v1/forget                       forget key  {website, visitorIds<=100, consentIds<=100, mode} -> counts
//        Delete-only, idempotent; the read key gets 403 there (O1/D6: the ERP's one narrow write to sumopod).
//        -> {website, mode, deleted:{events}, tombstoned:{visitors, consents}}; an empty id list is a 400, so never sent.
// Contract checked against the collector on branch m5/v3b (insights-collector/internal/ops/events.go).
// Both keys are sent as `Authorization: Bearer <key>` (the collector compares SHA-256 in constant time).
//
// Env (read per call, so a rotated key or a test override applies without a restart):
//   INSIGHTS_BASE_URL     e.g. http://10.88.0.2:18743      INSIGHTS_READ_KEY    the read key
//   INSIGHTS_FORGET_KEY   the forget key                    SEARCH_VISITORS_TIMEOUT_MS  optional, default 10000
// Any of the first three unset (or blank) => InsightsNotConfiguredError; an empty / 0 / junk timeout => the default.
// The keys are never logged and never placed in an error message; nor is a visitor or consent id.
export type FetchImpl = typeof fetch;

export type InsightsErrorKind = "not_configured" | "unreachable" | "rejected" | "not_found" | "bad_response";

export class InsightsError extends Error {
  readonly kind: InsightsErrorKind;
  constructor(kind: InsightsErrorKind, message: string) {
    super(message);
    this.name = "InsightsError";
    this.kind = kind;
  }
}
/** INSIGHTS_BASE_URL, INSIGHTS_READ_KEY or INSIGHTS_FORGET_KEY is unset or invalid. */
export class InsightsNotConfiguredError extends InsightsError {
  constructor() { super("not_configured", "the insights collector is not configured (INSIGHTS_BASE_URL / INSIGHTS_READ_KEY / INSIGHTS_FORGET_KEY)"); }
}
/** Network failure, timeout, or a 5xx from the gate or the collector. */
export class InsightsUnreachableError extends InsightsError {
  constructor(detail: string) { super("unreachable", `insights collector unreachable: ${detail}`); }
}
/** 401/403: a wrong or revoked key (or the read key on forget). */
export class InsightsAuthError extends InsightsError {
  readonly status: number;
  constructor(status: number) { super("rejected", `insights collector refused the credential (HTTP ${status})`); this.status = status; }
}
/** 404: the route or the website is unknown to the collector. */
export class InsightsNotFoundError extends InsightsError {
  constructor() { super("not_found", "insights collector: website or route not found"); }
}
/** Any other status, or a body that is not the shape the contract promises. */
export class InsightsBadResponseError extends InsightsError {
  constructor(detail: string) { super("bad_response", `insights collector returned an unexpected response: ${detail}`); }
}

export interface InsightsSettings { baseUrl: string; readKey: string; forgetKey: string; timeoutMs: number }

const DEFAULT_TIMEOUT_MS = 10000;

export function insightsSettings(env: NodeJS.ProcessEnv = process.env): InsightsSettings | null {
  const baseUrl = (env.INSIGHTS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const readKey = (env.INSIGHTS_READ_KEY ?? "").trim();
  const forgetKey = (env.INSIGHTS_FORGET_KEY ?? "").trim();
  if (!baseUrl || !readKey || !forgetKey || !/^https?:\/\//i.test(baseUrl)) return null;
  const raw = (env.SEARCH_VISITORS_TIMEOUT_MS ?? "").trim();
  const t = raw === "" ? DEFAULT_TIMEOUT_MS : Number(raw);
  return { baseUrl, readKey, forgetKey, timeoutMs: Number.isFinite(t) && t > 0 ? Math.floor(t) : DEFAULT_TIMEOUT_MS };
}

export interface InsightsOpts {
  settings?: InsightsSettings | null; // tests; default = from env
  fetchImpl?: FetchImpl;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENTS_PAGE_MAX = 1000;
export const FORGET_BATCH_MAX = 100;

async function call(
  s: InsightsSettings, method: "GET" | "POST", path: string, key: string, body: unknown, opts: InsightsOpts,
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), s.timeoutMs);
  let res: Response;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    res = await (opts.fetchImpl ?? fetch)(`${s.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      redirect: "manual",
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new InsightsUnreachableError(name === "AbortError" ? `timed out after ${s.timeoutMs}ms` : "connection failed");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new InsightsAuthError(res.status);
  if (res.status === 404) throw new InsightsNotFoundError();
  if (res.status >= 500) throw new InsightsUnreachableError(`HTTP ${res.status}`);
  if (res.status < 200 || res.status >= 300) throw new InsightsBadResponseError(`HTTP ${res.status}`);
  if (res.status === 204) return {};
  try {
    return await res.json();
  } catch {
    throw new InsightsBadResponseError("body is not JSON");
  }
}

// ── events ───────────────────────────────────────────────────────────────────────────────────────

export interface CollectorEvent {
  /** The collector's bigserial id (the cursor and the ERP's dedupe key). */
  id: number;
  visitorId: string; // lower-case uuid
  consentId: string; // lower-case uuid
  receivedAt: string;
  occurredAt: string;
  kind: "pageview" | "event";
  path: string | null;
  name: string | null;
  data: Record<string, unknown> | null;
  device: string | null;
  geo: { country: string | null; city: string | null } | null;
  network: { asn: number | null; name: string | null } | null;
  company: Record<string, unknown> | null;
}

export interface EventsPage {
  events: CollectorEvent[];
  /** The cursor to ask from next time (the collector's `next`, else the largest id seen, else null). */
  next: number | null;
  /** Rows dropped because their ids or kind were malformed (they still move the cursor). */
  malformed: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function toId(v: unknown, allowZero = false): number | null {
  const n = typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && (n > 0 || (allowZero && n === 0)) ? n : null;
}

/** One row of `/ops/v1/events`, or null when it cannot be attributed (no valid id, uuids or kind). */
export function parseCollectorEvent(raw: unknown): CollectorEvent | null {
  if (!isObj(raw)) return null;
  const id = toId(raw.id);
  const visitorId = typeof raw.visitorId === "string" && UUID_RE.test(raw.visitorId) ? raw.visitorId.toLowerCase() : null;
  const consentId = typeof raw.consentId === "string" && UUID_RE.test(raw.consentId) ? raw.consentId.toLowerCase() : null;
  const kind = raw.kind === "pageview" || raw.kind === "event" ? raw.kind : null;
  if (id === null || !visitorId || !consentId || !kind) return null;
  const geo = isObj(raw.geo) ? { country: str(raw.geo.country), city: str(raw.geo.city) } : null;
  const network = isObj(raw.network)
    ? { asn: typeof raw.network.asn === "number" && Number.isSafeInteger(raw.network.asn) ? raw.network.asn : null, name: str(raw.network.name) }
    : null;
  return {
    id, visitorId, consentId, kind,
    receivedAt: str(raw.receivedAt) ?? "",
    occurredAt: str(raw.occurredAt) ?? "",
    path: str(raw.path),
    name: str(raw.name),
    data: isObj(raw.data) ? raw.data : null,
    device: str(raw.device),
    geo, network,
    company: isObj(raw.company) ? raw.company : null,
  };
}

/** One page of consented events after `after` (exclusive). Throws a typed InsightsError. */
export async function readEventsPage(website: string, after: number, limit: number, opts: InsightsOpts = {}): Promise<EventsPage> {
  const s = opts.settings === undefined ? insightsSettings() : opts.settings;
  if (!s) throw new InsightsNotConfiguredError();
  if (!UUID_RE.test(website)) throw new InsightsBadResponseError("website id is not a UUID");
  website = website.toLowerCase();
  const lim = Math.max(1, Math.min(EVENTS_PAGE_MAX, Math.floor(limit)));
  const qs = new URLSearchParams({ website, after: String(Math.max(0, Math.floor(after))), limit: String(lim) });
  const body = await call(s, "GET", `/ops/v1/events?${qs.toString()}`, s.readKey, undefined, opts);
  if (!isObj(body) || !Array.isArray(body.events)) throw new InsightsBadResponseError("no events array");
  if (body.events.length > lim) throw new InsightsBadResponseError("more events than the limit");
  const events: CollectorEvent[] = [];
  let malformed = 0;
  let maxId = 0;
  for (const raw of body.events) {
    const rawId = isObj(raw) ? toId(raw.id) : null;
    if (rawId !== null && rawId > maxId) maxId = rawId;
    const e = parseCollectorEvent(raw);
    if (e) events.push(e);
    else malformed++;
  }
  let next: number | null = null;
  if (body.next !== null && body.next !== undefined) {
    next = toId(body.next, true); // the collector answers `next = after` when there is no row, so 0 is legal
    if (next === null) throw new InsightsBadResponseError("next is not a non-negative integer");
  } else if (maxId > 0) {
    next = maxId;
  }
  if (next !== null && next < Math.max(0, after)) throw new InsightsBadResponseError("next is behind the cursor");
  if (next !== null && maxId > next) throw new InsightsBadResponseError("next is behind the page");
  return { events, next, malformed };
}

// ── bots (M5-V3-g: the Visitors status line and, later, the Analytics figure) ─────────────────────────────────────

export interface BotCounts { from: string; to: string; total: number; byReason: Record<string, number> }

/** GET /ops/v1/bots?website&from&to (read key): daily counts by reason, summed. Counts only, no visitor data. Typed InsightsError. */
export async function readBotCounts(website: string, range: { from?: string; to?: string } = {}, opts: InsightsOpts = {}): Promise<BotCounts> {
  const s = opts.settings === undefined ? insightsSettings() : opts.settings;
  if (!s) throw new InsightsNotConfiguredError();
  if (!UUID_RE.test(website)) throw new InsightsBadResponseError("website id is not a UUID");
  const qs = new URLSearchParams({ website: website.toLowerCase() });
  if (range.from) qs.set("from", range.from);
  if (range.to) qs.set("to", range.to);
  const body = await call(s, "GET", `/ops/v1/bots?${qs.toString()}`, s.readKey, undefined, opts);
  if (!isObj(body) || !Array.isArray(body.days)) throw new InsightsBadResponseError("no days array");
  const byReason: Record<string, number> = {};
  let total = 0;
  for (const d of body.days) {
    if (!isObj(d) || typeof d.reason !== "string" || typeof d.count !== "number" || !Number.isFinite(d.count) || d.count < 0) {
      throw new InsightsBadResponseError("a bot row is malformed");
    }
    byReason[d.reason] = (byReason[d.reason] ?? 0) + d.count;
    total += d.count;
  }
  return { from: String(body.from ?? ""), to: String(body.to ?? ""), total, byReason };
}

// ── forget ───────────────────────────────────────────────────────────────────────────────────────

export type ForgetMode = "withdraw" | "erase";

export interface ForgetResult { calls: number; deleted: Record<string, number> }

/** Delete-only. Splits the lists into calls of <= 100 ids each; idempotent, so a retry after a failure is safe. */
export async function forgetAtCollector(
  website: string, ids: { visitorIds: readonly string[]; consentIds: readonly string[] }, mode: ForgetMode, opts: InsightsOpts = {},
): Promise<ForgetResult> {
  const s = opts.settings === undefined ? insightsSettings() : opts.settings;
  if (!s) throw new InsightsNotConfiguredError();
  if (!UUID_RE.test(website)) throw new InsightsBadResponseError("website id is not a UUID");
  website = website.toLowerCase();
  const clean = (xs: readonly string[]) => [...new Set(xs.filter((x) => UUID_RE.test(x)).map((x) => x.toLowerCase()))];
  const visitors = clean(ids.visitorIds);
  const consents = clean(ids.consentIds);
  const out: ForgetResult = { calls: 0, deleted: {} };
  const rounds = Math.max(Math.ceil(visitors.length / FORGET_BATCH_MAX), Math.ceil(consents.length / FORGET_BATCH_MAX));
  for (let i = 0; i < rounds; i++) {
    const body = {
      website,
      visitorIds: visitors.slice(i * FORGET_BATCH_MAX, (i + 1) * FORGET_BATCH_MAX),
      consentIds: consents.slice(i * FORGET_BATCH_MAX, (i + 1) * FORGET_BATCH_MAX),
      mode,
    };
    const res = await call(s, "POST", "/ops/v1/forget", s.forgetKey, body, opts);
    out.calls++;
    if (isObj(res)) {
      const counts = isObj(res.deleted) ? res.deleted : res;
      for (const [k, v] of Object.entries(counts)) {
        if (typeof v === "number" && Number.isFinite(v)) out.deleted[k] = (out.deleted[k] ?? 0) + v;
      }
    }
  }
  return out;
}
