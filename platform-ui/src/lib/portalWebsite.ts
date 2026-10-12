import "server-only";
// WSK-49d — the client portal's Website area: the SERVER reads, over the §16j BFF.
//
//   /api/:t/portal/clients/:clientId/website/…      (:t = the serving company = the portal's ACTIVE company, :clientId = clients.id)
//
// A NEW module on purpose. `platform-nest/.../webdesk-content-ui-contract.test.ts` loads `webdeskContent.ts`,
// `webdeskContentActions.ts`, `webdeskContentModel.ts` and `platform.ts` into nest's own test runner (nest's node_modules
// only), so nothing portal-specific is added to those four. This file imports FROM them; they do not import it.
//
// Same three rules as `webdeskContent.ts` (read its header):
//   1. every Website read goes through here;
//   2. every 2xx body is validated before it is returned (a mismatch is `contract_drift`, never data) — in particular a
//      collection or item WITHOUT a well-formed `clientEditable` is drift, never "editable";
//   3. no refusal becomes `[]`: results are `WdResult<T>`, and `ok` with an empty list is evidence of emptiness.
//
// THE PORTAL RULES (PV guard list): the company is `getActivePortalCompany`, never the staff company resolver; the client
// comes from the viewer's own grants intersected with the portal's own client scope (`lib/portalWebsiteAccess.ts`). UI gating
// is cosmetic: the BFF's Cerbos check and the site wall are the authority on every route below.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PlatformError, platformFetch, getMe, type Me } from "./platform";
import { getSessionUserId } from "./session-server";
import { getActivePortalCompany } from "./portal-company";
import { getPortalOverview } from "./portal-data";
import { HOST_COOKIES, readHostCookie } from "./cookieNames";
import {
  parseCollections, parseComposition, parseItemDetail, parseItemList, parseVersionFull, parseVersionList, problemOf, resultFromError, wire, WireDrift,
  type EditorBundle,
} from "./webdeskContent";
import {
  hasNeutralDescendant, splitVersionContent, type CollectionComposition, type CollectionSummary, type ItemDetail, type ItemListBody,
  type SiteRef, type TenantRef, type VersionFull, type VersionListBody, type WdResult,
} from "./webdeskContentModel";
import type { ClientEditable } from "./webdeskEditorDriver";
import { mediaCall } from "./webdeskMedia";
import { parseMediaList, type MediaListBody } from "./webdeskMediaModel";
import { pickWebsiteClient, WEBSITE_EDITOR_ROLE, websiteEditorClients } from "./portalWebsiteAccess";
import { itemTitle } from "./portalWebsiteModel";
import type {
  PortalApproveResult, PortalBuild, PortalCollection, PortalPublishRequest, PortalRequestFiled, PortalSite, RequestItemView, RequestView,
} from "./portalWebsiteModel";

const { str, int, bool, nullable, arr, obj, key, opt } = wire;
const strN = nullable(str);
const enc = encodeURIComponent;

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────────

export const portalWebsiteBase = (tenant: string, clientId: string) => `/api/${enc(tenant)}/portal/clients/${enc(clientId)}/website`;
export const portalSiteBase = (tenant: string, clientId: string, tenantSlug: string, siteId: string) =>
  `${portalWebsiteBase(tenant, clientId)}/sites/${enc(tenantSlug)}/${enc(siteId)}`;

// ── Errors → results ─────────────────────────────────────────────────────────────────────────────────

/** `resultFromError`, plus the §16j problem slug on the two kinds that drop it (422 `invalid` and 403 `forbidden`), so the
 *  words can tell `field-not-client-editable` from `publish-not-client-editable` and `client-command-not-allowed` from a plain 403.
 *  Staff results are untouched (this is only ever called from the portal). */
export function portalResultFromError(e: unknown): WdResult<never> {
  const r = resultFromError(e);
  if (e instanceof PlatformError && (r.kind === "invalid" || r.kind === "forbidden")) {
    const slug = problemOf(e).slug;
    if (slug) return { ...r, slug };
  }
  return r;
}

