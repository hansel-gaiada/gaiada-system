// SCP-3c — the maths and the body rules of a post's metrics (FRONTEND-BFF-CONTRACT §63.10 "Metrics"; plan §4.2). PURE: no I/O, no clock
// (`now` is an argument), so every rule here is pinned by post-metrics.test.ts and the routes (metrics.controller.ts) only read and write.
//
// THE NUMBERS ARE NEVER INVENTED. A counter that nobody reported is `null`, never 0 (metrics-job.ts: "we do not know" is not "zero happened").
// Summing two variants adds what each reported; a counter no variant reported stays null.
//
// ONE SNAPSHOT PER VARIANT. A post has one variant per network. The post's numbers are each variant's NEWEST snapshot, summed. The newest is the
// one with the latest `fetched_at` (the row's capture time: the nightly pull's run time, or the `capturedAt` a person typed in), ties broken by
// creation then id, in SQL (metrics.controller.ts).
//
// THE RATE. engagementRate = (likes + comments + saves + shares) / reach, null without a reach (null, or 0: nothing to divide by). A counter
// not reported counts as 0 in the numerator (the rate is of what is known). Only variants that REPORT a reach are in a post's rate, numerator
// and denominator both: a pulled variant with likes but no reach would otherwise inflate the numerator of a sum whose reach it never entered.
//
// THE BOOST CANDIDATE. A post is one when its rate is at least `factor` (social_settings.boost_candidate_factor, default 1.25) times the mean
// per-post rate of the same client's OTHER live posts that went live in the last 90 days and have a rate. False when either is null.
import { BadRequestException } from "@nestjs/common";

