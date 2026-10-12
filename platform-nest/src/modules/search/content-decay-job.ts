// M5-V4 — the daily content-decay job: for every verified, active search property that has data, run the
// pure detector (content-decay.ts) over Search Console clicks/impressions/position (our own
// search_gsc_performance rows, real data only: `simulated = false`) and Umami page views, and keep the
// findings as rows (search_decay_findings).
//
// DARK BY DEFAULT. `SEARCH_DECAY_ENABLED` must be exactly "1": unset, empty, "true", "0" and anything else
// leave the job OFF — an empty compose default (`${SEARCH_DECAY_ENABLED:-}`) is OFF, never read as a number.
// `startContentDecayLoop` returns null in that case before it creates a timer, opens a connection or
// touches the network. The only network this job can cause is umami-client.ts (the approved, GET-only
// Umami read egress); Search Console is read from our own tables, never from Google.
//
// IDEMPOTENT. The same window written twice converges (unique on property+path+window), and a page keeps at
// most one live finding (partial unique), so a restart or a second replica cannot duplicate or flood. One
// advisory lock keeps two sweeps from running at once.
//
// MISSING DATA IS NOT ZERO. A source that cannot measure a window (no Search Console rows on enough days of
// it, Umami unreachable / unbound / empty, a truncated Umami top-500 that does not list the page) yields a
// null window, and the detector never alerts on a null.
import type { PoolClient } from "pg";
import { withGlobal, withTenants, newId } from "../../db";
import { config } from "../../config";
import { isModuleEnabled } from "../registry";
import { umamiGet, UmamiError, type UmamiGetOpts } from "./umami-client";
import {
  DECAY_WINDOW_DAYS, MIN_GSC_COVERAGE_DAYS, composePage, decayWindows, detectDecay, normalizePagePath,
  type DateWindows, type DecayReason, type GscAgg, type PageWindows,
} from "./content-decay";
import { notifyDecayFindings } from "./notifications";

export const DECAY_ENABLED_ENV = "SEARCH_DECAY_ENABLED";
export const DECAY_INTERVAL_ENV = "SEARCH_DECAY_INTERVAL_MS";
const DEFAULT_INTERVAL_MS = 24 * 3600 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000;
/** Umami `metrics?type=path` page cap per call; a window that returns this many rows may be truncated. */
export const UMAMI_PATH_LIMIT = 500;
const GSC_PAGE_LIMIT = 20000;
const LOCK_NS = 0x53430004; // 'SC' + 4 — distinct from the pull scheduler's 0x53430003
const LOCK_KEY = 0;

/** ON only for the exact string "1". */
export function isDecayJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DECAY_ENABLED_ENV] === "1";
}

