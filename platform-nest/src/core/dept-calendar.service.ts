// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59; PERMISSION-CONTRACT §48; owner ruling DW-D33) — the department calendar:
//   GET /api/:tenantId/departments/:unitNodeId/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// This file is the window rule, the four legs and their SQL; dept-calendar.controller.ts is the gate (Cerbos, then the unit narrowing,
// then existence) and the answer's assembly.
//
// ── FOUR LEGS, EACH ISOLATED ─────────────────────────────────────────────────────────────────────
// Every leg is `{ included: true, items }` (a read that SUCCEEDED, an empty list included) or `{ included: false, reason }`:
// `module_off` (the owning module is not enabled for this company: `isModuleEnabled`, never `app_module_allowed`, which checks DECLARED
// scopes only) or `read_failed` (the leg threw; logged here, and the other three legs are untouched). A leg is never a fake empty. At
// most 200 items a leg, with `truncated: true` when more existed.
//
//   holidays   the company's DEFAULT holiday calendar. Its OWN query under the `hr` module wall (`withTenants(..., { modules: ["hr"] })`:
//              the hr_* tables read ZERO rows with no error without it).
//   away       DW-D33. APPROVED leave, for the people placed in the unit or below it TODAY. Its own query under the `hr` wall, and it
//              SELECTs exactly the five fields the contract names: the leave type is the only thing about the leave it shows. The
//              note, the minutes, the approver and the status are never fetched, so the answer cannot carry them. NEVER `listLeave`:
//              that reader degrades a refusal to the caller's own rows, and a colleague's leave read here widens no HR route.
//   deadlines  open milestones of the projects whose department is the unit or below it (`departmentFilterSql`, which carries the
//              tenant). Each project is re-checked for `pm_project · read` with the caller (Cerbos batches of at most 50); a project the
//              caller cannot read drops its milestones silently.
//   events     confirmed `company`-visible events, and `department`-visible events of the unit or a unit above it that the caller
//              reaches. The caller's private and attendee-only events are not here.
//
// ⚠ DAYS ARE THE DISPLAY ZONE'S for the event times: a window day `D` runs from D 00:00 to D+1 00:00 in `displayTimeZone()` (the zone the
// UI draws the month grid in and the notifications word their times in); an all-day event and a leave compare as plain dates.
import { withTenants } from "../db";
import { checkMany, type Resource } from "../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../rbac/principal";
import { isModuleEnabled } from "../modules/registry";
import { collectUnitSubtree, loadUnitRoster } from "../modules/reports/person-scope";
import { departmentFilterSql } from "./department-filter";
import { loadUnitAncestors } from "./org-unit-closure";
import { displayTimeZone, parseDay } from "./calendar-events.service";
import type { UnitReach } from "./unit-reach";

/** At most 42 days (a six-week month grid), counting both ends. */
export const WINDOW_MAX_DAYS = 42;
/** At most this many items a leg. */
export const LEG_CAP = 200;
/** The most projects one deadlines read checks with Cerbos; more than this and the leg is `truncated`. */
export const PROJECT_CANDIDATE_CAP = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A refusal the controller maps to a 400 `{ message, field }`. Pure data: no Nest import. */
export class DeptCalendarRuleError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "DeptCalendarRuleError";
  }
}

export interface CalendarWindow { from: string; to: string }

const dayOf = (s: string): number => new Date(`${s}T00:00:00.000Z`).getTime();

/** `?from=&to=`: both required `YYYY-MM-DD` real dates, `from <= to`, at most 42 days counting both ends. A bad value is a 400 naming
 *  the field. Run only AFTER the Cerbos `read_calendar` decision, so a refused caller never sees which part was wrong. */
export function parseWindow(query: Record<string, unknown>): CalendarWindow {
  const read = (field: "from" | "to"): string => {
    const v = query[field];
    if (typeof v !== "string" || v === "") throw new DeptCalendarRuleError(`${field} is required: a YYYY-MM-DD date`, field);
    try {
      return parseDay(v, field);
    } catch {
      throw new DeptCalendarRuleError(`${field} must be a real YYYY-MM-DD date`, field);
    }
  };
  const from = read("from");
  const to = read("to");
  if (to < from) throw new DeptCalendarRuleError("to must not be before from", "to");
  if ((dayOf(to) - dayOf(from)) / DAY_MS + 1 > WINDOW_MAX_DAYS) {
    throw new DeptCalendarRuleError(`the window is at most ${WINDOW_MAX_DAYS} days`, "to");
  }
  return { from, to };
}

