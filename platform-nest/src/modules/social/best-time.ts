// SMM-27 — best-time-to-post: a CLASSICAL STATS computation over SMM-21's own tables
// (`social_post_variants.published_at` + `social_post_metrics`). Deliberately NOT an AI ticket —
// no gateway call, no model, no prompt. See this file's header for the method and the clock.
//
// ── THE HARDEST CONSTRAINT: THERE IS NO DATA, AND WON'T BE SOON (D-23) ────────────────────────────
// Every platform credential in the estate is empty; no account is connected, no post has ever
// published, `social_post_metrics` is empty and stays empty until staging. A best-time
// recommendation is a claim about OBSERVED engagement — with zero observations, "post at 9am" would
// be a confident fabrication wearing a UI affordance. So `BestTimeResult['status']` is not a
// boolean: it is THREE distinct facts, `capabilities.ts`'s own discipline applied to a statistic
// instead of a capability —
//   'unsupported'            — the resolved driver for this account's network does not advertise
//                               `post_metrics` at all. No amount of waiting produces a suggestion.
//   'insufficient_evidence'  — the driver COULD report engagement, but fewer measured posts exist
//                               than `config.social.bestTime.minMeasuredPosts` (or the single best
//                               hour bucket did not itself reach `minBucketPosts`) — see config.ts
//                               for the documented rationale behind both thresholds.
//   'suggested'              — a real answer, backed by real counts.
// A chip/consumer MUST render 'insufficient_evidence' and 'unsupported' as distinct, honest,
// non-numeric states — never as an empty string and never as a time.
//
// ── THE METHOD ──────────────────────────────────────────────────────────────────────────────────
// For one connected account: take every PUBLISHED variant in the lookback window, join each to its
// LATEST `social_post_metrics` snapshot (append-only history — "latest" is our best current estimate
// of a post's settled engagement, the same reasoning the Analytics tab uses to read this table).
// A variant with NO snapshot yet, or a snapshot where every interaction field is NULL, is EXCLUDED
// from the sample entirely — an absent counter means "not yet measured", never "zero happened"
// (`metrics-job.ts`'s own "no invented numbers" rule, applied here to sample membership rather than
// a single field). For each measured post, its ENGAGEMENT SCORE is the sum of whichever of
// likes/comments/shares/saves/clicks it does carry (NULL fields coalesced to 0 only WITHIN this
// derived sum, since the post already cleared the "at least one real field" gate above — this is a
// ranking aggregate, not a claim that any one field reads zero). Posts are bucketed by the UTC hour
// of `published_at` (see below), and the bucket with the highest AVERAGE score, among buckets
// meeting `minBucketPosts`, is the suggestion.
//
// ── THE CLOCK: UTC, NOT LOCAL, AND NOT THE SESSION TIMEZONE ────────────────────────────────────
// "Best time to post" is a wall-clock claim, and this module has already shipped a real timezone
// bug at exactly this seam (SMM-35's `assistant-summary.ts` header: a `date` column parsed by
// node-postgres at local midnight, then shifted a calendar day backward by a later `.toISOString()`
// call). `published_at` here is `timestamptz`, not `date`, so node-pg already returns an
// unambiguous instant — but EXTRACTING an "hour of day" from an instant still requires picking a
// zone, and this schema has NO per-account or per-client timezone column to localize into (checked:
// `social_accounts` carries none). Rather than guess one (which would be exactly this ticket's own
// "fabricated precision" failure mode, pointed at a timezone instead of a sample size), every bucket
// is computed as `EXTRACT(HOUR FROM (published_at AT TIME ZONE 'UTC'))` — deterministic regardless
// of the database session's own `TimeZone` setting or the Node process's `TZ` env var, and never
// silently reinterpreted by a later `.toISOString()`/`.toLocaleString()` call the way the SMM-35 bug
// was. The UI renders this explicitly labelled "UTC" (`REFUSAL_LABELS`/chip copy) rather than
// implying a client-local hour that was never computed — a deliberate, named limitation until a real
// per-account timezone fact exists to localize against.
//
// ── THE MODULE GUC (recurring defect class #1) ─────────────────────────────────────────────────
// Every `social_*` table this file touches carries 0105's third RLS wall,
// `app_module_allowed('social')`, which `withTenants([tenantId])` alone does NOT satisfy. Every
// exported function below calls `declareSocialModuleScope` on its OWN transaction before touching a
// row — delete any one call and that function's query reads ZERO ROWS, SILENTLY, which for THIS
// ticket is the worst possible failure: a stats job computing over a silently-empty set would still
// return a definite verdict (0 measured posts < any positive threshold => insufficient_evidence),
// making the bug LOOK like the honest "no data yet" state instead of screaming that something is
// broken. `best-time.test.ts`'s "(module GUC)" tests prove this the same way `metrics-job.test.ts`
// does: call the exported function on a transaction with NO `{modules:['social']}` option and assert
// a REAL row/count exists afterward — it fails outright (not merely "reads insufficient_evidence")
// if the declaration is ever removed, because the regression seeds ENOUGH rows to clear every
// threshold and asserts the resulting status is 'suggested', not merely present.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { declareSocialModuleScope } from "./module-scope";
import { openOrg, type PublisherOrgRow } from "./publisher/provisioning";
import { config } from "../../config";