/** One portal BFF call: egress, validate, and fold every failure into a `WdResult` (with the slug). */
export async function portalCall<T>(path: string, userId: string, parse: (raw: unknown) => T, init: RequestInit = {}): Promise<WdResult<T>> {
  let raw: unknown;
  try {
    raw = await platformFetch<unknown>(path, userId, init);
  } catch (e) {
    return portalResultFromError(e);
  }
  try {
    return { kind: "ok", data: parse(raw) };
  } catch (e) {
    return resultFromError(e);
  }
}

// ── Parsers (strict) ─────────────────────────────────────────────────────────────────────────────────

const CREATE_REASONS: readonly string[] = ["system-collection", "nothing-editable", "required-fields-not-editable"];

/** `clientEditable` (§16j). STRICT: a body without it, or with `seo` other than `false`, is drift. A missing verdict is never "editable". */
export function parseClientEditable(v: unknown, path: string): ClientEditable {
  const o = obj(v, path);
  const fields = key(o, "fields", wire.record(bool), path);
  const blocks = key(o, "blocks", bool, path);
  const seo = key(o, "seo", bool, path);
  if (seo !== false) throw new WireDrift(`${path}.seo`, "false (seo is never client-editable)", seo);
  const c = key(o, "create", obj, path);
  const cp = `${path}.create`;
  const allowed = key(c, "allowed", bool, cp);
  const reason = key(c, "reason", strN, cp);
  if (reason !== null && !CREATE_REASONS.includes(reason)) throw new WireDrift(`${cp}.reason`, CREATE_REASONS.join("|"), reason);
  const blockedBy = key(c, "blockedBy", arr(str), cp);
  return { fields, blocks, seo: false, create: { allowed, reason: reason as ClientEditable["create"]["reason"], blockedBy } };
}

export function parsePortalSites(v: unknown): { clientId: string; sites: PortalSite[] } {
  const o = obj(v, "website");
  return {
    clientId: key(o, "clientId", str, "website"),
    sites: key(o, "sites", arr((x, p) => {
      const s = obj(x, p);
      return {
        tenantSlug: key(s, "tenantSlug", str, p), siteId: key(s, "siteId", str, p), name: key(s, "name", str, p), kind: key(s, "kind", str, p),
        defaultLocale: key(s, "defaultLocale", str, p), locales: key(s, "locales", arr(str), p), linkedAt: opt(s, "linkedAt", strN, p) ?? null,
      };
    }), "website"),
  };
}

export function parsePortalCollections(v: unknown): PortalCollection[] {
  const base: CollectionSummary[] = parseCollections(v);
  const raw = key(obj(v, "collections"), "collections", arr(obj), "collections");
  return base.map((c, i) => ({ ...c, clientEditable: key(raw[i] as Record<string, unknown>, "clientEditable", (x, p) => parseClientEditable(x, p), `collections[${i}]`) }));
}

/** The display labels the BFF resolved for the author ids in a read (WSK-359): `{<users.id>: "Ayu Wijaya" | "Gaiada" | "<automation name>" | "Someone else"}`.
 *  Absent in the body (an older BFF, or a read naming no author) is `{}`, and `authorLabel` then falls back to a short id as before. */
export type PortalAuthors = Record<string, string>;

export function parseAuthors(v: unknown): PortalAuthors {
  const o = obj(v, "read");
  const raw = opt(o, "authors", wire.record(str), "read");
  return raw ?? {};
}

/** A parser whose result also carries the body's `authors`. */
const withAuthors = <T,>(parse: (raw: unknown) => T) => (raw: unknown): T & { authors: PortalAuthors } => ({ ...parse(raw), authors: parseAuthors(raw) });

export interface PortalItemDetail extends ItemDetail {
  composition: CollectionComposition;
  clientEditable: ClientEditable;
  authors: PortalAuthors;
}

export function parsePortalItemDetail(v: unknown): PortalItemDetail {
  const detail = parseItemDetail(v);
  const o = obj(v, "item.get");
  return {
    ...detail,
    composition: key(o, "composition", (x, p) => parseComposition(x, p), "item.get"),
    clientEditable: key(o, "clientEditable", (x, p) => parseClientEditable(x, p), "item.get"),
    authors: parseAuthors(v),
  };
}

const REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;

