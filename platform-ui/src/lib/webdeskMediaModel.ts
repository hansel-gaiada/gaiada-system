// WSK-43c — the media library's types, parsers and plain-words copy. PURE: no `server-only`, no `fetch`, no
// browser API, so the server reads (`webdeskMedia.ts`), the server actions (`webdeskMediaActions.ts`), the
// browser upload (`mediaUpload.ts`) and every component share ONE definition of "an asset", "an upload
// token" and "why an upload was refused".
//
//   BFF (WSK-43b; FRONTEND-BFF-CONTRACT §27 "The media library"), all under
//   `/api/:company/modules/webdev/content/sites/:tenantSlug/:siteId/`:
//     GET    media?mime&q&tag&includeDeleted&cursor&limit      -> { assets: MediaAsset[], page }
//     GET    media/:assetId/usage                              -> { assetId, url, total, items[] }
//     POST   media/upload-token                                -> 201 { uploadUrl, expiresAt, maxBytes, allowedMimes }
//     PATCH  media/:assetId  { title?, alt?, tags? }           -> { asset }      (replace-all per key)
//     DELETE media/:assetId                                    -> { assetId, deletedAt, purgeAfter, alreadyDeleted } | 409 media-in-use
//   The upload itself goes from the browser straight to `uploadUrl` (WebDesk's public host), never through
//   the ERP: `POST <uploadUrl>?filename=<name>` with the raw file and its own Content-Type
//   (`webdesk/api/README.md` "Media library (WSK-43a)"). That public route answers refusals as problem+json
//   with a stable `type` slug (`upload-*`), which `failureFromUploadResponse` reads first; an older WebDesk answered Nest's
//   plain `{statusCode, message, error}`, so status plus message stays as the fallback.
//
// Parsers throw `MediaShapeError` (path + what was expected, never the value) so a body that is not the
// spec'd shape becomes a loud "contract drift" result and is never rendered as data.
import type { Page, WdResult } from "./webdeskContentModel";

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────

export interface MediaAsset {
  assetId: string;
  /** Canonical `/v1/t/<tenantSlug>/media/<assetId>`: what a media field stores and the in-use scan looks for. */
  url: string;
  mime: string;
  sizeBytes: number;
  scanStatus: string;
  title: string | null;
  /** locale -> alt text. `{}` when none. */
  alt: Record<string, string>;
  tags: string[];
  originalFilename: string | null;
  width: number | null;
  height: number | null;
  /** The ERP user id of whoever minted the upload token (null for rows from before WebDesk recorded it). */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only the list carries these; an upload's response does not. */
  deletedAt: string | null;
}

export interface MediaListBody { assets: MediaAsset[]; page: Page }

/** Where an asset is used: `live` (a published item), `head` (an item's working draft), `scheduled` (a pending swap). */
export interface MediaUsageItem { itemId: string; collectionKey: string; locale: string; slug: string; in: string }
export interface MediaUsage { assetId: string; url: string; total: number; items: MediaUsageItem[] }

export interface MediaDeleted { assetId: string; deletedAt: string; purgeAfter: string | null; alreadyDeleted: boolean }

export interface UploadToken {
  /** The PUBLIC WebDesk URL carrying a ONE-TIME secret. Never logged, stored, put in a link or in an error message. */
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
  allowedMimes: string[];
}

/** The 409 `media-in-use` problem: the delete was refused because content still names the asset. */
export interface MediaInUse { kind: "in_use"; message: string; total: number; items: MediaUsageItem[] }
/** A write that can be refused for being in use. */
export type MediaWriteResult<T> = WdResult<T> | MediaInUse;

/** The media primitive's stored value (`webdeskContentModel` `media`): `{url, alt?, width?, height?, mime?}`. */
export interface MediaValue { url: string; alt?: string; width?: number; height?: number; mime?: string }

export interface MediaQuery { mime?: string; q?: string; tag?: string; cursor?: string; limit?: number }

