"use server";
// WSK-43c — the media library's writes and its client-driven reads, as server actions.
//
//   GET    …/sites/:tenantSlug/:siteId/media?mime&q&tag&cursor&limit       list (filters, "load more", the picker)
//   GET    …/media/:assetId/usage                                           "Where it's used"
//   POST   …/media/upload-token  {bucket}                                   -> {uploadUrl, expiresAt, maxBytes, allowedMimes}
//   PATCH  …/media/:assetId      {title?, alt?, tags?}                      replace-all per key
//   DELETE …/media/:assetId                                                 -> 409 `media-in-use` {total, items}
//
// The FILE never goes through these: `mintUploadTokenAction` returns the one-time `uploadUrl` and the browser POSTs the
// bytes straight to WebDesk (`mediaUpload.ts`). The token is a secret: this file never logs it and never puts it in a
// result's `reason`; the BFF's own body carries only `{uploadUrl, expiresAt, maxBytes, allowedMimes}`.
//
// Same shape as `webdeskContentActions.ts` (and the same reasons): a `WdResult` for everything, a 403 comes back as
// `{ kind: "forbidden" }` and the library turns that control off with the reason; there is NO `can(me, …)` gate because
// `lib/rbac.ts` has no mirror of the `webdesk_media_asset` kind (UI gating is cosmetic; the BFF's `authorize()` is
// the first statement of every media handler).
//
// Request bodies carry ONLY the keys the BFF takes (it 400s an unknown key). Writes carry an `Idempotency-Key` when the
// caller supplies one: a `502 webdesk_ambiguous` ("we couldn't confirm") is retried with the SAME key so WebDesk replays
// the first answer instead of applying the change twice.
import { getMediaUsage, isMediaCtx, listMedia, mediaBase, mediaCall, mediaCtx } from "./webdeskMedia";
import type { SiteScope } from "./webdeskContentActions";
import type { WdResult } from "./webdeskContentModel";
import {
  parseMediaDeleted, parseMediaUpdated, parseUploadToken,
  type MediaAsset, type MediaDeleted, type MediaListBody, type MediaQuery, type MediaUsage, type MediaWriteResult, type UploadToken,
} from "./webdeskMediaModel";

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const scopeOk = (s: SiteScope): boolean => !!clean(s?.tenantSlug) && !!clean(s?.siteId);
const badScope: WdResult<never> = { kind: "invalid", issues: [], message: "Missing site." };
const badAsset: WdResult<never> = { kind: "invalid", issues: [], message: "Missing asset." };

const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/;
const IDEM_RE = /^[\x21-\x7e]{8,200}$/;
const idemHeaders = (key: string | undefined): Record<string, string> => (key && IDEM_RE.test(key) ? { "idempotency-key": key } : {});

/** Only the filters WebDesk's list understands, each bounded; anything else is dropped (never forwarded blind). */
function cleanQuery(q: MediaQuery | undefined): MediaQuery {
  const out: MediaQuery = {};
  const mime = clean(q?.mime);
  if (mime && MIME_RE.test(mime) && mime.length <= 100) out.mime = mime;
  const text = clean(q?.q);
  if (text) out.q = text.slice(0, 200);
  const tag = clean(q?.tag);
  if (tag) out.tag = tag.slice(0, 40);
  const cursor = clean(q?.cursor);
  if (cursor && cursor.length <= 512) out.cursor = cursor;
  if (Number.isInteger(q?.limit)) out.limit = q?.limit;
  return out;
}

export async function listMediaAction(scope: SiteScope, query?: MediaQuery): Promise<WdResult<MediaListBody>> {
  const c = await mediaCtx(); if (!isMediaCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  return listMedia(c.userId, c.company, clean(scope.tenantSlug), clean(scope.siteId), cleanQuery(query));
}

export async function mediaUsageAction(scope: SiteScope, assetId: string): Promise<WdResult<MediaUsage>> {
  const c = await mediaCtx(); if (!isMediaCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  if (!clean(assetId)) return badAsset;
  return getMediaUsage(c.userId, c.company, clean(scope.tenantSlug), clean(scope.siteId), clean(assetId));
}

/** One token per file (a token is single-use and is spent even by a refused body). `bucket` is `media` (images, PDFs) or
 *  `video`; the token's own `allowedMimes` and `maxBytes` come back so the browser can refuse a bad file before sending it. */
export async function mintUploadTokenAction(scope: SiteScope, bucket: "media" | "video"): Promise<WdResult<UploadToken>> {
  const c = await mediaCtx(); if (!isMediaCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  if (bucket !== "media" && bucket !== "video") return { kind: "invalid", issues: [], message: "Choose a bucket." };
  const r = await mediaCall(`${mediaBase(c.company, clean(scope.tenantSlug), clean(scope.siteId))}/upload-token`, c.userId, parseUploadToken, {
    method: "POST", body: JSON.stringify({ bucket }),
  });
  return r as WdResult<UploadToken>;
}

export interface MediaPatch {
  title?: string | null;
  /** The COMPLETE locale -> text map (`{}` clears; an empty text drops its key). */
  alt?: Record<string, string>;
  /** The COMPLETE tag list (`[]` clears). */
  tags?: string[];
}

export async function updateMediaAction(scope: SiteScope, assetId: string, patch: MediaPatch, idempotencyKey?: string): Promise<WdResult<{ asset: MediaAsset }>> {
  const c = await mediaCtx(); if (!isMediaCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  if (!clean(assetId)) return badAsset;
  // Strict body: only the three keys, and at least one.
  const body: MediaPatch = {};
  if (patch && "title" in patch) body.title = patch.title === null ? null : String(patch.title ?? "");
  if (patch && patch.alt && typeof patch.alt === "object") {
    body.alt = Object.fromEntries(Object.entries(patch.alt).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
  }
  if (patch && Array.isArray(patch.tags)) body.tags = patch.tags.filter((t): t is string => typeof t === "string");
  if (Object.keys(body).length === 0) return { kind: "invalid", issues: [], message: "Nothing to change." };
  const r = await mediaCall(`${mediaBase(c.company, clean(scope.tenantSlug), clean(scope.siteId))}/${encodeURIComponent(clean(assetId))}`, c.userId, parseMediaUpdated, {
    method: "PATCH", body: JSON.stringify(body), headers: idemHeaders(idempotencyKey),
  });
  return r as WdResult<{ asset: MediaAsset }>;
}

/** Soft delete. Refused with `{ kind: "in_use", total, items }` while any live or draft item (or a pending scheduled swap)
 *  names the asset: the dialog shows those items instead of a bare failure. */
export async function deleteMediaAction(scope: SiteScope, assetId: string, idempotencyKey?: string): Promise<MediaWriteResult<MediaDeleted>> {
  const c = await mediaCtx(); if (!isMediaCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  if (!clean(assetId)) return badAsset;
  return mediaCall(`${mediaBase(c.company, clean(scope.tenantSlug), clean(scope.siteId))}/${encodeURIComponent(clean(assetId))}`, c.userId, parseMediaDeleted, {
    method: "DELETE", headers: idemHeaders(idempotencyKey),
  });
}
