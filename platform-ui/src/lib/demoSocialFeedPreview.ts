import "server-only";
// SCP-3d (BFF §63.10, §63.16) — what DEMO_MODE answers for the client's feed preview, from the demo pipeline store (`demoSocialPipeline.ts`):
//
//   GET  engagements/:engagementId/feed-preview        the grid: dated, not archived, not a story, newest first; every post that is not live and the newest 12 live
//   POST engagements/:engagementId/feed-preview/swap   two posts trade dates under the date-move rule, ALL OR NOTHING
//
// Nothing is stored here. The read is derived from the posts every time. The swap applies the SAME rule as the server, in the server's order of checks
// (the officer's gate before the body, then the body, then the posts, then each post's stale picture, then the lock rule), and each move is the demo runner's own
// (`runDemoStage`: `edit` with `fields.scheduledAt`, or `reschedule` with `at`, so a rescheduled post goes back to the client exactly as the post page's Reschedule
// does). A move the runner refuses puts the other one back: the posts are snapshotted first, so the store is never left half-swapped.
//
// SCP-Sg: a live post also answers `liveUrl`, `reach` and `reachSource` (the metrics store's newest snapshots, `demoLiveReach`), and the answer `lastSyncedAt` (the
// client's accounts' newest sync, `demoClientLastSyncedAt`). A SIMULATED post's address is `https://simulated.invalid/...`, as the server's simulator writes it.
import { PIPE_POSTS, PIPE_ENGAGEMENTS, allocStore, isClientContact, type DemoResult, type PipePost } from "./demoSocialPipeline";
import { runDemoStage } from "./demoSocialPipelineRun";
import { demoLiveReach } from "./demoSocialMetrics";
import { demoClientLastSyncedAt } from "./demoSocialAccountsSummary";
import { scpPhaseOf, SCP_STATUSES } from "./scpStageMachine";
import { FEED_PREVIEW_LIVE_CAP, byNewest, dateMoveForPost, type DateMove, type FeedItem } from "./socialFeedPreview";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
/** The server takes uuids; the demo store's ids are words (`soc-post-n-6`), so the demo takes the same shape of word as its calendar does. */
const ID = /^[\w-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown): boolean => v === undefined || v === null;
const NOT_AUTHORIZED = "not authorized: cerbos denied read on social_post";

const moveOf = (p: PipePost): DateMove => dateMoveForPost({ status: p.pipelineStatus, changeCase: p.changeCase });
const view = (p: PipePost) => ({ pipelineStatus: p.pipelineStatus, changeCase: p.changeCase, scheduleVia: p.scheduleVia, blockWaitingOn: p.blockWaitingOn, creativeState: p.creativeState });

/** `/feed-preview` routes by `tail` (the path after `modules/social/`); null for any other path or method (the caller falls through). */
export function demoFeedPreviewRoute(method: string, tail: string, body: string | undefined, userId: string): DemoResult | null {
  const m = /^engagements\/([^/]+)\/feed-preview(\/swap)?$/.exec(tail);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (m[2]) {
    if (method !== "POST") return null;
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
    return demoSwap(id, parsed, userId);
  }
  return method === "GET" ? demoFeedPreview(id, userId) : null;
}

/** `GET engagements/:engagementId/feed-preview`. */
export function demoFeedPreview(engagementId: string, userId: string): DemoResult {
  if (isClientContact(userId)) return err(403, NOT_AUTHORIZED);
  const engagement = PIPE_ENGAGEMENTS.find((e) => e.id === engagementId);
  if (!engagement) return err(404, "engagement_not_found");
  const posts = PIPE_POSTS
    .filter((p) => p.engagementId === engagementId && p.scheduledAt !== null && !p.archivedAt && p.format !== "story")
    .sort((a, b) => byNewest({ scheduledAt: a.scheduledAt as string, postId: a.id }, { scheduledAt: b.scheduledAt as string, postId: b.id }));
  const live = posts.filter((p) => p.pipelineStatus === "live");
  const keptLive = new Set(live.slice(0, FEED_PREVIEW_LIVE_CAP).map((p) => p.id));
  const items = posts.filter((p) => p.pipelineStatus !== "live" || keptLive.has(p.id)).map((p): FeedItem => {
    const move = moveOf(p);
    const isLive = p.pipelineStatus === "live";
    const seen = isLive ? demoLiveReach(p) : { reach: null, source: null };
    return {
      postId: p.id, scheduledAt: new Date(p.scheduledAt as string).toISOString(), thumbFileId: null, pipelineStatus: p.pipelineStatus,
      locked: isLive, title: p.title, format: p.format, phase: scpPhaseOf(view(p)), simulated: p.simulated,
      dateMove: move.move, dateMoveRefusal: move.refusal,
      liveUrl: isLive ? (p.simulated ? `https://simulated.invalid/${p.id}` : p.liveUrl) : null, reach: seen.reach, reachSource: seen.source,
    };
  });
  return { status: 200, json: { items, liveHidden: Math.max(0, live.length - keptLive.size), lastSyncedAt: demoClientLastSyncedAt(engagement.clientId) } };
}

