// LMS L4 — the Creatives + Social Media curriculum seed.
//
// Asserts SHAPE, not prose: both departments exist, every path is ordered, every quiz is
// gradeable, and — the one that would otherwise be found by a learner — NO lab is authored
// before the runner exists, because a required lab nothing can pass makes its whole path
// permanently uncompletable.
//
// Needs DATABASE_URL_TEST. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedCreativeSocialCurriculum, verifyCreativeSocialCurriculum } from "./lms-creative-social-curriculum";

const RUN = !!TEST_URL;
const UNIT_CREATIVES = "d-creatives";
const UNIT_SOCIAL = "d-social";
const UNITS = [UNIT_CREATIVES, UNIT_SOCIAL];
const DISCIPLINES = ["Creatives", "Social Media"];

describe.skipIf(!RUN)("LMS L4 — the Creatives + Social Media curriculum", () => {
  let A: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Gaia Digital Agency", ["lms", "hr"]);
    await seedCreativeSocialCurriculum("Gaia Digital Agency");
  });
  afterAll(async () => { await teardownTestDb(); });

  it("covers both departments, at more than one level", async () => {
    const rows = await withTenants(
      [A],
      (c) => c.query<{ discipline: string; level: string; course_key: string; unit_node_id: string }>(
        `SELECT discipline, level, course_key, unit_node_id FROM lms_courses
          WHERE unit_node_id = ANY($1) ORDER BY discipline, level`,
        [UNITS],
      ),
      { modules: ["lms"] },
    );
    const found = new Set(rows.rows.map((r) => r.discipline));
    for (const d of DISCIPLINES) {
      expect(found, `discipline missing: ${d}`).toContain(d);
    }
    // "for all levels... not just for operationals but for management too" — the lead tier is what
    // makes that true, and it is a course rather than a note in a doc.
    expect(rows.rows.some((r) => r.level === "lead")).toBe(true);
    expect(rows.rows.some((r) => r.level === "foundation")).toBe(true);
    expect(rows.rows.some((r) => r.level === "practitioner")).toBe(true);
    // Each department's courses land on its own org node — a Creatives course must not land on
    // Social Media's node or vice versa.
    const creatives = rows.rows.filter((r) => r.discipline === "Creatives");
    const social = rows.rows.filter((r) => r.discipline === "Social Media");
    expect(creatives.length).toBeGreaterThan(0);
    expect(social.length).toBeGreaterThan(0);
    for (const r of creatives) expect(r.unit_node_id).toBe(UNIT_CREATIVES);
    for (const r of social) expect(r.unit_node_id).toBe(UNIT_SOCIAL);
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
      // Ordered, enforced rather than suggested.
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
    const counts = await verifyCreativeSocialCurriculum(A);
    // The failure this prevents: a required activity nothing can grade makes its whole path
    // permanently uncompletable, and the symptom reads as "the training is too hard" rather than
    // as a missing service.
    expect(counts.labs).toBe(0);
    expect(counts.quizzes).toBeGreaterThan(0);
    expect(counts.disciplines).toBeGreaterThanOrEqual(2);
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
      expect(qs.length, `${row.title} has no questions`).toBeGreaterThanOrEqual(4);
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

  it("judged material (critique, costing, crisis calls, reporting) is REVIEWED, not auto-graded", async () => {
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
    // The mixed-grading decision, asserted: an auto-gradeable proxy for "is this good design" or
    // "was that the right call with a client" mostly is not one.
    for (const r of reviewed.rows) expect(r.grading).toBe("review");
    const disciplines = new Set(reviewed.rows.map((r) => r.discipline));
    expect(disciplines).toContain("Creatives");
    expect(disciplines).toContain("Social Media");
  });

  it("is idempotent — a second run creates nothing", async () => {
    const before = await verifyCreativeSocialCurriculum(A);
    const second = await seedCreativeSocialCurriculum("Gaia Digital Agency");
    expect(second.courses.created).toEqual([]);
    expect(second.paths.created).toEqual([]);
    expect(second.activities).toBe(0);
    expect(await verifyCreativeSocialCurriculum(A)).toEqual(before);
  });

  it("refuses when the lms module is off rather than writing zero rows and reporting success", async () => {
    await createCompany("No LMS Creative Social Co", ["hr"]);
    await expect(seedCreativeSocialCurriculum("No LMS Creative Social Co")).rejects.toThrow(/not enabled/i);
  });
});
