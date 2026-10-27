// SCP-Sd — THE SIMULATED NUMBERS: a pure, deterministic generator for the social simulator's post and account metrics
// (plan §5 "Simulated metrics", §8 row Sd). No I/O, no clock, no `Math.random`, no import from this module's other files:
// the same input gives the same output on every machine, forever. The driver (simulated-driver.ts) reads the facts from
// our rows and calls these functions; the metrics job (metrics-job.ts) stores what the driver returns.
//
// ── DETERMINISM ────────────────────────────────────────────────────────────────────────────────────────────────────
// Every number is a function of (a stable id, a label), through SHA-256: `unit(seed, label)` is a uniform [0, 1) drawn from
// the digest of `seed|label`. A label per quantity means the draws are independent of one another AND of the order they
// are asked in, so adding a counter later never shifts an existing one. Pinned in simulated-metrics.test.ts by golden
// values: change a constant below and those pins fail on purpose, because every number the owner has already seen would
// move. The seed of a post's numbers is the VARIANT id (a post has one variant per network, so the post id alone would
// give two networks identical numbers); the seed of an account's is the ACCOUNT id.
//
// ── A POST'S SHAPE ─────────────────────────────────────────────────────────────────────────────────────────────────
// Each post has FINAL numbers (what it reaches by day 7) and a CURVE (the share of those it has by day 1 and day 3). The
// snapshot of day d is `round(final × share(d))` per counter, so counters are CUMULATIVE and, because `share` rises and
// rounding is monotone, never fall from day 1 to day 3 to day 7 (the property tests pin it for hundreds of ids).
//   - Reach scales with the network (a TikTok post travels further than a Mastodon one) and the FORMAT: reels carry more,
//     stories fewer (plan §5: "reels are higher and stories lower, as in the design"). The engagement RATE follows the
//     format the same way.
//   - The rate has a per-post spread (a log-normal-ish factor from three uniforms), so across a client's month a minority
//     of posts clear the 1.25x boost-candidate bar (post-metrics.ts) and most do not. The spread is the whole point of
//     simulating: a bar nothing ever cleared would leave the boost loop un-drivable.
//   - The curve is format-shaped: a story is almost all there on day 1 (it expires in a day), a reel keeps climbing.
//   - Video views exist for reels only. A counter a format cannot have is ABSENT (the job stores NULL), never 0: the
//     module's standing "no invented numbers" rule (metrics-job.ts's header), kept even for made-up numbers.
// An account's daily row is a function of (account id, network, date): followers rise by a fixed per-account amount a day
// (slowly, never falling); reach, impressions, engagements, link clicks and video views wobble around a share of the
// followers, per date.
import { createHash } from "node:crypto";

export const SIMULATED_FORMATS = ["feed", "carousel", "reel", "story"] as const;
export type SimulatedFormat = (typeof SIMULATED_FORMATS)[number];

/** The days after go-live a snapshot is taken (plan §5: "one, three and seven days after go-live"). */
export const SNAPSHOT_DAYS = [1, 3, 7] as const;
export type SnapshotDay = (typeof SNAPSHOT_DAYS)[number];

const DAY_MS = 86_400_000;

/** A uniform [0, 1) from the digest of `seed|label`: 48 bits, so it is exact in a double. */
export function unit(seed: string, label: string): number {
  const d = createHash("sha256").update(`${seed}|${label}`).digest();
  return d.readUIntBE(0, 6) / 2 ** 48;
}

/** A value between `lo` and `hi` (inclusive of lo, exclusive of hi) for this seed and label. */
const between = (seed: string, label: string, lo: number, hi: number): number => lo + (hi - lo) * unit(seed, label);

/** A roughly normal draw (mean 0, sd 1) from three uniforms (Irwin-Hall, scaled): bounded to about +-3, which keeps the
 *  rate's spread finite without a tail that would print a 90% engagement rate. */
function z(seed: string, label: string): number {
  return (unit(seed, `${label}#1`) + unit(seed, `${label}#2`) + unit(seed, `${label}#3`) - 1.5) * 2;
}

// ── a post ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Day-7 reach of a typical feed post, by network. Invented dev-review scale, not a claim about any network. */
const NETWORK_REACH: Record<string, number> = {
  instagram: 2400, facebook: 1500, tiktok: 4200, linkedin: 1100, x: 900,
  youtube: 1800, threads: 1000, pinterest: 1300, bluesky: 500, mastodon: 300,
};
const DEFAULT_NETWORK_REACH = 1000;