/** Empty, junk, zero or sub-minute values fall back to a day (never 0: that would be a busy loop). */
export function decayIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[DECAY_INTERVAL_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_INTERVAL_MS ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

export interface DecaySweepResult {
  skippedLocked: boolean;
  tenants: number;
  properties: number;
  /** Properties with no measurable data in the recent and baseline windows (skipped, never alerted). */
  noData: number;
  evaluated: number;
  inserted: number;
  resolved: number;
  errors: number;
}

export interface DecaySweepDeps {
  /** Umami client overrides (tests): settings and a fake fetch. Default = env settings + global fetch. */
  umami?: UmamiGetOpts;
}

type WinKey = "recent" | "baseline" | "yearAgo";
const WINS: WinKey[] = ["recent", "baseline", "yearAgo"];

// ── Search Console, from our own tables ────────────────────────────────────────────────────────────────
interface GscWindow { covered: boolean; byPath: Map<string, GscAgg> }

export async function loadGscWindow(c: PoolClient, propertyId: string, from: string, to: string): Promise<GscWindow> {
  const cov = await c.query<{ days: string }>(
    `SELECT count(DISTINCT date) AS days FROM search_gsc_performance
      WHERE property_id = $1 AND simulated = false AND date BETWEEN $2 AND $3`,
    [propertyId, from, to],
  );
  const covered = Number(cov.rows[0]?.days ?? 0) >= MIN_GSC_COVERAGE_DAYS;
  const byPath = new Map<string, GscAgg>();
  if (!covered) return { covered, byPath };
  const { rows } = await c.query<{ page: string; clicks: string; impressions: string; pw: string }>(
    `SELECT page, sum(clicks) AS clicks, sum(impressions) AS impressions,
            sum(COALESCE(position, 0) * impressions) AS pw
       FROM search_gsc_performance
      WHERE property_id = $1 AND simulated = false AND date BETWEEN $2 AND $3
      GROUP BY page ORDER BY sum(clicks) DESC LIMIT ${GSC_PAGE_LIMIT}`,
    [propertyId, from, to],
  );
  for (const r of rows) {
    const path = normalizePagePath(r.page);
    if (!path) continue;
    const cur = byPath.get(path) ?? { clicks: 0, impressions: 0, positionWeighted: 0 };
    cur.clicks += Number(r.clicks);
    cur.impressions += Number(r.impressions);
    cur.positionWeighted += Number(r.pw);
    byPath.set(path, cur);
  }
  return { covered, byPath };
}

// ── Umami ──────────────────────────────────────────────────────────────────────────────────────────────
interface ViewsWindow { covered: boolean; truncated: boolean; byPath: Map<string, number> }
const NO_VIEWS: ViewsWindow = { covered: false, truncated: false, byPath: new Map() };

/** [{x: path, y: views}] -> normalized path -> views. Raw counts (internal use; never returned unsuppressed). */
export function parseUmamiPaths(body: unknown): ViewsWindow {
  const byPath = new Map<string, number>();
  const rows = Array.isArray(body) ? body : [];
  for (const r of rows) {
    const o = r as { x?: unknown; y?: unknown };
    if (typeof o.x !== "string" || typeof o.y !== "number" || !Number.isFinite(o.y)) continue;
    const p = normalizePagePath(o.x);
    if (p) byPath.set(p, (byPath.get(p) ?? 0) + o.y);
  }
  return { covered: rows.length > 0, truncated: rows.length >= UMAMI_PATH_LIMIT, byPath };
}

async function loadViewsWindow(siteId: string, from: string, to: string, opts: UmamiGetOpts): Promise<ViewsWindow> {
  try {
    const body = await umamiGet(
      siteId, "metrics",
      { type: "path", startAt: Date.parse(`${from}T00:00:00.000Z`), endAt: Date.parse(`${to}T23:59:59.999Z`), limit: UMAMI_PATH_LIMIT },
      opts,
    );
    return parseUmamiPaths(body);
  } catch (e) {
    if (e instanceof UmamiError) return NO_VIEWS; // not configured / unreachable / rejected: not measurable
    throw e;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── one property ───────────────────────────────────────────────────────────────────────────────────────
interface PropertyRow { id: string; umamiSiteId: string | null }

export interface PropertyDecayOutcome {
  noData: boolean;
  evaluated: number;
  inserted: Array<{ id: string; path: string; reason: string; reasons: DecayReason[] }>;
  resolved: number;
}

/** Judge every page of one property and write the findings. Network (Umami) first, then ONE tenant
 *  transaction for the reads and writes, so no DB connection is held across a network call. */
export async function detectForProperty(
  tenantId: string, prop: PropertyRow, now: Date, deps: DecaySweepDeps = {},
): Promise<PropertyDecayOutcome> {
  const win: DateWindows = decayWindows(now);
  const opts = deps.umami ?? {};

  const views: Record<WinKey, ViewsWindow> = { recent: NO_VIEWS, baseline: NO_VIEWS, yearAgo: NO_VIEWS };
  if (prop.umamiSiteId && UUID_RE.test(prop.umamiSiteId)) {
    for (const k of WINS) views[k] = await loadViewsWindow(prop.umamiSiteId, win[k].from, win[k].to, opts);
  }

  return withTenants([tenantId], async (c) => {
    const gsc = {} as Record<WinKey, GscWindow>;
    for (const k of WINS) gsc[k] = await loadGscWindow(c, prop.id, win[k].from, win[k].to);

    const measurable = (gsc.recent.covered || views.recent.covered) && (gsc.baseline.covered || views.baseline.covered);
    if (!measurable) return { noData: true, evaluated: 0, inserted: [], resolved: 0 };

    const live = await c.query<{ id: string; page_path: string; status: string }>(
      `SELECT id, page_path, status FROM search_decay_findings
        WHERE property_id = $1 AND status IN ('open','acknowledged')`,
      [prop.id],
    );

    const paths = new Set<string>(live.rows.map((r) => r.page_path));
    for (const k of WINS) {
      for (const p of gsc[k].byPath.keys()) paths.add(p);
      for (const p of views[k].byPath.keys()) paths.add(p);
    }

    const inserted: PropertyDecayOutcome["inserted"] = [];
    let resolved = 0;
    const liveByPath = new Map(live.rows.map((r) => [r.page_path, r]));

    for (const path of paths) {
      const viewsCovered = (k: WinKey): boolean => views[k].covered && (!views[k].truncated || views[k].byPath.has(path));
      const page: PageWindows = composePage(
        {
          recent: gsc.recent.byPath.get(path), baseline: gsc.baseline.byPath.get(path), yearAgo: gsc.yearAgo.byPath.get(path),
          covered: { recent: gsc.recent.covered, baseline: gsc.baseline.covered, yearAgo: gsc.yearAgo.covered },
        },
        {
          recent: views.recent.byPath.get(path), baseline: views.baseline.byPath.get(path), yearAgo: views.yearAgo.byPath.get(path),
          covered: { recent: viewsCovered("recent"), baseline: viewsCovered("baseline"), yearAgo: viewsCovered("yearAgo") },
        },
      );
      const result = detectDecay(page);
      if (result.flagged) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO search_decay_findings
             (id, tenant_id, property_id, page_path, window_from, window_to, window_days, status, reason, reasons, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            newId(), tenantId, prop.id, path, win.recent.from, win.recent.to, DECAY_WINDOW_DAYS,
            result.reason, JSON.stringify(result.reasons), config.originSite,
          ],
        );
        if (ins.rows[0]) inserted.push({ id: ins.rows[0].id, path, reason: result.reason, reasons: result.reasons });
      } else if (liveByPath.has(path) && page.recent && page.baseline) {
        // Recovered, and measured (both windows present): close the open/acknowledged finding.
        const upd = await c.query(
          `UPDATE search_decay_findings SET status = 'resolved', resolved_at = now(), updated_at = now()
            WHERE id = $1 AND status IN ('open','acknowledged')`,
          [liveByPath.get(path)!.id],
        );
        resolved += upd.rowCount ?? 0;
      }
    }
    return { noData: false, evaluated: paths.size, inserted, resolved };
  }, { modules: ["search"] });
}

// ── the sweep ──────────────────────────────────────────────────────────────────────────────────────────
export async function runContentDecaySweep(now: Date = new Date(), deps: DecaySweepDeps = {}): Promise<DecaySweepResult> {
  const result: DecaySweepResult = {
    skippedLocked: false, tenants: 0, properties: 0, noData: 0, evaluated: 0, inserted: 0, resolved: 0, errors: 0,
  };
  return withGlobal(async (c) => {
    const lock = await c.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [LOCK_NS, LOCK_KEY]);
    if (!lock.rows[0]?.locked) { result.skippedLocked = true; return result; }
    try {
      const { rows: companies } = await c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC`);
      for (const { id: tenantId } of companies) {
        try {
          if (!(await isModuleEnabled(tenantId, "search"))) continue;
          result.tenants += 1;
          const props = await withTenants([tenantId], async (t) => {
            const r = await t.query<{ id: string; umami_site_id: string | null }>(
              `SELECT id, umami_site_id FROM search_properties
                WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL AND verified_at IS NOT NULL
                ORDER BY created_at ASC`,
              [tenantId],
            );
            return r.rows.map((x) => ({ id: x.id, umamiSiteId: x.umami_site_id }));
          }, { modules: ["search"] });
          for (const prop of props) {
            result.properties += 1;
            try {
              const o = await detectForProperty(tenantId, prop, now, deps);
              if (o.noData) { result.noData += 1; continue; }
              result.evaluated += o.evaluated;
              result.inserted += o.inserted.length;
              result.resolved += o.resolved;
              if (o.inserted.length > 0) {
                // Fail-soft: a notification problem never loses a finding that is already stored.
                try {
                  await notifyDecayFindings(tenantId, prop.id, o.inserted.map((f) => ({ id: f.id, path: f.path, reason: f.reason })), decayWindows(now).recent.to);
                } catch (err) {
                  console.error(`[SEARCH-DECAY] notify failed for property ${prop.id}:`, (err as Error).message);
                }
              }
            } catch (err) {
              result.errors += 1;
              console.error(`[SEARCH-DECAY] property ${prop.id} failed:`, (err as Error).message);
            }
          }
        } catch (err) {
          result.errors += 1;
          console.error(`[SEARCH-DECAY] tenant ${tenantId} failed:`, (err as Error).message);
        }
      }
      return result;
    } finally {
      await c.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_NS, LOCK_KEY]);
    }
  });
}

/** The loop. Returns null — with no timer, no DB and no network — unless SEARCH_DECAY_ENABLED is exactly "1".
 *  Chained setTimeout (a slow sweep never stacks), fail-soft per tick. */
export function startContentDecayLoop(
  env: NodeJS.ProcessEnv = process.env,
  opts: { initialDelayMs?: number; sweep?: () => Promise<DecaySweepResult> } = {},
): { stop: () => void } | null {
  if (!isDecayJobEnabled(env)) return null;
  const intervalMs = decayIntervalMs(env);
  const sweep = opts.sweep ?? (() => runContentDecaySweep());
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await sweep();
      if (r.inserted > 0 || r.resolved > 0 || r.errors > 0) {
        console.log("[SEARCH-DECAY] tick:", { properties: r.properties, inserted: r.inserted, resolved: r.resolved, errors: r.errors });
      }
    } catch (err) {
      console.error("[SEARCH-DECAY] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
