// M5-P5a — how a WebDesk publish reaches the IndexNow ping, without a single line outside the search module.
//
// THE TRIGGER. An editor's publish is a D14 approval (WSK-66): when it is approved the ERP emits the outbox
// event `automation_approval.decided` (entity type `automation_approval`, a stream main.ts already drains) and
// then EXECUTES the publish in-band. The handler below is registered as a CORE event handler (main.ts calls
// `registerIndexNowEventHandlers()` beside the core approval executor), NOT in `searchModule.eventHandlers`:
// the search module must register NO `automation_approval.decided` handler (search-sem-apply.test.ts and
// probe-consent.test.ts pin it, because the module's other approval path spends a client's ad budget and "no
// handler exists" is a structural guarantee that deciding can never grow a second branch). A core handler is
// not gated by `isModuleEnabled`, so this one checks the tenant has `search` on itself. It acts only on an
// APPROVED `content.publish` approval of origin `webdesk`; every other approval is ignored, and all it can do
// is queue URL submissions for the tenant's own verified, IndexNow-enabled property.
//
// THE EVENT IS A HINT, NOT DATA. It carries the approval id and the stored args (site id, item ids, the approved
// versions) and nothing about the pages. Before pinging, the handler
//   1. waits for the approval to be EXECUTED (reads `automation_approvals.execution_status`: pending / executing
//      throws, so the bus redelivers; executed proceeds; failed / not_applicable ends quietly: nothing went live),
//   2. re-reads every item from WebDesk (item.get) and keeps only those that are LIVE at the approved version,
//   3. reads the collections (collection.list) for each item's `ui.routePattern`, and the tenant's default locale
//      and the site's environment domains (the cross-company wall: tenant.list?companyRef=, as every WebDesk read),
// and hands the result to `notifyContentChange` (indexnow-service.ts), which does the rest (flag, property match,
// URL building, idempotent ledger, send). Idempotency: the version tag is `publish:v<N>:<approval id>`, so a
// redelivered event inserts nothing new and sends nothing.
//
// THE OTHER TWO CALLERS (M5-P5a2). An unpublish and a SCHEDULED publish / takedown do not go through this
// event; they call `notifyWebdeskTransition` below, from the places that make them effective:
//   - webdev/webdesk-content.service.ts: an editor's immediate UNPUBLISH of a live item (fire-and-forget, after
//     the WebDesk write succeeded; the MCP tool `webdesk.content.unpublish` re-drives the same BFF route);
//   - webdev/scheduled-rebuilds.service.ts: a `content.schedule` approval whose publish went live / whose
//     takedown came down (settlePublish / settleUnpublish).
// Both re-read the items from WebDesk first (`want: "live"` for a publish, `want: "down"` for an unpublish), so
// the ping is decided by WebDesk's present state, never by what the caller believed. The version tag carries the
// transition, the version and a caller ref (the schedule's approval id, or `req:<hash of the Idempotency-Key>`),
// so a repeat of the same effect inserts nothing and sends nothing.
//
// WHAT THIS STILL DOES NOT COVER (stated, not hidden): a DELETE never pings. Zone B refuses to delete a live
// item (409 item-is-live), so a delete never takes a page down; the unpublish that precedes it already pinged.
//
// The WebDesk reads reuse the webdev module's own egress seam (`webdeskZoneB`), loaded lazily so the search
// module has no static dependency on webdev (webdev already imports search). No fetch is made here.
import { Logger } from "@nestjs/common";
import { withTenants } from "../../db";
import { registerCoreEventHandler } from "../../events/consumer.service";
import type { OutboxEvent } from "../../events/types";
import { isModuleEnabled } from "../registry";
import { isIndexNowEnabled, type ChangedItem } from "./indexnow";
import { notifyContentChange, type IndexNowDeps, type NotifyResult } from "./indexnow-service";

const logger = new Logger("SearchIndexNowWebdesk");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const MAX_ITEMS = 200;

