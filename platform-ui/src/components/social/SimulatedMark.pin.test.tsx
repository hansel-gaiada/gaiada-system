import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { cleanup, render, screen, type RenderResult } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// SCP-Sf (plan §5 "Marking", §8 row Sf): THE RENDER PIN. A simulated row that renders without the SIMULATED mark fails here.
//
// Two halves:
//   1. THE REGISTRY (static). Every component under the Social Media surfaces (`components/social/**`, `components/portal/social/**` and the Connections block)
//      whose code reads a simulated flag (`.simulated`, or a `source === "simulated"` metric) must be in COVERED below, with a render case, and must draw
//      `<SimulatedMark`; or be in PENDING with the reason it is not yet (another session owns the file). A NEW component that reads the flag fails here until
//      it is pinned, so it cannot be added unmarked. No component but SimulatedMark.tsx writes the word SIMULATED itself (no ad-hoc chip comes back).
//   2. THE RENDERS. For each COVERED file, the component is drawn twice from a fixture: once with a simulated item (the mark's accessible name "Simulated" must
//      be there) and once with the same item real (it must not be: a mark on a real row is a lie too).
//
// Pure vitest; the mocks below only stand in for the server actions and the router, which a first render never calls. The post page draws a DEMO_MODE read, so
// the clock is pinned before the demo store seeds (as PostPage.test.tsx does).
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), back: vi.fn(), push: vi.fn() }), usePathname: () => "/portal/social" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialSimulatedAccountsActions", () => ({ seedSimulatedAccounts: vi.fn() }));
vi.mock("@/lib/socialClientActions", () => ({ swapFeedPreview: vi.fn(), bulkPostAction: vi.fn(), createClientPost: vi.fn() }));
vi.mock("@/lib/socialActions", () => ({ createReplyDraft: vi.fn(), updateReplyDraft: vi.fn(), approveReplyDraft: vi.fn(), checkReplySendPreconditions: vi.fn() }));
vi.mock("@/lib/collabActions", () => ({ postEntityComment: vi.fn() }));
vi.mock("@/lib/socialPipelineActions", () => ({
  runPostAction: vi.fn(), runSimulatedPublishNow: vi.fn(), savePostFields: vi.fn(), saveSuggestion: vi.fn(), dropSuggestion: vi.fn(),
  addPostDesign: vi.fn(), removePostDesign: vi.fn(), enterPostMetrics: vi.fn(), loadPostMetrics: vi.fn(),
}));
vi.mock("@/lib/portalSocialActions", () => ({ portalSocialDecide: vi.fn(), portalSocialUndo: vi.fn(), portalSocialReloadPost: vi.fn(), portalSocialApproveAll: vi.fn() }));

import { SIMULATED_MARK_NAME } from "./SimulatedMark";
import { ClientAccounts } from "./ClientAccounts";
import { ClientCalendar } from "./ClientCalendar";
import { ClientHeader } from "./ClientHeader";
import { ClientPostList } from "./ClientPostList";
import { FeedPreview } from "./FeedPreview";
import { HomeTurnList } from "./HomeTurnList";
import { InboxWorkspace } from "./InboxWorkspace";
import { PostCard } from "./PostCard";
import { PostMetricsSection } from "./PostMetrics";
import { PostPage } from "./PostPage";
import { SocialCalendar } from "./SocialCalendar";
import { QuotaStrip } from "./VariantCard";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { SocialAccountsBlock } from "@/components/departments/SocialAccountsBlock";
import { PortalSocialPostCard } from "@/components/portal/social/PortalSocialPostCard";
import { PortalSocialToasts } from "@/components/portal/social/PortalSocialToasts";
import { post as portalPost, TENANT } from "@/components/portal/social/portalSocialFixtures";
import { PIPE_POSTS, demoPipelineRead } from "@/lib/demoSocialPipeline";
import { asPipelinePost } from "@/lib/socialPipeline";
import { placeItem } from "@/lib/socialCalendar";
import type { AccountsSummaryView } from "@/lib/socialAccountsSummary";
import type { AllocationRow } from "@/lib/socialAllocation";
import type { CalendarItem, ClientPost } from "@/lib/socialClient";
import type { FeedItem } from "@/lib/socialFeedPreview";
import type { PipelineCard } from "@/lib/socialHome";
import type { PostMetrics } from "@/lib/socialMetrics";
import type { DailyMetricRow, InboxThread, PostMetricRow, SocialAccount } from "@/lib/socialShared";

