// M5-W8 — the writer dashboard's BFF read (docs/plans/2026-10-11-m5-writers-room-design.md §5 W8; FRONTEND-BFF-CONTRACT §27 "Writers' room
// dashboard"). `GET …/content/sites/:tenantSlug/:siteId/writers/dashboard`: per published article the caller may read, the page it is
// served at and its figures from Umami (A4), Search Console (SM-25b), web leads (L4) and decay findings (V4), as COUNTS only.
//
// THE ORDER (the two-phase gate of webdesk-content.service.ts, unchanged):
//   1. the controller's first statement: `authorizeSite(…)`  (phase 1, `webdesk_collection:read` on the route's site);
//   2. here: the cross-company wall, then the REAL question for what the dashboard lists: Cerbos `read` + `assign` on each
//      (collection, locale) pair that has published items (one question per pair, asked in groups of at most 50, the batch
//      limit), or one company-level `read` for a staff tier. A caller that may read none of the site's collections is 403,
//      never an empty dashboard;
//   3. only then the query is validated (an unknown parameter is a 400 for a caller that was let in).
//
// WHOSE ARTICLES: a row is listed when the pair is readable AND (the caller is a staff tier, OR holds `assign` on the pair (the
// editor tier), OR wrote the item). So a writer sees their own work, an editor or staff member everything in scope. `?mine=true`
// narrows any caller to their own. Authorship is WebDesk's `editorial.authorSub`, never the request.
//
// FAIL-HONEST: WebDesk failing is the whole read's 503 (the typed answer of `zoneB.read`); Cerbos failing is a 503 too. Any other
// upstream (Umami, search tables, leads, decay) failing makes ITS figures null with a reason: never 0, never a dropped row.
import { HttpException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { authorize } from "../../core/http";
import { checkActions, type Resource } from "../../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
import {
  ItemGate, WebdeskProblem, invalidRequest, isPlainObject, probeAllowed, strictQuery, webdeskZoneB,
  type ContentGate, type EditableSite, type SiteRef, type WebdeskZoneB,
} from "./webdesk-content.service";
import {
  CERBOS_CHUNK, DASHBOARD_PERIODS, DEFAULT_LIMIT, DEFAULT_PERIOD, MAX_LIMIT, assembleItems, chunked, dashboardWindows, decodeCursor, encodeCursor,
  isLocalized, isPeriod, pathKey, resolvePagePath, routePatternOf, sourceFail,
  type DashboardItem, type DashboardPeriod, type DashboardQuery, type DashboardWindows, type PageItem, type Reason, type Sourced,
} from "./webdesk-writers-dashboard";
import { DbDashboardSources, type DashboardSources } from "./webdesk-writers-dashboard-sources";

const logger = new Logger("WebdeskWritersDashboard");

/** Most WebDesk pages one request reads while every row of them is filtered out (so a page is never blank for no reason). */
export const MAX_SCAN_STEPS = 5;
const ASSIGN = "assign";
const READ = "read";

// ── what the service needs from WebDesk and from Cerbos (narrow, so a test can stand them in) ─────

export interface WdCollection { key: string; composition: unknown; liveItems: number | null; locales: string[] }
export interface WdItemRow {
  itemId: string; slug: string; locale: string; title: string | null; publishedVersion: number | null; authorSub: string | null; deleted: boolean;
}
export interface WdItemPage { items: WdItemRow[]; hasMore: boolean; cursor: string | null }

export interface DashboardWebdesk {
  collections(site: SiteRef): Promise<WdCollection[]>;
  liveItems(site: SiteRef, collectionKey: string, q: { locale: string | null; cursor: string | null; limit: number }): Promise<WdItemPage>;
}

export interface Pair { collectionKey: string; locale: string }
export interface PairVerdict { read: boolean; assign: boolean }
export const pairKey = (p: Pair): string => `${p.collectionKey}\u0000${p.locale}`;

export interface DashboardAuthz {
  /** Does the caller hold a company-level `read` on the site's items (a staff tier)? On true the real, audited check has been made. */
  siteWide(gate: ContentGate, siteId: string): Promise<boolean>;
  /** `read` and `assign` for each pair, asked in groups of at most CERBOS_CHUNK. */
  pairs(gate: ContentGate, siteId: string, pairs: readonly Pair[]): Promise<Map<string, PairVerdict>>;
  /** The ordinary denial, with its audit row (throws). */
  deny(gate: ContentGate, siteId: string, pair: Pair): Promise<never>;
}

// ── WebDesk, over the control channel ────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function drift(what: string): never {
  throw new HttpException({ message: "webdesk_error", reason: what }, 502);
}

