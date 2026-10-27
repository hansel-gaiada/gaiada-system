// WSK-43b — the ERP's media-library BFF for WebDesk (m3 plan "WSK-43 · The media library"; owner rulings WSK-D53
// and WSK-D54, docs/blueprints/webdesk-design-v2.md §14). The Zone A half of the Media tab (WSK-43c) and of the MCP
// `webdesk.media.*` tools: every library read and write goes through THIS class, so a capability behaves
// identically under a human, under n8n and under an agent.
//
// It is WSK-59's content service shape, reused, not reinvented: the egress seam, the cross-company wall, the
// typed error mapping and the editorial-assertion + two-row-activity wrapper all live in `webdesk-content.service.ts`
// (`WebdeskZoneB`). What is new here is only the five media commands and what is done with their answers.
//
//   media.list         GET    …/media                       read
//   media.usage        GET    …/media/:assetId/usage        read
//   media.uploadToken  POST   …/media/upload-token          MEDIUM, editorial assertion, Idempotency-Key
//   media.update       PATCH  …/media/:assetId              MEDIUM, editorial assertion, Idempotency-Key
//   media.delete       DELETE …/media/:assetId              MEDIUM, editorial assertion, Idempotency-Key
//   media.list (queue) GET    …/media/quarantine           read (M5-W1q: the review queue, with a per-asset `allowed.review`)
//   media.review       POST   …/media/:assetId/review      MEDIUM, editorial assertion, Idempotency-Key (M5-W1q)
//   media.reviewPreview GET   …/media/:assetId/review-preview read, BYTES (M5-W1q2: the reviewer sees a raster image before deciding)
//
// ── THE CONTRIBUTOR UPLOAD QUARANTINE (M5-W1q, owner ruling WSK-D84) ─────────────────────────────
// A freelance writer (`users.kind = contributor`) may mint an upload token (Cerbos `webdesk_media_asset:upload`, an ALLOW only for
// that kind), and the token WebDesk mints for a contributor's signed assertion (`xc`) QUARANTINES what it uploads: the asset is
// not served by any route until a staff editor accepts it. The review desk is the two routes above. `review` is a Cerbos action
// with a structural DENY on the uploader (nobody reviews their own upload), so its resource MUST carry the asset's REAL uploader
// (`creatorId`), read from WebDesk's own row, never from the request: `review()` loads the asset (media.list, filtered by id) before
// it asks Cerbos, and an unknown uploader is a denial. The queue answers `allowed.review` per asset from the same question.
//
// Every method takes a `ContentGate`, which only `authorizeContent()` (Cerbos, as the CALLER, kind
// `webdesk_media_asset`, module `webdev`) can produce; the controller's first statement is that call, so
// authorization precedes ANY body validation (the "validation pre-empts authz" trap). No attribute is taken
// from Zone B for the decision: the policy reads only the tenant and the module.
//
// ── THE REVIEWER'S BYTE PREVIEW (M5-W1q2, owner ruling WSK-D84, approved 2026-10-27) ────────────────
// A staff editor decides on an upload they can now SEE. `reviewPreview()` asks the same questions as `review()`, in the same order
// (the caller may review someone's upload at all; the asset's REAL uploader from WebDesk's own row; `review` again with it), so the
// uploader previewing their own upload, an unknown uploader, a contributor, a writer, a client editor and a bot are all 403 and the
// 403 comes BEFORE any byte is fetched. Only then does it ask WebDesk's `media.reviewPreview` (raw bytes over the same control
// channel: `WebdeskZoneB.readBytes`) and check the bytes ITSELF: the content type must be one of five raster types, the file
// signature must match it, the size must be within 10 MiB (webdesk-media-preview.ts). A mismatch is 415 and the bytes are dropped.
// The browser gets exactly six headers (CSP `sandbox; default-src 'none'`, nosniff, inline, no-store, CORP same-origin), never one
// copied from WebDesk. SVG, HTML, PDF and video are never served: WebDesk answers 415 for them and the page shows the name only.
// A read: no ledger row, no activity (like `media.list`). `@ContributorRoute()` is NOT on the route, and there is no MCP tool.
//
// ── THE UPLOAD TOKEN IS A ONE-TIME SECRET ─────────────────────────────────────────────────────────
// `media.uploadToken` answers `{token, uploadPath, …}` once; Zone B stores only sha256(token). The browser then
// uploads straight to WebDesk (`<public base>/v1/t/<slug>/media/upload/<token>`), so the bytes never pass through the
// ERP. This class turns the answer into `{uploadUrl, expiresAt, maxBytes, allowedMimes}` and drops everything else
// (`token`, `tokenId`, `bucket`). The token is therefore never:
//   * logged: nothing here logs a response body, and the shape-failure error names a reason, never the answer;
//   * ledgered: `WebdeskZoneB.write` records identifiers and the typed outcome only; this method's ledger fields
//     are tenantSlug, siteId, bucket and the requested size cap;
//   * stored: no ERP table is written with it (and the tool is deliberately NOT a D14 executable, because a
//     D14 re-drive would store the tool's result text in `automation_approvals.execution_result`).
// Zone B makes the mint's idempotency record withhold the token too, so a REPLAY of a mint is a 409
// `idempotency-response-withheld` (mint again under a new key); this BFF never retries a write and never resends.
//
// ── `media-in-use` (WSK-D54) ─────────────────────────────────────────────────────────────────────
// A delete of an asset any live or draft item still uses is Zone B's 409 `media-in-use` problem, whose body lists
// the items (`items: [{itemId, collectionKey, locale, slug, in}]`). `WebdeskZoneB.settle` passes every 4xx problem
// through byte-for-byte, so the UI can show where the asset is used; nothing here rewrites it.
//
// ── AMBIGUOUS WRITES ─────────────────────────────────────────────────────────────────────────────
// Like every editorial write, a media write whose link died after it was fully sent is a 502 `webdesk_ambiguous`
// (never success, never a plain failure). No reconcile is attempted, because none is needed: a retry with the SAME
// Idempotency-Key is safe for update and delete (Zone B replays by key, and deleting a deleted asset is a no-op that
// answers with the original instants), and an unspent upload token simply expires (ten minutes).
import { BadGatewayException, Logger } from "@nestjs/common";
import { config } from "../../config";
import { authorize } from "../../core/http";
import { checkActions, checkMany } from "../../rbac/cerbos";
import {
  PREVIEW_MAX_BYTES,
  isPreviewRasterMime,
  mediaTypeOf,
  rasterSignatureMatches,
  type PreviewRasterMime,
} from "./webdesk-media-preview";
import {
  UUID_RE,
  WebdeskProblem,
  invalidRequest,
  isPlainObject,
  notConfigured,
  strictBody,
  strictQuery,
  webdeskZoneB,
  type ContentGate,
  type SiteRef,
  type WebdeskZoneB,
  type ZoneBResult,
} from "./webdesk-content.service";