afterEach(cleanup);

// ── Fixtures: one item each, simulated or not ────────────────────────────────────────────────────────────────────────

const account = (simulated: boolean) =>
  ({ id: "a-ig", clientId: "c1", network: "instagram", handle: "@mock-kopi-senja", displayName: null, status: "connected", quota: {}, capabilities: {},
     lastError: null, healthCheckedAt: null, connectedAt: null, publisherOrgRef: "org", driver: "postiz", simulated }) as unknown as SocialAccount;
const clientPost = (simulated: boolean): ClientPost => ({
  postId: "p-1", title: "Harvest teaser", status: "live", phase: "posted", holder: null, isExtra: false, format: "feed", health: null, simulated,
});
const feedItem = (simulated: boolean): FeedItem => ({
  postId: "p-1", scheduledAt: "2026-11-10T09:30:00.000Z", thumbFileId: null, pipelineStatus: "live", locked: true, title: "Harvest teaser", format: "feed",
  phase: "posted", simulated, dateMove: "locked", dateMoveRefusal: "post_is_live", liveUrl: null, reach: null, reachSource: null,
});
const calendarItem = (simulated: boolean): CalendarItem => ({
  postId: "p-1", clientName: "Kopi Senja", title: "Harvest teaser", format: "feed", scheduledAt: "2026-10-20T01:30:00.000Z", pipelineStatus: "client", phase: "with_client",
  simulated, dateMove: "locked", dateMoveRefusal: "field_locked",
});
const allocationRow: AllocationRow = {
  engagementId: "e-1", clientId: "c1", clientName: "Kopi Senja", status: "active", officer: { id: "u-2", name: "Sam Officer" }, postsPerCycle: 5, creativeSource: "creatives",
  deliveryBatch: "A", reportFormat: "email", reportDueDay: 5, platforms: ["instagram"], formats: ["feed"], defaultPostTime: "09:30", stepEstimates: {},
  thisCycle: { cycleId: "cy-1", month: "2026-10", target: 5, counted: 1, extra: 0, stories: 0 }, canPlan: false,
};
/** The client's accounts read back: a synced account whose numbers are the simulator's, or a real one's pulled ones. */
const accountsSummary = (simulated: boolean): AccountsSummaryView => ({
  accounts: [{
    accountId: "a-ig", network: "instagram", handle: "@mock-kopi-senja", simulated, followers: 500, followersDelta30d: 20, reach30d: 900, impressions30d: 1200,
    lastSyncedAt: "2026-10-15T03:00:00.000Z", source: simulated ? "simulated" : "pull",
  }],
  totals: { followers: 500, reach30d: 900 }, simulated, lastSyncedAt: "2026-10-15T03:00:00.000Z",
});
const card = (simulated: boolean): PipelineCard => ({
  id: "p-1", engagementId: "e-1", clientName: "Kopi Senja", title: "Harvest teaser", format: "feed", isExtra: false, isStory: false, thumbFileId: null,
  pipelineStatus: "approved", phase: "client_approved", holder: { role: "officer", label: "The officer" }, yourTurn: true, health: null,
  scheduledAt: null, statusSince: "2026-10-14T04:00:00.000Z", nextAction: { action: "schedule", allowed: true }, simulated,
});
const thread: InboxThread = {
  id: "t-1", accountId: "a-ig", network: "instagram", kind: "comment", externalThreadId: "x-1", postVariantId: null, authorHandle: "@a.reader", authorName: "A Reader",
  excerpt: "Lovely.", sentiment: null, category: null, urgency: null, aiTriageStatus: "unclassified", aiTriageAt: null, status: "open", assignedTo: null,
  slaDueAt: null, slaAlertedAt: null, lastMessageAt: null, createdAt: "2026-10-14T04:00:00.000Z", updatedAt: "2026-10-14T04:00:00.000Z",
} as InboxThread;
const metrics = (simulated: boolean): PostMetrics => ({ latest: null, engagementRate: null, accountAverageRate: null, boostCandidate: false, simulated });
const daily = (simulated: boolean): DailyMetricRow => ({
  accountId: "a-ig", network: "instagram", handle: "mock-kopi-senja", displayName: null, date: "2026-10-14", followers: 500, impressions: null, reach: 900,
  engagements: null, linkClicks: null, videoViews: null, source: simulated ? "simulated" : "pull",
});
const postRow = (simulated: boolean): PostMetricRow => ({
  variantId: "v-1", postId: "p-1", accountId: "a-ig", network: "instagram", publishedAt: "2026-10-14T04:00:00.000Z", publishedUrl: null, impressions: 100,
  likes: 10, comments: 1, shares: 0, saves: 0, videoViews: null, clicks: null, fetchedAt: "2026-10-15T04:00:00.000Z", source: simulated ? "simulated" : "pull",
});
/** A pipeline read from the demo store: the simulated live post, a plain one, and the plain one with a network the simulator served (a failed simulated publish). */
const SIM_POST = PIPE_POSTS.find((p) => p.title === "Weekend brunch is back")!;
const PLAIN_POST = PIPE_POSTS.find((p) => !p.simulated && p.pipelineStatus === "planned")!;
const pipelineRead = (simulated: boolean, variantOnly = false) => {
  const raw = demoPipelineRead((simulated && !variantOnly ? SIM_POST : PLAIN_POST).id, "u-social").json as Record<string, unknown>;
  if (!variantOnly) return asPipelinePost(raw);
  return asPipelinePost({
    ...raw, simulated: false,
    variants: [{ id: "v-sim", network: "instagram", handle: "@mock-kopi-senja", status: "failed", reviewStatus: "approved", simulated: true, lastError: null }],
  });
};

