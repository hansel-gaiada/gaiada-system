// WSK-61 — the producer half of the `schedule.fired` Zone B event (the rebuild hint). Pure: no I/O.
//
// The content tick records every transition that COMMITTED as a FiredTransition; after a tenant's
// steps finish, groupFired() folds them into the events the ERP consumer expects:
//   one event per (siteId, mapped transition, approvalId-or-null), at most MAX_ITEMS_PER_EVENT items each
//   (a larger group is chunked in itemId order, so the chunks are deterministic).
// The eventId is a SHA-256 over the event's content, so a retry or redelivery of the same firing dedups
// at the ERP (UNIQUE (tenant_id, event_id)) while a later, different firing of the same item does not.
import { createHash } from "node:crypto";
import type { ScheduleFiredData, ScheduleFiredItem } from "../events/zoneb-event.types";

export const MAX_ITEMS_PER_EVENT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FiredTransition {
  siteId: string;
  /** The tick's step: a due publish, a due swap, or a due takedown. */
  kind: "publish" | "swap" | "takedown";
  itemId: string;
  version: number | null;
  /** publish_at (publish, swap) or unpublish_at (takedown), as the driver returned it. */
  effectiveAt: Date | string;
  /** A swap's original approval id (content_schedules.ws4_approval_id); null for the other kinds. */
  approvalId: string | null;
}

export interface ScheduleFiredEvent {
  eventId: string;
  data: ScheduleFiredData;
}

/** content_schedules.ws4_approval_id is free text; the contract wants a uuid or null. Anything else is sent as null. */
export function contractApprovalId(raw: string | null): string | null {
  return raw !== null && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** sha256("schedule.fired|" + tenantSlug + "|" + siteId + "|" + transition + "|" + (approvalId ?? "-") + "|" + sorted "itemId:version:effectiveAt" joined by ","), lowercase hex. */
export function scheduleFiredEventId(data: ScheduleFiredData): string {
  const items = data.items
    .map((i) => `${i.itemId}:${i.version ?? "-"}:${i.effectiveAt}`)
    .sort()
    .join(",");
  return createHash("sha256")
    .update(`schedule.fired|${data.tenantSlug}|${data.siteId}|${data.transition}|${data.approvalId ?? "-"}|${items}`)
    .digest("hex");
}

export function groupFired(tenantSlug: string, fired: readonly FiredTransition[]): ScheduleFiredEvent[] {
  interface Group {
    siteId: string;
    transition: "publish" | "unpublish";
    approvalId: string | null;
    items: ScheduleFiredItem[];
  }
  const groups = new Map<string, Group>();
  for (const f of fired) {
    const transition = f.kind === "takedown" ? "unpublish" : "publish";
    const approvalId = f.kind === "swap" ? contractApprovalId(f.approvalId) : null;
    const key = JSON.stringify([f.siteId, transition, approvalId]);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { siteId: f.siteId, transition, approvalId, items: [] }));
    g.items.push({ itemId: f.itemId, version: f.version, effectiveAt: new Date(f.effectiveAt).toISOString() });
  }

  const events: ScheduleFiredEvent[] = [];
  const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, g] of ordered) {
    const items = [...g.items].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
    for (let i = 0; i < items.length; i += MAX_ITEMS_PER_EVENT) {
      const data: ScheduleFiredData = {
        tenantSlug,
        siteId: g.siteId,
        transition: g.transition,
        approvalId: g.approvalId,
        items: items.slice(i, i + MAX_ITEMS_PER_EVENT),
      };
      events.push({ eventId: scheduleFiredEventId(data), data });
    }
  }
  return events;
}