export type BestTimeStatus = "insufficient_evidence" | "unsupported" | "suggested";

export interface BestTimeResult {
  status: BestTimeStatus;
  bestHourUtc: number | null;
  bestHourSampleSize: number | null;
  totalMeasuredPosts: number;
  avgEngagementScore: number | null;
  minMeasuredPostsThreshold: number;
  minBucketPostsThreshold: number;
  lookbackDays: number;
  /** Full per-hour breakdown, our own derived aggregate — never engine-reported. */
  raw: Record<string, { count: number; avgScore: number }>;
}

interface MeasuredPostRow {
  published_at: string;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
}

async function loadAccountOrg(c: PoolClient, accountId: string): Promise<{ orgRow: PublisherOrgRow | null; network: string } | null> {
  const { rows } = await c.query<{ network: string; org_id: string }>(
    `SELECT network, publisher_org_id AS org_id FROM social_accounts
      WHERE id = $1 AND deleted_at IS NULL`,
    [accountId],
  );
  const acct = rows[0];
  if (!acct) return null;
  const { rows: orgRows } = await c.query<PublisherOrgRow>(
    `SELECT id, client_id AS "clientId", driver, postiz_org_id AS "postizOrgId",
            api_key_ref AS "apiKeyRef", status
       FROM social_publisher_orgs WHERE id = $1 AND deleted_at IS NULL`,
    [acct.org_id],
  );
  return { orgRow: orgRows[0] ?? null, network: acct.network };
}

async function loadMeasuredPosts(c: PoolClient, accountId: string, lookbackDays: number): Promise<MeasuredPostRow[]> {
  const { rows } = await c.query<MeasuredPostRow>(
    `SELECT v.published_at, m.likes, m.comments, m.shares, m.saves, m.clicks
       FROM social_post_variants v
       JOIN LATERAL (
         SELECT likes, comments, shares, saves, clicks
           FROM social_post_metrics pm
          WHERE pm.variant_id = v.id
          ORDER BY pm.fetched_at DESC
          LIMIT 1
       ) m ON true
      WHERE v.account_id = $1 AND v.status = 'published' AND v.deleted_at IS NULL
        AND v.published_at IS NOT NULL
        AND v.published_at >= now() - make_interval(days => $2::int)
        -- at least one real interaction field — an all-NULL snapshot means "not yet measured",
        -- never "zero engagement" (see file header).
        AND (m.likes IS NOT NULL OR m.comments IS NOT NULL OR m.shares IS NOT NULL
             OR m.saves IS NOT NULL OR m.clicks IS NOT NULL)`,
    [accountId, lookbackDays],
  );
  return rows;
}

/** Pure arithmetic — no I/O — kept separate from the DB read so the bucketing/threshold logic is
 *  independently unit-testable against hand-built fixtures, not only DB-seeded ones. */
export function computeBestTimeFromRows(
  rows: MeasuredPostRow[],
  opts: { minMeasuredPosts: number; minBucketPosts: number; lookbackDays: number },
): Omit<BestTimeResult, "status"> & { status: "insufficient_evidence" | "suggested" } {
  const buckets = new Map<number, { count: number; sum: number }>();
  for (const r of rows) {
    // UTC hour bucket — see file header for why UTC and not a guessed local zone.
    const hour = new Date(r.published_at).getUTCHours();
    const score = (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0) + (r.saves ?? 0) + (r.clicks ?? 0);
    const b = buckets.get(hour) ?? { count: 0, sum: 0 };
    b.count += 1;
    b.sum += score;
    buckets.set(hour, b);
  }

  const raw: Record<string, { count: number; avgScore: number }> = {};
  for (const [hour, b] of buckets) {
    raw[String(hour)] = { count: b.count, avgScore: b.count > 0 ? b.sum / b.count : 0 };
  }

  const totalMeasuredPosts = rows.length;
  const base = {
    totalMeasuredPosts,
    minMeasuredPostsThreshold: opts.minMeasuredPosts,
    minBucketPostsThreshold: opts.minBucketPosts,
    lookbackDays: opts.lookbackDays,
    raw,
  };

  if (totalMeasuredPosts < opts.minMeasuredPosts) {
    return { ...base, status: "insufficient_evidence", bestHourUtc: null, bestHourSampleSize: null, avgEngagementScore: null };
  }

  // Among buckets that themselves clear minBucketPosts, pick the highest average score. A tie is
  // broken by the EARLIEST hour (deterministic, never by insertion/Map iteration order, which V8
  // happens to preserve for small integer keys but which this file does not want to depend on).
  let best: { hour: number; count: number; avg: number } | null = null;
  for (const [hour, b] of buckets) {
    if (b.count < opts.minBucketPosts) continue;
    const avg = b.sum / b.count;
    if (!best || avg > best.avg || (avg === best.avg && hour < best.hour)) {
      best = { hour, count: b.count, avg };
    }
  }

  if (!best) {
    return { ...base, status: "insufficient_evidence", bestHourUtc: null, bestHourSampleSize: null, avgEngagementScore: null };
  }

  return {
    ...base,
    status: "suggested",
    bestHourUtc: best.hour,
    bestHourSampleSize: best.count,
    avgEngagementScore: best.avg,
  };
}

