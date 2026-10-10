"use server";
// WSK-44 — writes (and the client-driven re-reads) for the Website workspace.
//
//   POST …/sites/:tenantSlug/:siteId/collections/:collectionKey/items       create
//   PUT  …/sites/:tenantSlug/:siteId/items/:itemId                          update   (full replacement)
//   POST …/sites/:tenantSlug/:siteId/items/:itemId/restore
//   POST …/sites/:tenantSlug/:siteId/publish-requests                       -> 202 { approvalId }
//   POST …/sites/:tenantSlug/:siteId/items/:itemId/unpublish
//   POST …/sites/:tenantSlug/:siteId/items/:itemId/delete
//   PROPOSED (not in WSK-59 — see the WSK-44 report):
//   POST …/sites/:tenantSlug/:siteId/publish-requests/:approvalId/withdraw  -> { approvalId, status }
//   POST …/sites/:tenantSlug/:siteId/rebuild-requests                       -> 202 { approvalId }
//
// Same shape as the repo's other actions files: a `ctx()` resolving session -> me -> active company,
// then a typed result. Unlike them there is NO `can(me, …)` gate: `lib/rbac.ts` has no WebDesk
// capability (the Cerbos kinds `webdesk_content_item`/`webdesk_collection` are WSK-47's and carry no
// UI mirror), and inventing one here would be a guess dressed as a gate. UI gating is cosmetic anyway
// — the BFF's `authorize()` is the first statement of every handler. A 403 comes back as
// `{ kind: "forbidden" }` and the editor turns read-only (see ItemEditor).
//
// Every result is a `WdResult<T>` — a refusal is never swallowed into a success-shaped value, and a
// 409/422 is returned as DATA (the editor must keep the user's edits and show them), never thrown.
//
// Request bodies carry ONLY the keys §3.2 names. `tenantSlug`, `siteId` and `itemId` travel in the
// route, never the body: Zone B 400s a body containing them (the command hash merges route params and
// body, and a colliding key would make it ambiguous).
import { getSessionUserId } from "./session-server";
import { getMe } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  wdCall, siteBase, parseItemWriteResult, parseItemOnly, parseApprovalId, parseWithdraw, parseBuildStatus,
  parseApprovalRow, loadEditorBundle, getItem,
  type EditorBundle,
} from "./webdeskContent";
import type {
  Block, BuildStatus, ItemDetail, ItemRef, ItemWriteResult, WdResult, WebdeskApprovalRow,
} from "./webdeskContentModel";

export interface SiteScope { tenantSlug: string; siteId: string }

type Ctx = { userId: string; company: string };

async function ctx(): Promise<Ctx | WdResult<never>> {
  const userId = await getSessionUserId();
  if (!userId) return { kind: "unavailable", code: "upstream_error", reason: "session_expired" };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { kind: "unavailable", code: "upstream_error", reason: "no_active_company" };
  return { userId, company };
}

function isCtx(c: Ctx | WdResult<never>): c is Ctx {
  return "userId" in c;
}

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

function scopeOk(s: SiteScope): boolean {
  return !!clean(s?.tenantSlug) && !!clean(s?.siteId);
}
const badScope: WdResult<never> = { kind: "invalid", issues: [], message: "Missing site." };

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// ── Item writes ──────────────────────────────────────────────────────────────────────────────────

export interface SaveInput {
  baseVersion: number;
  fields: Record<string, unknown>;
  blocks: Block[];
  seo: Record<string, unknown>;
  note?: string;
}

export async function saveItemAction(scope: SiteScope, itemId: string, input: SaveInput): Promise<WdResult<ItemWriteResult>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  if (!Number.isInteger(input?.baseVersion)) return { kind: "invalid", issues: [], message: "Missing base version." };
  const body = {
    baseVersion: input.baseVersion,
    fields: input.fields,
    blocks: input.blocks,
    seo: input.seo,
    ...(clean(input.note) ? { note: clean(input.note) } : {}),
  };
  return wdCall(`${siteBase(c.company, scope.tenantSlug, scope.siteId)}/items/${encodeURIComponent(itemId)}`, c.userId, parseItemWriteResult, {
    method: "PUT", body: JSON.stringify(body),
  });
}

export interface CreateInput {
  collectionKey: string;
  locale: string;
  slug: string;
  /** An itemId in the same collection, another locale — joins its localization group. */
  twinOf: string | null;
  fields: Record<string, unknown>;
  blocks: Block[];
  seo: Record<string, unknown>;
  note?: string;
}

