// SCP-3d — the client's feed preview: the grid, and the swap of two posts' publish dates (BFF §63.10, plan §8 row 3d).
//
//   GET  engagements/:engagementId/feed-preview        social_post · read     the grid
//   POST engagements/:engagementId/feed-preview/swap   the date-move rules    two posts trade dates, ALL OR NOTHING
//
// THE GRID. The engagement's pipeline posts that have a `scheduled_at`, not deleted, not archived, and not a `story` (a story
// is not in a feed grid), NEWEST DATE FIRST. THE CAP: every post that is not live yet, plus the newest `FEED_PREVIEW_LIVE_CAP`
// (12) live posts; `liveHidden` says how many older live posts were left out, so the page can say "12 of 40 live posts". A
// not-yet-live post is never dropped: the work to do is in them (an engagement holds at most a few cycles of at most 200 posts).
// Each item carries what the contract names, `{postId, scheduledAt, thumbFileId, pipelineStatus, locked}`, and additively:
// `title`, `format`, `phase`, `simulated` and what a date move would do to this post (`dateMove` and, when it is locked,
// `dateMoveRefusal`), so the page can say what will happen before a drop.
//
// THE DATE-MOVE RULE (fixture `systemRules.date_moves`), read from the fixture's own `from` and `editRules`, never restated:
//   - `reschedule` when the machine's `reschedule` accepts the status (approved, scheduled): the client is asked again;
//   - `edit` when `edit` accepts it and its `editRules` allow `scheduledAt` (planned, drafting, and the team copy `changes`
//     cases): an edit of the date;
//   - `locked` otherwise: 409 `post_is_live` for a live post, 409 `field_locked` for the rest (proofread, hod, design, final,
//     client, blocked, and the client copy `changes` case).
//
// THE SWAP. `{postA, postB, expectedA, expectedB}` with `expected*` = `{status, scheduledAt}` as the caller saw them. Each post's
// move is the stage machine's own action (`edit` with `fields.scheduledAt`, or `reschedule` with `at`), so each post is judged by
// the same Cerbos action, the same guards and the same effects as the single-post route: nothing of the machine is restated
// here. What is new is only the composition:
//   1. Authorization first, before any body is read: the officer's `author` or `schedule` on this engagement's posts, else 403
//      `not_the_officer` (audited), so a refused caller never reads a 400.
//   2. The body (400), the posts (404 for a post that does not exist, is another engagement's or another company's), the two
//      differ (400).
//   3. Per post, `prepareStage` (steps 1 to 11 of §63.3.2 with no row locked: Cerbos, expected status, the body), then the date
//      the caller saw (409 `status_changed`), and only then the lock rule (409 `field_locked` / `post_is_live`): a refused
//      caller or a stale picture is answered before a lock is. The same date on both posts is 409 `no_change`.
//   4. Network work before the lock: a queued dispatch of a scheduled post is cancelled at the publisher (as `unschedule` and
//      `reschedule` do), only after every gate has passed, so a refused swap never cancels anything.
//   5. ONE transaction: both posts locked `FOR UPDATE` in id order (two swaps over the same pair cannot deadlock), then each
//      move through `applyStageInTx` (the single-post transaction body, unchanged). A refusal of either move THROWS, which rolls
//      the other back: all or nothing.
//   6. After the commit: the activity row of each post (`writeActivity` through `afterCommit`, with `swappedWith`), and the
//      client is told once per rescheduled post by the review request's own event, inside the transaction.
// A swap is not idempotent: replaying it after it landed no longer matches `expected*` (409 `status_changed`).
//
// KNOWN LIMIT (the same as `reschedule` alone): the publisher's cancel runs before the transaction, so a swap that is refused
// INSIDE the transaction after a dispatch was cancelled (a missing account, a dispatch that started meanwhile) leaves the
// dispatch cancelled and the post as it was; the officer reschedules it. Every guard that can be judged without a lock was.
import { HttpException } from "@nestjs/common";
import { withTenants } from "../../../db";
import { authorize } from "../../../core/http";
import type { Principal } from "../../../rbac/principal";
import type { Resource } from "../../../rbac/cerbos";
import { declareSocialModuleScope } from "../module-scope";
import { loadSocialApproverIds } from "../pipeline-authz";
import { SCP, scpAction } from "./fixture";
import { editableFields, fromMatches, isIsoDateTime, isUuid, phaseOf, type PipelinePostState, type StageRefusal, type StatusPost } from "./machine";
import { isUuidText, loadEngagement, loadPostRow, stateOf, type PostRow } from "./pipeline-data";
import { ScpRouteError, cancelQueuedDispatchesBeforeTx } from "./pipeline-effects";
import { postPhase } from "./schedule-health";
import {
  afterCommit, applyStageInTx, authorizeStage, cerbosDecisionsFor, prepareStage, type Prepared, type StageRequest, type StageTxResult,
} from "./pipeline.service";

