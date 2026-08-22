import "server-only";
import { evaluateClientReviewState, type ClientReviewState, type ClientReviewStatus } from "./socialShared";
// SMM-14 — DEMO_MODE fixtures for the Social Media department (calendar + composer, SMM-12).
// Mirrors demoPipeline.ts's STATEFUL in-memory-store convention exactly (module-level arrays
// mutate across requests within one running dev-server process; resets on restart). Before this
// file existed, `DEMO_MODE=1 npm run build`/the Playwright smoke project could load
// `/departments/dept-4/{calendar,composer}` (Social Media is `dept-4` in `lib/org.ts`'s
// `defaultStructure` seed order: Web Dev, Creatives, SEO, Social Media), but every read fell
// through to demoFixtures.ts's generic `[]`/`{accounts:[]}` fallback — an empty calendar, an empty
// composer list, no quota strip, nothing to drag. SMM-12 (drag-to-reschedule + quota strips +
// submit-with-preview) had therefore never been driven in a browser. This file is the fixture that
// makes it drivable, nothing more — see `lib/social.ts`/`lib/socialShared.ts` for the real BFF
// contract this mirrors and `lib/socialActions.ts` for the write paths (`rescheduleVariants`,
// `checkPublishPreconditions`, `updateVariant`/`updatePost`/`deleteVariant`/`deletePost`) that call
// into the routes below.
//
// Routed from demoFixtures.getDemoResponse for every `/api/:t/modules/social/*` path — tenant is
// captured but not filtered on (same convention as demoPipeline.ts: exactly one demo tenant,
// co-agency, ever reaches this module in DEMO_MODE).
//
// Scope: only the routes the Calendar/Composer/Composer-detail pages actually call are
// implemented (`lib/social.ts`'s "add a fixture whenever you add a consumed endpoint" rule, cited
// in `platform-ui/CLAUDE.md`'s DEMO_MODE section) — engagements/accounts/posts/variants read+write,
// validation, and the publish-preconditions dry run. Campaigns/kpi-targets/brand-profiles have no
// UI consumer under Social Media yet (no ScopeEditor-equivalent component exists for this
// department), so they are deliberately NOT seeded here; add them alongside whichever ticket wires
// their first reader, per that same rule.
//
// SMM-21 added `metrics/daily`/`metrics/posts` (read-only — the Analytics tab has no write path)
// with `dailyMetrics`/`postMetrics` seeded onto the SAME globalThis-pinned store, deliberately
// partial (see their own seed comments below) so "an absent counter renders as unknown, never
// zero" is drivable in a real browser, not just asserted in a unit test.

export type DemoSocialNetwork =
  | "instagram" | "facebook" | "tiktok" | "linkedin" | "x"
  | "youtube" | "threads" | "pinterest" | "bluesky" | "mastodon";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

interface DemoValidationIssue { rule: string; message: string }
interface DemoValidation { ok: boolean; errors: DemoValidationIssue[]; warnings: DemoValidationIssue[] }
const PASS: DemoValidation = { ok: true, errors: [], warnings: [] };

interface DemoAccountCapabilities {
  schedule: boolean; nativeSchedule: boolean; directPost: boolean; stories: boolean;
  comments: boolean; dm: boolean; analytics: boolean;
  unsupported: Partial<Record<"schedule" | "nativeSchedule" | "directPost" | "stories" | "comments" | "dm" | "analytics", "network" | "driver" | "unverified">>;
}
const FULL_CAPS: DemoAccountCapabilities = {
  schedule: true, nativeSchedule: true, directPost: true, stories: true, comments: true, dm: true, analytics: true, unsupported: {},
};

interface DemoAccount {
  id: string; clientId: string; network: DemoSocialNetwork; handle: string; displayName: string | null;
  status: "connected" | "expiring" | "expired" | "error";
  quota: Record<string, unknown>;
  capabilities: DemoAccountCapabilities;
  lastError: string | null; healthCheckedAt: string | null; connectedAt: string | null;
  publisherOrgRef: string; driver: string;
}

interface DemoMediaDescriptor {
  fileId?: string; kind?: "image" | "video"; alt?: string; format?: string;
}

interface DemoVariant {
  id: string; accountId: string; network: DemoSocialNetwork; handle: string; body: string;
  firstComment: string | null;
  media: DemoMediaDescriptor[];
  settings: Record<string, unknown>;
  validation: DemoValidation;
  argsSha256: string;
  approvalId: string | null;
  nativeImport: boolean;
  scheduledAt: string | null;
  status: string;
  publishedUrl: string | null;
  publishedAt: string | null;
  lastError: string | null;
  estimatedCostUsd: number;
}

// ── the engagement inbox (SMM-15/16/17 backend; SMM-18 THIS ticket) ────────────────────────────────
//
// `socialShared.ts`'s own header states the real gap this fixture stands in for: the backend has
// NO `GET threads` list/detail route at all yet (only message-level routes scoped to an
// already-known threadId). Everything below is answered here so the triage queue / thread view /
// SLA timers / reply-approval states are provably correct and browser-drivable TODAY, ready to
// rewire the moment the real route exists — never presented as if it already had backend parity.
interface DemoInboxThread {
  id: string; accountId: string; network: DemoSocialNetwork; kind: "comment" | "dm" | "mention" | "review";
  externalThreadId: string; postVariantId: string | null;
  authorHandle: string | null; authorName: string | null; excerpt: string | null;
  sentiment: "positive" | "neutral" | "negative" | "urgent" | null;
  category: "question" | "complaint" | "praise" | "spam" | "other" | null;
  urgency: "low" | "normal" | "high" | null;
  aiTriageStatus: "unclassified" | "unavailable" | "classified" | "purged";
  aiTriageAt: string | null;
  status: "open" | "replied" | "escalated" | "dismissed" | "closed";
  assignedTo: string | null;
  slaDueAt: string | null; slaAlertedAt: string | null;
  lastMessageAt: string | null;
  createdAt: string; updatedAt: string;
  /** Fixture-internal ONLY — the real `activity_content_purged_at` column is never returned by any
   *  endpoint (verified: no SELECT in social.controller.ts exposes it), so this field is deliberately
   *  absent from `InboxThread` (socialShared.ts) and never leaves `toPublicThread` below. It is what
   *  the reply gate's own `retention` stage checks server-side. */
  activityContentPurgedAt: string | null;
}
interface DemoInboxMessage {
  id: string; threadId: string; direction: "in" | "out"; body: string;
  status: "draft" | "in_review" | "approved" | "sent" | "failed";
  source: "postiz_sync" | "reply";
  externalId: string | null; postedAt: string | null; createdAt: string;
  /** Internal only — mirrors `approval_id`/`args_sha256`, neither of which
   *  `listThreadMessages`'s real SELECT returns either. */
  approvalId: string | null; argsSha256: string | null;
}

interface DemoPost {
  id: string; engagementId: string; campaignId: string | null; title: string; brief: string | null;
  source: "human" | "ai" | "agent" | "native_import";
  status: string;
  scheduledAt: string | null;
  customFields: Record<string, unknown>;
  createdBy: string; createdAt: string; updatedAt: string;
  variants: DemoVariant[];
}

interface DemoEngagement {
  id: string; clientId: string; projectId: string | null; name: string; status: string;
  usageBudgetUsd: number; ownerId: string | null; startsOn: string | null; endsOn: string | null;
  customFields: Record<string, unknown>; createdAt: string; updatedAt: string;
  toolScope: {
    networks: Record<DemoSocialNetwork, boolean>;
    posting: { cadencePerWeek: number; requiresClientOk: boolean };
    // `reply` (SMM-17's own additive dial, `tool_scope.inbox.reply`) — jsonb on the real backend,
    // so no migration; added here the same way.
    inbox: { enabled: boolean; slaMinutes: number; dm: boolean; reply: boolean };
    ai: { drafting: boolean; cloudPolish: boolean; imageGen: boolean };
    reporting: { cadence: string };
  };
}

// `u-pm` (Dewi Santoso, "Account Manager") — the demo member with `social_manager`-shaped access
// in `lib/demoFixtures.ts`'s MEMBERS/PROJECTS seed, reused here as the seeded posts' `createdBy`
// rather than inventing a new user id. Declared before its first use (POSTS, below) — a plain
// module-level `const` referenced inside another `const`'s initializer at the top of the same
// module must come first, or the temporal dead zone throws at import time.
const DEMO_MANAGER_ID = "u-pm";

// ── the demo tenant's one engagement — cl-1 (Northwind Traders), matching demoFixtures.ts's
// CLIENTS/COMPANIES seed. Named `soc-*`, deliberately distinct from demoFixtures.ts's `sm-eng-*`
// ids (those are SEARCH MARKETING — SEO/SEM — engagements under `/modules/search/`, an unrelated
// module that happens to share the "sm" initials; a shared prefix here would read as the same
// domain when it isn't). ─────────────────────────────────────────────────────────────────────────
const ENGAGEMENT: DemoEngagement = {
  id: "soc-eng-1", clientId: "cl-1", projectId: null, name: "Northwind Traders — Organic Social",
  status: "active", usageBudgetUsd: 150, ownerId: "u-pm", startsOn: "2026-07-01", endsOn: null,
  customFields: {}, createdAt: "2026-07-01T09:00:00Z", updatedAt: "2026-07-01T09:00:00Z",
  toolScope: {
    networks: {
      instagram: true, facebook: true, tiktok: true, linkedin: false, x: false,
      youtube: false, threads: false, pinterest: false, bluesky: false, mastodon: false,
    },
    posting: { cadencePerWeek: 4, requiresClientOk: false },
    // SMM-18: flipped `enabled`/`reply` on for THIS ticket so the inbox demo has an in-scope
    // engagement to check replies against — `enabled: false` was SMM-12's own placeholder from
    // before SMM-15/16/17 existed, never revisited until now.
    inbox: { enabled: true, slaMinutes: 240, dm: false, reply: true },
    ai: { drafting: true, cloudPolish: false, imageGen: false },
    reporting: { cadence: "monthly" },
  },
};
// ── a SECOND engagement, requiring client sign-off (SMM-31/32, D-16) ────────────────────────────
// Deliberately separate from `ENGAGEMENT` above rather than flipping that one's own
// `requiresClientOk` — SMM-12's own demo already relies on `ENGAGEMENT`'s dry-run passing `ok:true`
// for a healthy variant with `requiresClientOk:false`; flipping it would have quietly broken that
// scenario for an unrelated ticket. Same client (`cl-1`, Northwind Traders) so the ONE demo-client
// portal login (`demo-client`) can review posts filed under either engagement.
const CLIENT_REVIEWED_ENGAGEMENT: DemoEngagement = {
  id: "soc-eng-2", clientId: "cl-1", projectId: null, name: "Northwind Traders — Client-Reviewed Campaign",
  status: "active", usageBudgetUsd: 80, ownerId: "u-pm", startsOn: "2026-08-01", endsOn: null,
  customFields: {}, createdAt: "2026-08-01T09:00:00Z", updatedAt: "2026-08-01T09:00:00Z",
  toolScope: {
    networks: {
      instagram: true, facebook: false, tiktok: false, linkedin: false, x: false,
      youtube: false, threads: false, pinterest: false, bluesky: false, mastodon: false,
    },
    posting: { cadencePerWeek: 2, requiresClientOk: true },
    inbox: { enabled: false, slaMinutes: 240, dm: false, reply: false },
    ai: { drafting: true, cloudPolish: false, imageGen: false },
    reporting: { cadence: "monthly" },
  },
};

