// AIP-03b — the ingest behind `POST /api/internal/ai-usage`: AI callers OUTSIDE platform-nest (the ai-agents runner, the knowledge
// service, the MCP hub, the WhatsApp bot) have no platform database, so they report each gateway call here and we write it through the
// SAME writer every platform-nest caller uses (writer.ts: validation, never-throw, price table, cost_source).
//
// WHAT THIS ADDS TO THE WRITER (and nothing else)
//   * Surface fence: a service writes `agent`, `knowledge`, `bot` or `other`. It never writes `assistant`, `compaction`, `title` or
//     `search`: those rows belong to platform-nest's own call sites, so a service cannot forge a person's assistant line.
//   * The company must exist. A tenant id that is not a live company is rejected for that event (`unknown_tenant`).
//   * A `userId` must be a member of THAT company. When it is not, the event is stored with user_id NULL and counted, never rejected:
//     the money still happened.
//   * The department is never taken from the caller. A supplied `orgUnitId` is ignored; the department is the member's primary placement
//     today (resolvePrimaryUnitId, the same read every platform-nest caller gets), or null.
//   * Reasons are short codes. Nothing the caller sent (a key name, a label, a value) is echoed back.
//
// One event failing never fails the batch: the answer is `{accepted, rejected: [{index, reason}], counted}`.
import { withGlobal, withTenants } from "../../db";
import { AI_USAGE_EVENT_KEYS, UUID_PATTERN, recordAiUsage, validateAiUsageEvent, type AiUsageEvent, type RecordResult } from "./writer";
import { resolvePrimaryUnitId } from "./gateway-usage";
import type { AiUsageSurface } from "./vocab";

/** The only surfaces a service may report. */
export const INGEST_SURFACES: readonly AiUsageSurface[] = ["agent", "knowledge", "bot", "other"];
export const INGEST_MAX_EVENTS = 100;

export interface IngestResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
  /** Events stored but adjusted, by reason. `user_not_member`: the person is not a member of the company, so user_id was stored NULL. */
  counted: Record<string, number>;
}

export interface IngestDeps {
  /** Which of these company ids exist (live). Defaults to one read of `companies`. */
  existingCompanies?: (ids: string[]) => Promise<Set<string>>;
  /** Which of these users are active members of the company. Defaults to one read of `company_memberships` under that company. */
  members?: (tenantId: string, userIds: string[]) => Promise<Set<string>>;
  /** The member's primary department. Defaults to resolvePrimaryUnitId. */
  resolveUnit?: (tenantId: string, userId: string) => Promise<string | null>;
  /** The writer. Defaults to recordAiUsage. */
  record?: (event: AiUsageEvent) => Promise<RecordResult>;
}

async function defaultExistingCompanies(ids: string[]): Promise<Set<string>> {
  // companies is global reference data (no tenant_id, no RLS); the ids are only checked for existence, nothing is read from the rows.
  const r = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]));
  return new Set(r.rows.map((x) => x.id));
}

async function defaultMembers(tenantId: string, userIds: string[]): Promise<Set<string>> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ user_id: string }>(
      `SELECT user_id FROM company_memberships WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active' AND deleted_at IS NULL`,
      [tenantId, userIds],
    ),
  );
  return new Set(r.rows.map((x) => x.user_id));
}

const KEYS: ReadonlySet<string> = new Set(AI_USAGE_EVENT_KEYS);

/** A short code for a validator message. The message names a field (or echoes a short unknown key): the code never does. */
export function reasonCode(error: string): string {
  if (error.startsWith("event must be")) return "not_an_object";
  if (error.startsWith("unknown field")) return "unknown_field";
  const field = error.split(" ")[0] ?? "";
  return KEYS.has(field) ? `invalid_${field}` : "invalid_event";
}

/** Validate, fence, and write a batch (already known to hold 1 to INGEST_MAX_EVENTS items). Never throws on a bad event. */
export async function ingestAiUsage(events: unknown[], deps: IngestDeps = {}): Promise<IngestResult> {
  const existing = deps.existingCompanies ?? defaultExistingCompanies;
  const members = deps.members ?? defaultMembers;
  const resolveUnit = deps.resolveUnit ?? resolvePrimaryUnitId;
  const record = deps.record ?? ((e: AiUsageEvent) => recordAiUsage(e));

  const rejected: IngestResult["rejected"] = [];
  const counted: Record<string, number> = {};
  const ok: Array<{ index: number; event: AiUsageEvent }> = [];

  events.forEach((raw, index) => {
    const v = validateAiUsageEvent(raw);
    if (!v.ok) return void rejected.push({ index, reason: reasonCode(v.error) });
    if (!INGEST_SURFACES.includes(v.event.surface)) return void rejected.push({ index, reason: "surface_not_allowed" });
    ok.push({ index, event: v.event });
  });

  // One read for every company, one read per company that has a person to check.
  const known = ok.length > 0 ? await existing([...new Set(ok.map((x) => x.event.tenantId))]) : new Set<string>();
  const live: typeof ok = [];
  for (const x of ok) {
    if (known.has(x.event.tenantId)) live.push(x);
    else rejected.push({ index: x.index, reason: "unknown_tenant" });
  }

  const usersByTenant = new Map<string, Set<string>>();
  for (const { event } of live) {
    if (typeof event.userId === "string") usersByTenant.set(event.tenantId, (usersByTenant.get(event.tenantId) ?? new Set()).add(event.userId));
  }
  const memberOf = new Map<string, Set<string>>();
  for (const [tenantId, users] of usersByTenant) {
    try {
      memberOf.set(tenantId, await members(tenantId, [...users]));
    } catch {
      memberOf.set(tenantId, new Set()); // cannot prove membership: store no person rather than an unproven one
    }
  }

  let accepted = 0;
  for (const { index, event } of live) {
    let userId: string | null = typeof event.userId === "string" ? event.userId : null;
    if (userId !== null && !(memberOf.get(event.tenantId)?.has(userId) ?? false)) {
      userId = null;
      counted.user_not_member = (counted.user_not_member ?? 0) + 1;
    }
    let orgUnitId: string | null = null;
    if (userId !== null && UUID_PATTERN.test(userId)) {
      try { orgUnitId = await resolveUnit(event.tenantId, userId); } catch { orgUnitId = null; }
    }
    const result = await record({ ...event, userId, orgUnitId });
    if (result.ok) accepted++;
    else rejected.push({ index, reason: "write_failed" });
  }

  rejected.sort((a, b) => a.index - b.index);
  return { accepted, rejected, counted };
}