export async function createItemAction(scope: SiteScope, input: CreateInput): Promise<WdResult<ItemWriteResult>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  const { collectionKey, locale, slug } = input;
  if (!clean(collectionKey) || !clean(locale) || !clean(slug)) {
    return { kind: "invalid", issues: [{ path: "/slug", message: "Collection, locale and slug are required." }], message: "Collection, locale and slug are required." };
  }
  const body = {
    collectionKey, locale, slug,
    twinOf: input.twinOf,
    fields: input.fields, blocks: input.blocks, seo: input.seo,
    ...(clean(input.note) ? { note: clean(input.note) } : {}),
  };
  return wdCall(
    `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/collections/${encodeURIComponent(collectionKey)}/items`,
    c.userId, parseItemWriteResult, json(body),
  );
}

export async function restoreVersionAction(scope: SiteScope, itemId: string, version: number, baseVersion: number, note?: string): Promise<WdResult<ItemWriteResult>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId) || !Number.isInteger(version) || !Number.isInteger(baseVersion)) return badScope;
  return wdCall(
    `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/items/${encodeURIComponent(itemId)}/restore`,
    c.userId, parseItemWriteResult, json({ version, baseVersion, ...(clean(note) ? { note: clean(note) } : {}) }),
  );
}

export async function unpublishItemAction(scope: SiteScope, itemId: string, expectedPublishedVersion: number): Promise<WdResult<{ item: ItemRef }>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId) || !Number.isInteger(expectedPublishedVersion)) return badScope;
  return wdCall(
    `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/items/${encodeURIComponent(itemId)}/unpublish`,
    c.userId, parseItemOnly, json({ expectedPublishedVersion }),
  );
}

export async function deleteItemAction(scope: SiteScope, itemId: string, baseVersion: number): Promise<WdResult<{ item: ItemRef }>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId) || !Number.isInteger(baseVersion)) return badScope;
  return wdCall(
    `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/items/${encodeURIComponent(itemId)}/delete`,
    c.userId, parseItemOnly, json({ baseVersion }),
  );
}

// ── Publish / approval ───────────────────────────────────────────────────────────────────────────

export async function requestPublishAction(
  scope: SiteScope, items: { itemId: string; version: number }[], publishAt?: string | null,
): Promise<WdResult<{ approvalId: string }>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !Array.isArray(items) || items.length === 0 || items.some((i) => !clean(i.itemId) || !Number.isInteger(i.version))) return badScope;
  return wdCall(
    `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/publish-requests`,
    c.userId, parseApprovalId, json({ items: items.map((i) => ({ itemId: i.itemId, version: i.version })), ...(publishAt ? { publishAt } : {}) }),
  );
}

/** PROPOSED route (see header). A 404/405 comes back as `not_enabled` and the UI says so. */
export async function withdrawPublishRequestAction(scope: SiteScope, approvalId: string): Promise<WdResult<{ approvalId: string; status: string }>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(approvalId)) return badScope;
  return wdCall(
    `${siteBase(c.company, scope.tenantSlug, scope.siteId)}/publish-requests/${encodeURIComponent(approvalId)}/withdraw`,
    c.userId, parseWithdraw, { method: "POST" },
  );
}

/** PROPOSED route (see header): files a rebuild approval for the "unpublished, staging stale" state. */
export async function requestRebuildAction(scope: SiteScope): Promise<WdResult<{ approvalId: string }>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  return wdCall(`${siteBase(c.company, scope.tenantSlug, scope.siteId)}/rebuild-requests`, c.userId, parseApprovalId, { method: "POST" });
}

// ── Client-driven re-reads (poll / refresh) ──────────────────────────────────────────────────────

export async function pollApprovalAction(approvalId: string): Promise<WdResult<WebdeskApprovalRow>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!clean(approvalId)) return badScope;
  return wdCall(`/api/${encodeURIComponent(c.company)}/automation-approvals/${encodeURIComponent(approvalId)}`, c.userId, parseApprovalRow);
}

export async function pollBuildStatusAction(scope: SiteScope): Promise<WdResult<BuildStatus>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope)) return badScope;
  return wdCall(`${siteBase(c.company, scope.tenantSlug, scope.siteId)}/build-status`, c.userId, parseBuildStatus);
}

/** The item's current head — the conflict dialog's "theirs", and the publish verification read. */
export async function getItemHeadAction(scope: SiteScope, itemId: string): Promise<WdResult<ItemDetail>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(itemId)) return badScope;
  return getItem(c.userId, c.company, scope.tenantSlug, scope.siteId, itemId, "head");
}

/** The editor's "refresh": the whole bundle again. A failure here is what flips the page to STALE. */
export async function refreshEditorAction(
  scope: SiteScope, collectionKey: string, slug: string, locale: string,
): Promise<WdResult<EditorBundle>> {
  const c = await ctx(); if (!isCtx(c)) return c;
  if (!scopeOk(scope) || !clean(collectionKey) || !clean(slug) || !clean(locale)) return badScope;
  return loadEditorBundle(c.userId, c.company, scope.tenantSlug, scope.siteId, collectionKey, slug, locale);
}
