// OutboxService (WS1 event-backbone spec §3): explicit emit(), same transaction as the
// caller's business write. This is the ONLY write path into outbox_events — no triggers.
import type { PoolClient } from "pg";
import { newId } from "../db";
import { config } from "../config";
import { getClock } from "./hlc";

export async function emitEvent(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  entityId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = newId();
  // HLC is stamped here — the ONLY outbox write path — so every event carries the clock the
  // sync engine orders by (sync-engine-revision §2, D3 #2). See ./hlc.
  const hlc = getClock().next();
  await client.query(
    `INSERT INTO outbox_events (id, tenant_id, entity_type, entity_id, event_type, payload, origin_site, hlc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, tenantId, entityType, entityId, eventType, JSON.stringify(payload), config.originSite, hlc],
  );
  return id;
}