const MEDIA_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/media";
const LIST_QUERY = ["mime", "q", "tag", "includeDeleted", "cursor", "limit"] as const;
const MINT_KEYS = ["bucket", "maxBytes", "mime"] as const;
const UPDATE_KEYS = ["title", "alt", "tags"] as const;
const QUEUE_QUERY = ["cursor", "limit"] as const;
const REVIEW_KEYS = ["decision"] as const;
/**
 * The uploader the queue's gate probes `review` with: "somebody other than the caller". The queue lists other people's uploads,
 * so the question is "may this caller review an upload that is not their own", and the policy's self-review and unknown-uploader
 * DENYs need a real, different id to answer it. Not a user id (users are uuids); it is never sent anywhere or stored.
 */
const OTHER_UPLOADER = "queue-probe:another-uploader";
/** Exactly what Zone B's `mintUploadToken()` produces: 32 random bytes as unpadded base64url. */
const UPLOAD_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** What the caller may do with this site's media library (WSK-359): the four `webdesk_media_asset` actions, as booleans. */
export interface MediaCapabilities {
  read: boolean;
  upload: boolean;
  update: boolean;
  delete: boolean;
}
const MEDIA_ACTIONS = ["read", "upload", "update", "delete"] as const;
const logger = new Logger("WebdeskMedia");

/**
 * The caller's media capabilities from ONE Cerbos `checkResources` request (one resource, the four actions), asked with
 * EXACTLY the resource the real handlers ask with: `{kind: webdesk_media_asset, tenantId, module: "webdev"}` plus the client
 * (`clientId`) on a client gate (`ContentGate.clientAttr`). The attribute set is `resourcePayload()`'s own defaults for those
 * fields (rbac/cerbos.ts keeps that function private); `webdesk-media.test.ts` pins this answer to the per-action `authorize()`
 * outcomes for every tier, so a drift between the two fails there.
 *
 * ADVISORY: the UI disables controls with it, and the per-action check (and WebDesk) stays the authority on every call. In
 * client mode `delete` is false whatever Cerbos says (WSK-49c: a client never deletes media). A Cerbos failure is `null`
 * (unknown, never "denied"): the UI then leaves the controls enabled and the 403 handling is the fallback.
 */