/** `notLive` counts the refs that were NOT in the wanted state (live for a publish, down for an unpublish) or 404. */
export interface ResolvedChange { domains: string[]; items: ChangedItem[]; notLive: number }
export interface PublishedItemRef { itemId: string; version: number }
/** `live`: keep an item production serves at the ref's version. `down`: keep one production no longer serves. */
export type WantedState = "live" | "down";

/** What the handler needs from WebDesk. The default talks to Zone B; a test passes a fake. */
export interface WebdeskPageResolver {
  resolve(tenantId: string, a: { tenantSlug: string; siteId: string; items: PublishedItemRef[]; want?: WantedState; nowMs?: number }): Promise<ResolvedChange>;
}
export interface HookDeps extends IndexNowDeps {
  resolver?: WebdeskPageResolver;
  /** Tests: the approval's execution status without a DB read. */
  executionStatus?: (tenantId: string, approvalId: string) => Promise<string | null>;
  /** Tests: is the `search` module on for this tenant (default: the registry's own check). */
  moduleEnabled?: (tenantId: string) => Promise<boolean>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The environments' domains, production first (the same rule the writer dashboard uses). */
export function domainsOfEnvironments(environments: unknown): string[] {
  const envs = (Array.isArray(environments) ? environments : []).filter((e): e is Record<string, unknown> & { domain: string } => isObj(e) && typeof e.domain === "string" && e.domain.trim() !== "");
  const prod = (e: Record<string, unknown>) => String(e.name ?? "").toLowerCase() === "production";
  return [...envs.filter(prod), ...envs.filter((e) => !prod(e))].map((e) => e.domain);
}

/** A stored `content.publish` approval's args, or null when they are not that shape (never throws). */
export function parsePublishArgs(raw: unknown): { tenantSlug: string; siteId: string; items: PublishedItemRef[] } | null {
  if (!isObj(raw) || raw.command !== "content.publish") return null;
  return parseTarget(raw);
}

/** The site + item refs shared by every caller (slug, uuid site id, 1..MAX_ITEMS items, integer version >= 1), or null. */
function parseTarget(raw: Record<string, unknown>): { tenantSlug: string; siteId: string; items: PublishedItemRef[] } | null {
  const { tenantSlug, siteId, items } = raw;
  if (typeof tenantSlug !== "string" || !SLUG_RE.test(tenantSlug) || typeof siteId !== "string" || !UUID_RE.test(siteId)) return null;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) return null;
  const out: PublishedItemRef[] = [];
  for (const it of items) {
    if (!isObj(it) || typeof it.itemId !== "string" || !UUID_RE.test(it.itemId) || typeof it.version !== "number" || !Number.isInteger(it.version) || it.version < 1) return null;
    out.push({ itemId: it.itemId, version: it.version });
  }
  return { tenantSlug, siteId, items: out };
}

const ITEM_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId";
const COLLECTIONS_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/collections";

/**
 * The version production serves for a WebDesk item at `nowMs`, or null. Zone B's LIVE rule as `item.get`
 * shows it: deleted -> null; no numeric publishedVersion -> null; unpublishAt <= now -> null; `published` ->
 * its version; `scheduled` with publishAt <= now -> its version; anything else null.
 * KEPT IN STEP BY HAND with `liveVersionOf` in webdev/scheduled-rebuilds.service.ts, because the search module
 * cannot import webdev statically (webdev imports search). A parity test (scheduled-rebuilds.unit.test.ts) pins it.
 */
export function liveVersionNow(item: Record<string, unknown>, nowMs: number): number | null {
  if (item.deletedAt !== null && item.deletedAt !== undefined) return null;
  if (typeof item.publishedVersion !== "number") return null;
  const at = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const publishAt = at(item.publishAt);
  const unpublishAt = at(item.unpublishAt);
  if (unpublishAt !== null && unpublishAt <= nowMs) return null;
  if (item.publishState === "published") return item.publishedVersion;
  if (item.publishState === "scheduled" && publishAt !== null && publishAt <= nowMs) return item.publishedVersion;
  return null;
}