export function zoneBWebdesk(zoneB: WebdeskZoneB = webdeskZoneB): DashboardWebdesk {
  return {
    async collections(site) {
      const r = await zoneB.read({
        command: "collection.list",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections",
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
      });
      if (!isPlainObject(r.body) || !Array.isArray(r.body.collections)) return drift("collection_list_shape");
      const out: WdCollection[] = [];
      for (const c of r.body.collections) {
        if (!isPlainObject(c) || typeof c.key !== "string") return drift("collection_shape");
        const counts = isPlainObject(c.counts) ? c.counts : {};
        const byLocale = isPlainObject(counts.byLocale) ? Object.keys(counts.byLocale) : [];
        out.push({ key: c.key, composition: c.composition, liveItems: num(counts.live), locales: byLocale });
      }
      return out;
    },
    async liveItems(site, collectionKey, q) {
      const query: Record<string, string> = { state: "live", limit: String(q.limit) };
      if (q.locale) query.locale = q.locale;
      if (q.cursor) query.cursor = q.cursor;
      const r = await zoneB.read({
        command: "item.list",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key/items",
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId, key: collectionKey },
        query,
      });
      if (!isPlainObject(r.body) || !Array.isArray(r.body.items)) return drift("item_list_shape");
      const items: WdItemRow[] = [];
      for (const it of r.body.items) {
        if (!isPlainObject(it) || typeof it.itemId !== "string" || typeof it.slug !== "string" || typeof it.locale !== "string") return drift("item_shape");
        const ed = isPlainObject(it.editorial) ? it.editorial : null;
        items.push({
          itemId: it.itemId, slug: it.slug, locale: it.locale, title: strOrNull(it.title), publishedVersion: num(it.publishedVersion),
          authorSub: ed ? strOrNull(ed.authorSub) : null, deleted: typeof it.deletedAt === "string",
        });
      }
      const page = isPlainObject(r.body.page) ? r.body.page : {};
      return { items, hasMore: page.hasMore === true, cursor: strOrNull(page.cursor) };
    },
  };
}

// ── Cerbos ───────────────────────────────────────────────────────────────────────────────────────

export type PairChecker = (principal: Principal, resource: Resource, actions: readonly string[]) => Promise<Record<string, boolean>>;

/** `read` and `assign` on one resource for the caller and, on a delegated call, for the human it acts for (both must allow). */
export async function pairVerdict(principal: Principal, resource: Resource, check: PairChecker = checkActions): Promise<PairVerdict> {
  const mine = await check(principal, resource, [READ, ASSIGN]);
  let v: PairVerdict = { read: mine[READ] === true, assign: mine[ASSIGN] === true };
  if (principal.actFor && principal.actFor.userId !== principal.userId && (v.read || v.assign)) {
    const human = await assemblePrincipal(principal.actFor.userId, principal.assurance);
    if (!human) return { read: false, assign: false };
    const theirs = await check({ ...human, via: principal.via }, resource, [READ, ASSIGN]);
    v = { read: v.read && theirs[READ] === true, assign: v.assign && theirs[ASSIGN] === true };
  }
  return v;
}