export async function mediaCapabilities(gate: ContentGate, siteId?: string): Promise<MediaCapabilities | null> {
  try {
    // Through rbac/cerbos.ts (the approved egress and the one resource-attribute allow-list), with exactly the resource
    // the real handlers authorize: kind, tenant, module, and the client on a client gate.
    const got = await checkActions(
      gate.principal,
      { kind: "webdesk_media_asset", tenantId: gate.tenantId, module: "webdev", ...(siteId !== undefined ? { siteId } : {}), ...(gate.client ? { clientId: gate.client.clientId } : {}) },
      MEDIA_ACTIONS,
    );
    return { read: got.read === true, upload: got.upload === true, update: got.update === true, delete: gate.client ? false : got.delete === true };
  } catch (err) {
    logger.warn(`media capabilities unavailable: ${(err as Error).message}`);
    return null;
  }
}

/** One answer for every way an asset is "not yours" or does not exist, in Zone B's own problem type. */
function mediaAssetNotFound(): WebdeskProblem {
  return new WebdeskProblem(404, {
    type: "https://webdesk.gaiada.online/errors/media-asset-not-found",
    title: "Media asset not found",
    status: 404,
    detail: "No such media asset on this site.",
  });
}

/** 415, in Zone B's own problem type: the bytes are not a preview the ERP will send. Carries the declared type only. */
function previewUnsupported(mime: string | null): WebdeskProblem {
  return new WebdeskProblem(415, {
    type: "https://webdesk.gaiada.online/errors/media-preview-unsupported",
    title: "No preview for this type",
    status: 415,
    detail: "Only raster images (png, jpeg, gif, webp, avif) are previewed.",
    ...(mime !== null ? { mime } : {}),
  });
}

/** 413: more bytes than the preview cap. */
function previewTooLarge(): WebdeskProblem {
  return new WebdeskProblem(413, {
    type: "https://webdesk.gaiada.online/errors/media-preview-too-large",
    title: "Too large to preview",
    status: 413,
    detail: `Only images up to ${PREVIEW_MAX_BYTES} bytes are previewed.`,
  });
}

/** What `reviewPreview` returns: the checked bytes and the one type they were checked against. */
export interface MediaPreview {
  mime: PreviewRasterMime;
  bytes: Buffer;
}

/**
 * The PUBLIC origin of the WebDesk api, from `WEBDESK_PUBLIC_BASE_URL` (see config.ts), without a trailing slash.
 * Unset or unusable is a typed 503 raised BEFORE a token is minted, so a deployment that cannot hand a browser an
 * upload URL never creates a token nobody can use.
 */