export const METRIC_SOURCES = ["pull", "manual", "simulated"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

/** The counters a snapshot carries besides `reach`, in the body's camelCase (columns: `video_views` for `videoViews`). */
export const OPTIONAL_COUNTERS = ["impressions", "likes", "comments", "shares", "saves", "videoViews", "clicks"] as const;
export type Counter = "reach" | (typeof OPTIONAL_COUNTERS)[number];

/** The `integer` columns' ceiling: a larger count is a 400, never a database error. */
export const MAX_COUNT = 2_147_483_647;
/** A `capturedAt` up to this far ahead of the server clock is accepted (clock skew between the person's device and ours). */
export const CAPTURED_AT_SKEW_MS = 5 * 60 * 1000;
/** The window of the account average: posts that went live this many days back or later. */
export const AVERAGE_WINDOW_DAYS = 90;
/** The factor when the company has no `social_settings` row (the column's own default). */
export const DEFAULT_BOOST_FACTOR = 1.25;

const invalid = (field: string): never => { throw new BadRequestException({ message: "invalid_field", field }); };
const missing = (field: string): never => { throw new BadRequestException({ message: "missing_field", field }); };

export interface ManualMetrics {
  capturedAt: Date;
  reach: number;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  clicks: number | null;
}

// `YYYY-MM-DDTHH:MM[:SS[.fff]]` and an explicit zone: a time with no zone is ambiguous, so it is refused.
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** PURE. A real ISO date-time with a zone as a Date, or null: the calendar day must exist (no 30 February) and the clock be a real time of day. */
export function parseDateTime(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = DATE_TIME_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  if (m[7] !== "Z") {
    const [oh, om] = m[7].slice(1).split(":").map(Number);
    if (oh > 23 || om > 59) return null;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/** PURE. A whole number from 0 to `MAX_COUNT`, else null (a string, a fraction, a negative, NaN and Infinity are all refused). */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null);

/**
 * PURE. The request body of `POST variants/:variantId/metrics`, or 400 `{field}`: `capturedAt` a real date-time not more than five minutes
 * ahead of `now`, `reach` required, every other counter optional (absent or null is "not reported"), each a whole number from 0. The first
 * bad field in the body's own order is the one named.
 */
export function parseMetricsBody(body: unknown, now: Date): ManualMetrics {
  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (b.capturedAt === undefined || b.capturedAt === null) missing("capturedAt");
  const at = parseDateTime(b.capturedAt);
  if (!at || at.getTime() > now.getTime() + CAPTURED_AT_SKEW_MS) invalid("capturedAt");
  if (b.reach === undefined || b.reach === null) missing("reach");
  const reach = count(b.reach);
  if (reach === null) invalid("reach");
  const out: ManualMetrics = { capturedAt: at as Date, reach: reach as number, impressions: null, likes: null, comments: null, shares: null, saves: null, videoViews: null, clicks: null };
  for (const k of OPTIONAL_COUNTERS) {
    const v = b[k];
    if (v === undefined || v === null) continue;
    const n = count(v);
    if (n === null) invalid(k);
    out[k] = n;
  }
  return out;
}

/** One variant's newest snapshot, as the SQL reads it: every counter nullable. */
export interface Snapshot {
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  clicks: number | null;
  source: MetricSource;
  capturedAt: Date;
}

/** The sum of what each reported, or null when none did. */
function sumKnown(values: ReadonlyArray<number | null>): number | null {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
}

export interface PostLatest {
  reach: number | null;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  videoViews: number | null;
  source: MetricSource;
  capturedAt: Date;
}

/**
 * PURE. A post's `latest`: its variants' newest snapshots summed, or null with none. `source` is `simulated` if any snapshot is, else `manual`
 * if any is, else `pull`; `capturedAt` is the newest of them.
 */
export function combineSnapshots(snaps: readonly Snapshot[]): PostLatest | null {
  if (snaps.length === 0) return null;
  const sum = (k: Counter) => sumKnown(snaps.map((s) => s[k]));
  const source: MetricSource = snaps.some((s) => s.source === "simulated") ? "simulated" : snaps.some((s) => s.source === "manual") ? "manual" : "pull";
  const capturedAt = new Date(Math.max(...snaps.map((s) => s.capturedAt.getTime())));
  return {
    reach: sum("reach"), impressions: sum("impressions"), likes: sum("likes"), comments: sum("comments"), shares: sum("shares"),
    saves: sum("saves"), clicks: sum("clicks"), videoViews: sum("videoViews"), source, capturedAt,
  };
}

/** PURE. (likes + comments + saves + shares) / reach: null without a reach (null or 0). An unreported counter counts as 0. */
export function engagementRate(s: Pick<Snapshot, "reach" | "likes" | "comments" | "saves" | "shares">): number | null {
  if (s.reach === null || s.reach <= 0) return null;
  return ((s.likes ?? 0) + (s.comments ?? 0) + (s.saves ?? 0) + (s.shares ?? 0)) / s.reach;
}

/**
 * PURE. One post's rate from its variants' snapshots: the engagements of the variants that report a reach over their reach, null when none does.
 * (The post's displayed `latest` sums every variant; the RATE keeps to the variants that have a reach, so a counter with no reach behind it never
 * lifts the rate.)
 */
export function postRate(snaps: readonly Snapshot[]): number | null {
  const withReach = snaps.filter((s) => s.reach !== null && s.reach > 0);
  if (withReach.length === 0) return null;
  const reach = withReach.reduce((n, s) => n + (s.reach as number), 0);
  const engaged = withReach.reduce((n, s) => n + (s.likes ?? 0) + (s.comments ?? 0) + (s.saves ?? 0) + (s.shares ?? 0), 0);
  return engaged / reach;
}

/** PURE. The mean of the posts' rates that have one, or null when none has. */
export function meanRate(rates: ReadonlyArray<number | null>): number | null {
  const known = rates.filter((r): r is number => r !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
}

/** PURE. At least `factor` times the average; false when either side is null (nothing to compare). A rate that equals the bar IS a candidate. */
export function isBoostCandidate(rate: number | null, average: number | null, factor: number): boolean {
  if (rate === null || average === null) return false;
  // A small tolerance for binary floating point: 0.05 against 0.04 x 1.25 is the bar exactly, and must count as meeting it.
  return rate + 1e-12 >= average * factor;
}

/** The rate and averages are answered to six decimals: a ratio, not a percentage (the page shows 100 x). */
export const round6 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e6) / 1e6);
