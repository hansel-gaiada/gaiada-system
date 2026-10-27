// M5-W2e — the writers' room, client-safe half: types, the review-state vocabulary, "which buttons does this caller get", and every
// refusal in plain words. NO `server-only`, NO I/O (the components import this at interaction time); the readers and parsers are in
// `webdeskEditorial.ts` (server-only), the writes in `webdeskEditorialActions.ts` ("use server").
//
//   BFF (M5-W2d + M5-W1b, FRONTEND-BFF-CONTRACT §27), all under `/api/:company/modules/webdev/content/sites/:tenantSlug/:siteId/…`:
//     GET  items/:itemId                          `editorial?` and `allowed?` (what THIS caller may do with THIS item)
//     GET  items/:itemId/editorial                the item's review record: state, events, comments, SEO snapshot
//     POST items/:itemId/editorial/{submit,withdraw,request-changes,seo-signoff,approve,assign,comments}
//     POST items/:itemId/editorial/comments/:commentId/resolve
//     GET  editorial/board                        the site's review board (`countsWithheld` for a scoped caller)
//     GET|POST editorial/grants, DELETE editorial/grants/:userId/:role      (publisher tier)
//
// PERMISSIONS COME FROM `allowed`, NEVER FROM A ROLE. `editorialActionsFor` reads the item's `allowed` and its review state and nothing
// else; with no `allowed` it offers nothing and says why. The BFF checks every action again, so this only decides what to OFFER.
import type { ItemAllowed, ItemEditorial, Page, WdResult } from "./webdeskContentModel";
import { isOutcomeUnknown } from "./webdeskContentModel";

// ── Review state vocabulary ──────────────────────────────────────────────────────────────────────

export const REVIEW_STATES = ["draft", "in_review", "changes_requested", "approved"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface ReviewStateInfo {
  /** The state in words: the chip text. */
  label: string;
  /** One sentence for what the state means for the writer. */
  sentence: string;
  /** A visual tone, NEVER the only signal: the chip always carries `label` and `glyph`. */
  tone: "neutral" | "info" | "warn" | "ok";
  /** A shape that differs per state, so the four read apart without colour. */
  glyph: string;
  known: boolean;
}

export function isReviewState(s: string): s is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(s);
}

export function reviewStateInfo(state: string): ReviewStateInfo {
  switch (state) {
    case "draft": return { label: "Draft", sentence: "Being written. It has not been sent for review.", tone: "neutral", glyph: "○", known: true };
    case "in_review": return { label: "In review", sentence: "Sent for review. It is waiting for a reviewer to approve it or ask for changes.", tone: "info", glyph: "◐", known: true };
    case "changes_requested": return { label: "Changes requested", sentence: "A reviewer asked for changes. The writer revises it and sends it for review again.", tone: "warn", glyph: "▲", known: true };
    case "approved": return { label: "Approved", sentence: "Approved. The approved version can be published.", tone: "ok", glyph: "●", known: true };
    // An unknown state is shown as its own word on the neutral chip: never guessed into one of the four.
    default: return { label: state ? state.replace(/_/g, " ") : "Unknown", sentence: "WebDesk reported a review state this screen does not know.", tone: "neutral", glyph: "?", known: false };
  }
}

// ── The item's review record (`GET …/items/:id/editorial`) ───────────────────────────────────────

export interface EditorialEvent {
  id: string;
  version: number | null;
  kind: string;
  actorSub: string;
  note: string | null;
  createdAt: string;
}