/**
 * One item's decision: the page to ping, or null when the item is not in the wanted state. `live` keeps it iff
 * production serves exactly the ref's version now; `down` keeps it iff production serves nothing of it now.
 * Both need a string slug, locale and collectionKey (a page cannot be named without them). `version` is the
 * ref's in both modes (for `down` it is the version that was live, which names the takedown in the ledger).
 */
export function pageForItem(
  item: Record<string, unknown>,
  ref: PublishedItemRef,
  want: WantedState,
  ctx: { defaultLocale: string; compositions: Map<string, unknown>; nowMs: number },
): ChangedItem | null {
  const liveNow = liveVersionNow(item, ctx.nowMs);
  if (want === "live" ? liveNow !== ref.version : liveNow !== null) return null;
  if (typeof item.slug !== "string" || typeof item.locale !== "string" || typeof item.collectionKey !== "string") return null;
  const comp = ctx.compositions.get(item.collectionKey);
  const ui = isObj(comp) && isObj(comp.ui) ? comp.ui : {};
  return {
    slug: item.slug, locale: item.locale, defaultLocale: ctx.defaultLocale,
    routePattern: ui.routePattern, localized: !(isObj(comp) && comp.localized === false), version: ref.version,
  };
}

/** The default resolver: WebDesk over the webdev module's control-channel seam. */
export function webdeskControlResolver(): WebdeskPageResolver {
  return {
    async resolve(tenantId, a) {
      const { webdeskZoneB } = await import("../webdev/webdesk-content.service");
      const editable = await webdeskZoneB.resolveEditableSite(tenantId, a.tenantSlug, a.siteId); // the cross-company wall
      const cols = await webdeskZoneB.read({ command: "collection.list", path: COLLECTIONS_PATH, params: { tenantSlug: a.tenantSlug, siteId: a.siteId } });
      const compositions = new Map<string, unknown>();
      if (isObj(cols.body) && Array.isArray(cols.body.collections)) {
        for (const c of cols.body.collections) if (isObj(c) && typeof c.key === "string") compositions.set(c.key, c.composition);
      }
      const items: ChangedItem[] = [];
      let notLive = 0;
      const want = a.want ?? "live";
      const nowMs = a.nowMs ?? Date.now();
      for (const ref of a.items) {
        let item: Record<string, unknown> | null = null;
        try {
          const r = await webdeskZoneB.read({ command: "item.get", path: ITEM_PATH, params: { tenantSlug: a.tenantSlug, siteId: a.siteId, itemId: ref.itemId } });
          if (isObj(r.body) && isObj(r.body.item)) item = r.body.item;
        } catch (err) {
          if ((err as { getStatus?: () => number })?.getStatus?.() !== 404) throw err; // WebDesk trouble: retry; a missing item: not live
        }
        const page = item === null ? null : pageForItem(item, ref, want, { defaultLocale: editable.tenant.defaultLocale, compositions, nowMs });
        if (page === null) { notLive++; continue; }
        items.push(page);
      }
      return { domains: domainsOfEnvironments(editable.site.environments), items, notLive };
    },
  };
}

async function readExecutionStatus(tenantId: string, approvalId: string): Promise<string | null> {
  const r = await withTenants([tenantId], (c) => c.query<{ execution_status: string }>(`SELECT execution_status FROM automation_approvals WHERE id = $1`, [approvalId]));
  return r.rows[0]?.execution_status ?? null;
}

export type HookOutcome = "ignored" | "disabled" | "module_off" | "not_executed" | "not_live" | "not_down" | NotifyResult["status"];

export interface WebdeskTransitionArgs {
  tenantSlug: string;
  siteId: string;
  transition: "publish" | "unpublish";
  /** A stable name for the effect (schedule approval id, `req:<hash>`): part of the ledger's idempotency key. */
  ref: string;
  items: PublishedItemRef[];
}

/**
 * Ping IndexNow for a publish or an unpublish that has ALREADY taken effect in WebDesk (the callers: an editor's
 * immediate unpublish, a scheduled publish / takedown settling). Order: flag first (OFF means no DB, no WebDesk
 * read, no byte out), then the args, then the `search` module, then WebDesk's present state (`live` for a
 * publish, `down` for an unpublish), then `notifyContentChange`. MAY THROW on WebDesk read trouble: callers
 * catch (they are best-effort). Logs carry ids and typed outcomes only, never a URL, slug or body.
 */