export function webdeskPublicBase(): string {
  const raw = config.webdeskPublic.baseUrl.trim();
  if (raw === "") throw notConfigured("webdesk_public_url_not_configured");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw notConfigured("webdesk_public_url_invalid");
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw notConfigured("webdesk_public_url_invalid");
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") throw notConfigured("webdesk_public_url_invalid");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export class WebdeskMediaService {
  constructor(private readonly zoneB: WebdeskZoneB = webdeskZoneB) {}

  /**
   * M5-W1c PHASE 2 for a media route: the real `webdesk_media_asset` action with the wall's own site id (never a body's or
   * a query's). Media carries no per-asset attribute any rule reads, so the site is the whole of it; a writers' room grant
   * reads (only) the media of the sites it covers (resource_webdesk_media_asset.yaml, `webdesk_editorial_site`).
   */
  private async authorizeMedia(gate: ContentGate, siteId: string, action: "read" | "upload" | "update" | "delete"): Promise<void> {
    await authorize(
      gate.principal,
      { kind: "webdesk_media_asset", tenantId: gate.tenantId, module: "webdev", siteId, ...(gate.client ? { clientId: gate.client.clientId } : {}) },
      action,
    );
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  /**
   * `GET …/media[?mime&q&tag&includeDeleted&cursor&limit]`: Zone B's `media.list`, allow-listed query only, plus
   * `capabilities: {read, upload, update, delete}` (WSK-359, `mediaCapabilities`) so the UI disables a control the caller cannot
   * use up front. `capabilities` is absent when Cerbos could not answer the batch (unknown, never "denied").
   */
  async list(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    await this.authorizeMedia(gate, editable.site.siteId, "read"); // PHASE 2, before the query is validated
    const query = strictQuery(rawQuery, LIST_QUERY);
    const [res, capabilities] = await Promise.all([
      this.zoneB.read({
        command: "media.list",
        path: MEDIA_PATH,
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
        query,
      }),
      mediaCapabilities(gate, editable.site.siteId),
    ]);
    return capabilities && isPlainObject(res.body) ? { status: res.status, body: { ...res.body, capabilities } } : res;
  }

  /** `GET …/media/:assetId/usage`: which items use the asset (at most 50), so the UI can say where before a delete. */
  async usage(gate: ContentGate, site: SiteRef, assetId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    await this.authorizeMedia(gate, editable.site.siteId, "read"); // PHASE 2
    strictQuery(rawQuery, []);
    if (!UUID_RE.test(assetId)) throw mediaAssetNotFound();
    return this.zoneB.read({
      command: "media.usage",
      path: `${MEDIA_PATH}/:assetId/usage`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId },
    });
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST …/media/upload-token` body `{bucket, maxBytes?, mime?}` → 201 `{uploadUrl, expiresAt, maxBytes, allowedMimes}`.
   * `uploadUrl` is the PUBLIC WebDesk URL; the browser POSTs the file to it. Zone B validates the bucket, the cap
   * and the types (a typed 400 passes through).
   */
  async mintUploadToken(gate: ContentGate, site: SiteRef, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "upload");
    const editable = await gate.resolveSite(this.zoneB, site);
    await this.authorizeMedia(gate, editable.site.siteId, "upload"); // PHASE 2, before the body is validated
    const b = strictBody(rawBody, MINT_KEYS);
    if (typeof b.bucket !== "string" || b.bucket === "") throw invalidRequest("bucket is a required string");
    // Before anything is minted: a deployment that cannot say where the browser should upload mints nothing.
    const publicBase = webdeskPublicBase();

    const res = await this.zoneB.write(gate.principal, gate.tenantId, {
      command: "media.uploadToken",
      verb: "webdesk.media.uploadToken",
      method: "POST",
      path: `${MEDIA_PATH}/upload-token`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      body: b,
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      ...gate.egressClient(),
      entity: { type: "webdesk_media_asset", id: null },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, bucket: b.bucket, maxBytes: typeof b.maxBytes === "number" ? b.maxBytes : null },
    });

    // Narrow the answer to what the browser needs. NEVER put the answer (it carries the token) into an error.
    const r = res.body;
    const prefix = `/v1/t/${site.tenantSlug}/media/upload/`;
    const uploadPath = isPlainObject(r) ? r.uploadPath : undefined;
    if (
      !isPlainObject(r) ||
      typeof uploadPath !== "string" ||
      !uploadPath.startsWith(prefix) ||
      !UPLOAD_TOKEN_RE.test(uploadPath.slice(prefix.length)) ||
      typeof r.expiresAt !== "string" ||
      typeof r.maxBytes !== "number" ||
      !Number.isSafeInteger(r.maxBytes) ||
      !Array.isArray(r.allowedMimes) ||
      !r.allowedMimes.every((m) => typeof m === "string")
    ) {
      throw new BadGatewayException({ message: "webdesk_error", reason: "upload_token_shape" });
    }
    return {
      status: res.status,
      body: { uploadUrl: `${publicBase}${uploadPath}`, expiresAt: r.expiresAt, maxBytes: r.maxBytes, allowedMimes: r.allowedMimes },
    };
  }

  // ── the review desk (M5-W1q) ─────────────────────────────────────────────────────────────────

  /** The Cerbos resource of a `review` question: the site from the wall, and the uploader from WebDesk's own row. */
  private reviewResource(gate: ContentGate, siteId: string, uploader: string | null) {
    return { kind: "webdesk_media_asset" as const, tenantId: gate.tenantId, module: "webdev", siteId, creatorId: uploader ?? "" };
  }

  /**
   * `GET …/media/quarantine[?cursor&limit]` → `{assets: [... + allowed: {review}], page}`: the contributor uploads waiting for a staff
   * decision on this site, newest first. The gate is `webdesk_media_asset:read` (phase 1); this method then asks the question the
   * list stands for, `review` on an upload that is not the caller's, and a caller who may not (a contributor, a writer, a client, a
   * bot) is a 403 BEFORE anything is read, so nobody learns that an upload exists or who made it. `reviewState` is forced here,
   * never taken from the query. Each asset carries `allowed.review` (one `checkMany`, in chunks of 50): the UI shows Accept and
   * Reject from it. `null` means Cerbos could not answer (unknown, never "denied"); the 403 on the action is then the fallback.
   */
  async quarantine(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    await authorize(gate.principal, this.reviewResource(gate, editable.site.siteId, OTHER_UPLOADER), "review"); // PHASE 2
    const query = strictQuery(rawQuery, QUEUE_QUERY);
    const res = await this.zoneB.read({
      command: "media.list",
      path: MEDIA_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      query: { ...query, reviewState: "quarantined" },
    });
    if (!isPlainObject(res.body) || !Array.isArray(res.body.assets)) return res;
    const assets = res.body.assets.filter(isPlainObject);
    let flags: boolean[] | null = null;
    try {
      flags = await checkMany(
        gate.principal,
        assets.map((a) => this.reviewResource(gate, editable.site.siteId, typeof a.createdBy === "string" ? a.createdBy : null)),
        "review",
      );
    } catch (err) {
      logger.warn(`media review capabilities unavailable: ${(err as Error).message}`);
    }
    return { status: res.status, body: { ...res.body, assets: assets.map((a, i) => ({ ...a, allowed: { review: flags ? flags[i] === true : null } })) } };
  }

  /**
   * `POST …/media/:assetId/review` body `{decision: "accept" | "reject"}` → 200 `{asset, decision, alreadyDecided}`. Zone B's problems pass
   * through untouched (409 `media-not-quarantined`, 409 `media-asset-deleted`, 403 `media-self-review`, 404 `media-asset-not-found`).
   * Order: (1) the caller may review SOMEONE's upload at all (403 before anything is validated or read); (2) the body and the id are
   * validated; (3) the asset's real uploader is read from WebDesk and Cerbos decides on it (the uploader is refused here, and again by
   * WebDesk); (4) the signed command is sent. No asset in the quarantine is one 404.
   */
  async review(gate: ContentGate, site: SiteRef, assetId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    await authorize(gate.principal, this.reviewResource(gate, siteId, OTHER_UPLOADER), "review"); // (1) PHASE 2, before the body is validated
    const b = strictBody(rawBody, REVIEW_KEYS);
    if (b.decision !== "accept" && b.decision !== "reject") throw invalidRequest('decision must be "accept" or "reject"');
    if (!UUID_RE.test(assetId)) throw mediaAssetNotFound();
    // (3) the REAL uploader, from WebDesk's own row (never the request), then the decision with it.
    const found = await this.zoneB.read({
      command: "media.list",
      path: MEDIA_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      query: { assetId, reviewState: "all", includeDeleted: "true", limit: "1" },
    });
    const row = isPlainObject(found.body) && Array.isArray(found.body.assets) ? found.body.assets.find(isPlainObject) : undefined;
    if (!row || row.assetId !== assetId.toLowerCase()) throw mediaAssetNotFound();
    await authorize(gate.principal, this.reviewResource(gate, siteId, typeof row.createdBy === "string" ? row.createdBy : null), "review");
    return this.zoneB.write(gate.principal, gate.tenantId, {
      command: "media.review",
      verb: "webdesk.media.review",
      method: "POST",
      path: `${MEDIA_PATH}/:assetId/review`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId },
      body: b,
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      ...gate.egressClient(),
      entity: { type: "webdesk_media_asset", id: assetId },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId, decision: b.decision },
    });
  }

  /**
   * `GET …/media/:assetId/review-preview` → the bytes of ONE quarantined raster upload, checked. Authorization is `review()`'s, in its
   * order: (1) the caller may review SOMEONE's upload (OTHER_UPLOADER, before anything is validated or read); (2) the id is a uuid
   * (404 otherwise); (3) the asset's REAL uploader is read from WebDesk's own row, filtered to the quarantine (any other state, site
   * or tenant is the one 404); (4) `review` again with that uploader (the uploader themself and an unknown uploader are refused);
   * (5) only now are the bytes fetched, and (6) checked: allow-listed type, signature, size. Zone B's own refusals pass through
   * (415 `media-preview-unsupported` for a type that is never previewed, 413 `media-preview-too-large`, 404).
   */
  async reviewPreview(gate: ContentGate, site: SiteRef, assetId: string, rawQuery: unknown): Promise<MediaPreview> {
    gate.require("webdesk_media_asset", "read");
    const editable = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;
    await authorize(gate.principal, this.reviewResource(gate, siteId, OTHER_UPLOADER), "review"); // (1) PHASE 2, before anything is validated
    strictQuery(rawQuery, []);
    if (!UUID_RE.test(assetId)) throw mediaAssetNotFound(); // (2)
    const found = await this.zoneB.read({
      command: "media.list",
      path: MEDIA_PATH,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      query: { assetId, reviewState: "quarantined", limit: "1" },
    });
    const row = isPlainObject(found.body) && Array.isArray(found.body.assets) ? found.body.assets.find(isPlainObject) : undefined;
    if (!row || row.assetId !== assetId.toLowerCase()) throw mediaAssetNotFound(); // (3) not in the quarantine of THIS site: the one 404
    await authorize(gate.principal, this.reviewResource(gate, siteId, typeof row.createdBy === "string" ? row.createdBy : null), "review"); // (4)
    const got = await this.zoneB.readBytes({
      command: "media.reviewPreview",
      path: `${MEDIA_PATH}/:assetId/review-preview`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId },
    }); // (5)
    // (6) the ERP's own wall: nothing Zone B says about the type is believed.
    const mime = mediaTypeOf(got.contentType);
    if (mime === null || !isPreviewRasterMime(mime) || (typeof row.mime === "string" && row.mime !== mime)) throw previewUnsupported(mime);
    if (got.bytes.length > PREVIEW_MAX_BYTES) throw previewTooLarge();
    if (got.bytes.length === 0 || !rasterSignatureMatches(got.bytes, mime)) throw previewUnsupported(mime);
    return { mime, bytes: got.bytes };
  }

  /** `PATCH …/media/:assetId` body `{title?, alt?, tags?}` (at least one) → 200 `{asset}`. Zone B validates the values. */
  async update(gate: ContentGate, site: SiteRef, assetId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "update");
    const editable = await gate.resolveSite(this.zoneB, site);
    await this.authorizeMedia(gate, editable.site.siteId, "update"); // PHASE 2, before the body is validated
    const b = strictBody(rawBody, UPDATE_KEYS);
    if (Object.keys(b).length === 0) throw invalidRequest(`the body must carry at least one of: ${UPDATE_KEYS.join(", ")}`);
    if (!UUID_RE.test(assetId)) throw mediaAssetNotFound();
    return this.zoneB.write(gate.principal, gate.tenantId, {
      command: "media.update",
      verb: "webdesk.media.update",
      method: "PATCH",
      path: `${MEDIA_PATH}/:assetId`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId },
      body: b,
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      ...gate.egressClient(),
      entity: { type: "webdesk_media_asset", id: assetId },
      // Which fields changed, never their values (a title or alt text is content).
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId, fields: Object.keys(b) },
    });
  }

  /**
   * `DELETE …/media/:assetId` → 200 `{assetId, deletedAt, purgeAfter, alreadyDeleted}`, or Zone B's 409 `media-in-use`
   * (with the using items) passed through untouched. Soft delete (WSK-D54). No body is sent.
   */
  async delete(gate: ContentGate, site: SiteRef, assetId: string, rawQuery: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "delete");
    const editable = await gate.resolveSite(this.zoneB, site);
    await this.authorizeMedia(gate, editable.site.siteId, "delete"); // PHASE 2, before the query is validated
    strictQuery(rawQuery, []);
    if (!UUID_RE.test(assetId)) throw mediaAssetNotFound();
    return this.zoneB.write(gate.principal, gate.tenantId, {
      command: "media.delete",
      verb: "webdesk.media.delete",
      method: "DELETE",
      path: `${MEDIA_PATH}/:assetId`,
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId },
      idempotencyKey,
      editorial: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      ...gate.egressClient(),
      entity: { type: "webdesk_media_asset", id: assetId },
      ledger: { tenantSlug: site.tenantSlug, siteId: site.siteId, assetId },
    });
  }
}

/** The process-wide service (one wall cache, shared with the content BFF). */
export const webdeskMedia = new WebdeskMediaService();