// ── Parsers ──────────────────────────────────────────────────────────────────────────────────────

export class MediaShapeError extends Error {
  constructor(public path: string, public expected: string, got: unknown) {
    super(`${path || "<root>"}: expected ${expected}, got ${got === undefined ? "missing" : got === null ? "null" : Array.isArray(got) ? "array" : typeof got}`);
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, path: string): Record<string, unknown> => { if (!isRec(v)) throw new MediaShapeError(path, "object", v); return v; };
const str = (v: unknown, path: string): string => { if (typeof v !== "string") throw new MediaShapeError(path, "string", v); return v; };
const int = (v: unknown, path: string): number => { if (typeof v !== "number" || !Number.isInteger(v)) throw new MediaShapeError(path, "integer", v); return v; };
const bool = (v: unknown, path: string): boolean => { if (typeof v !== "boolean") throw new MediaShapeError(path, "boolean", v); return v; };
const need = (o: Record<string, unknown>, k: string, path: string): unknown => { if (!(k in o)) throw new MediaShapeError(`${path}.${k}`, "present", undefined); return o[k]; };
const strN = (o: Record<string, unknown>, k: string, path: string): string | null => { const v = need(o, k, path); return v === null ? null : str(v, `${path}.${k}`); };
const intN = (o: Record<string, unknown>, k: string, path: string): number | null => { const v = need(o, k, path); return v === null ? null : int(v, `${path}.${k}`); };
const optStrN = (o: Record<string, unknown>, k: string, path: string): string | null => { const v = o[k]; return v === undefined || v === null ? null : str(v, `${path}.${k}`); };

export function readMediaAsset(v: unknown, path = "asset"): MediaAsset {
  const o = obj(v, path);
  const altRaw = obj(need(o, "alt", path), `${path}.alt`);
  const alt: Record<string, string> = {};
  for (const [k, x] of Object.entries(altRaw)) alt[k] = str(x, `${path}.alt.${k}`);
  const tagsRaw = need(o, "tags", path);
  if (!Array.isArray(tagsRaw)) throw new MediaShapeError(`${path}.tags`, "array", tagsRaw);
  return {
    assetId: str(need(o, "assetId", path), `${path}.assetId`),
    url: str(need(o, "url", path), `${path}.url`),
    mime: str(need(o, "mime", path), `${path}.mime`),
    sizeBytes: int(need(o, "sizeBytes", path), `${path}.sizeBytes`),
    scanStatus: str(need(o, "scanStatus", path), `${path}.scanStatus`),
    title: strN(o, "title", path),
    alt,
    tags: tagsRaw.map((t, i) => str(t, `${path}.tags[${i}]`)),
    originalFilename: strN(o, "originalFilename", path),
    width: intN(o, "width", path),
    height: intN(o, "height", path),
    createdBy: strN(o, "createdBy", path),
    createdAt: str(need(o, "createdAt", path), `${path}.createdAt`),
    updatedAt: str(need(o, "updatedAt", path), `${path}.updatedAt`),
    deletedAt: optStrN(o, "deletedAt", path),
  };
}

function readPage(v: unknown, path: string): Page {
  const o = obj(v, path);
  const cursor = need(o, "cursor", path);
  return { cursor: cursor === null ? null : str(cursor, `${path}.cursor`), hasMore: bool(need(o, "hasMore", path), `${path}.hasMore`), limit: int(need(o, "limit", path), `${path}.limit`) };
}

export function parseMediaList(v: unknown): MediaListBody {
  const o = obj(v, "media");
  const assets = need(o, "assets", "media");
  if (!Array.isArray(assets)) throw new MediaShapeError("media.assets", "array", assets);
  return { assets: assets.map((a, i) => readMediaAsset(a, `media.assets[${i}]`)), page: readPage(need(o, "page", "media"), "media.page") };
}

export function readUsageItems(v: unknown, path: string): MediaUsageItem[] {
  if (!Array.isArray(v)) throw new MediaShapeError(path, "array", v);
  return v.map((x, i) => {
    const o = obj(x, `${path}[${i}]`);
    return {
      itemId: str(need(o, "itemId", `${path}[${i}]`), `${path}[${i}].itemId`),
      collectionKey: str(need(o, "collectionKey", `${path}[${i}]`), `${path}[${i}].collectionKey`),
      locale: str(need(o, "locale", `${path}[${i}]`), `${path}[${i}].locale`),
      slug: str(need(o, "slug", `${path}[${i}]`), `${path}[${i}].slug`),
      in: str(need(o, "in", `${path}[${i}]`), `${path}[${i}].in`),
    };
  });
}

export function parseMediaUsage(v: unknown): MediaUsage {
  const o = obj(v, "usage");
  return {
    assetId: str(need(o, "assetId", "usage"), "usage.assetId"),
    url: str(need(o, "url", "usage"), "usage.url"),
    total: int(need(o, "total", "usage"), "usage.total"),
    items: readUsageItems(need(o, "items", "usage"), "usage.items"),
  };
}

export function parseMediaUpdated(v: unknown): { asset: MediaAsset } {
  const o = obj(v, "update");
  return { asset: readMediaAsset(need(o, "asset", "update"), "update.asset") };
}

export function parseMediaDeleted(v: unknown): MediaDeleted {
  const o = obj(v, "delete");
  const purge = o.purgeAfter;
  return {
    assetId: str(need(o, "assetId", "delete"), "delete.assetId"),
    deletedAt: str(need(o, "deletedAt", "delete"), "delete.deletedAt"),
    purgeAfter: purge === undefined || purge === null ? null : str(purge, "delete.purgeAfter"),
    alreadyDeleted: bool(need(o, "alreadyDeleted", "delete"), "delete.alreadyDeleted"),
  };
}

/** The upload URL must be a plain https (or loopback http, for local dev) URL: anything else is drift, never
 *  something to hand to `XMLHttpRequest`. The message names the path only, never the URL (it carries a secret). */
export function isUsableUploadUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function parseUploadToken(v: unknown): UploadToken {
  const o = obj(v, "upload-token");
  const uploadUrl = str(need(o, "uploadUrl", "upload-token"), "upload-token.uploadUrl");
  if (!isUsableUploadUrl(uploadUrl)) throw new MediaShapeError("upload-token.uploadUrl", "an https URL", "a different value");
  const mimes = need(o, "allowedMimes", "upload-token");
  if (!Array.isArray(mimes)) throw new MediaShapeError("upload-token.allowedMimes", "array", mimes);
  return {
    uploadUrl,
    expiresAt: str(need(o, "expiresAt", "upload-token"), "upload-token.expiresAt"),
    maxBytes: int(need(o, "maxBytes", "upload-token"), "upload-token.maxBytes"),
    allowedMimes: mimes.map((m, i) => str(m, `upload-token.allowedMimes[${i}]`)),
  };
}

/** The public upload route answers 201 with the asset itself (not wrapped). */
export function parseUploadedAsset(v: unknown): MediaAsset {
  return readMediaAsset(v, "upload");
}

// ── Small pure helpers ───────────────────────────────────────────────────────────────────────────

export const assetLabel = (a: MediaAsset): string => a.title || a.originalFilename || `Asset ${a.assetId.slice(0, 8)}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export const isImage = (mime: string): boolean => mime.startsWith("image/");

export function mimeLabel(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  const [type, sub] = mime.split("/");
  if (type === "image") return `${(sub ?? "").toUpperCase()} image`;
  if (type === "video") return `${(sub ?? "").toUpperCase()} video`;
  return mime;
}

export const dimensionsLabel = (a: { width: number | null; height: number | null }): string | null =>
  a.width !== null && a.height !== null ? `${a.width} × ${a.height}` : null;

/** The tag grammar the server applies (`media.update`): trimmed, whitespace collapsed, lower-cased, de-duplicated. */
export function normalizeTags(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(",");
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim().replace(/\s+/g, " ").toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export const altFor = (a: Pick<MediaAsset, "alt">, locale: string): string => a.alt[locale] ?? "";

/** The value a media field stores for a picked asset: exactly `{url, alt?, width?, height?, mime?}`, each optional member
 *  present only when the asset has it. `alt` is the asset's text for THIS locale and nothing else (a wrong-language alt is
 *  worse than none, so there is no fallback to another locale). */
export function mediaValueFor(asset: MediaAsset, locale: string): MediaValue {
  const v: MediaValue = { url: asset.url };
  const alt = altFor(asset, locale).trim();
  if (alt) v.alt = alt;
  if (asset.width !== null) v.width = asset.width;
  if (asset.height !== null) v.height = asset.height;
  if (asset.mime) v.mime = asset.mime;
  return v;
}

export function usageLabel(where: string): string {
  switch (where) {
    case "live": return "Live";
    case "head": return "Draft";
    case "scheduled": return "Scheduled swap";
    default: return where;
  }
}

/** Filter choices. `image/*` is a type prefix WebDesk understands; the others are exact types. */
export const MEDIA_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All types" },
  { value: "image/*", label: "Images" },
  { value: "application/pdf", label: "PDFs" },
  { value: "video/*", label: "Videos" },
];

