// TR-07 — the nightly fact job + attribution engine (Blueprint §3.1 attribution table, §3.2
// precedence ①–④, §4a invariants 1/2/5/6/7, §5.3 check-in expectation, §5.4 additivity).
//
// This file computes `report_work_facts`: THE atomic fact grain (`person × project × day`, §4a
// invariant 1) that every department / company / week / month / arbitrary-range number is a plain
// SUM over. It is the correctness heart of the reporting program — a wrong join here produces a
// plausible-looking company total that nobody questions for months.
//
// ─────────────────────────── HOUSE PATTERN: pure core, I/O at the edges ───────────────────────────
// Same shape as core/dept-resolution.ts, core/work-activity-linker.ts and modules/search/ai-drafts.ts:
//
//   gather*()          — I/O. Every DB read, each inside its own `withTenants([oneTenant], …)`.
//   computeFactRows()  — PURE. No DB, no clock, no randomness. The whole attribution decision.
//   writeFactSlice()   — I/O. DELETE+INSERT of one (tenant, date) slice in ONE transaction.
//
// Purity is not decoration here: this runs over every row of every tenant every night, so the
// decision logic has to be testable without a database (fact-job.test.ts) and cheap to run.
//
// ─────────────────────────── DEPARTMENT RESOLUTION IS NOT REIMPLEMENTED ───────────────────────────
// Precedence ①–④ and the provider stamp live in `core/dept-resolution.ts` (TR-04) and are CALLED
// from here, never re-derived. This file's only job on that axis is to GATHER the four inputs that
// resolver documents (`ownerUnitNodeId`, a `PersonMembershipLookup`, `projectDepartmentId`, and a
// precomputed `activeServiceAssignment` boolean) — see resolveUnit() below.
//
// ─────────────────────── RULINGS HONOURED (each came from a real defect) ───────────────────────
//  1. `actor_user_id IS NULL` ⇒ EXCLUDED from person attribution, never a guessed owner (§15,
//     TR-31's deliberate non-attributions: 'pm:recurrence-engine', 'pm:ai-tracker', async
//     transcription). Those rows still land on the UNIT axis (so company totals stay complete),
//     with `user_id = NULL` — the explicit unattributed-person bucket, not a hidden one.
//  2. Cross-company: a person's unit resolves from whichever tenant's org tree they actually sit
//     in, REGARDLESS of `service_assignments` state; only the provider STAMP requires an ACTIVE
//     edge (§15 TR-04 ruling). A suspended commercial edge must never move a person's history
//     between departments, so there is no fall-through to ③/④ here.
//  3. Done-ness is never a literal status id. This job reads the `completed`/`reopened` verbs the
//     outbox consumer already derived from `effectiveStatuses()`'s `is_done` FLAG
//     (events/work-activity-consumer.ts `deriveVerb`), so there is exactly ONE place in the
//     codebase that decides is-done-ness and a renamed/custom done status still counts.
//  4. Additive measures ONLY (§4a invariant 2). No ratio, no percentage, no pre-divided value is
//     computed or stored here. Every ratio in §5 is numerator/denominator in `rollup_metrics`
//     (TR-08's job) over these counters.
//  5. Soft-deleted tasks WERE backfilled into `pm_task_assignees` on purpose (TR-01), so every
//     query below filters `pm_tasks.deleted_at IS NULL` itself. Not filtering it inflates every
//     completion count silently.
//  6. `origin_site` is passed EXPLICITLY on every insert — `report_work_facts.origin_site` has no
//     column default by design (§15 ruling), because a default would let a site-originated row
//     mislabel itself 'central'.
//  7. The slice is keyed exactly like the table's `UNIQUE NULLS NOT DISTINCT (tenant_id,
//     fact_date, user_id, project_id, unit_node_id)` — that constraint is what makes NULL-user /
//     NULL-project rows idempotent, so the accumulator uses the identical 5-tuple.
//
// ────── CLOSED (TR-34): attribution is now AS-OF, matching department resolution ──────
// `org_unit_memberships` (0055) made the DEPARTMENT axis time-aware; this used to be a documented gap
// on the PERSON axis (`pm_task_assignees` had no validity interval, so recomputing a historical slice
// credited that day's completions to whoever owns the task TODAY — reassign a finished task next
// month and a re-run of last month's slice moved the credit). TR-34 (migration 0063) closed it:
// `pm_task_assignees.role IN ('owner','responsible')` rows now carry `valid_from`/`valid_to`
// (`NULL` = open), a reassignment CLOSES the old interval and OPENS a new one (pm.controller.ts's
// `syncTaskAssignees`/`applyRoleTransition`), and both queries below (the task attribution join and
// the time-entry `task_role` classification) resolve AS OF the fact's own date — inclusive both
// ends, NULL-valid_to-is-open, the identical semantics `resolveMembershipAsOf`
// (core/dept-resolution.ts) uses for the unit axis. SEALING (§0057 + §5.2 point 8) remains the
// mitigation for the residual, now much narrower, exposure: an UNSEALED fact recomputed the same day
// a reassignment happens (before `today` rolls over) still resolves to whichever value was open at
// the moment the query ran, same as any as-of system. `pm_task_assignees` rows that predate 0063 were
// backfilled with a single interval dated from the task's own `created_at` (0063's backfill), so
// existing history resolves correctly too, not just future reassignments.
//
// Contributor rows are deliberately NOT interval-tracked (0063's design-judgement header comment):
// their reporting number, `minutes_contributed`, is already date-correct via `time_entries.entry_date`
// itself, and add/remove (not open/close) remains their whole lifecycle.
//
// ─────────────────────────── WHY DELETE+INSERT AND NOT UPSERT ───────────────────────────
// §4a invariant 5. An UPSERT leaves yesterday's row behind when today's recomputation no longer
// produces it (e.g. a task was soft-deleted, or a time entry was voided) — the slice would keep a
// phantom measure forever. DELETE-then-INSERT of the WHOLE (tenant, fact_date) slice inside one
// transaction is the only shape that converges from any prior state, and it is atomic: a reader
// either sees the old slice or the new one, never a half-written one.
//
// ─────────────── WHY ROW IDS ARE DETERMINISTIC (uuid v5, not the usual newId()) ───────────────
// The acceptance bar is "recompute twice → byte-identical rows". With `newId()` (uuid v7) the id
// column would differ on every run, so "byte-identical" could only ever be asserted on a subset of
// columns, and any downstream reference to a fact id would break on every nightly run. The id is
// therefore a uuid v5 over the row's own unique key, which makes it a stable, reproducible
// function of the data. The two columns that MUST still change per run are `computed_at` and
// `job_run_id` — invariant 5 requires `job_run_id` to trace a row to the run that wrote it, so a
// stable job_run_id would defeat its only purpose.
import { randomUUID } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { config } from "../../config";
import { isModuleEnabled } from "../registry";
import { logAssigneeDriftIfAny } from "../pm/pm.controller";
import {
  addDaysIso,
  resolveDepartment,
  resolveMembershipAsOf,
  todayIso,
  type MembershipInterval,
  type PersonMembershipLookup,
  type ResolutionPrecedence,
} from "../../core/dept-resolution";

