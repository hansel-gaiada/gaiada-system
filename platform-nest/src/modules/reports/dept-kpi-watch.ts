// DW-4j-1 — the head is made aware: condition changes and off-track alerts (docs/FRONTEND-BFF-CONTRACT.md §43.1 to §43.6;
// plan docs/plans/2026-10-13-department-workspaces.md §5.5, "How the HOD is made aware"). The I/O half and the pure
// rules. The routes are dept-kpi-watch.controller.ts; the engine this calls is dept-kpi-targets.ts (§40.3a), unchanged.
//
// ══════════════════════════ THE RUN (§43.4, §43.6) ══════════════════════════
// `runDeptKpiWatch(tenantId, now?)` is what `POST /dept-kpis/watch` calls, once a day, from n8n (reporting blueprint §10:
// n8n schedules, platform-nest gains no timer):
//   1. EVALUATE, read-only and outside any transaction: `evaluateUnits` over every `department` node, for the current
//      calendar month in REPORTS_TZ, exactly as `GET /dept-kpis/overview` does. So a notification always agrees with what
//      the head sees when they open the page.
//   2. DECIDE AND WRITE in ONE transaction, serialised per tenant by `pg_advisory_xact_lock(hashtext('dept_kpi_watch:' ||
//      tenant_id))`: read the memory (`dept_kpi_conditions`) and the open alerts AFTER the lock is held (a second, concurrent
//      run waits, then reads the first one's committed state, so it tells nothing), apply the pure plan (`planWatch`),
//      upsert the memory, open and resolve alerts.
//   3. NOTIFY after the commit, per recipient, each in its own try/catch (`notifyBestEffort`): a failing send never fails the
//      run and never rolls the state back. A crash between the commit and the send LOSES that notification rather than
//      doubling it (the state already moved on); a failure is logged by notifyBestEffort.
// `now` is a parameter of the SERVICE only (the tests drive months with it); the HTTP route never takes one.
//
// ══════════════════════════ THE CHANGE RULE (§43.4) ══════════════════════════
// `classifyChange(previous, next)` is pure: tell only when the new condition is real and the previous one was a different
// real condition (either direction), or `unavailable` turning at risk / off track. No previous row (first run, a new KPI, a
// new department) stores and tells nothing, so a deploy never floods the Inbox. Anything to `unavailable`, and
// `unavailable` to on track, is stored silently. One notification per unit per run, only when the unit has something to tell.
//
// ══════════════════════════ WHO IS TOLD (§43.1) ══════════════════════════
// DW-10g-2: the holders of THIS company's own lead seat on the department's node EXACTLY (`loadSeatHoldersByNode`: an active
// `is_lead` position carrying the `org_unit_lead` role row, held through an assignment with no `valid_to`) who are active members
// of the company. The same seat `loadLedUnitScope` reads, so what is told here is who heads the unit there. Not told: the heads
// of enclosing units, a manager placed in the unit, a lead position without its role row, and the holder of an `org_unit_lead`
// GRANT alone. Before DW-10g-2 this read `user_roles`, whose `org_unit` grant carries no company: only the membership conjunct
// kept a node id that two companies share (`d-hr`) from reaching across, and a member of both companies was told as a head of
// each. Seats belong to one company's `positions` and are read in its scope.
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { notifyBestEffort } from "../../core/client-notify";
import { resolveRange } from "./reports.controller";
import { loadLeadSeatNodes, loadOrgStructure, loadSeatHoldersByNode, todayIsoInTz } from "./person-scope";
import { departmentUnits, findOrgUnit, kpiDefFor, workspaceSlugFor, type KpiCondition, type KpiUnit } from "./dept-kpis";
import { DEPT_KPI_MODULES, companyVertical, evaluateUnits, type UnitKpis } from "./dept-kpi-targets";

/** The department's own row in `dept_kpi_conditions`: a sentinel, never NULL (NULL defeats the unique key). */
export const KPI_KEY_DEPARTMENT = "*";
export const WATCH_NOTIFICATION_TYPE = "dept_kpi.condition_changed";
/** `ack_note` is at most this many characters (table CHECK and §43.5). */
export const MAX_ACK_NOTE = 1000;

