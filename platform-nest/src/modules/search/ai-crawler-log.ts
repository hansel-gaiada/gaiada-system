// M5-P5b — the AI-crawler log: a PURE parser + aggregator for web-server access-log chunks. No database, no network,
// no clock except the injected `now`. The ops side can call `aggregateAiCrawlerLog` from a cron as is; the
// platform route (ai-crawler.controller.ts) calls it and then upserts the result (ai-crawler-store.ts).
//
// PRIVACY (legal/website-visitor-addendum.md): an access log holds visitor IPs and full User-Agents. This file keeps
// ONLY requests whose User-Agent claims to be a known AI crawler (ai-crawler-bots.ts), and of those keeps only
// {day (UTC), bot id, path without query string, status, verification}. The IP is read transiently to ask the
// verifier and is dropped; the User-Agent string, the referrer and the raw line are never returned or stored. A
// line that is not an AI crawler (a human, an ordinary search bot) is counted as "dropped" and forgotten.
//
// FORMATS: nginx / Apache "combined" (the format of the estate's nginx hosts, infra/nginx/*.conf: `$remote_addr -
// $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"`), and
// Caddy's JSON access log (one object per line: request.remote_ip, request.uri, request.headers["User-Agent"],
// status, ts). Anything else is "malformed" and dropped.
import { AI_CRAWLERS, matchAiCrawler, type AiCrawlerBot } from "./ai-crawler-bots";

export type Verification = "claimed" | "verified" | "unverified";

/** Pluggable check of "is this IP really that vendor's crawler?". Called once per distinct (ip, bot) in a chunk. */
export type CrawlerVerifier = (ip: string | null, bot: AiCrawlerBot) => Verification | Promise<Verification>;

export interface CrawlerAggregate {
  day: string; // YYYY-MM-DD, UTC
  bot: string;
  path: string; // no query string, no fragment, at most 512 chars, starts with "/"
  status: number;
  verification: Verification;
  hits: number;
}

export interface AggregateStats {
  linesSeen: number;
  malformed: number;
  /** Well-formed requests that were not from a known AI crawler (humans, other bots): counted, then forgotten. */
  dropped: number;
  kept: number;
  /** Older than MAX_AGE_DAYS or more than a day in the future. */
  outOfRange: number;
  /** Kept requests that did not fit under MAX_KEYS distinct rows. */
  overflow: number;
}

export interface AggregateResult { rows: CrawlerAggregate[]; stats: AggregateStats }

export const MAX_PATH_LEN = 512;
export const MAX_KEYS = 20000;
export const MAX_AGE_DAYS = 400;

export interface ParsedRequest { ip: string | null; at: Date; method: string; path: string; status: number; userAgent: string }

const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) \S+(?: "[^"]*" "((?:[^"\\]|\\.)*)")?/;
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const TIME = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

function parseCombinedTime(s: string): Date | null {
  const m = TIME.exec(s);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (mon === undefined) return null;
  const offMin = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const t = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offMin * 60000;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The path of a request target: no scheme/host, no query string, no fragment. Null when it is not a path. */
export function cleanPath(target: string): string | null {
  let t = target.trim();
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(t);
  if (abs) t = t.slice(abs[0].length) || "/";
  const cut = t.search(/[?#]/);
  if (cut >= 0) t = t.slice(0, cut);
  if (!t.startsWith("/")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  return t.length > MAX_PATH_LEN ? t.slice(0, MAX_PATH_LEN) : t;
}

function fromCombined(line: string): ParsedRequest | null {
  const m = COMBINED.exec(line);
  if (!m) return null;
  const at = parseCombinedTime(m[2]);
  if (!at) return null;
  const req = /^([A-Z]+) (\S+)(?: \S+)?$/.exec(m[3]);
  if (!req) return null;
  const path = cleanPath(req[2]);
  if (!path) return null;
  return { ip: m[1], at, method: req[1], path, status: Number(m[4]), userAgent: (m[5] ?? "").replace(/\\x22/g, '"') };
}

function fromCaddyJson(line: string): ParsedRequest | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const j = o as { ts?: unknown; status?: unknown; request?: { remote_ip?: unknown; client_ip?: unknown; method?: unknown; uri?: unknown; headers?: Record<string, unknown> } };
  const r = j.request;
  if (!r || typeof r.uri !== "string" || typeof r.method !== "string" || typeof j.status !== "number" || typeof j.ts !== "number") return null;
  const path = cleanPath(r.uri);
  if (!path) return null;
  const h = r.headers ?? {};
  const raw = h["User-Agent"] ?? h["user-agent"];
  const ua = Array.isArray(raw) ? String(raw[0] ?? "") : typeof raw === "string" ? raw : "";
  const ip = typeof r.client_ip === "string" ? r.client_ip : typeof r.remote_ip === "string" ? r.remote_ip : null;
  const at = new Date(j.ts * 1000);
  if (Number.isNaN(at.getTime())) return null;
  return { ip, at, method: r.method, path, status: j.status, userAgent: ua };
}

/** One access-log line, or null when it is not a recognised line. */
export function parseAccessLogLine(line: string): ParsedRequest | null {
  const l = line.trim();
  if (!l) return null;
  const p = l.startsWith("{") ? fromCaddyJson(l) : fromCombined(l);
  if (!p || !Number.isInteger(p.status) || p.status < 100 || p.status > 599) return null;
  return p;
}

export interface AggregateOptions {
  /** Default: every kept row is "claimed" (no verification). */
  verifier?: CrawlerVerifier;
  now?: Date;
}

export async function aggregateAiCrawlerLog(chunk: string, opts: AggregateOptions = {}): Promise<AggregateResult> {
  const now = (opts.now ?? new Date()).getTime();
  const stats: AggregateStats = { linesSeen: 0, malformed: 0, dropped: 0, kept: 0, outOfRange: 0, overflow: 0 };
  const counts = new Map<string, CrawlerAggregate>();
  const verdicts = new Map<string, Verification>(); // per (ip,bot), chunk-local; the IP never leaves this function

  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    stats.linesSeen++;
    const p = parseAccessLogLine(line);
    if (!p) { stats.malformed++; continue; }
    const bot = matchAiCrawler(p.userAgent);
    if (!bot || (p.method !== "GET" && p.method !== "HEAD")) { stats.dropped++; continue; }
    const t = p.at.getTime();
    if (t > now + 86400000 || t < now - MAX_AGE_DAYS * 86400000) { stats.outOfRange++; continue; }

    let verification: Verification = "claimed";
    if (opts.verifier) {
      const k = `${p.ip ?? ""}\u0000${bot.id}`;
      let v = verdicts.get(k);
      if (v === undefined) {
        try { v = await opts.verifier(p.ip, bot); } catch { v = "unverified"; }
        verdicts.set(k, v);
      }
      verification = v;
    }

    const day = p.at.toISOString().slice(0, 10);
    const key = `${day}\u0000${bot.id}\u0000${p.path}\u0000${p.status}\u0000${verification}`;
    const cur = counts.get(key);
    if (cur) { cur.hits++; stats.kept++; continue; }
    if (counts.size >= MAX_KEYS) { stats.overflow++; continue; }
    counts.set(key, { day, bot: bot.id, path: p.path, status: p.status, verification, hits: 1 });
    stats.kept++;
  }
  return { rows: [...counts.values()], stats };
}

export { AI_CRAWLERS };
