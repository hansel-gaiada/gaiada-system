// LMS L2 — the general track, the assignment sweep, and the training-tenant reset.
//
// The reset is the reason this file is careful. It deletes production rows, so the assertions are
// about BOUNDS as much as about effect: what it clears, what it must NOT clear, that it cannot be
// pointed at another company, and that a run which matched nothing is visible rather than silent.
//
// Needs DATABASE_URL_TEST. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants, newId } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { seedGeneralTrack, verifyGeneralTrack } from "../../seed/lms-general-track";
import { runMandatoryAssignment, dueDateFor, inScopeFor } from "./mandatory-assignment";
import {
  resolveTrainingTenant, loadResetAllowList, planTrainingReset, runTrainingReset, revokeCohortAccess,
} from "./training-tenant-reset";

const RUN = !!TEST_URL;

/** An employee row, because the sweep reads `employees` rather than memberships. */
async function addEmployee(
  tenantId: string, userId: string | null, name: string, status = "active",
): Promise<void> {
  await withTenants(
    [tenantId],
    (c) => c.query(
      `INSERT INTO employees (id, tenant_id, user_id, display_name, employment_status, origin_site)
       VALUES ($1,$2,$3,$4,$5,'central')`,
      [newId(), tenantId, userId, name, status],
    ),
    { modules: ["hr"] },
  );
}