// ═══════════════════════════════ pure: the change rule ═══════════════════════════════

export type ChangeVerdict = "tell" | "store";

/** PURE. §43.4: whether a move from `previous` (null: no row yet) to `next` is told or only stored. */
export function classifyChange(previous: KpiCondition | null, next: KpiCondition): ChangeVerdict {
  if (previous === null) return "store"; // the first run, a new KPI, a new department: a deploy never floods the Inbox
  if (next === "unavailable") return "store"; // a new month with no data, a target withdrawn, a failed reader
  if (previous === next) return "store";
  if (previous === "unavailable") return next === "at_risk" || next === "off_track" ? "tell" : "store";
  return "tell"; // a different real condition, worse or back
}

// ═══════════════════════════════ pure: the text ═══════════════════════════════

const CONDITION_WORD: Readonly<Record<KpiCondition, string>> = {
  on_track: "on track",
  at_risk: "at risk",
  off_track: "off track",
  unavailable: "unavailable",
};
export const conditionWord = (c: KpiCondition): string => CONDITION_WORD[c] ?? "unavailable";

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Port of platform-ui `deptKpiFormat.ts` `formatMinutes`: "45 min", "3h 20m", "2.5 d". */
function formatMinutes(m: number): string {
  if (m < 60) return `${round(m, 0)} min`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  return `${round(m / 1440, 1)} d`;
}

/** Port of platform-ui `formatKpiValue`: a percent fraction as a whole percent ("71%"), a duration, a count. */
export function formatKpiValue(value: number | null | undefined, unit: KpiUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "minutes") return formatMinutes(value);
  return round(value).toLocaleString("en-US");
}

export interface ToldChange {
  kpiKey: string;
  label: string;
  from: KpiCondition;
  to: KpiCondition;
  /** The body line: "Projects on time: at risk → off track (71% against 85%)". */
  line: string;
}

/** PURE. One KPI line of the body. The numbers are the department's own, the ones the head reads on the KPI page. */
export function kpiChangeLine(label: string, from: KpiCondition, to: KpiCondition, value: number | null, target: number | null, unit: KpiUnit): string {
  const base = `${label}: ${conditionWord(from)} → ${conditionWord(to)}`;
  return value === null || target === null ? base : `${base} (${formatKpiValue(value, unit)} against ${formatKpiValue(target, unit)})`;
}

export type NoticeSeverity = "info" | "warning" | "critical";

// A type alias, not an interface: notify()'s NotificationPayload has an index signature an interface would not satisfy.
export type NoticePayload = {
  title: string;
  body: string;
  href: string;
  severity: NoticeSeverity;
};

/** PURE. `critical` when the department or any KPI told is now off track; `warning` when one is now at risk; `info` when
 *  every change told lands on track (an improvement). */
export function noticeSeverity(toldConditions: readonly KpiCondition[]): NoticeSeverity {
  if (toldConditions.includes("off_track")) return "critical";
  if (toldConditions.includes("at_risk")) return "warning";
  return "info";
}

/** PURE. The one notification of a unit for a run: "Web Dev: off track", one line per change told (the department's last),
 *  the unit's appraisal page as the link. No `entityType`, so the Inbox opens no thread panel; no person is named. */
export function buildNotice(
  unitNodeId: string,
  unitName: string,
  departmentCondition: KpiCondition,
  kpiChanges: readonly ToldChange[],
  departmentChange: { from: KpiCondition; to: KpiCondition } | null,
): NoticePayload {
  const lines = kpiChanges.map((c) => c.line);
  if (departmentChange) lines.push(`Department: ${conditionWord(departmentChange.from)} → ${conditionWord(departmentChange.to)}`);
  const told = [...kpiChanges.map((c) => c.to), ...(departmentChange ? [departmentChange.to] : [])];
  return {
    title: `${unitName}: ${conditionWord(departmentCondition)}`,
    body: lines.join("\n"),
    href: `/appraisals/department?unit=${encodeURIComponent(unitNodeId)}`,
    severity: noticeSeverity(told),
  };
}