/** A thumbnail URL needs the host WebDesk serves media from; the asset's own `url` is only a path. `null` when the
 *  base is unknown (the grid then shows a type tile instead of a broken image). */
export function previewUrl(base: string | null, asset: Pick<MediaAsset, "url" | "mime">): string | null {
  if (!base || !isImage(asset.mime) || !asset.url.startsWith("/")) return null;
  return `${base.replace(/\/+$/, "")}${asset.url}`;
}

/** The origin of a minted upload URL, used as the preview base when the ERP was not told one. Origin ONLY: the path
 *  and token never leave the upload call. */
export function originOf(uploadUrl: string): string | null {
  try { return new URL(uploadUrl).origin; } catch { return null; }
}

export const bucketFor = (mime: string): "media" | "video" => (mime.startsWith("video/") ? "video" : "media");

// ── Upload: what can go wrong, in plain words ────────────────────────────────────────────────────

export type UploadFailureKind =
  | "forbidden" | "not_enabled" | "unavailable" | "drift" | "token_expired" | "too_large" | "type_not_allowed" | "type_mismatch"
  | "empty" | "infected" | "quota" | "scan_unavailable" | "busy" | "timeout" | "offline" | "failed";

export interface UploadFailure {
  kind: UploadFailureKind;
  /** One sentence, shown on the file's row. */
  title: string;
  /** What to do or why, or null. */
  detail: string | null;
}