export interface EditorialComment {
  id: string;
  version: number;
  /** An RFC 6901 pointer to the field the comment is about ("" = the whole document), or null = about the item. */
  anchor: string | null;
  body: string;
  authorSub: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface EditorialHistory {
  itemId: string;
  collectionKey: string;
  headVersion: number;
  deleted: boolean;
  editorial: ItemEditorial;
  events: EditorialEvent[];
  eventsTruncated: boolean;
  comments: EditorialComment[];
  commentsTruncated: boolean;
}

/** What the editorial panel starts from (the page's two reads) and holds afterwards. */
export interface EditorialInitial {
  editorial: ItemEditorial | undefined;
  allowed: ItemAllowed | undefined;
  history: EditorialHistory | null;
  /** Why `history` is null (a sentence); null when it loaded. */
  historyProblem: string | null;
}

/** What the panel holds: the item read's `editorial` + `allowed`, and the history (or why there is none). */
export interface EditorialState {
  /** The head version the BFF answered with (what a submit would name). */
  headVersion: number;
  editorial: ItemEditorial | undefined;
  allowed: ItemAllowed | undefined;
  history: EditorialHistory | null;
  /** Why `history` is null (a plain sentence), when the history read failed; null otherwise. */
  historyProblem: string | null;
}

const EVENT_WORDS: Record<string, string> = {
  "review.created": "created in the review flow",
  "review.submitted": "submitted for review",
  "review.withdrawn": "withdrew it from review",
  "review.changes_requested": "requested changes",
  "review.seo_signed": "signed off the SEO and AEO checks",
  "review.approved": "approved it",
  "review.assigned": "changed the assignment or dates",
  "review.comment": "commented",
  "review.comment_resolved": "resolved a comment",
  "review.edited": "edited it while it was in review",
  "review.reopened": "edited it after approval, so it went back to draft",
};
export function eventWords(kind: string): string {
  return EVENT_WORDS[kind] ?? kind.replace(/^review\./, "").replace(/[._]/g, " ");
}

/** The newest event of `kind`, or null. Events arrive oldest first. */
export function lastEvent(events: EditorialEvent[], kind: string): EditorialEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === kind) return events[i];
  return null;
}

/** An RFC 6901 pointer in words for a comment's anchor: "/blocks/0/props/h1" -> "h1". "" is the whole item. */
export function anchorLabel(anchor: string | null): string | null {
  if (anchor === null) return null;
  if (anchor === "") return "the whole item";
  const segs = anchor.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const rest = segs[0] === "blocks" && segs[2] === "props" ? segs.slice(3) : segs;
  return rest.length > 0 ? rest.join(" > ") : anchor;
}

/** A comment anchor the BFF will take: "" or an RFC 6901 pointer of at most 512 characters. */
export function validAnchor(a: string): boolean {
  return a.length <= 512 && (a === "" || a.startsWith("/"));
}

// ── Which actions does this caller get? ──────────────────────────────────────────────────────────

export interface EditorialActionSet {
  submit: boolean;
  withdraw: boolean;
  requestChanges: boolean;
  seoSignoff: boolean;
  approve: boolean;
  assign: boolean;
  comment: boolean;
  /** Why `approve` is on but not usable yet (a sentence), or null. */
  approveBlockedWhy: string | null;
  /** Why NOTHING is offered, in words, or null when at least one action is. The panel prints it. */
  why: string | null;
}

export const NO_ACTIONS: Omit<EditorialActionSet, "why"> = {
  submit: false, withdraw: false, requestChanges: false, seoSignoff: false, approve: false, assign: false, comment: false, approveBlockedWhy: null,
};

/**
 * The one decision function. `allowed` is the BFF's answer to "may THIS caller do THIS to THIS item" (Cerbos, one batch); the
 * review state only narrows to the moves the state machine can make. Nothing here looks at a role, a bundle or a capability.
 *   allowed absent           -> nothing is offered ("could not be checked", never "denied" and never "allowed")
 *   editorial absent         -> nothing is offered (an older WebDesk sends no review member)
 *   review off               -> nothing is offered (every item command would refuse with `review-not-enabled`)
 */