/** Every DB read in this file declares all three module scopes it crosses (§4a invariant 7): the
 *  `reports` third wall for `report_*`, `hr` for the leave/attendance false-negative guard (§5.3),
 *  and `pm` for the assignee substrate. `pm_*` tables carry a plain tenant policy today, so `pm`
 *  is declared for VISIBILITY (a future pm third wall must not silently zero this job) — exactly
 *  what invariant 7 means by "declared, not assumed". */
export const REPORT_JOB_MODULES = ["reports", "pm", "hr"] as const;

/** Fixed namespace for the deterministic fact-row ids (see the header). Never change it: changing
 *  it re-mints every fact id in the estate on the next recompute. */
const FACT_ID_NAMESPACE = "3d5b7f14-2c9a-4e6d-8b71-0f2a4c6e8d10";

/** The 5-tuple of the table's own UNIQUE NULLS NOT DISTINCT key, hashed. NULLs are encoded as a
 *  sentinel that cannot collide with a uuid or an org-node id. */
export function factRowId(
  tenantId: string,
  factDate: string,
  userId: string | null,
  projectId: string | null,
  unitNodeId: string | null,
): string {
  const key = [tenantId, factDate, userId ?? " ", projectId ?? " ", unitNodeId ?? " "].join("|");
  return uuidv5(key, FACT_ID_NAMESPACE);
}

// ═══════════════════════════════ PURE CORE — input types ═══════════════════════════════

export type AssigneeKind = "person" | "department" | "division";

/** One task that produced at least one outcome EVENT on the slice date, plus the attribution
 *  substrate needed to decide who/which unit gets the credit.
 *
 *  `completed`/`reopened`/`created` are per-DAY booleans, deliberately not event counts: a task
 *  completed → reopened → completed again within one day is ONE completion and ONE reopen on that
 *  day, not two completions. Counting raw events would let a status ping-pong inflate throughput,
 *  and `tasks_reopened` already carries the churn signal (metric #9). Across days a task really
 *  completed twice does count twice — it was delivered twice. */
export interface TaskFactInput {
  taskId: string;
  projectId: string;
  /** `projects.department_id` — precedence ③ input. */
  projectDepartmentId: string | null;
  dueDate: string | null; // 'YYYY-MM-DD'
  estimateMinutes: number | null;
  /** `pm_task_assignees` role='owner'. NULL when the task has no assignee at all (§3.1 row 4). */
  ownerKind: AssigneeKind | null;
  /** Set only when ownerKind === 'person'. */
  ownerUserId: string | null;
  /** Set only when ownerKind is a unit — precedence ① input. */
  ownerUnitNodeId: string | null;
  /** `pm_task_assignees` role='responsible' (always a person, may exist beside a unit owner). */
  responsibleUserId: string | null;
  completed: boolean;
  reopened: boolean;
  created: boolean;
  /** TR-08 (§15 ruling ②'s second gap, metric #13 `effort.estimate_accuracy`): total minutes
   *  logged against THIS task (all time, not just this slice's date — gathered fresh per
   *  completion so a task logged-then-completed-later still matches). 0 when the task has no
   *  time entries. Only meaningful when `completed && estimateMinutes !== null`; harmless
   *  otherwise. Not part of the §3.1 attribution decision — purely an additive counter input. */
  actualMinutesLogged: number;
}

/** One `time_entries` row on the slice date. `taskRole` is the logging person's OWN role on the
 *  linked `pm_task` (null when the entry has no pm task, or the person holds no role on it) — it
 *  is what separates `minutes_contributed` (help on someone else's task, §3.1's contributor rule,
 *  metric #15) from plain `minutes_logged`. */
export interface TimeFactInput {
  userId: string;
  projectId: string;
  minutes: number;
  billable: boolean;
  taskRole: "owner" | "responsible" | "contributor" | null;
}

/** One `work_activity` row on the slice date — the evidence axis. */
export interface ActivityFactInput {
  activityId: string;
  source: string;
  /** NULL ⇒ system/AI actor ⇒ excluded from person attribution (ruling 1). */
  actorUserId: string | null;
  /** From `work_activity_links` target_kind='project', validated against `projects`. */
  projectId: string | null;
  verb: string;
  objectKind: string;
  hasExactLink: boolean;
}

export interface FactSliceInputs {
  tenantId: string;
  factDate: string; // 'YYYY-MM-DD'
  tasks: TaskFactInput[];
  timeEntries: TimeFactInput[];
  activities: ActivityFactInput[];
  /** userId → the candidate membership lookups, ORDERED: the fact tenant's own org tree first,
   *  then each provider tenant's (ascending tenant id, so the choice is deterministic when a
   *  person is placed in more than one foreign tree). The first lookup with an interval covering
   *  `factDate` wins — this is the caller-side decision `resolveDepartment` documents as its own
   *  (it takes exactly one lookup). */
  memberships: Record<string, PersonMembershipLookup[]>;
  /** `${membershipTenantId}|${unitNodeId}` for every ACTIVE `service_assignments` edge serving
   *  this fact's tenant. Only membership (①-losing, ②-winning) resolutions consult it, and ONLY
   *  for the provider stamp — never for the base unit resolution (ruling 2). */
  activeProviderUnits: Set<string>;
  /** fact-tenant unit node id → its rolled ancestor department node id (itself when it already IS
   *  a department). Derived from the tenant's own org blob by deriveUnitDepartments(). */
  unitDepartment: Record<string, string>;
}

// ═══════════════════════════════ PURE CORE — output type ═══════════════════════════════

export interface FactRow {
  factDate: string;
  userId: string | null;
  projectId: string | null;
  unitNodeId: string | null;
  departmentNodeId: string | null;
  providerTenantId: string | null;
  providerUnitNodeId: string | null;
  tasksCompleted: number;
  tasksCompletedOnTime: number;
  /** TR-08 (0057, §15 ruling ②) — completed tasks that carried a due date (regardless of
   *  on-time-ness). This is metric #3 `delivery.on_time_rate`'s DENOMINATOR: seeding it against
   *  `tasksCompleted` instead would dilute the rate with due-date-less tasks and reward teams
   *  that set fewer due dates — the exact inversion the ruling forbids. */
  tasksCompletedWithDueDate: number;
  tasksCompletedEstimated: number;
  estimateMinutesCompleted: number;
  /** TR-08 (0057, §15 ruling ②'s second gap) — metric #13 `effort.estimate_accuracy`'s matched
   *  numerator/denominator: Σ estimate / Σ actual minutes, but ONLY for completed tasks that
   *  carry BOTH an estimate and at least one logged minute (never diluted by tasks with only
   *  one side of the pair). */
  estimateMinutesCompletedWithActual: number;
  minutesLoggedCompletedWithActual: number;
  tasksReopened: number;
  tasksCreated: number;
  minutesLogged: number;
  minutesBillable: number;
  minutesContributed: number;
  commentsAuthored: number;
  docsUpdated: number;
  activityEvents: number;
  activityLinkedExact: number;
  activityBySource: Record<string, number>;
}

// ═══════════════════════════════ PURE CORE — attribution ═══════════════════════════════