const ASK = "Ask a Web Dev editor or a company admin for access.";

/** Which failures the library should remember as "you can't do this" (and so disable the control). */
export const isUploadDenial = (f: UploadFailure): boolean => f.kind === "forbidden";

/** The mint (`POST …/media/upload-token`) refused or failed. */
export function failureFromMint(r: Exclude<WdResult<UploadToken>, { kind: "ok" }>): UploadFailure {
  switch (r.kind) {
    case "forbidden":
      return { kind: "forbidden", title: "You can't upload to this library.", detail: ASK };
    case "unavailable":
      if (r.reason === "webdesk_public_url_not_configured" || r.reason === "webdesk_public_url_invalid") {
        return { kind: "not_enabled", title: "Uploads aren't enabled for this site yet.", detail: "The ERP has not been told where WebDesk accepts uploads. An operator needs to set WEBDESK_PUBLIC_BASE_URL on the platform. Nothing was uploaded." };
      }
      if (r.code === "contract_drift") return { kind: "drift", title: "WebDesk answered with something unexpected.", detail: `Nothing was uploaded. (${r.reason})` };
      return { kind: "unavailable", title: "WebDesk can't be reached right now.", detail: "Nothing was uploaded. Try again in a moment." };
    case "not_enabled":
      return { kind: "not_enabled", title: "Uploads aren't enabled for this site yet.", detail: r.reason === "module_disabled" ? "The Web Dev module is switched off for this company." : "This deployment doesn't serve the media library yet." };
    case "not_found":
      return { kind: "failed", title: "This site isn't one of your company's.", detail: null };
    case "conflict":
    case "invalid":
      return { kind: "failed", title: "WebDesk refused to start the upload.", detail: r.message };
  }
}

