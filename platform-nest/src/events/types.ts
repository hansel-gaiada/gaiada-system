export interface OutboxEvent {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
  originSite: string;
  schemaVersion: number;
  createdAt: string;
}
