// WSK-43c — the media library half of the stubbed WSK-59/WSK-43b BFF, plus a FAKE WebDesk public upload endpoint.
// TEST FIXTURE ONLY (nothing under `src/` imports it). Transcribed from the spec, not from the UI:
//   FRONTEND-BFF-CONTRACT §27 "The media library" and `webdesk/api/README.md` "Media library (WSK-43a)".
//
//   BFF (through `wd.mjs`'s handleWebdesk, same wall, same 503/403 states as the content routes):
//     GET    …/media?mime&q&tag&includeDeleted&cursor&limit   -> {assets, page}         newest first
//     GET    …/media/:id/usage                                 -> {assetId,url,total,items:[{itemId,collectionKey,locale,slug,in}]}
//     POST   …/media/upload-token  {bucket,…}                  -> 201 {uploadUrl,expiresAt,maxBytes,allowedMimes}
//     PATCH  …/media/:id           {title?,alt?,tags?}         -> {asset}   (replace-all; unknown key / undeclared locale = 400)
//     DELETE …/media/:id                                       -> {assetId,deletedAt,purgeAfter,alreadyDeleted} | 409 media-in-use
//   WebDesk's PUBLIC routes (served by `server.mjs` on the stub's port, i.e. a DIFFERENT origin from the ERP, like the real thing):
//     OPTIONS /v1/t/:slug/media/upload/:token                  CORS preflight (only when `cfg.uploadCors` is true)
//     POST    /v1/t/:slug/media/upload/:token?filename=        the raw file; single-use token; 201 {asset} or Nest's {statusCode,message,error}
//     GET     /v1/t/:slug/media/:id                            the bytes (for thumbnails)
//
// Scenario switches (`/__stub/config`): uploadCors (default true), publicUrlNotConfigured, mediaMaxBytes, mediaDeny
// {upload,update,delete}, scanUnavailable, ambiguousMediaWrite, mediaCaps ({upload,update,delete} booleans: overrides what the list's
// `capabilities` says), mediaCapsUnknown (true: the list carries NO `capabilities`, as when the BFF could not ask Cerbos).
// Content that contains the text EICAR is "infected".
//
// WSK-359: the list answer carries `capabilities: {read, upload, update, delete}` (BFF contract §27): by default from the caller's role
// (a viewer can do nothing but read; an editor uploads and updates; only a publisher in STAFF mode deletes, a client never does).
// `mediaDeny` is deliberately NOT folded in: it models a refusal the advisory answer did not predict (a policy changed after the list was
// read), so the 403 handling stays testable with controls that were enabled up front.

import crypto from "node:crypto";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const R = (status, json) => ({ status, json });
const problem = (status, slug, title, extra = {}) => R(status, { type: `${PROBLEM}${slug}`, title, status, instance: "/stub", requestId: "stub-req", ...extra });
const forbidden = () => R(403, { error: "forbidden" });
const nowIso = () => new Date().toISOString();
const UUID = () => crypto.randomUUID();

export const ALLOWED_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];
const VIDEO_MIMES = ["video/mp4", "video/webm"];
export const DEFAULT_MAX_BYTES = 1024 * 1024;
const LOCALES = ["en", "id"];

export function seedMedia() {
  return { media: new Map(), uploadTokens: new Map(), uploadLog: [], mediaLog: [] };
}
export const mediaCfg = () => ({ uploadCors: true, publicUrlNotConfigured: false, mediaMaxBytes: DEFAULT_MAX_BYTES, mediaDeny: {}, mediaCaps: {}, mediaCapsUnknown: false, scanUnavailable: false, ambiguousMediaWrite: null });

/** The list's `capabilities` for this caller (see the header). `client` = the portal's client mode: delete is never offered. */
export function mediaCapabilities(S, { role, client }) {
  const base = role === "viewer" ? { upload: false, update: false, delete: false } : { upload: true, update: true, delete: role === "publisher" && !client };
  const over = S.cfg.mediaCaps ?? {};
  const pick = (k) => (typeof over[k] === "boolean" ? over[k] : base[k]);
  return { read: true, upload: pick("upload"), update: pick("update"), delete: client ? false : pick("delete") };
}

/** What `/__stub/state` returns for the media library (never the bytes). */
export function mediaState(S) {
  return {
    media: [...S.media.values()].map(({ bytes, ...a }) => a),
    uploadLog: S.uploadLog,
    mediaLog: S.mediaLog,
  };
}