// ═══════════════════════════════ pure: the plan ═══════════════════════════════

/** The memory, keyed by (unit, KPI): see `stateKey`. */
export type PreviousStates = ReadonlyMap<string, KpiCondition>;
export const stateKey = (unitNodeId: string, kpiKey: string): string => JSON.stringify([unitNodeId, kpiKey]);

export interface OpenAlertRef {
  id: string;
  unitNodeId: string;
  kpiKey: string;
}

export interface StateUpsert {
  unitNodeId: string;
  kpiKey: string;
  condition: KpiCondition;
  reason: string | null;
  value: number | null;
  target: number | null;
}

export interface UnitNotice {
  unitNodeId: string;
  unitName: string;
  changes: number;
  payload: NoticePayload;
}

export interface WatchPlan {
  upserts: StateUpsert[];
  notices: UnitNotice[];
  alertsToOpen: Array<{ unitNodeId: string; kpiKey: string; value: number | null; target: number | null }>;
  alertsToResolve: Array<{ id: string; unitNodeId: string; kpiKey: string; condition: KpiCondition }>;
}

/**
 * PURE. What one run does, given the fresh reads, the memory and the open alerts:
 *   - every (unit, KPI) and every unit's own condition is upserted;
 *   - each unit with something to tell gets ONE notice (§43.4);
 *   - an alert is OPENED for a KPI that is off track and has no open alert (a state, not a change: the first run opens
 *     alerts for KPIs already off track, and notifies nothing);
 *   - an open alert is RESOLVED when its KPI is no longer off track, `unavailable` included. An alert whose unit or KPI is no
 *     longer evaluated at all (the unit stopped being a department, or moved to a workspace without the KPI) resolves as
 *     `unavailable`, so a stale item never sits in Needs you for ever.
 */
export function planWatch(reads: readonly UnitKpis[], previous: PreviousStates, openAlerts: readonly OpenAlertRef[]): WatchPlan {
  const plan: WatchPlan = { upserts: [], notices: [], alertsToOpen: [], alertsToResolve: [] };
  const current = new Map<string, KpiCondition>();
  const open = new Set(openAlerts.map((a) => stateKey(a.unitNodeId, a.kpiKey)));

  for (const read of reads) {
    const changes: ToldChange[] = [];
    for (const k of read.kpis) {
      current.set(stateKey(read.unit.id, k.key), k.condition);
      plan.upserts.push({ unitNodeId: read.unit.id, kpiKey: k.key, condition: k.condition, reason: k.reason ?? null, value: k.value, target: k.target });
      const before = previous.get(stateKey(read.unit.id, k.key)) ?? null;
      if (classifyChange(before, k.condition) === "tell" && before !== null) {
        changes.push({
          kpiKey: k.key,
          label: k.label,
          from: before,
          to: k.condition,
          line: kpiChangeLine(k.label, before, k.condition, k.value, k.target, k.unit),
        });
      }
      if (k.condition === "off_track" && !open.has(stateKey(read.unit.id, k.key))) {
        plan.alertsToOpen.push({ unitNodeId: read.unit.id, kpiKey: k.key, value: k.value, target: k.target });
      }
    }
    plan.upserts.push({ unitNodeId: read.unit.id, kpiKey: KPI_KEY_DEPARTMENT, condition: read.condition, reason: null, value: null, target: null });
    const deptBefore = previous.get(stateKey(read.unit.id, KPI_KEY_DEPARTMENT)) ?? null;
    const deptChange =
      deptBefore !== null && classifyChange(deptBefore, read.condition) === "tell" ? { from: deptBefore, to: read.condition } : null;
    if (changes.length > 0 || deptChange) {
      plan.notices.push({
        unitNodeId: read.unit.id,
        unitName: read.unit.name,
        changes: changes.length + (deptChange ? 1 : 0),
        payload: buildNotice(read.unit.id, read.unit.name, read.condition, changes, deptChange),
      });
    }
  }

  for (const a of openAlerts) {
    const now = current.get(stateKey(a.unitNodeId, a.kpiKey)) ?? "unavailable";
    if (now !== "off_track") plan.alertsToResolve.push({ id: a.id, unitNodeId: a.unitNodeId, kpiKey: a.kpiKey, condition: now });
  }
  return plan;
}

