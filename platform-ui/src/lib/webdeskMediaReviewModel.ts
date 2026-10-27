// M5-W1q (owner ruling WSK-D84) -- the contributor upload quarantine's review desk: types, parsers and plain-words copy. PURE (no
// `server-only`, no `fetch`), shared by the server read (`webdeskMediaReview.ts`), the server actions
// (`webdeskMediaReviewActions.ts`) and the panel.
//
//   BFF (FRONTEND-BFF-CONTRACT §27 "The contributor upload quarantine"), under `/api/:company/modules/webdev/content/sites/:tenantSlug/:siteId/`:
//     GET  media/quarantine?cursor&limit        -> { assets: [MediaAsset + { reviewState, allowed: { review } }], page }
//     POST media/:assetId/review {decision}     -> { asset, decision, alreadyDecided }
//   `allowed.review` is the BFF's own Cerbos answer for THAT upload (it is false for the uploader themselves); `null` means Cerbos could not
//   answer, and the controls then stay on with the server's 403 as the fallback. The page never guesses a role.
import { MediaShapeError, readMediaAsset, type MediaAsset } from "./webdeskMediaModel";
import type { Page, WdResult } from "./webdeskContentModel";

export type ReviewDecision = "accept" | "reject";
export type ReviewState = "accepted" | "quarantined" | "rejected";

export interface QuarantinedUpload {
  asset: MediaAsset;
  reviewState: ReviewState;
  /** `null`: unknown (Cerbos could not answer), never "denied". */
  allowedReview: boolean | null;
}
export interface QuarantineBody { assets: QuarantinedUpload[]; page: Page }
export interface MediaReviewed { assetId: string; decision: ReviewDecision; alreadyDecided: boolean; reviewState: ReviewState }

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, path: string): Record<string, unknown> => { if (!isRec(v)) throw new MediaShapeError(path, "object", v); return v; };
const STATES: readonly string[] = ["accepted", "quarantined", "rejected"];
const state = (v: unknown, path: string): ReviewState => {
  if (typeof v !== "string" || !STATES.includes(v)) throw new MediaShapeError(path, "accepted | quarantined | rejected", v);
  return v as ReviewState;
};

export function parseQuarantine(v: unknown): QuarantineBody {
  const o = obj(v, "quarantine");
  const assets = o.assets;
  if (!Array.isArray(assets)) throw new MediaShapeError("quarantine.assets", "array", assets);
  const page = obj(o.page, "quarantine.page");
  if (typeof page.hasMore !== "boolean") throw new MediaShapeError("quarantine.page.hasMore", "boolean", page.hasMore);
  if (typeof page.limit !== "number" || !Number.isInteger(page.limit)) throw new MediaShapeError("quarantine.page.limit", "integer", page.limit);
  if (page.cursor !== null && typeof page.cursor !== "string") throw new MediaShapeError("quarantine.page.cursor", "string or null", page.cursor);
  return {
    assets: assets.map((a, i) => {
      const path = `quarantine.assets[${i}]`;
      const r = obj(a, path);
      const allowed = obj(r.allowed, `${path}.allowed`);
      const rv = allowed.review;
      if (rv !== null && typeof rv !== "boolean") throw new MediaShapeError(`${path}.allowed.review`, "boolean or null", rv);
      return { asset: readMediaAsset(a, path), reviewState: state(r.reviewState, `${path}.reviewState`), allowedReview: rv };
    }),
    page: { cursor: page.cursor as string | null, hasMore: page.hasMore, limit: page.limit },
  };
}

export function parseMediaReviewed(v: unknown): MediaReviewed {
  const o = obj(v, "review");
  const asset = obj(o.asset, "review.asset");
  if (typeof asset.assetId !== "string") throw new MediaShapeError("review.asset.assetId", "string", asset.assetId);
  if (o.decision !== "accept" && o.decision !== "reject") throw new MediaShapeError("review.decision", "accept | reject", o.decision);
  if (typeof o.alreadyDecided !== "boolean") throw new MediaShapeError("review.alreadyDecided", "boolean", o.alreadyDecided);
  return { assetId: asset.assetId, decision: o.decision, alreadyDecided: o.alreadyDecided, reviewState: state(asset.reviewState, "review.asset.reviewState") };
}

/** Plain words for a refused read of the queue. A 403 is a statement about the PERSON, never "empty". */
export const QUEUE_FORBIDDEN_COPY =
  "You can't review uploads here. Only a Web Dev editor or publisher, a company admin or a writers' room editor can accept or reject a freelance writer's upload.";

const REVIEW_WORDS: Record<string, string> = {
  "media-not-quarantined": "That upload was already decided (or never needed a review). Reload the list to see its state.",
  "media-asset-deleted": "That upload was deleted, so it can't be reviewed any more.",
  "media-self-review": "You uploaded this yourself, so someone else has to review it.",
  "media-asset-not-found": "That upload no longer exists.",
};

/** Plain words for a refused accept or reject. */
export function reviewRefusalCopy(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  if (r.kind === "unavailable" && r.code === "upstream_error" && ["webdesk_ambiguous", "write_ambiguous", "ambiguous"].includes(r.reason)) {
    return "We couldn't confirm whether that was saved. Reload the list to see what happened before you try again.";
  }
  const token = r.kind === "conflict" ? r.slug : r.kind === "not_found" ? r.slug : null;
  if (token && REVIEW_WORDS[token]) return REVIEW_WORDS[token];
  switch (r.kind) {
    case "forbidden": return /uploaded|own upload|reviewed by the person/i.test(r.reason) ? REVIEW_WORDS["media-self-review"] : QUEUE_FORBIDDEN_COPY;
    case "not_found": return REVIEW_WORDS["media-asset-not-found"];
    case "not_enabled": return r.reason === "module_disabled" ? "The Web Dev module is switched off for this company." : "Upload review isn't available on this deployment yet.";
    case "invalid": return r.message || "That request wasn't accepted.";
    case "conflict": return r.message || "That upload changed while you were looking at it. Reload the list.";
    case "unavailable":
      if (r.code === "contract_drift") return `WebDesk answered with something unexpected (${r.reason}). Nothing was assumed to have changed.`;
      return "The website service can't be reached right now. Nothing was changed.";
  }
}

/** One short line for an upload row: type, size, dimensions. */
export function uploadFacts(a: MediaAsset): string {
  const size = a.sizeBytes >= 1_048_576 ? `${(a.sizeBytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.sizeBytes / 1024))} KB`;
  const dims = a.width && a.height ? `${a.width} x ${a.height}` : null;
  return [a.mime, size, dims].filter(Boolean).join(" · ");
}