/** The pair checks, in groups of at most `chunk` in flight at once. Exported for the chunking test. */
export async function pairVerdicts(
  principal: Principal, resourceOf: (p: Pair) => Resource, pairs: readonly Pair[], check: PairChecker = checkActions, chunk: number = CERBOS_CHUNK,
): Promise<Map<string, PairVerdict>> {
  const out = new Map<string, PairVerdict>();
  for (const group of chunked(pairs, chunk)) {
    const got = await Promise.all(group.map(async (p) => [pairKey(p), await pairVerdict(principal, resourceOf(p), check)] as const));
    for (const [k, v] of got) out.set(k, v);
  }
  return out;
}

export function cerbosAuthz(check: PairChecker = checkActions): DashboardAuthz {
  const resourceOf = (gate: ContentGate, siteId: string) => (p: Pair): Resource => ItemGate.resourceOf(gate, siteId, null, { collectionKey: p.collectionKey, locale: p.locale });
  return {
    async siteWide(gate, siteId) {
      const res: Resource = { kind: "webdesk_content_item", tenantId: gate.tenantId, module: "webdev", siteId };
      if (!(await probeAllowed(gate.principal, res, READ))) return false;
      await authorize(gate.principal, res, READ); // the real, audited check (session, delegation) once the answer is yes
      return true;
    },
    pairs: (gate, siteId, pairs) => pairVerdicts(gate.principal, resourceOf(gate, siteId), pairs, check),
    async deny(gate, siteId, pair) {
      await authorize(gate.principal, resourceOf(gate, siteId)(pair), READ);
      throw new ServiceUnavailableException({ message: "authorization_inconsistent" }); // authorize() allowed what the probe denied
    },
  };
}

// ── the response ─────────────────────────────────────────────────────────────────────────────────

export type SourceStatus = { state: "ok" } | { state: "unavailable"; reason: Reason } | { state: "not_asked" };

export interface DashboardResponse {
  tenantSlug: string;
  siteId: string;
  period: { key: DashboardPeriod; days: number };
  windows: DashboardWindows;
  /** "all_site": the caller's read is company-level (a staff tier). "scoped": it reaches only some collections and languages. */
  scope: "all_site" | "scoped";
  /** The state of each upstream for THIS page, for one banner; every figure also carries its own reason. */
  sources: { umami: SourceStatus; search: SourceStatus; leads: SourceStatus; decay: SourceStatus };
  items: DashboardItem[];
  page: { cursor: string | null; hasMore: boolean; limit: number };
}

const statusOf = (r: { ok: true } | { ok: false; reason: Reason }): SourceStatus => (r.ok ? { state: "ok" } : { state: "unavailable", reason: r.reason });
const NO_SOURCES: Sourced = { umami: sourceFail("no_route_pattern"), gsc: sourceFail("no_route_pattern"), leads: sourceFail("no_route_pattern"), decay: sourceFail("no_route_pattern") };
const NOT_ASKED: DashboardResponse["sources"] = { umami: { state: "not_asked" }, search: { state: "not_asked" }, leads: { state: "not_asked" }, decay: { state: "not_asked" } };

/** The environments' domains, production first; an environment with no hostname yet is skipped. */
export function domainsOf(environments: unknown): string[] {
  const envs = (Array.isArray(environments) ? environments : []).filter(
    (e): e is Record<string, unknown> & { domain: string } => isPlainObject(e) && typeof e.domain === "string" && e.domain.trim() !== "",
  );
  const prod = (e: Record<string, unknown>) => String(e.name ?? "").toLowerCase() === "production";
  return [...envs.filter(prod), ...envs.filter((e) => !prod(e))].map((e) => e.domain);
}