/** The file is checked against the token's limits BEFORE any bytes are sent (the token is then simply left to expire). */
export function checkFileAgainstToken(file: { name: string; type: string; size: number }, token: Pick<UploadToken, "maxBytes" | "allowedMimes">): UploadFailure | null {
  if (file.size === 0) return { kind: "empty", title: "That file is empty.", detail: "Nothing was uploaded." };
  if (!token.allowedMimes.includes(file.type)) {
    const allowed = token.allowedMimes.map(mimeLabel).join(", ");
    return { kind: "type_not_allowed", title: "That file type isn't allowed.", detail: `${file.type ? mimeLabel(file.type) : "This file's type is unknown"}. The library accepts: ${allowed}.` };
  }
  if (file.size > token.maxBytes) {
    return { kind: "too_large", title: `That file is too large (${formatBytes(file.size)}).`, detail: `The limit is ${formatBytes(token.maxBytes)}.` };
  }
  return null;
}

/** The failures the public upload route can name, in plain words. One definition for the slug path and the status path. */
const upload = {
  tokenExpired: (): UploadFailure => ({ kind: "token_expired", title: "The upload link expired or was already used.", detail: "Nothing was added. Retrying asks for a fresh one." }),
  tooLarge: (ctx: { maxBytes?: number }, fallbackDetail: string | null): UploadFailure => ({ kind: "too_large", title: "That file is too large.", detail: ctx.maxBytes ? `The limit is ${formatBytes(ctx.maxBytes)}.` : fallbackDetail }),
  typeNotAllowed: (): UploadFailure => ({ kind: "type_not_allowed", title: "That file type isn't allowed.", detail: "WebDesk doesn't accept this kind of file in the library." }),
  typeMismatch: (): UploadFailure => ({ kind: "type_mismatch", title: "The file's contents don't match its type.", detail: "For example, a file named .png that is not really a PNG. It was not added." }),
  empty: (): UploadFailure => ({ kind: "empty", title: "That file is empty.", detail: "Nothing was uploaded." }),
  infected: (): UploadFailure => ({ kind: "infected", title: "WebDesk's virus scan refused this file.", detail: "It was not added to the library." }),
  quota: (): UploadFailure => ({ kind: "quota", title: "This site's media storage is full.", detail: "Delete assets you no longer use, or ask an operator to raise the quota." }),
  scanUnavailable: (): UploadFailure => ({ kind: "scan_unavailable", title: "WebDesk couldn't scan this file right now, so it wasn't accepted.", detail: "Try again in a few minutes." }),
  busy: (): UploadFailure => ({ kind: "busy", title: "WebDesk is busy with other uploads.", detail: "Try again in a few seconds." }),
  timeout: (): UploadFailure => ({ kind: "timeout", title: "The upload took too long and was stopped.", detail: "Retrying asks for a fresh upload link." }),
  interrupted: (): UploadFailure => ({ kind: "failed", title: "The upload was interrupted.", detail: "Retrying asks for a fresh upload link." }),
};

