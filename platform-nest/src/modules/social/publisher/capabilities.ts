// SMM-05 — what a connected account can actually DO, and why a `false` is false.
//
// `social_accounts.capabilities` is the column the composer, the calendar, the inbox and the
// console all read before offering an affordance. Getting it wrong in the permissive direction is
// the D-12 failure ("never let a human queue what the API will reject") wearing a different hat, so
// this file is deliberately evidence-cited line by line: every `false` below points at the addendum
// section that established it.
//
// ── TWO INDEPENDENT LAYERS, AND KEEPING THEM SEPARATE IS THE POINT ──────────────────────────────
// A capability can be absent for two completely different reasons, and collapsing them into one
// boolean destroys the only information an operator needs:
//
//   NETWORK  — the platform's API does not offer it, and no engine choice changes that.
//              TikTok has no comment scope on its developer platform at all (§A4h). LinkedIn,
//              YouTube and TikTok have no DM API whatsoever (§A4e/§A4g/§A4h). Waiting will not
//              help; a driver swap will not help. This is permanent until the VENDOR changes.
//   DRIVER   — our engine cannot reach it, though the network could. Postiz has ZERO inbound
//              engagement surface for every network (spike §8b / addendum §A4j) — so Instagram
//              comments, which Meta's API genuinely offers, are still unavailable to us today.
//              This one IS fixable: it is exactly what the Mixpost fallback exists for.
//   UNVERIFIED — nobody has researched it. Treated as unavailable (fail-closed), and NAMED, so it
//              is visibly a gap in our knowledge rather than a confident "no". Four of the ten
//              networks 0105 admits were never part of OQ-1's research; pretending otherwise would
//              be the "confident wrong answer" failure class the root guide warns about.
//
// The stored value is the AND of the two layers (`resolveAccountCapabilities`), plus an
// `unsupported` map giving the reason for each `false`. A console can then say "TikTok will never
// have comments" and "we cannot read Instagram comments yet" as the different sentences they are.
//
// ── THE OBSOLETE NUMBER THIS FILE MUST NOT REINTRODUCE ──────────────────────────────────────────
// There is no quota constant anywhere in this module. `quota` is populated ONLY from a live probe
// (SocialPublisher.getQuota) and is `{}` when the probe is unavailable. Addendum §A4f: the design's
// "IG ~25 posts/24h" is obsolete, Meta's own doc says 100 in one place and 50 in another, and 25
// appears nowhere in it — so we ask the account, or we record that we do not know. `media-rules.ts`
// already treats an absent counter as `quota_unknown` (a warning), never as "zero used".
import type { IntegrationState, PublisherCapability } from "./types";

/** Why a capability is false. See the header — these three are not interchangeable. */
export type UnsupportedReason = "network" | "driver" | "unverified";

export interface AccountCapabilities {
  /** Our queue can hold this and publish it at a chosen time. */
  schedule: boolean;
  /** The NETWORK's own API schedules it (Facebook Pages only: `scheduled_publish_time`, 10 minutes
   *  to 30 days — §A4i. Instagram has none at all, which is why our queue's availability IS
   *  publishing reliability there, §A4f item 3). */
  nativeSchedule: boolean;
  /** A publish lands PUBLICLY without a human finishing it in the network's own app. */
  directPost: boolean;
  stories: boolean;
  comments: boolean;
  dm: boolean;
  analytics: boolean;
  /** Reason for every `false` above, keyed by capability name. */
  unsupported: Partial<Record<keyof Omit<AccountCapabilities, "unsupported">, UnsupportedReason>>;
}

type NetworkCapabilityRow = Omit<AccountCapabilities, "unsupported"> & {
  reasons: Partial<Record<keyof Omit<AccountCapabilities, "unsupported">, UnsupportedReason>>;
};

/** What each NETWORK's API can ever do, independent of which engine we run.
 *
 *  Sources, per row:
 *   - instagram/facebook — addendum §A4f (Meta research return)
 *   - linkedin          — §A4e (LinkedIn research return)
 *   - youtube           — §A4g (YouTube research return)
 *   - tiktok            — §A4h (TikTok research return) + §A4i OQ-8
 *   - x                 — design §05/OQ-2 (metered; the only paid network)
 *   - threads/pinterest/bluesky/mastodon — NOT RESEARCHED. 0105's CHECK admits them; OQ-1 covered
 *     five networks and these four were not among them. Marked `unverified` rather than guessed. */
