// M5-P5b — Website → Analytics → AI visibility: the shapes of platform-nest's AI-crawler summary and SM-16
// AI-visibility summary (platform-nest/src/modules/search/ai-crawler-store.ts), a STRICT parser, and the pure
// grouping the panels draw. Pure: no server-only imports, so the browser and the tests can use it.
//
// Rules the panels rest on:
//   * a read with no data is a STATE with words (no_data / no_data_in_range), never a zero;
//   * crawler rows carry bot ids, paths and counts only; there is no visitor data here and no <5 suppression
//     (these are crawlers, not people);
//   * a body that is off-contract is a contract defect (AiVisibilityShapeError), not an empty panel.

export class AiVisibilityShapeError extends Error {}

export interface CrawlerSummaryOk {
  state: "ok";
  range: { from: string; to: string };
  coverage: { firstDay: string | null; lastDay: string | null };
  totalHits: number;
  byDay: Array<{ day: string; bot: string; hits: number }>;
  byBot: Array<{ bot: string; hits: number; verified: number; unverified: number; claimed: number }>;
  topPaths: Array<{ path: string; hits: number }>;
  statusMix: Array<{ status: number; hits: number }>;
}
export interface CrawlerNoData {
  state: "no_data" | "no_data_in_range";
  message: string;
  range: { from: string; to: string };
  coverage: { firstDay: string | null; lastDay: string | null };
}
export type CrawlerSummary = CrawlerSummaryOk | CrawlerNoData;

export interface VisibilityRow {
  engine: string; query: string; brandMentioned: boolean; cited: boolean; citedUrl: string | null;
  prominence: number | null; capturedAt: string; simulated: boolean; changed: boolean;
}
export interface VisibilityOk {
  state: "ok";
  lastCapturedAt: string;
  anySimulated: boolean;
  engines: Array<{ engine: string; queries: number; mentioned: number; cited: number; changed: number }>;
  latest: VisibilityRow[];
}
export interface VisibilityNoData { state: "no_data"; message: string }
export type VisibilitySummary = VisibilityOk | VisibilityNoData;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, at: string): Record<string, unknown> => {
  if (!isObj(v)) throw new AiVisibilityShapeError(`${at}: expected an object`);
  return v;
};
const str = (v: unknown, at: string): string => {
  if (typeof v !== "string") throw new AiVisibilityShapeError(`${at}: expected a string`);
  return v;
};
const strN = (v: unknown, at: string): string | null => (v === null || v === undefined ? null : str(v, at));
const int = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new AiVisibilityShapeError(`${at}: expected a whole number of 0 or more`);
  return v;
};
const num = (v: unknown, at: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new AiVisibilityShapeError(`${at}: expected a number or null`);
  return v;
};
const bool = (v: unknown, at: string): boolean => {
  if (typeof v !== "boolean") throw new AiVisibilityShapeError(`${at}: expected true or false`);
  return v;
};
const arr = <T,>(v: unknown, at: string, f: (o: Record<string, unknown>, at: string) => T): T[] => {
  if (!Array.isArray(v)) throw new AiVisibilityShapeError(`${at}: expected an array`);
  return v.map((x, i) => f(obj(x, `${at}[${i}]`), `${at}[${i}]`));
};
const range = (v: unknown, at: string) => { const o = obj(v, at); return { from: str(o.from, `${at}.from`), to: str(o.to, `${at}.to`) }; };

export function parseCrawlerSummary(body: unknown): CrawlerSummary {
  const o = obj(body, "ai-crawlers summary");
  const cov = obj(o.coverage, "coverage");
  const base = { range: range(o.range, "range"), coverage: { firstDay: strN(cov.firstDay, "coverage.firstDay"), lastDay: strN(cov.lastDay, "coverage.lastDay") } };
  if (o.state === "no_data" || o.state === "no_data_in_range") {
    return { state: o.state, message: str(o.message, "message"), ...base };
  }
  if (o.state !== "ok") throw new AiVisibilityShapeError("ai-crawlers summary: unknown state");
  return {
    state: "ok", ...base,
    totalHits: int(o.totalHits, "totalHits"),
    byDay: arr(o.byDay, "byDay", (x, at) => ({ day: str(x.day, `${at}.day`), bot: str(x.bot, `${at}.bot`), hits: int(x.hits, `${at}.hits`) })),
    byBot: arr(o.byBot, "byBot", (x, at) => ({ bot: str(x.bot, `${at}.bot`), hits: int(x.hits, `${at}.hits`), verified: int(x.verified, `${at}.verified`), unverified: int(x.unverified, `${at}.unverified`), claimed: int(x.claimed, `${at}.claimed`) })),
    topPaths: arr(o.topPaths, "topPaths", (x, at) => ({ path: str(x.path, `${at}.path`), hits: int(x.hits, `${at}.hits`) })),
    statusMix: arr(o.statusMix, "statusMix", (x, at) => ({ status: int(x.status, `${at}.status`), hits: int(x.hits, `${at}.hits`) })),
  };
}