/**
 * The stable `type` slug of a problem+json body: the last path segment of `https://webdesk.gaiada.online/errors/<slug>`.
 * null for any other body (an older WebDesk answered `{statusCode, message, error}`) and for a `type` that is not a plain slug.
 */
export function problemSlugOf(body: unknown): string | null {
  if (!isRec(body) || typeof body.type !== "string") return null;
  const slug = body.type.slice(body.type.lastIndexOf("/") + 1);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

/** The upload route's slugs (webdesk/api/README.md "Media library (WSK-43a)") -> the failure to show; null for any other slug. */
function failureFromUploadSlug(slug: string | null, ctx: { maxBytes?: number }): UploadFailure | null {
  switch (slug) {
    case "upload-not-found": return upload.tokenExpired();
    case "upload-busy": return upload.busy();
    case "upload-type-not-allowed": return upload.typeNotAllowed();
    case "upload-type-mismatch": return upload.typeMismatch();
    case "upload-too-large": return upload.tooLarge(ctx, null);
    case "upload-empty": return upload.empty();
    case "upload-quota-exceeded": return upload.quota();
    case "upload-infected": return upload.infected();
    case "upload-scan-unavailable": return upload.scanUnavailable();
    case "upload-timeout": return upload.timeout();
    case "upload-interrupted": return upload.interrupted();
    default: return null;
  }
}

/**
 * The public upload route's refusal -> plain words. `status` 0 means the browser never got an answer.
 * A current WebDesk answers problem+json with a stable `type` slug, which is read first; an older one answered Nest's
 * `{statusCode, message, error}`, so the status-plus-message mapping stays as the fallback (and serves a slug this
 * function does not know, such as `invalid-request` or `internal-error`).
 */
export function failureFromUploadResponse(status: number, body: unknown, ctx: { maxBytes?: number; online?: boolean } = {}): UploadFailure {
  if (status !== 0) {
    const bySlug = failureFromUploadSlug(problemSlugOf(body), ctx);
    if (bySlug) return bySlug;
  }
  // `detail` is the problem body's prose, `message` the old body's.
  const message = isRec(body) ? (typeof body.detail === "string" ? body.detail : typeof body.message === "string" ? body.message : "") : "";
  const m = message.toLowerCase();
  if (status === 0) {
    if (ctx.online === false) return { kind: "offline", title: "You're offline.", detail: "Nothing was uploaded. Reconnect and try again." };
    return {
      kind: "not_enabled",
      title: "Uploads aren't enabled for this site yet.",
      detail: "The browser couldn't reach WebDesk's upload service. Usually this means this ERP's address isn't on WebDesk's upload allow-list (an operator sets WEBDESK_UPLOAD_CORS_ORIGINS); it can also be a dropped connection. Nothing was uploaded.",
    };
  }
  if (status === 404) return upload.tokenExpired();
  if (status === 413) return upload.tooLarge(ctx, "It is over this upload's size limit.");
  if (status === 415) return upload.typeNotAllowed();
  if (status === 408) return upload.timeout();
  if (status === 403) {
    if (m.includes("malware") || m.includes("virus")) return upload.infected();
    if (m.includes("quota")) return upload.quota();
    return { kind: "failed", title: "WebDesk refused this file.", detail: message || null };
  }
  if (status === 503) {
    if (m.includes("scan")) return upload.scanUnavailable();
    return upload.busy();
  }
  if (status === 400) {
    if (m.includes("empty")) return upload.empty();
    if (m.includes("signature") || m.includes("does not match")) return upload.typeMismatch();
    if (m.includes("not allowed")) return upload.typeNotAllowed();
    if (m.includes("exceeds") || m.includes("limit")) return upload.tooLarge(ctx, null);
    if (m.includes("interrupted")) return upload.interrupted();
    return { kind: "failed", title: "WebDesk didn't accept this file.", detail: message || null };
  }
  return { kind: "failed", title: `The upload failed (HTTP ${status}).`, detail: "Retrying asks for a fresh upload link." };
}
