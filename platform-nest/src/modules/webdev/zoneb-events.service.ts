// WSK-12 — the dedup insert. `ux_wzel_tenant_event UNIQUE (tenant_id, event_id)`
// (202608261440_webdev_zoneb_event_log.sql) IS the idempotency mechanism; `ON CONFLICT DO NOTHING`
// is the one INSERT statement this whole ticket's Zone A consumer exists to make safe to call
// twice — every webhook fires twice doctrine (root CLAUDE.md), applied literally.
//
// Plain exported functions, not an `@Injectable()` service class — matching the sibling
// `provisioning.service.ts`'s own shape in this same module directory (its controller imports
// `provisionSite`/`listProvisionedSites`/etc. directly, no DI). Keeping the same shape here means
// `zoneb-events.controller.ts` only needs a `controllers` array addition to `app.module.ts`, not a
// SECOND `providers` array edit for a service class nothing else in this module directory uses.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import type { ZoneBEventInput } from "./zoneb-event-schema";

/** Every access to `webdev_zoneb_event_log` declares `{modules:['webdev']}` — the table carries
 *  the THIRD WALL (migration header); a plain `withTenants()` call would read/write ZERO ROWS
 *  silently, the exact WD-23A-1 regression class this helper exists to make impossible to forget. */
function withWebdev<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["webdev"] });
}

export type RecordEventOutcome = { inserted: true; id: string } | { inserted: false; id: string };

/** Idempotent by construction: a second call with the SAME (tenantId, eventId) returns
 *  `inserted: false` against the EXISTING row's id — never a duplicate row, never a thrown
 *  unique-violation the caller would have to catch. */
export async function recordZoneBEvent(tenantId: string, event: ZoneBEventInput): Promise<RecordEventOutcome> {
  return withWebdev(tenantId, async (c) => {
    const insertResult = await c.query<{ id: string }>(
      `INSERT INTO webdev_zoneb_event_log (tenant_id, event_id, kind, payload, origin_site)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, event_id) DO NOTHING
       RETURNING id`,
      [tenantId, event.eventId, event.kind, JSON.stringify(event.data), event.originSite],
    );
    if (insertResult.rowCount && insertResult.rowCount > 0) {
      return { inserted: true, id: insertResult.rows[0].id };
    }
    // Conflict — the row already exists. Re-read it so the caller (and its HTTP response) can
    // report the SAME id a client that retried would see, rather than a bodiless 200.
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM webdev_zoneb_event_log WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, event.eventId],
    );
    return { inserted: false, id: existing.rows[0].id };
  });
}

/** Read path for a future console (WSK-24, not built yet) and for this ticket's own tests to
 *  assert exactly one row landed per event id, under the same third wall as the write. */
export async function listRecentZoneBEvents(
  tenantId: string,
  limit = 50,
): Promise<Array<{ id: string; eventId: string; kind: string; receivedAt: string }>> {
  return withWebdev(tenantId, async (c) => {
    const r = await c.query<{ id: string; event_id: string; kind: string; received_at: string }>(
      `SELECT id, event_id, kind, received_at FROM webdev_zoneb_event_log
        WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return r.rows.map((row) => ({ id: row.id, eventId: row.event_id, kind: row.kind, receivedAt: row.received_at }));
  });
}