// ═══════════════════════════════ recipients (§43.1) ═══════════════════════════════

/** Which of `userIds` are active members of the company. `company_memberships` is tenant-RLS'd (an unset tenant GUC reads
 *  ZERO rows, so this cannot run under `withGlobal`), hence the tenant transaction. */
async function activeMembers(tenantId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await withTenants([tenantId], async (c) =>
    (
      await c.query<{ user_id: string }>(
        `SELECT user_id FROM company_memberships
          WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]) AND deleted_at IS NULL AND status = 'active'`,
        [tenantId, [...new Set(userIds)]],
      )
    ).rows,
  );
  return new Set(rows.map((r) => r.user_id));
}

/** The heads of each of `unitNodeIds`, exact node, as unit -> sorted distinct user ids. A unit with no head is absent. The
 *  company's own lead seats (`loadSeatHoldersByNode`, in its scope); the holder must also be an active member of THIS company
 *  (see the header). */
export async function loadLeadUserIdsByUnit(tenantId: string, unitNodeIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (unitNodeIds.length === 0) return out;
  const seats = await withTenants([tenantId], (c) => loadSeatHoldersByNode(c, tenantId, unitNodeIds));
  const members = await activeMembers(tenantId, [...seats.values()].flat());
  for (const [unit, holders] of seats) {
    const list = [...new Set(holders.filter((u) => members.has(u)))].sort();
    if (list.length > 0) out.set(unit, list);
  }
  return out;
}

/** §43.1: the department's heads, sorted and distinct (see the header for the exact conditions). */
export async function loadUnitLeadUserIds(tenantId: string, unitNodeId: string): Promise<string[]> {
  return (await loadLeadUserIdsByUnit(tenantId, [unitNodeId])).get(unitNodeId) ?? [];
}

/** The inverse of the above, for the caller: the nodes `userId` heads exactly in THIS company (its own lead seats, active
 *  member). */
export async function loadUnitsLedExactly(tenantId: string, userId: string): Promise<string[]> {
  if (!(await activeMembers(tenantId, [userId])).has(userId)) return [];
  return withTenants([tenantId], (c) => loadLeadSeatNodes(c, tenantId, userId));
}

// ═══════════════════════════════ the run (§43.6) ═══════════════════════════════

export interface WatchResult {
  period: { start: string; end: string };
  evaluatedUnits: number;
  /** One entry per unit that was told something: how many heads were addressed and how many changes the notice carried. */
  told: Array<{ unitNodeId: string; recipients: number; changes: number }>;
  alertsOpened: number;
  alertsResolved: number;
  /** Every evaluated department with no head today (sorted): nobody is told for it. */
  unitsWithoutHead: string[];
}

async function loadMemory(c: PoolClient, tenantId: string): Promise<Map<string, KpiCondition>> {
  const { rows } = await c.query<{ unit_node_id: string; kpi_key: string; condition: KpiCondition }>(
    `SELECT unit_node_id, kpi_key, condition FROM dept_kpi_conditions WHERE tenant_id = $1`,
    [tenantId],
  );
  return new Map(rows.map((r) => [stateKey(r.unit_node_id, r.kpi_key), r.condition]));
}

async function loadOpenAlertRefs(c: PoolClient, tenantId: string): Promise<OpenAlertRef[]> {
  const { rows } = await c.query<{ id: string; unit_node_id: string; kpi_key: string }>(
    `SELECT id, unit_node_id, kpi_key FROM dept_kpi_alerts WHERE tenant_id = $1 AND resolved_at IS NULL ORDER BY opened_at, id`,
    [tenantId],
  );
  return rows.map((r) => ({ id: r.id, unitNodeId: r.unit_node_id, kpiKey: r.kpi_key }));
}