const SOCIAL = { modules: ["social"] };

/** The newest live posts the grid keeps (every post that is not live yet is kept). */
export const FEED_PREVIEW_LIVE_CAP = 12;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The date-move rule (PURE)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type DateMoveKind = "edit" | "reschedule" | "locked";

export interface DateMove {
  move: DateMoveKind;
  /** The refusal a move would get: `post_is_live` or `field_locked`; null when the date can move. */
  refusal: "post_is_live" | "field_locked" | null;
}

/** What moving this post's date does, by the fixture (`systemRules.date_moves`): see the header. */
export function dateMoveOf(post: StatusPost): DateMove {
  if (post.pipelineStatus === "live") return { move: "locked", refusal: "post_is_live" };
  const reschedule = scpAction("reschedule");
  if (reschedule && fromMatches(reschedule, post)) return { move: "reschedule", refusal: null };
  const edit = scpAction("edit");
  if (edit && fromMatches(edit, post) && editableFields(post).fields.includes("scheduledAt")) return { move: "edit", refusal: null };
  return { move: "locked", refusal: "field_locked" };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The read
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface FeedPreviewItem {
  postId: string;
  scheduledAt: string;
  thumbFileId: string | null;
  pipelineStatus: string;
  /** True for a live post: it cannot be dragged. */
  locked: boolean;
  title: string;
  format: string | null;
  phase: string | null;
  simulated: boolean;
  dateMove: DateMoveKind;
  dateMoveRefusal: "post_is_live" | "field_locked" | null;
}

export interface FeedPreview {
  items: FeedPreviewItem[];
  /** Live posts older than the newest `FEED_PREVIEW_LIVE_CAP`, left out of `items`. */
  liveHidden: number;
}

interface FeedRow {
  id: string; title: string; format: string | null; scheduled_at: Date | string; pipeline_status: string;
  change_by: string | null; change_kind: string | null; return_to: string | null; changed_only: boolean;
  blocked_from: string | null; block_waiting_on: string | null; simulated: boolean;
  thumb_file_id: string | null; live_total: string;
}

/** `GET engagements/:engagementId/feed-preview`. 404 `engagement_not_found`; the caller's `social_post` · `read` is judged first. */
export async function readFeedPreview(principal: Principal, tenantId: string, engagementId: string): Promise<FeedPreview> {
  await authorize(principal, { kind: "social_post", tenantId, module: "social" }, "read");
  if (!isUuidText(engagementId)) throw new ScpRouteError(404, "engagement_not_found");
  const rows = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const eng = await c.query(`SELECT 1 FROM social_engagements WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tenantId, engagementId]);
    if (!eng.rowCount) return null;
    // The window ranks live and not-live posts apart (newest first in each), so the cap keeps every not-yet-live post and the
    // newest live ones. The thumbnail (the first stored design's file, as the feed card's) is read for the kept rows only.
    const { rows: found } = await c.query<FeedRow>(
      `WITH base AS (
         SELECT p.id, p.tenant_id, p.title, p.format, p.scheduled_at, p.pipeline_status, p.change_by, p.change_kind, p.return_to,
                p.changed_only, p.blocked_from, p.block_waiting_on, p.simulated,
                row_number() OVER (PARTITION BY (p.pipeline_status = 'live') ORDER BY p.scheduled_at DESC, p.id DESC) AS rn,
                count(*) FILTER (WHERE p.pipeline_status = 'live') OVER () AS live_total
           FROM social_posts p
          WHERE p.tenant_id = $1 AND p.engagement_id = $2 AND p.pipeline_status IS NOT NULL AND p.scheduled_at IS NOT NULL
            AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.format IS DISTINCT FROM 'story'
       )
       SELECT b.id::text AS id, b.title, b.format, b.scheduled_at, b.pipeline_status, b.change_by, b.change_kind, b.return_to,
              b.changed_only, b.blocked_from, b.block_waiting_on, b.simulated, b.live_total::text AS live_total,
              (SELECT d.file_id::text FROM social_post_designs d
                WHERE d.tenant_id = b.tenant_id AND d.post_id = b.id AND d.removed_at IS NULL AND d.file_id IS NOT NULL
                ORDER BY d.position, d.added_at LIMIT 1) AS thumb_file_id
         FROM base b
        WHERE b.pipeline_status <> 'live' OR b.rn <= $3
        ORDER BY b.scheduled_at DESC, b.id DESC`,
      [tenantId, engagementId, FEED_PREVIEW_LIVE_CAP],
    );
    return found;
  }, SOCIAL);
  if (!rows) throw new ScpRouteError(404, "engagement_not_found");

  const items = rows.map((r): FeedPreviewItem => {
    const move = dateMoveOf({
      pipelineStatus: r.pipeline_status, changeBy: r.change_by, changeKind: r.change_kind, returnTo: r.return_to,
      scheduleVia: null, blockWaitingOn: r.block_waiting_on, creativeState: null,
    });
    return {
      postId: r.id,
      scheduledAt: new Date(r.scheduled_at).toISOString(),
      thumbFileId: r.thumb_file_id,
      pipelineStatus: r.pipeline_status,
      locked: r.pipeline_status === "live",
      title: r.title,
      format: r.format,
      phase: postPhase({
        status: r.pipeline_status, changeBy: r.change_by, changeKind: r.change_kind, returnTo: r.return_to, changedOnly: r.changed_only,
        blockedFrom: r.blocked_from, blockWaitingOn: r.block_waiting_on,
      }),
      simulated: r.simulated === true,
      dateMove: move.move,
      dateMoveRefusal: move.refusal,
    };
  });
  const liveShown = items.filter((i) => i.locked).length;
  const liveTotal = rows.length ? Number(rows[0].live_total) : 0;
  return { items, liveHidden: Math.max(0, liveTotal - liveShown) };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The swap
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The post as the caller saw it. */
export interface SwapExpected {
  status: string;
  scheduledAt: string;
}

export interface SwapBody {
  postA: string;
  postB: string;
  expectedA: SwapExpected;
  expectedB: SwapExpected;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;

/** PURE. The body of the swap: 400 `missing_field` / `invalid_field` with the field's name (the order: postA, postB, expectedA,
 *  expectedB, then the two posts differ). Judged AFTER authorization, as everywhere (§63.0). */
export function parseSwapBody(body: unknown): SwapBody {
  const b = isObject(body) ? body : {};
  const id = (field: "postA" | "postB"): string => {
    const v = b[field];
    if (absent(v)) throw new ScpRouteError(400, "missing_field", { field });
    if (!isUuid(v)) throw new ScpRouteError(400, "invalid_field", { field });
    return v.toLowerCase();
  };
  const expected = (field: "expectedA" | "expectedB"): SwapExpected => {
    const v = b[field];
    if (absent(v)) throw new ScpRouteError(400, "missing_field", { field });
    if (!isObject(v) || typeof v.status !== "string" || !SCP.statuses.includes(v.status) || !isIsoDateTime(v.scheduledAt)) {
      throw new ScpRouteError(400, "invalid_field", { field });
    }
    return { status: v.status, scheduledAt: v.scheduledAt };
  };
  const postA = id("postA");
  const postB = id("postB");
  const expectedA = expected("expectedA");
  const expectedB = expected("expectedB");
  if (postA === postB) throw new ScpRouteError(400, "invalid_field", { field: "postB" });
  return { postA, postB, expectedA, expectedB };
}

export interface SwapAnswer {
  posts: Array<{ postId: string; scheduledAt: string | null; pipelineStatus: string | null; askedClient: boolean }>;
}

/** One post's side of the swap. */
interface Leg {
  postId: string;
  otherId: string;
  expected: SwapExpected;
  state: PipelinePostState;
  move: DateMove;
  req: StageRequest;
  prepared: Prepared;
  cancelled: Set<string>;
}

/** A refusal raised inside the transaction: thrown, so the other move rolls back with it. */
class SwapRefused extends Error {
  constructor(readonly leg: Leg, readonly refusal: StageRefusal) {
    super(refusal.code);
  }
}

/** The code of a refusal the orchestration threw (`{message: code}` of a `ScpRouteError`, or a plain 4xx). */
function codeOf(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const r = e.getResponse();
  return typeof r === "string" ? r : typeof (r as { message?: unknown }).message === "string" ? (r as { message: string }).message : null;
}

const sameInstant = (a: string | null, b: string) => a !== null && Date.parse(a) === Date.parse(b);

/** `POST engagements/:engagementId/feed-preview/swap`: see the header. */
export async function swapFeedPreviewDates(principal: Principal, tenantId: string, engagementId: string, rawBody: unknown): Promise<SwapAnswer> {
  // 1. The engagement, and authorization before anything of the body is read.
  const pre = await withTenants([tenantId], async (c) => {
    if (!isUuidText(engagementId)) return null;
    const engagement = await loadEngagement(c, tenantId, engagementId);
    return engagement ? { engagement, approverIds: await loadSocialApproverIds(c, tenantId) } : null;
  }, SOCIAL);
  if (!pre) throw new ScpRouteError(404, "engagement_not_found");
  // The would-be post of this client: its officer and the four, read from the rows (as create does, §63.6.1). Moving a date is
  // the officer's `author` (an edit) or `schedule` (a reschedule): holding neither is refused here, audited like any denial.
  const clientResource: Resource = {
    kind: "social_post", tenantId, module: "social", ownerId: pre.engagement.owner_id ?? "", creatorId: "",
    approverIds: pre.approverIds, assigneeIds: [], creativeSource: "",
  };
  const coarse = await cerbosDecisionsFor(principal, clientResource, ["author", "schedule"]);
  if (!coarse.author && !coarse.schedule) {
    return authorizeStage(principal, clientResource, "edit", { ok: false, http: 403, code: "not_the_officer", guard: "cerbos" });
  }

  // 2. The body, then the posts: both must be this engagement's (404 otherwise, as a post that does not exist).
  const body = parseSwapBody(rawBody);
  const rows = await withTenants([tenantId], async (c) => [await loadPostRow(c, tenantId, body.postA), await loadPostRow(c, tenantId, body.postB)], SOCIAL);
  const found = rows.map((r) => (r && r.deleted_at === null && r.engagement_id === engagementId ? r : null));
  if (!found[0] || !found[1]) throw new ScpRouteError(404, "post_not_found");
  const [rowA, rowB] = found as [PostRow, PostRow];
  const states = [stateOf(rowA)!, stateOf(rowB)!];
  if (states.some((s) => s.pipelineStatus === null)) throw new ScpRouteError(409, "not_a_pipeline_post");

  // 3. Per post: the machine's gate (Cerbos, expected status, the body), the date the caller saw, then the lock rule.
  const sides = [
    { postId: body.postA, otherId: body.postB, expected: body.expectedA, otherAt: body.expectedB.scheduledAt, state: states[0] },
    { postId: body.postB, otherId: body.postA, expected: body.expectedB, otherAt: body.expectedA.scheduledAt, state: states[1] },
  ];
  const legs: Leg[] = [];
  let locked: ScpRouteError | null = null;
  for (const s of sides) {
    const move = dateMoveOf(s.state);
    const action = move.move === "reschedule" ? "reschedule" : "edit";
    const req: StageRequest = {
      tenantId, postId: s.postId, action, expectedStatus: s.expected.status,
      params: action === "reschedule" ? { at: s.otherAt } : { fields: { scheduledAt: s.otherAt } },
    };
    const lockRefusal = () => new ScpRouteError(409, move.refusal ?? "field_locked", {
      detail: { postId: s.postId, status: s.state.pipelineStatus, ...(move.refusal === "field_locked" ? { field: "scheduledAt" } : {}) },
    });
    let prepared: Prepared | null = null;
    try {
      prepared = await prepareStage(principal, req);
    } catch (e) {
      // A locked post is outside the edit action's statuses (invalid_transition): its answer is the lock rule's, once the
      // caller is known to be allowed and the picture is not stale (those refusals come earlier in the gate).
      if (!(move.move === "locked" && codeOf(e) === "invalid_transition")) throw e;
    }
    if (!sameInstant(s.state.scheduledAt, s.expected.scheduledAt)) {
      throw new ScpRouteError(409, "status_changed", {
        detail: { postId: s.postId, status: s.state.pipelineStatus, phase: phaseOf(s.state), scheduledAt: s.state.scheduledAt },
      });
    }
    if (move.move === "locked" || !prepared) {
      locked ??= lockRefusal();
      continue;
    }
    legs.push({ postId: s.postId, otherId: s.otherId, expected: s.expected, state: s.state, move, req, prepared, cancelled: new Set<string>() });
  }
  if (locked) throw locked;
  if (sameInstant(states[0].scheduledAt, body.expectedB.scheduledAt)) throw new ScpRouteError(409, "no_change");

  // 4. Network work before the lock, only now that every gate has passed: a scheduled post's queued dispatch is cancelled.
  for (const leg of legs) {
    if (leg.state.pipelineStatus === "scheduled") leg.cancelled = await cancelQueuedDispatchesBeforeTx(tenantId, leg.postId);
  }

  // 5. One transaction: both posts locked in id order, then each move through the single-post transaction body.
  let applied: Array<{ leg: Leg; r: Extract<StageTxResult, { applied: unknown }> }>;
  try {
    applied = await withTenants([tenantId], async (c) => {
      for (const id of [body.postA, body.postB].sort()) await loadPostRow(c, tenantId, id, true);
      const done: typeof applied = [];
      for (const leg of legs) {
        // The date the caller saw, again under the lock (the status is re-checked by the machine: `expectedStatus`).
        const now = stateOf(await loadPostRow(c, tenantId, leg.postId));
        if (!now || !sameInstant(now.scheduledAt, leg.expected.scheduledAt)) {
          throw new SwapRefused(leg, {
            ok: false, http: 409, code: "status_changed", guard: "expected_status_matches",
            detail: { postId: leg.postId, status: now?.pipelineStatus ?? null, scheduledAt: now?.scheduledAt ?? null },
          });
        }
        const r = await applyStageInTx(c, leg.prepared, leg.req, leg.cancelled);
        if ("refusal" in r) throw new SwapRefused(leg, r.refusal);
        done.push({ leg, r });
      }
      return done;
    }, SOCIAL);
  } catch (e) {
    if (e instanceof SwapRefused) return authorizeStage(principal, e.leg.prepared.resource, e.leg.req.action, e.refusal);
    throw e;
  }

  // 6. After the commit: the activity of each post, and its notifications (never undoing the swap).
  for (const { leg, r } of applied) {
    const a = r.applied;
    await afterCommit(
      principal, tenantId, leg.postId, { ...a, activity: { ...a.activity, metadata: { ...a.activity.metadata, swappedWith: leg.otherId } } },
      r.out, r.engagement, r.cycle, r.before, leg.prepared.pre.authz,
    );
  }
  return {
    posts: applied.map(({ leg, r }) => ({
      postId: leg.postId,
      scheduledAt: r.applied.next?.scheduledAt ? new Date(r.applied.next.scheduledAt).toISOString() : null,
      pipelineStatus: r.applied.next?.pipelineStatus ?? null,
      askedClient: leg.move.move === "reschedule",
    })),
  };
}
