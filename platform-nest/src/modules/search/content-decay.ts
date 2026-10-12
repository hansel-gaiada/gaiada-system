// M5-V4 — the content-decay detector. PURE: no DB, no network, no clock. Given, per page path, three
// window totals (the recent window, the window right before it, and the same window a year ago), it says
// whether the page is losing search clicks / impressions / position or site views, and why, in words.
//
// WHAT "MISSING" MEANS (the rule every test pins): a window the caller could not measure is `null`, not 0.
// A null recent or baseline window means NO ALERT for that metric — never a fake zero that would read as
// "the page lost everything". A null year-ago window simply means the seasonality cross-check is skipped.
//
// TWO WAYS A PAGE IS FLAGGED, per metric:
//   prior_period  recent vs the window before it fell by the thresholds below. If a year-ago window exists
//                 the drop must ALSO sit below the year-ago level by YOY_CONFIRM_REL: a page that always
//                 dips at this time of year (seasonal) is flat against last year and is NOT flagged.
//   year_ago      recent vs the same window last year fell by YOY_MIN_REL_DROP (slow decay that the
//                 prior-period comparison cannot see, because each window is only a little below the last).
// Both need a minimum baseline volume (tiny pages are noise) AND a minimum relative AND absolute drop.
//
// Counts here are raw; the HTTP layer applies the small-cell rule (visitor addendum R-V6) when it returns
// view counts.

/** Length of the recent window and of the baseline window, in days. */
export const DECAY_WINDOW_DAYS = 28;
/** Search Console settles late: the recent window ends this many days before today. */
export const DECAY_DATA_LAG_DAYS = 3;
/** A window is only measurable when the property has Search Console rows on at least this many of its days. */
export const MIN_GSC_COVERAGE_DAYS = 14;

export interface DecayThresholds {
  /** Page-level volume floors on the BASELINE window (a page below it is never flagged on that metric). */
  minBaselineClicks: number;
  minBaselineImpressions: number;
  minBaselineViews: number;
  /** A drop must be at least this share of the baseline... */
  minRelDrop: number;
  /** ...and at least this many units (per metric), so a 30-click page losing 10 is not an alert. */
  minAbsDropClicks: number;
  minAbsDropImpressions: number;
  minAbsDropViews: number;
  /** Position worsening (higher number = worse) that counts, and the baseline position range it applies to. */
  minPositionWorsen: number;
  maxBaselinePosition: number;
  minBaselineImpressionsForPosition: number;
  /** Seasonality cross-check: a prior-period drop stands only if recent is also this share below year-ago. */
  yoyConfirmRel: number;
  /** Slow-decay rule: recent vs year-ago. */
  yoyMinRelDrop: number;
}

export const DECAY_THRESHOLDS: Readonly<DecayThresholds> = Object.freeze({
  minBaselineClicks: 30,
  minBaselineImpressions: 500,
  minBaselineViews: 100,
  minRelDrop: 0.3,
  minAbsDropClicks: 15,
  minAbsDropImpressions: 250,
  minAbsDropViews: 40,
  minPositionWorsen: 4,
  maxBaselinePosition: 30,
  minBaselineImpressionsForPosition: 500,
  yoyConfirmRel: 0.15,
  yoyMinRelDrop: 0.4,
});

export type DecayMetric = "clicks" | "impressions" | "position" | "views";
export type DecayBasis = "prior_period" | "year_ago";

/** One window's totals for one page. Any member is null when that source had no measurable data. */
export interface WindowStat {
  clicks: number | null;
  impressions: number | null;
  /** Impression-weighted average position (1 = best). */
  position: number | null;
  views: number | null;
}
export const EMPTY_WINDOW: Readonly<WindowStat> = Object.freeze({ clicks: null, impressions: null, position: null, views: null });

export interface PageWindows {
  recent: WindowStat | null;
  baseline: WindowStat | null;
  yearAgo: WindowStat | null;
}

export interface DecayReason {
  metric: DecayMetric;
  basis: DecayBasis;
  recent: number;
  baseline: number;
  /** For clicks/impressions/views: the absolute fall. For position: how many places it worsened. */
  drop: number;
  /** Share of the baseline lost (0..1). For position: null. */
  dropPct: number | null;
  text: string;
}