/** §3.1's PERSON column, verbatim and in one place:
 *
 *  | owner = person                     | the owner                                        |
 *  | owner = department/division + resp | the RESPONSIBLE person ("a unit cannot ship work")|
 *  | owner = unit, no responsible       | NONE — person grain simply excludes it            |
 *  | no assignee at all                 | NONE                                              |
 *
 *  A unit-assigned task therefore NEVER invents a person, and contributors are absent from this
 *  function entirely: owner-takes-all means contributors get their logged minutes
 *  (`minutes_contributed`) but not one unit of outcome credit — which is exactly what keeps
 *  Σperson ≤ Σunit = company true instead of double-counting an outcome. */
export function attributePerson(task: Pick<TaskFactInput, "ownerKind" | "ownerUserId" | "responsibleUserId">): string | null {
  if (task.ownerKind === "person") return task.ownerUserId;
  if (task.ownerKind === "department" || task.ownerKind === "division") return task.responsibleUserId;
  return null;
}

export interface UnitAttribution {
  unitNodeId: string | null;
  unitTenantId: string | null;
  departmentNodeId: string | null;
  providerTenantId: string | null;
  providerUnitNodeId: string | null;
  precedence: ResolutionPrecedence;
}

/** Gather the four §3.2 inputs and delegate to `resolveDepartment` (TR-04). The only logic here is
 *  input GATHERING — which membership lookup to hand in, and whether an ACTIVE provider edge
 *  covers the unit that lookup resolves to. */
function resolveUnit(
  inputs: FactSliceInputs,
  opts: { ownerUnitNodeId: string | null; userId: string | null; projectDepartmentId: string | null },
): UnitAttribution {
  const candidates = opts.userId ? inputs.memberships[opts.userId] ?? [] : [];
  let chosen: PersonMembershipLookup | null = null;
  let asOfUnit: string | null = null;
  for (const candidate of candidates) {
    const interval = resolveMembershipAsOf(candidate.intervals, inputs.factDate);
    if (interval) {
      chosen = candidate;
      asOfUnit = interval.unitNodeId;
      break;
    }
  }
  // Ruling 2: the ACTIVE-edge test gates the STAMP only. `chosen` above was selected without ever
  // consulting service_assignments, so a suspended/revoked edge cannot move the person's unit.
  const activeServiceAssignment =
    chosen !== null && asOfUnit !== null && inputs.activeProviderUnits.has(`${chosen.tenantId}|${asOfUnit}`);

  const resolved = resolveDepartment({
    ownerUnitNodeId: opts.ownerUnitNodeId,
    personMembership: chosen,
    asOfDate: inputs.factDate,
    projectDepartmentId: opts.projectDepartmentId,
    factTenantId: inputs.tenantId,
    activeServiceAssignment,
  });

  return {
    unitNodeId: resolved.unitNodeId,
    unitTenantId: resolved.unitTenantId,
    departmentNodeId: rollToDepartment(inputs, resolved.unitNodeId, resolved.unitTenantId),
    providerTenantId: resolved.providerTenantId,
    providerUnitNodeId: resolved.providerUnitNodeId,
    precedence: resolved.precedence,
  };
}

/** §3.1: "Divisions roll up to their ancestor department via the org-blob path; facts store both
 *  `unit_node_id` (exact) and `department_node_id` (rolled) so both slices are additive."
 *
 *  A unit resolved out of ANOTHER tenant's org tree (the cross-company ② case) cannot be rolled:
 *  walking that tree needs a read of the foreign tenant's `company_org_structure`, and this
 *  slice's transaction is authorized for exactly one tenant (D5). It is therefore carried through
 *  unrolled. That is safe for the surfaces that read it — the provider view reads
 *  `{unit, servedTenant}` off `provider_*` via the rollup engine (§3.2, the D12-sanctioned path),
 *  not `department_node_id` — and it is recorded as a known limitation in the ticket report. */
function rollToDepartment(inputs: FactSliceInputs, unitNodeId: string | null, unitTenantId: string | null): string | null {
  if (!unitNodeId) return null;
  if (unitTenantId !== inputs.tenantId) return unitNodeId;
  return inputs.unitDepartment[unitNodeId] ?? unitNodeId;
}

// ═══════════════════════════════ PURE CORE — the accumulator ═══════════════════════════════

interface Bucket extends FactRow {
  /** Number of contributions that agreed on the unique key but disagreed on a derived column
   *  (provider stamp / rolled department). Zero in every correct run; surfaced as a warning by
   *  computeFactRows' caller rather than silently merged, and never allowed to become a duplicate
   *  row (which would abort the whole slice on the UNIQUE key). */
  keyConflicts: number;
}

const EMPTY_MEASURES = {
  tasksCompleted: 0,
  tasksCompletedOnTime: 0,
  tasksCompletedWithDueDate: 0,
  tasksCompletedEstimated: 0,
  estimateMinutesCompleted: 0,
  estimateMinutesCompletedWithActual: 0,
  minutesLoggedCompletedWithActual: 0,
  tasksReopened: 0,
  tasksCreated: 0,
  minutesLogged: 0,
  minutesBillable: 0,
  minutesContributed: 0,
  commentsAuthored: 0,
  docsUpdated: 0,
  activityEvents: 0,
  activityLinkedExact: 0,
};

/** The pure computation. Deterministic: same inputs → same rows in the same order, which is what
 *  makes the idempotency guarantee testable at all. */
