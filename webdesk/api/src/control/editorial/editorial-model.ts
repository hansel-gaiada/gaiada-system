// M5-W2b (writers' room design section 4) — the review state machine as PURE data: no database, no Nest.
// The commands (editorial-commands.service.ts) ask this table which transition is legal; the table-driven
// spec (test/editorial-state-machine.spec.ts) walks EVERY (command, state) pair against it. The database
// enforces only the invariants true in every state (migration 0016); which move is legal from which state
// is decided here and nowhere else.
//
// Review is per immutable VERSION: a submit, an SEO sign-off and an approval each name one content_versions
// row, and the commands refuse any other version (409 review-version-mismatch).

export const REVIEW_STATES = ["draft", "in_review", "changes_requested", "approved"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The commands that move (or stamp) the review state of one item. assign / comment / policy move nothing. */
export const TRANSITION_COMMANDS = ["submit", "withdraw", "requestChanges", "seoSignoff", "approve"] as const;
export type TransitionCommand = (typeof TRANSITION_COMMANDS)[number];

/**
 * THE event vocabulary of editorial_events.kind (0016 checks only the FORMAT ^[a-z][a-z0-9_.]{0,47}$ and
 * leaves the list to this file, so adding a kind never needs a migration). Every kind starts `review.`.
 */
export const EDITORIAL_EVENT_KINDS = [
  "review.created", // content.create on a review-required collection: the item enters the flow as a draft
  "review.submitted",
  "review.withdrawn",
  "review.changes_requested",
  "review.seo_signed",
  "review.approved",
  "review.assigned",
  "review.comment",
  "review.comment_resolved",
  "review.edited", // content.update while in_review: submitted_version followed the new head
  "review.reopened", // content.update while approved: back to draft (approved_version stays publishable)
] as const;
export type EditorialEventKind = (typeof EDITORIAL_EVENT_KINDS)[number];

export const EVENT_KIND_FORMAT = /^[a-z][a-z0-9_.]{0,47}$/;

interface TransitionRule {
  /** The states the command may run from; any other state is 409 review-state-conflict. */
  readonly from: readonly ReviewState[];
  /** The state after. `null` = the state does not move (a sign-off stamps a version only). */
  readonly to: ReviewState | null;
  readonly event: EditorialEventKind;
}

export const TRANSITIONS: Readonly<Record<TransitionCommand, TransitionRule>> = Object.freeze({
  submit: { from: ["draft", "changes_requested"], to: "in_review", event: "review.submitted" },
  withdraw: { from: ["in_review"], to: "draft", event: "review.withdrawn" },
  requestChanges: { from: ["in_review"], to: "changes_requested", event: "review.changes_requested" },
  seoSignoff: { from: ["in_review"], to: null, event: "review.seo_signed" },
  approve: { from: ["in_review"], to: "approved", event: "review.approved" },
});

export type TransitionResult =
  | { ok: true; to: ReviewState; event: EditorialEventKind }
  | { ok: false; slug: "review-state-conflict"; currentState: ReviewState };

/** Whether `command` may run from `current`, and where it lands. */
export function evaluateTransition(command: TransitionCommand, current: ReviewState): TransitionResult {
  const rule = TRANSITIONS[command];
  if (!rule.from.includes(current)) return { ok: false, slug: "review-state-conflict", currentState: current };
  return { ok: true, to: rule.to ?? current, event: rule.event };
}

/**
 * What a new version of the item does to its review state (content.update / restoreVersion, called from the
 * version writer): in_review keeps its state and the submitted version FOLLOWS the new head (so a sign-off of
 * an older version no longer counts); approved goes back to draft (approved_version survives); draft and
 * changes_requested are unchanged.
 */
export function stateAfterNewVersion(
  current: ReviewState,
): { state: ReviewState; followHead: boolean; event: EditorialEventKind | null } {
  if (current === "in_review") return { state: "in_review", followHead: true, event: "review.edited" };
  if (current === "approved") return { state: "draft", followHead: false, event: "review.reopened" };
  return { state: current, followHead: false, event: null };
}