// ── WHY THESE STORES ARE PINNED TO globalThis (SMM-14 QA, 2026-08-20) ───────────────────────────
// A plain module-level array does NOT survive here, and the symptom is a convincing lie. Next bundles
// the `"use server"` action graph and the page's RSC read graph as SEPARATE module instances, so a
// mutation lands on one copy of the array while the page's read sees another: the drag-to-reschedule
// warning fires, the server action returns `approvalInvalidated: true`, the banner appears -- and a
// reload shows both variants still APPROVED.
//
// `demoPortal.ts` hit the identical failure on 2026-08-08 and documented it; `demoMonitoring.ts`
// followed the fixed pattern. This file copied `demoPipeline.ts`'s plain-array convention instead,
// which is fine for a READ-ONLY fixture and wrong the moment anything mutates.
//
// The trap worth remembering: an in-process vitest ("mutate then immediately re-read") passes by
// construction, because it has ONE module instance. It exercised the store and was silent about the
// bundling. Only a real browser against a real dev server could see it -- which is exactly why
// SMM-14 insisted on the browser pass rather than accepting the unit test as proof.
//
// Demo-only state, so one process-wide store is the intended lifetime, and it survives dev HMR where
// a module-level `const` silently does not.
const STORE = Symbol.for("gaiada.demoSocial.store");
interface DemoClientReview {
  id: string; variantId: string; clientId: string; status: ClientReviewStatus;
  comment: string | null; reviewedArgsSha256: string | null;
  requestedAt: string; decidedBy: string | null; decidedAt: string | null; updatedAt: string;
}
// SMM-21 — one account's one day. Every counter OPTIONAL, exactly like the real
// `social_metrics_daily` row/`DailyMetrics` port type — a field simply absent from a seed object
// below IS the "never fetched/never reported" fixture, not an omission to fill in later.
interface DemoDailyMetric {
  accountId: string; date: string;
  followers?: number; impressions?: number; reach?: number; engagements?: number;
  linkClicks?: number; videoViews?: number;
}
// The latest snapshot for one published variant — mirrors `social_post_metrics`'s append-only
// shape, but the demo only ever keeps the ONE row the "latest snapshot per variant" read needs.
interface DemoPostMetric {
  variantId: string;
  impressions?: number; likes?: number; comments?: number; shares?: number; saves?: number;
  videoViews?: number; clicks?: number;
  fetchedAt: string;
}
// SMM-27 — one account's cached best-time-to-post verdict, mirroring
// `social_best_time_suggestions` (and `BestTimeSuggestion`, socialShared.ts) field-for-field. An
// account with NO entry here reads `not_yet_computed` from the dispatcher below — the demo's own
// honest default, matching every real deployment today (D-23: no account is connected anywhere).
interface DemoBestTime {
  accountId: string;
  status: "insufficient_evidence" | "unsupported" | "suggested";
  bestHourUtc: number | null; bestHourSampleSize: number | null; totalMeasuredPosts: number;
  avgEngagementScore: number | null; minMeasuredPostsThreshold: number; minBucketPostsThreshold: number;
  lookbackDays: number;
}
type SocialStore = {
  engagements: DemoEngagement[]; accounts: DemoAccount[]; posts: DemoPost[]; seq: number;
  clientReviews: DemoClientReview[];
  dailyMetrics: DemoDailyMetric[]; postMetrics: DemoPostMetric[];
  inboxThreads: DemoInboxThread[]; inboxMessages: DemoInboxMessage[];
  bestTime: DemoBestTime[];
};

const ENGAGEMENTS_SEED: DemoEngagement[] = [ENGAGEMENT, CLIENT_REVIEWED_ENGAGEMENT];

// ── accounts (SMM-05 registry) — a deliberate mix per the ticket's own requirement: at least one
// connected instagram account with a LIVE known quota, at least one connected account with NO live
// counter (renders "unknown", never "0 used" — QUOTA_UNKNOWN_RULE/describeQuota's own contract),
// one account whose quota is simply not modeled for its network (facebook), and one disconnected
// (expired) account so the registry's non-happy path is drivable too. ───────────────────────────
const ACCOUNTS_SEED: DemoAccount[] = [
  {
    id: "soc-acc-ig-1", clientId: "cl-1", network: "instagram", handle: "northwindtraders",
    displayName: "Northwind Traders", status: "connected",
    quota: { igPosts24h: { used: 8, cap: 25 } },
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: "2026-08-19T06:00:00Z", connectedAt: "2026-07-01T09:10:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph",
  },
  {
    // Deliberately NO `igPosts24h` bucket — the registry has simply never synced this account's
    // quota. `describeQuota` must render "Unknown — registry not synced (never zero)", the exact
    // gap this ticket exists to make drivable.
    id: "soc-acc-ig-2", clientId: "cl-1", network: "instagram", handle: "northwind.behindthescenes",
    displayName: "Northwind BTS", status: "connected",
    quota: {},
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: null, connectedAt: "2026-07-15T11:00:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph",
  },
  {
    // Quota AT cap — drives the `quota_exhausted` publish-precondition refusal (soc-var-4 below
    // targets this account) and the QuotaStrip's "critical" (100%) styling.
    id: "soc-acc-ig-3", clientId: "cl-1", network: "instagram", handle: "northwind.promo",
    displayName: "Northwind Promo", status: "connected",
    quota: { igPosts24h: { used: 25, cap: 25 } },
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: "2026-08-19T05:30:00Z", connectedAt: "2026-07-01T09:15:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph",
  },
  {
    // facebook has no live-counter model at all in `describeQuota` — always "not_modeled",
    // regardless of what `quota` carries. A different fact from "unsynced" (soc-acc-ig-2 above).
    id: "soc-acc-fb-1", clientId: "cl-1", network: "facebook", handle: "NorthwindTraders",
    displayName: "Northwind Traders (Facebook)", status: "connected",
    quota: {},
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: "2026-08-19T06:00:00Z", connectedAt: "2026-07-02T09:00:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph",
  },
  {
    // Disconnected — exercises the registry's non-happy status and a capability actually blocked
    // for a real reason ("network": TikTok's API never exposed DM to third-party publishers).
    id: "soc-acc-tiktok-1", clientId: "cl-1", network: "tiktok", handle: "northwindtraders",
    displayName: "Northwind Traders (TikTok)", status: "expired",
    quota: {},
    capabilities: { ...FULL_CAPS, dm: false, unsupported: { dm: "network" } },
    lastError: "OAuth token expired — reconnect required.",
    healthCheckedAt: "2026-08-10T08:00:00Z", connectedAt: "2026-06-20T09:00:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "tiktok-api",
  },
];