const publicBase = () => `http://127.0.0.1:${Number(process.env.WD_STUB_PORT ?? 3991)}`;

function wireAsset(S, a, withLifecycle = false) {
  const base = {
    assetId: a.assetId, url: `/v1/t/${a.tenantSlug}/media/${a.assetId}`, bucket: a.bucket, bucketKey: `${a.bucket}/${a.assetId}`, mime: a.mime, sizeBytes: a.sizeBytes,
    scanStatus: a.scanStatus, title: a.title, alt: a.alt, tags: a.tags, originalFilename: a.originalFilename, width: a.width, height: a.height,
    createdBy: a.createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
  return withLifecycle ? { ...base, deletedAt: a.deletedAt, purgeAfter: a.purgeAfter ?? null, purgedAt: null } : base;
}

/** Seed an asset directly (for tests that need a library without uploading). */
export function addAsset(S, o) {
  const id = o.assetId ?? UUID();
  const bytes = o.bytes ?? Buffer.from(o.mime === "application/pdf" ? "%PDF-1.4 stub" : "stub");
  S.media.set(id, {
    assetId: id, tenantSlug: "gaiada", bucket: "media", mime: o.mime ?? "image/png", sizeBytes: o.sizeBytes ?? bytes.length, scanStatus: "clean",
    title: o.title ?? null, alt: o.alt ?? {}, tags: o.tags ?? [], originalFilename: o.originalFilename ?? "file.png", width: o.width ?? null, height: o.height ?? null,
    createdBy: o.createdBy ?? "demo-hansel", createdAt: o.createdAt ?? nowIso(), updatedAt: o.createdAt ?? nowIso(), deletedAt: null, bytes,
  });
  return id;
}

// ── where an asset is used (the same substring scan WebDesk's media.usage/media.delete use) ───────
function usageOf(S, assetId) {
  const needle = `/media/${assetId}`.toLowerCase();
  const items = [];
  for (const it of S.items.values()) {
    if (it.deletedAt) continue;
    const text = (v) => (v ? `${JSON.stringify(v.blocks)}${JSON.stringify(v.seo)}`.toLowerCase() : "");
    const head = it.versions[it.versions.length - 1];
    const live = it.publishedVersion !== null ? it.versions.find((v) => v.n === it.publishedVersion) : null;
    const inLive = !!live && (it.publishState === "published" || it.publishState === "scheduled") && text(live).includes(needle);
    const inHead = text(head).includes(needle);
    if (inLive || inHead) items.push({ itemId: it.itemId, collectionKey: it.collectionKey, locale: it.locale, slug: it.slug, in: inLive ? "live" : "head" });
  }
  items.sort((a, b) => a.collectionKey.localeCompare(b.collectionKey) || a.slug.localeCompare(b.slug) || a.locale.localeCompare(b.locale));
  return { total: items.length, items: items.slice(0, 50) };
}

// ── BFF routes ────────────────────────────────────────────────────────────────────────────────────
/** `rest` is what follows `/sites/:t/:s` (starts with `/media`). Returns a `{status, json}` or null when it is not a media route. */
export function handleMediaBff(S, { method, rest, query, body, userId, role, client = false }) {
  let mm;
  const deny = (cap) => S.cfg.mediaDeny?.[cap] === true;

  if (rest === "/media" && method === "GET") {
    let rows = [...S.media.values()].filter((a) => (query.get("includeDeleted") === "true" ? true : !a.deletedAt));
    const mime = query.get("mime");
    if (mime) rows = rows.filter((a) => (mime.endsWith("/*") ? a.mime.startsWith(mime.slice(0, -1)) : a.mime === mime));
    const tag = query.get("tag");
    if (tag) rows = rows.filter((a) => a.tags.includes(tag));
    const q = (query.get("q") ?? "").toLowerCase();
    if (q) rows = rows.filter((a) => (a.title ?? "").toLowerCase().includes(q) || (a.originalFilename ?? "").toLowerCase().includes(q) || a.tags.some((t) => t.includes(q)));
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.assetId < b.assetId ? 1 : -1));
    const limit = Math.min(Math.max(Number(query.get("limit") ?? 48), 1), 100);
    const offset = Number(query.get("cursor") ?? 0);
    const slice = rows.slice(offset, offset + limit);
    const hasMore = offset + limit < rows.length;
    return R(200, {
      assets: slice.map((a) => wireAsset(S, a, true)), page: { cursor: hasMore ? String(offset + limit) : null, hasMore, limit },
      ...(S.cfg.mediaCapsUnknown ? {} : { capabilities: mediaCapabilities(S, { role, client }) }),
    });
  }

  if ((mm = rest.match(/^\/media\/([^/]+)\/usage$/)) && method === "GET") {
    const a = S.media.get(mm[1]);
    if (!a) return problem(404, "media-asset-not-found", "Media asset not found");
    const u = usageOf(S, a.assetId);
    return R(200, { assetId: a.assetId, url: `/v1/t/${a.tenantSlug}/media/${a.assetId}`, ...u });
  }

  if (rest === "/media/upload-token" && method === "POST") {
    if (deny("upload") || role === "viewer") return forbidden();
    if (S.cfg.publicUrlNotConfigured) return R(503, { error: "webdesk_not_configured", reason: "webdesk_public_url_not_configured" });
    const bucket = body?.bucket;
    if (bucket !== "media" && bucket !== "video") return problem(400, "invalid-request", "Invalid request", { detail: "bucket must be media or video" });
    const token = crypto.randomBytes(24).toString("base64url");
    const maxBytes = S.cfg.mediaMaxBytes ?? DEFAULT_MAX_BYTES;
    const allowedMimes = bucket === "video" ? VIDEO_MIMES : ALLOWED_MIMES;
    S.uploadTokens.set(token, { bucket, maxBytes, allowedMimes, createdBy: userId, used: false, expiresAt: Date.now() + 10 * 60_000 });
    S.mediaLog.push({ op: "uploadToken", bucket, by: userId });
    return R(201, { uploadUrl: `${publicBase()}/v1/t/gaiada/media/upload/${token}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), maxBytes, allowedMimes });
  }

  if ((mm = rest.match(/^\/media\/([^/]+)$/)) && method === "PATCH") {
    if (deny("update") || role === "viewer") return forbidden();
    const a = S.media.get(mm[1]);
    if (!a) return problem(404, "media-asset-not-found", "Media asset not found");
    if (a.deletedAt) return problem(409, "media-asset-deleted", "Media asset deleted", { detail: "The asset is deleted." });
    const keys = Object.keys(body ?? {});
    if (keys.length === 0 || keys.some((k) => !["title", "alt", "tags"].includes(k))) return problem(400, "invalid-request", "Invalid request", { detail: "title, alt and tags only; at least one" });
    if (body.alt !== undefined) {
      for (const [l, t] of Object.entries(body.alt)) {
        if (!LOCALES.includes(l)) return problem(400, "invalid-request", "Invalid request", { detail: `alt: '${l}' is not a locale this tenant declares` });
        if (typeof t !== "string" || t.length > 500) return problem(400, "invalid-request", "Invalid request", { detail: "alt text is at most 500 characters" });
      }
    }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 20)) return problem(400, "invalid-request", "Invalid request", { detail: "at most 20 tags" });
    const apply = () => {
      if ("title" in body) a.title = body.title === null || body.title === "" ? null : String(body.title).slice(0, 200);
      if ("alt" in body) a.alt = Object.fromEntries(Object.entries(body.alt).filter(([, t]) => t !== ""));
      if ("tags" in body) a.tags = [...new Set(body.tags.map((t) => String(t).trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean))];
      a.updatedAt = nowIso();
    };
    S.mediaLog.push({ op: "update", assetId: a.assetId, keys, by: userId });
    if (S.cfg.ambiguousMediaWrite === "drop") return R(502, { error: "webdesk_ambiguous", reason: "not_observed" });
    apply();
    if (S.cfg.ambiguousMediaWrite === "land") return R(502, { error: "webdesk_ambiguous", reason: "reconcile_failed" });
    return R(200, { asset: wireAsset(S, a, true) });
  }

  if ((mm = rest.match(/^\/media\/([^/]+)$/)) && method === "DELETE") {
    if (deny("delete") || role === "viewer") return forbidden();
    const a = S.media.get(mm[1]);
    if (!a) return problem(404, "media-asset-not-found", "Media asset not found");
    if (a.deletedAt) return R(200, { assetId: a.assetId, deletedAt: a.deletedAt, purgeAfter: a.purgeAfter, alreadyDeleted: true });
    const u = usageOf(S, a.assetId);
    if (u.total > 0) return problem(409, "media-in-use", "Media asset in use", { detail: `The asset is used by ${u.total} item(s).`, total: u.total, items: u.items });
    a.deletedAt = nowIso();
    a.purgeAfter = new Date(Date.now() + 24 * 3600_000).toISOString();
    S.mediaLog.push({ op: "delete", assetId: a.assetId, by: userId });
    return R(200, { assetId: a.assetId, deletedAt: a.deletedAt, purgeAfter: a.purgeAfter, alreadyDeleted: false });
  }
  return null;
}

// ── WebDesk's PUBLIC routes (the fake upload endpoint) ────────────────────────────────────────────
function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  return null;
}

function corsHeaders(S, origin) {
  const h = { "cache-control": "no-store", vary: "Origin" };
  if (S.cfg.uploadCors !== false && origin) h["access-control-allow-origin"] = origin;
  return h;
}

/** Returns `{status, headers?, json?, bytes?}` or null when the path is not one of WebDesk's public media routes. */
export function handlePublicMedia(S, { method, pathname, query, headers, body }) {
  const origin = headers.origin;
  let mm;
  if ((mm = pathname.match(/^\/v1\/t\/([^/]+)\/media\/upload\/([^/]+)$/))) {
    const token = mm[2];
    const h = corsHeaders(S, origin);
    const t = S.uploadTokens.get(token);
    const live = t && !t.used && t.expiresAt > Date.now();
    if (method === "OPTIONS") {
      if (!live) return { status: 404, headers: h, json: { statusCode: 404, message: "Not Found" } };
      return { status: 204, headers: { ...h, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, x-request-id", "access-control-max-age": "600" } };
    }
    if (method !== "POST") return { status: 404, headers: h, json: { statusCode: 404, message: "Not Found" } };
    const err = (status, message, error) => ({ status, headers: { ...h, connection: "close" }, json: { statusCode: status, message, error } });
    if (!live) return err(404, "Not Found", "Not Found");
    const ct = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    S.uploadLog.push({ token: "redacted", contentType: ct, filename: query.get("filename"), size: body.length, origin: origin ?? null });
    // headers-only refusals leave the token unspent
    if (!t.allowedMimes.includes(ct)) return err(415, `content-type '${ct || "(none)"}' is not allowed for this upload token`, "Unsupported Media Type");
    if (body.length > t.maxBytes) return err(413, `upload exceeds the ${t.maxBytes}-byte limit of this token`, "Payload Too Large");
    t.used = true; // claimed: spent from here on, whatever happens
    if (body.length === 0) return err(400, "empty upload", "Bad Request");
    const sniffed = sniff(body);
    if (sniffed !== ct) return err(400, `declared content-type '${ct}' does not match the file's actual signature (${sniffed ?? "unrecognized"})`, "Bad Request");
    if (S.cfg.scanUnavailable) return err(503, "malware scan unavailable - upload refused: Error: connect ECONNREFUSED", "Service Unavailable");
    if (body.includes(Buffer.from("EICAR"))) return err(403, "upload refused: malware scan matched 'Eicar-Test-Signature'", "Forbidden");
    let width = null; let height = null;
    if (ct === "image/png" && body.length >= 24) { width = body.readUInt32BE(16); height = body.readUInt32BE(20); }
    const id = addAsset(S, { mime: ct, bytes: body, originalFilename: (query.get("filename") ?? "").split(/[/\\]/).pop() || null, width, height, createdBy: t.createdBy });
    const a = S.media.get(id);
    a.bucket = t.bucket;
    const { deletedAt, ...asset } = wireAsset(S, a, false);
    return { status: 201, headers: h, json: asset };
  }
  if ((mm = pathname.match(/^\/v1\/t\/([^/]+)\/media\/([^/]+)$/)) && method === "GET") {
    const a = S.media.get(mm[2]);
    if (!a || a.deletedAt) return { status: 404, json: { statusCode: 404, message: "Not Found" } };
    return { status: 200, headers: { "content-type": a.mime, "cache-control": "public, max-age=60", "access-control-allow-origin": "*" }, bytes: a.bytes };
  }
  return null;
}