type Case = (simulated: boolean) => RenderResult;
/** Every component that reads a simulated flag, by file, and how to draw it. */
const COVERED: Record<string, Case> = {
  "components/social/ClientAccounts.tsx": (s) => render(<ClientAccounts engagementId="e1" read={{ kind: "ok", accounts: [account(s)] }} canPlan={false} />),
  "components/departments/SocialAccountsBlock.tsx": (s) => render(<SocialAccountsBlock accounts={[account(s)]} />),
  "components/social/InboxWorkspace.tsx": (s) => render(
    <InboxWorkspace tenantId="co" deptId="d-soc" threads={[thread]} accountsById={{ "a-ig": { handle: "@mock-kopi-senja", displayName: null, network: "instagram", simulated: s } }}
      selectedThreadId={null} messages={[]} messagesForbidden={false} canReply={false} canAssign={false} canEscalate={false} />,
  ),
  "components/social/VariantCard.tsx": (s) => render(<QuotaStrip network="instagram" account={account(s)} />),
  "components/social/PostPage.tsx": (s) => render(<PostPage deptId="d-soc" post={pipelineRead(s)} comments={[]} assets={[]} demo />),
  // The block reads only the metrics' own mark; the post is the live one, so the block is drawn at all.
  "components/social/PostMetrics.tsx": (s) => render(<PostMetricsSection post={pipelineRead(true)} metrics={metrics(s)} viewerId={null} />),
  "components/social/FeedPreview.tsx": (s) => render(<FeedPreview deptId="d-soc" engagementId="e-1" items={[feedItem(s)]} liveHidden={0} />),
  "components/social/HomeTurnList.tsx": (s) => render(<HomeTurnList cards={[card(s)]} deptId="d-soc" hasMore={false} nowIso="2026-10-16T04:00:00.000Z" />),
  "components/social/PostCard.tsx": (s) => render(<PostCard post={clientPost(s)} href="/departments/d-soc/posts/p-1" />),
  "components/social/ClientHeader.tsx": (s) => render(<ClientHeader row={allocationRow} cycle={null} tone={null} summary={{ kind: "ok", data: accountsSummary(s) }} />),
  "components/social/ClientCalendar.tsx": (s) => render(
    <ClientCalendar deptId="d-soc" engagementId="e-1" month="2026-10" today="2026-10-16" items={[calendarItem(s)]} dayOf={(iso) => iso.slice(0, 10)} timeOf={() => "09:30"} />,
  ),
  "components/social/SocialCalendar.tsx": (s) => render(
    <SocialCalendar deptId="d-soc" month="2026-10" today="2026-10-16" items={[placeItem(calendarItem(s))]} composer={[]} notes={{}} clients={null} summary="1 pipeline post." />,
  ),
  "components/social/ClientPostList.tsx": (s) => render(<ClientPostList deptId="d-soc" posts={[clientPost(s)]} />),
  "components/social/AnalyticsPanel.tsx": (s) => render(<AnalyticsPanel dailySeries={[daily(s)]} postMetrics={[postRow(s)]} />),
  "components/portal/social/PortalSocialPostCard.tsx": (s) => render(
    <PortalSocialToasts>
      <PortalSocialPostCard post={portalPost({ state: "live", liveUrl: "https://simulated.invalid/instagram/1", simulated: s, decision: null })} tenant={TENANT} onReloaded={vi.fn()} onDecided={vi.fn()} />
    </PortalSocialToasts>,
  ),
};

