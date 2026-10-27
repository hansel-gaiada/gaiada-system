"use server";
// M5-W1q (WSK-D84) -- the review desk's writes and its client-driven re-read, as server actions. Same shape as
// `webdeskMediaActions.ts`: a `WdResult` for everything; a refusal is DATA (never thrown). There is NO `can(me, ...)` gate here: whether the
// buttons are on comes from the BFF's own per-upload `allowed.review`, and the BFF asks Cerbos again before it validates the body.
//
//   GET  …/sites/:t/:s/media/quarantine?cursor&limit    -> { assets: [... + allowed: {review}], page }
//   POST …/sites/:t/:s/media/:assetId/review {decision} -> { asset, decision, alreadyDecided }
//
// `idempotencyKey` is one per user intent and reused when the same click is retried, so a retry after a lost answer cannot decide twice.
import { isMediaCtx, mediaBase, mediaCall, mediaCtx } from "./webdeskMedia";
import { listQuarantine } from "./webdeskMediaReview";
import type { SiteScope } from "./webdeskContentActions";
import type { WdResult } from "./webdeskContentModel";
import { parseMediaReviewed, type MediaReviewed, type QuarantineBody, type ReviewDecision } from "./webdeskMediaReviewModel";

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const scopeOk = (s: SiteScope): boolean => !!clean(s?.tenantSlug) && !!clean(s?.siteId);
const badScope: WdResult<never> = { kind: "invalid", issues: [], message: "Missing site." };
const IDEM_RE = /^[\x21-\x7e]{8,200}$/;

export async function listQuarantineAction(scope: SiteScope, cursor?: string): Promise<WdResult<QuarantineBody>> {
  const c = await mediaCtx(); if (!isMediaCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  return listQuarantine(c.userId, c.company, clean(scope.tenantSlug), clean(scope.siteId), clean(cursor) || undefined);
}

export async function reviewUploadAction(scope: SiteScope, assetId: string, decision: ReviewDecision, idempotencyKey?: string): Promise<WdResult<MediaReviewed>> {
  const c = await mediaCtx(); if (!isMediaCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  if (!clean(assetId)) return { kind: "invalid", issues: [], message: "Missing upload." };
  if (decision !== "accept" && decision !== "reject") return { kind: "invalid", issues: [], message: 'Choose "accept" or "reject".' };
  const r = await mediaCall(`${mediaBase(c.company, clean(scope.tenantSlug), clean(scope.siteId))}/${encodeURIComponent(clean(assetId))}/review`, c.userId, parseMediaReviewed, {
    method: "POST",
    body: JSON.stringify({ decision }),
    ...(idempotencyKey && IDEM_RE.test(idempotencyKey) ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
  });
  return r as WdResult<MediaReviewed>; // a review is never `in_use`
}
