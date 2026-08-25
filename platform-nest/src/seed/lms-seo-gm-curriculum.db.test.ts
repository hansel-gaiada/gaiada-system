// LMS — the SEO curriculum and the GM (general management) curriculum seed.
//
// Modelled on `lms-webdev-curriculum.db.test.ts`. Asserts SHAPE, not prose: both departments'
// disciplines exist, every path is ordered, every quiz is gradeable, the reviewed activities are
// actually `grading: "review"`, and — the one that would otherwise be found by a learner — NO lab
// is authored before the runner exists, because a required lab nothing can pass makes its whole
// path permanently uncompletable.
//
// Needs DATABASE_URL_TEST. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedSeoGmCurriculum, verifySeoGmCurriculum } from "./lms-seo-gm-curriculum";

const RUN = !!TEST_URL;
const UNITS = ["d-seo", "d-gm"];

describe.skipIf(!RUN)("LMS — the SEO + GM curriculum", () => {
  let A: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Gaia Digital Agency", ["lms", "hr"]);
    await seedSeoGmCurriculum("Gaia Digital Agency");
  });
  afterAll(async () => { await teardownTestDb(); });

  it("covers both departments, at more than one level", async () => {
    const rows = await withTenants(
      [A],
      (c) => c.query<{ discipline: string; level: string; unit_node_id: string; course_key: string }>(
        `SELECT discipline, level, unit_node_id, course_key FROM lms_courses
          WHERE unit_node_id = ANY($1) ORDER BY unit_node_id, discipline, level`,
        [UNITS],
      ),
      { modules: ["lms"] },
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(6);
    const units = new Set(rows.rows.map((r) => r.unit_node_id));
    expect(units).toContain("d-seo");
    expect(units).toContain("d-gm");
    expect(rows.rows.some((r) => r.level === "foundation")).toBe(true);
    expect(rows.rows.some((r) => r.level === "practitioner")).toBe(true);
    expect(rows.rows.some((r) => r.level === "lead")).toBe(true);
  });

  it("every path is ORDERED and every course it names exists", async () => {
    const paths = await withTenants(
      [A],
      (c) => c.query<{ id: string; path_key: string; status: string }>(
        `SELECT id, path_key, status FROM lms_paths WHERE unit_node_id = ANY($1)`, [UNITS],
      ),
      { modules: ["lms"] },
    );
    expect(paths.rows.length).toBeGreaterThanOrEqual(3);
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
      // "steps so difficulties are in order" — enforced, not suggested.
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

  it("NO lab is authored — the runner does not exist yet", async () => {
    const counts = await verifySeoGmCurriculum(A);
    expect(counts.labs).toBe(0);
    expect(counts.quizzes).toBeGreaterThan(0);
    expect(counts.courses).toBeGreaterThanOrEqual(6);
    expect(counts.paths).toBeGreaterThanOrEqual(3);
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
          WHERE co.unit_node_id = ANY($1) AND a.kind = 'quiz'`, [UNITS],
      ),
      { modules: ["lms"] },
    );
    expect(quizzes.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of quizzes.rows) {
      expect(row.grading).toBe("auto");
      expect(row.pass_threshold, `${row.title} has no pass mark`).not.toBeNull();
      const qs = row.spec.questions ?? [];
      expect(qs.length, `${row.title} has no questions`).toBeGreaterThanOrEqual(3);
      const ids = new Set<string>();
      for (const q of qs) {
        expect(q.id, `${row.title}: a question has no id`).toBeTruthy();
        // The grader compares JSON.stringify(submitted) === JSON.stringify(answer). Undefined here
        // grades everybody wrong and the course becomes impossible to pass.
        expect(q.answer, `${row.title}/${q.id}: no answer`).not.toBeUndefined();
        // The answer is an option INDEX, so it has to be inside the option list.
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

  it("scenarios are REVIEWED, not auto-graded — the GM track especially", async () => {
    const reviewed = await withTenants(
      [A],
      (c) => c.query<{ discipline: string; kind: string; grading: string }>(
        `SELECT co.discipline, a.kind, a.grading FROM lms_activities a
           JOIN lms_modules m ON m.id = a.module_id
           JOIN lms_courses co ON co.id = m.course_id
          WHERE co.unit_node_id = ANY($1) AND a.kind = 'scenario'`, [UNITS],
      ),
      { modules: ["lms"] },
    );
    expect(reviewed.rows.length).toBeGreaterThan(0);
    for (const r of reviewed.rows) expect(r.grading).toBe("review");
    const disciplines = new Set(reviewed.rows.map((r) => r.discipline));
    expect(disciplines).toContain("Management");
  });

  it("is idempotent — a second run creates nothing", async () => {
    const before = await verifySeoGmCurriculum(A);
    const second = await seedSeoGmCurriculum("Gaia Digital Agency");
    expect(second.courses.created).toEqual([]);
    expect(second.paths.created).toEqual([]);
    expect(second.activities).toBe(0);
    expect(await verifySeoGmCurriculum(A)).toEqual(before);
  });

  it("refuses when the lms module is off rather than writing zero rows and reporting success", async () => {
    await createCompany("No LMS SEO/GM Co", ["hr"]);
    await expect(seedSeoGmCurriculum("No LMS SEO/GM Co")).rejects.toThrow(/not enabled/i);
  });
});