export function parsePortalRequests(v: unknown): PortalPublishRequest[] {
  const o = obj(v, "publish-requests");
  return key(o, "requests", arr((x, p) => {
    const r = obj(x, p);
    const status = key(r, "status", str, p);
    if (!(REQUEST_STATUSES as readonly string[]).includes(status)) throw new WireDrift(`${p}.status`, REQUEST_STATUSES.join("|"), status);
    const by = key(r, "requestedBy", obj, p);
    return {
      approvalId: key(r, "approvalId", str, p), status: status as PortalPublishRequest["status"], createdAt: key(r, "createdAt", str, p),
      tenantSlug: key(r, "tenantSlug", strN, p), siteId: key(r, "siteId", strN, p),
      itemCount: key(r, "itemCount", int, p), itemIds: key(r, "itemIds", arr(str), p),
      // The requested versions (WSK-359). Optional on the wire so an older BFF still parses: no `items` = the versions are unknown.
      items: opt(r, "items", arr((x, ip) => { const i = obj(x, ip); return { itemId: key(i, "itemId", str, ip), version: key(i, "version", int, ip) }; }), p) ?? [],
      requestedBy: { userId: key(by, "userId", strN, `${p}.requestedBy`), name: key(by, "name", strN, `${p}.requestedBy`) },
      requestedByMe: key(r, "requestedByMe", bool, p), canApprove: key(r, "canApprove", bool, p),
      executionStatus: key(r, "executionStatus", strN, p),
    };
  }), "publish-requests");
}

/** The approve / self-publish answer. `executionStatus` is `executed` or `failed`; anything else is drift, never "published". */
const BUILD_STATES = ["rebuilding", "live", "unverified", "failed"] as const;

/** `build: {state, failureReason}` (WSK-359). Absent is `null` (no state to show); present, an unknown state is drift, never "live". */
export function parseBuild(v: unknown, path: string): PortalBuild | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, path);
  const state = key(o, "state", str, path);
  if (!(BUILD_STATES as readonly string[]).includes(state)) throw new WireDrift(`${path}.state`, BUILD_STATES.join("|"), state);
  return { state: state as PortalBuild["state"], failureReason: key(o, "failureReason", strN, path) };
}

export function parseApproveResult(v: unknown): PortalApproveResult {
  const o = obj(v, "approve");
  const exec = key(o, "executionStatus", str, "approve");
  if (exec !== "executed" && exec !== "failed") throw new WireDrift("approve.executionStatus", "executed|failed", exec);
  return {
    build: parseBuild(o.build, "approve.build"),
    approvalId: key(o, "approvalId", str, "approve"), status: key(o, "status", str, "approve"), executionStatus: exec,
    selfPublish: opt(o, "selfPublish", bool, "approve") ?? null, reconciled: opt(o, "reconciled", bool, "approve") ?? null,
    error: opt(o, "error", strN, "approve") ?? null,
  };
}

export function parseRequestFiled(v: unknown): PortalRequestFiled {
  const o = obj(v, "request");
  return { approvalId: key(o, "approvalId", str, "request"), command: key(o, "command", str, "request"), itemCount: key(o, "itemCount", int, "request") };
}

// ── Readers ──────────────────────────────────────────────────────────────────────────────────────────

export function listPortalSites(userId: string, tenant: string, clientId: string) {
  return portalCall(portalWebsiteBase(tenant, clientId), userId, parsePortalSites);
}

export function listPortalCollections(userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string) {
  return portalCall(`${portalSiteBase(tenant, clientId, tenantSlug, siteId)}/collections`, userId, parsePortalCollections);
}

export interface PortalItemQuery { locale?: string; state?: string; q?: string; cursor?: string; limit?: number; slug?: string }

export function listPortalItems(userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string, collectionKey: string, q: PortalItemQuery = {}) {
  const p = new URLSearchParams();
  for (const k of ["locale", "state", "q", "cursor", "slug"] as const) if (q[k]) p.set(k, q[k] as string);
  p.set("limit", String(Math.min(q.limit ?? 100, 100)));
  return portalCall(`${portalSiteBase(tenant, clientId, tenantSlug, siteId)}/collections/${enc(collectionKey)}/items?${p.toString()}`, userId, withAuthors(parseItemList));
}

export function getPortalItem(userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string, itemId: string, version?: "head" | "live" | number) {
  const qs = version === undefined ? "" : `?version=${version}`;
  return portalCall(`${portalSiteBase(tenant, clientId, tenantSlug, siteId)}/items/${enc(itemId)}${qs}`, userId, parsePortalItemDetail);
}

