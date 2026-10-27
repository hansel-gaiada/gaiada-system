// DW-6h UI (contract §35.5, §35.6, §35.8): asset versions and review rounds. Pure, client-safe helpers: the row types the
// backend answers, the review chip and version badge mapping, the error-token to sentence mapping, which actions show in
// which state, and the URL builders the readers use. No server-only import, so client components and tests use it freely.
// The server stays the authority on every rule here; the UI only decides what is worth offering.

/** One live version of an asset, as `GET /creative/assets` and `GET /creative/assets/:id/versions` answer (§35.5). */
export interface AssetVersionFields {
  versionNo: number;
  /** The group key. A first version reports its own id (§35.8 item 2). The comment thread's `entityId`. */
  versionGroupId: string;
  supersedesId: string | null;
  versionCount: number;
  isLatest: boolean;
  review: { round: number; status: ReviewStatus } | null;
  /** SCP-1h: where this version came from and, for an AI-made one, how. Optional so an older backend still types. */
  source?: string;
  aiNote?: string | null;
}

export type ReviewStatus = "open" | "approved" | "changes_requested" | "withdrawn" | "superseded";

/** One row of the versions list (the library row shape, with the version fields). */
export interface AssetVersion extends AssetVersionFields {
  id: string;
  name: string;
  content_type: string;
  width: number | null;
  height: number | null;
  department_id: string | null;
  uploader_id: string | null;
  created_at: string;
}

/** One review round (§35.3, §35.8). */
export interface ReviewRound {
  id: string;
  round: number;
  status: ReviewStatus;
  assetId: string;
  versionNo: number;
  groupId: string;
  note: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
}

// ---- chip and badge ----------------------------------------------------------------------------------------------

/** The library card's review chip. Only the three states a reader acts on get one; withdrawn, superseded and "no round"
 *  show nothing (a closed-without-decision round is history, not a status of the asset). */
export function reviewChip(review: { status: string } | null | undefined): { label: string } | null {
  switch (review?.status) {
    case "open": return { label: "In review" };
    case "approved": return { label: "Approved" };
    case "changes_requested": return { label: "Changes requested" };
    default: return null;
  }
}

/** The quiet "v3" badge, only when the group has more than one live version. */
export function versionBadge(a: { versionNo?: number; versionCount?: number }): string | null {
  return typeof a.versionNo === "number" && typeof a.versionCount === "number" && a.versionCount > 1 ? `v${a.versionNo}` : null;
}

/** A round's status in words, for the rounds list (every status, not only the chip's three). */
export function roundStatusLabel(status: string): string {
  switch (status) {
    case "open": return "Open";
    case "approved": return "Approved";
    case "changes_requested": return "Changes requested";
    case "withdrawn": return "Withdrawn";
    case "superseded": return "Superseded by a newer version";
    default: return status;
  }
}

// ---- error tokens ------------------------------------------------------------------------------------------------

const TOKEN_SENTENCES: Record<string, string> = {
  not_latest_version: "This isn't the latest version, so it can't be put into review. Open the latest version.",
  review_open: "A review is already open on this asset.",
  review_not_open: "That review round is no longer open.",
  asset_deleted: "This asset was deleted.",
  asset_not_found: "This asset couldn't be found.",
  review_not_found: "That review round couldn't be found.",
  version_conflict: "Someone saved a version at the same moment. Try again.",
  comment_required: "Add a comment explaining what needs to change.",
  comment_invalid: "That comment isn't valid. Shorten it and try again.",
  note_invalid: "That note isn't valid. Shorten it and try again.",
  decision_invalid: "That decision isn't recognised.",
  version_of_invalid: "The asset to add a version to isn't valid.",
  versions_invalid: "That version filter isn't valid.",
  body_invalid: "That request wasn't valid.",
  // SCP-1h: the save's source and AI note (400 `source_invalid`, `ai_note_invalid`, `ai_note_required`).
  source_invalid: "That source isn't one of the choices.",
  ai_note_invalid: "That AI note isn't valid. Keep it to 1,000 characters or fewer.",
  ai_note_required: "Add a note on how the AI picture was made.",
};

