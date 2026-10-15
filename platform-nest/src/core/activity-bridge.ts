// DW-4h-1 (docs/FRONTEND-BFF-CONTRACT.md §44.1) — the audit-log bridge: one `activities` row (what `writeActivity` just
// wrote) becomes one `work_activity` row, when the catalogue in `activity-kinds.ts` says it is a person's work.
//
// Called from `writeActivity` (core/http.ts, ~442 call sites) AFTER its own insert, and from the history backfill
// (work-activity-backfill-bridge.ts). Both go through `bridgeActivity`, so live and history produce the same rows.
//
// HOT PATH: `bridgeEntryFor` is a Map lookup on one short string. When nothing matches there is no query, no await,
// nothing. Only a matching pair pays for the ingest (and `time.logged` for one read of its entry's date).
//
// BEST EFFORT, NEVER IN THE WAY: `writeActivity` has already committed the audit row, in its own transaction, and this
// runs outside any caller transaction. A failure is logged as `[ACTIVITY-BRIDGE] <entity>/<verb>: <message>` and swallowed.
// Idempotent through UNIQUE(tenant_id, source, source_ref): `act:<activities.id>`, or `act:<entity>:<entityId>` for
// the kinds that are one row per entity (a re-submitted check-in is still one check-in).
import { withTenants } from "../db";
import { config } from "../config";
import { bridgeEntryFor, bridgeTitle, noonInTz, type BridgeEntry } from "./activity-kinds";
import { ingestWorkActivity, type WorkActivityIngestResult } from "./work-activity-ingest.service";

export interface BridgeSubject {
  tenantId: string;
  /** `activities.id`. */
  activityId: string;
  /** `activities.actor_id`. Null (a job, a scheduler) is never bridged. */
  actorId: string | null;
  verb: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  /** The audit row's own time. The live path omits it (now); the backfill passes the row's `occurred_at` so a re-run is stable. */
  occurredAt?: string;
}

export interface BridgeOutcome {
  kind: string;
  deduped: boolean;
}

/** `occurredAt` for one entry: when the action happened, except the two kinds that belong to a calendar day (§44.2). */
async function occurredAtFor(entry: BridgeEntry, s: BridgeSubject): Promise<string | null | undefined> {
  if (entry.occurredAtFrom === "metadata_date") {
    const d = typeof s.metadata.date === "string" ? s.metadata.date : "";
    return noonInTz(d, config.reportsTz) ?? undefined;
  }
  if (entry.occurredAtFrom === "time_entry_date") {
    if (!s.entityId) return null;
    const r = await withTenants([s.tenantId], (c) =>
      c.query<{ d: string }>(`SELECT to_char(entry_date, 'YYYY-MM-DD') AS d FROM time_entries WHERE id = $1 AND deleted_at IS NULL`, [s.entityId]),
    );
    const d = r.rows[0]?.d;
    // The entry is gone (soft-deleted before a backfill reached it): there is no work to count.
    return d ? noonInTz(d, config.reportsTz) : null;
  }
  return s.occurredAt;
}

/**
 * Bridge one audit row. Resolves to the outcome when a row was written (or already there), `null` when the pair is not
 * catalogued, has no person behind it, or the entry's date is gone. THROWS on an ingest failure: `writeActivity` wraps it in
 * `bridgeActivityBestEffort`; the backfill counts the error and carries on.
 */
export async function bridgeActivity(s: BridgeSubject): Promise<BridgeOutcome | null> {
  if (!s.actorId) return null;
  const entry = bridgeEntryFor(s.entityType, s.verb, s.metadata);
  if (!entry) return null;

  const occurredAt = await occurredAtFor(entry, s);
  if (occurredAt === null) return null;

  const sourceRef = entry.dedupe === "entity" && s.entityId ? `act:${s.entityType}:${s.entityId}` : `act:${s.activityId}`;
  const result: WorkActivityIngestResult = await ingestWorkActivity(s.tenantId, {
    source: entry.source,
    sourceRef,
    actorUserId: s.actorId,
    verb: entry.verb,
    objectKind: entry.objectKind,
    objectRef: s.entityId ?? s.activityId,
    title: bridgeTitle(entry, s.metadata),
    // The kind rides in the payload (BFF §44.1); nothing else: no metadata, so no free text can reach the series.
    payload: { kind: entry.kind },
    // A stable value on every path: a re-ingest of the same sourceRef overwrites occurred_at (the ingest upserts).
    occurredAt: occurredAt ?? s.occurredAt ?? new Date().toISOString(),
  });
  return { kind: entry.kind, deduped: result.deduped };
}

/** The `writeActivity` entry point: never throws, logs the pair and the message only. */
export async function bridgeActivityBestEffort(s: BridgeSubject): Promise<void> {
  try {
    await bridgeActivity(s);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[ACTIVITY-BRIDGE] ${s.entityType}/${s.verb}: ${(err as Error)?.message ?? "error"}`);
  }
}
