"use server";
// WSK-49d — the client portal's Website area: WRITES (and the client-driven re-reads) as server actions, over the §16j BFF.
//
//   PUT  …/website/sites/:slug/:siteId/items/:itemId                      update   { baseVersion, fields?, note? }   (never seo, never blocks)
//   POST …/website/sites/:slug/:siteId/collections/:key/items             create   { locale, slug, fields?, note? }
//   POST …/website/sites/:slug/:siteId/items/:itemId/restore              { version, baseVersion, note? }
//   POST …/website/sites/:slug/:siteId/items/:itemId/preview              -> { previewUrl, expiresAt, version }
//   POST …/website/sites/:slug/:siteId/items/:itemId/publish              SELF-PUBLISH ONE item (D58) -> the approve answer
//   POST …/website/sites/:slug/:siteId/publish-requests                   file ONE request for a batch -> 202 { approvalId, command, itemCount }
//   POST …/website/publish-requests/:approvalId/approve                   another editor's request (D58): decide AND execute
//   POST …/website/sites/:slug/:siteId/publish-requests/:approvalId/withdraw
//   GET  …/media · POST …/media/upload-token · PATCH …/media/:assetId
//   There is NO route to delete media, delete / unpublish / schedule an item, or touch schema or keys, so nothing here can.
//
// Same shape as `webdeskContentActions.ts` (read its header): a `ctx()` resolving session -> me -> the portal's ACTIVE company
// (`getActivePortalCompany`, never the staff company resolver), then a typed `WdResult` for everything. A refusal is DATA: the
// editor must keep the user's edits and say why. UI gating is cosmetic; the BFF is the authority, and it answers a viewer without
// the grant with a 403 whatever this file does. This file also refuses a client the viewer holds no website-editor grant for, so a
// forged `clientId` never reaches the network.
//
// A write that leaves the page navigates FROM THE SERVER (`…AndOpenAction`), for the reason `webdeskContentActions.ts` gives
// (measured: a client `router.push` right after an awaited action is sometimes dropped). The destination is built here from a
// validated portal route, never taken as a free-form URL from the browser.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe } from "./platform";
import { getActivePortalCompany } from "./portal-company";
import { getPortalOverview } from "./portal-data";
import { HOST_COOKIES, setHostCookie } from "./cookieNames";
import { parsePreviewLink, parseWithdraw } from "./webdeskContent";
import type { ItemDetail, ItemWriteResult, PreviewLink, WdResult } from "./webdeskContentModel";
import { parseItemWriteResult } from "./webdeskContent";
import type { SiteScope } from "./webdeskContentActions";
import type { EditorCreateInput, EditorSaveInput, EditorWriteFailure } from "./webdeskEditorDriver";
import { mediaCall } from "./webdeskMedia";
import { parseMediaList, parseMediaUpdated, parseUploadToken, type MediaAsset, type MediaListBody, type MediaQuery, type UploadToken } from "./webdeskMediaModel";
import {
  getPortalItem, loadPortalEditorBundle, parseApproveResult, parseRequestFiled, portalCall, portalSiteBase, portalWebsiteBase,
  type PortalEditorBundle,
} from "./portalWebsite";
import { PORTAL_WEBSITE_BASE, type PortalApproveResult, type PortalRequestFiled } from "./portalWebsiteModel";
import { websiteEditorClients } from "./portalWebsiteAccess";

type Ctx = { userId: string; tenant: string; clientId: string };

const enc = encodeURIComponent;
const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const badScope: WdResult<never> = { kind: "invalid", issues: [], message: "Missing site." };
const noAccess: WdResult<never> = { kind: "forbidden", reason: "no website editing access" };
const sessionGone: WdResult<never> = { kind: "unavailable", code: "upstream_error", reason: "session_expired" };

function scopeOk(s: SiteScope): boolean {
  return !!clean(s?.tenantSlug) && !!clean(s?.siteId);
}

/** Session -> the viewer -> the portal's active company, and the client the viewer may edit the website of. */
async function ctx(clientId: string): Promise<Ctx | WdResult<never>> {
  const userId = await getSessionUserId();
  if (!userId) return sessionGone;
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return { kind: "unavailable", code: "upstream_error", reason: "no_active_company" };
  const id = clean(clientId);
  if (!ID_RE.test(id) || websiteEditorClients(me.roles, [id]).length === 0) return noAccess;
  return { userId, tenant, clientId: id };
}