/** Files that read the flag but cannot carry the mark yet, and why. Each must NOT draw the mark yet: when it does, move it to COVERED with a render case. None is pending now. */
const PENDING: Record<string, string> = {};

// ── 1. The registry ──────────────────────────────────────────────────────────────────────────────────────────────────

const SRC = join(__dirname, "..", "..");
const ROOTS = [join(SRC, "components", "social"), join(SRC, "components", "portal", "social"), join(SRC, "components", "departments", "SocialAccountsBlock.tsx")];
const sources = (p: string): string[] =>
  statSync(p).isDirectory()
    ? readdirSync(p).flatMap((n) => sources(join(p, n)))
    : /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
/** The code without its comments (a comment that says SIMULATED, or names `.simulated`, is not a render). */
const codeOnly = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const FILES = ROOTS.flatMap(sources).map((f) => ({ file: rel(f), code: codeOnly(readFileSync(f, "utf8")) }));
/** A read of the flag: `x.simulated`, a `source === "simulated"` metric, or a destructured `{ simulated } = …` (SCP-Sg's header reads the summary's flag that way). */
const readsSimulated = (code: string): boolean =>
  /\.simulated\b/.test(code) || /source\s*===\s*"simulated"/.test(code) || /\{[^{}]*\bsimulated\b[^{}]*\}\s*=[^=>]/.test(code);

describe("SCP-Sf · the registry: every component that reads a simulated flag is pinned", () => {
  it("found the Social Media components", () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it("the components that read a simulated flag are exactly the pinned ones (a new one fails here until it is pinned)", () => {
    const readers = FILES.filter((f) => f.file.endsWith(".tsx") && readsSimulated(f.code)).map((f) => f.file).sort();
    expect(readers).toEqual([...Object.keys(COVERED), ...Object.keys(PENDING)].sort());
  });

  it("each pinned component draws the one mark", () => {
    for (const file of Object.keys(COVERED)) {
      expect(FILES.find((f) => f.file === file)!.code, file).toContain("<SimulatedMark");
    }
  });

  it("a pending file does not draw the mark yet (when it does, it moves to COVERED with a render case)", () => {
    for (const [file, why] of Object.entries(PENDING)) {
      expect(why.length).toBeGreaterThan(20);
      expect(FILES.find((f) => f.file === file)!.code, file).not.toContain("<SimulatedMark");
    }
  });

  it("no component writes the word SIMULATED itself: there is one mark, not a chip per screen", () => {
    const writers = FILES.filter((f) => /\.tsx?$/.test(f.file) && /\bSIMULATED\b/.test(f.code)).map((f) => f.file).sort();
    expect(writers).toEqual(["components/social/SimulatedMark.tsx", ...Object.keys(PENDING)].sort());
  });
});

// ── 2. The renders ───────────────────────────────────────────────────────────────────────────────────────────────────

const marks = () => screen.queryAllByRole("img", { name: SIMULATED_MARK_NAME });

describe("SCP-Sf · the renders: a simulated item carries the mark, a real one does not", () => {
  for (const [file, draw] of Object.entries(COVERED)) {
    it(`${file}: simulated -> marked`, () => {
      draw(true);
      expect(marks().length, file).toBeGreaterThan(0);
      for (const m of marks()) expect(m).toHaveTextContent("SIMULATED");
    });
    it(`${file}: real -> not marked`, () => {
      draw(false);
      expect(marks(), file).toHaveLength(0);
    });
  }

  it("the post page marks a network the simulator served even when the post itself is not marked (a failed or partial simulated publish)", () => {
    render(<PostPage deptId="d-soc" post={pipelineRead(true, true)} comments={[]} assets={[]} demo />);
    expect(marks().length).toBeGreaterThanOrEqual(2); // the header, and the network in the client-review line
  });
});
