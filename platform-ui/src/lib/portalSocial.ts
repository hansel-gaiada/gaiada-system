// SCP-2 (BFF §63.9) — the client's post approval page: TYPES and PURE helpers. Client-safe on purpose (no server imports), so the
// server page, the client components and the tests all read the same words. Readers are in `portal-data.ts`, writes in
// `portalSocialActions.ts`.
//
// The client sees the content, the date and time, the placement, the decisions and the comments written for them: everything their
// approval covers, and nothing else. No staff status, holder, check, suggestion or name appears in these types, and none is added here
// (the only staff name the client may see is the author of a comment written for them).
import { DISPLAY_TZ } from "./format";
import type { CommentAnchor } from "./pm";

// ── the shapes of BFF §63.9 ───────────────────────────────────────────────────────────────────────────────────────────────
export type PortalSocialState = "to_review" | "changes_asked" | "approved" | "scheduled" | "live";
export type PortalSocialSurface = "feed" | "carousel" | "reel" | "story";
export type PortalSocialTab = "to_review" | "grid" | "approved";

export interface PortalSocialImage { fileId: string; thumbFileId: string; position: number; alt: string }
export interface PortalSocialVariant {
  id: string; network: string; handle: string; surface: PortalSocialSurface; body: string; firstComment: string | null; scheduledAt: string | null;
}
export interface PortalSocialDecision {
  decisionId: string;
  kind: "approved" | "changes";
  changeKind?: "copy" | "design";
  note?: string;
  anchor?: CommentAnchor | null;
  decidedAt: string;
  /** The contact who decided: null when our team recorded it for them (never a staff name). */
  decidedBy: { name: string } | null;
  recorded: boolean;
  channel?: string;
  /** Set only while the decision can still be undone (10 s after it was made, and never for a recorded one). */
  undoUntil?: string;
}
export interface PortalSocialComment { id: string; body: string; author: { name: string }; anchor?: CommentAnchor | null; createdAt: string }
export interface PortalSocialPost {
  id: string; clientId: string; clientName: string; month: string; title: string; format: PortalSocialSurface;
  plannedAt: string | null; placement: string[]; state: PortalSocialState;
  caption: string; onAssetText: string; cta: string; hashtags: string[];
  images: PortalSocialImage[]; variants: PortalSocialVariant[];
  reviewHash: string;
  decision: PortalSocialDecision | null;
  comments?: PortalSocialComment[];
  liveUrl: string | null; simulated: boolean;
}
export interface PortalSocialCounts { toReview: number; approved: number; changesAsked: number }
export interface PortalSocialList { items: PortalSocialPost[]; nextCursor: string | null; counts: PortalSocialCounts }

/** `POST portal/social/posts/:postId/decide` answers this (or, on a replay, `{alreadyDecided: true}`). */
export interface PortalSocialDecided { decisionId?: string; postId?: string; state?: PortalSocialState; undoUntil?: string; alreadyDecided?: boolean }
export interface PortalSocialBulkResult { postId: string; outcome: "approved" | "skipped"; reason?: string; decisionId?: string }
export interface PortalSocialBulkAnswer { results: PortalSocialBulkResult[]; undoUntil?: string | null }

/** The decision window the server gives (BFF §63.9). The page counts down from the server's `undoUntil`, this is only the fallback. */
export const UNDO_WINDOW_MS = 10_000;
/** The note of a change request: 1 to 2,000 characters (BFF §63.9). */
export const CHANGE_NOTE_MAX = 2000;

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NETWORK_WORDS: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", linkedin: "LinkedIn", youtube: "YouTube", x: "X", twitter: "X", threads: "Threads", pinterest: "Pinterest",
};
export function networkLabel(network: string): string {
  return NETWORK_WORDS[network.toLowerCase()] ?? network.charAt(0).toUpperCase() + network.slice(1);
}

const SURFACE_WORDS: Record<PortalSocialSurface, string> = { feed: "Feed post", carousel: "Carousel", reel: "Reel", story: "Story" };
export function surfaceLabel(format: PortalSocialSurface): string { return SURFACE_WORDS[format] ?? format; }

const STATE_WORDS: Record<PortalSocialState, string> = {
  to_review: "Waiting for you", changes_asked: "Changes asked", approved: "Approved", scheduled: "Approved and scheduled", live: "Published",
};
export function stateLabel(state: PortalSocialState): string { return STATE_WORDS[state] ?? state; }

