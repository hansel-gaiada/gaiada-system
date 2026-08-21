// SMM-38 phase 38d (design addendum §PD) — YouTube's quota ACCOUNTING, against the three real
// buckets SMM-37 already modelled on `QuotaSnapshot.youtubeQuota` (`media-rules.ts`) and the
// dossier's own measured regime (`docs/blueprints/smm-app-review-dossier.md` §6.4, quoted verbatim
// there): 100 `search.list` calls/day, 100 `videos.insert` calls/day, and a SEPARATE 10,000-unit/day
// pool for every other Data API call. These are NOT one pool — `media-rules.ts`'s own header already
// names the trap this file must not reintroduce (the old `{"youtubeUnitsToday":1600}` single-pool
// model), and `checkQuota` already reads `videosInsertCallsToday` as the bucket that gates an
// upload, never `otherUnitsToday`.
//
// ── WHY THIS IS ACCOUNTING, NOT A LIVE PROBE — AND WHY THAT IS THE HONEST ANSWER FOR YOUTUBE ──────
// `SocialPublisher.getQuota`'s own doc (types.ts) forbids a driver from ever SYNTHESIZING A CAP —
// that rule was written for Instagram, where the cap itself is a live, per-account, Meta-side fact
// (`GET /<IG_ID>/content_publishing_limit`) that genuinely varies and must be asked for. YouTube is
// the opposite shape on BOTH halves:
//   (a) there is no live "how much of my quota is left" endpoint anywhere in the Data API —
//       UNVERIFIED whether one exists at all, and the dossier's own research pass (§6) names none —
//       so there is nothing to probe.
//   (b) the CAP itself is not a per-account fact but a per-Google-Cloud-PROJECT default, published
//       as a fixed number in Google's own docs (§6.4, quoted there) and identical for every channel
//       this ONE deployment's ONE OAuth app touches (the dossier's own §6.5 finding: "the binding
//       constraint is 100 video uploads/day across the ENTIRE FLEET, not per client").
// So the cap here is a CITED, DOCUMENTED CONSTANT — not the same failure class the Instagram warning
// names — while the USED count is something nobody but THIS PROCESS can know, because Google exposes
// no read for it: we account for our own calls, or we do not know, exactly the "unknown is not zero"
// doctrine `media-rules.ts` already enforces on the read side. A fresh day (or a fresh process)
// starts every bucket at `used: 0`, which is a TRUE fact ("no calls observed"), never a guess dressed
// up as a measurement — "quota measured not assumed" (38d's own exit criterion), read literally.
//
// ── THE NAMED LIMITATION, AS 38d LEFT IT: PER-PROCESS, IN-MEMORY, NOT DURABLE ───────────────────────
// This counter lived in a module-level Map, not a table. Two consequences:
//   1. It resets on a process restart, so a deployment that restarts mid-day loses its count and
//      starts the day looking emptier than it actually is.
//   2. It does not share state across multiple Node instances behind a load balancer, so a
//      multi-instance deployment would UNDERcount (each instance only sees its own calls).
// 38d left this as a named follow-up rather than building a table unilaterally, because nothing on a
// live path called `recordYouTubeQuotaUsage` yet.
//
// ── GAP 3, CLOSED IN 38e: A `YouTubeQuotaStore` SEAM + A DURABLE, GLOBAL-TABLE IMPLEMENTATION ──────
// 38e's own dispatch wiring (`provisioning.ts#resolveDispatchOrgHandle`) makes `direct` reachable
// from a real dispatch call for the first time (LinkedIn today; YouTube's `media_upload` is capable
// of being routed the same way, once a future pass resolves the upload-is-publish collision named in
// that function's own header) — so this counter stops being "verified inert" the moment an operator
// sets the right override, and an under-reporting counter that resets on restart is exactly the kind
// of silent failure that gets this deployment's ONE shared Google Cloud project throttled with no
// warning. The fix is a SEAM, not a hard rewrite: `YouTubeQuotaStore` below is the interface
// `direct.ts` now calls through; `defaultYouTubeQuotaStore()` wraps the ORIGINAL module-level
// functions below byte-for-byte (so every existing call site and every existing test — including
// `resetYouTubeQuotaUsage()`'s own seam — keeps working with ZERO changes), and
// `createDbYouTubeQuotaStore()` is the durable, cross-instance-safe implementation `boot.ts` wires in
// for the real app. The in-memory functions are NOT deleted or hidden — they remain this file's
// documented default and the thing every unit test in this module still exercises directly.
//
// ── WHY A GLOBAL TABLE, NOT A PER-TENANT ONE ────────────────────────────────────────────────────────
// The dossier's own finding (§6.5, quoted in this file's header above): the 100-upload/day cap binds
// per Google-Cloud PROJECT, i.e. per DEPLOYMENT, shared across every tenant's every YouTube channel —
// never per tenant. A per-tenant table would UNDERSTATE the real, shared exposure (ten tenants each
// reading "0/100 used today" while the shared project sits at 100/100). This mirrors
// `social_platform_apps` (0105, design D-4): "one approved app serves every tenant on that network,
// so it has no tenant_id and carries no RLS" — the identical reasoning, applied to usage instead of
// registration. See `migrations/<this file's own migration>` for the table.
import { withGlobal } from "../../../db";
import type { QuotaSnapshot } from "../media-rules";

