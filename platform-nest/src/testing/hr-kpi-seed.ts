// Test seeding shared by the HR functional readers' database tests (DW-7j: f3, f4, f5, f6). Not a test file.
// Every helper writes through the app role (RLS-bound) under the module wall the table needs, so a seed row proves the reader's
// own scope the same way production data would. Timestamps are passed in by the test (build them with `at()` from
// dept-kpi-seed.ts) so a boundary never assumes the zone.
import type { PoolClient } from "pg";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { addMembership } from "./fixtures";

export const HR = { modules: ["hr"] };
export const LMS_HR = { modules: ["lms", "hr"] };

export const withHr = <T>(tenant: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenants([tenant], fn, HR);
export const withLmsHr = <T>(tenant: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenants([tenant], fn, LMS_HR);

let seq = 0;
const next = () => (seq += 1);

/** The company's DEFAULT holiday calendar (Sat+Sun weekend) with `holidays` as [day, kind], plus an optional spare, non-default one. */
export async function seedHolidayCalendar(
  tenant: string,
  holidays: Array<[string, "public" | "joint_leave" | "company"]>,
  spare: Array<[string, "public" | "joint_leave" | "company"]> = [],
): Promise<void> {
  await withHr(tenant, async (c) => {
    const def = newId();
    await c.query(
      `INSERT INTO hr_holiday_calendars (id, tenant_id, name, weekend_days, is_default, origin_site) VALUES ($1,$2,'Default',ARRAY[6,7],true,$3)`,
      [def, tenant, config.originSite],
    );
    for (const [day, kind] of holidays) {
      await c.query(`INSERT INTO hr_holidays (id, tenant_id, calendar_id, day, name, kind) VALUES ($1,$2,$3,$4,'Holiday',$5)`, [newId(), tenant, def, day, kind]);
    }
    if (spare.length > 0) {
      const other = newId();
      await c.query(
        `INSERT INTO hr_holiday_calendars (id, tenant_id, name, weekend_days, is_default, origin_site) VALUES ($1,$2,'Spare',ARRAY[6,7],false,$3)`,
        [other, tenant, config.originSite],
      );
      for (const [day, kind] of spare) {
        await c.query(`INSERT INTO hr_holidays (id, tenant_id, calendar_id, day, name, kind) VALUES ($1,$2,$3,$4,'Spare holiday',$5)`, [newId(), tenant, other, day, kind]);
      }
    }
  });
}

// ── f3 · leave ─────────────────────────────────────────────────────────────────────────────────────

export interface LeaveSeed {
  tenant: string;
  subject: string;
  created: Date;
  status: "pending" | "approved" | "denied" | "cancelled";
  decidedAt?: Date | null;
  updatedAt?: Date;
  deleted?: boolean;
}

export async function seedLeave(s: LeaveSeed): Promise<void> {
  await withHr(s.tenant, (c) =>
    c.query(
      `INSERT INTO hr_leave_requests (id, tenant_id, subject_user_id, leave_type, starts_on, ends_on, minutes, status, decided_at, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,'vacation','2026-12-01','2026-12-01',480,$4,$5,$6,$7,$8)`,
      [
        newId(), s.tenant, s.subject, s.status, s.decidedAt ?? null, s.created, s.updatedAt ?? s.created,
        s.deleted ? new Date("2026-09-15T00:00:00Z") : null,
      ],
    ),
  );
}

// ── f4 · payroll ───────────────────────────────────────────────────────────────────────────────────

export interface PayrollSeed {
  tenant: string;
  actor: string;
  kind?: "regular" | "thr" | "bonus" | "final" | "correction";
  status: "draft" | "calculated" | "pending_approval" | "approved" | "paid" | "cancelled";
  payDate: string | null;
  paidAt?: Date | null;
  deleted?: boolean;
}

/** One run. Each gets its own period (a LIVE regular run per period is unique) and its own reference. */
export async function seedPayrollRun(s: PayrollSeed): Promise<void> {
  const n = next();
  const month = String((n % 12) + 1).padStart(2, "0");
  const year = 2000 + Math.floor(n / 12);
  await withHr(s.tenant, (c) =>
    c.query(
      `INSERT INTO hr_payroll_runs (id, tenant_id, reference, kind, period_start, period_end, pay_date, status, paid_at, created_by, deleted_at)
       VALUES ($1,$2,$3,$4,$5::date,$5::date + 27,$6::date,$7,$8,$9,$10)`,
      [
        newId(), s.tenant, `PR-${n}`, s.kind ?? "regular", `${year}-${month}-01`, s.payDate, s.status, s.paidAt ?? null, s.actor,
        s.deleted ? new Date("2026-09-15T00:00:00Z") : null,
      ],
    ),
  );
}

// ── f5 · hires ─────────────────────────────────────────────────────────────────────────────────────

export interface HireSeed {
  tenant: string;
  actor: string;
  /** The requisition's clocks. */
  openedAt: Date | null;
  approvedAt?: Date | null;
  /** The offer's conversion instant; `null` leaves the offer unconverted (a draft). */
  convertedAt: Date | null;
}

/** requisition -> candidate -> application -> employee -> offer. A converted offer carries its employee (ck_hr_offer_conversion). */
export async function seedHire(s: HireSeed): Promise<void> {
  const n = next();
  await withHr(s.tenant, async (c) => {
    const req = await c.query<{ id: string }>(
      `INSERT INTO hr_requisitions (tenant_id, reference, title, opened_at, approved_at, created_by) VALUES ($1,$2,'Role',$3,$4,$5) RETURNING id`,
      [s.tenant, `REQ-${n}`, s.openedAt, s.approvedAt ?? null, s.actor],
    );
    const cand = await c.query<{ id: string }>(`INSERT INTO hr_candidates (tenant_id, full_name) VALUES ($1,$2) RETURNING id`, [s.tenant, `Candidate ${n}`]);
    const app = await c.query<{ id: string }>(
      `INSERT INTO hr_applications (tenant_id, requisition_id, candidate_id, stage_key) VALUES ($1,$2,$3,'applied') RETURNING id`,
      [s.tenant, req.rows[0].id, cand.rows[0].id],
    );
    if (s.convertedAt === null) {
      await c.query(`INSERT INTO hr_offers (tenant_id, application_id, base_amount, created_by) VALUES ($1,$2,10000000,$3)`, [s.tenant, app.rows[0].id, s.actor]);
      return;
    }
    const emp = await c.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, display_name, hire_date, created_by) VALUES ($1,$2,'2026-01-01',$3) RETURNING id`,
      [s.tenant, `Hire ${n}`, s.actor],
    );
    await c.query(
      `INSERT INTO hr_offers (tenant_id, application_id, base_amount, status, employee_id, converted_at, created_by)
       VALUES ($1,$2,10000000,'converted',$3,$4,$5)`,
      [s.tenant, app.rows[0].id, emp.rows[0].id, s.convertedAt, s.actor],
    );
  });
}

// ── f6 · mandatory learning ────────────────────────────────────────────────────────────────────────

/** The org tree `root(company) > d-hr(department) > dv-sub(division)`, as `company_org_structure` stores it (`{ root }`). */
export async function seedOrgTree(tenant: string): Promise<void> {
  const root = {
    id: "root", kind: "company", name: "Root",
    children: [{ id: "d-hr", kind: "department", name: "HR", children: [{ id: "dv-sub", kind: "division", name: "Sub", children: [] }] }],
  };
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)`, [tenant, JSON.stringify({ root }), config.originSite]),
  );
}

/** A person on the roster: an active company membership and a primary org-unit membership `[from, to]` (`to` null = open). */
export async function seatPerson(tenant: string, user: string, unit: string, from = "2020-01-01", to: string | null = null): Promise<void> {
  await addMembership(tenant, user);
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
       VALUES ($1,$2,$3,$4,true,$5::date,$6::date,'manual',$7)`,
      [newId(), tenant, user, unit, from, to, config.originSite],
    ),
  );
}

/** A general-track path (a mandatory one needs track general: ck_lms_paths_mandatory_scope). */
export async function seedPath(
  tenant: string,
  o: { key: string; mandatory: boolean; status?: "draft" | "published" | "retired"; deleted?: boolean },
): Promise<string> {
  const id = newId();
  await withLmsHr(tenant, (c) =>
    c.query(
      `INSERT INTO lms_paths (id, tenant_id, path_key, title, track, status, is_mandatory, deleted_at, origin_site)
       VALUES ($1,$2,$3,$3,'general',$4,$5,$6,$7)`,
      [id, tenant, o.key, o.status ?? "published", o.mandatory, o.deleted ? new Date("2026-09-15T00:00:00Z") : null, config.originSite],
    ),
  );
  return id;
}

/** One enrolment. A `completed` one needs `completedAt` (ck_lms_enrollments_completed), and no other status may carry it. */
export async function seedEnrollment(
  tenant: string,
  o: { user: string; path: string; status: "assigned" | "in_progress" | "completed" | "waived" | "expired"; completedAt?: Date },
): Promise<void> {
  await withLmsHr(tenant, (c) =>
    c.query(
      `INSERT INTO lms_enrollments (id, tenant_id, subject_user_id, path_id, status, completed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), tenant, o.user, o.path, o.status, o.status === "completed" ? o.completedAt ?? null : null],
    ),
  );
}
