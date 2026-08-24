// The mandatory-path assignment runner — how "a general track every employee must pass" actually
// reaches people.
//
// Design: docs/blueprints/lms-foundation.md §4, L2. `lms_paths.is_mandatory` is the switch; this is
// what reads it.
//
// ── A SWEEP, NOT AN EVENT CONSUMER (stated in the L1 module contract, implemented here) ────────
// A new employee needs enrolling whether or not anybody emitted an event. A sweep is idempotent and
// self-healing: run it twice and the second run creates nothing; miss a run and the next one
// catches up. A missed event, by contrast, is silent and permanent — and the failure it produces is
// "somebody was never assigned the mandatory training", which nobody notices until an audit.
//
// ── WHAT COUNTS AS "EVERY EMPLOYEE" ───────────────────────────────────────────────────────────
// `employees.employment_status = 'active'` with a linked `user_id`, in this tenant, not deleted.
// The three exclusions are each deliberate:
//   * `pending_start` — not here yet. Assigning training with a due date to somebody who has not
//     started produces an overdue enrolment on day one.
//   * `terminated` — gone. A leaver showing as non-compliant is noise that makes the real number
//     unreadable.
//   * `on_leave` — INCLUDED. Somebody on leave is still an employee and their training is still
//     required; what changes is when they get to it, which is a due-date conversation rather than
//     an enrolment one.
//   * a row with no `user_id` cannot be enrolled at all — `lms_enrollments.subject_user_id`
//     references `users`. Those are counted and REPORTED, never silently skipped: an unlinked
//     employee is a real gap in coverage and looks identical to "everyone is enrolled" if dropped.
//
// ── AND WHAT IT WILL NOT DO ───────────────────────────────────────────────────────────────────
// It never touches an existing enrolment. Not to change a due date, not to re-open a waived one,
// not to re-assign a completed one. Re-certification after expiry is a separate concern with its
// own rules; a sweep that quietly re-enrolled people would make "completed" mean nothing.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";

export interface MandatoryCandidate {
  subjectUserId: string | null;
  displayName: string;
  employmentStatus: string;
}

export interface PathPlan {
  pathId: string;
  pathKey: string;
  title: string;
  dueDays: number | null;
  appliesTo: string;
  toEnrol: string[];
  alreadyEnrolled: number;
  completedOrWaived: number;
  unlinked: string[];
}

export interface AssignmentPlan {
  tenantId: string;
  activeEmployees: number;
  paths: PathPlan[];
  /** Employees with no `users` row — cannot be enrolled, and NOT silently dropped. */
  unlinkedEmployees: string[];
}

export interface AssignmentResult extends AssignmentPlan {
  enrolled: number;
  dryRun: boolean;
}

/**
 * Due date for a freshly created enrolment.
 *
 * Pure and exported so a test can pin it without a database: an off-by-one here is invisible in
 * production until somebody is reported overdue a day early, and by then the wrong dates are
 * already on hundreds of rows.
 */