export function computeFactRows(inputs: FactSliceInputs): { rows: FactRow[]; keyConflicts: number } {
  const buckets = new Map<string, Bucket>();

  const bucketFor = (userId: string | null, projectId: string | null, attribution: UnitAttribution): Bucket => {
    // The key is EXACTLY the table's UNIQUE NULLS NOT DISTINCT tuple (ruling 7).
    const key = `${userId ?? " "}|${projectId ?? " "}|${attribution.unitNodeId ?? " "}`;
    const existing = buckets.get(key);
    if (existing) {
      if (
        existing.departmentNodeId !== attribution.departmentNodeId ||
        existing.providerTenantId !== attribution.providerTenantId ||
        existing.providerUnitNodeId !== attribution.providerUnitNodeId
      ) {
        existing.keyConflicts += 1;
      }
      return existing;
    }
    const created: Bucket = {
      factDate: inputs.factDate,
      userId,
      projectId,
      unitNodeId: attribution.unitNodeId,
      departmentNodeId: attribution.departmentNodeId,
      providerTenantId: attribution.providerTenantId,
      providerUnitNodeId: attribution.providerUnitNodeId,
      ...EMPTY_MEASURES,
      activityBySource: {},
      keyConflicts: 0,
    };
    buckets.set(key, created);
    return created;
  };

  // ── (1) task outcomes — owner-takes-all (§3.1) ───────────────────────────────────────────────
  for (const task of inputs.tasks) {
    const userId = attributePerson(task);
    const attribution = resolveUnit(inputs, {
      // ① fires only for a UNIT owner. For a person owner this is null so ② (the owner's own
      // as-of membership) decides, which is what §3.1's first row prescribes.
      ownerUnitNodeId: task.ownerKind === "department" || task.ownerKind === "division" ? task.ownerUnitNodeId : null,
      userId,
      projectDepartmentId: task.projectDepartmentId,
    });
    const bucket = bucketFor(userId, task.projectId, attribution);
    if (task.completed) {
      bucket.tasksCompleted += 1;
      // On-time is only meaningful against a due date. A task with no due date is counted in
      // `tasks_completed` (and, TR-08: NOT in `tasks_completed_with_due_date`) but in NEITHER
      // on-time nor late.
      if (task.dueDate !== null) {
        bucket.tasksCompletedWithDueDate += 1;
        if (inputs.factDate <= task.dueDate) bucket.tasksCompletedOnTime += 1;
      }
      if (task.estimateMinutes !== null) {
        bucket.tasksCompletedEstimated += 1;
        bucket.estimateMinutesCompleted += task.estimateMinutes;
        // TR-08 (§15 ruling ②'s second gap, metric #13): only counted when the task ALSO has
        // logged minutes — a completed+estimated task with zero time entries would otherwise
        // silently drag the ratio toward "way over budget" for work nobody logged against.
        if (task.actualMinutesLogged > 0) {
          bucket.estimateMinutesCompletedWithActual += task.estimateMinutes;
          bucket.minutesLoggedCompletedWithActual += task.actualMinutesLogged;
        }
      }
    }
    if (task.reopened) bucket.tasksReopened += 1;
    if (task.created) bucket.tasksCreated += 1;
  }

  // ── (2) effort — the logging person's OWN axis (precedence ②, never ①) ───────────────────────
  // Deliberate: minutes are the PERSON's effort, so they roll up to the person's own as-of
  // department. Using the owner-unit rule here would move a shared-service person's hours into the
  // served company's department and erase the provider stamp §3.2 requires for exactly that case.
  for (const entry of inputs.timeEntries) {
    const attribution = resolveUnit(inputs, {
      ownerUnitNodeId: null,
      userId: entry.userId,
      projectDepartmentId: null,
    });
    const bucket = bucketFor(entry.userId, entry.projectId, attribution);
    bucket.minutesLogged += entry.minutes;
    if (entry.billable) bucket.minutesBillable += entry.minutes;
    if (entry.taskRole === "contributor") bucket.minutesContributed += entry.minutes;
  }

  // ── (3) evidence — actor axis; NULL actor stays person-unattributed (ruling 1) ────────────────
  for (const activity of inputs.activities) {
    const attribution = resolveUnit(inputs, {
      ownerUnitNodeId: null,
      userId: activity.actorUserId,
      // A system/AI activity has no person, so ② cannot fire — ③ keeps it on the UNIT axis
      // instead of dropping it, which is what keeps Σunit = company with the unattributed bucket
      // explicit rather than hidden.
      projectDepartmentId: null,
    });
    const bucket = bucketFor(activity.actorUserId, activity.projectId, attribution);
    bucket.activityEvents += 1;
    if (activity.hasExactLink) bucket.activityLinkedExact += 1;
    bucket.activityBySource[activity.source] = (bucket.activityBySource[activity.source] ?? 0) + 1;
    if (activity.objectKind === "pm_task" && activity.verb === "commented") bucket.commentsAuthored += 1;
    if (activity.objectKind === "doc" && (activity.verb === "created" || activity.verb === "updated" || activity.verb === "restored")) {
      bucket.docsUpdated += 1;
    }
  }

  // Deterministic output order (NULLs last within each axis) so two runs produce byte-identical
  // INSERT streams, not merely equal sets.
  const nullsLast = (a: string | null, b: string | null): number => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  };
  const rows = [...buckets.values()].sort(
    (a, b) =>
      nullsLast(a.userId, b.userId) || nullsLast(a.projectId, b.projectId) || nullsLast(a.unitNodeId, b.unitNodeId),
  );
  const keyConflicts = rows.reduce((sum, r) => sum + r.keyConflicts, 0);
  return { rows: rows.map(({ keyConflicts: _drop, ...row }) => row), keyConflicts };
}

// ═══════════════════════════════ PURE CORE — org-blob unit → department ═══════════════════════

export interface OrgNodeLike {
  id?: string;
  kind?: string;
  children?: OrgNodeLike[];
}

/** Walk the tenant's org blob and map every department/division node id to its rolled DEPARTMENT:
 *  a department maps to itself; a division maps to its nearest department ancestor (and to itself
 *  when it has none, so the value is never null and the dept slice never silently loses rows).
 *
 *  Pure, and deliberately a different function from dept-resolution.ts's `deriveBlobPlacements`
 *  (which maps PERSONS to units) — this one maps UNITS to departments. Same blob, different index. */
export function deriveUnitDepartments(root: OrgNodeLike | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root) return out;
  const walk = (node: OrgNodeLike, inheritedDepartment: string | null): void => {
    let departmentForSubtree = inheritedDepartment;
    if (node.id) {
      if (node.kind === "department") {
        departmentForSubtree = node.id;
        out[node.id] = node.id;
      } else if (node.kind === "division") {
        out[node.id] = inheritedDepartment ?? node.id;
      }
    }
    for (const child of node.children ?? []) walk(child, departmentForSubtree);
  };
  walk(root, null);
  return out;
}

// ═══════════════════════════════ PURE CORE — §5.3 check-in expectation ═══════════════════════

export interface WorkCalendar {
  /** ISO day-of-week, Mon=1 … Sun=7. */
  workingDays: number[];
  /** 'YYYY-MM-DD' holiday dates. */
  holidays: string[];
  workdayMinutes: number;
}

export const DEFAULT_WORK_CALENDAR: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: [], workdayMinutes: 480 };

/** ISO day-of-week (Mon=1 … Sun=7) of a 'YYYY-MM-DD' date, in UTC — the same calendar-day basis
 *  every other date in this program uses (dept-resolution.ts's todayIso). */