export function editorialActionsFor(editorial: ItemEditorial | undefined, allowed: ItemAllowed | undefined): EditorialActionSet {
  if (allowed === undefined) {
    return { ...NO_ACTIONS, why: "The permission check for this item did not answer, so no review actions are offered. Refresh to try again." };
  }
  if (editorial === undefined) {
    return { ...NO_ACTIONS, why: "WebDesk did not report this item's review state, so no review actions are offered." };
  }
  if (!editorial.reviewRequired) {
    return { ...NO_ACTIONS, why: "Review is not turned on for this collection, so items here are not submitted or approved. A publisher can turn review on for the collection." };
  }
  const s = editorial.state;
  const can = (k: string) => allowed[k] === true;
  const needsSeo = editorial.seoSignoffRequired === true && editorial.seoSignedCurrent !== true;
  const set: EditorialActionSet = {
    submit: can("submit") && (s === "draft" || s === "changes_requested"),
    withdraw: can("submit") && s === "in_review",
    requestChanges: can("request_changes") && s === "in_review",
    seoSignoff: can("seo_signoff") && s === "in_review" && editorial.seoSignedCurrent !== true,
    approve: can("approve") && s === "in_review",
    assign: can("assign"),
    comment: can("comment"),
    approveBlockedWhy: null,
    why: null,
  };
  if (set.approve && needsSeo) {
    set.approveBlockedWhy = `This collection needs an SEO and AEO sign-off of v${editorial.submittedVersion ?? "?"} before it can be approved.`;
  }
  const any = set.submit || set.withdraw || set.requestChanges || set.seoSignoff || set.approve || set.assign || set.comment;
  if (!any) {
    set.why = "You can read this item, but there is no review action available to you on it in its current state.";
  }
  return set;
}

/**
 * M5-W1f: the contributor's view of an action set. `allowed` stays the only source of "may I" (the backend's Cerbos DENYs already answer `approve: false`
 * and `assign: false` for a contributor); this only closes the two commands whose ROUTES the W1d fence does not open to a contributor, so a screen
 * never offers a button that would come back 403 `contributor_route_forbidden`. It reads no role. A set with nothing left says why, as before.
 */
