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
// ── THE NAMED LIMITATION: PER-PROCESS, IN-MEMORY, NOT DURABLE ───────────────────────────────────────
// This counter lives in a module-level Map, not a table. Two consequences, both named rather than
// silently accepted:
//   1. It resets on a process restart, so a deployment that restarts mid-day loses its count and
//      starts the day looking emptier than it actually is.
//   2. It does not share state across multiple Node instances behind a load balancer, so a
//      multi-instance deployment would UNDERcount (each instance only sees its own calls).
// Both are real gaps for a LIVE deployment — but nothing on a live path calls
// `recordYouTubeQuotaUsage` today: `direct.ts`'s YouTube methods are the only callers, and (per that
// file's header, echoing 38c's own finding for LinkedIn) nothing on a live dispatch path builds a
// YouTube-shaped `OrgHandle` yet — that surgery is 38e's. Building a durable, cross-instance counter
// for a capability nothing can reach live yet would be exactly the kind of unrequested architecture
// decision this ticket's own discipline forbids improvising; a future pass with a live call path is
// better placed to decide whether that needs a table (probably yes, given the 100-call/day ceiling is
// a hard, compliance-relevant wall) or a shared cache. Named here as a real follow-up for 38e, not
// silently declared unnecessary.
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