export function isoDayOfWeek(dateIso: string): number {
  const dow = new Date(`${dateIso}T00:00:00.000Z`).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

export interface CheckinExpectationInput {
  date: string;
  calendar: WorkCalendar;
  /** Users with an employment-active (open or date-covering) primary membership in this tenant. */
  employed: string[];
  /** Users with an APPROVED `hr_leave_requests` row covering the date. */
  approvedLeave: string[];
  /** Users whose `hr_attendance` row for the date is 'leave' or 'absent'. */
  attendanceOff: string[];
}

/** §5.3's false-negative guard, in one pure predicate:
 *
 *   expected(user, date) = working-day(tenant calendar) ∧ ¬holiday ∧ ¬approved-leave
 *                          ∧ ¬attendance(leave|absent) ∧ open membership exists
 *
 *  A person on approved leave, or on a holiday, or on a non-working weekday, is NOT expected —
 *  so the nightly job never writes an `auto_missed` row for them and metric #18 never punishes
 *  them for a day they were never supposed to check in on. Returns a sorted list so the caller's
 *  writes (and its tests) are deterministic. */
export function expectedCheckinUsers(input: CheckinExpectationInput): string[] {
  if (!input.calendar.workingDays.includes(isoDayOfWeek(input.date))) return [];
  if (input.calendar.holidays.includes(input.date)) return [];
  const excused = new Set([...input.approvedLeave, ...input.attendanceOff]);
  return [...new Set(input.employed)].filter((u) => !excused.has(u)).sort();
}

// ═══════════════════════════════ I/O EDGE — foreign (provider) context ═══════════════════════

/** Everything about OTHER tenants this job needs, gathered once per window because none of it is
 *  date-dependent (membership INTERVALS are; which tenants/units exist is not). */
export interface ForeignContext {
  /** userId → PersonMembershipLookup per provider tenant, ascending tenant id. */
  memberships: Record<string, PersonMembershipLookup[]>;
  /** `${providerTenantId}|${unitNodeId}` for ACTIVE edges only. */
  activeProviderUnits: Set<string>;
}

const EMPTY_FOREIGN: ForeignContext = { memberships: {}, activeProviderUnits: new Set() };

/** Discover the provider tenants that serve `tenantId` and read their org placements.
 *
 *  Two-step ON PURPOSE, and each step is a SINGLE-tenant `withTenants` call (the lint's rule, and
 *  D5's): step 1 reads `service_assignments` from the SERVED side (0026's `sa_select` policy allows
 *  either side of the edge), which is the bounded, non-guessable set of foreign tenants this
 *  tenant is legitimately entangled with. Step 2 then enters each provider tenant's own scope to
 *  read its `org_unit_memberships` + `org_units` — a foreign tenant's org tree is simply not
 *  visible from the served tenant's scope, so there is no way to fold this into one transaction.
 *
 *  Ruling 2 is why step 1 does NOT filter on status: a suspended edge must still let the person's
 *  own unit resolve. Only `activeProviderUnits` (the STAMP source) is status-filtered. */
export async function gatherForeignContext(tenantId: string): Promise<ForeignContext> {
  const edges = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ provider_tenant_id: string; unit_id: string; status: string }>(
        `SELECT provider_tenant_id, unit_id, status FROM service_assignments WHERE target_tenant_id = $1`,
        [tenantId],
      ),
    { modules: [...REPORT_JOB_MODULES] },
  );
  if (edges.rows.length === 0) return EMPTY_FOREIGN;

  const providerTenants = [...new Set(edges.rows.map((e) => e.provider_tenant_id))].sort();
  const memberships: Record<string, PersonMembershipLookup[]> = {};
  const activeProviderUnits = new Set<string>();

  for (const providerTenantId of providerTenants) {
    const activeUnitIds = edges.rows.filter((e) => e.provider_tenant_id === providerTenantId && e.status === "active").map((e) => e.unit_id);
    // Single-element tenant array per call — one provider tenant at a time, never a widened set.
    const { intervals, activeNodes } = await withTenants(
      [providerTenantId],
      async (c) => {
        const mem = await c.query<{ user_id: string; unit_node_id: string; valid_from: string; valid_to: string | null }>(
          `SELECT user_id, unit_node_id, valid_from::text AS valid_from, valid_to::text AS valid_to
             FROM org_unit_memberships
            WHERE tenant_id = $1 AND is_primary
            ORDER BY user_id, valid_from`,
          [providerTenantId],
        );
        const units = activeUnitIds.length
          ? await c.query<{ node_id: string }>(
              `SELECT node_id FROM org_units WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
              [providerTenantId, activeUnitIds],
            )
          : { rows: [] as { node_id: string }[] };
        return { intervals: mem.rows, activeNodes: units.rows.map((u) => u.node_id) };
      },
      { modules: [...REPORT_JOB_MODULES] },
    );

    for (const nodeId of activeNodes) activeProviderUnits.add(`${providerTenantId}|${nodeId}`);
    const byUser = new Map<string, MembershipInterval[]>();
    for (const row of intervals) {
      const list = byUser.get(row.user_id) ?? [];
      list.push({ unitNodeId: row.unit_node_id, validFrom: row.valid_from, validTo: row.valid_to });
      byUser.set(row.user_id, list);
    }
    for (const [userId, list] of byUser) {
      (memberships[userId] ??= []).push({ tenantId: providerTenantId, intervals: list });
    }
  }
  return { memberships, activeProviderUnits };
}

// ═══════════════════════════════ I/O EDGE — the slice gather ═══════════════════════════════

/** Guard so a malformed `work_activity_links.target_id` can never abort a whole nightly slice on a
 *  `::uuid` cast. target_kind='project' targets are uuids by construction; this is insurance. */
const UUID_SQL_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Read every input for one (tenant, date) slice. Runs inside the CALLER's transaction so the
 *  gather and the DELETE+INSERT are one atomic unit (invariant 5). */
export async function gatherSliceInputs(
  c: PoolClient,
  tenantId: string,
  factDate: string,
  foreign: ForeignContext,
  tz: string,
): Promise<FactSliceInputs> {
  // ── (a) which tasks produced an outcome event on this day ──────────────────────────────────
  // Done-ness comes from the verbs the consumer derived off the is_done FLAG (ruling 3), never a
  // status id. `bool_or` collapses a same-day ping-pong to one completion / one reopen.
  const events = await c.query<{ task_id: string; completed: boolean; reopened: boolean; created: boolean }>(
    `SELECT object_ref AS task_id,
            bool_or(verb = 'completed') AS completed,
            bool_or(verb = 'reopened')  AS reopened,
            bool_or(verb = 'created')   AS created
       FROM work_activity
      WHERE tenant_id = $1
        AND source = 'pm' AND object_kind = 'pm_task'
        AND verb IN ('completed','reopened','created')
        AND object_ref ~ $4
        AND (occurred_at AT TIME ZONE $3)::date = $2::date
      GROUP BY object_ref`,
    [tenantId, factDate, tz, UUID_SQL_RE],
  );

  let tasks: TaskFactInput[] = [];
  if (events.rows.length > 0) {
    const taskIds = events.rows.map((e) => e.task_id);
    // Ruling 5: soft-deleted tasks ARE in pm_task_assignees on purpose, so `deleted_at IS NULL` is
    // filtered HERE. Without it every completion count silently inflates with archived work.
    //
    // TR-34 (0063, §15 ①): owner/responsible are now interval-tracked, so this join resolves them
    // AS OF `factDate` — inclusive both ends, NULL valid_to = open — the identical semantics
    // `resolveMembershipAsOf` (core/dept-resolution.ts) uses for the unit axis, expressed here as a
    // SQL predicate rather than a JS array scan because this is a batch join over every task that
    // produced an event today, not a per-user array lookup. The 0063 EXCLUDE constraint guarantees
    // at most one row per (task, role) matches at any given date, so this LEFT JOIN never fans out.
    // WITHOUT this filter, a task reassigned after `factDate` would resolve to TODAY's owner when a
    // PAST slice is recomputed — exactly the bug this ticket exists to close.
    const attribution = await c.query<{
      id: string;
      project_id: string;
      department_id: string | null;
      due_date: string | null;
      estimate_minutes: number | null;
      owner_kind: AssigneeKind | null;
      owner_user_id: string | null;
      owner_ref: string | null;
      responsible_user_id: string | null;
    }>(
      `SELECT t.id, t.project_id, p.department_id,
              t.due_date::text AS due_date, t.estimate_minutes,
              o.assignee_kind AS owner_kind, o.user_id AS owner_user_id, o.assignee_ref AS owner_ref,
              r.user_id AS responsible_user_id
         FROM pm_tasks t
         JOIN projects p ON p.id = t.project_id AND p.tenant_id = t.tenant_id
         LEFT JOIN pm_task_assignees o
                ON o.tenant_id = t.tenant_id AND o.task_id = t.id AND o.role = 'owner'
               AND o.valid_from <= $3::date AND (o.valid_to IS NULL OR o.valid_to >= $3::date)
         LEFT JOIN pm_task_assignees r
                ON r.tenant_id = t.tenant_id AND r.task_id = t.id AND r.role = 'responsible'
               AND r.valid_from <= $3::date AND (r.valid_to IS NULL OR r.valid_to >= $3::date)
        WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.id = ANY($2::uuid[])`,
      [tenantId, taskIds, factDate],
    );
    const byTask = new Map(attribution.rows.map((r) => [r.id, r]));

    // TR-08 (§15 ruling ②'s second gap, metric #13 `effort.estimate_accuracy`): the CUMULATIVE
    // (all-time, not just this slice's date) minutes logged per task, so a task logged-before or
    // logged-after its completion day still matches. Scoped to just this day's completed tasks —
    // cheap, and never a per-tenant full-table scan. `deleted_at IS NULL` matches the same
    // soft-delete discipline as everywhere else in this file (ruling 5) — a voided time entry
    // must not count toward "actual" minutes.
    const actualMinutes = await c.query<{ pm_task_id: string; total: string }>(
      `SELECT pm_task_id, SUM(minutes) AS total
         FROM time_entries
        WHERE tenant_id = $1 AND pm_task_id = ANY($2::uuid[]) AND deleted_at IS NULL
        GROUP BY pm_task_id`,
      [tenantId, taskIds],
    );
    const actualMinutesByTask = new Map(actualMinutes.rows.map((r) => [r.pm_task_id, Number(r.total)]));

    tasks = events.rows
      .map((event) => {
        const row = byTask.get(event.task_id);
        if (!row) return null; // soft-deleted or hard-deleted task — deliberately not counted
        const isUnitOwner = row.owner_kind === "department" || row.owner_kind === "division";
        const input: TaskFactInput = {
          taskId: row.id,
          projectId: row.project_id,
          projectDepartmentId: row.department_id,
          dueDate: row.due_date,
          estimateMinutes: row.estimate_minutes,
          ownerKind: row.owner_kind,
          ownerUserId: row.owner_kind === "person" ? row.owner_user_id : null,
          ownerUnitNodeId: isUnitOwner ? row.owner_ref : null,
          responsibleUserId: row.responsible_user_id,
          completed: event.completed,
          reopened: event.reopened,
          created: event.created,
          actualMinutesLogged: actualMinutesByTask.get(row.id) ?? 0,
        };
        return input;
      })
      .filter((t): t is TaskFactInput => t !== null)
      .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  }

  // ── (b) effort ─────────────────────────────────────────────────────────────────────────────
  // TR-34 (0063): `task_role` decides `minutes_contributed` (§3.1's contributor rule, metric #15),
  // so it must resolve owner/responsible AS OF the time entry's OWN `entry_date` — the same class of
  // bug as the attribution query above: without the as-of filter, a task reassigned AFTER this entry
  // was logged would silently reclassify a past day's minutes from "owner's own hours" to
  // "contributed" (or vice versa) the moment the fact job recomputes. `contributor` is deliberately
  // left UNFILTERED by date (0063's design judgement: contributor rows are never interval-tracked —
  // their own lifecycle is add/remove, not open/close), so it falls back to whatever contributor rows
  // CURRENTLY exist when neither owner nor responsible resolves as-of that date.
  const time = await c.query<{
    user_id: string;
    project_id: string;
    minutes: number;
    billable: boolean;
    task_role: "owner" | "responsible" | "contributor" | null;
  }>(
    `SELECT te.user_id, te.project_id, te.minutes, te.billable,
            COALESCE(
              (SELECT a.role FROM pm_task_assignees a
                 WHERE a.tenant_id = te.tenant_id AND a.task_id = te.pm_task_id AND a.user_id = te.user_id
                   AND a.role IN ('owner', 'responsible')
                   AND a.valid_from <= te.entry_date AND (a.valid_to IS NULL OR a.valid_to >= te.entry_date)
                 ORDER BY CASE a.role WHEN 'owner' THEN 0 ELSE 1 END
                 LIMIT 1),
              (SELECT 'contributor' FROM pm_task_assignees a
                 WHERE a.tenant_id = te.tenant_id AND a.task_id = te.pm_task_id AND a.user_id = te.user_id
                   AND a.role = 'contributor'
                 LIMIT 1)
            ) AS task_role
       FROM time_entries te
      WHERE te.tenant_id = $1 AND te.entry_date = $2::date AND te.deleted_at IS NULL
      ORDER BY te.user_id, te.project_id, te.id`,
    [tenantId, factDate],
  );

  // ── (c) evidence ───────────────────────────────────────────────────────────────────────────
  const activity = await c.query<{
    id: string;
    source: string;
    actor_user_id: string | null;
    verb: string;
    object_kind: string;
    project_id: string | null;
    has_exact: boolean | null;
  }>(
    `SELECT wa.id, wa.source, wa.actor_user_id, wa.verb, wa.object_kind,
            pl.project_id, ex.has_exact
       FROM work_activity wa
       LEFT JOIN LATERAL (
         SELECT p.id AS project_id
           FROM work_activity_links l
           JOIN projects p ON p.id = l.target_id::uuid AND p.tenant_id = wa.tenant_id
          WHERE l.activity_id = wa.id AND l.target_kind = 'project' AND l.target_id ~ $4
          ORDER BY (l.confidence = 'exact') DESC, p.id
          LIMIT 1
       ) pl ON true
       LEFT JOIN LATERAL (
         SELECT true AS has_exact FROM work_activity_links l2
          WHERE l2.activity_id = wa.id AND l2.confidence = 'exact' LIMIT 1
       ) ex ON true
      WHERE wa.tenant_id = $1 AND (wa.occurred_at AT TIME ZONE $3)::date = $2::date
      ORDER BY wa.id`,
    [tenantId, factDate, tz, UUID_SQL_RE],
  );

  // ── (d) the fact tenant's OWN memberships, prepended so they always beat a foreign tree ────
  const own = await c.query<{ user_id: string; unit_node_id: string; valid_from: string; valid_to: string | null }>(
    `SELECT user_id, unit_node_id, valid_from::text AS valid_from, valid_to::text AS valid_to
       FROM org_unit_memberships
      WHERE tenant_id = $1 AND is_primary
      ORDER BY user_id, valid_from`,
    [tenantId],
  );
  const memberships: Record<string, PersonMembershipLookup[]> = {};
  const ownByUser = new Map<string, MembershipInterval[]>();
  for (const row of own.rows) {
    const list = ownByUser.get(row.user_id) ?? [];
    list.push({ unitNodeId: row.unit_node_id, validFrom: row.valid_from, validTo: row.valid_to });
    ownByUser.set(row.user_id, list);
  }
  for (const [userId, list] of ownByUser) memberships[userId] = [{ tenantId, intervals: list }];
  for (const [userId, lookups] of Object.entries(foreign.memberships)) {
    memberships[userId] = [...(memberships[userId] ?? []), ...lookups];
  }

  // ── (e) unit → department roll, off the tenant's own org blob ───────────────────────────────
  const blob = await c.query<{ structure: OrgNodeLike }>(
    `SELECT structure FROM company_org_structure WHERE tenant_id = $1`,
    [tenantId],
  );

  return {
    tenantId,
    factDate,
    tasks,
    timeEntries: time.rows.map((r) => ({
      userId: r.user_id,
      projectId: r.project_id,
      minutes: Number(r.minutes),
      billable: r.billable,
      taskRole: r.task_role,
    })),
    activities: activity.rows.map((r) => ({
      activityId: r.id,
      source: r.source,
      actorUserId: r.actor_user_id,
      projectId: r.project_id,
      verb: r.verb,
      objectKind: r.object_kind,
      hasExactLink: r.has_exact === true,
    })),
    memberships,
    activeProviderUnits: foreign.activeProviderUnits,
    unitDepartment: deriveUnitDepartments(blob.rows[0]?.structure),
  };
}

// ═══════════════════════════════ I/O EDGE — the slice write ═══════════════════════════════

const INSERT_COLUMNS = 28; // TR-08 (0057) added 3: tasks_completed_with_due_date,
// estimate_minutes_completed_with_actual, minutes_logged_completed_with_actual
const INSERT_CHUNK = 200;

/** DELETE the whole (tenant, fact_date) slice, then INSERT the computed rows — invariant 5. Must
 *  be called inside a transaction (it is: `recomputeFactSlice` wraps it in one `withTenants`). */
export async function writeFactSlice(
  c: PoolClient,
  tenantId: string,
  factDate: string,
  rows: FactRow[],
  jobRunId: string,
): Promise<number> {
  await c.query(`DELETE FROM report_work_facts WHERE tenant_id = $1 AND fact_date = $2::date`, [tenantId, factDate]);
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((row, i) => {
      const base = i * INSERT_COLUMNS;
      params.push(
        factRowId(tenantId, factDate, row.userId, row.projectId, row.unitNodeId),
        tenantId,
        factDate,
        row.userId,
        row.projectId,
        row.unitNodeId,
        row.departmentNodeId,
        row.providerTenantId,
        row.providerUnitNodeId,
        row.tasksCompleted,
        row.tasksCompletedOnTime,
        row.tasksCompletedWithDueDate,
        row.tasksCompletedEstimated,
        row.estimateMinutesCompleted,
        row.estimateMinutesCompletedWithActual,
        row.minutesLoggedCompletedWithActual,
        row.tasksReopened,
        row.tasksCreated,
        row.minutesLogged,
        row.minutesBillable,
        row.minutesContributed,
        row.commentsAuthored,
        row.docsUpdated,
        row.activityEvents,
        row.activityLinkedExact,
        JSON.stringify(row.activityBySource),
        jobRunId,
        // Ruling 6: origin_site has NO column default by design — pass it explicitly, always.
        config.originSite,
      );
      const placeholders = Array.from({ length: INSERT_COLUMNS }, (_, k) => `$${base + k + 1}`);
      // fact_date / project cast so a 'YYYY-MM-DD' string and a uuid bind correctly.
      placeholders[2] = `${placeholders[2]}::date`;
      return `(${placeholders.join(",")})`;
    });
    await c.query(
      `INSERT INTO report_work_facts (
         id, tenant_id, fact_date, user_id, project_id, unit_node_id, department_node_id,
         provider_tenant_id, provider_unit_node_id,
         tasks_completed, tasks_completed_on_time, tasks_completed_with_due_date,
         tasks_completed_estimated, estimate_minutes_completed,
         estimate_minutes_completed_with_actual, minutes_logged_completed_with_actual,
         tasks_reopened, tasks_created, minutes_logged, minutes_billable, minutes_contributed,
         comments_authored, docs_updated, activity_events, activity_linked_exact, activity_by_source,
         job_run_id, origin_site
       ) VALUES ${tuples.join(",")}`,
      params,
    );
  }
  return rows.length;
}

// ═══════════════════ I/O EDGE — §5.3 auto_missed check-ins (TR-09's substrate) ═══════════════

/** Write `auto_missed` rows for the expected-but-missing check-ins of one past day (§5.3).
 *
 *  Three deliberate guards:
 *   - ONLY for days strictly before `today`: marking the current day "missed" while people are
 *     still working would manufacture the exact false negative §5.3 exists to prevent.
 *   - `ON CONFLICT DO NOTHING` on (tenant, user, date): a submitted or manager-excused row is
 *     NEVER overwritten by a later recompute. This is why check-ins are not part of the
 *     DELETE+INSERT slice — that slice is derived data, a check-in is a person's own record.
 *   - `expectedCheckinUsers` (pure) decides expectation from calendar + holidays + APPROVED leave
 *     + attendance + employment, so a leave day never counts as a miss. */
export async function writeAutoMissedCheckins(
  c: PoolClient,
  tenantId: string,
  factDate: string,
  today: string,
): Promise<number> {
  if (!(factDate < today)) return 0;

  const cal = await c.query<{ working_days: number[]; holidays: unknown; workday_minutes: number }>(
    `SELECT working_days, holidays, workday_minutes FROM report_work_calendars WHERE tenant_id = $1`,
    [tenantId],
  );
  const calendarRow = cal.rows[0];
  const holidayList = Array.isArray(calendarRow?.holidays) ? (calendarRow.holidays as Array<{ date?: string } | string>) : [];
  const calendar: WorkCalendar = calendarRow
    ? {
        workingDays: calendarRow.working_days ?? DEFAULT_WORK_CALENDAR.workingDays,
        holidays: holidayList.map((h) => (typeof h === "string" ? h : h?.date ?? "")).filter((d) => d.length > 0),
        workdayMinutes: calendarRow.workday_minutes ?? DEFAULT_WORK_CALENDAR.workdayMinutes,
      }
    : DEFAULT_WORK_CALENDAR;

  const employed = await c.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND is_primary
        AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
    [tenantId, factDate],
  );
  if (employed.rows.length === 0) return 0;

  const leave = await c.query<{ subject_user_id: string }>(
    `SELECT DISTINCT subject_user_id FROM hr_leave_requests
      WHERE tenant_id = $1 AND status = 'approved' AND deleted_at IS NULL
        AND starts_on <= $2::date AND ends_on >= $2::date`,
    [tenantId, factDate],
  );
  const attendance = await c.query<{ subject_user_id: string }>(
    `SELECT subject_user_id FROM hr_attendance
      WHERE tenant_id = $1 AND day = $2::date AND status IN ('leave','absent')`,
    [tenantId, factDate],
  );

  const expected = expectedCheckinUsers({
    date: factDate,
    calendar,
    employed: employed.rows.map((r) => r.user_id),
    approvedLeave: leave.rows.map((r) => r.subject_user_id),
    attendanceOff: attendance.rows.map((r) => r.subject_user_id),
  });
  if (expected.length === 0) return 0;

  const { rowCount } = await c.query(
    `INSERT INTO report_checkins (tenant_id, user_id, checkin_date, status, source, origin_site)
     SELECT $1, u, $2::date, 'auto_missed', 'system', $4
       FROM unnest($3::uuid[]) AS u
      WHERE NOT EXISTS (
        SELECT 1 FROM report_checkins rc
         WHERE rc.tenant_id = $1 AND rc.user_id = u AND rc.checkin_date = $2::date
      )
     ON CONFLICT (tenant_id, user_id, checkin_date) DO NOTHING`,
    [tenantId, factDate, expected, config.originSite],
  );
  return rowCount ?? 0;
}

// ═══════════════════════════════ I/O EDGE — the drift sweep (§3.1 point 5) ═══════════════════

/** Per-tenant nightly blob↔rows drift sweep. Reuses TR-02's `logAssigneeDriftIfAny` verbatim —
 *  the blob-vs-rows comparison is NOT reimplemented here — over the tasks this slice actually
 *  touched, capped so one huge day cannot turn the sweep into the job's cost centre. Read-only and
 *  non-throwing by construction (that helper swallows and logs), so a drift finding reports a
 *  problem instead of failing the recompute. */
const DRIFT_SAMPLE_CAP = 50;

export async function sweepAssigneeDrift(c: PoolClient, tenantId: string, taskIds: string[]): Promise<number> {
  let drifted = 0;
  for (const taskId of taskIds.slice(0, DRIFT_SAMPLE_CAP)) {
    const result = await logAssigneeDriftIfAny(c, tenantId, taskId);
    if (result.drift) drifted += 1;
  }
  return drifted;
}

// ═══════════════════════════════ ORCHESTRATION ═══════════════════════════════

export interface SliceResult {
  tenantId: string;
  factDate: string;
  factRows: number;
  autoMissed: number;
  driftFindings: number;
  keyConflicts: number;
  jobRunId: string;
}

export interface RecomputeOptions {
  /** Pre-gathered foreign context (window runs gather it once and pass it to every slice). */
  foreign?: ForeignContext;
  /** One id per RUN, stamped on every row it writes (invariant 5's traceability). */
  jobRunId?: string;
  /** Overridable for tests; defaults to today in UTC. Only used to refuse auto_missed for
   *  today/future days. */
  today?: string;
  /** IANA zone the `occurred_at → fact_date` bucketing uses (§6.2's REPORTS_TZ). */
  tz?: string;
}

/** Recompute exactly ONE (tenant, date) slice: gather → compute (pure) → DELETE+INSERT, all in a
 *  single transaction with the three module scopes declared. Idempotent and convergent: run it any
 *  number of times, the slice ends up byte-identical apart from `computed_at` / `job_run_id`. */
export async function recomputeFactSlice(tenantId: string, factDate: string, opts: RecomputeOptions = {}): Promise<SliceResult> {
  const jobRunId = opts.jobRunId ?? randomUUID();
  const tz = opts.tz ?? config.reportsTz;
  const today = opts.today ?? todayIso();
  const foreign = opts.foreign ?? (await gatherForeignContext(tenantId));

  return withTenants(
    [tenantId],
    async (c) => {
      const inputs = await gatherSliceInputs(c, tenantId, factDate, foreign, tz);
      const { rows, keyConflicts } = computeFactRows(inputs);
      if (keyConflicts > 0) {
        // eslint-disable-next-line no-console
        console.warn("[REPORT-FACT-JOB] reports.fact_key_conflict", { tenantId, factDate, keyConflicts });
      }
      const factRows = await writeFactSlice(c, tenantId, factDate, rows, jobRunId);
      const autoMissed = await writeAutoMissedCheckins(c, tenantId, factDate, today);
      const driftFindings = await sweepAssigneeDrift(c, tenantId, inputs.tasks.map((t) => t.taskId));
      return { tenantId, factDate, factRows, autoMissed, driftFindings, keyConflicts, jobRunId };
    },
    { modules: [...REPORT_JOB_MODULES] },
  );
}

/** Inclusive [from, to] date list. Bounded by the caller (the endpoint enforces §6.2's 400-day
 *  ceiling) so an unbounded range can never be turned into an unbounded fact scan. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

export interface WindowResult {
  tenantId: string;
  from: string;
  to: string;
  days: number;
  factRows: number;
  autoMissed: number;
  driftFindings: number;
  jobRunId: string;
  slices: SliceResult[];
}

/** Recompute a whole window, one atomic slice at a time. Each day is its own transaction on
 *  purpose: a 60-day backfill must not hold one transaction open across the whole window, and a
 *  failure on day 40 must leave days 1–39 correctly written rather than rolling back a week of
 *  work. The foreign context is gathered ONCE for the window (it is not date-dependent). */
export async function recomputeFactWindow(
  tenantId: string,
  from: string,
  to: string,
  opts: RecomputeOptions = {},
): Promise<WindowResult> {
  const jobRunId = opts.jobRunId ?? randomUUID();
  const foreign = opts.foreign ?? (await gatherForeignContext(tenantId));
  const slices: SliceResult[] = [];
  for (const factDate of dateRange(from, to)) {
    slices.push(await recomputeFactSlice(tenantId, factDate, { ...opts, foreign, jobRunId }));
  }
  return {
    tenantId,
    from,
    to,
    days: slices.length,
    factRows: slices.reduce((n, s) => n + s.factRows, 0),
    autoMissed: slices.reduce((n, s) => n + s.autoMissed, 0),
    driftFindings: slices.reduce((n, s) => n + s.driftFindings, 0),
    jobRunId,
    slices,
  };
}

/** The nightly entry point: yesterday's slice for every company that has the `reports` module
 *  (own `enabled_modules` OR an ACTIVE service assignment — `isModuleEnabled`, the ONE place that
 *  OR lives). Per-tenant failures are logged and swallowed so one bad tenant cannot stop the
 *  estate, exactly like pm/burndown-job.ts.
 *
 *  NOT wired to a timer in main.ts by design: §10 rules that n8n orchestrates and platform-nest
 *  gains no scheduler — the flow calls `POST /api/:t/reports/facts/recompute`. This function
 *  exists for the ops/CLI path and so the "nightly" semantics are defined in exactly one place. */
export async function runNightlyFactJob(opts: RecomputeOptions & { date?: string } = {}): Promise<{
  tenants: number;
  skipped: number;
  errors: number;
  results: SliceResult[];
}> {
  const today = opts.today ?? todayIso();
  const factDate = opts.date ?? addDaysIso(today, -1);
  const { rows: companies } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`),
  );
  const results: SliceResult[] = [];
  let skipped = 0;
  let errors = 0;
  for (const { id: tenantId } of companies) {
    try {
      if (!(await isModuleEnabled(tenantId, "reports"))) {
        skipped += 1;
        continue;
      }
      results.push(await recomputeFactSlice(tenantId, factDate, { ...opts, today }));
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[REPORT-FACT-JOB] tenant ${tenantId} slice ${factDate} failed:`, (err as Error).message);
    }
  }
  return { tenants: results.length, skipped, errors, results };
}
