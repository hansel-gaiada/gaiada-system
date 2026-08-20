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

interface DemoVariant {
  id: string; accountId: string; network: DemoSocialNetwork; handle: string; body: string;
  firstComment: string | null;
  media: { fileId?: string; kind?: "image" | "video"; alt?: string }[];
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
    inbox: { enabled: boolean; slaMinutes: number; dm: boolean };
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
    inbox: { enabled: false, slaMinutes: 240, dm: false },
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
    inbox: { enabled: false, slaMinutes: 240, dm: false },
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
type SocialStore = {
  engagements: DemoEngagement[]; accounts: DemoAccount[]; posts: DemoPost[]; seq: number;
  clientReviews: DemoClientReview[];
  dailyMetrics: DemoDailyMetric[]; postMetrics: DemoPostMetric[];
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

// One store, shared by every module copy. Seeded once, on first touch.
const store: SocialStore = ((globalThis as Record<symbol, unknown>)[STORE] ??= {
  engagements: ENGAGEMENTS_SEED,
  accounts: ACCOUNTS_SEED,
  posts: POSTS_SEED,
  seq: 900,
  clientReviews: CLIENT_REVIEWS_SEED,
  dailyMetrics: DAILY_METRICS_SEED,
  postMetrics: POST_METRICS_SEED,
}) as SocialStore;

// Live views. Every read and every mutation below goes through these, so the action graph and the RSC
// read graph are looking at the same arrays.
const ENGAGEMENTS = store.engagements;
const ACCOUNTS = store.accounts;
const POSTS = store.posts;
const CLIENT_REVIEWS = store.clientReviews;
const DAILY_METRICS = store.dailyMetrics;
const POST_METRICS = store.postMetrics;
const nid = (p: string) => `${p}-${++store.seq}`;
const now = () => new Date().toISOString();

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