const isCtx = (c: Ctx | WdResult<never>): c is Ctx => "userId" in c;

const json = (method: "POST" | "PUT" | "PATCH", body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** Every portal page that shows publishing state: dropped after a write that changes it. */
function revalidateWebsite(): void {
  revalidatePath(PORTAL_WEBSITE_BASE, "layout");
}

// ── Item writes ──────────────────────────────────────────────────────────────────────────────────────

/** Update. The body is `{ baseVersion, fields, note? }` ONLY: the BFF refills `seo` and generic blocks from the head, and refuses a
 *  client that states them (`422 field-not-client-editable` `/seo`), so this never forwards either even if a caller passes them. */
export async function portalSaveItemAction(clientId: string, scope: SiteScope, itemId: string, input: EditorSaveInput): Promise<WdResult<ItemWriteResult>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (!Number.isInteger(input?.baseVersion)) return { kind: "invalid", issues: [], message: "Missing base version." };
  const body = {
    baseVersion: input.baseVersion,
    fields: input.fields,
    ...(clean(input.note) ? { note: clean(input.note) } : {}),
  };
  return portalCall(`${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/items/${enc(clean(itemId))}`, c.userId, parseItemWriteResult, json("PUT", body));
}

/** Create. `{ locale, slug, fields?, note? }`: no `seo`, and no `twinOf` (a client never creates a locale twin: it would copy fields the
 *  client cannot set). The collection is in the path, not the body. */
export async function portalCreateItemAction(clientId: string, scope: SiteScope, input: EditorCreateInput): Promise<WdResult<ItemWriteResult>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  const { collectionKey, locale, slug } = input;
  if (!clean(collectionKey) || !clean(locale) || !clean(slug)) {
    return { kind: "invalid", issues: [{ path: "/slug", message: "Collection, language and page address are required." }], message: "Collection, language and page address are required." };
  }
  const body = {
    locale, slug,
    fields: input.fields,
    ...(Array.isArray(input.blocks) && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
    ...(clean(input.note) ? { note: clean(input.note) } : {}),
  };
  return portalCall(
    `${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/collections/${enc(clean(collectionKey))}/items`,
    c.userId, parseItemWriteResult, json("POST", body),
  );
}

export async function portalRestoreVersionAction(clientId: string, scope: SiteScope, itemId: string, version: number, baseVersion: number, note?: string): Promise<WdResult<ItemWriteResult>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId) || !Number.isInteger(version) || !Number.isInteger(baseVersion)) return badScope;
  return portalCall(
    `${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/items/${enc(clean(itemId))}/restore`,
    c.userId, parseItemWriteResult, json("POST", { version, baseVersion, ...(clean(note) ? { note: clean(note) } : {}) }),
  );
}

/** The Website area's own base (`/portal/website/<tenant>/<site>`): the only place a write may send the browser. */
const ROUTE_BASE_RE = /^\/portal\/website\/[^/?#\s]+\/[^/?#\s]+$/;
/** An editor URL under that base: `<base>/<collection>/<slug>[?locale=<tag>]`. */
const EDITOR_HREF_RE = /^\/portal\/website\/[^/?#\s]+\/[^/?#\s]+\/[^/?#\s]+\/[^/?#\s]+(\?locale=[A-Za-z0-9-]+)?$/;
const badDestination: EditorWriteFailure = { kind: "invalid", issues: [], message: "Not a page in the Website area." };

export async function portalCreateItemAndOpenAction(clientId: string, scope: SiteScope, input: EditorCreateInput, routeBase: string): Promise<EditorWriteFailure> {
  if (typeof routeBase !== "string" || !ROUTE_BASE_RE.test(routeBase)) return badDestination;
  const r = await portalCreateItemAction(clientId, scope, input);
  if (r.kind !== "ok") return r;
  revalidateWebsite();
  redirect(`${routeBase}/${enc(input.collectionKey)}/${enc(r.data.item.slug)}?locale=${enc(r.data.item.locale)}`);
}

export async function portalRestoreVersionAndOpenAction(
  clientId: string, scope: SiteScope, itemId: string, version: number, baseVersion: number, editorHref: string, note?: string,
): Promise<EditorWriteFailure> {
  if (typeof editorHref !== "string" || !EDITOR_HREF_RE.test(editorHref)) return badDestination;
  const r = await portalRestoreVersionAction(clientId, scope, itemId, version, baseVersion, note);
  if (r.kind !== "ok") return r;
  revalidateWebsite();
  redirect(editorHref);
}

// ── Preview ──────────────────────────────────────────────────────────────────────────────────────────

/** WSK-46's one-time preview link, authorised as the item's `update`. The link is a bearer secret: returned to the caller, never stored or logged here. */
export async function portalPreviewItemAction(clientId: string, scope: SiteScope, itemId: string, version?: number): Promise<WdResult<PreviewLink>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) return { kind: "invalid", issues: [], message: "Missing version." };
  return portalCall(
    `${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/items/${enc(clean(itemId))}/preview`,
    c.userId, parsePreviewLink, json("POST", version === undefined ? {} : { version }),
  );
}