/** The format's lift on reach, and the typical engagement rate of the format. Reels above, stories below. */
const FORMAT: Record<SimulatedFormat, { reach: number; rate: number; share1: number; share3: number }> = {
  // share1/share3: the share of the day-7 numbers present on day 1 / day 3 (the per-post jitter is added on top).
  feed:     { reach: 1.0,  rate: 0.040, share1: 0.55, share3: 0.82 },
  carousel: { reach: 1.15, rate: 0.050, share1: 0.50, share3: 0.80 },
  reel:     { reach: 2.4,  rate: 0.060, share1: 0.35, share3: 0.70 },
  story:    { reach: 0.45, rate: 0.018, share1: 0.90, share3: 0.98 },
};

/** The format a post's own `format` column names, or `feed` for NULL or anything unknown (a Composer post has none). */
export function normalizeFormat(format: string | null | undefined): SimulatedFormat {
  return (SIMULATED_FORMATS as readonly string[]).includes(format ?? "") ? (format as SimulatedFormat) : "feed";
}

/** The counters of one snapshot. `videoViews` is absent for any format that is not a reel (never 0). */
export interface SimulatedPostSnapshot {
  day: SnapshotDay;
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  videoViews?: number;
}

/** The post's day-7 numbers, before the curve is applied. */
interface FinalNumbers {
  reach: number; impressions: number; likes: number; comments: number; shares: number; saves: number; clicks: number;
  videoViews?: number;
}

/** The engagement RATE a post settles at, (likes + comments + saves + shares) / reach: the format's typical rate times a
 *  per-post log-normal-ish factor (sigma 0.4), capped at 30% so a lucky draw stays plausible. Exposed for the spread test. */
export function simulatedEngagementRate(seed: string, format: SimulatedFormat): number {
  return Math.min(0.30, FORMAT[format].rate * Math.exp(0.4 * z(seed, "rate")));
}

function finalNumbers(seed: string, network: string, format: SimulatedFormat): FinalNumbers {
  const f = FORMAT[format];
  const reach = Math.max(1, Math.round((NETWORK_REACH[network] ?? DEFAULT_NETWORK_REACH) * f.reach * between(seed, "reach", 0.6, 1.5)));
  const impressions = Math.max(reach, Math.round(reach * between(seed, "frequency", 1.15, 1.7)));
  const engaged = Math.round(reach * simulatedEngagementRate(seed, format));
  // The mix of engagements. Each part gets a jittered weight; the weights are normalised, so the parts sum to the total
  // (give or take rounding) and the RATE the SCP-3c read computes is the one drawn above. A story has almost no saves.
  const w = {
    likes: between(seed, "w-likes", 0.62, 0.78),
    comments: between(seed, "w-comments", 0.04, 0.09),
    shares: between(seed, "w-shares", 0.05, 0.12),
    saves: format === "story" ? between(seed, "w-saves", 0.0, 0.02) : between(seed, "w-saves", 0.08, 0.2),
  };
  const sum = w.likes + w.comments + w.shares + w.saves;
  const out: FinalNumbers = {
    reach, impressions,
    likes: Math.round((engaged * w.likes) / sum),
    comments: Math.round((engaged * w.comments) / sum),
    shares: Math.round((engaged * w.shares) / sum),
    saves: Math.round((engaged * w.saves) / sum),
    clicks: Math.round(reach * between(seed, "clicks", 0.006, 0.026)),
  };
  if (format === "reel") out.videoViews = Math.round(impressions * between(seed, "video", 0.55, 0.85));
  return out;
}

/** The share of the day-7 numbers present on `day`: rises strictly 1 -> 3 -> 7 (day 7 is 1). Per-post jitter on the
 *  day-1 share (+-0.07), and the day-3 share sits between day 1 and 1 by a per-post fraction. */
function curveShare(seed: string, format: SimulatedFormat, day: SnapshotDay): number {
  if (day === 7) return 1;
  const f = FORMAT[format];
  const s1 = Math.min(0.97, Math.max(0.05, f.share1 + between(seed, "curve-1", -0.07, 0.07)));
  if (day === 1) return s1;
  // Day 3: the format's typical share, but never below day 1 plus a sliver, and always below 1.
  const s3 = Math.min(0.995, Math.max(s1 + 0.01, f.share3 + between(seed, "curve-3", -0.05, 0.05)));
  return s3;
}

/**
 * PURE. One post's cumulative numbers `day` days after go-live. `seed` is the VARIANT id. The same input always gives
 * the same output; for a fixed (seed, network, format) every counter is non-decreasing from day 1 to 3 to 7.
 */
export function simulatedPostMetrics(seed: string, network: string, format: string | null | undefined, day: SnapshotDay): SimulatedPostSnapshot {
  const fmt = normalizeFormat(format);
  const final = finalNumbers(seed, network, fmt);
  const share = curveShare(seed, fmt, day);
  const at = (n: number) => Math.round(n * share);
  const out: SimulatedPostSnapshot = {
    day,
    reach: at(final.reach), impressions: at(final.impressions), likes: at(final.likes), comments: at(final.comments),
    shares: at(final.shares), saves: at(final.saves), clicks: at(final.clicks),
  };
  if (final.videoViews !== undefined) out.videoViews = at(final.videoViews);
  return out;
}

