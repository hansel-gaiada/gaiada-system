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
//
// Every method takes a `ContentGate`, which only `authorizeContent()` (Cerbos, as the CALLER, kind
// `webdesk_media_asset`, module `webdev`) can produce; the controller's first statement is that call, so
// authorization precedes ANY body validation (the "validation pre-empts authz" trap). No attribute is taken
// from Zone B for the decision: the policy reads only the tenant and the module.
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
import { checkActions } from "../../rbac/cerbos";
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
export async function mediaCapabilities(gate: ContentGate): Promise<MediaCapabilities | null> {
  try {
    // Through rbac/cerbos.ts (the approved egress and the one resource-attribute allow-list), with exactly the resource
    // the real handlers authorize: kind, tenant, module, and the client on a client gate.
    const got = await checkActions(
      gate.principal,
      { kind: "webdesk_media_asset", tenantId: gate.tenantId, module: "webdev", ...(gate.client ? { clientId: gate.client.clientId } : {}) },
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

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  /**
   * `GET …/media[?mime&q&tag&includeDeleted&cursor&limit]`: Zone B's `media.list`, allow-listed query only, plus
   * `capabilities: {read, upload, update, delete}` (WSK-359, `mediaCapabilities`) so the UI disables a control the caller cannot
   * use up front. `capabilities` is absent when Cerbos could not answer the batch (unknown, never "denied").
   */
  async list(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "read");
    const query = strictQuery(rawQuery, LIST_QUERY);
    await gate.resolveSite(this.zoneB, site);
    const [res, capabilities] = await Promise.all([
      this.zoneB.read({
        command: "media.list",
        path: MEDIA_PATH,
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
        query,
      }),
      mediaCapabilities(gate),
    ]);
    return capabilities && isPlainObject(res.body) ? { status: res.status, body: { ...res.body, capabilities } } : res;
  }

  /** `GET …/media/:assetId/usage`: which items use the asset (at most 50), so the UI can say where before a delete. */
  async usage(gate: ContentGate, site: SiteRef, assetId: string, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "read");
    strictQuery(rawQuery, []);
    await gate.resolveSite(this.zoneB, site);
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
    await gate.resolveSite(this.zoneB, site);
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

  /** `PATCH …/media/:assetId` body `{title?, alt?, tags?}` (at least one) → 200 `{asset}`. Zone B validates the values. */
  async update(gate: ContentGate, site: SiteRef, assetId: string, rawBody: unknown, idempotencyKey: string): Promise<ZoneBResult> {
    gate.require("webdesk_media_asset", "update");
    await gate.resolveSite(this.zoneB, site);
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
    strictQuery(rawQuery, []);
    await gate.resolveSite(this.zoneB, site);
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