export const FORBIDDEN_SENTENCE = "You can't do this on this asset.";

/** The leading token of a backend message (`not_latest_version: ...`), or null when the message does not start with one. */
export function errorToken(message: string | null | undefined): string | null {
  const m = /^([a-z][a-z0-9_]*)(?=$|[\s:.,;-])/.exec((message ?? "").trim());
  return m && m[1] in TOKEN_SENTENCES ? m[1] : null;
}

/** Plain words for a refusal. A 403 is the calm "You can't do this on this asset"; a known token (at the start of the
 *  message, or in `reason`) gets its sentence; anything else passes the backend's own words through. */
export function creativeErrorSentence(e: { status?: number; message?: string; reason?: string }): string {
  if (e.status === 403) return FORBIDDEN_SENTENCE;
  const token = errorToken(e.reason) ?? errorToken(e.message);
  if (token) return TOKEN_SENTENCES[token];
  return e.message?.trim() || "That didn't work. Try again.";
}

// ---- which actions show ------------------------------------------------------------------------------------------

export interface ActionState {
  /** The version the detail is showing. */
  isLatest: boolean;
  /** The group's open round, if any. `"unknown"` when the rounds could not be read (refused or unavailable): no review
   *  action is offered then, since none of them can be judged. */
  openRound: Pick<ReviewRound, "round" | "requestedBy"> | null | "unknown";
  /** The signed-in user's id. */
  meId: string | null;
}

export interface ActionVisibility {
  uploadVersion: boolean;
  requestReview: boolean;
  approve: boolean;
  requestChanges: boolean;
  withdraw: boolean;
}

/** Show an action only when it can work (§35.6). The one Cerbos rule mirrored is the cheap and safe one: whoever opened the
 *  round is not offered Approve. "Request changes" stays offered to them (the server's DENY covers `decide_review`, so a
 *  refusal is shown if it applies). Everything else is tried, and a 403 is shown calmly. */
export function visibleActions(s: ActionState): ActionVisibility {
  const open = s.openRound;
  if (open === "unknown") return { uploadVersion: true, requestReview: false, approve: false, requestChanges: false, withdraw: false };
  return {
    uploadVersion: true,
    requestReview: s.isLatest && !open,
    approve: !!open && !(s.meId && open.requestedBy === s.meId),
    requestChanges: !!open,
    withdraw: !!open,
  };
}

/** The group's open round from the rounds list (newest first), if any. */
export function openRoundOf(rounds: ReviewRound[]): ReviewRound | null {
  return rounds.find((r) => r.status === "open") ?? null;
}

// ---- reader URLs -------------------------------------------------------------------------------------------------

export interface AssetListOpts {
  trainingReady?: boolean;
  departmentId?: string;
  versions?: "latest" | "all";
}

/** `/api/:t/creative/assets` with the query the options ask for. `versions` is left out for the default (`latest`). */
export function assetListPath(tenant: string, opts: AssetListOpts = {}): string {
  const q = new URLSearchParams();
  if (opts.trainingReady !== undefined) q.set("trainingReady", String(opts.trainingReady));
  if (opts.departmentId) q.set("departmentId", opts.departmentId);
  if (opts.versions && opts.versions !== "latest") q.set("versions", opts.versions);
  const s = q.toString();
  return `/api/${encodeURIComponent(tenant)}/creative/assets${s ? `?${s}` : ""}`;
}

export const assetVersionsPath = (tenant: string, assetId: string) =>
  `/api/${encodeURIComponent(tenant)}/creative/assets/${encodeURIComponent(assetId)}/versions`;
export const assetReviewsPath = (tenant: string, assetId: string) =>
  `/api/${encodeURIComponent(tenant)}/creative/assets/${encodeURIComponent(assetId)}/reviews`;

/** The thumbnail and download of a version: the staff download route streams the graded bytes. */
export const assetContentHref = (assetId: string) => `/api/creative-assets/${encodeURIComponent(assetId)}`;
