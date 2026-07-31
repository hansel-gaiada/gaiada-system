// TR-08 — the reports RollupProvider against LIVE Postgres + real RLS.
//
// Covers the ticket's own acceptance bar:
//  * idempotent upsert into rollup_metrics (recompute twice, no duplicate rows, same values);
//  * a ratio_of_sums metric verified against a HAND-COMPUTED week (not asserted against the code
//    that produced it);
//  * #20 discipline.overdue_open does NOT multiply over a multi-day range (§5.4 regression);
//  * a days-denominated ratio on a deliberately awkward 11-day span crossing a month boundary,
//    proving the denominator is the ACTUAL day count, never an assumed 7 or 30;
//  * correct `dimensions` per grain (P {userId} / J {projectId} / D {unit} / C {}).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { registerModule, resetModules } from "../registry";
import { recomputeRollups, resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { reportsModule } from ".";
import { formatPeriodRange } from "./metrics";
import { recomputeFactWindow } from "./fact-job";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createProject, createUser } from "../../testing/fixtures";

describe.skipIf(!TEST_URL)("TR-08 report-rollups (live PG + RLS)", () => {
  let co: string;
  let alice: string;
  let projectId: string;

  async function addTimeEntry(userId: string, minutes: number, billable: boolean, date: string, pmTaskId: string | null = null): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, pm_task_id, minutes, billable, entry_date, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,'central')`,
        [newId(), co, userId, projectId, pmTaskId, minutes, billable, date],
      ),
    );
  }

  async function openMembership(userId: string, unitNodeId: string, validFrom = "2026-01-01"): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,$4,true,$5::date,'manual','central')`,
        [newId(), co, userId, unitNodeId, validFrom],
      ),
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(reportsModule);
    await syncMetricDefinitions();

    co = await createCompany("Reports Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr08.test");
    projectId = await createProject(co, "Website");
    await openMembership(alice, "d-eng");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  const metricRows = async (period: string, metricKey: string) =>
    (
      await withTenants([co], (c) =>
        c.query<{ numerator: string; denominator: string | null; dimensions: Record<string, unknown> }>(
          `SELECT numerator, denominator, dimensions FROM rollup_metrics
            WHERE tenant_id = $1 AND module = 'reports' AND metric_key = $2 AND period = $3
            ORDER BY dimensions::text`,
          [co, metricKey, period],
        ),
      )
    ).rows;

  // ═══════════════════ hand-computed week — effort.billable_share (ratio_of_sums) ═══════════════════

  describe("ratio_of_sums, hand-computed against a real week", () => {
    const WEEK_START = "2026-07-13"; // Monday
    const WEEK_END = "2026-07-19"; // Sunday
    const period = formatPeriodRange(WEEK_START, WEEK_END);

    beforeAll(async () => {
      // Hand-computed inputs: 120 (billable) + 60 (non-billable) + 90 (billable) = 270 total,
      // 210 billable. Expected billable_share = 210/270 — computed HERE, by hand, not derived
      // from the code under test.
      await addTimeEntry(alice, 120, true, "2026-07-13");
      await addTimeEntry(alice, 60, false, "2026-07-14");
      await addTimeEntry(alice, 90, true, "2026-07-16");
      await recomputeFactWindow(co, WEEK_START, WEEK_END);
      await recomputeRollups(co, period);
    });

    it("matches the hand-computed numerator/denominator at PERSON grain, dimensioned {userId}", async () => {
      const rows = await metricRows(period, "effort.billable_share");
      const aliceRow = rows.find((r) => r.dimensions.userId === alice);
      expect(aliceRow, "alice must have a billable_share row").toBeTruthy();
      expect(Number(aliceRow!.numerator)).toBe(210);
      expect(Number(aliceRow!.denominator)).toBe(270);
    });

    it("matches at COMPANY grain, dimensioned {} (single-person tenant here, so identical totals)", async () => {
      const rows = await metricRows(period, "effort.billable_share");
      const companyRow = rows.find((r) => Object.keys(r.dimensions).length === 0);
      expect(companyRow, "company-grain row must exist with dimensions {}").toBeTruthy();
      expect(Number(companyRow!.numerator)).toBe(210);
      expect(Number(companyRow!.denominator)).toBe(270);
    });

    it("matches at PROJECT grain, dimensioned {projectId}", async () => {
      const rows = await metricRows(period, "effort.billable_share");
      const projRow = rows.find((r) => r.dimensions.projectId === projectId);
      expect(projRow, "project-grain row must exist").toBeTruthy();
      expect(Number(projRow!.numerator)).toBe(210);
      expect(Number(projRow!.denominator)).toBe(270);
    });

    it("effort.minutes_logged (plain sum) has NO denominator", async () => {
      const rows = await metricRows(period, "effort.minutes_logged");
      const aliceRow = rows.find((r) => r.dimensions.userId === alice);
      expect(Number(aliceRow!.numerator)).toBe(270);
      expect(aliceRow!.denominator).toBeNull();
    });

    it("is idempotent: recomputing the SAME period twice writes no duplicate rows and the same values", async () => {
      const before = await metricRows(period, "effort.billable_share");
      await recomputeRollups(co, period);
      await recomputeRollups(co, period);
      const after = await metricRows(period, "effort.billable_share");
      expect(after.length).toBe(before.length); // no duplicate rows via the ON CONFLICT upsert
      expect(after).toEqual(before);
    });
  });

  // ═══════════════════ awkward span: 11 days crossing a month boundary ═══════════════════
  //
  // flow.wip_open_avg's denominator is the RANGE's real day count, not the numerator's row count
  // and not an assumed 7/30 — the cleanest possible proof, since it needs no calendar/leave
  // substrate at all: `Σ daily open / Σ days`, and Σ days is asserted to be exactly 11.

  describe("day-denominated ratio on a deliberately awkward 11-day span", () => {
    const SPAN_START = "2026-07-26";
    const SPAN_END = "2026-08-05"; // 11 inclusive days, crosses the Jul/Aug boundary
    const period = formatPeriodRange(SPAN_START, SPAN_END);
    let spanProject: string;

    beforeAll(async () => {
      spanProject = await createProject(co, "Span Project");
      // Snapshot rows on every day BUT one (2026-07-30) — a deliberate gap, so the numerator is
      // provably a genuine SUM of the rows that exist, not `open_count * 11`.
      const days = ["2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"];
      for (const d of days) {
        await withTenants([co], (c) =>
          c.query(
            `INSERT INTO pm_progress_snapshots (tenant_id, project_id, snapshot_date, open_count, done_count, avg_progress, origin_site)
             VALUES ($1,$2,$3::date,4,1,50,'central')`,
            [co, spanProject, d],
          ),
        );
      }
      await recomputeRollups(co, period);
    });

    it("denominator is the ACTUAL 11-day range length, never 7 or 30", async () => {
      const rows = await metricRows(period, "flow.wip_open_avg");
      const projRow = rows.find((r) => r.dimensions.projectId === spanProject);
      expect(projRow, "project-grain wip_open_avg row must exist").toBeTruthy();
      expect(Number(projRow!.denominator)).toBe(11);
      // 10 snapshot rows (one day deliberately missing) x open_count 4 = 40, NOT 4*11=44 and NOT
      // scaled by an assumed week/month length.
      expect(Number(projRow!.numerator)).toBe(40);
    });
  });

  // ═══════════════════ #20 discipline.overdue_open — no multiply over a range ═══════════════════

  describe("§5.4 regression: discipline.overdue_open does not multiply over a multi-day range", () => {
    const END = "2026-07-20";
    let overdueTask: string;

    beforeAll(async () => {
      overdueTask = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, origin_site)
           VALUES ($1,$2,$3,'overdue task','2026-07-01'::date,'central')`,
          [overdueTask, co, projectId],
        ),
      );
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
           VALUES ($1,$2,$3,'owner','person',$4,$5,'central')`,
          [newId(), co, overdueTask, alice, alice],
        ),
      );
    });

    it("a 1-day period and a 30-day period ending on the SAME date report the IDENTICAL count", async () => {
      const oneDayPeriod = formatPeriodRange(END, END);
      const thirtyDayPeriod = formatPeriodRange("2026-06-21", END);

      await recomputeRollups(co, oneDayPeriod);
      const oneDayRows = await metricRows(oneDayPeriod, "discipline.overdue_open");
      const oneDayCompany = oneDayRows.find((r) => Object.keys(r.dimensions).length === 0);
      expect(oneDayCompany, "company-grain overdue_open row must exist for the 1-day period").toBeTruthy();

      await recomputeRollups(co, thirtyDayPeriod);
      const thirtyDayRows = await metricRows(thirtyDayPeriod, "discipline.overdue_open");
      const thirtyDayCompany = thirtyDayRows.find((r) => Object.keys(r.dimensions).length === 0);
      expect(thirtyDayCompany, "company-grain overdue_open row must exist for the 30-day period").toBeTruthy();

      // The whole point of the regression: NOT 30x the one-day count.
      expect(Number(thirtyDayCompany!.numerator)).toBe(Number(oneDayCompany!.numerator));
      expect(Number(oneDayCompany!.numerator)).toBeGreaterThanOrEqual(1);
      expect(thirtyDayCompany!.denominator).toBeNull(); // 'last' — never a ratio
    });

    it("credits the person via the SAME owner-takes-all rule as the fact job (attributePerson reused)", async () => {
      const period = formatPeriodRange(END, END);
      await recomputeRollups(co, period);
      const rows = await metricRows(period, "discipline.overdue_open");
      const aliceRow = rows.find((r) => r.dimensions.userId === alice);
      expect(aliceRow, "alice must be credited as the person owner").toBeTruthy();
      expect(Number(aliceRow!.numerator)).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════ TR-35: #14/#18/#19 split per-day, agreeing with the fact-sourced split ═══════════
  //
  // §15's 2026-07-31 finding: `discipline.checkin_compliance`/`time_logging_coverage`/
  // `effort.capacity_utilization` used to resolve department ONCE as-of the range's END date, so a
  // mid-range transfer attributed the WHOLE range to the person's end-of-range department while
  // every fact-sourced metric (e.g. `effort.minutes_logged`, department-grain, sourced from
  // `report_work_facts.department_node_id`) split correctly at the transfer date. The fix resolves
  // department PER DAY via the same pure `resolveMembershipAsOf` (TR-04) fact-job.ts's precedence
  // ② already uses for a time-entry fact. This suite proves the two families now agree on the
  // EXACT same split date, not merely that a split happens somewhere.
  describe("TR-35: discipline/effort metrics split at the same date as the fact-sourced metrics", () => {
    // Unique, never-reused unit ids so this block's department-grain rows can't be contaminated by
    // alice's unrelated, never-transferred `d-eng` membership (she stays "employed"/"expected" for
    // any period regardless, since `employed` is company-wide and date-independent).
    const OLD_DEPT = "d-tr35-old";
    const NEW_DEPT = "d-tr35-new";
    // A Mon-Fri span with no weekend inside (2026-09-07 is a Monday) so every day is a working day
    // under the default calendar and the expected-day count is unambiguous.
    const RANGE_START = "2026-09-07";
    const TRANSFER_DATE = "2026-09-09"; // Wednesday — carol's NEW membership opens here
    const RANGE_END = "2026-09-11";
    const ALL_DAYS = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
    const PRE_TRANSFER_DAYS = 2; // 09-07, 09-08 — still OLD_DEPT
    const POST_TRANSFER_DAYS = 3; // 09-09, 09-10, 09-11 — NEW_DEPT
    const MINUTES_PER_DAY = 60;
    const period = formatPeriodRange(RANGE_START, RANGE_END);
    let carol: string;

    beforeAll(async () => {
      carol = await createUser("carol@tr35.test");
      await openMembership(carol, OLD_DEPT, "2026-01-01");
      // The exact "transfer" shape `diffMembershipSweep` produces (TR-04): close the old row the
      // day BEFORE the new one opens, so the two never overlap and the EXCLUDE constraint holds.
      await withTenants([co], (c) =>
        c.query(
          `UPDATE org_unit_memberships SET valid_to = $3::date
             WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`,
          [co, carol, "2026-09-08"],
        ),
      );
      await openMembership(carol, NEW_DEPT, TRANSFER_DATE);

      // A submitted check-in + a logged hour every single day of the range — this is the data the
      // calendar/checkin family (#14/#18/#19) is sourced from. Same set of days also drives
      // `report_work_facts` (via time_entries -> recomputeFactWindow below), which is the
      // fact-sourced family's source — so both families are being asked to split the IDENTICAL
      // set of days at the IDENTICAL transfer date.
      for (const d of ALL_DAYS) {
        // report_checkins sits behind the 'reports' module third wall (WITH CHECK
        // app_module_allowed('reports')) — a plain withTenants([co]) has no scope declared and
        // the INSERT is refused (module-reports-rls.test.ts pins this).
        await withTenants(
          [co],
          (c) =>
            c.query(
              `INSERT INTO report_checkins (id, tenant_id, user_id, checkin_date, status, summary, origin_site)
               VALUES ($1,$2,$3,$4::date,'submitted','tr-35 checkin','central')`,
              [newId(), co, carol, d],
            ),
          { modules: ["reports"] },
        );
        await addTimeEntry(carol, MINUTES_PER_DAY, true, d);
      }
      await recomputeFactWindow(co, RANGE_START, RANGE_END);
      await recomputeRollups(co, period);
    });

    it("fact-sourced effort.minutes_logged (department grain) splits at the transfer date", async () => {
      const rows = await metricRows(period, "effort.minutes_logged");
      const oldRow = rows.find((r) => r.dimensions.unit === OLD_DEPT);
      const newRow = rows.find((r) => r.dimensions.unit === NEW_DEPT);
      expect(oldRow, "OLD_DEPT must have an effort.minutes_logged row").toBeTruthy();
      expect(newRow, "NEW_DEPT must have an effort.minutes_logged row").toBeTruthy();
      expect(Number(oldRow!.numerator)).toBe(PRE_TRANSFER_DAYS * MINUTES_PER_DAY);
      expect(Number(newRow!.numerator)).toBe(POST_TRANSFER_DAYS * MINUTES_PER_DAY);
    });

    it("discipline.checkin_compliance (department grain) splits at the SAME transfer date", async () => {
      const rows = await metricRows(period, "discipline.checkin_compliance");
      const oldRow = rows.find((r) => r.dimensions.unit === OLD_DEPT);
      const newRow = rows.find((r) => r.dimensions.unit === NEW_DEPT);
      expect(oldRow, "OLD_DEPT must have a checkin_compliance row").toBeTruthy();
      expect(newRow, "NEW_DEPT must have a checkin_compliance row").toBeTruthy();
      expect(Number(oldRow!.numerator)).toBe(PRE_TRANSFER_DAYS);
      expect(Number(oldRow!.denominator)).toBe(PRE_TRANSFER_DAYS);
      expect(Number(newRow!.numerator)).toBe(POST_TRANSFER_DAYS);
      expect(Number(newRow!.denominator)).toBe(POST_TRANSFER_DAYS);
    });

    it("discipline.time_logging_coverage (department grain) splits at the SAME transfer date", async () => {
      const rows = await metricRows(period, "discipline.time_logging_coverage");
      const oldRow = rows.find((r) => r.dimensions.unit === OLD_DEPT);
      const newRow = rows.find((r) => r.dimensions.unit === NEW_DEPT);
      expect(oldRow, "OLD_DEPT must have a time_logging_coverage row").toBeTruthy();
      expect(newRow, "NEW_DEPT must have a time_logging_coverage row").toBeTruthy();
      expect(Number(oldRow!.numerator)).toBe(PRE_TRANSFER_DAYS);
      expect(Number(oldRow!.denominator)).toBe(PRE_TRANSFER_DAYS);
      expect(Number(newRow!.numerator)).toBe(POST_TRANSFER_DAYS);
      expect(Number(newRow!.denominator)).toBe(POST_TRANSFER_DAYS);
    });

    it("effort.capacity_utilization (department grain) splits at the SAME transfer date, denominator = days-in-department * workday minutes", async () => {
      const rows = await metricRows(period, "effort.capacity_utilization");
      const oldRow = rows.find((r) => r.dimensions.unit === OLD_DEPT);
      const newRow = rows.find((r) => r.dimensions.unit === NEW_DEPT);
      expect(oldRow, "OLD_DEPT must have a capacity_utilization row").toBeTruthy();
      expect(newRow, "NEW_DEPT must have a capacity_utilization row").toBeTruthy();
      expect(Number(oldRow!.numerator)).toBe(PRE_TRANSFER_DAYS * MINUTES_PER_DAY);
      expect(Number(oldRow!.denominator)).toBe(PRE_TRANSFER_DAYS * 480); // DEFAULT_WORK_CALENDAR.workdayMinutes
      expect(Number(newRow!.numerator)).toBe(POST_TRANSFER_DAYS * MINUTES_PER_DAY);
      expect(Number(newRow!.denominator)).toBe(POST_TRANSFER_DAYS * 480);
    });

    it("THE ACCEPTANCE BAR: the fact-sourced family and the calendar/checkin family agree on the split — same days attributed to the same departments, nothing lost or double-counted", async () => {
      const factRows = await metricRows(period, "effort.minutes_logged");
      const coverageRows = await metricRows(period, "discipline.time_logging_coverage");

      const factOld = Number(factRows.find((r) => r.dimensions.unit === OLD_DEPT)!.numerator);
      const factNew = Number(factRows.find((r) => r.dimensions.unit === NEW_DEPT)!.numerator);
      const coverageOld = Number(coverageRows.find((r) => r.dimensions.unit === OLD_DEPT)!.numerator);
      const coverageNew = Number(coverageRows.find((r) => r.dimensions.unit === NEW_DEPT)!.numerator);

      // The fact family reports MINUTES, the discipline family reports DAYS — converting back by
      // the fixed per-day rate proves both families counted the exact same days per department.
      expect(factOld / MINUTES_PER_DAY).toBe(coverageOld);
      expect(factNew / MINUTES_PER_DAY).toBe(coverageNew);

      // Nothing lost or double-counted: the two departments' day-shares sum to the FULL range.
      expect(coverageOld + coverageNew).toBe(ALL_DAYS.length);
      expect(Number(coverageRows.find((r) => r.dimensions.unit === OLD_DEPT)!.denominator) + Number(coverageRows.find((r) => r.dimensions.unit === NEW_DEPT)!.denominator)).toBe(ALL_DAYS.length);
    });
  });
});
