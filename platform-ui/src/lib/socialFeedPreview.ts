// SCP-3d — the client's feed preview: types, parsers and words (BFF §63.10 `GET engagements/:engagementId/feed-preview` and
// `POST engagements/:engagementId/feed-preview/swap`). No server-only import, so a client component and the DEMO_MODE handlers may import it.
//
// The server decides every date move (the stage machine's `date_moves` rule, Cerbos, the locks); this file only parses what it answered and says it in
// words. `dateMoveForPost` is the UI twin of the server's rule for the places that have no server (the DEMO_MODE store): it reads the fixture twin
// (`scpStageMachine.json`) through `scpActionsFromStatus` and `editableFieldsOf`, and restates no status or transition.
import { scpActionsFromStatus } from "./scpStageMachine";
import { editableFieldsOf, refusalText, statusLabel } from "./socialPipeline";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** What moving a post's date does: an edit, a reschedule (the client is asked again), or nothing (locked). */
export type DateMoveKind = "edit" | "reschedule" | "locked";
export type DateMoveRefusal = "post_is_live" | "field_locked";

export interface DateMove { move: DateMoveKind; refusal: DateMoveRefusal | null }

/** The newest live posts the server keeps in the grid (it keeps every post that is not live yet). The page says "N of M" with `liveHidden`. */
export const FEED_PREVIEW_LIVE_CAP = 12;

/**
 * The server's date-move rule (fixture `systemRules.date_moves`), for a post at `status` (and `changeCase` in `changes`): `reschedule` where the machine's
 * `reschedule` is available, `edit` where `edit` is and the status's `editRules` allow `scheduledAt`, else locked (`post_is_live` for a live post).
 */
export function dateMoveForPost(post: { status: string; changeCase?: string | null }): DateMove {
  if (post.status === "live") return { move: "locked", refusal: "post_is_live" };
  let actions: string[];
  try {
    actions = scpActionsFromStatus({ pipelineStatus: post.status, changeCase: post.changeCase ?? null });
  } catch {
    return { move: "locked", refusal: "field_locked" }; // a `changes` post whose case is unknown: say nothing can be done rather than guess
  }
  if (actions.includes("reschedule")) return { move: "reschedule", refusal: null };
  const change = post.changeCase ? { by: "", kind: "", returnTo: "", note: null, case: post.changeCase } : null;
  if (actions.includes("edit") && editableFieldsOf({ pipelineStatus: post.status, change }).fields.includes("scheduledAt")) return { move: "edit", refusal: null };
  return { move: "locked", refusal: "field_locked" };
}

// ── The grid ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FeedItem {
  postId: string;
  scheduledAt: string;
  thumbFileId: string | null;
  pipelineStatus: string;
  /** A live post: it cannot be dragged. */
  locked: boolean;
  title: string;
  format: string | null;
  phase: string | null;
  simulated: boolean;
  dateMove: DateMoveKind;
  dateMoveRefusal: DateMoveRefusal | null;
}

export interface FeedPreviewView { items: FeedItem[]; liveHidden: number }

/** `GET engagements/:engagementId/feed-preview`. Throws on a body that is not one (a wrong shape must read as "cannot tell", never as an empty grid). */
export function asFeedPreview(raw: unknown): FeedPreviewView {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("feed preview: not a list");
  const items = raw.items.map((i): FeedItem => {
    if (!isObj(i) || typeof i.postId !== "string" || typeof i.scheduledAt !== "string" || typeof i.pipelineStatus !== "string") throw new Error("feed preview: not an item");
    const locked = i.locked === true || i.pipelineStatus === "live";
    const given = i.dateMove === "edit" || i.dateMove === "reschedule" || i.dateMove === "locked" ? (i.dateMove as DateMoveKind) : null;
    // A server that does not say what a move would do is read by the rule; a post it calls locked is never offered a move.
    const move = given ? { move: given, refusal: i.dateMoveRefusal === "post_is_live" || i.dateMoveRefusal === "field_locked" ? (i.dateMoveRefusal as DateMoveRefusal) : null } : dateMoveForPost({ status: i.pipelineStatus });
    return {
      postId: i.postId, scheduledAt: i.scheduledAt, thumbFileId: str(i.thumbFileId), pipelineStatus: i.pipelineStatus, locked,
      title: str(i.title) ?? "Untitled post", format: str(i.format), phase: str(i.phase), simulated: i.simulated === true,
      dateMove: locked ? "locked" : move.move,
      dateMoveRefusal: locked ? "post_is_live" : move.move === "locked" ? move.refusal ?? "field_locked" : null,
    };
  });
  return { items, liveHidden: typeof raw.liveHidden === "number" && raw.liveHidden > 0 ? Math.floor(raw.liveHidden) : 0 };
}