export function forContributor(set: EditorialActionSet): EditorialActionSet {
  const next: EditorialActionSet = { ...set, approve: false, assign: false, approveBlockedWhy: null };
  if (next.why !== null) return next;
  const any = next.submit || next.withdraw || next.requestChanges || next.seoSignoff || next.comment;
  return any ? next : { ...next, why: "You can read this item, but there is no review action available to you on it in its current state." };
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

export type EditorialCommand = "submit" | "withdraw" | "requestChanges" | "seoSignoff" | "approve" | "assign" | "comment" | "resolve";

const DONE_WORDS: Record<EditorialCommand, string> = {
  submit: "Sent for review.",
  withdraw: "Withdrawn from review. It is a draft again.",
  requestChanges: "Changes requested. The author has been told.",
  seoSignoff: "SEO and AEO sign-off recorded for this version.",
  approve: "Approved. This version can now be published.",
  assign: "Assignment saved.",
  comment: "Comment added.",
  resolve: "Comment resolved.",
};
export const doneWords = (c: EditorialCommand): string => DONE_WORDS[c];

const DOING_WORDS: Record<EditorialCommand, string> = {
  submit: "sending it for review", withdraw: "withdrawing it", requestChanges: "requesting changes", seoSignoff: "recording the sign-off",
  approve: "approving it", assign: "saving the assignment", comment: "adding the comment", resolve: "resolving the comment",
};

/** Typed 409 problems of the review flow, in plain words. Keyed by the problem slug. Every one of them changed nothing. */
const CONFLICT_WORDS: Record<string, string> = {
  "review-not-enabled": "Review is not turned on for this collection, so there is nothing to submit or approve. Nothing was changed.",
  "review-state-conflict": "That can't be done in the item's current review state. It has probably just moved on: refresh to see where it is now. Nothing was changed.",
  "review-version-mismatch": "The item was edited or moved on since you opened it, so that version is no longer the one in review. Refresh, then act on the current version. Nothing was changed.",
  "seo-signoff-required": "This collection needs an SEO and AEO sign-off of this version before it can be approved. Nothing was changed.",
  "review-not-approved": "This version has not been approved, and this collection only publishes approved versions. Get it approved first. Nothing was changed.",
  "review-principal-not-allowed": "Approving and signing off are human decisions. An automation or agent account cannot make them. Nothing was changed.",
  "review-self-approval": "You wrote this version, so you can't approve it: a different person has to. Nothing was changed.",
  "idempotency-key-reused": "That request was already used for something different. Try again. Nothing was changed.",
  "item-deleted": "This item has been deleted, so it can't move through review.",
};

/** The slug of a refusal when it carries one, else null. */
function slugOf(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string | null {
  if (r.kind === "conflict") return r.slug;
  if (r.kind === "invalid") return r.slug ?? null;
  if (r.kind === "not_found") return r.slug;
  return null;
}

/** Plain words for a refused editorial command: never a raw slug, never a status code, always what the user can do. */
export function editorialRefusalCopy(command: EditorialCommand, r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  if (isOutcomeUnknown(r)) return `We couldn't confirm ${DOING_WORDS[command]}. Refresh to see what happened before you try again.`;
  const slug = slugOf(r);
  if (slug && CONFLICT_WORDS[slug]) return CONFLICT_WORDS[slug];
  switch (r.kind) {
    case "forbidden":
      return command === "approve"
        ? "You can't approve this. Either you don't have approval rights on this item, or you wrote the version being approved and a different person has to approve it. Nothing was changed."
        : command === "seoSignoff"
          ? "You can't sign off the SEO and AEO checks on this item. Nothing was changed."
          : "You don't have permission to do that on this item. Nothing was changed.";
    case "not_found":
      return slug === "comment-not-found" ? "That comment no longer exists on this item." : "This item no longer exists in WebDesk.";
    case "not_enabled":
      return r.reason === "module_disabled" ? "The Web Dev module is switched off for this company." : "The review flow isn't available on this deployment yet.";
    case "invalid":
      // The BFF's own sentence (a missing note, an assignee who could not edit the item): it is already words.
      return stripToken(r.message) ? `${stripToken(r.message)} Nothing was changed.` : "That request wasn't accepted. Nothing was changed.";
    case "conflict":
      return `${stripToken(r.message)} Nothing was changed.`;
    case "unavailable":
      if (r.code === "contract_drift") return `WebDesk answered with something unexpected (${r.reason}). Nothing was assumed to have changed.`;
      if (r.reason === "webdesk_refused") return "WebDesk refused the request. Nothing was changed.";
      if (r.reason === "session_expired") return "Your session has expired. Sign in again; nothing was changed.";
      return "Editing is unavailable: WebDesk can't be reached. Nothing was changed.";
  }
}

// ── The review board (`GET …/editorial/board`) ───────────────────────────────────────────────────

export interface BoardItem {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  title: string | null;
  headVersion: number;
  publishState: string;
  editorial: ItemEditorial;
}

export interface BoardPolicy { collectionKey: string; reviewRequired: boolean; seoSignoffRequired: boolean }

export interface EditorialBoard {
  items: BoardItem[];
  /** Per-state counts of the WHOLE site. null exactly when `countsWithheld`: the caller's scope does not cover the site. */
  counts: Record<ReviewState, number> | null;
  /** True when the BFF left `counts` out because they would disclose items outside the caller's scope. Never read it as zero. */
  countsWithheld: boolean;
  policies: BoardPolicy[];
  page: Page;
}

export interface BoardColumn { state: ReviewState | "other"; info: ReviewStateInfo; items: BoardItem[] }

/** The board's items grouped by review state, in flow order. States WebDesk may add later land in a trailing "other" column. */
export function groupBoard(items: BoardItem[]): BoardColumn[] {
  const cols: BoardColumn[] = REVIEW_STATES.map((s) => ({ state: s, info: reviewStateInfo(s), items: items.filter((i) => i.editorial.state === s) }));
  const other = items.filter((i) => !isReviewState(i.editorial.state));
  if (other.length > 0) cols.push({ state: "other", info: { ...reviewStateInfo("other"), label: "Other states" }, items: other });
  return cols;
}

// ── Grants (`…/editorial/grants`, M5-W1b; publisher tier) ────────────────────────────────────────

export const EDITORIAL_ROLES = ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"] as const;
export type EditorialRole = (typeof EDITORIAL_ROLES)[number];

export function isEditorialRole(s: string): s is EditorialRole {
  return (EDITORIAL_ROLES as readonly string[]).includes(s);
}

export const ROLE_INFO: Record<EditorialRole, { label: string; sentence: string }> = {
  webdesk_writer: { label: "Writer", sentence: "Writes and edits their own items in scope, and sends them for review." },
  webdesk_translator: { label: "Translator", sentence: "Writes translations of items that already have an approved or live source." },
  webdesk_seo_reviewer: { label: "SEO reviewer", sentence: "Reviews items in review, edits them, asks for changes and signs off the SEO and AEO checks." },
  webdesk_editor: { label: "Editor", sentence: "Reviews and approves items in scope (never their own versions), assigns work and asks for publication." },
};
export const roleLabel = (role: string): string => (isEditorialRole(role) ? ROLE_INFO[role].label : role.replace(/^webdesk_/, "").replace(/_/g, " "));

export interface EditorialGrant {
  grantId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  tenantSlug: string;
  siteId: string;
  allCollections: boolean;
  collections: string[];
  allLocales: boolean;
  locales: string[];
  expiresAt: string | null;
  grantedBy: string | null;
  updatedAt: string | null;
}

export interface GrantsBody { tenantSlug: string; siteId: string; grants: EditorialGrant[] }

/** What the grant form sends. An empty list never means "all": `allCollections` / `allLocales` say that. */
export interface GrantInput {
  userId: string;
  role: EditorialRole;
  allCollections: boolean;
  collections: string[];
  allLocales: boolean;
  locales: string[];
  /** ISO instant in the future, or null for no expiry. */
  expiresAt: string | null;
}

export interface GrantWritten { userId: string; role: string; changed: boolean; createdGrant?: boolean; removedGrant?: boolean }

/** "every collection" / "service, page" in words. */
export function scopeWords(all: boolean, list: string[], noun: string): string {
  if (all) return `every ${noun}`;
  return list.length > 0 ? list.join(", ") : `no ${noun}`;
}

const GRANT_WORDS: Record<string, string> = {
  self_grant_forbidden: "You can't give a writers' room role to yourself. Ask another publisher.",
  editorial_target_not_eligible: "That person can't hold a writers' room role: it has to be an active employee who is a member of this company.",
  editorial_role_dedicated_path: "Writers' room roles are given here, not through the general role screens.",
  editorial_grant_expiry_mismatch: "This person already holds this role with a different expiry date, and the expiry applies to all their sites. Remove the role first, then give it again with the new date.",
  unknown_collection: "One of the collections you picked doesn't exist on this site. Reload the page and try again.",
  unknown_locale: "One of the languages you picked isn't one of this site's languages. Reload the page and try again.",
  site_not_found: "That site doesn't exist or isn't one of your company's.",
  "site-not-found": "That site doesn't exist or isn't one of your company's.",
};

/** The machine token at the front of a BFF refusal ("self_grant_forbidden: a principal may not…" -> "self_grant_forbidden"). */
export function leadingToken(message: string): string | null {
  const m = /^([a-z][a-z0-9_-]*)(?::|$)/.exec(message.trim());
  return m ? m[1] : null;
}

/** A BFF sentence without its machine prefix ("invalid_request: userId must be a uuid" -> "userId must be a uuid"). */
export function stripToken(message: string): string {
  return message.replace(/^[a-z][a-z0-9_-]*:\s+/, "").trim();
}

/** Plain words for a refused grant, revoke or grants read. A 403 is a statement about the PERSON, never "empty". */
export function grantRefusalCopy(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  if (isOutcomeUnknown(r)) return "We couldn't confirm whether that was saved. Reload the list to see what happened before you try again.";
  const token = r.kind === "conflict" ? (r.slug !== "conflict" ? r.slug : leadingToken(r.message))
    : r.kind === "invalid" ? (r.slug ?? leadingToken(r.message))
    : r.kind === "not_found" ? r.slug : null;
  if (token && GRANT_WORDS[token]) return GRANT_WORDS[token];
  switch (r.kind) {
    case "forbidden": return "You can't manage writers on this site. Only a publisher (a company admin or a Web Dev manager) can give and remove writers' room roles.";
    case "not_found": return "That site doesn't exist or isn't one of your company's.";
    case "not_enabled": return r.reason === "module_disabled" ? "The Web Dev module is switched off for this company." : "Writers' room roles aren't available on this deployment yet.";
    case "invalid": return stripToken(r.message) || "That request wasn't accepted.";
    case "conflict": return stripToken(r.message);
    case "unavailable":
      if (r.code === "contract_drift") return `WebDesk answered with something unexpected (${r.reason}). Nothing was assumed to have changed.`;
      return "The website service can't be reached right now. Nothing was changed.";
  }
}