/** The scheduled run (§43.4, §43.6): evaluate, decide and write under the tenant's lock, notify after the commit. */
export async function runDeptKpiWatch(tenantId: string, now: Date = new Date()): Promise<WatchResult> {
  // The period: the current calendar month in REPORTS_TZ, which is the default of the KPI page and of the Overview.
  const today = todayIsoInTz(config.reportsTz, now);
  const range = resolveRange("month", `${today.slice(0, 7)}-01`);

  // (1) Evaluate: read-only, outside the transaction.
  const structure = await withTenants([tenantId], (c) => loadOrgStructure(c, tenantId), { modules: DEPT_KPI_MODULES });
  const departments = departmentUnits(structure);
  // `today` is the watch's own (from `now`), so module readers judge "already due" on the day this run evaluates (§40.5.1).
  const reads = await evaluateUnits(tenantId, await companyVertical(tenantId), departments, departments, range, range.start, today);

  // (2) Decide and write, serialised per tenant.
  const plan = await withTenants(
    [tenantId],
    async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('dept_kpi_watch:' || $1::text))`, [tenantId]);
      const decided = planWatch(reads, await loadMemory(c, tenantId), await loadOpenAlertRefs(c, tenantId));

      if (decided.upserts.length > 0) {
        await c.query(
          `INSERT INTO dept_kpi_conditions (tenant_id, unit_node_id, kpi_key, period_start, condition, reason, value, target,
                                            evaluated_at, changed_at, origin_site)
           SELECT $1::uuid, u.unit, u.kpi, $2::date, u.cond, u.reason, u.value, u.target, now(), now(), $3::text
             FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[])
                  AS u(unit, kpi, cond, reason, value, target)
           ON CONFLICT (tenant_id, unit_node_id, kpi_key) DO UPDATE
             SET period_start = EXCLUDED.period_start,
                 condition = EXCLUDED.condition,
                 reason = EXCLUDED.reason,
                 value = EXCLUDED.value,
                 target = EXCLUDED.target,
                 evaluated_at = now(),
                 changed_at = CASE WHEN dept_kpi_conditions.condition IS DISTINCT FROM EXCLUDED.condition
                                   THEN now() ELSE dept_kpi_conditions.changed_at END`,
          [
            tenantId,
            range.start,
            config.originSite,
            decided.upserts.map((u) => u.unitNodeId),
            decided.upserts.map((u) => u.kpiKey),
            decided.upserts.map((u) => u.condition),
            decided.upserts.map((u) => u.reason),
            decided.upserts.map((u) => u.value),
            decided.upserts.map((u) => u.target),
          ],
        );
      }
      let opened = 0;
      for (const a of decided.alertsToOpen) {
        const r = await c.query(
          `INSERT INTO dept_kpi_alerts (id, tenant_id, unit_node_id, kpi_key, period_start, value, target, origin_site)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)
           ON CONFLICT (tenant_id, unit_node_id, kpi_key) WHERE resolved_at IS NULL DO NOTHING`,
          [newId(), tenantId, a.unitNodeId, a.kpiKey, range.start, a.value, a.target, config.originSite],
        );
        opened += r.rowCount ?? 0;
      }
      let resolved = 0;
      for (const a of decided.alertsToResolve) {
        const r = await c.query(
          `UPDATE dept_kpi_alerts SET resolved_at = now(), resolved_condition = $3
            WHERE tenant_id = $1 AND id = $2 AND resolved_at IS NULL`,
          [tenantId, a.id, a.condition],
        );
        resolved += r.rowCount ?? 0;
      }
      return { decided, opened, resolved };
    },
    { modules: DEPT_KPI_MODULES },
  );

  // (3) Notify, after the commit: the heads of each unit, one notification each, none for a unit without a head.
  const heads = await loadLeadUserIdsByUnit(tenantId, departments.map((d) => d.id));
  const told: WatchResult["told"] = [];
  for (const notice of plan.decided.notices) {
    const recipients = heads.get(notice.unitNodeId) ?? [];
    if (recipients.length === 0) continue;
    // actorId null: a scheduler. notify() skips a recipient equal to a non-null actor, and a non-member.
    await notifyBestEffort(tenantId, null, recipients, WATCH_NOTIFICATION_TYPE, notice.payload);
    told.push({ unitNodeId: notice.unitNodeId, recipients: recipients.length, changes: notice.changes });
  }
  return {
    period: { start: range.start, end: range.end },
    evaluatedUnits: reads.length,
    told,
    alertsOpened: plan.opened,
    alertsResolved: plan.resolved,
    unitsWithoutHead: departments.filter((d) => !heads.has(d.id)).map((d) => d.id).sort(),
  };
}

// ═══════════════════════════════ alerts: reads and acknowledge (§43.5) ═══════════════════════════════

interface DbAlertRow {
  id: string;
  unit_node_id: string;
  kpi_key: string;
  opened_at: Date;
  period_start: string;
  value: string | null;
  target: string | null;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  ack_note: string | null;
  resolved_at: Date | null;
  resolved_condition: KpiCondition | null;
}

// `date` as text (this pool installs no type parser), numerics as text so they come back as numbers below.
const ALERT_COLUMNS = `id, unit_node_id, kpi_key, opened_at, period_start::text AS period_start, value::text AS value, target::text AS target,
  acknowledged_by, acknowledged_at, ack_note, resolved_at, resolved_condition`;

export interface AlertView {
  id: string;
  unit: { id: string; name: string };
  kpiKey: string;
  kpiLabel: string;
  kpiUnit: KpiUnit | null;
  periodStart: string;
  openedAt: string;
  value: number | null;
  target: number | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  ackNote: string | null;
  resolvedAt: string | null;
  resolvedCondition: KpiCondition | null;
}

const num = (s: string | null): number | null => (s === null ? null : Number(s));
const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/** Names (display names of the users who acknowledged). `users` is global. */
async function userNames(ids: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await withGlobal((c) => c.query<{ id: string; name: string | null }>(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [unique]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Shape rows as the contract's alert row. The unit's name and the KPI's label and unit come from the org tree and the
 *  catalogue (a unit that left the tree reads as its id; a KPI the unit's workspace no longer has reads as its key, with
 *  a null unit). */
async function toViews(tenantId: string, rows: DbAlertRow[], structure: unknown): Promise<AlertView[]> {
  const vertical = await companyVertical(tenantId);
  const names = await userNames(rows.map((r) => r.acknowledged_by).filter((x): x is string => !!x));
  return rows.map((r) => {
    const unit = findOrgUnit(structure, r.unit_node_id);
    const def = unit ? kpiDefFor(workspaceSlugFor(vertical, unit.name), r.kpi_key) : undefined;
    return {
      id: r.id,
      unit: { id: r.unit_node_id, name: unit ? unit.name : r.unit_node_id },
      kpiKey: r.kpi_key,
      kpiLabel: def ? def.label : r.kpi_key,
      kpiUnit: def ? def.unit : null,
      periodStart: r.period_start,
      openedAt: new Date(r.opened_at).toISOString(),
      value: num(r.value),
      target: num(r.target),
      acknowledgedBy: r.acknowledged_by,
      acknowledgedByName: r.acknowledged_by ? (names.get(r.acknowledged_by) ?? null) : null,
      acknowledgedAt: iso(r.acknowledged_at),
      ackNote: r.ack_note,
      resolvedAt: iso(r.resolved_at),
      resolvedCondition: r.resolved_condition,
    };
  });
}

/** Needs-you source: the open, unacknowledged alerts of `unitNodeIds`, newest first. */
export async function listOpenUnacknowledgedAlerts(tenantId: string, unitNodeIds: string[]): Promise<AlertView[]> {
  if (unitNodeIds.length === 0) return [];
  return withTenants(
    [tenantId],
    async (c) => {
      const { rows } = await c.query<DbAlertRow>(
        `SELECT ${ALERT_COLUMNS} FROM dept_kpi_alerts
          WHERE tenant_id = $1 AND unit_node_id = ANY($2::text[]) AND resolved_at IS NULL AND acknowledged_at IS NULL
          ORDER BY opened_at DESC, id DESC`,
        [tenantId, unitNodeIds],
      );
      return toViews(tenantId, rows, await loadOrgStructure(c, tenantId));
    },
    { modules: DEPT_KPI_MODULES },
  );
}

/** One unit's alerts, every state, newest first, at most 100. */
export async function listUnitAlerts(tenantId: string, unitNodeId: string, structure: unknown): Promise<AlertView[]> {
  return withTenants(
    [tenantId],
    async (c) => {
      const { rows } = await c.query<DbAlertRow>(
        `SELECT ${ALERT_COLUMNS} FROM dept_kpi_alerts WHERE tenant_id = $1 AND unit_node_id = $2 ORDER BY opened_at DESC, id DESC LIMIT 100`,
        [tenantId, unitNodeId],
      );
      return toViews(tenantId, rows, structure);
    },
    { modules: DEPT_KPI_MODULES },
  );
}

/** The alert's unit and state, or null when there is no such alert in this company. */
export async function fetchAlertHead(tenantId: string, alertId: string): Promise<{ unitNodeId: string; resolved: boolean; acknowledged: boolean } | null> {
  return withTenants(
    [tenantId],
    async (c) => {
      const { rows } = await c.query<{ unit_node_id: string; resolved_at: Date | null; acknowledged_at: Date | null }>(
        `SELECT unit_node_id, resolved_at, acknowledged_at FROM dept_kpi_alerts WHERE tenant_id = $1 AND id = $2`,
        [tenantId, alertId],
      );
      const r = rows[0];
      return r ? { unitNodeId: r.unit_node_id, resolved: r.resolved_at !== null, acknowledged: r.acknowledged_at !== null } : null;
    },
    { modules: DEPT_KPI_MODULES },
  );
}

export type AckOutcome =
  | { ok: true; alert: AlertView; unitNodeId: string; kpiKey: string }
  | { ok: false; reason: "not_found" | "resolved" | "already_acknowledged" };

/** Record that a head saw the alert. The UPDATE's own conditions decide the race: an alert resolved or acknowledged between
 *  the checks and the write changes no row, and the re-read says why. A resolved alert reads `resolved` even when it had
 *  also been acknowledged. */
export async function acknowledgeAlert(tenantId: string, alertId: string, userId: string, note: string | null, structure: unknown): Promise<AckOutcome> {
  const outcome = await withTenants(
    [tenantId],
    async (c): Promise<{ ok: true; row: DbAlertRow } | { ok: false; reason: "not_found" | "resolved" | "already_acknowledged" }> => {
      const upd = await c.query<DbAlertRow>(
        `UPDATE dept_kpi_alerts SET acknowledged_by = $3, acknowledged_at = now(), ack_note = $4
          WHERE tenant_id = $1 AND id = $2 AND acknowledged_at IS NULL AND resolved_at IS NULL
         RETURNING ${ALERT_COLUMNS}`,
        [tenantId, alertId, userId, note],
      );
      if (upd.rows[0]) return { ok: true, row: upd.rows[0] };
      const cur = await c.query<{ resolved_at: Date | null }>(`SELECT resolved_at FROM dept_kpi_alerts WHERE tenant_id = $1 AND id = $2`, [tenantId, alertId]);
      if (!cur.rows[0]) return { ok: false, reason: "not_found" };
      return { ok: false, reason: cur.rows[0].resolved_at ? "resolved" : "already_acknowledged" };
    },
    { modules: DEPT_KPI_MODULES },
  );
  if (!outcome.ok) return outcome;
  const [alert] = await toViews(tenantId, [outcome.row], structure);
  return { ok: true, alert, unitNodeId: outcome.row.unit_node_id, kpiKey: outcome.row.kpi_key };
}