export function listPortalVersions(userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string, itemId: string) {
  return portalCall(`${portalSiteBase(tenant, clientId, tenantSlug, siteId)}/items/${enc(itemId)}/versions?limit=100`, userId, withAuthors(parseVersionList));
}

export function getPortalVersion(userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string, itemId: string, n: number) {
  return portalCall(`${portalSiteBase(tenant, clientId, tenantSlug, siteId)}/items/${enc(itemId)}/versions/${n}`, userId, withAuthors(parseVersionFull));
}

export function listPortalRequests(userId: string, tenant: string, clientId: string, status: "pending" | "approved" | "rejected" | "cancelled" | "all" = "all") {
  return portalCall(`${portalWebsiteBase(tenant, clientId)}/publish-requests?status=${status}`, userId, parsePortalRequests);
}

export async function listPortalMedia(userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string, limit = 48): Promise<WdResult<MediaListBody>> {
  const r = await mediaCall(`${portalSiteBase(tenant, clientId, tenantSlug, siteId)}/media?limit=${limit}`, userId, parseMediaList);
  return r as WdResult<MediaListBody>;
}

// ── Composites ───────────────────────────────────────────────────────────────────────────────────────

/** The site + its collections (with each `clientEditable`), as the staff `SiteContext` shapes them, so the shared editor takes them as is.
 *  A client has no environments to show, so `site.environments` is `[]`. */
export interface PortalSiteContext {
  tenant: TenantRef;
  site: SiteRef;
  siteInfo: PortalSite;
  collections: PortalCollection[];
}

export async function loadPortalSiteContext(userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string): Promise<WdResult<PortalSiteContext>> {
  const [sites, collections] = await Promise.all([
    listPortalSites(userId, tenant, clientId),
    listPortalCollections(userId, tenant, clientId, tenantSlug, siteId),
  ]);
  if (sites.kind !== "ok") return sites;
  const siteInfo = sites.data.sites.find((s) => s.tenantSlug === tenantSlug && s.siteId === siteId);
  // A site that is not one of THIS client's linked sites is the same answer the BFF gives: not found, with no hint it exists.
  if (!siteInfo) return { kind: "not_found", slug: "site-not-found" };
  if (collections.kind !== "ok") return collections;
  const site: SiteRef = { siteId: siteInfo.siteId, name: siteInfo.name, kind: siteInfo.kind, environments: [] };
  return {
    kind: "ok",
    data: {
      tenant: { slug: siteInfo.tenantSlug, status: "active", defaultLocale: siteInfo.defaultLocale, locales: siteInfo.locales, sites: [site] },
      site, siteInfo, collections: collections.data,
    },
  };
}

const SLUG_SCAN_MAX_PAGES = 20;

/** A slug (+ locale) to its item. The BFF's list takes `slug`; the match is re-checked here, and the walk continues while there are
 *  more pages, so a backend that ignores the filter still resolves (capped). A deleted item is never listed: it is `item-not-found`. */
export async function resolvePortalItemBySlug(
  userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string, collectionKey: string, slug: string, locale: string,
): Promise<WdResult<ItemListBody["items"][number]>> {
  let cursor: string | undefined;
  for (let i = 0; i < SLUG_SCAN_MAX_PAGES; i++) {
    const r = await listPortalItems(userId, tenant, clientId, tenantSlug, siteId, collectionKey, { locale, slug, cursor, limit: 100 });
    if (r.kind !== "ok") return r;
    const hit = r.data.items.find((it) => it.slug === slug && it.locale === locale);
    if (hit) return { kind: "ok", data: hit };
    if (!r.data.page.hasMore || !r.data.page.cursor) break;
    cursor = r.data.page.cursor;
  }
  return { kind: "not_found", slug: "item-not-found" };
}

/** What the editor page needs: the staff `EditorBundle` (so the shared ItemEditor takes it unchanged) plus the client's verdict. */
export interface PortalEditorBundle extends EditorBundle {
  clientEditable: ClientEditable;
  /** The BFF's author labels for this item's reads (WSK-359). */
  authors: PortalAuthors;
  /** This client's PENDING publish requests that name this item. `null` + `requestsProblem` when the lookup failed. */
  requests: PortalPublishRequest[] | null;
  requestsProblem: string | null;
}