/** A `--status-*` tone for the state's dot, in the portal's own vocabulary (tokens only, see PortalBits). */
export function stateTone(state: PortalSocialState): "warning" | "info" | "success" | "neutral" {
  switch (state) {
    case "to_review": return "warning";
    case "changes_asked": return "info";
    case "approved": case "scheduled": case "live": return "success";
    default: return "neutral";
  }
}

const CHANNEL_WORDS: Record<string, string> = { whatsapp: "WhatsApp", email: "email", meeting: "a meeting" };
export function channelLabel(channel: string | undefined): string | null {
  if (!channel) return null;
  return CHANNEL_WORDS[channel.toLowerCase()] ?? channel;
}

/** "Recorded by our team on your behalf (via WhatsApp)". Never a staff name: the server sends none, and this never asks for one. */
export function recordedLine(d: Pick<PortalSocialDecision, "channel">): string {
  const via = channelLabel(d.channel);
  return via ? `Recorded by our team on your behalf (via ${via})` : "Recorded by our team on your behalf";
}

/** The one line that says what was decided, who by and when: used under a post's image once it is no longer waiting. */
export function decisionLine(d: PortalSocialDecision): string {
  const what = d.kind === "approved" ? "Approved" : d.changeKind === "design" ? "Design changes asked" : d.changeKind === "copy" ? "Text changes asked" : "Changes asked";
  if (d.recorded) return `${what}. ${recordedLine(d)}, ${whenLabel(d.decidedAt)}.`;
  return `${what}${d.decidedBy?.name ? ` by ${d.decidedBy.name}` : ""}, ${whenLabel(d.decidedAt)}.`;
}

/** The server's refusal codes, in plain words for the person who clicked. `content_changed` and `post_not_with_client` are branched on by the
 *  caller (they reload the post or the list); the words here are what they read meanwhile. */
const DECIDE_ERROR_WORDS: Record<string, string> = {
  content_changed: "This post changed while you were looking; here is the new version.",
  post_not_with_client: "This post is no longer waiting for your decision. The list has been refreshed.",
  client_review_already_decided: "This post was already decided differently. Refresh the page to see where it stands.",
  not_your_decision: "Only the person who made this decision can undo it.",
  undo_window_passed: "It is too late to undo this one: it was already passed on to our team.",
  decision_not_found: "We could not find that decision.",
  post_not_found: "We could not find that post.",
  not_a_portal_client: "This page is for client accounts.",
  "not a portal client": "This page is for client accounts.",
};
const FIELD_WORDS: Record<string, string> = {
  note: `Tell us what to change, in 1 to ${CHANGE_NOTE_MAX.toLocaleString("en-GB")} characters.`,
  changeKind: "Choose whether the change is to the text or to the design.",
  decision: "Choose Approve or Ask for changes.",
  anchor: "The pin could not be placed. Try placing it again, or leave it out.",
  seenHash: "We could not tell which version you were looking at. Refresh the page and try again.",
  items: "Choose between 1 and 50 posts.",
};
export function describeDecideError(code: string, field?: string): string {
  if (DECIDE_ERROR_WORDS[code]) return DECIDE_ERROR_WORDS[code];
  if (field && FIELD_WORDS[field]) return FIELD_WORDS[field];
  return /^[a-z0-9_]+$/.test(code) ? "That did not work. Refresh the page and try again." : code;
}

const SKIP_WORDS: Record<string, string> = {
  content_changed: "changed while you were looking",
  post_not_with_client: "was no longer waiting for you",
  post_not_found: "could not be found",
  client_review_already_decided: "was already decided",
};
export function skipReasonText(reason: string | undefined): string {
  return (reason && SKIP_WORDS[reason]) || "could not be approved";
}

/** "Approved 3 posts. Skipped 'A', which changed while you were looking." One sentence per fact, in plain words. */
export function bulkSummary(results: ReadonlyArray<PortalSocialBulkResult>, titleOf: (postId: string) => string): { approved: number; skipped: string[]; text: string } {
  const approved = results.filter((r) => r.outcome === "approved").length;
  const skipped = results.filter((r) => r.outcome === "skipped").map((r) => `"${titleOf(r.postId)}" ${skipReasonText(r.reason)}`);
  const head = approved === 0 ? "Nothing was approved." : approved === 1 ? "Approved 1 post." : `Approved ${approved} posts.`;
  const tail = skipped.length === 0 ? "" : skipped.length === 1 ? ` Skipped: ${skipped[0]}.` : ` Skipped ${skipped.length}: ${skipped.join("; ")}.`;
  return { approved, skipped, text: `${head}${tail}` };
}

// ── dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** "Tue 27 Oct, 17:30" in the fixed display zone (hydration-safe: the same text on the server and in the browser). */
export function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "No date yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No date yet";
  return d.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TZ });
}
/** The day alone, for the grid: "27 Oct". */
export function dayLabel(iso: string | null | undefined): string {
  if (!iso) return "No date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No date";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: DISPLAY_TZ });
}
/** "October 2026" for a `YYYY-MM` month. */
export function monthLabel(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
/** `YYYY-MM` shifted by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const t = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** The months the switcher offers: two before today's, today's, and two after, plus the selected one when it is outside that range. */
export function monthOptions(todayMonth: string, selected: string | null): string[] {
  const list = [-2, -1, 0, 1, 2].map((d) => shiftMonth(todayMonth, d));
  if (selected && !list.includes(selected)) list.push(selected);
  return list.sort();
}

// ── the URL: tab, month, client ───────────────────────────────────────────────────────────────────────────────────────────
export function parseTab(v: string | string[] | undefined): PortalSocialTab {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "grid" || s === "approved" ? s : "to_review";
}
/** A `YYYY-MM` month, or null (no month filter: every month). */
export function parseMonth(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null;
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export function parseId(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && ID.test(s) ? s : null;
}
/** The cursor the server gave for the next page: opaque, so only its alphabet and length are checked. */
export function parseCursor(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^[A-Za-z0-9_\-=.+/]{1,200}$/.test(s) ? s : null;
}
/** The tab a post is listed on: waiting posts on To review, decided and live ones on Approved, and posts with changes asked on the Grid preview. */
export function tabForState(state: PortalSocialState): PortalSocialTab {
  return state === "to_review" ? "to_review" : state === "changes_asked" ? "grid" : "approved";
}
/** The page's own URL with some parameters changed (a null or empty value removes one). Keeps the others, so a tab link keeps the month. */
export function socialHref(current: { tab?: string | null; month?: string | null; clientId?: string | null; post?: string | null; cursor?: string | null }, change: Partial<Record<"tab" | "month" | "clientId" | "post" | "cursor", string | null>> = {}): string {
  const merged: Record<string, string | null | undefined> = { ...current, ...change };
  const qs = new URLSearchParams();
  for (const k of ["tab", "month", "clientId", "post", "cursor"] as const) {
    const v = merged[k];
    if (v && !(k === "tab" && v === "to_review")) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `/portal/social?${s}` : "/portal/social";
}

// ── files ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The portal's own file route (BFF §63.8): a portal user sees only their client's files, and a pin's `fileId` is the full file. */
export function portalSocialFileHref(tenant: string, fileId: string): string {
  return `/api/${encodeURIComponent(tenant)}/portal/files/${encodeURIComponent(fileId)}`;
}

// ── the change request, before it is sent ─────────────────────────────────────────────────────────────────────────────────
export type ChangeProblem = { field: "changeKind" | "note"; message: string };
/** PURE. What the dialog checks before it sends; the server checks the same (400 `{field}`). */
export function changeProblem(changeKind: string | null, note: string): ChangeProblem | null {
  if (changeKind !== "copy" && changeKind !== "design") return { field: "changeKind", message: FIELD_WORDS.changeKind };
  const len = [...note.trim()].length;
  if (len < 1) return { field: "note", message: "Write a note so we know what to change." };
  if (len > CHANGE_NOTE_MAX) return { field: "note", message: `The note is ${len.toLocaleString("en-GB")} characters; the most we can take is ${CHANGE_NOTE_MAX.toLocaleString("en-GB")}.` };
  return null;
}

/** The posts "Approve all" would send: exactly those waiting, with the hash the client was shown, at most 50 (BFF §63.9). */
export function approveAllItems(posts: ReadonlyArray<Pick<PortalSocialPost, "id" | "state" | "reviewHash">>): Array<{ postId: string; seenHash: string }> {
  return posts.filter((p) => p.state === "to_review").slice(0, 50).map((p) => ({ postId: p.id, seenHash: p.reviewHash }));
}