/** `POST engagements/:engagementId/feed-preview/swap`. */
export function demoSwap(engagementId: string, raw: unknown, userId: string): DemoResult {
  if (isClientContact(userId)) return err(403, NOT_AUTHORIZED);
  if (!PIPE_ENGAGEMENTS.some((e) => e.id === engagementId)) return err(404, "engagement_not_found");
  // 1. The officer's gate, before the body is read (the superadmin holds every social_post action).
  const officer = allocStore.byEngagement[engagementId]?.officerId ?? null;
  if (userId !== "demo-hansel" && userId !== officer) return err(403, "not_the_officer");

  // 2. The body, in the server's order: postA, postB, expectedA, expectedB, then the two differ.
  const b = isObj(raw) ? raw : {};
  const id = (f: "postA" | "postB"): string | DemoResult => (absent(b[f]) ? err(400, "missing_field", { field: f }) : typeof b[f] === "string" && ID.test(b[f] as string) ? (b[f] as string) : err(400, "invalid_field", { field: f }));
  const expected = (f: "expectedA" | "expectedB"): { status: string; scheduledAt: string } | DemoResult => {
    const v = b[f];
    if (absent(v)) return err(400, "missing_field", { field: f });
    if (!isObj(v) || typeof v.status !== "string" || !SCP_STATUSES.includes(v.status) || !isIso(v.scheduledAt)) return err(400, "invalid_field", { field: f });
    return { status: v.status, scheduledAt: v.scheduledAt };
  };
  const parts = [id("postA"), id("postB"), expected("expectedA"), expected("expectedB")];
  const bad = parts.find((x): x is DemoResult => typeof x === "object" && x !== null && "status" in x && "json" in x);
  if (bad) return bad;
  const [idA, idB, expA, expB] = parts as [string, string, { status: string; scheduledAt: string }, { status: string; scheduledAt: string }];
  if (idA === idB) return err(400, "invalid_field", { field: "postB" });

  // 3. The posts: both this client's, else 404.
  const mine = (pid: string) => PIPE_POSTS.find((p) => p.id === pid && p.engagementId === engagementId);
  const postA = mine(idA);
  const postB = mine(idB);
  if (!postA || !postB) return err(404, "post_not_found");

  // 4. Per post: archived, the picture the caller saw (the step, then the date), then the lock rule, answered once both pictures are known to be current.
  const sides = [
    { post: postA, exp: expA, otherAt: expB.scheduledAt, other: postB },
    { post: postB, exp: expB, otherAt: expA.scheduledAt, other: postA },
  ];
  let locked: DemoResult | null = null;
  for (const s of sides) {
    const p = s.post;
    if (p.archivedAt) return err(409, "post_archived");
    const move = moveOf(p);
    if (s.exp.status !== p.pipelineStatus) return err(409, "status_changed", { detail: { status: p.pipelineStatus, phase: scpPhaseOf(view(p)) } });
    if (p.scheduledAt === null || Date.parse(p.scheduledAt) !== Date.parse(s.exp.scheduledAt)) {
      return err(409, "status_changed", { detail: { postId: p.id, status: p.pipelineStatus, phase: scpPhaseOf(view(p)), scheduledAt: p.scheduledAt } });
    }
    if (move.move === "locked" && !locked) {
      locked = err(409, move.refusal ?? "field_locked", { detail: { postId: p.id, status: p.pipelineStatus, ...(move.refusal === "field_locked" ? { field: "scheduledAt" } : {}) } });
    }
  }
  if (locked) return locked;
  if (Date.parse(expA.scheduledAt) === Date.parse(expB.scheduledAt)) return err(409, "no_change");

  // 5. Apply, A then B, each by the runner; B refused puts A back (all or nothing).
  const snaps = [structuredClone(postA), structuredClone(postB)];
  const legs: Array<{ post: PipePost; move: DateMove }> = [];
  for (const [i, s] of sides.entries()) {
    const move = moveOf(s.post);
    const out = runDemoStage(
      { postId: s.post.id, action: move.move === "reschedule" ? "reschedule" : "edit", params: move.move === "reschedule" ? { at: s.otherAt } : { fields: { scheduledAt: s.otherAt } }, expectedStatus: s.exp.status },
      userId, false,
    );
    if (!out.ok) {
      for (let k = 0; k < i; k++) Object.assign(sides[k].post, snaps[k]);
      return out.result;
    }
    legs.push({ post: s.post, move });
  }
  return {
    status: 200,
    json: {
      posts: legs.map(({ post, move }) => ({
        postId: post.id, scheduledAt: post.scheduledAt ? new Date(post.scheduledAt).toISOString() : null, pipelineStatus: post.pipelineStatus, askedClient: move.move === "reschedule",
      })),
    },
  };
}