export async function loadPortalEditorBundle(
  userId: string, tenant: string, clientId: string, tenantSlug: string, siteId: string, collectionKey: string, slug: string, requestedLocale: string | null,
): Promise<WdResult<PortalEditorBundle>> {
  const ctx = await loadPortalSiteContext(userId, tenant, clientId, tenantSlug, siteId);
  if (ctx.kind !== "ok") return ctx;
  const collection = ctx.data.collections.find((c) => c.key === collectionKey);
  if (!collection) return { kind: "not_found", slug: "collection-not-found" };
  const { tenant: t, site } = ctx.data;

  const locale = collection.composition.localized === false ? t.defaultLocale : (requestedLocale ?? t.defaultLocale);
  const summary = await resolvePortalItemBySlug(userId, tenant, clientId, tenantSlug, siteId, collectionKey, slug, locale);
  if (summary.kind !== "ok") return summary;
  const detail = await getPortalItem(userId, tenant, clientId, tenantSlug, siteId, summary.data.itemId, "head");
  if (detail.kind !== "ok") return detail;

  const [authoritative, requests] = await Promise.all([
    (async (): Promise<{ value: EditorBundle["authoritative"]; problem: string | null }> => {
      const defs = collection.composition.fields ?? [];
      if (locale === t.defaultLocale || !defs.some(hasNeutralDescendant)) return { value: null, problem: null };
      const twin = detail.data.group.find((g) => g.locale === t.defaultLocale);
      if (!twin) return { value: null, problem: `There is no ${t.defaultLocale} version yet, so shared fields show this page's own copy.` };
      const r = await getPortalItem(userId, tenant, clientId, tenantSlug, siteId, twin.itemId, "head");
      if (r.kind !== "ok") return { value: null, problem: `The ${t.defaultLocale} version could not be read, so shared fields show this page's own copy.` };
      return { value: { locale: t.defaultLocale, fields: splitVersionContent(collectionKey, r.data.version.blocks, r.data.version.seo).fields }, problem: null };
    })(),
    listPortalRequests(userId, tenant, clientId, "pending"),
  ]);

  const itemId = detail.data.item.itemId;
  const mine = requests.kind === "ok" ? requests.data.filter((q) => q.itemIds.includes(itemId)) : null;
  return {
    kind: "ok",
    data: {
      tenant: t, site, collection, detail: detail.data,
      authoritative: authoritative.value, authoritativeProblem: authoritative.problem,
      // The staff bar's pending list carries the requested VERSION; the client list does not (§16j), so it stays empty here and the
      // client panel reads `requests` instead.
      pendingRequests: [], pendingProblem: null,
      build: null, buildProblem: null,
      loadedAt: new Date().toISOString(),
      // The item read's own verdict wins over the collection's: it is the one computed for THIS item's composition.
      clientEditable: detail.data.clientEditable,
      authors: detail.data.authors,
      requests: mine,
      requestsProblem: requests.kind === "ok" ? null : "unavailable",
    },
  };
}

// ── The page guard ───────────────────────────────────────────────────────────────────────────────────

export interface WebsiteAccess {
  userId: string;
  me: Me;
  tenant: string;
  clientId: string;
  clientName: string;
  /** Every client of this company the viewer may edit the website of (the switcher's options). */
  clients: { id: string; name: string }[];
}

/**
 * Who is this, which company's portal, and which client's website: or `null` = no access (the page shows the plain
 * "You don't have website editing access" page, never a confident empty list). Redirects to /login with no session.
 *
 * Resolved through the portal's OWN helpers (never the staff company resolver): the active company is `getActivePortalCompany`,
 * the clients are that company's (`overview.clients`), and the viewer must hold `client_website_editor` for one of them. The
 * remembered client is the same cookie the Business tab uses.
 */
