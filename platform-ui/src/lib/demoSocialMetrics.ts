import "server-only";
// SCP-3c (BFF §63.10 "Metrics", §63.16) — what DEMO_MODE answers for a post's metrics, from the demo pipeline store (`demoSocialPipeline.ts`):
//
//   GET  posts/:postId/metrics        the post's numbers, rate, the client's average and the boost mark (the server's maths: `socialMetrics.ts`)
//   POST variants/:variantId/metrics  the officer types one snapshot in (201 with the stored row)
//
// A variant's id in the demo is `<post id>-v-<network>` (`variantsOf`), so a variant finds its post by that prefix. The snapshots are this file's own store, pinned to
// globalThis like the other demo stores, and seeded once from the live posts that hold demo numbers (`PipePost.metrics`): the seeded rows are what the officer would have typed
// in (the nightly pull supplies no reach), with ONE pulled row without a reach (the null case) and the simulated hotel post's marked simulated. The demo's live posts are shaped so
// "A day in the warehouse" (Northwind Traders) is a boost candidate: its rate is about twice the client's other posts'. Nothing here is a real client, person or number.
//
// The server's order of checks: an unknown variant or post is 404 `post_not_found` first; then authorization (a client contact is refused, and `schedule` is the client's officer's
// own, so only the officer and the superadmin pass); then a Composer post (409 `not_a_pipeline_post`, GET only: a Composer post has no variants here); then the body (400 `{field}`);
// then 409 `post_not_live`. Authorization before validation: a refused caller never gets a 400.
import {
  AVERAGE_WINDOW_DAYS, CAPTURED_AT_SKEW_MS, COUNTERS, MAX_COUNT, combineSnapshots, isBoostCandidate, meanRate, postRate, round6,
  type Counter, type MetricSource, type Snapshot,
} from "./socialMetrics";
import {
  PIPE_ENGAGEMENTS, PIPE_POSTS, allocStore, cerbosAllows, cyclesStore, isClientContact, type DemoResult, type PipePost,
} from "./demoSocialPipeline";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const DAY_MS = 86_400_000;

interface Row extends Snapshot { id: string; variantId: string; postId: string; enteredBy: string | null; seq: number }
interface MetricsStore { rows: Row[]; seq: number }
const KEY = Symbol.for("gaiada.demo.social.metrics");

/** The demo's invented rates, by client (the order of `PIPE_ENGAGEMENTS`) and by that client's live posts in the store's order; `null` is the pulled row with no reach. */
const RATE_PROFILE: ReadonlyArray<ReadonlyArray<number | null>> = [
  [0.032, 0.071, null, 0.04], // Northwind Traders: the second post is about twice the others
  [0.031, 0.034], // the spa: the posts sit at the client's own average
  [0.045], // the hotel: one simulated post, so no average to compare with
];

const variantId = (p: PipePost, network: string): string => `${p.id}-v-${network}`;
const findVariant = (id: string): { post: PipePost; network: string } | null => {
  for (const p of PIPE_POSTS) {
    for (const network of p.placement) if (variantId(p, network) === id) return { post: p, network };
  }
  return null;
};

function seed(): MetricsStore {
  const store: MetricsStore = { rows: [], seq: 0 };
  const capturedAt = new Date(Date.now() - 36 * 3_600_000);
  PIPE_ENGAGEMENTS.forEach((e, ei) => {
    const live = PIPE_POSTS.filter((p) => p.engagementId === e.id && p.pipelineStatus === "live" && p.metrics !== null);
    live.forEach((p, i) => {
      const profile = RATE_PROFILE[ei] ?? [];
      const rate = i < profile.length ? profile[i] : 0.035; // a `null` entry is the pulled row (no reach), not a missing one
      const m = p.metrics!;
      const n = p.placement.length || 1;
      const engaged = rate === null ? 0 : Math.round(rate * m.reach);
      const likes = Math.round(engaged * 0.78);
      const comments = Math.round(engaged * 0.06);
      const shares = Math.round(engaged * 0.04);
      const saves = engaged - likes - comments - shares;
      const share = (total: number, k: number): number => Math.floor(total / n) + (k === 0 ? total - Math.floor(total / n) * n : 0);
      const source: MetricSource = p.simulated ? "simulated" : rate === null ? "pull" : "manual";
      p.placement.forEach((network, k) => {
        store.seq += 1;
        store.rows.push({
          id: `demo-metric-${store.seq}`, variantId: variantId(p, network), postId: p.id, enteredBy: source === "manual" ? allocStore.byEngagement[e.id]?.officerId ?? null : null, seq: store.seq,
          // A pulled snapshot carries no reach: the engine does not report it (metrics-job.ts).
          reach: rate === null ? null : share(m.reach, k), impressions: share(m.impressions, k),
          likes: rate === null ? share(m.likes, k) : share(likes, k), comments: rate === null ? share(m.comments, k) : share(comments, k),
          shares: rate === null ? share(m.shares, k) : share(shares, k), saves: rate === null ? share(m.saves, k) : share(saves, k),
          clicks: null, videoViews: null, source, capturedAt,
        });
      });
    });
  });
  return store;
}
const store = (): MetricsStore => ((globalThis as Record<symbol, unknown>)[KEY] ??= seed()) as MetricsStore;

