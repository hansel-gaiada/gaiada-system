// LMS — the HR and IT curriculum seed.
//
// Asserts SHAPE, not prose: both functional departments exist at foundation/practitioner/lead, every
// path is ordered, every quiz is gradeable, and — the one that would otherwise be found by a learner
// — NO lab is authored before a runner exists, because a required lab nothing can pass makes its
// whole path permanently uncompletable.
//
// Needs DATABASE_URL_TEST. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedHrItCurriculum, verifyHrItCurriculum } from "./lms-hr-it-curriculum";

const RUN = !!TEST_URL;
const UNIT_HR = "d-hr";
const UNIT_IT = "d-it";

describe.skipIf(!RUN)("LMS — the HR and IT curriculum", () => {
  let A: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Gaia Digital Agency", ["lms", "hr"]);
    await seedHrItCurriculum("Gaia Digital Agency");
  });
  afterAll(async () => { await teardownTestDb(); });

  it("covers both functional departments, at foundation/practitioner/lead", async () => {
    const rows = await withTenants(
      [A],
      (c) => c.query<{ discipline: string; level: string; unit_node_id: string; course_key: string }>(
        `SELECT discipline, level, unit_node_id, course_key FROM lms_courses
          WHERE unit_node_id IN ($1,$2) ORDER BY discipline, level`,
        [UNIT_HR, UNIT_IT],
      ),
      { modules: ["lms"] },
    );
    const disciplines = new Set(rows.rows.map((r) => r.discipline));
    expect(disciplines).toContain("HR");
    expect(disciplines).toContain("IT");
    const units = new Set(rows.rows.map((r) => r.unit_node_id));
    expect(units).toContain(UNIT_HR);
    expect(units).toContain(UNIT_IT);
    for (const level of ["foundation", "practitioner", "lead"]) {
      expect(rows.rows.some((r) => r.level === level), `no course at level ${level}`).toBe(true);
    }
    // One HR and one IT course at every level: 3 + 3 = 6 courses total.
    expect(rows.rows.length).toBe(6);
  });

  it("every path is ORDERED and every course it names exists", async () => {
    const paths = await withTenants(
      [A],
      (c) => c.query<{ id: string; path_key: string; status: string; unit_node_id: string }>(
        `SELECT id, path_key, status, unit_node_id FROM lms_paths WHERE unit_node_id IN ($1,$2)`,
        [UNIT_HR, UNIT_IT],
      ),
      { modules: ["lms"] },
    );
    expect(paths.rows.length).toBeGreaterThanOrEqual(4);
    for (const p of paths.rows) {
      expect(p.status).toBe("published");
      const steps = await withTenants(
        [A],
        (c) => c.query<{ course_key: string; position: number; requires_previous: boolean }>(
          `SELECT course_key, position, requires_previous FROM lms_path_courses
            WHERE path_id = $1 ORDER BY position`, [p.id],
        ),
        { modules: ["lms"] },
      );
      expect(steps.rows.length, `${p.path_key} has no courses`).toBeGreaterThan(0);
      // Positions are 1..n with no gaps — a path that jumps from 1 to 3 renders a missing step.
      expect(steps.rows.map((s) => s.position)).toEqual(steps.rows.map((_, i) => i + 1));
      // Order is enforced, not suggested.
      for (const s of steps.rows) expect(s.requires_previous).toBe(true);
      // A path naming a course that does not exist is a path nobody can finish.
      for (const s of steps.rows) {
        const c = await withTenants(
          [A],
          (cl) => cl.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM lms_courses WHERE course_key = $1 AND status = 'published'`,
            [s.course_key],
          ),
          { modules: ["lms"] },
        );
        expect(Number(c.rows[0].n), `${p.path_key} names a missing course: ${s.course_key}`).toBeGreaterThan(0);
      }
    }
  });

  it("NO lab is authored — no runner exists for it yet", async () => {
    const counts = await verifyHrItCurriculum(A);
    expect(counts.labs).toBe(0);
    expect(counts.quizzes).toBeGreaterThan(0);
    expect(counts.disciplines).toBeGreaterThanOrEqual(2);
    expect(counts.courses).toBe(6);
    expect(counts.paths).toBeGreaterThanOrEqual(4);
  });

  it("every auto-graded quiz is actually gradeable", async () => {
    const quizzes = await withTenants(
      [A],
      (c) => c.query<{
        title: string; grading: string; pass_threshold: string | null;
        spec: { questions?: { id?: string; answer?: unknown; options?: unknown[] }[] };
      }>(
        `SELECT a.title, a.grading, a.pass_threshold, a.spec FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id IN ($1,$2) AND a.kind = 'quiz'`, [UNIT_HR, UNIT_IT],
      ),
      { modules: ["lms"] },
    );
    expect(quizzes.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of quizzes.rows) {
      expect(row.grading).toBe("auto");
      expect(row.pass_threshold, `${row.title} has no pass mark`).not.toBeNull();
      const qs = row.spec.questions ?? [];
      // Ticket requires 4+ questions per quiz.
      expect(qs.length, `${row.title} has fewer than 4 questions`).toBeGreaterThanOrEqual(4);
      const ids = new Set<string>();
      for (const q of qs) {
        expect(q.id, `${row.title}: a question has no id`).toBeTruthy();
        // The grader compares JSON.stringify(submitted) === JSON.stringify(answer). Undefined here
        // grades everybody wrong and the course becomes impossible to pass.
        expect(q.answer, `${row.title}/${q.id}: no answer`).not.toBeUndefined();
        expect(Array.isArray(q.options), `${row.title}/${q.id}: no options`).toBe(true);
        expect(typeof q.answer).toBe("number");
        expect(q.answer as number).toBeGreaterThanOrEqual(0);
        expect(q.answer as number).toBeLessThan((q.options as unknown[]).length);
        // A duplicate id silently means one question can never be answered.
        expect(ids.has(String(q.id)), `${row.title}: duplicate question id ${q.id}`).toBe(false);
        ids.add(String(q.id));
      }
    }
  });

  it("every quiz question has an explanation", async () => {
    const quizzes = await withTenants(
      [A],
      (c) => c.query<{ title: string; spec: { questions?: { id?: string; explanation?: unknown }[] } }>(
        `SELECT a.title, a.spec FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id IN ($1,$2) AND a.kind = 'quiz'`, [UNIT_HR, UNIT_IT],
      ),
      { modules: ["lms"] },
    );
    for (const row of quizzes.rows) {
      for (const q of row.spec.questions ?? []) {
        expect(q.explanation, `${row.title}/${q.id}: no explanation`).toBeTruthy();
      }
    }
  });

  it("scenarios (disputes, performance, standardise-vs-choose) are REVIEWED, not auto-graded", async () => {
    const reviewed = await withTenants(
      [A],
      (c) => c.query<{ discipline: string; kind: string; grading: string }>(
        `SELECT co.discipline, a.kind, a.grading FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id IN ($1,$2) AND a.kind = 'scenario'`, [UNIT_HR, UNIT_IT],
      ),
      { modules: ["lms"] },
    );
    expect(reviewed.rows.length).toBeGreaterThan(0);
    for (const r of reviewed.rows) expect(r.grading).toBe("review");
    const disciplines = new Set(reviewed.rows.map((r) => r.discipline));
    expect(disciplines).toContain("HR");
    expect(disciplines).toContain("IT");
  });

  it("is idempotent — a second run creates nothing", async () => {
    const before = await verifyHrItCurriculum(A);
    const second = await seedHrItCurriculum("Gaia Digital Agency");
    expect(second.courses.created).toEqual([]);
    expect(second.paths.created).toEqual([]);
    expect(second.activities).toBe(0);
    expect(await verifyHrItCurriculum(A)).toEqual(before);
  });

  it("refuses when the lms module is off rather than writing zero rows and reporting success", async () => {
    await createCompany("No LMS HR-IT Co", ["hr"]);
    await expect(seedHrItCurriculum("No LMS HR-IT Co")).rejects.toThrow(/not enabled/i);
  });
});