export async function resolveWebsiteAccess(): Promise<WebsiteAccess | WebsiteAccessRefusal> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  const holdsGrant = me.roles.some((g) => g.role === WEBSITE_EDITOR_ROLE && g.scopeType === "client");
  if (!tenant) return { refused: "denied" };
  let overview: Awaited<ReturnType<typeof getPortalOverview>>["overview"] = null;
  try {
    overview = (await getPortalOverview(userId, tenant)).overview;
  } catch {
    // The portal's client list could not be read. A viewer who holds a website-editor grant must NOT be told they have no access
    // because of an outage: that is "unavailable". Anyone else has no access whatever the outage.
    return { refused: holdsGrant ? "unavailable" : "denied" };
  }
  const scope = overview?.clients ?? [];
  const granted = websiteEditorClients(me.roles, scope.map((c) => c.id));
  const jar = await cookies();
  const clientId = pickWebsiteClient(granted, readHostCookie(jar, HOST_COOKIES.portalClient));
  if (!clientId) return { refused: "denied" };
  const clients = granted.map((id) => ({ id, name: scope.find((c) => c.id === id)?.name ?? "Your company" }));
  return { userId, me, tenant, clientId, clientName: clients.find((c) => c.id === clientId)?.name ?? "Your company", clients };
}

/** `resolveWebsiteAccess` found no usable client: `denied` (no grant, no client account here: the plain no-access page) or
 *  `unavailable` (the viewer holds a grant but the portal's client list could not be read: an outage, said as one). */
export interface WebsiteAccessRefusal { refused: "denied" | "unavailable" }

export const websiteAccessOk = (a: WebsiteAccess | WebsiteAccessRefusal): a is WebsiteAccess => !("refused" in a);

/** Names the viewer can be shown for version authors. The portal cannot read the company directory, so the labels are the BFF's own
 *  (`fromBff`, WSK-359: a same-client contact's name, "Gaiada" for staff, an automation account's name, else "Someone else"), then the
 *  requesters of the client's publish requests, then the viewer ("<name> (you)"), which always wins. An id nobody labelled reads as a short
 *  id, which is `authorLabel`'s own fallback. */
export function portalAuthorNames(me: Pick<Me, "userId" | "name">, requests: readonly PortalPublishRequest[] = [], fromBff: PortalAuthors = {}): Record<string, string> {
  const out: Record<string, string> = { ...fromBff };
  for (const r of requests) if (r.requestedBy.userId && r.requestedBy.name) out[r.requestedBy.userId] = r.requestedBy.name;
  out[me.userId] = `${me.name || "You"} (you)`;
  return out;
}

// ── Request views (the Website page's "Publish requests") ────────────────────────────────────────────

const REQUEST_ITEMS_SHOWN = 6;

/**
 * Each request with its pages named, at the version the request NAMED (§16j's `items:[{itemId, version}]`, WSK-359): the title is read
 * from the item AT that version, so the card says "v<N> of <title>" and never shows the item's current draft as if it were the requested
 * one. A row whose stored request carries no version for an item reads the head for its title and shows NO version. A page that cannot be
 * read is "no longer available" (never dropped: the count on the card stays true). Capped per request; the card says "and N more".
 */
export async function buildRequestViews(
  userId: string, tenant: string, clientId: string, rows: readonly PortalPublishRequest[], sites: readonly PortalSite[],
): Promise<RequestView[]> {
  const siteName = (r: PortalPublishRequest) => sites.find((s) => s.tenantSlug === r.tenantSlug && s.siteId === r.siteId)?.name ?? null;
  return Promise.all(rows.map(async (r): Promise<RequestView> => {
    const ids = r.itemIds.slice(0, REQUEST_ITEMS_SHOWN);
    const items = await Promise.all(ids.map(async (itemId): Promise<RequestItemView> => {
      const version = r.items.find((i) => i.itemId === itemId)?.version ?? null;
      if (!r.tenantSlug || !r.siteId) return { itemId, title: itemId, version, available: false };
      const d = await getPortalItem(userId, tenant, clientId, r.tenantSlug, r.siteId, itemId, version ?? "head");
      if (d.kind !== "ok") return { itemId, title: itemId, version, available: false };
      const fields = splitVersionContent(d.data.item.collectionKey, d.data.version.blocks, d.data.version.seo).fields;
      return { itemId, title: itemTitle(fields, d.data.version.seo, d.data.composition.ui?.titleField, d.data.item.slug), version, available: true };
    }));
    return { ...r, siteName: siteName(r), items };
  }));
}
