// SCP-3c — a Social Media post's metrics: the types, the defensive parsing and the pure helpers of the post page's Metrics block (BFF §63.10 "Metrics"). No server-only
// import, so a client component may import the values.
//
// The reader (`GET posts/:postId/metrics`) is `readPostMetrics` in `lib/socialPipeline-data.ts` (server-only, `ReadResult`), the writes are `enterPostMetrics` and
// `loadPostMetrics` in `lib/socialPipelineActions.ts` ("use server"); DEMO_MODE answers both routes from `lib/demoSocialMetrics.ts`. The answer is parsed defensively
// (`asPostMetrics`): a 200 with the wrong shape must read as "cannot tell", never as a plausible empty block.
//
// THE NUMBERS ARE NEVER INVENTED. A counter the server did not report is null and the page says "Not reported", never 0 (the same rule as the server's metrics-job.ts).
// The rate is a RATIO (0.042 is 4.2%); `formatRate` is the one place that multiplies by a hundred.
//
// THE MATHS TWIN. `combineSnapshots`, `postRate`, `meanRate` and `isBoostCandidate` are the server's rules (platform-nest `pipeline/post-metrics.ts`), kept here only so DEMO_MODE
// answers what the server would. `socialMetrics.test.ts` pins the same golden values as the server's `post-metrics.test.ts`. The server decides every real answer.
import { DISPLAY_TZ } from "./format";
import { isoToZoneInput, zoneInputToIso, type PipelinePost } from "./socialPipeline";

export const METRIC_SOURCES = ["pull", "manual", "simulated"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];
/** How a source reads on the page (BFF §63.0: a simulated row says so on every screen that shows it). */
export const SOURCE_WORDS: Readonly<Record<MetricSource, string>> = { pull: "Pulled", manual: "Typed in", simulated: "Simulated" };

/** The counters of a post's numbers, in the order the page lists them. `reach` is the one the rate divides by. */
export const COUNTERS = ["reach", "impressions", "likes", "comments", "shares", "saves", "clicks", "videoViews"] as const;
export type Counter = (typeof COUNTERS)[number];
export const COUNTER_LABEL: Readonly<Record<Counter, string>> = {
  reach: "Reach", impressions: "Impressions", likes: "Likes", comments: "Comments", shares: "Shares", saves: "Saves", clicks: "Clicks", videoViews: "Video views",
};
/** The largest count the server takes (its integer column). */
export const MAX_COUNT = 2_147_483_647;
/** How far ahead of the clock a capture time may be (the server's clock-skew allowance). */
export const CAPTURED_AT_SKEW_MS = 5 * 60 * 1000;
/** The window of the client's average, in days. */
export const AVERAGE_WINDOW_DAYS = 90;
export const DEFAULT_BOOST_FACTOR = 1.25;

export type Counters = Record<Counter, number | null>;
export interface MetricsLatest extends Counters { source: MetricSource; capturedAt: string }
/** BFF §63.10's answer of `GET posts/:postId/metrics`. */
export interface PostMetrics {
  latest: MetricsLatest | null;
  /** (likes + comments + saves + shares) / reach as a ratio, or null without a reach. */
  engagementRate: number | null;
  /** The mean rate of the client's other live posts of the last 90 days that have one, or null. */
  accountAverageRate: number | null;
  boostCandidate: boolean;
  simulated: boolean;
}
/** The row `POST variants/:variantId/metrics` answers (201). */
export interface StoredMetrics extends Counters { id: string; variantId: string; postId: string; source: "manual"; capturedAt: string; enteredBy: string }

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isSource = (v: unknown): v is MetricSource => typeof v === "string" && (METRIC_SOURCES as readonly string[]).includes(v);

function countersOf(o: Record<string, unknown>): Counters {
  return Object.fromEntries(COUNTERS.map((k) => [k, num(o[k])])) as Counters;
}

/** A `PostMetrics` from a read. Throws on a body that is not one (the reader turns that into "cannot tell"). */
export function asPostMetrics(raw: unknown): PostMetrics {
  if (!isObj(raw) || typeof raw.boostCandidate !== "boolean" || typeof raw.simulated !== "boolean" || !("latest" in raw)) throw new Error("post metrics: not a PostMetrics");
  let latest: MetricsLatest | null = null;
  if (raw.latest !== null) {
    const l = raw.latest;
    if (!isObj(l) || !isSource(l.source) || typeof l.capturedAt !== "string") throw new Error("post metrics: latest is not a snapshot");
    latest = { ...countersOf(l), source: l.source, capturedAt: l.capturedAt };
  }
  return { latest, engagementRate: num(raw.engagementRate), accountAverageRate: num(raw.accountAverageRate), boostCandidate: raw.boostCandidate, simulated: raw.simulated };
}