/** The newest snapshot of each variant of `p`, as `Snapshot`s. */
function newestPerVariant(p: PipePost): Snapshot[] {
  const out: Snapshot[] = [];
  for (const network of p.placement) {
    const mine = store().rows.filter((r) => r.variantId === variantId(p, network));
    if (mine.length === 0) continue;
    out.push(mine.reduce((a, b) => (b.capturedAt.getTime() > a.capturedAt.getTime() || (b.capturedAt.getTime() === a.capturedAt.getTime() && b.seq > a.seq) ? b : a)));
  }
  return out;
}

// ── GET posts/:postId/metrics ──────────────────────────────────────────────────────────────────────────────────────────────────

function readMetrics(postId: string, userId: string, isComposerPost: (id: string) => boolean): DemoResult {
  const p = PIPE_POSTS.find((x) => x.id === postId);
  if (!p && !isComposerPost(postId)) return err(404, "post_not_found");
  if (isClientContact(userId)) return err(403, "not authorized: cerbos denied read on social_post");
  if (!p) return err(409, "not_a_pipeline_post");

  const mine = newestPerVariant(p);
  const latest = combineSnapshots(mine);
  const rate = postRate(mine);
  const since = Date.now() - AVERAGE_WINDOW_DAYS * DAY_MS;
  const peers = PIPE_POSTS.filter((x) => x.id !== p.id && x.engagementId === p.engagementId && x.pipelineStatus === "live" && !x.archivedAt && !!x.wentLiveAt && Date.parse(x.wentLiveAt) >= since);
  const average = meanRate(peers.map((x) => postRate(newestPerVariant(x))));
  return {
    status: 200,
    json: {
      latest: latest && {
        reach: latest.reach, impressions: latest.impressions, likes: latest.likes, comments: latest.comments, shares: latest.shares, saves: latest.saves,
        clicks: latest.clicks, videoViews: latest.videoViews, source: latest.source, capturedAt: latest.capturedAt.toISOString(),
      },
      engagementRate: round6(rate), accountAverageRate: round6(average),
      boostCandidate: isBoostCandidate(rate, average, cyclesStore.boostCandidateFactor),
      simulated: p.simulated || latest?.source === "simulated",
    },
  };
}

// ── POST variants/:variantId/metrics ───────────────────────────────────────────────────────────────────────────────────────────

const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** The server's rule for a capture time: a real date-time with a zone (no 30 February, no 24:00), as an instant, or null. */
export function demoParseDateTime(v: unknown): Date | null {
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
const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;

function enterMetrics(variant: string, rawBody: string | undefined, userId: string): DemoResult {
  const found = findVariant(variant);
  if (!found) return err(404, "post_not_found");
  const p = found.post;
  // `schedule` is the client's officer's own rule (the superadmin's wildcard aside); a client contact is never staff.
  if (isClientContact(userId) || !cerbosAllows("schedule", userId, p)) return err(403, "not authorized: cerbos denied schedule on social_post");

  let b: Record<string, unknown> = {};
  try { const j = rawBody ? JSON.parse(rawBody) : {}; if (j && typeof j === "object" && !Array.isArray(j)) b = j as Record<string, unknown>; } catch { /* an unreadable body is an empty one */ }
  if (b.capturedAt === undefined || b.capturedAt === null) return err(400, "missing_field", { field: "capturedAt" });
  const at = demoParseDateTime(b.capturedAt);
  if (!at || at.getTime() > Date.now() + CAPTURED_AT_SKEW_MS) return err(400, "invalid_field", { field: "capturedAt" });
  if (b.reach === undefined || b.reach === null) return err(400, "missing_field", { field: "reach" });
  const values: Record<Counter, number | null> = { reach: null, impressions: null, likes: null, comments: null, shares: null, saves: null, clicks: null, videoViews: null };
  for (const k of ["reach", "impressions", "likes", "comments", "shares", "saves", "videoViews", "clicks"] as const) {
    const v = b[k];
    if (v === undefined || v === null) continue;
    if (!whole(v)) return err(400, "invalid_field", { field: k });
    values[k] = v;
  }
  if (p.pipelineStatus !== "live") return err(409, "post_not_live");

  const s = store();
  s.seq += 1;
  const row: Row = { id: `demo-metric-${s.seq}`, variantId: variant, postId: p.id, enteredBy: userId, seq: s.seq, source: "manual", capturedAt: at, ...values };
  s.rows.push(row);
  // The post now has numbers: the officer's "metrics missing" item on Needs you clears (the store's own flag).
  if (p.metrics === null) {
    const l = combineSnapshots(newestPerVariant(p));
    p.metrics = { impressions: l?.impressions ?? 0, reach: l?.reach ?? 0, likes: l?.likes ?? 0, comments: l?.comments ?? 0, shares: l?.shares ?? 0, saves: l?.saves ?? 0 };
  }
  return {
    status: 201,
    json: {
      id: row.id, variantId: variant, postId: p.id, source: "manual", capturedAt: at.toISOString(), ...Object.fromEntries(COUNTERS.map((k) => [k, values[k]])), enteredBy: userId,
    },
  };
}

/** Routes the two metrics routes of `/api/:t/modules/social/*` (the `tail` after `modules/social/`); null when the tail is neither. */
export function demoSocialMetrics(method: string, tail: string, body: string | undefined, userId: string, isComposerPost: (id: string) => boolean): DemoResult | null {
  const m = method.toUpperCase();
  const read = tail.match(/^posts\/([^/]+)\/metrics$/);
  if (read && m === "GET") return readMetrics(read[1], userId, isComposerPost);
  const write = tail.match(/^variants\/([^/]+)\/metrics$/);
  if (write && m === "POST") return enterMetrics(write[1], body, userId);
  return null;
}