/** Newest date first, then the id: the order the server sends, kept after a local change. */
export const byNewest = (a: Pick<FeedItem, "scheduledAt" | "postId">, b: Pick<FeedItem, "scheduledAt" | "postId">): number =>
  b.scheduledAt.localeCompare(a.scheduledAt) || b.postId.localeCompare(a.postId);

/** Whether a post can be moved by a swap at all. */
export const isMovable = (i: Pick<FeedItem, "dateMove" | "locked">): boolean => !i.locked && i.dateMove !== "locked";

/** Whether a swap of these two asks the client again (either is approved or scheduled: a reschedule). */
export const swapAsksClient = (a: Pick<FeedItem, "dateMove">, b: Pick<FeedItem, "dateMove">): boolean => a.dateMove === "reschedule" || b.dateMove === "reschedule";

/** The words under a post: what moving its date does. */
export function moveWords(i: Pick<FeedItem, "dateMove" | "dateMoveRefusal" | "pipelineStatus">): string {
  if (i.dateMove === "reschedule") return "Moving its date asks the client to approve it again.";
  if (i.dateMove === "edit") return "Its date can be moved.";
  if (i.dateMoveRefusal === "post_is_live") return "Live: its date cannot be changed.";
  return `Its date is locked at ${statusLabel(i.pipelineStatus)}.`;
}

// ── The swap ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The post as the page saw it: the server answers 409 `status_changed` when either has moved since. */
export interface SwapExpected { status: string; scheduledAt: string }
export interface SwapInput { postA: string; postB: string; expectedA: SwapExpected; expectedB: SwapExpected }

export interface SwappedPost { postId: string; scheduledAt: string | null; pipelineStatus: string | null; askedClient: boolean }

/** `POST …/feed-preview/swap`'s `{posts}`. Throws on a body that is not one. */
export function asSwapAnswer(raw: unknown): SwappedPost[] {
  if (!isObj(raw) || !Array.isArray(raw.posts)) throw new Error("feed preview swap: not an answer");
  return raw.posts.map((p): SwappedPost => {
    if (!isObj(p) || typeof p.postId !== "string") throw new Error("feed preview swap: not a post");
    return { postId: p.postId, scheduledAt: str(p.scheduledAt), pipelineStatus: str(p.pipelineStatus), askedClient: p.askedClient === true };
  });
}

/** The swap's input for two grid items, from what the page showed. */
export const swapInput = (a: FeedItem, b: FeedItem): SwapInput => ({
  postA: a.postId, postB: b.postId,
  expectedA: { status: a.pipelineStatus, scheduledAt: a.scheduledAt }, expectedB: { status: b.pipelineStatus, scheduledAt: b.scheduledAt },
});

/** The sentence for a refused swap, naming the post the refusal is about when the server said which (`detail.postId`). The code stays the contract's. */
export function swapRefusalText(r: { status: number; error: string; field?: string; detail?: Record<string, unknown>; reason?: string }, titleOf: (postId: string) => string | null): string {
  const words = refusalText(r);
  const id = r.detail && typeof r.detail.postId === "string" ? r.detail.postId : null;
  const title = id ? titleOf(id) : null;
  if (r.error === "field_locked") return `${title ?? "A post"}: ${words}`;
  if (r.error === "post_is_live") return `${title ?? "A post"}: ${words}`;
  if (r.error === "status_changed") return `${title ? `${title}: ` : ""}${words}`;
  if (r.error === "no_change") return "The two posts are on the same date and time, so there is nothing to swap.";
  if (r.error === "post_not_found") return "One of the posts is no longer on this client. Reload the page.";
  return words;
}

/** The sentence after a swap that went through. */
export function swapDoneText(posts: readonly SwappedPost[], titleOf: (postId: string) => string | null): string {
  const asked = posts.filter((p) => p.askedClient).map((p) => titleOf(p.postId) ?? "A post");
  if (asked.length === 0) return "The two dates are swapped.";
  return `The two dates are swapped. The client will be asked to approve ${asked.join(" and ")} again.`;
}