export function parseVisibilitySummary(body: unknown): VisibilitySummary {
  const o = obj(body, "ai-visibility summary");
  if (o.state === "no_data") return { state: "no_data", message: str(o.message, "message") };
  if (o.state !== "ok") throw new AiVisibilityShapeError("ai-visibility summary: unknown state");
  return {
    state: "ok",
    lastCapturedAt: str(o.lastCapturedAt, "lastCapturedAt"),
    anySimulated: bool(o.anySimulated, "anySimulated"),
    engines: arr(o.engines, "engines", (x, at) => ({ engine: str(x.engine, `${at}.engine`), queries: int(x.queries, `${at}.queries`), mentioned: int(x.mentioned, `${at}.mentioned`), cited: int(x.cited, `${at}.cited`), changed: int(x.changed, `${at}.changed`) })),
    latest: arr(o.latest, "latest", (x, at) => ({
      engine: str(x.engine, `${at}.engine`), query: str(x.query, `${at}.query`), brandMentioned: bool(x.brandMentioned, `${at}.brandMentioned`),
      cited: bool(x.cited, `${at}.cited`), citedUrl: strN(x.citedUrl, `${at}.citedUrl`),
      prominence: x.prominence === null || x.prominence === undefined ? null : num(x.prominence, `${at}.prominence`),
      capturedAt: str(x.capturedAt, `${at}.capturedAt`), simulated: bool(x.simulated, `${at}.simulated`), changed: bool(x.changed, `${at}.changed`),
    })),
  };
}

// ── Grouping the panels draw ─────────────────────────────────────────────────────────────────────────────

export interface StatusGroup { key: "ok" | "redirect" | "blocked" | "client_error" | "server_error"; label: string; hits: number; statuses: number[] }

/** 2xx fine; 3xx redirects; 401/403/429 the site refused the crawler ("blocked"); other 4xx broken links; 5xx server errors. */
export function groupStatus(mix: Array<{ status: number; hits: number }>): StatusGroup[] {
  const defs: Array<[StatusGroup["key"], string, (s: number) => boolean]> = [
    ["ok", "Served (2xx)", (s) => s >= 200 && s < 300],
    ["redirect", "Redirected (3xx)", (s) => s >= 300 && s < 400],
    ["blocked", "Blocked (401, 403, 429)", (s) => s === 401 || s === 403 || s === 429],
    ["client_error", "Not found or other client error (4xx)", (s) => s >= 400 && s < 500 && s !== 401 && s !== 403 && s !== 429],
    ["server_error", "Server error (5xx)", (s) => s >= 500],
  ];
  return defs
    .map(([key, label, test]) => {
      const rows = mix.filter((m) => test(m.status));
      return { key, label, hits: rows.reduce((n, r) => n + r.hits, 0), statuses: rows.map((r) => r.status) };
    })
    .filter((g) => g.hits > 0);
}

export interface DaySeries { days: string[]; bots: string[]; cells: Record<string, Record<string, number>>; max: number }

/** Every calendar day in the range, even one with no hits (a real, measured gap in the log), by bot. */
export function bySeries(rows: Array<{ day: string; bot: string; hits: number }>, from: string, to: string): DaySeries {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && days.length < 400; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  const totals = new Map<string, number>();
  const cells: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    (cells[r.day] ??= {})[r.bot] = r.hits;
    totals.set(r.bot, (totals.get(r.bot) ?? 0) + r.hits);
  }
  const bots = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b);
  const max = days.reduce((m, d) => Math.max(m, Object.values(cells[d] ?? {}).reduce((n, h) => n + h, 0)), 0);
  return { days, bots, cells, max };
}

export const fmtHits = (n: number): string => n.toLocaleString("en-US");
export const ENGINE_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT", google_ai_overview: "Google AI Overviews", gemini: "Gemini", claude: "Claude", perplexity: "Perplexity",
};
export const engineLabel = (e: string): string => ENGINE_LABELS[e] ?? e;