/** The stored row of a 201. Throws on a body that is not one. */
export function asStoredMetrics(raw: unknown): StoredMetrics {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.variantId !== "string" || typeof raw.capturedAt !== "string") throw new Error("metrics row: not a stored snapshot");
  return {
    ...countersOf(raw), id: raw.id, variantId: raw.variantId, postId: typeof raw.postId === "string" ? raw.postId : "", source: "manual",
    capturedAt: raw.capturedAt, enteredBy: typeof raw.enteredBy === "string" ? raw.enteredBy : "",
  };
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A ratio as a percentage with one decimal ("5.0%"), or "Not known" for none. */
export const formatRate = (r: number | null): string => (r === null ? "Not known" : `${(r * 100).toFixed(1)}%`);
/** A counter with thousands separators, or "Not reported". */
export const formatCount = (n: number | null): string => (n === null ? "Not reported" : n.toLocaleString("en-US"));

/**
 * May the viewer type metrics in (`social_post` · `schedule`, the client's officer)? A live post lists no step in the read's `actions[]` (the page's usual gate), so the
 * officer is found by the read's own `officer` (the engagement's owner, whom Cerbos keys `schedule` to). Cosmetic: the server decides on the write, so a superadmin, who
 * holds every action, is not offered the form by this hint, though the server would take the entry.
 */
export function canEnterMetrics(post: Pick<PipelinePost, "pipelineStatus" | "officer">, viewerId: string | null | undefined): boolean {
  return post.pipelineStatus === "live" && !!viewerId && post.officer?.id === viewerId;
}

// ── The form: input to body ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What the form holds: `capturedAt` as a `datetime-local` value in the display zone, every counter as typed. */
export interface MetricsForm { capturedAt: string; values: Record<Counter, string> }
export const emptyMetricsForm = (now: Date = new Date()): MetricsForm => ({
  capturedAt: isoToZoneInput(now.toISOString(), DISPLAY_TZ), values: Object.fromEntries(COUNTERS.map((k) => [k, ""])) as Record<Counter, string>,
});

export type FieldErrors = Partial<Record<Counter | "capturedAt", string>>;
export type BuiltMetrics = { ok: true; body: Record<string, unknown> } | { ok: false; errors: FieldErrors };

/**
 * The request body from the form, or one sentence per bad field. The server judges the same rules again (a 400 names its `field`), so this only saves the round trip:
 * a capture time that is a real instant not ahead of `now` by more than the skew, `reach` required, a counter a whole number from 0, a blank counter left out.
 */
export function buildMetricsBody(form: MetricsForm, now: Date = new Date()): BuiltMetrics {
  const errors: FieldErrors = {};
  const iso = zoneInputToIso(form.capturedAt);
  if (!iso) errors.capturedAt = "Choose when these numbers were read.";
  else if (Date.parse(iso) > now.getTime() + CAPTURED_AT_SKEW_MS) errors.capturedAt = "These numbers cannot be from the future.";
  const body: Record<string, unknown> = {};
  for (const k of COUNTERS) {
    const raw = form.values[k].trim();
    if (raw === "") {
      if (k === "reach") errors.reach = "Reach is required: the engagement rate divides by it.";
      continue;
    }
    if (!/^\d{1,10}$/.test(raw) || Number(raw) > MAX_COUNT) errors[k] = `${COUNTER_LABEL[k]} must be a whole number from 0.`;
    else body[k] = Number(raw);
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { capturedAt: iso, ...body } };
}

// ── The maths twin (DEMO_MODE only) ─────────────────────────────────────────────────────────────────────────────────────────

export interface Snapshot extends Counters { source: MetricSource; capturedAt: Date }
const sumKnown = (values: ReadonlyArray<number | null>): number | null => {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
};

/** A post's `latest`: each variant's newest snapshot summed (a counter nobody reported stays null); the source is simulated if any is, else manual, else pull. */
export function combineSnapshots(snaps: readonly Snapshot[]): (Counters & { source: MetricSource; capturedAt: Date }) | null {
  if (snaps.length === 0) return null;
  const sums = Object.fromEntries(COUNTERS.map((k) => [k, sumKnown(snaps.map((s) => s[k]))])) as Counters;
  const source: MetricSource = snaps.some((s) => s.source === "simulated") ? "simulated" : snaps.some((s) => s.source === "manual") ? "manual" : "pull";
  return { ...sums, source, capturedAt: new Date(Math.max(...snaps.map((s) => s.capturedAt.getTime()))) };
}

/** One post's rate: the engaged over the reach of the variants that report a reach, null when none does. */
export function postRate(snaps: readonly Snapshot[]): number | null {
  const withReach = snaps.filter((s) => s.reach !== null && s.reach > 0);
  if (withReach.length === 0) return null;
  const reach = withReach.reduce((n, s) => n + (s.reach as number), 0);
  const engaged = withReach.reduce((n, s) => n + (s.likes ?? 0) + (s.comments ?? 0) + (s.saves ?? 0) + (s.shares ?? 0), 0);
  return engaged / reach;
}

export const meanRate = (rates: ReadonlyArray<number | null>): number | null => {
  const known = rates.filter((r): r is number => r !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
};

/** At least `factor` times the average; false when either is null. */
export const isBoostCandidate = (rate: number | null, average: number | null, factor: number): boolean =>
  rate !== null && average !== null && rate + 1e-12 >= average * factor;

export const round6 = (n: number | null): number | null => (n === null ? null : Math.round(n * 1e6) / 1e6);