export function parseQuery(raw: unknown): DashboardQuery {
  const q = strictQuery(raw, ["period", "collection", "locale", "mine", "cursor", "limit"]);
  const period = q.period ?? DEFAULT_PERIOD;
  if (!isPeriod(period)) throw invalidRequest(`period must be one of ${Object.keys(DASHBOARD_PERIODS).join(", ")}`);
  const text = (k: "collection" | "locale", max: number): string | null => {
    if (q[k] === undefined) return null;
    if (q[k] === "" || q[k].length > max) throw invalidRequest(`${k} must be a non-empty string of at most ${max} characters`);
    return q[k];
  };
  let mine = false;
  if (q.mine !== undefined) {
    if (q.mine !== "true" && q.mine !== "false") throw invalidRequest("mine must be true or false");
    mine = q.mine === "true";
  }
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!/^\d+$/.test(q.limit) || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw invalidRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    limit = n;
  }
  let cursor: DashboardQuery["cursor"] = null;
  if (q.cursor !== undefined) {
    cursor = decodeCursor(q.cursor);
    if (!cursor) throw invalidRequest("cursor is not one this dashboard issued");
  }
  return { period, collection: text("collection", 100), locale: text("locale", 35), mine, limit, cursor };
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────

export interface DashboardDeps {
  zoneB?: WebdeskZoneB;
  webdesk?: DashboardWebdesk;
  authz?: DashboardAuthz;
  sources?: DashboardSources;
}