/** dossier §6.4, quoted verbatim from Google's own "getting started" page: "Projects that enable the
 *  YouTube Data API have a default quota allocation of 100 search.list calls, 100 videos.insert
 *  calls, and 10,000 units per day combined for all other endpoints." */
export const YOUTUBE_QUOTA_CAPS = {
  searchListCallsPerDay: 100,
  videosInsertCallsPerDay: 100,
  otherUnitsPerDay: 10000,
} as const;

/** Per-method unit costs THIS driver can actually incur, from the dossier's own "determine quota
 *  cost" table (§6.4). `videos.insert`/`search.list` are deliberately ABSENT from this table — they
 *  are tracked as their own CALL-COUNT buckets above, never as a unit cost against the 10,000 pool.
 *  Collected here so a future call site (e.g. `comments.insert`, once SMM-17's reply flow lands) has
 *  ONE place to add a cost rather than guessing one. */
export const YOUTUBE_UNIT_COSTS = {
  commentThreadsList: 1,
  videosList: 1,
  channelsList: 1,
  commentsInsert: 50,
} as const;

type Bucket = "searchListCallsToday" | "videosInsertCallsToday" | "otherUnitsToday";

interface DayCounters {
  searchListCallsToday: number;
  videosInsertCallsToday: number;
  otherUnitsToday: number;
}

const usage = new Map<string, DayCounters>();

/** UTC calendar day. ⚠UNVERIFIED whether this matches Google's own reset instant (some quota docs
 *  describe a Pacific-time midnight reset elsewhere in Google's ecosystem) — UTC is this estate's own
 *  convention (every other daily job in this module keys on UTC), named rather than assumed to be
 *  Google's actual reset boundary. A day-boundary mismatch could under- or over-report by at most one
 *  day's worth of slack at the edges, never silently invent a number. */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dayCounters(now: Date): DayCounters {
  const key = utcDayKey(now);
  let row = usage.get(key);
  if (!row) {
    row = { searchListCallsToday: 0, videosInsertCallsToday: 0, otherUnitsToday: 0 };
    usage.set(key, row);
  }
  return row;
}

/** Record ONE successful call against a bucket. Called by `direct.ts` immediately AFTER a call this
 *  driver actually made succeeds — never speculatively, and never for a call that failed. (A failed
 *  call may still cost Google's real quota — ⚠UNVERIFIED whether a 4xx/5xx response is itself
 *  metered — but this file only counts what it can verify happened: a successful response this
 *  driver observed. Undercounting a real failure is the safer of the two wrong directions: the
 *  alternative — counting a call we are not certain reached Google — could report a false "quota
 *  exhausted" against an account nowhere near its real limit.) */
export function recordYouTubeQuotaUsage(bucket: Bucket, units: number, now: Date = new Date()): void {
  const row = dayCounters(now);
  row[bucket] += units;
}

/** The snapshot `direct.ts#getQuota` returns for `network === 'youtube'`. Every `cap` is the cited
 *  constant above; every `used` is THIS PROCESS's own count for today — see the header for why an
 *  absent/zero count here is a true fact, not a guess. Global per deployment, NOT per account (the
 *  dossier's own finding: the binding cap is per-project, shared across every channel) — so every
 *  connected YouTube account reads the SAME snapshot, a deliberate, named departure from Instagram's
 *  per-account probe shape. */