const NETWORK_CAPABILITIES: Record<string, NetworkCapabilityRow> = {
  instagram: {
    schedule: true,
    // §A4f item 3: Instagram has NO native API scheduling. Our queue is the scheduler, and its
    // availability IS publishing reliability — the same conclusion LinkedIn's research reached
    // from the other direction. Containers also expire after 24h, so a week-ahead calendar is a
    // queue property, never a pre-built upstream object.
    nativeSchedule: false,
    directPost: true,
    // §A4f: business accounts only; Creator accounts may not qualify. Advertised true, but SMM-07
    // must verify per account before promising it to a client.
    stories: true,
    comments: true,
    dm: true,
    analytics: true,
    reasons: { nativeSchedule: "network" },
  },
  facebook: {
    schedule: true,
    nativeSchedule: true, // §A4i: 10 minutes to 30 days. media-rules.ts enforces that window.
    directPost: true,
    stories: false,
    comments: true,
    dm: true,
    analytics: true,
    reasons: { stories: "unverified" },
  },
  linkedin: {
    schedule: true,
    // §A4e item 3: `lifecycleState` accepts only PUBLISHED at creation — no server-side scheduling.
    nativeSchedule: false,
    directPost: true,
    stories: false,
    // §A4i: comment READING needs the `*_social_feed` scopes, not `r_organization_social`. The
    // capability exists; the scope list must be right before it works, and a wrong scope set is
    // approved at review and then fails at RUNTIME — the worst failure shape.
    comments: true,
    // §A4e item 2: there is NO messaging/conversation scope anywhere in the Marketing API, and the
    // restricted-use-cases page forbids mass messaging outright. A partner-gated Conversations API
    // is reported to exist but is UNVERIFIED and undocumented. Never promise LinkedIn DMs.
    dm: false,
    analytics: true,
    reasons: { nativeSchedule: "network", stories: "network", dm: "network" },
  },
  tiktok: {
    // §A4i OQ-8 (OPEN, owner decision): TikTok requires the creator to consent "immediately before
    // the upload starts", against a live `creator_info` fetch with no default privacy value. Our
    // spine approves at T and publishes at T+hours. Until the owner rules, scheduling to TikTok is
    // NOT offered — the conservative branch, chosen because the auditor's reading is the one that
    // counts and a rejected submission burns the app registration.
    schedule: false,
    nativeSchedule: false,
    // §A4h finding 2: unaudited clients are locked to SELF_ONLY, posting accounts must be private,
    // 5 users per 24h. Audit-gated, exactly like YouTube's private lock.
    directPost: false,
    stories: false,
    // §A4h finding 1 / §A4i: THERE IS NO COMMENT SCOPE on developers.tiktok.com. Comments and
    // mentions live only on the SEPARATE business-api.tiktok.com platform, which needs its own app,
    // Business Center linkage and (since 2026-03-20) a separate access application. This is a
    // second workstream with its own approval clock, not a scope we tick.
    comments: false,
    dm: false, // §A4h: no DM API; the only DM-adjacent scopes are Data Portability bulk EXPORT.
    analytics: true,
    reasons: {
      schedule: "network", nativeSchedule: "network", directPost: "network",
      stories: "network", comments: "network", dm: "network",
    },
  },
  youtube: {
    schedule: true,
    nativeSchedule: false, // §A4g: whether `publishAt` even fires under the private lock is UNVERIFIED.
    // §A4g item 1: every video uploaded via `videos.insert` from an API project created after
    // 2020-07-28 is FORCED to `private` until YouTube's own compliance audit passes — silently, with
    // no error. Upload-to-draft only; a human flips it public in YouTube Studio. ~3 months.
    directPost: false,
    stories: false,
    comments: true,
    dm: false, // §A4g item 3: confirmed — 26 resources, no messages/inbox; the feature died in 2019.
    analytics: true,
    reasons: { nativeSchedule: "unverified", directPost: "network", stories: "network", dm: "network" },
  },
  x: {
    schedule: true,
    nativeSchedule: false,
    directPost: true,
    stories: false,
    comments: true,
    dm: true,
    analytics: true,
    reasons: { nativeSchedule: "unverified", stories: "network" },
  },
  threads: unresearched(),
  pinterest: unresearched(),
  bluesky: unresearched(),
  mastodon: unresearched(),
};