/** One account's read + compute. Declares its own module scope (see file header). Returns
 *  'unsupported' if the account cannot be resolved to an org/driver, or the resolved driver does
 *  not advertise `post_metrics` — checked BEFORE querying `social_post_metrics` (the same
 *  "unsupported vs empty" discipline `inbox-sync-job.ts` applies to `inbox_read`). */
export async function computeAccountBestTime(tenantId: string, accountId: string, now: Date = new Date()): Promise<BestTimeResult> {
  const { lookbackDays, minMeasuredPosts, minBucketPosts } = config.social.bestTime;

  const resolved = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadAccountOrg(c, accountId);
  });

  const unsupportedBase = {
    bestHourUtc: null, bestHourSampleSize: null, totalMeasuredPosts: 0, avgEngagementScore: null,
    minMeasuredPostsThreshold: minMeasuredPosts, minBucketPostsThreshold: minBucketPosts,
    lookbackDays, raw: {},
  } as const;

  if (!resolved || !resolved.orgRow) {
    return { status: "unsupported", ...unsupportedBase };
  }
  const { driver } = openOrg(resolved.orgRow);
  if (!driver.capabilities.has("post_metrics")) {
    return { status: "unsupported", ...unsupportedBase };
  }

  const rows = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadMeasuredPosts(c, accountId, lookbackDays);
  });

  void now; // reserved for a future "as-of" override in tests; today() is implicit in the SQL `now()`
  return computeBestTimeFromRows(rows, { minMeasuredPosts, minBucketPosts, lookbackDays });
}

/** Upsert the cached verdict (own transaction, own declared scope). One row per account — a re-run
 *  REPLACES the prior verdict, mirroring `social_metrics_daily`'s own per-day upsert reasoning. */
export async function applyBestTimeSuggestion(tenantId: string, accountId: string, result: BestTimeResult): Promise<void> {
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    await c.query(
      `INSERT INTO social_best_time_suggestions
         (tenant_id, account_id, status, best_hour_utc, best_hour_sample_size,
          total_measured_posts, avg_engagement_score, min_measured_posts_threshold,
          min_bucket_posts_threshold, lookback_days, raw, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT (account_id) DO UPDATE SET
         status = EXCLUDED.status, best_hour_utc = EXCLUDED.best_hour_utc,
         best_hour_sample_size = EXCLUDED.best_hour_sample_size,
         total_measured_posts = EXCLUDED.total_measured_posts,
         avg_engagement_score = EXCLUDED.avg_engagement_score,
         min_measured_posts_threshold = EXCLUDED.min_measured_posts_threshold,
         min_bucket_posts_threshold = EXCLUDED.min_bucket_posts_threshold,
         lookback_days = EXCLUDED.lookback_days, raw = EXCLUDED.raw,
         computed_at = now(), updated_at = now()`,
      [
        tenantId, accountId, result.status, result.bestHourUtc, result.bestHourSampleSize,
        result.totalMeasuredPosts, result.avgEngagementScore, result.minMeasuredPostsThreshold,
        result.minBucketPostsThreshold, result.lookbackDays, JSON.stringify(result.raw),
      ],
    );
  });
}

/** Read the cached verdict. `null` means the sweep has never run for this account yet — a FOURTH,
 *  distinct fact from any of the three computed statuses ("nobody has looked" vs "looked, and here
 *  is what was found"), surfaced by the controller as its own `not_yet_computed` token rather than
 *  silently defaulting to `insufficient_evidence` (which would claim a look already happened). */
export async function getCachedBestTime(tenantId: string, accountId: string): Promise<(BestTimeResult & { computedAt: string }) | null> {
  return withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const { rows } = await c.query<{
      status: BestTimeStatus; best_hour_utc: number | null; best_hour_sample_size: number | null;
      total_measured_posts: number; avg_engagement_score: string | null;
      min_measured_posts_threshold: number; min_bucket_posts_threshold: number;
      lookback_days: number; raw: Record<string, { count: number; avgScore: number }>;
      computed_at: string;
    }>(
      `SELECT status, best_hour_utc, best_hour_sample_size, total_measured_posts,
              avg_engagement_score, min_measured_posts_threshold, min_bucket_posts_threshold,
              lookback_days, raw, computed_at
         FROM social_best_time_suggestions WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      status: row.status,
      bestHourUtc: row.best_hour_utc,
      bestHourSampleSize: row.best_hour_sample_size,
      totalMeasuredPosts: row.total_measured_posts,
      avgEngagementScore: row.avg_engagement_score === null ? null : Number(row.avg_engagement_score),
      minMeasuredPostsThreshold: row.min_measured_posts_threshold,
      minBucketPostsThreshold: row.min_bucket_posts_threshold,
      lookbackDays: row.lookback_days,
      raw: row.raw,
      computedAt: row.computed_at,
    };
  });
}
