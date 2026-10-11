// M5-W2c (writers' room design 4.5, decision D6) — THE PUBLISH GATE: on a collection where review is ON, the
// only version that may go in front of a production key is the APPROVED one.
//
// THE RULE, in one line: for an item whose collection has review_required = true on this site, the version
// being published / scheduled / swapped in must equal editorial_items.approved_version EXACTLY. Not the head
// (promotion import and rollback append versions WITHOUT the review hooks, so the head can move under an
// approved item), and not the state alone (an edit after approval returns the item to `draft` while
// approved_version stays publishable, design 4.1; and an `approved` state says nothing about WHICH bytes).
// No editorial_items row, or approved_version NULL, is "nothing approved": refused.
//
// REVIEW OFF (no policy row, or review_required = false, the default) is a no-op: one SELECT of the policy per
// distinct collection in the request, nothing else, no refusal. The importer, deck sections and client sites
// behave exactly as before.
//
// WHERE IT RUNS (design 4.5 "Order"), always inside the command's own transaction, under the content item locks:
//   content.publish   after the WS4 claim (the envelope's audit row) and D62's client-path check, before any
//                     effect; one refusal refuses the WHOLE batch, so the transaction rolls back and the claim with it;
//   content.schedule  the same, for a schedule that publishes (publishAt set); a takedown-only schedule is not gated;
//   the scheduler     a due version swap (WSK-61 step 2) is re-checked at fire time; a stale one is marked failed.
// The item lock is what makes the read consistent: every writer of editorial_items (the review commands, the
// version hooks) locks the content item FIRST, so nothing can approve or re-approve between this read and the effect.
//
// FOR EVERY PRINCIPAL CLASS: human, automation, agent, client editor (`ce`). A client editor cannot approve
// (no editorial command is on CLIENT_EDITOR_COMMANDS), so on a review-required client collection a client's
// self-publish (D58) needs an agency approval first; D62's path check still runs independently, before this.
import type { PoolClient } from "pg";
import { ControlProblem } from "../content/content-problem";
import { loadPolicy, type PolicyRow } from "./editorial-store";
import type { ReviewState } from "./editorial-model";

/** At most this many refused items are listed in the problem body; `total` always counts all of them. */
const MAX_LISTED = 50;

/** One item of a publish / schedule / swap, in request order. */
export interface GateItem {
  /** Position in the request's `items` (what the refusal names). */
  index: number;
  itemId: string;
  collectionKey: string;
  /** The EXACT version that would go live. */
  version: number;
}

/** Why one item is refused. */
export interface ReviewRefusal {
  itemIndex: number;
  itemId: string;
  version: number;
  /** The version that IS approved, or null when nothing is. */
  approvedVersion: number | null;
  /** The item's review state (an item the flow never touched reads as `draft`). */
  reviewState: ReviewState;
}

/**
 * Every item in `items` that the gate refuses (empty = all may go live). Reads only; never throws for a
 * refusal. Policies are read once per distinct collection; the review rows in one query, and only when some
 * collection has review on.
 */
export async function reviewRefusals(client: PoolClient, siteId: string, items: readonly GateItem[]): Promise<ReviewRefusal[]> {
  if (items.length === 0) return [];
  const policies = new Map<string, PolicyRow>();
  for (const key of new Set(items.map((i) => i.collectionKey))) policies.set(key, await loadPolicy(client, siteId, key));
  const gated = items.filter((i) => policies.get(i.collectionKey)?.reviewRequired === true);
  if (gated.length === 0) return [];

  const { rows } = await client.query<{ content_item_id: string; state: ReviewState; approved_version: number | null }>(
    `SELECT content_item_id, state, approved_version FROM editorial_items WHERE content_item_id = ANY($1::uuid[])`,
    [[...new Set(gated.map((i) => i.itemId))]],
  );
  const review = new Map(rows.map((r) => [r.content_item_id, r]));
  const refused: ReviewRefusal[] = [];
  for (const i of gated) {
    const r = review.get(i.itemId);
    const approvedVersion = r?.approved_version ?? null;
    if (approvedVersion !== null && approvedVersion === i.version) continue;
    refused.push({ itemIndex: i.index, itemId: i.itemId, version: i.version, approvedVersion, reviewState: r?.state ?? "draft" });
  }
  return refused;
}

/** reviewRefusals, then 409 `review-not-approved` naming every refused item when there is any. */
export async function assertReviewApproved(client: PoolClient, siteId: string, items: readonly GateItem[]): Promise<void> {
  const refused = await reviewRefusals(client, siteId, items);
  if (refused.length > 0) throw reviewNotApproved(refused);
}

/**
 * 409 `review-not-approved` (design 4.1's slug). `items` names each refused item by its request index, with the
 * version asked for and the version that is approved (null = none). Nothing was published or scheduled, and the WS4 approval was not consumed.
 */
export function reviewNotApproved(refused: readonly ReviewRefusal[]): ControlProblem {
  const n = refused.length;
  return new ControlProblem(
    409,
    "review-not-approved",
    "Review not approved",
    `Editorial review is required for ${n === 1 ? "this item's collection" : "these items' collections"}, and ` +
      `${n === 1 ? "the version asked for is not the approved version" : `${n} of the versions asked for are not the approved versions`}. ` +
      "Only the exact approved version can go live. Nothing was published or scheduled.",
    {
      items: refused.slice(0, MAX_LISTED).map((r) => ({ itemIndex: r.itemIndex, itemId: r.itemId, version: r.version, approvedVersion: r.approvedVersion })),
      total: n,
    },
  );
}

/** The scheduler's fail_reason for a swap the gate refuses at fire time (no item content, ids and numbers only). */
export function swapRefusalReason(r: ReviewRefusal): string {
  return `review-not-approved: version ${r.version} is not the approved version (${r.approvedVersion === null ? "nothing is approved" : `approved: ${r.approvedVersion}`})`;
}