/** A network 0105 admits but OQ-1 never researched. Everything beyond a plain scheduled post is
 *  reported unavailable-because-unverified: fail-closed, and honestly labelled. */
function unresearched(): NetworkCapabilityRow {
  return {
    schedule: true,
    nativeSchedule: false,
    directPost: true,
    stories: false,
    comments: false,
    dm: false,
    analytics: false,
    reasons: {
      nativeSchedule: "unverified", stories: "unverified", comments: "unverified",
      dm: "unverified", analytics: "unverified",
    },
  };
}

/** Every network 0105's CHECK constraint admits. Exported so the sync can refuse an unmodelled
 *  network by name instead of letting Postgres reject the INSERT with a constraint error. */
export const KNOWN_NETWORKS = Object.keys(NETWORK_CAPABILITIES);

/** Resolve what THIS account can do: the network's own ceiling AND'd with what the registered
 *  driver can reach. The reason for each `false` prefers the PERMANENT explanation — if TikTok will
 *  never have comments, saying "our engine cannot" would be technically true and practically
 *  misleading, because swapping the engine would not help. */
export function resolveAccountCapabilities(
  network: string,
  driverCapabilities: ReadonlySet<PublisherCapability>,
): AccountCapabilities {
  const row = NETWORK_CAPABILITIES[network];
  if (!row) {
    // Unmodelled network: nothing is offered. The sync refuses these before reaching here, but a
    // direct caller gets the fail-closed answer rather than an exception.
    return {
      schedule: false, nativeSchedule: false, directPost: false, stories: false,
      comments: false, dm: false, analytics: false,
      unsupported: {
        schedule: "unverified", nativeSchedule: "unverified", directPost: "unverified",
        stories: "unverified", comments: "unverified", dm: "unverified", analytics: "unverified",
      },
    };
  }

  // What the DRIVER can reach, per capability. `inbox_read`/`inbox_reply` are the ones Postiz does
  // not advertise for any network (spike §8b) — which is why `comments` comes out false even on
  // Instagram, where Meta's API genuinely offers it.
  const driverAllows: Record<keyof Omit<AccountCapabilities, "unsupported">, boolean> = {
    schedule: driverCapabilities.has("schedule"),
    nativeSchedule: driverCapabilities.has("schedule"),
    directPost: driverCapabilities.has("schedule"),
    stories: driverCapabilities.has("schedule"),
    comments: driverCapabilities.has("inbox_read"),
    dm: driverCapabilities.has("inbox_read"),
    analytics: driverCapabilities.has("account_metrics"),
  };

  const out: AccountCapabilities = {
    schedule: false, nativeSchedule: false, directPost: false, stories: false,
    comments: false, dm: false, analytics: false, unsupported: {},
  };
  for (const cap of ["schedule", "nativeSchedule", "directPost", "stories", "comments", "dm", "analytics"] as const) {
    const byNetwork = row[cap];
    const byDriver = driverAllows[cap];
    out[cap] = byNetwork && byDriver;
    if (out[cap]) continue;
    // Permanent explanation first: a network-level absence is not fixed by a driver swap.
    out.unsupported[cap] = !byNetwork ? (row.reasons[cap] ?? "network") : "driver";
  }
  return out;
}

/** Map the engine's view of a connection onto 0105's `social_accounts.status` vocabulary.
 *
 *  `expiring` is a real state and not a nicety: LinkedIn's refresh token has a 365-day TTL that does
 *  NOT reset on use and needs annual human re-consent (§A4e), Meta's access token is 60 days, and
 *  TikTok's is 24 hours with a 365-day refresh (§A4h). The proactive nudge those facts demand is
 *  only possible if the registry distinguishes "will need a human soon" from "already dead". */
export function deriveAccountStatus(integration: IntegrationState): "connected" | "expiring" | "expired" | "error" {
  if (integration.error) return "error";
  // The engine says a human must re-consent. We cannot tell "soon" from "already" over its API, so
  // this maps to `expiring` — the state that TRIGGERS a nudge — rather than `expired`, which reads
  // as "stop trying". Over-nudging costs an email; under-nudging costs a silent publishing outage
  // on a client account, discovered by the client.
  if (integration.refreshNeeded) return "expiring";
  if (integration.disabled) return "expired";
  return "connected";
}
