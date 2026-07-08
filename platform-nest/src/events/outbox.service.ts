// OutboxService (WS1 event-backbone spec §3): explicit emit(), same transaction as the
// caller's business write. This is the ONLY write path into outbox_events — no triggers.
import type { PoolClient } from "pg";
import { newId } from "../db";
import { config } from "../config";

export async function emitEvent(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  entityId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO outbox_events (id, tenant_id, entity_type, entity_id, event_type, payload, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, tenantId, entityType, entityId, eventType, JSON.stringify(payload), config.originSite],
  );
  return id;
}