// ── Publishing (D58, D62) ────────────────────────────────────────────────────────────────────────────

/** SELF-PUBLISH ONE item (D58): the BFF files the request and approves it as the same person in one call. `version` omitted = the head. */
export async function portalPublishItemAction(clientId: string, scope: SiteScope, itemId: string, version?: number): Promise<WdResult<PortalApproveResult>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) return { kind: "invalid", issues: [], message: "Missing version." };
  const r = await portalCall(
    `${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/items/${enc(clean(itemId))}/publish`,
    c.userId, parseApproveResult, json("POST", version === undefined ? {} : { version }),
  );
  if (r.kind === "ok") revalidateWebsite();
  return r;
}

/** Request publish for a BATCH: files ONE request; publishes nothing. A client never schedules, so no `publishAt` / `unpublishAt` exists here. */
export async function portalRequestPublishAction(clientId: string, scope: SiteScope, items: { itemId: string; version: number }[], note?: string): Promise<WdResult<PortalRequestFiled>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !Array.isArray(items) || items.length === 0 || items.length > 100 || items.some((i) => !clean(i.itemId) || !Number.isInteger(i.version) || i.version < 1)) return badScope;
  const r = await portalCall(
    `${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/publish-requests`,
    c.userId, parseRequestFiled, json("POST", { items: items.map((i) => ({ itemId: i.itemId, version: i.version })), ...(clean(note) ? { note: clean(note) } : {}) }),
  );
  if (r.kind === "ok") revalidateWebsite();
  return r;
}

/** Approve ANOTHER editor's request: decide AND execute (D58). A self-approved batch is a 403 from the server, whatever the page showed. */
export async function portalApproveRequestAction(clientId: string, approvalId: string): Promise<WdResult<PortalApproveResult>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!ID_RE.test(clean(approvalId))) return badScope;
  const r = await portalCall(`${portalWebsiteBase(c.tenant, c.clientId)}/publish-requests/${enc(clean(approvalId))}/approve`, c.userId, parseApproveResult, { method: "POST" });
  if (r.kind === "ok") revalidateWebsite();
  return r;
}

/** The REQUESTER cancels their own pending request. Nothing is sent to WebDesk. */
export async function portalWithdrawRequestAction(clientId: string, scope: SiteScope, approvalId: string): Promise<WdResult<{ approvalId: string; status: string }>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !ID_RE.test(clean(approvalId))) return badScope;
  const r = await portalCall(
    `${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/publish-requests/${enc(clean(approvalId))}/withdraw`,
    c.userId, parseWithdraw, { method: "POST" },
  );
  if (r.kind === "ok") revalidateWebsite();
  return r;
}

// ── Client-driven re-reads (refresh / conflict reload / publish verification) ────────────────────────

/** The item's current head: the publish verification read. */
export async function portalGetItemHeadAction(clientId: string, scope: SiteScope, itemId: string): Promise<WdResult<ItemDetail>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  return getPortalItem(c.userId, c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId), clean(itemId), "head");
}