/** Cerbos or a pair check failing is the dashboard's 503: "cannot tell what you may see" is never an empty list. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpException) throw err;
    logger.warn(`authorization unavailable: ${(err as Error)?.message ?? "error"}`);
    throw new ServiceUnavailableException({ message: "authorization_unavailable" });
  }
}

export class WebdeskWritersDashboardService {
  private readonly zoneB: WebdeskZoneB;
  private readonly webdesk: DashboardWebdesk;
  private readonly authz: DashboardAuthz;
  private sources: DashboardSources;

  constructor(deps: DashboardDeps = {}) {
    this.zoneB = deps.zoneB ?? webdeskZoneB;
    this.webdesk = deps.webdesk ?? zoneBWebdesk(this.zoneB);
    this.authz = deps.authz ?? cerbosAuthz();
    this.sources = deps.sources ?? new DbDashboardSources();
  }

  /** Tests only: replace the data sources (the HTTP test points Umami at a fake). */
  setSourcesForTests(s: DashboardSources | null): void {
    this.sources = s ?? new DbDashboardSources();
  }

  async read(gate: ContentGate, site: SiteRef, rawQuery: unknown, now: Date = new Date()): Promise<DashboardResponse> {
    gate.require("webdesk_content_item", "read");
    const editable: EditableSite = await gate.resolveSite(this.zoneB, site);
    const siteId = editable.site.siteId;

    // PHASE 2 — what the dashboard lists is decided by Cerbos before the query is looked at.
    const collections = await this.webdesk.collections(site);
    const withItems = collections.filter((c) => c.liveItems === null || c.liveItems > 0).sort((a, b) => a.key.localeCompare(b.key));
    const defaultLocale = editable.tenant.defaultLocale;
    const pairsOf = (c: WdCollection): Pair[] => (c.locales.length > 0 ? c.locales : [defaultLocale]).map((locale) => ({ collectionKey: c.key, locale }));
    const allPairs = withItems.flatMap(pairsOf);

    const siteWide = await guarded(() => this.authz.siteWide(gate, siteId));
    const verdicts = siteWide ? new Map<string, PairVerdict>() : await guarded(() => this.authz.pairs(gate, siteId, allPairs));
    const canRead = (p: Pair): boolean => siteWide || verdicts.get(pairKey(p))?.read === true;
    if (!siteWide && allPairs.length > 0 && !allPairs.some(canRead)) await guarded(() => this.authz.deny(gate, siteId, allPairs[0]));

    // Only now the query.
    const q = parseQuery(rawQuery);
    if (q.collection !== null && !collections.some((c) => c.key === q.collection)) {
      throw new WebdeskProblem(404, {
        type: "https://webdesk.gaiada.online/errors/collection-not-found", title: "Collection not found", status: 404, detail: "No such collection on this site.",
      });
    }
    const days = DASHBOARD_PERIODS[q.period];
    const windows = dashboardWindows(now, days);
    const callerId = gate.principal.userId ?? null;

    const scan = withItems.filter((c) => (q.collection === null || c.key === q.collection) && pairsOf(c).some((p) => canRead(p) && (q.locale === null || p.locale === q.locale)));
    let ci = 0;
    let wcursor: string | null = null;
    if (q.cursor) {
      ci = scan.findIndex((c) => c.key === q.cursor!.collection);
      if (ci < 0) throw invalidRequest("cursor is not one this dashboard issued");
      wcursor = q.cursor.webdesk;
    }

    const rows: Array<{ it: WdItemRow; collectionKey: string }> = [];
    for (let steps = 0; ci < scan.length && steps < MAX_SCAN_STEPS && rows.length === 0; steps++) {
      const col = scan[ci];
      const page = await this.webdesk.liveItems(site, col.key, { locale: q.locale, cursor: wcursor, limit: q.limit });
      for (const it of page.items) {
        if (it.deleted || it.publishedVersion === null) continue; // a dashboard of published articles; WebDesk's `state=live` is not trusted alone
        if (q.locale !== null && it.locale !== q.locale) continue;
        const own = callerId !== null && it.authorSub !== null && it.authorSub.toLowerCase() === callerId.toLowerCase();
        const pair = { collectionKey: col.key, locale: it.locale };
        const may = siteWide || (canRead(pair) && (verdicts.get(pairKey(pair))?.assign === true || own));
        if (may && (!q.mine || own)) rows.push({ it, collectionKey: col.key });
      }
      if (page.hasMore && page.cursor) wcursor = page.cursor;
      else { ci++; wcursor = null; }
    }
    const hasMore = ci < scan.length;
    const cursor = hasMore ? encodeCursor({ collection: scan[ci].key, webdesk: wcursor }) : null;

    const compositionOf = new Map(collections.map((c) => [c.key, c.composition] as const));
    const pageItems: PageItem[] = rows.map(({ it, collectionKey }) => {
      const composition = compositionOf.get(collectionKey);
      return {
        itemId: it.itemId, collectionKey, locale: it.locale, slug: it.slug, title: it.title, publishedVersion: it.publishedVersion as number,
        mine: callerId !== null && it.authorSub !== null && it.authorSub.toLowerCase() === callerId.toLowerCase(),
        path: resolvePagePath({ pattern: routePatternOf(composition), slug: it.slug, locale: it.locale, defaultLocale, localized: isLocalized(composition) }),
      };
    });
    const keys = [...new Set(pageItems.flatMap((i) => ("path" in i.path ? [pathKey(i.path.path)] : [])).filter((k): k is string => k !== null))];

    let sourced: Sourced | null = null;
    if (keys.length > 0) {
      sourced = await this.sources.collect({ tenantId: gate.tenantId, tenantSlug: site.tenantSlug, domains: domainsOf(editable.site.environments), keys, windows, days });
    }
    // With no key to look up, every item already carries its own path reason and no source is consulted.
    const items = assembleItems(pageItems, sourced ?? NO_SOURCES);

    return {
      tenantSlug: site.tenantSlug,
      siteId,
      period: { key: q.period, days },
      windows,
      scope: siteWide ? "all_site" : "scoped",
      sources: sourced ? { umami: statusOf(sourced.umami), search: statusOf(sourced.gsc), leads: statusOf(sourced.leads), decay: statusOf(sourced.decay) } : NOT_ASKED,
      items,
      page: { cursor, hasMore, limit: q.limit },
    };
  }
}

export const webdeskWritersDashboard = new WebdeskWritersDashboardService();
