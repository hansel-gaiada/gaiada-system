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
// WHAT THIS DOES NOT COVER (stated, not hidden): an unpublish and a SCHEDULED publish / takedown do not go
// through this event. They reach the same pipeline through the route `POST .../indexnow/notify` (and its MCP
// tool), or an in-process call to `notifyContentChange` from the places that make them effective
// (webdev/zoneb-events.controller.ts for `schedule.fired`, the unpublish BFF). Those edits are outside this
// ticket's owned paths and are listed in the report as follow-ups.
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

export interface ResolvedChange { domains: string[]; items: ChangedItem[]; notLive: number }
export interface PublishedItemRef { itemId: string; version: number }

/** What the handler needs from WebDesk. The default talks to Zone B; a test passes a fake. */
export interface WebdeskPageResolver {
  resolve(tenantId: string, a: { tenantSlug: string; siteId: string; items: PublishedItemRef[] }): Promise<ResolvedChange>;
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
      for (const ref of a.items) {
        let item: Record<string, unknown> | null = null;
        try {
          const r = await webdeskZoneB.read({ command: "item.get", path: ITEM_PATH, params: { tenantSlug: a.tenantSlug, siteId: a.siteId, itemId: ref.itemId } });
          if (isObj(r.body) && isObj(r.body.item)) item = r.body.item;
        } catch (err) {
          if ((err as { getStatus?: () => number })?.getStatus?.() !== 404) throw err; // WebDesk trouble: retry; a missing item: not live
        }
        const live = item !== null && item.deletedAt == null && item.publishState === "published" && item.publishedVersion === ref.version;
        if (!live || item === null || typeof item.slug !== "string" || typeof item.locale !== "string" || typeof item.collectionKey !== "string") { notLive++; continue; }
        const comp = compositions.get(item.collectionKey);
        const ui = isObj(comp) && isObj(comp.ui) ? comp.ui : {};
        items.push({
          slug: item.slug, locale: item.locale, defaultLocale: editable.tenant.defaultLocale,
          routePattern: ui.routePattern, localized: !(isObj(comp) && comp.localized === false), version: ref.version,
        });
      }
      return { domains: domainsOfEnvironments(editable.site.environments), items, notLive };
    },
  };
}

async function readExecutionStatus(tenantId: string, approvalId: string): Promise<string | null> {
  const r = await withTenants([tenantId], (c) => c.query<{ execution_status: string }>(`SELECT execution_status FROM automation_approvals WHERE id = $1`, [approvalId]));
  return r.rows[0]?.execution_status ?? null;
}

export type HookOutcome = "ignored" | "disabled" | "module_off" | "not_executed" | "not_live" | NotifyResult["status"];

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