export async function notifyWebdeskTransition(tenantId: string, a: WebdeskTransitionArgs, deps: HookDeps = {}): Promise<HookOutcome> {
  if (!isIndexNowEnabled(deps.env ?? process.env)) return "disabled";
  const target = isObj(a) && (a.transition === "publish" || a.transition === "unpublish") && typeof a.ref === "string" && a.ref !== "" ? parseTarget(a as unknown as Record<string, unknown>) : null;
  if (!target) return "ignored";
  if (!(await (deps.moduleEnabled ?? ((t: string) => isModuleEnabled(t, "search")))(tenantId))) return "module_off";
  const want: WantedState = a.transition === "publish" ? "live" : "down";
  const resolved = await (deps.resolver ?? webdeskControlResolver()).resolve(tenantId, { ...target, want });
  if (resolved.items.length === 0) {
    logger.log(`${a.transition} ${a.ref}: no item is ${want === "live" ? "live" : "down"} as expected, nothing to ping`);
    return want === "live" ? "not_live" : "not_down";
  }
  const r = await notifyContentChange(tenantId, { domains: resolved.domains, transition: a.transition, ref: a.ref, items: resolved.items }, deps);
  logger.log(`${a.transition} ${a.ref}: ${r.status}${r.engine ? ` via ${r.engine}` : ""}, ${r.urls} url(s), ${r.skipped.length} skipped`);
  return r.status;
}

/**
 * The `automation_approval.decided` handler. Throws (so the bus redelivers) only when the publish has not
 * finished executing or WebDesk could not be read; every other outcome returns, because retrying cannot help.
 * Fail-soft: it NEVER makes an approval's decide request fail, because it runs on the bus, not in the request.
 */
export async function handlePublishApprovalDecided(event: OutboxEvent, deps: HookDeps = {}): Promise<HookOutcome> {
  if (!isIndexNowEnabled(deps.env ?? process.env)) return "disabled";
  const p = event.payload;
  if (p.decision !== "approved" || p.workflowId !== "content.publish" || p.origin !== "webdesk") return "ignored";
  const args = parsePublishArgs(p.toolArgs);
  if (!args) return "ignored";
  if (!(await (deps.moduleEnabled ?? ((t: string) => isModuleEnabled(t, "search")))(event.tenantId))) return "module_off";
  const approvalId = event.entityId;

  const status = await (deps.executionStatus ?? readExecutionStatus)(event.tenantId, approvalId);
  if (status === "pending" || status === "executing") throw new Error("content.publish approval has not finished executing");
  if (status !== "executed") return "not_executed";

  // `want` is left to the resolver's default ("live"): the call's shape is pinned by indexnow-webdesk.test.ts.
  const resolved = await (deps.resolver ?? webdeskControlResolver()).resolve(event.tenantId, args);
  if (resolved.items.length === 0) {
    logger.log(`approval ${approvalId}: no item is live at its approved version, nothing to ping`);
    return "not_live";
  }
  const r = await notifyContentChange(event.tenantId, { domains: resolved.domains, transition: "publish", ref: approvalId, items: resolved.items }, deps);
  logger.log(`approval ${approvalId}: ${r.status}${r.engine ? ` via ${r.engine}` : ""}, ${r.urls} url(s), ${r.skipped.length} skipped`);
  return r.status;
}

/** The core event handler: `automation_approval.decided`. Throws only for "retry me" (see above). */
export async function onApprovalDecided(event: OutboxEvent): Promise<void> {
  if (event.eventType !== "automation_approval.decided") return;
  await handlePublishApprovalDecided(event);
}

/** Called once from main.ts, before the consumer loop starts reading (beside the core approval executor). */
export function registerIndexNowEventHandlers(): void {
  registerCoreEventHandler("automation_approval.decided", onApprovalDecided);
}