export interface DecayResult {
  flagged: boolean;
  reasons: DecayReason[];
  /** All reasons joined, in words. Empty when not flagged. */
  reason: string;
}

const METRIC_LABEL: Record<Exclude<DecayMetric, "position">, string> = {
  clicks: "Search clicks", impressions: "Search impressions", views: "Page views",
};
/** Visitor addendum R-V6: view counts below this are never shown. */
export const SMALL_CELL = 5;
const n0 = (n: number): string => String(Math.round(n));
const pct = (r: number): string => `${Math.round(r * 100)}%`;
const present = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

type CountMetric = "clicks" | "impressions" | "views";
const COUNT_RULES: Array<{ metric: CountMetric; minBase: keyof DecayThresholds; minAbs: keyof DecayThresholds }> = [
  { metric: "clicks", minBase: "minBaselineClicks", minAbs: "minAbsDropClicks" },
  { metric: "impressions", minBase: "minBaselineImpressions", minAbs: "minAbsDropImpressions" },
  { metric: "views", minBase: "minBaselineViews", minAbs: "minAbsDropViews" },
];

export function detectDecay(page: PageWindows, t: DecayThresholds = DECAY_THRESHOLDS): DecayResult {
  const reasons: DecayReason[] = [];
  const { recent, baseline, yearAgo } = page;

  if (recent && baseline) {
    for (const rule of COUNT_RULES) {
      const r = recent[rule.metric];
      const b = baseline[rule.metric];
      if (!present(r) || !present(b)) continue; // missing data: no alert, never a fake zero
      const minBase = t[rule.minBase] as number;
      const minAbs = t[rule.minAbs] as number;
      if (b < minBase) continue; // a tiny page is noise
      const drop = b - r;
      if (drop < minAbs || drop / b < t.minRelDrop) continue;
      // Seasonality: with a year-ago window, the fall must also be a fall against last year.
      const y = yearAgo?.[rule.metric];
      if (present(y) && y > 0 && r >= y * (1 - t.yoyConfirmRel)) continue;
      const label = METRIC_LABEL[rule.metric];
      const yoyBit = present(y) && y > 0 ? ` and is ${pct(Math.max(0, (y - r) / y))} below the same period last year (${n0(y)})` : "";
      // Small-cell rule (visitor addendum R-V6): a view count under 5 is never spelled out.
      const fell = rule.metric === "views" && r < SMALL_CELL
        ? `${label} fell to fewer than ${SMALL_CELL} (from ${n0(b)})`
        : `${label} fell ${pct(drop / b)} (${n0(b)} to ${n0(r)})`;
      reasons.push({
        metric: rule.metric, basis: "prior_period", recent: r, baseline: b, drop, dropPct: drop / b,
        text: `${fell} over the last ${DECAY_WINDOW_DAYS} days compared with the ${DECAY_WINDOW_DAYS} days before${yoyBit}.`,
      });
    }

    // Position: only for a page that ranked meaningfully and had real impressions, and only a real slide.
    const rp = recent.position;
    const bp = baseline.position;
    const bi = baseline.impressions;
    if (present(rp) && present(bp) && present(bi) && bi >= t.minBaselineImpressionsForPosition && bp <= t.maxBaselinePosition) {
      const worsen = rp - bp;
      if (worsen >= t.minPositionWorsen) {
        reasons.push({
          metric: "position", basis: "prior_period", recent: rp, baseline: bp, drop: worsen, dropPct: null,
          text: `Average search position slid from ${bp.toFixed(1)} to ${rp.toFixed(1)} (${worsen.toFixed(1)} places lower) compared with the ${DECAY_WINDOW_DAYS} days before.`,
        });
      }
    }
  }

  // Slow decay against the same window last year (needs recent and year-ago; baseline is not required).
  if (recent && yearAgo) {
    for (const rule of COUNT_RULES) {
      if (reasons.some((x) => x.metric === rule.metric)) continue; // already reported by the stronger rule
      const r = recent[rule.metric];
      const y = yearAgo[rule.metric];
      if (!present(r) || !present(y)) continue;
      if (y < (t[rule.minBase] as number)) continue;
      const drop = y - r;
      if (drop < (t[rule.minAbs] as number) || drop / y < t.yoyMinRelDrop) continue;
      reasons.push({
        metric: rule.metric, basis: "year_ago", recent: r, baseline: y, drop, dropPct: drop / y,
        text: rule.metric === "views" && r < SMALL_CELL
          ? `${METRIC_LABEL[rule.metric]} are fewer than ${SMALL_CELL} in the last ${DECAY_WINDOW_DAYS} days, from ${n0(y)} in the same days last year.`
          : `${METRIC_LABEL[rule.metric]} are ${pct(drop / y)} below the same ${DECAY_WINDOW_DAYS} days last year (${n0(y)} to ${n0(r)}).`,
      });
    }
  }

  return { flagged: reasons.length > 0, reasons, reason: reasons.map((r) => r.text).join(" ") };
}