/** The unit id in the path: the org node ids are short slugs or uuids, so this is a sanity bound, not a lookup (a well-formed id that
 *  names no node is a 404 after the narrowing). 1 to 200 characters, no control characters. */
export function checkUnitParam(raw: string): string {
  const bad = raw.length === 0 || raw.length > 200 || [...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (bad) throw new DeptCalendarRuleError("unitNodeId must be 1 to 200 characters with no control characters", "unitNodeId");
  return raw;
}

// ───────────────────────────────────────────── the answer's shapes ─────────────────────────────────────────────

export type LegReason = "module_off" | "read_failed";
export type Leg<T> = { included: true; items: T[]; truncated?: true } | { included: false; reason: LegReason };

export interface HolidayItem { day: string; name: string; kind: "public" | "joint_leave" | "company" }
/** EXACTLY these five fields (DW-D33): never minutes, the note, the approver or the status. */
export interface AwayItem { userId: string; name: string; startsOn: string; endsOn: string; leaveType: "vacation" | "sick" | "unpaid" | "other" }
export interface DeadlineItem { milestoneId: string; name: string; dueDate: string; projectId: string; projectName: string }
export interface EventItem {
  id: string; title: string;
  startsAt: string | null; endsAt: string | null; startsOn: string | null; endsOn: string | null;
  visibility: "company" | "department"; unitNodeId: string | null;
}

/** Cap a list read with `LEG_CAP + 1` rows: the first 200, and `truncated: true` only when a 201st existed. */
export function capLeg<T>(rows: readonly T[]): Leg<T> {
  return rows.length > LEG_CAP ? { included: true, items: rows.slice(0, LEG_CAP), truncated: true } : { included: true, items: [...rows] };
}

/** One leg: the module gate (`module_off`), then the read; a throw is logged WITH the leg and the unit and becomes `read_failed`, so one
 *  failing leg never fails the others. */
async function runLeg<T>(
  leg: string, tenantId: string, unitNodeId: string, module: "hr" | "pm" | null, read: () => Promise<Leg<T>>,
): Promise<Leg<T>> {
  try {
    if (module && !(await isModuleEnabled(tenantId, module))) return { included: false, reason: "module_off" };
    return await read();
  } catch (err) {
    console.error(`[dept-calendar] ${leg} leg failed (tenant=${tenantId}, unit=${unitNodeId}):`, (err as Error)?.message ?? err);
    return { included: false, reason: "read_failed" };
  }
}

// ───────────────────────────────────────────── holidays ─────────────────────────────────────────────

export function holidaysLeg(tenantId: string, unitNodeId: string, w: CalendarWindow): Promise<Leg<HolidayItem>> {
  return runLeg("holidays", tenantId, unitNodeId, "hr", () =>
    withTenants(
      [tenantId],
      async (c) => {
        const { rows } = await c.query<{ day: string; name: string; kind: HolidayItem["kind"] }>(
          `SELECT to_char(h.day, 'YYYY-MM-DD') AS day, h.name, h.kind
             FROM hr_holidays h
             JOIN hr_holiday_calendars cal ON cal.id = h.calendar_id AND cal.tenant_id = h.tenant_id
            WHERE h.tenant_id = $1 AND cal.is_default AND cal.deleted_at IS NULL
              AND h.day >= $2::date AND h.day <= $3::date
            ORDER BY h.day, h.name, h.id
            LIMIT ${LEG_CAP + 1}`,
          [tenantId, w.from, w.to],
        );
        return capLeg(rows.map((r) => ({ day: r.day, name: r.name, kind: r.kind })));
      },
      { modules: ["hr"] },
    ),
  );
}

// ───────────────────────────────────────────── away (DW-D33) ─────────────────────────────────────────────

/** Who is placed in the unit or below it TODAY (the roster is as of `asOf`, never the window: choosing a past window cannot widen who is
 *  shown), and their approved leave overlapping the window. */
export function awayLeg(tenantId: string, unitNodeId: string, structure: unknown, asOf: string, w: CalendarWindow): Promise<Leg<AwayItem>> {
  return runLeg("away", tenantId, unitNodeId, "hr", () =>
    withTenants(
      [tenantId],
      async (c) => {
        const roster = await loadUnitRoster(c, tenantId, collectUnitSubtree(structure, unitNodeId), asOf);
        if (roster.length === 0) return capLeg<AwayItem>([]);
        // EXACTLY the five fields. No `minutes`, `note`, `status`, `decided_by` or `approval_id` is named anywhere in this SELECT.
        const { rows } = await c.query<{ user_id: string; name: string; starts_on: string; ends_on: string; leave_type: AwayItem["leaveType"] }>(
          `SELECT r.subject_user_id AS user_id, u.name,
                  to_char(r.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(r.ends_on, 'YYYY-MM-DD') AS ends_on, r.leave_type
             FROM hr_leave_requests r
             JOIN users u ON u.id = r.subject_user_id
            WHERE r.tenant_id = $1 AND r.status = 'approved' AND r.deleted_at IS NULL
              AND r.subject_user_id = ANY($2::uuid[]) AND u.deleted_at IS NULL
              AND r.starts_on <= $4::date AND r.ends_on >= $3::date
            ORDER BY r.starts_on, u.name, r.id
            LIMIT ${LEG_CAP + 1}`,
          [tenantId, roster, w.from, w.to],
        );
        return capLeg(rows.map((r) => ({ userId: r.user_id, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, leaveType: r.leave_type })));
      },
      { modules: ["hr"] },
    ),
  );
}

// ───────────────────────────────────────────── deadlines ─────────────────────────────────────────────

/** `read` on each resource for the caller, and, when the caller acts for a human, for that human as well (both must allow): the
 *  intersection `authorize()` applies, which `checkMany` (advisory) does not. An unresolvable acting user fails CLOSED. */
async function readAllowed(principal: Principal, resources: readonly Resource[]): Promise<boolean[]> {
  const own = await checkMany(principal, resources, "read");
  if (!principal.actFor || principal.actFor.userId === principal.userId) return own;
  const onBehalfOf = await assemblePrincipal(principal.actFor.userId, principal.assurance);
  if (!onBehalfOf) return resources.map(() => false);
  const delegated = await checkMany({ ...onBehalfOf, via: principal.via }, resources, "read");
  return own.map((a, i) => a && delegated[i]);
}

export function deadlinesLeg(principal: Principal, tenantId: string, unitNodeId: string, w: CalendarWindow): Promise<Leg<DeadlineItem>> {
  const filter = departmentFilterSql({ kind: "unit", nodeId: unitNodeId }, "p.department_id", 1, 4);
  const where =
    `m.tenant_id = $1 AND m.deleted_at IS NULL AND m.status <> 'done'
        AND m.due_date >= $2::date AND m.due_date <= $3::date
        AND p.deleted_at IS NULL AND ${filter.sql}`;
  return runLeg("deadlines", tenantId, unitNodeId, "pm", async () => {
    // 1. the projects that have a matching milestone (their ids only), so the Cerbos check runs on projects, not on milestones.
    const candidates = await withTenants([tenantId], async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT DISTINCT p.id
           FROM pm_milestones m JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
          WHERE ${where}
          LIMIT ${PROJECT_CANDIDATE_CAP + 1}`,
        [tenantId, w.from, w.to, ...filter.params],
      );
      return rows.map((r) => r.id);
    }, { modules: ["pm"] });
    const clipped = candidates.length > PROJECT_CANDIDATE_CAP;
    const projectIds = clipped ? candidates.slice(0, PROJECT_CANDIDATE_CAP) : candidates;
    if (projectIds.length === 0) return capLeg<DeadlineItem>([]);

    // 2. Cerbos `pm_project · read` for the caller, in batches of at most 50 (`checkMany`). A Cerbos error throws: the leg is
    //    `read_failed`, never "no deadlines".
    const allowed = await readAllowed(principal, projectIds.map((id): Resource => ({ kind: "pm_project", tenantId, id })));
    const readable = projectIds.filter((_, i) => allowed[i]);
    if (readable.length === 0) return clipped ? { included: true, items: [], truncated: true } : capLeg<DeadlineItem>([]);

    // 3. the milestones of the readable projects.
    const rows = await withTenants([tenantId], async (c) => {
      const res = await c.query<{ id: string; name: string; due_date: string; project_id: string; project_name: string }>(
        `SELECT m.id, m.name, to_char(m.due_date, 'YYYY-MM-DD') AS due_date, p.id AS project_id, p.name AS project_name
           FROM pm_milestones m JOIN projects p ON p.id = m.project_id AND p.tenant_id = m.tenant_id
          WHERE ${where} AND p.id = ANY($${4 + filter.params.length}::uuid[])
          ORDER BY m.due_date, m.name, m.id
          LIMIT ${LEG_CAP + 1}`,
        [tenantId, w.from, w.to, ...filter.params, readable],
      );
      return res.rows;
    }, { modules: ["pm"] });
    const leg = capLeg(rows.map((r) => ({ milestoneId: r.id, name: r.name, dueDate: r.due_date, projectId: r.project_id, projectName: r.project_name })));
    return clipped && leg.included && !leg.truncated ? { ...leg, truncated: true } : leg;
  });
}

// ───────────────────────────────────────────── events (10c-2) ─────────────────────────────────────────────

/** `company`-visible events, and `department`-visible events of the unit or a unit ABOVE it, that the caller reaches (`reach`: the same
 *  predicate that gated the unit; a head of a unit reaches the units below it, never the ones above, so the ancestors are filtered). A
 *  timed event is in the window when it overlaps it, an all-day one when its inclusive date range meets it. Confirmed only.
 *
 *  The `calendar_event · read` decision for each visibility is asked of Cerbos first (the same decision the detail read and the `mine`
 *  list apply), so this leg never names an event title to a caller who could not open the event: the HR read tier ALONE reaches the
 *  calendar (`org_structure · read_calendar`) but holds no `calendar_event` read, and gets an empty events leg. */
export function eventsLeg(principal: Principal, tenantId: string, unitNodeId: string, reach: UnitReach, w: CalendarWindow): Promise<Leg<EventItem>> {
  return runLeg("events", tenantId, unitNodeId, null, async () => {
    const [companyOk, departmentOk] = await readAllowed(principal, [
      { kind: "calendar_event", tenantId, visibility: "company" },
      { kind: "calendar_event", tenantId, visibility: "department", unitNodeId },
    ]);
    if (!companyOk && !departmentOk) return capLeg<EventItem>([]);
    return withTenants([tenantId], async (c) => {
      const chain = await loadUnitAncestors(c, tenantId, unitNodeId);
      const units = [...new Set([unitNodeId, ...chain])].filter((u) => reach.reaches(u));
      const tz = displayTimeZone();
      const { rows } = await c.query<{
        id: string; title: string; starts_at: Date | null; ends_at: Date | null; starts_on: string | null; ends_on: string | null;
        visibility: EventItem["visibility"]; unit_node_id: string | null;
      }>(
        `SELECT e.id, e.title, e.starts_at, e.ends_at,
                to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(e.ends_on, 'YYYY-MM-DD') AS ends_on,
                e.visibility, e.unit_node_id
           FROM calendar_events e
          WHERE e.tenant_id = $1 AND e.status = 'confirmed'
            AND ((e.visibility = 'company' AND $6::boolean)
                 OR (e.visibility = 'department' AND $7::boolean AND e.unit_node_id = ANY($5::text[])))
            AND ((e.starts_at IS NOT NULL
                  AND e.starts_at < (($3::date + 1)::timestamp AT TIME ZONE $4::text)
                  AND e.ends_at > ($2::date::timestamp AT TIME ZONE $4::text))
              OR (e.starts_on IS NOT NULL AND e.starts_on <= $3::date AND e.ends_on >= $2::date))
          ORDER BY COALESCE(e.starts_at, (e.starts_on::timestamp AT TIME ZONE $4::text)), e.created_at, e.id
          LIMIT ${LEG_CAP + 1}`,
        [tenantId, w.from, w.to, tz, units, companyOk, departmentOk],
      );
      return capLeg(
        rows.map((r) => ({
          id: r.id, title: r.title,
          startsAt: r.starts_at ? r.starts_at.toISOString() : null, endsAt: r.ends_at ? r.ends_at.toISOString() : null,
          startsOn: r.starts_on, endsOn: r.ends_on, visibility: r.visibility, unitNodeId: r.unit_node_id,
        })),
      );
    });
  });
}