export function getYouTubeQuotaSnapshot(now: Date = new Date()): NonNullable<QuotaSnapshot["youtubeQuota"]> {
  const row = dayCounters(now);
  return {
    searchListCallsToday: { used: row.searchListCallsToday, cap: YOUTUBE_QUOTA_CAPS.searchListCallsPerDay },
    videosInsertCallsToday: { used: row.videosInsertCallsToday, cap: YOUTUBE_QUOTA_CAPS.videosInsertCallsPerDay },
    otherUnitsToday: { used: row.otherUnitsToday, cap: YOUTUBE_QUOTA_CAPS.otherUnitsPerDay },
  };
}

/** Test seam — mirrors `resetTokenRefreshers()`/`resetPublishers()`: drop all accounted usage so one
 *  test's calls never leak into another's assertions. */
export function resetYouTubeQuotaUsage(): void {
  usage.clear();
}

// ── SMM-38 phase 38e — Gap 3's seam ─────────────────────────────────────────────────────────────────

/** What `direct.ts` calls through, instead of the module-level functions above directly. Async on
 *  both members even though the in-memory implementation below never awaits anything — the DB-backed
 *  implementation genuinely does, and a seam that were sync-for-one-impl/async-for-the-other would
 *  make `direct.ts` branch on which store it was holding, defeating the point of a seam. */
export interface YouTubeQuotaStore {
  record(bucket: Bucket, units: number, now?: Date): Promise<void>;
  snapshot(now?: Date): Promise<NonNullable<QuotaSnapshot["youtubeQuota"]>>;
}

/** The DEFAULT store: a thin wrapper over the module-level singleton functions above. Every existing
 *  caller (every test in this module, `direct.ts` with no `quotaStore` override) keeps EXACTLY
 *  today's behaviour — same Map, same `resetYouTubeQuotaUsage()` seam, same per-process lifetime. */
export function defaultYouTubeQuotaStore(): YouTubeQuotaStore {
  return {
    record: (bucket, units, now) => {
      recordYouTubeQuotaUsage(bucket, units, now);
      return Promise.resolve();
    },
    snapshot: (now) => Promise.resolve(getYouTubeQuotaSnapshot(now)),
  };
}

/** THE DURABLE STORE (Gap 3). Backed by `social_youtube_quota_usage` — a GLOBAL table, no tenant_id,
 *  no RLS, same shape and same reasoning as `social_platform_apps` (0105, D-4): see this file's
 *  header for why the cap (and therefore the count against it) is a per-DEPLOYMENT fact, never a
 *  per-tenant one. `record` is a single atomic `INSERT ... ON CONFLICT ... DO UPDATE SET col = col +
 *  EXCLUDED.col` — never a read-then-write — so two Node instances recording concurrently add up
 *  correctly rather than racing a read. `snapshot` is a single SELECT; a day with no row yet reads as
 *  every bucket at 0, the identical "no calls observed today" true-fact the in-memory store's fresh
 *  `dayCounters()` already returns — never a fabricated non-zero. */
export function createDbYouTubeQuotaStore(): YouTubeQuotaStore {
  const column: Record<Bucket, string> = {
    searchListCallsToday: "search_list_calls",
    videosInsertCallsToday: "videos_insert_calls",
    otherUnitsToday: "other_units",
  };
  return {
    async record(bucket, units, now = new Date()) {
      const day = utcDayKey(now);
      const col = column[bucket];
      await withGlobal((c) =>
        c.query(
          `INSERT INTO social_youtube_quota_usage (usage_day, ${col})
             VALUES ($1, $2)
           ON CONFLICT (usage_day) DO UPDATE
             SET ${col} = social_youtube_quota_usage.${col} + EXCLUDED.${col}, updated_at = now()`,
          [day, units],
        ),
      );
    },
    async snapshot(now = new Date()) {
      const day = utcDayKey(now);
      const { rows } = await withGlobal((c) =>
        c.query<{ search_list_calls: number; videos_insert_calls: number; other_units: number }>(
          `SELECT search_list_calls, videos_insert_calls, other_units
             FROM social_youtube_quota_usage WHERE usage_day = $1`,
          [day],
        ),
      );
      const row = rows[0] ?? { search_list_calls: 0, videos_insert_calls: 0, other_units: 0 };
      return {
        searchListCallsToday: { used: row.search_list_calls, cap: YOUTUBE_QUOTA_CAPS.searchListCallsPerDay },
        videosInsertCallsToday: { used: row.videos_insert_calls, cap: YOUTUBE_QUOTA_CAPS.videosInsertCallsPerDay },
        otherUnitsToday: { used: row.other_units, cap: YOUTUBE_QUOTA_CAPS.otherUnitsPerDay },
      };
    },
  };
}