// ── posts + variants — spans draft (unscheduled), in_review, approved (one healthy account, one
// at-quota so the same post demonstrates both a passing AND a failing publish-precondition dry
// run), queued, and published. All in August 2026 (the demo's "today") so the Calendar's default
// month view shows the scheduled ones without navigating. ──────────────────────────────────────
const POSTS_SEED: DemoPost[] = [
  {
    id: "soc-post-1", engagementId: "soc-eng-1", campaignId: null,
    title: "Product launch teaser", brief: "Early teaser for the autumn collection — no date yet.",
    source: "human", status: "draft", scheduledAt: null, customFields: {},
    createdBy: "u-pm", createdAt: "2026-08-14T10:00:00Z", updatedAt: "2026-08-14T10:00:00Z",
    variants: [
      {
        id: "soc-var-1", accountId: "soc-acc-ig-2", network: "instagram", handle: "northwind.behindthescenes",
        body: "Something's coming... 👀 #NorthwindAutumn", firstComment: null, media: [],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0001",
        approvalId: null, nativeImport: false, scheduledAt: null, status: "draft",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
  {
    id: "soc-post-2", engagementId: "soc-eng-1", campaignId: null,
    title: "Behind the scenes reel", brief: "Studio walkthrough ahead of the launch.",
    source: "human", status: "in_review", scheduledAt: "2026-08-25T14:00:00Z", customFields: {},
    createdBy: "u-pm", createdAt: "2026-08-15T09:00:00Z", updatedAt: "2026-08-16T09:00:00Z",
    variants: [
      {
        id: "soc-var-2", accountId: "soc-acc-ig-1", network: "instagram", handle: "northwindtraders",
        body: "Take a look behind the counter before it all goes live.", firstComment: "Link in bio soon.",
        media: [{ kind: "video", fileId: "demo-file-bts-1", alt: "Studio walkthrough clip" }],
        settings: { igType: "reel" }, validation: PASS, argsSha256: "sha256-demo-0002",
        approvalId: null, nativeImport: false, scheduledAt: "2026-08-25T14:00:00Z", status: "in_review",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
  {
    id: "soc-post-3", engagementId: "soc-eng-1", campaignId: null,
    title: "Weekly promo carousel", brief: "Rotating weekly-offer carousel, two networks.",
    source: "human", status: "approved", scheduledAt: "2026-08-27T09:00:00Z", customFields: {},
    createdBy: DEMO_MANAGER_ID, createdAt: "2026-08-16T09:00:00Z", updatedAt: "2026-08-17T15:00:00Z",
    variants: [
      {
        // Healthy account — the publish-preconditions dry run passes (`ok: true`) for this one.
        id: "soc-var-3", accountId: "soc-acc-ig-1", network: "instagram", handle: "northwindtraders",
        body: "This week only: 20% off the collection.", firstComment: null,
        media: [{ kind: "image", fileId: "demo-file-promo-1", alt: "Promo carousel slide 1" }],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0003",
        approvalId: "appr-demo-1", nativeImport: false, scheduledAt: "2026-08-27T09:00:00Z", status: "approved",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
      {
        // At-quota account — the publish-preconditions dry run REFUSES this one with
        // `quota_exhausted` at the `quota` stage, even though it is `approved` — the exact
        // "approved-but-can't-actually-publish-right-now" case §19's honesty rule exists for.
        // Also gives the drag-to-reschedule warning a post with TWO approved variants to count.
        id: "soc-var-4", accountId: "soc-acc-ig-3", network: "instagram", handle: "northwind.promo",
        body: "This week only: 20% off the collection.", firstComment: null,
        media: [{ kind: "image", fileId: "demo-file-promo-1", alt: "Promo carousel slide 1" }],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0004",
        approvalId: "appr-demo-2", nativeImport: false, scheduledAt: "2026-08-27T09:00:00Z", status: "approved",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
  {
    id: "soc-post-4", engagementId: "soc-eng-1", campaignId: null,
    title: "Flash sale announcement", brief: "AI-drafted, queued for dispatch.",
    source: "ai", status: "scheduled", scheduledAt: "2026-08-21T12:00:00Z", customFields: {},
    createdBy: DEMO_MANAGER_ID, createdAt: "2026-08-17T09:00:00Z", updatedAt: "2026-08-18T09:00:00Z",
    variants: [
      {
        // Already dispatched into the queue — its approval has been CONSUMED (cleared), and the
        // publish-preconditions dry run refuses `already_dispatched` at `unconsumed`: publishing
        // again would post it a second time.
        id: "soc-var-5", accountId: "soc-acc-fb-1", network: "facebook", handle: "NorthwindTraders",
        body: "Flash sale — today only, 24 hours.", firstComment: null, media: [],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0005",
        approvalId: null, nativeImport: false, scheduledAt: "2026-08-21T12:00:00Z", status: "queued",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0.02,
      },
    ],
  },
  {
    id: "soc-post-5", engagementId: "soc-eng-1", campaignId: null,
    title: "New store opening announcement", brief: null,
    source: "human", status: "published", scheduledAt: "2026-08-05T10:00:00Z", customFields: {},
    createdBy: "u-pm", createdAt: "2026-08-01T09:00:00Z", updatedAt: "2026-08-05T10:05:00Z",
    variants: [
      {
        id: "soc-var-6", accountId: "soc-acc-ig-1", network: "instagram", handle: "northwindtraders",
        body: "We're open! Come say hello at the new Bali storefront.", firstComment: "See you there 🎉",
        media: [{ kind: "image", fileId: "demo-file-opening-1", alt: "Storefront exterior" }],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0006",
        approvalId: null, nativeImport: false, scheduledAt: "2026-08-05T10:00:00Z", status: "published",
        publishedUrl: "https://instagram.com/p/demo-northwind-opening", publishedAt: "2026-08-05T10:05:00Z",
        lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
  // ── soc-eng-2 (requiresClientOk: true) — the client-review state machine, drivable end to end.
  // Four variants, four different steady states, so every one of the five CLIENT_REVIEW_REFUSAL
  // tokens is reachable by simply opening the composer (no live action needed to SEE each state),
  // while soc-var-10 stays `not_requested` so the request → pending → withdraw → re-request loop is
  // still drivable live, starting from a clean slate.
  {
    id: "soc-post-6", engagementId: "soc-eng-2", campaignId: null,
    title: "Client sign-off needed: Autumn drop", brief: "Awaiting the client's decision.",
    source: "human", status: "in_review", scheduledAt: "2026-08-24T09:00:00Z", customFields: {},
    createdBy: "u-pm", createdAt: "2026-08-18T09:00:00Z", updatedAt: "2026-08-18T09:00:00Z",
    variants: [
      {
        id: "soc-var-7", accountId: "soc-acc-ig-1", network: "instagram", handle: "northwindtraders",
        body: "The autumn drop is almost here — first look this Friday.", firstComment: null,
        media: [{ kind: "image", fileId: "demo-file-autumn-1", alt: "Autumn drop teaser" }],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0007",
        approvalId: null, nativeImport: false, scheduledAt: "2026-08-24T09:00:00Z", status: "in_review",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
  {
    id: "soc-post-7", engagementId: "soc-eng-2", campaignId: null,
    title: "Approved, then edited — now stale", brief: "The client signed off on an earlier draft.",
    source: "human", status: "draft", scheduledAt: "2026-08-26T09:00:00Z", customFields: {},
    createdBy: "u-pm", createdAt: "2026-08-15T09:00:00Z", updatedAt: "2026-08-19T11:00:00Z",
    variants: [
      {
        // `client_review_stale` — the client approved `sha256-demo-old-0008` (see the client-review
        // seed below); this variant's LIVE hash has since moved to `sha256-demo-0008` (staff edited
        // the copy after the client signed off) — a client who approved something that then changed
        // has not approved the NEW thing, and this must render as `client_review_stale`, never a
        // silent pass, honouring the ticket brief's own framing verbatim.
        id: "soc-var-8", accountId: "soc-acc-ig-1", network: "instagram", handle: "northwindtraders",
        body: "Autumn drop — now with free shipping on launch day.", firstComment: null, media: [],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0008",
        approvalId: null, nativeImport: false, scheduledAt: "2026-08-26T09:00:00Z", status: "draft",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
  {
    id: "soc-post-8", engagementId: "soc-eng-2", campaignId: null,
    title: "Client asked for changes — carousel copy", brief: null,
    source: "human", status: "draft", scheduledAt: null, customFields: {},
    createdBy: "u-pm", createdAt: "2026-08-16T09:00:00Z", updatedAt: "2026-08-17T10:00:00Z",
    variants: [
      {
        id: "soc-var-9", accountId: "soc-acc-ig-1", network: "instagram", handle: "northwindtraders",
        body: "Rotating weekly offer — 15% off storewide.", firstComment: null, media: [],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0009",
        approvalId: null, nativeImport: false, scheduledAt: null, status: "draft",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
  {
    id: "soc-post-9", engagementId: "soc-eng-2", campaignId: null,
    title: "Never asked yet — awaiting client outreach", brief: null,
    source: "human", status: "draft", scheduledAt: null, customFields: {},
    createdBy: "u-pm", createdAt: "2026-08-19T09:00:00Z", updatedAt: "2026-08-19T09:00:00Z",
    variants: [
      {
        // `not_requested` — no `clientReviews` row exists for this one at all. Left this way on
        // purpose so the request -> pending -> withdraw -> re-request loop is drivable live from a
        // clean slate, rather than only observable as a static seed.
        id: "soc-var-10", accountId: "soc-acc-ig-1", network: "instagram", handle: "northwindtraders",
        body: "Draft: end-of-month clearance teaser.", firstComment: null, media: [],
        settings: {}, validation: PASS, argsSha256: "sha256-demo-0010",
        approvalId: null, nativeImport: false, scheduledAt: null, status: "draft",
        publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
      },
    ],
  },
];

// ── the asset library (SMM-20, AMENDED by D-17 — attach only, generation removed) ──────────────
// Read-only reference data (nothing here ever mutates), so a plain module-level const is fine —
// the `globalThis`-pinning discipline above is specifically about MUTABLE state; this file's own
// header names the exact trap that doctrine exists to avoid, and it does not apply to data
// nothing ever writes to. Two Studio-graded assets given DIFFERENT content types (image/video) so
// both branches of `contentTypeToKindFormat`'s real-backend counterpart are exercisable here too.
const LIBRARY_FILES = [
  {
    id: "demo-file-promo-1", filename: "promo-carousel-1.jpg", contentType: "image/jpeg",
    byteSize: 482_311, source: "upload" as const, url: null, createdAt: "2026-08-10T09:00:00Z",
  },
  {
    id: "demo-file-bts-1", filename: "studio-walkthrough.mp4", contentType: "video/mp4",
    byteSize: 8_204_112, source: "upload" as const, url: null, createdAt: "2026-08-14T10:30:00Z",
  },
  {
    // A Drive-mirrored reference — no bytes of ours (OQ-5's "files + Drive mirror"; the shape
    // `files.controller.ts`'s reference-attach branch produces: filename + url, `storage_key`
    // NULL). Attaching this is legal here (mirrors the real backend, which does not block it
    // either) even though it carries no bytes to upload at dispatch time — a genuinely separate,
    // already-documented gap (dispatch's own `mediaUploadFailed`), not something this ticket
    // re-solves twice.
    id: "demo-file-drive-brief", filename: "Autumn Drop Brief.pdf", contentType: "application/pdf",
    byteSize: 0, source: "drive" as const, url: "https://drive.google.com/file/d/demo-autumn-brief",
    createdAt: "2026-08-05T08:00:00Z",
  },
] as const;

const LIBRARY_STUDIO_ASSETS = [
  {
    id: "demo-studio-1", name: "storefront-exterior-graded.webp", contentType: "image/webp",
    width: 1600, height: 900, gradedByteSize: 214_009, presetId: "vivid-warm", createdAt: "2026-08-04T12:00:00Z",
  },
  {
    id: "demo-studio-2", name: "autumn-drop-teaser-graded.webp", contentType: "image/webp",
    width: 1080, height: 1350, gradedByteSize: 301_552, presetId: "product-clean", createdAt: "2026-08-16T15:00:00Z",
  },
] as const;

function libraryContentTypeToKindFormat(contentType: string): { kind?: "image" | "video"; format?: string } {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/")) return { kind: "image", format: ct.slice("image/".length) || undefined };
  if (ct.startsWith("video/")) return { kind: "video", format: ct.slice("video/".length) || undefined };
  return {};
}

// ── the engagement inbox seed (SMM-18) — computed relative to module-load time (`hoursFromNow`)
// rather than a fixed date, so "due soon"/"overdue" stay true whenever the dev server is actually
// started, not just on the day this file was written. Nine threads, chosen to make every one of
// the four `AiTriageStatus` values, all five `InboxThreadStatus` values, all four `InboxThreadKind`
// values, and all four `SlaState`s (on_track/due_soon/overdue/none) reachable by simply opening the
// page — no live action required to SEE each state, exactly the demo-fixture discipline SMM-12's
// own composer/calendar seed already established. ───────────────────────────────────────────────
function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

const INBOX_THREADS_SEED: DemoInboxThread[] = [
  {
    // unclassified + on_track SLA — "nobody has looked yet", the absence state that must look
    // nothing like a real 'neutral' classification (see socialShared.ts's `describeTriage`).
    id: "soc-thread-1", accountId: "soc-acc-ig-1", network: "instagram", kind: "comment",
    externalThreadId: "ig-comment-8801", postVariantId: "soc-var-6",
    authorHandle: "priya.k", authorName: "Priya K.",
    excerpt: "Do you ship this to Australia?",
    sentiment: null, category: null, urgency: null,
    aiTriageStatus: "unclassified", aiTriageAt: null,
    status: "open", assignedTo: null,
    slaDueAt: hoursFromNow(2), slaAlertedAt: null, lastMessageAt: hoursFromNow(-0.5),
    createdAt: hoursFromNow(-0.5), updatedAt: hoursFromNow(-0.5), activityContentPurgedAt: null,
  },
  {
    // classified (question/normal/neutral) + due_soon SLA + assigned. Carries a DRAFT reply below
    // — the full draft -> edit -> approve -> "ok:true" send-preconditions loop starts here.
    id: "soc-thread-2", accountId: "soc-acc-ig-1", network: "instagram", kind: "comment",
    externalThreadId: "ig-comment-8802", postVariantId: "soc-var-6",
    authorHandle: "sam.lee", authorName: "Sam Lee",
    excerpt: "What sizes are available for the autumn jacket?",
    sentiment: "neutral", category: "question", urgency: "normal",
    aiTriageStatus: "classified", aiTriageAt: hoursFromNow(-0.4),
    status: "open", assignedTo: DEMO_MANAGER_ID,
    slaDueAt: hoursFromNow(0.3), slaAlertedAt: null, lastMessageAt: hoursFromNow(-0.4),
    createdAt: hoursFromNow(-0.4), updatedAt: hoursFromNow(-0.4), activityContentPurgedAt: null,
  },
  {
    // classified (complaint/high/negative) + OVERDUE SLA + unassigned — the "this needs a human
    // now" case. Carries a DRAFT reply (editable) so the edit-invalidates-approval loop is
    // separately drivable from soc-thread-2's own.
    id: "soc-thread-3", accountId: "soc-acc-fb-1", network: "facebook", kind: "comment",
    externalThreadId: "fb-comment-4401", postVariantId: null,
    authorHandle: "grumpy.customer", authorName: null,
    excerpt: "My order arrived damaged and nobody has replied to my email!!",
    sentiment: "negative", category: "complaint", urgency: "high",
    aiTriageStatus: "classified", aiTriageAt: hoursFromNow(-6),
    status: "open", assignedTo: null,
    slaDueAt: hoursFromNow(-0.5), slaAlertedAt: hoursFromNow(-0.4), lastMessageAt: hoursFromNow(-6),
    createdAt: hoursFromNow(-6), updatedAt: hoursFromNow(-6), activityContentPurgedAt: null,
  },
  {
    // classified (praise/low/positive), already `replied` (a SENT reply below), and a genuinely
    // NO-SLA thread — the engagement's own `slaMinutes` was never configured for this dial's
    // purposes in this specific case, matching `inbox-triage-job.ts`'s own "never invent a fallback
    // duration" rule: `none` is a real, distinct, legitimate state, not an error.
    id: "soc-thread-4", accountId: "soc-acc-ig-1", network: "instagram", kind: "comment",
    externalThreadId: "ig-comment-8803", postVariantId: "soc-var-6",
    authorHandle: "happy.customer", authorName: "Happy Customer",
    excerpt: "Loved the new arrivals, ordering more!",
    sentiment: "positive", category: "praise", urgency: "low",
    aiTriageStatus: "classified", aiTriageAt: hoursFromNow(-20),
    status: "replied", assignedTo: DEMO_MANAGER_ID,
    slaDueAt: null, slaAlertedAt: null, lastMessageAt: hoursFromNow(-19),
    createdAt: hoursFromNow(-20), updatedAt: hoursFromNow(-19), activityContentPurgedAt: null,
  },
  {
    // `unavailable` — a real comment exists, AI classification was ATTEMPTED and got nothing usable
    // (gateway down/unconfigured/unparsable). Must look nothing like `unclassified` (nobody's
    // looked) even though both have null sentiment/category/urgency.
    id: "soc-thread-5", accountId: "soc-acc-ig-1", network: "instagram", kind: "comment",
    externalThreadId: "ig-comment-8804", postVariantId: "soc-var-6",
    authorHandle: "m.tan", authorName: "M. Tan",
    excerpt: "Is this available in size M?",
    sentiment: null, category: null, urgency: null,
    aiTriageStatus: "unavailable", aiTriageAt: hoursFromNow(-1),
    status: "open", assignedTo: null,
    slaDueAt: hoursFromNow(3), slaAlertedAt: null, lastMessageAt: hoursFromNow(-1),
    createdAt: hoursFromNow(-1), updatedAt: hoursFromNow(-1), activityContentPurgedAt: null,
  },
  {
    // `purged` — WAS classified, then LinkedIn's 48h activity-content cap scrubbed the excerpt AND
    // (0113's profile-purge window) the author identity. A COMPLIANCE fact, never rendered as
    // missing data. Carries an APPROVED reply so `source_content_purged` is drivable live via
    // send-preconditions (fail-closed-on-unknown, D-22's own doctrine restated for a reply).
    id: "soc-thread-6", accountId: "soc-acc-ig-1", network: "instagram", kind: "comment",
    externalThreadId: "ig-comment-7701", postVariantId: "soc-var-6",
    authorHandle: null, authorName: null,
    excerpt: null,
    sentiment: null, category: null, urgency: null,
    aiTriageStatus: "purged", aiTriageAt: hoursFromNow(-60),
    status: "open", assignedTo: null,
    slaDueAt: hoursFromNow(-40), slaAlertedAt: hoursFromNow(-39), lastMessageAt: hoursFromNow(-58),
    createdAt: hoursFromNow(-60), updatedAt: hoursFromNow(-48), activityContentPurgedAt: hoursFromNow(-48),
  },
  {
    // `escalated` + dm kind + overdue SLA — kind/status variety.
    id: "soc-thread-7", accountId: "soc-acc-fb-1", network: "facebook", kind: "dm",
    externalThreadId: "fb-dm-2201", postVariantId: null,
    authorHandle: "concerned.parent", authorName: "Concerned Parent",
    excerpt: "Can someone from your team call me back about a safety recall?",
    sentiment: "negative", category: "complaint", urgency: "high",
    aiTriageStatus: "classified", aiTriageAt: hoursFromNow(-3),
    status: "escalated", assignedTo: DEMO_MANAGER_ID,
    slaDueAt: hoursFromNow(-1), slaAlertedAt: hoursFromNow(-0.9), lastMessageAt: hoursFromNow(-3),
    createdAt: hoursFromNow(-3), updatedAt: hoursFromNow(-1), activityContentPurgedAt: null,
  },
  {
    // `dismissed` + mention kind — an operator already closed this out with no reply needed.
    id: "soc-thread-8", accountId: "soc-acc-ig-1", network: "instagram", kind: "mention",
    externalThreadId: "ig-mention-3301", postVariantId: null,
    authorHandle: "randomshopper", authorName: null,
    excerpt: "just tagging @northwindtraders bc this looked cute lol",
    sentiment: "neutral", category: "other", urgency: "low",
    aiTriageStatus: "classified", aiTriageAt: hoursFromNow(-30),
    status: "dismissed", assignedTo: DEMO_MANAGER_ID,
    slaDueAt: null, slaAlertedAt: null, lastMessageAt: hoursFromNow(-30),
    createdAt: hoursFromNow(-30), updatedAt: hoursFromNow(-28), activityContentPurgedAt: null,
  },
  {
    // `closed` + review kind + due_soon-shaped SLA (harmless once closed — the queue's own default
    // filter hides closed/dismissed by status, see `socialDemo`'s `threads` route below) — kind
    // variety (review threads exist per 0105's own CHECK even though no network in this deployment
    // exposes a review surface today).
    id: "soc-thread-9", accountId: "soc-acc-fb-1", network: "facebook", kind: "review",
    externalThreadId: "fb-review-990", postVariantId: null,
    authorHandle: "verified.buyer", authorName: "Verified Buyer",
    excerpt: "Five stars, fast shipping and great packaging.",
    sentiment: "positive", category: "praise", urgency: "low",
    aiTriageStatus: "classified", aiTriageAt: hoursFromNow(-72),
    status: "closed", assignedTo: DEMO_MANAGER_ID,
    slaDueAt: hoursFromNow(-70), slaAlertedAt: hoursFromNow(-69), lastMessageAt: hoursFromNow(-72),
    createdAt: hoursFromNow(-72), updatedAt: hoursFromNow(-70), activityContentPurgedAt: null,
  },
];

const INBOX_MESSAGES_SEED: DemoInboxMessage[] = [
  // soc-thread-1 — inbound only, nothing drafted yet.
  { id: "soc-msg-1", threadId: "soc-thread-1", direction: "in", body: "Do you ship this to Australia?", status: "sent", source: "postiz_sync", externalId: "ig-comment-8801", postedAt: hoursFromNow(-0.5), createdAt: hoursFromNow(-0.5), approvalId: null, argsSha256: null },
  // soc-thread-2 — inbound + a DRAFT reply (editable; the live draft->edit->approve loop starts here).
  { id: "soc-msg-2", threadId: "soc-thread-2", direction: "in", body: "What sizes are available for the autumn jacket?", status: "sent", source: "postiz_sync", externalId: "ig-comment-8802", postedAt: hoursFromNow(-0.4), createdAt: hoursFromNow(-0.4), approvalId: null, argsSha256: null },
  { id: "soc-msg-3", threadId: "soc-thread-2", direction: "out", body: "Hi Sam! The autumn jacket runs XS-XL — happy to check a specific size for you.", status: "draft", source: "reply", externalId: null, postedAt: null, createdAt: hoursFromNow(-0.3), approvalId: null, argsSha256: "sha256-demo-reply-0003" },
  // soc-thread-3 — inbound + a DRAFT reply (a second, independently-editable draft).
  { id: "soc-msg-4", threadId: "soc-thread-3", direction: "in", body: "My order arrived damaged and nobody has replied to my email!!", status: "sent", source: "postiz_sync", externalId: "fb-comment-4401", postedAt: hoursFromNow(-6), createdAt: hoursFromNow(-6), approvalId: null, argsSha256: null },
  { id: "soc-msg-5", threadId: "soc-thread-3", direction: "out", body: "So sorry to hear that — I've escalated this to our support team and someone will reach out directly.", status: "draft", source: "reply", externalId: null, postedAt: null, createdAt: hoursFromNow(-0.2), approvalId: null, argsSha256: "sha256-demo-reply-0005" },
  // soc-thread-4 — inbound + a SENT reply (historical record; `status:'replied'` on the thread).
  { id: "soc-msg-6", threadId: "soc-thread-4", direction: "in", body: "Loved the new arrivals, ordering more!", status: "sent", source: "postiz_sync", externalId: "ig-comment-8803", postedAt: hoursFromNow(-20), createdAt: hoursFromNow(-20), approvalId: null, argsSha256: null },
  { id: "soc-msg-7", threadId: "soc-thread-4", direction: "out", body: "Thank you so much — can't wait for you to see what's coming next!", status: "sent", source: "reply", externalId: "ig-reply-9001", postedAt: hoursFromNow(-19), createdAt: hoursFromNow(-19.2), approvalId: "appr-demo-reply-1", argsSha256: "sha256-demo-reply-0007" },
  // soc-thread-5 — inbound only (unavailable triage; no reply drafted).
  { id: "soc-msg-8", threadId: "soc-thread-5", direction: "in", body: "Is this available in size M?", status: "sent", source: "postiz_sync", externalId: "ig-comment-8804", postedAt: hoursFromNow(-1), createdAt: hoursFromNow(-1), approvalId: null, argsSha256: null },
  // soc-thread-6 — the ORIGINAL comment row still exists (purge scrubs the THREAD's excerpt/author,
  // never individual message rows retroactively — inbox-sync-job.ts's own evidence: "Individual
  // MESSAGE rows carry no such guard"), plus an APPROVED reply that will refuse
  // `source_content_purged` at send-preconditions — drivable live, no click needed to reach it.
  { id: "soc-msg-9", threadId: "soc-thread-6", direction: "in", body: "Anyone know if this comes in navy?", status: "sent", source: "postiz_sync", externalId: "ig-comment-7701", postedAt: hoursFromNow(-58), createdAt: hoursFromNow(-58), approvalId: null, argsSha256: null },
  { id: "soc-msg-10", threadId: "soc-thread-6", direction: "out", body: "Navy is back in stock as of this week!", status: "approved", source: "reply", externalId: null, postedAt: null, createdAt: hoursFromNow(-47), approvalId: null, argsSha256: "sha256-demo-reply-0010" },
  // soc-thread-7 — inbound + a FAILED reply (the network call failed or its outcome was ambiguous;
  // never auto-retried — `reply_send_failed`'s own doctrine). No `lastError` rendered: the real
  // `listThreadMessages` SELECT does not return one either (verified against source).
  { id: "soc-msg-11", threadId: "soc-thread-7", direction: "in", body: "Can someone from your team call me back about a safety recall?", status: "sent", source: "postiz_sync", externalId: "fb-dm-2201", postedAt: hoursFromNow(-3), createdAt: hoursFromNow(-3), approvalId: null, argsSha256: null },
  { id: "soc-msg-12", threadId: "soc-thread-7", direction: "out", body: "We take this seriously — a member of our safety team will call you within the hour.", status: "failed", source: "reply", externalId: null, postedAt: null, createdAt: hoursFromNow(-0.8), approvalId: "appr-demo-reply-2", argsSha256: "sha256-demo-reply-0012" },
  // soc-thread-8/9 — inbound only, both resolved without ever needing a reply.
  { id: "soc-msg-13", threadId: "soc-thread-8", direction: "in", body: "just tagging @northwindtraders bc this looked cute lol", status: "sent", source: "postiz_sync", externalId: "ig-mention-3301", postedAt: hoursFromNow(-30), createdAt: hoursFromNow(-30), approvalId: null, argsSha256: null },
  { id: "soc-msg-14", threadId: "soc-thread-9", direction: "in", body: "Five stars, fast shipping and great packaging.", status: "sent", source: "postiz_sync", externalId: "fb-review-990", postedAt: hoursFromNow(-72), createdAt: hoursFromNow(-72), approvalId: null, argsSha256: null },
];

const CLIENT_REVIEWS_SEED: DemoClientReview[] = [
  {
    id: "cr-1", variantId: "soc-var-7", clientId: "cl-1", status: "pending",
    comment: null, reviewedArgsSha256: null,
    requestedAt: "2026-08-18T09:05:00Z", decidedBy: null, decidedAt: null, updatedAt: "2026-08-18T09:05:00Z",
  },
  {
    // Approved against an OLDER hash than soc-var-8 carries today — see that variant's own comment.
    id: "cr-2", variantId: "soc-var-8", clientId: "cl-1", status: "approved",
    comment: null, reviewedArgsSha256: "sha256-demo-old-0008",
    requestedAt: "2026-08-15T09:10:00Z", decidedBy: "demo-client", decidedAt: "2026-08-15T14:00:00Z",
    updatedAt: "2026-08-15T14:00:00Z",
  },
  {
    id: "cr-3", variantId: "soc-var-9", clientId: "cl-1", status: "changes_requested",
    comment: "Please swap the second photo for the new packaging shot before we go out with this.",
    reviewedArgsSha256: null,
    requestedAt: "2026-08-16T09:15:00Z", decidedBy: "demo-client", decidedAt: "2026-08-17T10:00:00Z",
    updatedAt: "2026-08-17T10:00:00Z",
  },
  // soc-var-10 has NO row — `not_requested` is the absence of a row, not a seeded one.
];

// ── SMM-21 — Analytics tab fixtures ─────────────────────────────────────────────────────────────
// `soc-acc-ig-1` (northwindtraders): three days seeded, the EARLIEST deliberately missing
// `reach`/`engagements`/`linkClicks`/`videoViews` — the engine reported followers+impressions that
// day and nothing else, which is a real, honest partial pull, not a fixture oversight. The other
// two days are complete. `soc-acc-ig-2` gets NO rows at all — this account's metrics have simply
// never been pulled, which the Analytics tab must render as "not fetched", never a zeroed table.
const DAILY_METRICS_SEED: DemoDailyMetric[] = [
  { accountId: "soc-acc-ig-1", date: "2026-08-14", followers: 4180, impressions: 6200 },
  {
    accountId: "soc-acc-ig-1", date: "2026-08-15",
    followers: 4192, impressions: 6410, reach: 4800, engagements: 312, linkClicks: 41, videoViews: 980,
  },
  {
    accountId: "soc-acc-ig-1", date: "2026-08-16",
    followers: 4201, impressions: 5990, reach: 4550, engagements: 288, linkClicks: 35, videoViews: 860,
  },
];

// `soc-var-6` is the one PUBLISHED variant in the seed (soc-post-5). No row exists for any other
// variant — a post that has never been published has no business having a metrics row at all, and
// this fixture does not manufacture one.
const POST_METRICS_SEED: DemoPostMetric[] = [
  {
    variantId: "soc-var-6", impressions: 5230, likes: 214, comments: 18, shares: 9,
    // `saves`/`videoViews`/`clicks` deliberately absent — Instagram's own metrics surface did not
    // report them for this post, and the Analytics tab must show that as "—", never "0".
    fetchedAt: "2026-08-19T02:00:00Z",
  },
];

// SMM-27 — the three DISTINCT non-default facts, driven deliberately across three different
// accounts so all four chip states are reachable in one demo session without any interaction
// (`not_yet_computed` is simply what an unlisted account — soc-acc-ig-2/soc-acc-ig-3 — reads):
//   - soc-acc-ig-1 (northwindtraders, the account with the most published+measured history in this
//     fixture): 'suggested' — 5 measured posts, 3 of them at 14:00 UTC, a real winning bucket.
//   - soc-acc-fb-1: 'insufficient_evidence' — only 2 measured posts against a threshold of 5, the
//     honest state a freshly-connected account would show.
//   - soc-acc-tiktok-1: 'unsupported' — TikTok is audit-locked in this deployment (config.ts's own
//     `enabledNetworks` default excludes it) and its driver never advertises `post_metrics` here.
const BEST_TIME_SEED: DemoBestTime[] = [
  {
    accountId: "soc-acc-ig-1", status: "suggested", bestHourUtc: 14, bestHourSampleSize: 3,
    totalMeasuredPosts: 5, avgEngagementScore: 62.5, minMeasuredPostsThreshold: 5,
    minBucketPostsThreshold: 2, lookbackDays: 180,
  },
  {
    accountId: "soc-acc-fb-1", status: "insufficient_evidence", bestHourUtc: null,
    bestHourSampleSize: null, totalMeasuredPosts: 2, avgEngagementScore: null,
    minMeasuredPostsThreshold: 5, minBucketPostsThreshold: 2, lookbackDays: 180,
  },
  {
    accountId: "soc-acc-tiktok-1", status: "unsupported", bestHourUtc: null,
    bestHourSampleSize: null, totalMeasuredPosts: 0, avgEngagementScore: null,
    minMeasuredPostsThreshold: 5, minBucketPostsThreshold: 2, lookbackDays: 180,
  },
];

// One store, shared by every module copy. Seeded once, on first touch.
const store: SocialStore = ((globalThis as Record<symbol, unknown>)[STORE] ??= {
  engagements: ENGAGEMENTS_SEED,
  accounts: ACCOUNTS_SEED,
  posts: POSTS_SEED,
  seq: 900,
  clientReviews: CLIENT_REVIEWS_SEED,
  dailyMetrics: DAILY_METRICS_SEED,
  postMetrics: POST_METRICS_SEED,
  inboxThreads: INBOX_THREADS_SEED,
  inboxMessages: INBOX_MESSAGES_SEED,
  bestTime: BEST_TIME_SEED,
}) as SocialStore;

// Live views. Every read and every mutation below goes through these, so the action graph and the RSC
// read graph are looking at the same arrays.
const ENGAGEMENTS = store.engagements;
const ACCOUNTS = store.accounts;
const POSTS = store.posts;
const CLIENT_REVIEWS = store.clientReviews;
const DAILY_METRICS = store.dailyMetrics;
const POST_METRICS = store.postMetrics;
const INBOX_THREADS = store.inboxThreads;
const INBOX_MESSAGES = store.inboxMessages;
const BEST_TIME = store.bestTime;
const nid = (p: string) => `${p}-${++store.seq}`;
const now = () => new Date().toISOString();

// ── the inbox reply gate, computed FRESH (never a stored verdict) — mirrors `computePrecondition`
// above's own reasoning, and mirrors the real `evaluateReplyPrecondition`'s four-stage order
// (scope -> hash -> unconsumed -> retention). Deliberately simplified for demo fidelity: the real
// chain's hash check requires re-hashing the live body against the args the caller supplied, which
// this fixture has no caller-supplied args to check against (`send-preconditions` here is a pure
// GET with no body) — omitted rather than faked, same "don't invent a check you can't really run"
// discipline this file's own asset-attach section states for `mediaUploadFailed`.
const REPLY_PRECONDITION_STAGES_DEMO = ["scope", "hash", "unconsumed", "retention"] as const;
const REPLY_TOOL_DEMO = "social.sendReply";

function inboxThreadById(id: string): DemoInboxThread | undefined {
  return INBOX_THREADS.find((t) => t.id === id);
}
function inboxMessageById(threadId: string, messageId: string): DemoInboxMessage | undefined {
  return INBOX_MESSAGES.find((m) => m.id === messageId && m.threadId === threadId && m.direction === "out");
}
function computeReplyPrecondition(thread: DemoInboxThread, msg: DemoInboxMessage) {
  const base = { stages: REPLY_PRECONDITION_STAGES_DEMO, tool: REPLY_TOOL_DEMO };
  const account = accountById(thread.accountId);
  if (!account || account.status !== "connected") {
    return { ...base, ok: false as const, stage: "scope" as const, reason: "account_not_connected" };
  }
  if (msg.externalId !== null || msg.status === "sent") {
    return { ...base, ok: false as const, stage: "unconsumed" as const, reason: "already_sent" };
  }
  if (msg.approvalId !== null) {
    return { ...base, ok: false as const, stage: "unconsumed" as const, reason: "approval_already_consumed" };
  }
  if (msg.status !== "approved") {
    return { ...base, ok: false as const, stage: "unconsumed" as const, reason: "message_not_approved" };
  }
  if (thread.activityContentPurgedAt !== null) {
    return { ...base, ok: false as const, stage: "retention" as const, reason: "source_content_purged" };
  }
  return { ...base, ok: true as const };
}

/** Never leaks `activityContentPurgedAt` — the real backend exposes it through no endpoint either
 *  (see this section's own header on `DemoInboxThread`). */
function toPublicThread(t: DemoInboxThread) {
  const { activityContentPurgedAt: _internal, ...pub } = t;
  return pub;
}
function toPublicMessage(m: DemoInboxMessage) {
  const { threadId: _t, approvalId: _a, argsSha256: _s, ...pub } = m;
  return pub;
}

function reviewByVariantId(variantId: string): DemoClientReview | undefined {
  return CLIENT_REVIEWS.find((r) => r.variantId === variantId);
}
function reviewToClientState(r: DemoClientReview | undefined): ClientReviewState {
  if (!r) return { status: "not_requested" };
  return {
    status: r.status, id: r.id, comment: r.comment, reviewedArgsSha256: r.reviewedArgsSha256,
    requestedAt: r.requestedAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt,
  };
}

const LIVE_VARIANT_STATUSES = ["queued", "publishing", "published", "partially_published"];
const EDITABLE_VARIANT_STATUSES = ["draft", "in_review", "approved"];

function accountById(id: string): DemoAccount | undefined {
  return ACCOUNTS.find((a) => a.id === id);
}
function findPostByVariantId(variantId: string): { post: DemoPost; variant: DemoVariant } | null {
  for (const post of POSTS) {
    const variant = post.variants.find((v) => v.id === variantId);
    if (variant) return { post, variant };
  }
  return null;
}

function toSummary(v: DemoVariant) {
  return {
    id: v.id, accountId: v.accountId, status: v.status, scheduledAt: v.scheduledAt,
    publishedUrl: v.publishedUrl, nativeImport: v.nativeImport, estimatedCostUsd: v.estimatedCostUsd,
  };
}
function toRollup(p: DemoPost) {
  return {
    id: p.id, engagementId: p.engagementId, campaignId: p.campaignId, title: p.title, brief: p.brief,
    source: p.source, status: p.status, scheduledAt: p.scheduledAt, createdBy: p.createdBy,
    createdAt: p.createdAt, variants: p.variants.map(toSummary),
  };
}
function toDetail(p: DemoPost) {
  return {
    id: p.id, engagementId: p.engagementId, campaignId: p.campaignId, title: p.title, brief: p.brief,
    source: p.source, status: p.status, scheduledAt: p.scheduledAt, customFields: p.customFields,
    createdBy: p.createdBy, createdAt: p.createdAt, updatedAt: p.updatedAt,
    variants: p.variants.map((v) => ({ ...v })),
  };
}

// The six publish-precondition stages, in order (mirrors platform-nest's `publish-precondition.ts`
// `PUBLISH_PRECONDITION_STAGES` — pinned here rather than imported, same reasoning
// `socialShared.ts`'s own copy of this array gives for staying import-free). ─────────────────────
const PRECONDITION_STAGES = ["scope", "quota", "hash", "unconsumed", "budget", "creator_info"] as const;
const PUBLISH_TOOL = "social.publish";
const PUBLISH_METERED_TOOL = "social.publish.metered";

// Computed FRESH off the variant's CURRENT status + its account's CURRENT quota — never a stored
// verdict — so a demo mutation (an edit that reverts an approved variant to draft, a reschedule)
// is reflected the next time this is read, exactly like the real dry run's own "computed fresh,
// not the stored column" rule (`lib/social.ts`'s header on `getVariantValidation`, same principle
// applied here to the precondition read).
// SMM-31/32 — mirrors `evaluatePublishPreconditionWithClientReview`'s own composition exactly: the
// client-review gate is checked FIRST, in front of the six-stage chain, never as a 7th stage inside
// it (`PRECONDITION_STAGES` above stays six, unchanged). `evaluateClientReviewState` is the SAME
// pure function `VariantCard.tsx`'s composer panel calls — one evaluator, not a second copy that
// could drift from it.
function computePrecondition(v: DemoVariant, account: DemoAccount | undefined, engagement: DemoEngagement | undefined) {
  const base = { stages: PRECONDITION_STAGES, tool: PUBLISH_TOOL, meteredTool: PUBLISH_METERED_TOOL };
  if (engagement?.toolScope.posting.requiresClientOk) {
    const verdict = evaluateClientReviewState(reviewToClientState(reviewByVariantId(v.id)), v.argsSha256);
    if (!verdict.ok) return { ...base, ok: false, stage: "client_review" as const, reason: verdict.reason };
  }
  if (!account) return { ...base, ok: false, stage: "scope" as const, reason: "account_not_connected" };
  if (account.status !== "connected") return { ...base, ok: false, stage: "scope" as const, reason: "account_not_connected" };
  const q = account.quota.igPosts24h as { used: number; cap: number } | undefined;
  if (q && q.used >= q.cap) return { ...base, ok: false, stage: "quota" as const, reason: "quota_exhausted" };
  if (LIVE_VARIANT_STATUSES.includes(v.status)) {
    return { ...base, ok: false, stage: "unconsumed" as const, reason: "already_dispatched" };
  }
  if (v.status !== "approved") {
    return { ...base, ok: false, stage: "unconsumed" as const, reason: "variant_not_approved" };
  }
  return { ...base, ok: true };
}

/** Returns a DemoResult for any `/api/:t/modules/social/*` route, or null if it doesn't match. */
export function socialDemo(method: string, p: string, params: URLSearchParams, body?: string): DemoResult | null {
  const match = p.match(/^\/api\/[^/]+\/modules\/social\/(.*)$/);
  if (!match) return null;
  const tail = match[1];
  const m = method.toUpperCase();
  const b = () => (body ? (JSON.parse(body) as Record<string, unknown>) : {});

  // ── engagements ──────────────────────────────────────────────────────────────────────────────
  if (tail === "engagements" && m === "GET") {
    const clientId = params.get("clientId");
    const status = params.get("status");
    let rows = ENGAGEMENTS;
    if (clientId) rows = rows.filter((e) => e.clientId === clientId);
    if (status) rows = rows.filter((e) => e.status === status);
    return ok(rows);
  }
  const engDetailM = tail.match(/^engagements\/([^/]+)$/);
  if (engDetailM && m === "GET") {
    const eng = ENGAGEMENTS.find((e) => e.id === engDetailM[1]);
    if (!eng) return err(404, "not found");
    return ok({ ...eng, tone: {}, hashtagStrategy: {}, knowledgeSourceIds: [] });
  }
  // `GET engagements/:id/scope` — a PRE-EXISTING gap this pass found and closed: `lib/social.ts`'s
  // `getEngagementScope` had NO demo route at all, so it silently fell through to `readGuarded`'s
  // `EMPTY_SCOPE` fallback (`requiresClientOk: false`) — invisible for the Composer's client-review
  // panel (which shows regardless of the toggle, only using it for one line of copy) but it fully
  // defeated the CALENDAR's chip feature, which gates its per-variant review fetch on this exact
  // flag. Also the (pre-existing, unrelated to this ticket) engagement-scope editor page's own read.
  const engScopeM = tail.match(/^engagements\/([^/]+)\/scope$/);
  if (engScopeM && m === "GET") {
    const eng = ENGAGEMENTS.find((e) => e.id === engScopeM[1]);
    if (!eng) return err(404, "not found");
    return ok({ toolScope: eng.toolScope, usageBudgetUsd: eng.usageBudgetUsd });
  }
  // SMM-22 — `GET engagements/:id/usage`, the usage panel's own demo route. X ships disabled at the
  // deployment level, so a real deployment's month-to-date spend is genuinely $0 everywhere; a demo
  // showing $0/$0/$0 would prove nothing about the panel's own rendering (the meter bars, the
  // near-cap warning colour, the "no tenant cap configured" honest sentence). A small, clearly
  // synthetic spend is seeded instead — labeled here as demo data, never presented as measured.
  const engUsageM = tail.match(/^engagements\/([^/]+)\/usage$/);
  if (engUsageM && m === "GET") {
    const eng = ENGAGEMENTS.find((e) => e.id === engUsageM[1]);
    if (!eng) return err(404, "not found");
    const engagementSpend = Math.min(eng.usageBudgetUsd, eng.usageBudgetUsd * 0.62);
    return ok({
      engagement: { mtdUsd: Number(engagementSpend.toFixed(3)), capUsd: eng.usageBudgetUsd },
      // The demo deliberately shows the UNSET tenant tier — the honest "not every deployment
      // configures every tier" state, distinct from a spent-down cap.
      tenant: { mtdUsd: Number(engagementSpend.toFixed(3)), capUsd: null },
      global: { mtdUsd: Number((engagementSpend + 4.2).toFixed(3)), capUsd: 100 },
      warnRatio: 0.8,
    });
  }

  // ── accounts (SMM-05 registry — the quota strips' data source) ─────────────────────────────────
  if (tail === "accounts" && m === "GET") {
    const clientId = params.get("clientId");
    const status = params.get("status");
    let rows = ACCOUNTS;
    if (clientId) rows = rows.filter((a) => a.clientId === clientId);
    if (status) rows = rows.filter((a) => a.status === status);
    return ok({ accounts: rows });
  }

  // ── posts ────────────────────────────────────────────────────────────────────────────────────
  if (tail === "posts" && m === "GET") {
    const engagementId = params.get("engagementId");
    const status = params.get("status");
    let rows = POSTS;
    if (engagementId) rows = rows.filter((p) => p.engagementId === engagementId);
    if (status) rows = rows.filter((p) => p.status === status);
    return ok(rows.map(toRollup));
  }
  if (tail === "posts" && m === "POST") {
    const body_ = b() as { engagementId?: string; title?: string; brief?: string; source?: DemoPost["source"]; campaignId?: string; scheduledAt?: string; id?: string };
    if (!body_.engagementId) return err(400, "missing_field");
    if (!body_.title) return err(400, "missing_field");
    if (body_.id) {
      const existing = POSTS.find((p) => p.id === body_.id);
      if (existing) return { status: 201, json: { id: existing.id, created: false } };
    }
    const id = body_.id ?? nid("soc-post");
    POSTS.push({
      id, engagementId: body_.engagementId, campaignId: body_.campaignId ?? null,
      title: body_.title, brief: body_.brief ?? null, source: body_.source ?? "human",
      status: "draft", scheduledAt: body_.scheduledAt ?? null, customFields: {},
      createdBy: DEMO_MANAGER_ID, createdAt: now(), updatedAt: now(), variants: [],
    });
    return { status: 201, json: { id, created: true } };
  }
  const postDetailM = tail.match(/^posts\/([^/]+)$/);
  if (postDetailM && m === "GET") {
    const post = POSTS.find((p) => p.id === postDetailM[1]);
    if (!post) return err(404, "not found");
    return ok(toDetail(post));
  }
  if (postDetailM && m === "PATCH") {
    const post = POSTS.find((p) => p.id === postDetailM[1]);
    if (!post) return err(404, "not found");
    const body_ = b();
    if ("title" in body_ && typeof body_.title === "string") post.title = body_.title;
    if ("brief" in body_) post.brief = (body_.brief as string | null) ?? null;
    if ("scheduledAt" in body_) post.scheduledAt = (body_.scheduledAt as string | null) ?? null;
    if ("status" in body_ && typeof body_.status === "string") post.status = body_.status;
    if ("campaignId" in body_) post.campaignId = (body_.campaignId as string | null) ?? null;
    post.updatedAt = now();
    return ok({ ok: true });
  }
  if (postDetailM && m === "DELETE") {
    const post = POSTS.find((p) => p.id === postDetailM[1]);
    if (!post) return err(404, "not found");
    if (post.variants.some((v) => LIVE_VARIANT_STATUSES.includes(v.status))) {
      return err(409, "post_has_live_variants");
    }
    const idx = POSTS.indexOf(post);
    POSTS.splice(idx, 1);
    return ok({ ok: true });
  }

  // ── variants ─────────────────────────────────────────────────────────────────────────────────
  const createVariantM = tail.match(/^posts\/([^/]+)\/variants$/);
  if (createVariantM && m === "POST") {
    const post = POSTS.find((p) => p.id === createVariantM[1]);
    if (!post) return err(404, "not found");
    const body_ = b() as { accountId?: string; body?: string; firstComment?: string | null; media?: DemoVariant["media"]; settings?: Record<string, unknown>; scheduledAt?: string | null; id?: string };
    if (!body_.accountId) return err(400, "missing_field");
    const account = accountById(body_.accountId);
    if (!account) return err(400, "unknown_network");
    const id = body_.id ?? nid("soc-var");
    const argsSha256 = nid("sha256-demo");
    const variant: DemoVariant = {
      id, accountId: account.id, network: account.network, handle: account.handle,
      body: body_.body ?? "", firstComment: body_.firstComment ?? null, media: body_.media ?? [],
      settings: body_.settings ?? {}, validation: PASS, argsSha256,
      approvalId: null, nativeImport: false, scheduledAt: body_.scheduledAt ?? post.scheduledAt ?? null,
      status: "draft", publishedUrl: null, publishedAt: null, lastError: null, estimatedCostUsd: 0,
    };
    post.variants.push(variant);
    return { status: 201, json: { id, created: true, validation: PASS, argsSha256, estimatedCostUsd: 0 } };
  }

  const variantDetailM = tail.match(/^variants\/([^/]+)$/);
  if (variantDetailM && m === "PATCH") {
    const found = findPostByVariantId(variantDetailM[1]);
    if (!found) return err(404, "not found");
    const { variant } = found;
    if (variant.nativeImport) return err(409, "variant_native_import_immutable");
    if (!EDITABLE_VARIANT_STATUSES.includes(variant.status)) return err(409, "variant_not_editable");
    const body_ = b();
    if ("body" in body_ && typeof body_.body === "string") variant.body = body_.body;
    if ("firstComment" in body_) variant.firstComment = (body_.firstComment as string | null) ?? null;
    if ("media" in body_) variant.media = (body_.media as DemoVariant["media"]) ?? [];
    if ("settings" in body_) variant.settings = (body_.settings as Record<string, unknown>) ?? {};
    if ("scheduledAt" in body_) variant.scheduledAt = (body_.scheduledAt as string | null) ?? null;
    // D-15 — editing rewrites the hashed args; an approved OR in-review variant drops back to
    // draft and its approval is cleared in the SAME write (mirrors `updateVariant`'s own
    // "approvalInvalidated" contract in `lib/socialShared.ts`). A plain draft edit stays draft.
    const priorStatus = variant.status;
    const approvalInvalidated = priorStatus === "approved" || priorStatus === "in_review";
    if (approvalInvalidated) {
      variant.status = "draft";
      variant.approvalId = null;
    }
    variant.argsSha256 = nid("sha256-demo");
    return ok({ ok: true, validation: variant.validation, argsSha256: variant.argsSha256, approvalInvalidated });
  }
  if (variantDetailM && m === "DELETE") {
    const found = findPostByVariantId(variantDetailM[1]);
    if (!found) return err(404, "not found");
    const { post, variant } = found;
    if (LIVE_VARIANT_STATUSES.includes(variant.status)) return err(409, "variant_is_live");
    post.variants = post.variants.filter((v) => v.id !== variant.id);
    return ok({ ok: true });
  }

  const validationM = tail.match(/^variants\/([^/]+)\/validation$/);
  if (validationM && m === "GET") {
    const found = findPostByVariantId(validationM[1]);
    if (!found) return err(404, "not found");
    const { variant } = found;
    return ok({ validation: variant.validation, estimatedCostUsd: variant.estimatedCostUsd, network: variant.network });
  }

  // ── the asset library (SMM-20, AMENDED by D-17 — attach only, generation removed) ────────────
  const assetLibraryM = tail.match(/^engagements\/([^/]+)\/asset-library$/);
  if (assetLibraryM && m === "GET") {
    const eng = ENGAGEMENTS.find((e) => e.id === assetLibraryM[1]);
    if (!eng) return err(404, "not found");
    return ok({ files: LIBRARY_FILES, studioAssets: LIBRARY_STUDIO_ASSETS });
  }

  const attachMediaM = tail.match(/^variants\/([^/]+)\/media\/attach$/);
  if (attachMediaM && m === "POST") {
    const found = findPostByVariantId(attachMediaM[1]);
    if (!found) return err(404, "not found");
    const { variant } = found;
    if (variant.nativeImport) return err(400, "variant_native_import_immutable");
    if (!EDITABLE_VARIANT_STATUSES.includes(variant.status)) return err(400, "variant_not_editable");
    const body_ = b() as { source?: "file" | "creative_asset"; assetId?: string; alt?: string; kind?: "image" | "video"; format?: string };
    if (!body_.source || !body_.assetId) return err(400, "missing_field");
    if (body_.source !== "file" && body_.source !== "creative_asset") return err(400, "unsupported_asset_source");

    let fileId: string;
    let contentType: string;
    if (body_.source === "file") {
      const f = LIBRARY_FILES.find((x) => x.id === body_.assetId);
      if (!f) return err(400, "asset_not_found");
      fileId = f.id;
      contentType = f.contentType;
    } else {
      const a = LIBRARY_STUDIO_ASSETS.find((x) => x.id === body_.assetId);
      if (!a) return err(400, "asset_not_found");
      // Materialization simulated deterministically (same asset id -> same synthesized fileId
      // every time), matching the real backend's idempotent "reuse the same `files` row" property
      // without actually needing a second store to prove it.
      fileId = `demo-file-from-${a.id}`;
      contentType = a.contentType;
    }
    const derived = libraryContentTypeToKindFormat(contentType);
    const descriptor: DemoMediaDescriptor = {
      fileId, kind: body_.kind ?? derived.kind, alt: body_.alt, format: body_.format ?? derived.format,
    };
    const already = variant.media.findIndex((mm) => mm.fileId === fileId);
    if (already >= 0) variant.media[already] = { ...variant.media[already], ...descriptor };
    else variant.media.push(descriptor);

    const priorStatus = variant.status;
    const approvalInvalidated = priorStatus === "approved" || priorStatus === "in_review";
    if (approvalInvalidated) {
      variant.status = "draft";
      variant.approvalId = null;
    }
    variant.argsSha256 = nid("sha256-demo");
    return ok({
      ok: true, fileId, media: variant.media, validation: variant.validation,
      argsSha256: variant.argsSha256, approvalInvalidated,
    });
  }

  const preconditionsM = tail.match(/^variants\/([^/]+)\/publish-preconditions$/);
  if (preconditionsM && m === "GET") {
    const found = findPostByVariantId(preconditionsM[1]);
    if (!found) return err(404, "not found");
    const { post, variant } = found;
    const engagement = ENGAGEMENTS.find((e) => e.id === post.engagementId);
    return ok(computePrecondition(variant, accountById(variant.accountId), engagement));
  }

  // ── analytics (SMM-21) — accounts are CLIENT-scoped, not engagement-scoped (0105's real shape),
  // so both routes resolve the engagement's clientId first and filter accounts/variants by it —
  // mirrors `social.controller.ts`'s own join through `social_accounts.client_id`. ──────────────
  if (tail === "metrics/daily" && m === "GET") {
    const engagementId = params.get("engagementId");
    if (!engagementId) return err(400, "missing_field");
    const eng = ENGAGEMENTS.find((e) => e.id === engagementId);
    if (!eng) return ok({ series: [] }); // an unknown engagementId reads as "nothing to show", same as the real endpoint
    const accountIdFilter = params.get("accountId");
    const from = params.get("from");
    const to = params.get("to");
    const clientAccountIds = new Set(ACCOUNTS.filter((a) => a.clientId === eng.clientId).map((a) => a.id));
    let rows = DAILY_METRICS.filter((r) => clientAccountIds.has(r.accountId));
    if (accountIdFilter) rows = rows.filter((r) => r.accountId === accountIdFilter);
    if (from) rows = rows.filter((r) => r.date >= from);
    if (to) rows = rows.filter((r) => r.date <= to);
    const series = rows.map((r) => {
      const account = ACCOUNTS.find((a) => a.id === r.accountId);
      return {
        accountId: r.accountId, network: account?.network ?? "instagram", handle: account?.handle ?? "",
        displayName: account?.displayName ?? null, date: r.date,
        followers: r.followers ?? null, impressions: r.impressions ?? null, reach: r.reach ?? null,
        engagements: r.engagements ?? null, linkClicks: r.linkClicks ?? null, videoViews: r.videoViews ?? null,
      };
    });
    return ok({ series });
  }
  if (tail === "metrics/posts" && m === "GET") {
    const engagementId = params.get("engagementId");
    if (!engagementId) return err(400, "missing_field");
    const postsForEngagement = POSTS.filter((p) => p.engagementId === engagementId);
    const rows = postsForEngagement.flatMap((post) =>
      post.variants
        .filter((v) => v.status === "published")
        .map((v) => {
          const m2 = POST_METRICS.find((pm) => pm.variantId === v.id);
          if (!m2) return null; // never pulled yet — omitted, never a fabricated zero row
          return {
            variantId: v.id, postId: post.id, accountId: v.accountId, network: v.network,
            publishedAt: v.publishedAt, publishedUrl: v.publishedUrl,
            impressions: m2.impressions ?? null, likes: m2.likes ?? null, comments: m2.comments ?? null,
            shares: m2.shares ?? null, saves: m2.saves ?? null, videoViews: m2.videoViews ?? null,
            clicks: m2.clicks ?? null, fetchedAt: m2.fetchedAt,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null),
    );
    return ok({ posts: rows });
  }

  // ── client review (SMM-31/32, D-16) — the STAFF side: ask / read / withdraw ────────────────────
  const clientReviewM = tail.match(/^variants\/([^/]+)\/client-review$/);
  if (clientReviewM && m === "POST") {
    const variantId = clientReviewM[1];
    const found = findPostByVariantId(variantId);
    if (!found) return err(404, "not found");
    const existing = reviewByVariantId(variantId);
    const alreadyPending = existing?.status === "pending";
    if (existing) {
      // ONE ROW PER VARIANT, FOREVER (0105's UNIQUE(variant_id)) — re-request is an UPSERT back to
      // pending, never a second row, from ANY prior state.
      existing.status = "pending";
      existing.comment = null;
      existing.reviewedArgsSha256 = null;
      existing.decidedBy = null;
      existing.decidedAt = null;
      existing.requestedAt = now();
      existing.updatedAt = now();
      return { status: 201, json: { id: existing.id, status: "pending", alreadyPending } };
    }
    const id = nid("cr");
    CLIENT_REVIEWS.push({
      id, variantId, clientId: "cl-1", status: "pending", comment: null, reviewedArgsSha256: null,
      requestedAt: now(), decidedBy: null, decidedAt: null, updatedAt: now(),
    });
    return { status: 201, json: { id, status: "pending", alreadyPending: false } };
  }
  if (clientReviewM && m === "GET") {
    const review = reviewByVariantId(clientReviewM[1]);
    if (!review) return ok({ status: "not_requested" });
    return ok({
      id: review.id, status: review.status, comment: review.comment,
      reviewedArgsSha256: review.reviewedArgsSha256, requestedAt: review.requestedAt,
      decidedBy: review.decidedBy, decidedAt: review.decidedAt,
    });
  }
  const withdrawM = tail.match(/^variants\/([^/]+)\/client-review\/withdraw$/);
  if (withdrawM && m === "POST") {
    const review = reviewByVariantId(withdrawM[1]);
    if (!review) return err(404, "no client review requested for this variant");
    if (review.status === "withdrawn") return ok({ id: review.id, status: "withdrawn" }); // idempotent no-op
    if (review.status !== "pending") return err(400, "client_review_not_pending");
    review.status = "withdrawn";
    review.decidedBy = DEMO_MANAGER_ID;
    review.decidedAt = now();
    review.updatedAt = now();
    return ok({ id: review.id, status: "withdrawn" });
  }

  // ── best-time-to-post (SMM-27) — classical stats, cached per account. GET reads the seeded
  // verdict, or the honest `not_yet_computed` default for any account not named in `BEST_TIME_SEED`
  // (see that seed's own header for which three accounts drive the other three states). POST
  // recompute is a demo no-op that echoes the SAME cached row back — there is no real posting
  // history in this fixture for a "recompute" to derive anything different from.
  const bestTimeM = tail.match(/^accounts\/([^/]+)\/best-time$/);
  if (bestTimeM && m === "GET") {
    const row = BEST_TIME.find((b) => b.accountId === bestTimeM[1]);
    if (!row) return ok({ status: "not_yet_computed" });
    const { accountId: _accountId, ...rest } = row;
    return ok(rest);
  }
  const bestTimeRecomputeM = tail.match(/^accounts\/([^/]+)\/best-time\/recompute$/);
  if (bestTimeRecomputeM && m === "POST") {
    const row = BEST_TIME.find((b) => b.accountId === bestTimeRecomputeM[1]);
    if (!row) return ok({ status: "insufficient_evidence", bestHourUtc: null, bestHourSampleSize: null, totalMeasuredPosts: 0, avgEngagementScore: null, minMeasuredPostsThreshold: 5, minBucketPostsThreshold: 2, lookbackDays: 180 });
    const { accountId: _accountId, ...rest } = row;
    return ok(rest);
  }

  // ── publisher status (SMM-05) — THIS ticket's first demo route for it. `inboxSurface:
  // "available"` on purpose: DEMO_MODE's whole point is proving the client-side rendering is
  // correct and ready, so it does NOT reproduce today's real "none" steady state (see this file's
  // header, and socialShared.ts's `PublisherStatus` doc, for why a live deployment reads "none").
  // `driver: "direct"` matches the ONE real driver whose capabilities ever include `inbox_read`
  // (platform-nest's `publisher/direct.ts`) — Postiz, the real default, never does.
  if (tail === "publisher/status" && m === "GET") {
    return ok({
      configured: true, driver: "direct",
      enabledNetworks: ["instagram", "facebook", "tiktok"],
      capabilities: ["schedule", "media_upload", "inbox_read", "quota_probe"],
      inboxSurface: "available", quotaProbe: "unavailable",
      orgs: [{ publisherOrgId: "pub-org-northwind", clientId: "cl-1", driver: "direct", status: "active", accountCount: ACCOUNTS.length, lastSyncedAt: hoursFromNow(-1) }],
    });
  }

  // ── the engagement inbox (SMM-15/16/17 backend; SMM-18 THIS ticket) ─────────────────────────────
  //
  // `GET threads` — the PROPOSED list route (see this file's + socialShared.ts's headers for the
  // real-backend gap this stands in for). `status` defaults to hiding `dismissed`/`closed` — the
  // same "the queue is a queue, not an archive" convention `?status=` lets a caller override,
  // mirroring `listPosts`/`listEngagements`'s own optional-filter shape.
  if (tail === "threads" && m === "GET") {
    const statusFilter = params.get("status");
    let rows = INBOX_THREADS;
    // `?status=all` bypasses the default filter (used to resolve a thread clicked into from a link
    // even if it is dismissed/closed) — rather than inventing a second endpoint for that one case.
    if (statusFilter && statusFilter !== "all") rows = rows.filter((t) => t.status === statusFilter);
    else if (!statusFilter) rows = rows.filter((t) => t.status !== "dismissed" && t.status !== "closed");
    return ok(rows.map(toPublicThread));
  }

  const threadMessagesM = tail.match(/^threads\/([^/]+)\/messages$/);
  if (threadMessagesM && m === "GET") {
    const threadId = threadMessagesM[1];
    if (!inboxThreadById(threadId)) return err(404, "inbox thread not found");
    const rows = INBOX_MESSAGES.filter((msg) => msg.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toPublicMessage);
    return ok({ threadId, messages: rows });
  }
  if (threadMessagesM && m === "POST") {
    const threadId = threadMessagesM[1];
    const thread = inboxThreadById(threadId);
    if (!thread) return err(404, "inbox thread not found");
    const body_ = b() as { body?: string };
    const text = (body_.body ?? "").trim();
    if (!text) return err(400, "empty_body");
    const id = nid("soc-msg");
    const argsSha256 = nid("sha256-demo-reply");
    INBOX_MESSAGES.push({
      id, threadId, direction: "out", body: text, status: "draft", source: "reply",
      externalId: null, postedAt: null, createdAt: now(), approvalId: null, argsSha256,
    });
    return { status: 201, json: { id, threadId, body: text, status: "draft", argsSha256 } };
  }

  const editableMessageStatuses = new Set(["draft", "in_review", "approved", "failed"]);
  const threadMessageDetailM = tail.match(/^threads\/([^/]+)\/messages\/([^/]+)$/);
  if (threadMessageDetailM && m === "PATCH") {
    const [, threadId, messageId] = threadMessageDetailM;
    if (!inboxThreadById(threadId)) return err(404, "reply draft not found");
    const msg = inboxMessageById(threadId, messageId);
    if (!msg) return err(404, "reply draft not found");
    const body_ = b() as { body?: string };
    if (body_.body === undefined) return err(400, "no_fields");
    const text = body_.body.trim();
    if (!text) return err(400, "empty_body");
    if (!editableMessageStatuses.has(msg.status)) return err(409, "message_not_editable");
    const wasApproved = msg.approvalId !== null || msg.status === "approved";
    msg.body = text;
    msg.argsSha256 = nid("sha256-demo-reply");
    msg.approvalId = null;
    if (["in_review", "approved", "failed"].includes(msg.status)) msg.status = "draft";
    return ok({ id: messageId, threadId, body: text, argsSha256: msg.argsSha256, approvalInvalidated: wasApproved });
  }

  const approveMessageM = tail.match(/^threads\/([^/]+)\/messages\/([^/]+)\/approve$/);
  if (approveMessageM && m === "POST") {
    const [, threadId, messageId] = approveMessageM;
    if (!inboxThreadById(threadId)) return err(404, "reply draft not found");
    const msg = inboxMessageById(threadId, messageId);
    if (!msg) return err(404, "reply draft not found");
    if (msg.status !== "approved") {
      if (msg.status !== "draft" && msg.status !== "in_review") return err(409, "message_not_editable");
      if (!msg.body.trim()) return err(400, "empty_body");
      msg.status = "approved";
    }
    return ok({ id: messageId, threadId, status: "approved" }); // idempotent
  }

  const sendPreconditionsM = tail.match(/^threads\/([^/]+)\/messages\/([^/]+)\/send-preconditions$/);
  if (sendPreconditionsM && m === "GET") {
    const [, threadId, messageId] = sendPreconditionsM;
    const thread = inboxThreadById(threadId);
    if (!thread) return err(404, "reply draft not found");
    const msg = inboxMessageById(threadId, messageId);
    if (!msg) return err(404, "reply draft not found");
    const verdict = computeReplyPrecondition(thread, msg);
    return ok({
      ok: verdict.ok,
      ...(verdict.ok ? {} : { stage: verdict.stage, reason: verdict.reason }),
      stages: verdict.stages, tool: verdict.tool,
    });
  }

  return null;
}

// ── PORTAL side (SMM-31/32, D-16) — `/api/:t/portal/social-reviews[...]`. A SEPARATE dispatch
// function (not folded into `socialDemo` above, which only ever matches `/modules/social/*`) but
// reading/writing the SAME globalThis-pinned `CLIENT_REVIEWS` store, so a staff request and a
// client decide agree on the one row's state — exactly the property this file's own header names
// as the trap ("the write and the read saw different copies"). Identity-aware like
// `demoPortal.ts`'s `portalDashboardDemo`: only `demo-client` may decide/list, matching the real
// portal scope resolver's own behaviour (a staff caller gets a genuine 403, never an empty list).
const DEMO_CLIENT_USER = "demo-client";
const DEMO_CLIENT_ID = "cl-1"; // Northwind Traders — the client `demo-client` represents

export function socialClientReviewPortalDemo(method: string, p: string, userId: string, body?: string): DemoResult | null {
  const match = p.match(/^\/api\/[^/]+\/portal\/social-reviews(?:\/([^/]+)\/decide)?$/);
  if (!match) return null;
  if (userId !== DEMO_CLIENT_USER) return err(403, "not a portal client");
  const m = method.toUpperCase();

  if (!match[1] && m === "GET") {
    const status = new URL(p, "http://demo").searchParams.get("status");
    const rows = CLIENT_REVIEWS
      .filter((r) => r.clientId === DEMO_CLIENT_ID && (!status || r.status === status))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .map((r) => {
        const found = findPostByVariantId(r.variantId);
        return {
          id: r.id, status: r.status, comment: r.comment,
          requestedAt: r.requestedAt, decidedAt: r.decidedAt,
          variantId: r.variantId,
          body: found?.variant.body ?? "", media: found?.variant.media ?? [],
          settings: found?.variant.settings ?? {}, scheduledAt: found?.variant.scheduledAt ?? null,
          network: found?.variant.network ?? "instagram", postTitle: found?.post.title ?? "",
        };
      });
    return ok(rows);
  }

  if (match[1] && m === "POST") {
    const reviewId = match[1];
    const review = CLIENT_REVIEWS.find((r) => r.id === reviewId && r.clientId === DEMO_CLIENT_ID);
    if (!review) return err(404, "review not found");
    const parsed: { decision?: string; comment?: string } = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const decision = parsed.decision;
    if (decision !== "approved" && decision !== "changes_requested") {
      return { status: 400, json: { error: "decision must be approved|changes_requested" } };
    }
    if (review.status !== "pending") {
      // IDEMPOTENT: the same decision replayed is a 200 no-op; a DIFFERENT one is a genuine 409 —
      // never a silent flip, mirroring `social-client-review-portal.controller.ts`'s own decide().
      if (review.status === decision) return ok({ id: review.id, status: review.status, alreadyDecided: true });
      return { status: 409, json: { error: "client_review_already_decided" } };
    }
    const found = findPostByVariantId(review.variantId);
    review.status = decision;
    review.comment = parsed.comment ?? review.comment;
    // Stamps the variant's LIVE hash at the moment of decision — a later edit is detectably stale.
    review.reviewedArgsSha256 = found?.variant.argsSha256 ?? null;
    review.decidedBy = DEMO_CLIENT_USER;
    review.decidedAt = now();
    review.updatedAt = now();
    return ok({ id: review.id, status: decision });
  }

  return null;
}