export function dueDateFor(today: Date, dueDays: number | null): string | null {
  if (dueDays === null) return null;
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + dueDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Who is in scope for a mandatory path.
 *
 * Only `applies_to = 'all'` is implemented in L2, and an unrecognised scope returns NOBODY rather
 * than everybody. Failing closed matters here: 'unit' and 'discipline' arrive with L4, and the
 * alternative reading — treat an unknown scope as "all" — would enrol the whole company in a
 * department's path the moment somebody publishes one.
 */
export function inScopeFor(appliesTo: string, allActive: MandatoryCandidate[]): MandatoryCandidate[] {
  if (appliesTo === "all") return allActive;
  return [];
}

/** Read the plan without writing anything. The runner and the dry-run share this exact query. */
export async function planMandatoryAssignments(tenantId: string): Promise<AssignmentPlan> {
  return withTenants(
    [tenantId],
    async (c) => planInside(c, tenantId),
    // BOTH scopes: `employees` is an hr_* table and the enrolments are lms_*. This is the second
    // place in the module that opens two, and like the certification write in lms-learn.controller
    // it is called out rather than left to be discovered — every other query declares one.
    { modules: ["lms", "hr"] },
  );
}

async function planInside(c: PoolClient, tenantId: string): Promise<AssignmentPlan> {
  const employees = await c.query<{ user_id: string | null; display_name: string; employment_status: string }>(
    `SELECT user_id, display_name, employment_status
       FROM employees
      WHERE deleted_at IS NULL AND employment_status IN ('active','on_leave')
      ORDER BY display_name`,
  );
  const all: MandatoryCandidate[] = employees.rows.map((r) => ({
    subjectUserId: r.user_id,
    displayName: r.display_name,
    employmentStatus: r.employment_status,
  }));
  const unlinkedEmployees = all.filter((e) => !e.subjectUserId).map((e) => e.displayName);

  const paths = await c.query<{
    id: string; path_key: string; title: string; due_days: number | null; applies_to: string;
  }>(
    `SELECT id, path_key, title, due_days, applies_to
       FROM lms_paths
      WHERE is_mandatory AND status = 'published' AND deleted_at IS NULL
      ORDER BY path_key`,
  );

  const out: PathPlan[] = [];
  for (const p of paths.rows) {
    const scope = inScopeFor(p.applies_to, all);
    const linked = scope.filter((e) => e.subjectUserId).map((e) => e.subjectUserId!);
    // ANY existing row counts as enrolled, including completed and waived ones. A sweep that
    // re-enrolled a completed learner would make "completed" mean "completed since the last sweep".
    const existing = await c.query<{ subject_user_id: string; status: string }>(
      `SELECT subject_user_id, status FROM lms_enrollments WHERE path_id = $1`,
      [p.id],
    );
    const have = new Set(existing.rows.map((r) => r.subject_user_id));
    out.push({
      pathId: p.id,
      pathKey: p.path_key,
      title: p.title,
      dueDays: p.due_days,
      appliesTo: p.applies_to,
      toEnrol: linked.filter((u) => !have.has(u)),
      alreadyEnrolled: existing.rows.filter((r) => r.status === "assigned" || r.status === "in_progress").length,
      completedOrWaived: existing.rows.filter((r) => r.status === "completed" || r.status === "waived").length,
      unlinked: scope.filter((e) => !e.subjectUserId).map((e) => e.displayName),
    });
  }

  return { tenantId, activeEmployees: all.length, paths: out, unlinkedEmployees };
}

/**
 * Enrol everybody in scope for every published mandatory path.
 *
 * `dryRun` plans and reports without writing — the default for anything run against a live estate
 * for the first time, because the count it prints is the same count the real run will produce.
 */
export async function runMandatoryAssignment(
  tenantId: string, opts: { dryRun?: boolean; assignedBy?: string | null; today?: Date } = {},
): Promise<AssignmentResult> {
  const dryRun = opts.dryRun ?? false;
  const today = opts.today ?? new Date();

  return withTenants(
    [tenantId],
    async (c) => {
      const plan = await planInside(c, tenantId);
      let enrolled = 0;
      if (!dryRun) {
        for (const p of plan.paths) {
          const due = dueDateFor(today, p.dueDays);
          for (const userId of p.toEnrol) {
            // ON CONFLICT against the LIVE partial unique index, so two sweeps racing each other
            // (a cron and a hand-run) cannot double-enrol anybody.
            const r = await c.query(
              `INSERT INTO lms_enrollments (id, tenant_id, subject_user_id, path_id, source, assigned_by,
                                            status, due_on)
               VALUES ($1,$2,$3,$4,'auto',$5,'assigned',$6)
               ON CONFLICT DO NOTHING`,
              [newId(), tenantId, userId, p.pathId, opts.assignedBy ?? null, due],
            );
            enrolled += r.rowCount ?? 0;
          }
        }
      }
      return { ...plan, enrolled, dryRun };
    },
    { modules: ["lms", "hr"] },
  );
}
