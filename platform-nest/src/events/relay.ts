// Polling relay (WS1 event-backbone spec §4): moves outbox_events rows into per-entity_type
// Redis Streams. Crash-safe — an interrupted batch just gets picked up by the next tick,
// since rows are only marked relayed_at after a successful XADD.
//
// RLS note: outbox_events has FORCE RLS (D5), so a plain withGlobal SELECT/UPDATE against it
// would return zero rows (no tenant context set, and the app role does not bypass RLS).
// The relay legitimately needs cross-tenant access (it's infrastructure, not a tenant-scoped
// request), so instead of bypassing RLS it enumerates the authorized-tenant-set explicitly
// and runs the outbox reads/writes through withTenants, matching the D5 discipline used
// everywhere else in this codebase. Only `companies` (a global, non-RLS table) uses withGlobal.
import { withGlobal, withTenants } from "../db";
import { getRedis } from "./redis";

interface UnrelayedRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  origin_site: string;
  schema_version: number;
  created_at: Date;
}

export async function relayBatch(limit = 100): Promise<number> {
  const redis = getRedis();
  const tenantIds = (
    await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`))
  ).rows.map((r) => r.id);
  if (tenantIds.length === 0) return 0;

  const rows = await withTenants(tenantIds, (c) =>
    c.query<UnrelayedRow>(
      `SELECT id, tenant_id, entity_type, entity_id, event_type, payload, origin_site, schema_version, created_at
       FROM outbox_events WHERE relayed_at IS NULL ORDER BY created_at LIMIT $1`,
      [limit],
    ),
  ).then((r) => r.rows);

  for (const row of rows) {
    await redis.xadd(
      `events:${row.entity_type}`,
      "*",
      "outboxId", row.id,
      "tenantId", row.tenant_id,
      "entityId", row.entity_id,
      "eventType", row.event_type,
      "payload", JSON.stringify(row.payload),
      "originSite", row.origin_site,
      "schemaVersion", String(row.schema_version),
      "createdAt", row.created_at.toISOString(),
    );
    await withTenants([row.tenant_id], (c) =>
      c.query(`UPDATE outbox_events SET relayed_at = now() WHERE id = $1`, [row.id]),
    );
  }
  return rows.length;
}

export function startRelayLoop(intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await relayBatch();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("relay tick failed:", (err as Error).message);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