describe.skipIf(!RUN)("LMS L2 — general track, assignment sweep, training-tenant reset", () => {
  let A: string;        // the real company
  let T: string;        // the training tenant
  let alice: string, bob: string, carol: string, dave: string, eve: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Gaia Digital Agency", ["lms", "hr", "pm"]);
    T = await createCompany("Gaiada Training Sandbox", ["lms", "hr", "pm"]);
    alice = await createUser("alice@a.test", "Alice Active");
    bob = await createUser("bob@a.test", "Bob OnLeave");
    carol = await createUser("carol@a.test", "Carol Terminated");
    dave = await createUser("dave@a.test", "Dave PendingStart");
    eve = await createUser("eve@a.test", "Eve Trainee");
    for (const u of [alice, bob, carol, dave, eve]) await addMembership(A, u);

    await addEmployee(A, alice, "Alice Active", "active");
    await addEmployee(A, bob, "Bob OnLeave", "on_leave");
    await addEmployee(A, carol, "Carol Terminated", "terminated");
    await addEmployee(A, dave, "Dave PendingStart", "pending_start");
    // No `users` row: a real hole in coverage that must be REPORTED, never silently skipped.
    await addEmployee(A, null, "Frank Unlinked", "active");

    await withGlobal((c) => c.query(`UPDATE companies SET is_training = true WHERE id = $1`, [T]));
  });

  afterAll(async () => { await teardownTestDb(); });

  // ═══════════════════════════════════════════════════════════ the general track ══════════════
  describe("the general track seed", () => {
    it("publishes three courses and one MANDATORY path, with real quizzes", async () => {
      const r = await seedGeneralTrack("Gaia Digital Agency");
      expect(r.courses.created.sort()).toEqual(
        ["general-claude-usage", "general-erp-usage", "general-fundamentals"],
      );
      expect(r.path.created).toBe(true);
      expect(r.path.courses).toBe(3);

      const counts = await verifyGeneralTrack(A);
      expect(counts.lms_courses).toBe(3);
      expect(counts.lms_paths).toBe(1);
      expect(counts.lms_path_courses).toBe(3);
      // Three assessments, one per course. A general track with no assessment is a reading list.
      expect(counts.quizzes).toBe(3);

      const path = await withTenants(
        [A],
        (c) => c.query<{ is_mandatory: boolean; status: string; applies_to: string; due_days: number }>(
          `SELECT is_mandatory, status, applies_to, due_days FROM lms_paths WHERE path_key = 'general-induction'`,
        ),
        { modules: ["lms"] },
      );
      expect(path.rows[0]).toMatchObject({
        is_mandatory: true, status: "published", applies_to: "all", due_days: 30,
      });
    });

    it("every quiz question carries an answer the grader can actually compare", async () => {
      // The grader does `JSON.stringify(submitted) === JSON.stringify(q.answer)`. A question with
      // no `answer` grades as wrong for everybody and the course becomes impossible to pass —
      // which presents as "the training is too hard", not as a data defect.
      const quizzes = await withTenants(
        [A],
        (c) => c.query<{ title: string; spec: { questions?: { id?: string; answer?: unknown }[] } }>(
          `SELECT title, spec FROM lms_activities WHERE kind = 'quiz'`,
        ),
        { modules: ["lms"] },
      );
      expect(quizzes.rows.length).toBe(3);
      for (const row of quizzes.rows) {
        const qs = row.spec.questions ?? [];
        expect(qs.length, `${row.title} has no questions`).toBeGreaterThan(0);
        for (const q of qs) {
          expect(q.id, `${row.title}: a question has no id`).toBeTruthy();
          expect(q.answer, `${row.title}/${q.id}: no answer`).not.toBeUndefined();
        }
        // Ids must be unique — the grader keys the submission by id, and a duplicate silently
        // means one question can never be answered.
        expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
      }
    });

    it("is idempotent and does NOT rewrite an existing course", async () => {
      const before = await withTenants(
        [A],
        (c) => c.query<{ id: string; title: string }>(
          `SELECT id, title FROM lms_courses WHERE course_key = 'general-erp-usage'`,
        ),
        { modules: ["lms"] },
      );
      await withTenants(
        [A],
        (c) => c.query(`UPDATE lms_courses SET title = 'Edited by a human' WHERE course_key = 'general-erp-usage'`),
        { modules: ["lms"] },
      );
      const second = await seedGeneralTrack("Gaia Digital Agency");
      expect(second.courses.created).toEqual([]);
      expect(second.courses.existing.length).toBe(3);
      const after = await withTenants(
        [A],
        (c) => c.query<{ id: string; title: string }>(
          `SELECT id, title FROM lms_courses WHERE course_key = 'general-erp-usage'`,
        ),
        { modules: ["lms"] },
      );
      // Same row, human's title intact. A seed that silently restored its own text would undo an
      // author's work and leave no trace of having done so.
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].id).toBe(before.rows[0].id);
      expect(after.rows[0].title).toBe("Edited by a human");
      await withTenants(
        [A],
        (c) => c.query(`UPDATE lms_courses SET title = $1 WHERE course_key = 'general-erp-usage'`,
                       [before.rows[0].title]),
        { modules: ["lms"] },
      );
    });

    it("refuses when the lms module is off, instead of writing zero rows and reporting success", async () => {
      const off = await createCompany("No LMS Co", ["hr"]);
      expect(off).toBeTruthy();
      await expect(seedGeneralTrack("No LMS Co")).rejects.toThrow(/not enabled/i);
    });
  });

  // ═══════════════════════════════════════════════════════ the assignment sweep ═══════════════
  describe("the mandatory-assignment sweep", () => {
    it("dueDateFor is UTC-stable and returns null when a path has no due window", () => {
      expect(dueDateFor(new Date("2026-08-24T23:30:00Z"), 30)).toBe("2026-09-23");
      expect(dueDateFor(new Date("2026-01-31T00:00:00Z"), 1)).toBe("2026-02-01");
      expect(dueDateFor(new Date("2026-08-24T00:00:00Z"), null)).toBeNull();
    });

    it("an unrecognised applies_to scope matches NOBODY, not everybody", () => {
      const all = [{ subjectUserId: "u1", displayName: "A", employmentStatus: "active" }];
      expect(inScopeFor("all", all)).toHaveLength(1);
      // 'unit' and 'discipline' arrive with L4. Reading an unknown scope as "all" would enrol the
      // whole company in a department's path the moment somebody publishes one.
      expect(inScopeFor("unit", all)).toHaveLength(0);
      expect(inScopeFor("discipline", all)).toHaveLength(0);
      expect(inScopeFor("nonsense", all)).toHaveLength(0);
    });

    it("plans without writing, and names the employee who has no account", async () => {
      const plan = await runMandatoryAssignment(A, { dryRun: true });
      expect(plan.dryRun).toBe(true);
      expect(plan.enrolled).toBe(0);
      // active + on_leave + the unlinked one. NOT terminated, NOT pending_start.
      expect(plan.activeEmployees).toBe(3);
      expect(plan.unlinkedEmployees).toEqual(["Frank Unlinked"]);
      const p = plan.paths.find((x) => x.pathKey === "general-induction")!;
      expect(p.toEnrol.sort()).toEqual([alice, bob].sort());

      const none = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lms_enrollments`),
        { modules: ["lms"] },
      );
      expect(Number(none.rows[0].n)).toBe(0);
    });

    it("enrols active and on-leave employees, and nobody else", async () => {
      const r = await runMandatoryAssignment(A, { today: new Date("2026-08-24T00:00:00Z") });
      expect(r.enrolled).toBe(2);
      const rows = await withTenants(
        [A],
        (c) => c.query<{ subject_user_id: string; source: string; due_on: string; status: string }>(
          `SELECT subject_user_id, source, to_char(due_on,'YYYY-MM-DD') AS due_on, status FROM lms_enrollments`,
        ),
        { modules: ["lms"] },
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.map((x) => x.subject_user_id).sort()).toEqual([alice, bob].sort());
      for (const row of rows.rows) {
        expect(row.source).toBe("auto");
        expect(row.status).toBe("assigned");
        expect(row.due_on).toBe("2026-09-23");
      }
      // Terminated and pending_start are ABSENT, and that is the assertion — a leaver showing as
      // non-compliant is noise that makes the real number unreadable.
      const ids = rows.rows.map((x) => x.subject_user_id);
      expect(ids).not.toContain(carol);
      expect(ids).not.toContain(dave);
    });

    it("is idempotent — a second sweep creates nothing", async () => {
      const again = await runMandatoryAssignment(A);
      expect(again.enrolled).toBe(0);
      const n = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lms_enrollments`),
        { modules: ["lms"] },
      );
      expect(Number(n.rows[0].n)).toBe(2);
    });

    it("does NOT re-enrol somebody who already completed or was waived", async () => {
      await withTenants(
        [A],
        (c) => c.query(
          `UPDATE lms_enrollments SET status = 'completed', completed_at = now() WHERE subject_user_id = $1`,
          [alice],
        ),
        { modules: ["lms"] },
      );
      const r = await runMandatoryAssignment(A);
      expect(r.enrolled).toBe(0);
      const p = r.paths.find((x) => x.pathKey === "general-induction")!;
      expect(p.completedOrWaived).toBe(1);
      expect(p.toEnrol).toEqual([]);
      // Restored, so the reset tests below start from a known state.
      await withTenants(
        [A],
        (c) => c.query(
          `UPDATE lms_enrollments SET status = 'assigned', completed_at = NULL WHERE subject_user_id = $1`,
          [alice],
        ),
        { modules: ["lms"] },
      );
    });
  });

  // ═══════════════════════════════════════════════════════ the training tenant ════════════════
  describe("the training-tenant reset", () => {
    let cohortId: string;

    beforeAll(async () => {
      cohortId = newId();
      await withTenants(
        [T],
        async (c) => {
          await c.query(
            `INSERT INTO lms_cohorts (id, tenant_id, cohort_key, title, status, started_at)
             VALUES ($1,$2,'cohort-2026-08','August intake','running',now())`,
            [cohortId, T],
          );
          await c.query(
            `INSERT INTO lms_cohort_members (id, tenant_id, cohort_id, subject_user_id, home_company_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [newId(), T, cohortId, eve, A],
          );
        },
        { modules: ["lms"] },
      );
      // Eve's real access to the training tenant: a membership AND a company-scoped grant.
      await addMembership(T, eve);
      await grantRole(eve, await createRole("member"), "company", T);

      // Work the cohort produced, in the training tenant AND matching rows in the REAL company.
      // The real ones are the control: if the reset touches them, the bound has failed.
      for (const tenant of [T, A]) {
        await withTenants(
          [tenant],
          (c) => c.query(
            `INSERT INTO notifications (id, tenant_id, user_id, type, payload, origin_site)
             VALUES ($1,$2,$3,'test','{}','central'), ($4,$2,$3,'test2','{}','central')`,
            [newId(), tenant, eve, newId()],
          ),
        );
        await withTenants(
          [tenant],
          (c) => c.query(
            `INSERT INTO hr_cases (id, tenant_id, subject_user_id, kind, status, title, created_by, origin_site)
             VALUES ($1,$2,$3,'grievance','open','A training exercise case',$3,'central')`,
            [newId(), tenant, eve],
          ),
          { modules: ["hr"] },
        );
      }
    });

    it("resolves the tenant from the FLAG, and there can only be one", async () => {
      const t = await resolveTrainingTenant();
      expect(t?.id).toBe(T);
      // The singleton is a database constraint, not a convention. Two training companies would
      // make "the" training tenant a guess.
      await expect(
        withGlobal((c) => c.query(`UPDATE companies SET is_training = true WHERE id = $1`, [A])),
      ).rejects.toThrow(/ux_companies_one_training|duplicate key/i);
    });

    it("the allow-list is data, is validated, and every entry names a real table", async () => {
      const tables = await loadResetAllowList();
      expect(tables.length).toBeGreaterThan(5);
      expect(tables.map((t) => t.tableName)).toContain("notifications");
      expect(tables.map((t) => t.tableName)).toContain("hr_cases");
      // Every entry states WHY. An allow-list entry with no rationale is how a table nobody meant
      // to clear survives three reviews.
      for (const t of tables) expect(t.rationale.length).toBeGreaterThan(10);
      // Ordering: children before parents, so an FK cannot abort a run half-way.
      const order = tables.map((t) => t.deleteOrder);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(tables.find((t) => t.tableName === "hr_case_events")!.deleteOrder)
        .toBeLessThan(tables.find((t) => t.tableName === "hr_cases")!.deleteOrder);
      // NOT in the list, and this is the assertion that matters most: the baseline survives.
      const names = tables.map((t) => t.tableName);
      for (const forbidden of ["employees", "users", "company_memberships", "hr_records",
                               "lms_courses", "lms_activities", "lms_paths", "companies"]) {
        expect(names, `${forbidden} must NEVER be in the reset allow-list`).not.toContain(forbidden);
      }
    });

    it("a dry run counts what it would clear and deletes NOTHING", async () => {
      const plan = await planTrainingReset(cohortId);
      expect(plan.tenantId).toBe(T);
      expect(plan.rowCounts.notifications).toBe(2);
      expect(plan.rowCounts.hr_cases).toBe(1);
      expect(plan.liveMembers).toBe(1);

      const r = await runTrainingReset({ execute: false, cohortId });
      expect(r.mode).toBe("dry_run");
      expect(r.deleted).toEqual({});
      const still = await withTenants(
        [T], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications`),
      );
      expect(Number(still.rows[0].n)).toBe(2);
      // The dry run is still FILED. A destructive tool whose rehearsals leave no trace cannot
      // answer "who has been looking at this".
      const runs = await withTenants(
        [T], (c) => c.query<{ mode: string }>(`SELECT mode FROM lms_training_resets`),
        { modules: ["lms"] },
      );
      expect(runs.rows.map((x) => x.mode)).toContain("dry_run");
    });

    it("executing clears the allow-listed tables, revokes access, and leaves the real company untouched", async () => {
      const r = await runTrainingReset({ execute: true, cohortId });
      expect(r.mode).toBe("executed");
      expect(r.deleted.notifications).toBe(2);
      expect(r.deleted.hr_cases).toBe(1);
      expect(r.grantsRevoked).toBe(1);

      const cleared = await withTenants(
        [T], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications`),
      );
      expect(Number(cleared.rows[0].n)).toBe(0);

      // ── THE BOUND. The real company's identical rows are still there. ──
      const real = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications`),
      );
      expect(Number(real.rows[0].n)).toBe(2);
      const realCases = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM hr_cases`),
        { modules: ["hr"] },
      );
      expect(Number(realCases.rows[0].n)).toBe(1);
      // And the real company's enrolments — a trainee's LMS progress lives in their HOME company.
      const enrol = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lms_enrollments`),
        { modules: ["lms"] },
      );
      expect(Number(enrol.rows[0].n)).toBe(2);

      // ── THE BASELINE. Fake staff and course material survive a reset. ──
      const staff = await withTenants(
        [T], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees`),
        { modules: ["hr"] },
      );
      expect(Number(staff.rows[0].n)).toBe(0); // none seeded here, but the table was never in scope
      const allow = await loadResetAllowList();
      expect(allow.map((t) => t.tableName)).not.toContain("employees");

      // ── ORG-6. Both doors closed: the grant AND the membership. ──
      const grants = await withGlobal((c) =>
        c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM user_roles WHERE scope_type='company' AND scope_id=$1 AND user_id=$2`,
          [T, eve],
        ),
      );
      expect(Number(grants.rows[0].n)).toBe(0);
      // ⚠ READ THROUGH withTenants, NOT withGlobal. `company_memberships` carries FORCE RLS, so a
      //   withGlobal count returns 0 for every tenant — which would have made the line below pass
      //   whether or not the membership was actually revoked. The first version of this test did
      //   exactly that, and the false pass hid a real bug in revokeCohortAccess: its membership
      //   DELETE was also running under withGlobal and deleting nothing.
      const memberships = await withTenants(
        [T], (c) => c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM company_memberships WHERE user_id=$1`, [eve]),
      );
      expect(Number(memberships.rows[0].n)).toBe(0);
      // Eve's membership of her REAL company is untouched — the assertion that catches an
      // over-broad revoke.
      const home = await withTenants(
        [A], (c) => c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM company_memberships WHERE user_id=$1`, [eve]),
      );
      expect(Number(home.rows[0].n)).toBe(1);

      const cohort = await withTenants(
        [T],
        (c) => c.query<{ status: string; reset_at: string | null }>(
          `SELECT status, reset_at FROM lms_cohorts WHERE id = $1`, [cohortId],
        ),
        { modules: ["lms"] },
      );
      expect(cohort.rows[0].status).toBe("reset");
      expect(cohort.rows[0].reset_at).not.toBeNull();
    });

    it("records per-table counts, not one total", async () => {
      const runs = await withTenants(
        [T],
        (c) => c.query<{ row_counts: Record<string, number>; grants_revoked: number }>(
          `SELECT row_counts, grants_revoked FROM lms_training_resets WHERE mode = 'executed' ORDER BY started_at DESC LIMIT 1`,
        ),
        { modules: ["lms"] },
      );
      const counts = runs.rows[0].row_counts;
      // Per-table is the point: a single total hides the table that matched zero rows when it
      // should have matched hundreds, which is how the RLS zero-row trap presents.
      expect(Object.keys(counts).length).toBeGreaterThan(5);
      expect(counts.notifications).toBe(2);
      expect(runs.rows[0].grants_revoked).toBe(1);
    });

    it("revoking twice is a no-op rather than an error", async () => {
      expect(await revokeCohortAccess(T, cohortId)).toBe(0);
    });
  });
});
