// DW-4h-2 (BFF §44.6): what the three emitter tests (hr, lms, finance) assert, in one place. Reads through the ADMIN pool,
// so it shows what is REALLY stored (RLS bypassed), and it knows the three catalogue pairs:
//   hr_leave_request / decided   -> work_activity source hr,       payload.kind hr.leave_decided
//   lms_completion   / completed -> work_activity source learning, payload.kind learning.completed
//   finance_journal  / posted    -> work_activity source finance,  payload.kind finance.journals
import { adminPool } from "./setup";

export interface AuditRow {
  id: string;
  actor_id: string | null;
  verb: string;
  target_entity_type: string;
  target_entity_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

export interface BridgedRow {
  source: string;
  source_ref: string;
  actor_user_id: string | null;
  verb: string;
  object_kind: string;
  object_ref: string;
  title: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

/** The `activities` rows for one entity (entity type + id + verb). */
export async function auditRows(tenantId: string, entityType: string, verb: string, entityId: string): Promise<AuditRow[]> {
  const r = await adminPool().query<AuditRow>(
    `SELECT id, actor_id, verb, target_entity_type, target_entity_id, metadata, occurred_at
       FROM activities WHERE tenant_id = $1 AND target_entity_type = $2 AND verb = $3 AND target_entity_id = $4 ORDER BY occurred_at, id`,
    [tenantId, entityType, verb, entityId],
  );
  return r.rows;
}

/** The `work_activity` rows for one object (source + object kind + object ref). */
export async function bridgedRows(tenantId: string, source: string, objectKind: string, objectRef: string): Promise<BridgedRow[]> {
  const r = await adminPool().query<BridgedRow>(
    `SELECT source, source_ref, actor_user_id, verb, object_kind, object_ref, title, payload, occurred_at
       FROM work_activity WHERE tenant_id = $1 AND source = $2 AND object_kind = $3 AND object_ref = $4 ORDER BY created_at, id`,
    [tenantId, source, objectKind, objectRef],
  );
  return r.rows;
}

/** How many `work_activity` rows one person has for one source (what the series must agree with). */
export async function bridgedCount(tenantId: string, actorUserId: string, source: string): Promise<number> {
  const r = await adminPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_activity WHERE tenant_id = $1 AND actor_user_id = $2 AND source = $3`,
    [tenantId, actorUserId, source],
  );
  return r.rows[0].n;
}

/** The series' answer for a person, with the window defaults (today in REPORTS_TZ, 365 days). */
export interface SeriesBody {
  to: string;
  days: Array<{ date: string; counts: Record<string, number> }>;
  totals: Record<string, number>;
  kinds: Array<{ key: string }>;
}