/** The editor's refresh / Reload: the whole bundle again. A failure here is what flips the page to STALE. */
export async function portalRefreshEditorAction(
  clientId: string, scope: SiteScope, collectionKey: string, slug: string, locale: string,
): Promise<WdResult<PortalEditorBundle>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(collectionKey) || !clean(slug) || !clean(locale)) return badScope;
  return loadPortalEditorBundle(c.userId, c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId), clean(collectionKey), clean(slug), clean(locale));
}

// ── Media (no delete: the client BFF has none) ───────────────────────────────────────────────────────

const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/;
const IDEM_RE = /^[\x21-\x7e]{8,200}$/;

function cleanMediaQuery(q: MediaQuery | undefined): MediaQuery {
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

export async function portalListMediaAction(clientId: string, scope: SiteScope, query?: MediaQuery): Promise<WdResult<MediaListBody>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  const q = cleanMediaQuery(query);
  const p = new URLSearchParams();
  if (q.mime) p.set("mime", q.mime);
  if (q.q) p.set("q", q.q);
  if (q.tag) p.set("tag", q.tag);
  if (q.cursor) p.set("cursor", q.cursor);
  p.set("limit", String(Math.min(Math.max(q.limit ?? 48, 1), 100)));
  const r = await mediaCall(`${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/media?${p.toString()}`, c.userId, parseMediaList);
  return r as WdResult<MediaListBody>;
}

/** One token per file; the file itself goes browser -> WebDesk exactly as in the staff UI. The token is a secret: never logged, never in a result's `reason`. */
export async function portalMintUploadTokenAction(clientId: string, scope: SiteScope, bucket: "media" | "video"): Promise<WdResult<UploadToken>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  if (bucket !== "media" && bucket !== "video") return { kind: "invalid", issues: [], message: "Choose a bucket." };
  const r = await mediaCall(`${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/media/upload-token`, c.userId, parseUploadToken, json("POST", { bucket }));
  return r as WdResult<UploadToken>;
}

export async function portalUpdateMediaAction(
  clientId: string, scope: SiteScope, assetId: string, patch: { title?: string | null; alt?: Record<string, string>; tags?: string[] }, idempotencyKey?: string,
): Promise<WdResult<{ asset: MediaAsset }>> {
  const c = await ctx(clientId); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(assetId)) return badScope;
  const body: { title?: string | null; alt?: Record<string, string>; tags?: string[] } = {};
  if (patch && "title" in patch) body.title = patch.title === null ? null : String(patch.title ?? "");
  if (patch && patch.alt && typeof patch.alt === "object") {
    body.alt = Object.fromEntries(Object.entries(patch.alt).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
  }
  if (patch && Array.isArray(patch.tags)) body.tags = patch.tags.filter((t): t is string => typeof t === "string");
  if (Object.keys(body).length === 0) return { kind: "invalid", issues: [], message: "Nothing to change." };
  const r = await mediaCall(
    `${portalSiteBase(c.tenant, c.clientId, clean(scope.tenantSlug), clean(scope.siteId))}/media/${enc(clean(assetId))}`, c.userId, parseMediaUpdated,
    { method: "PATCH", body: JSON.stringify(body), headers: idempotencyKey && IDEM_RE.test(idempotencyKey) ? { "idempotency-key": idempotencyKey } : {} },
  );
  return r as WdResult<{ asset: MediaAsset }>;
}

// ── The client switcher (a viewer who may edit the website of more than one client) ──────────────────

/** Form action behind the Website page's client switch. An id the viewer may not edit sets no cookie; the redirect still happens.
 *  Uses the SAME remembered-client cookie as the Business tab, so the two tabs always show the same client. */
export async function switchWebsiteClient(formData: FormData): Promise<void> {
  const id = clean(formData.get("clientId"));
  const userId = await getSessionUserId();
  if (userId && ID_RE.test(id)) {
    const me = await getMe(userId).catch(() => null);
    const tenant = me ? ((await getActivePortalCompany(me))?.id ?? null) : null;
    const scope = me && tenant ? ((await getPortalOverview(userId, tenant).catch(() => ({ overview: null }))).overview?.clients ?? []) : [];
    if (me && websiteEditorClients(me.roles, scope.map((c) => c.id)).includes(id)) {
      setHostCookie(await cookies(), HOST_COOKIES.portalClient, id);
    }
  }
  redirect(PORTAL_WEBSITE_BASE);
}