// ── helpers shared by the job and the tests ────────────────────────────────────────────────────────────

/** `/path?x=1#y` or `https://host/path/` -> `/path` ; root stays `/`. No query string, no fragment, no host:
 *  a path is the only page identity stored, so no query parameter can carry personal data into a finding.
 *  Returns null for anything that is not a usable page path. */
export function normalizePagePath(raw: string): string | null {
  let p = (raw ?? "").trim();
  if (!p) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return null; }
  }
  p = p.split("#")[0]!.split("?")[0]!;
  if (!p.startsWith("/")) return null;
  try { p = decodeURI(p); } catch { /* keep as sent */ }
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p === "") p = "/";
  return p.length <= 512 ? p : null;
}

export interface DateWindows {
  recent: { from: string; to: string };
  baseline: { from: string; to: string };
  yearAgo: { from: string; to: string };
}

const DAY = 86400000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The three windows for a run on `now` (UTC dates, inclusive). Recent ends DECAY_DATA_LAG_DAYS before today. */
export function decayWindows(now: Date): DateWindows {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const recentTo = today - DECAY_DATA_LAG_DAYS * DAY;
  const recentFrom = recentTo - (DECAY_WINDOW_DAYS - 1) * DAY;
  const baseTo = recentFrom - DAY;
  const baseFrom = baseTo - (DECAY_WINDOW_DAYS - 1) * DAY;
  const yTo = recentTo - 364 * DAY; // 52 weeks back: same weekdays, no leap-day edge
  const yFrom = yTo - (DECAY_WINDOW_DAYS - 1) * DAY;
  return {
    recent: { from: iso(recentFrom), to: iso(recentTo) },
    baseline: { from: iso(baseFrom), to: iso(baseTo) },
    yearAgo: { from: iso(yFrom), to: iso(yTo) },
  };
}

/** One page's Search Console rows aggregated over a window (position weighted by impressions). */
export interface GscAgg { clicks: number; impressions: number; positionWeighted: number }

export function gscToStat(agg: GscAgg | undefined, covered: boolean): Pick<WindowStat, "clicks" | "impressions" | "position"> {
  if (!covered) return { clicks: null, impressions: null, position: null }; // not measurable: never zero
  if (!agg) return { clicks: 0, impressions: 0, position: null }; // covered window, no rows: GSC omits zero days
  return {
    clicks: agg.clicks, impressions: agg.impressions,
    position: agg.impressions > 0 ? agg.positionWeighted / agg.impressions : null,
  };
}

/** Compose the three windows of one page from per-source lookups. `covered*` say whether a source could
 *  measure that window at all. */
export function composePage(
  gsc: { recent?: GscAgg; baseline?: GscAgg; yearAgo?: GscAgg; covered: { recent: boolean; baseline: boolean; yearAgo: boolean } },
  views: { recent?: number; baseline?: number; yearAgo?: number; covered: { recent: boolean; baseline: boolean; yearAgo: boolean } },
): PageWindows {
  const mk = (w: "recent" | "baseline" | "yearAgo"): WindowStat | null => {
    const g = gscToStat(gsc[w], gsc.covered[w]);
    const v = views.covered[w] ? (views[w] ?? 0) : null;
    if (g.clicks === null && v === null) return null;
    return { ...g, views: v };
  };
  return { recent: mk("recent"), baseline: mk("baseline"), yearAgo: mk("yearAgo") };
}