/** The snapshot days that have PASSED at `now` for a post that went live at `wentLive`: day d is due when
 *  `wentLive + d days <= now`. PURE; the caller owns the clock. A `wentLive` in the future gives none. */
export function dueSnapshotDays(wentLive: Date, now: Date): SnapshotDay[] {
  const t = wentLive.getTime();
  if (!Number.isFinite(t)) return [];
  return SNAPSHOT_DAYS.filter((d) => t + d * DAY_MS <= now.getTime());
}

/** The moment a snapshot of `day` is stamped with (`social_post_metrics.fetched_at`): exactly `day` days after go-live, so
 *  the stamp is a pure function of the post, and a rerun finds the row it wrote and writes nothing. */
export function snapshotCapturedAt(wentLive: Date, day: SnapshotDay): Date {
  return new Date(wentLive.getTime() + day * DAY_MS);
}

// ── an account ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Starting followers by network (an invented dev-review scale), then a per-account factor. */
const NETWORK_FOLLOWERS: Record<string, number> = {
  instagram: 4200, facebook: 3100, tiktok: 6500, linkedin: 1900, x: 1500,
  youtube: 2600, threads: 1200, pinterest: 1700, bluesky: 600, mastodon: 400,
};
const DEFAULT_NETWORK_FOLLOWERS = 1500;
/** Followers grow from this day, so a date before it reads as day 0, never a negative count. */
const GROWTH_EPOCH_MS = Date.UTC(2026, 0, 1);

export interface SimulatedDailyRow {
  date: string; // YYYY-MM-DD
  followers: number;
  impressions: number;
  reach: number;
  engagements: number;
  linkClicks: number;
  videoViews: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** PURE. The UTC midnight of a real `YYYY-MM-DD` as a time, or null (no 30 February, no other format). */
export function parseIsoDay(day: string): number | null {
  const m = DATE_RE.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}

/**
 * PURE. One account's numbers for one date. `seed` is the ACCOUNT id. Followers = a per-account start + a per-account whole-
 * number-ish daily gain (0.8 to 4.5 a day, fractional, floored): slowly rising, NEVER falling from one date to the next. The rest wobble per
 * date around a share of the followers. Null for a date that is not a real day.
 */
export function simulatedDailyMetrics(seed: string, network: string, date: string): SimulatedDailyRow | null {
  const t = parseIsoDay(date);
  if (t === null) return null;
  const dayIndex = Math.max(0, Math.round((t - GROWTH_EPOCH_MS) / DAY_MS));
  const start = Math.round((NETWORK_FOLLOWERS[network] ?? DEFAULT_NETWORK_FOLLOWERS) * between(seed, "followers", 0.6, 1.6));
  const gain = between(seed, "gain", 0.8, 4.5);
  const followers = start + Math.floor(dayIndex * gain);
  const reach = Math.round(followers * between(seed, "reach-share", 0.06, 0.16) * between(`${seed}|${date}`, "reach", 0.7, 1.3));
  const impressions = Math.max(reach, Math.round(reach * between(`${seed}|${date}`, "impressions", 1.15, 1.7)));
  return {
    date, followers, reach, impressions,
    engagements: Math.round(reach * between(seed, "eng-share", 0.025, 0.06) * between(`${seed}|${date}`, "eng", 0.75, 1.25)),
    linkClicks: Math.round(reach * between(seed, "click-share", 0.006, 0.02) * between(`${seed}|${date}`, "clicks", 0.7, 1.3)),
    videoViews: Math.round(impressions * between(seed, "video-share", 0.15, 0.35) * between(`${seed}|${date}`, "video", 0.7, 1.3)),
  };
}

/** The most days one `getAccountMetrics` call answers, whatever range it is asked for (a bad range must not spin the job). */
export const MAX_DAILY_RANGE_DAYS = 120;

/** PURE. The daily rows for `from..to` inclusive, oldest first, at most `MAX_DAILY_RANGE_DAYS` (the newest ones). An invalid or
 *  reversed range gives []. */
export function simulatedDailySeries(seed: string, network: string, range: { from: string; to: string }): SimulatedDailyRow[] {
  const from = parseIsoDay(range.from);
  const to = parseIsoDay(range.to);
  if (from === null || to === null || to < from) return [];
  const days = Math.min(MAX_DAILY_RANGE_DAYS, Math.round((to - from) / DAY_MS) + 1);
  const rows: SimulatedDailyRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(to - i * DAY_MS).toISOString().slice(0, 10);
    const row = simulatedDailyMetrics(seed, network, date);
    if (row) rows.push(row);
  }
  return rows;
}
