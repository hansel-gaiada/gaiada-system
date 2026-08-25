// LMS L5c — the FE/BE/QA labs.
//
// Two properties matter more than anything else here, and neither is about the database:
//   1. a lab's REFERENCE solution must pass, or the lab teaches people that correct work fails;
//   2. a lab's STARTER must fail, or the lab teaches nothing at all.
//
// Both were verified against the DEPLOYED runner on 2026-08-25 (reference: 100/100/100; starter:
// 0/0/14.29). That cannot run here — this suite has no Docker and no runner — so what it pins is
// everything that would make those two properties silently stop holding: the fixtures are present,
// the graded test file is a FIXTURE (not a starter file the learner could overwrite), the checks
// assert on output rather than on `fileExists` alone, and every lab is gradeable at all.
//
// Needs DATABASE_URL_TEST. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedWebdevCurriculum } from "./lms-webdev-curriculum";
import { seedWebdevLabs, verifyWebdevLabs, LABS } from "./lms-webdev-labs";

const RUN = !!TEST_URL;

describe("LMS L5c — the first hands-on labs", () => {
  // These are pure and run everywhere, including without a database.
  describe("the lab definitions", () => {
    it("covers FE, BE and QA — the three disciplines that need no new runner capability", () => {
      expect(LABS.map((l) => l.courseKey).sort()).toEqual(
        ["webdev-be-practice", "webdev-fe-practice", "webdev-qa-practice"],
      );
    });

    it("every lab ships an entry script and a graded test file as FIXTURES", () => {
      for (const lab of LABS) {
        const paths = lab.fixtures.map((f) => f.path);
        expect(paths, `${lab.title} has no run.sh`).toContain("run.sh");
        expect(paths, `${lab.title} has no test.js`).toContain("test.js");
        // THE assertion. `lab-dispatch.ts` refuses to let a learner file displace a fixture, so a
        // graded test file listed as a STARTER instead would be overwritable — and overwriting the
        // test with `process.exit(0)` is the obvious full-marks exploit.
        const starterPaths = lab.starter.map((f) => f.path);
        expect(starterPaths, `${lab.title}: test.js must not be a starter file`).not.toContain("test.js");
        expect(starterPaths, `${lab.title}: run.sh must not be a starter file`).not.toContain("run.sh");
      }
    });

    it("every lab gives the learner something to start from, and a brief that says what to do", () => {
      for (const lab of LABS) {
        expect(lab.starter.length, `${lab.title} has no starter file`).toBeGreaterThan(0);
        // A blank editor is not an exercise.
        expect(lab.starter.every((f) => f.content.trim().length > 0)).toBe(true);
        expect(lab.brief.length, `${lab.title} has a thin brief`).toBeGreaterThan(200);
      }
    });

    it("grading asserts on OUTPUT, never on fileExists alone", () => {
      for (const lab of LABS) {
        const kinds = lab.checks.map((c) => c.kind);
        expect(kinds.length, `${lab.title} has no checks`).toBeGreaterThan(0);
        // The artefact listing comes from inside the learner's own container, so `touch dist/app.js`
        // satisfies "did you produce dist/app.js". A lab graded only that way grades nothing.
        expect(
          kinds.some((k) => k === "exitCode" || k === "stdoutMatches"),
          `${lab.title} must assert on exit code or output`,
        ).toBe(true);
        expect(kinds.every((k) => k === "fileExists"), `${lab.title} relies only on fileExists`).toBe(false);
      }
    });

    it("no starter file already contains the answer", () => {
      // A starter that ships the solution is a lab everybody passes without reading it.
      for (const lab of LABS) {
        for (const f of lab.starter) {
          expect(
            /your code here|your tests here|\/\/ TODO/i.test(f.content),
            `${lab.title}/${f.path} does not look like a starting point`,
          ).toBe(true);
        }
      }
    });
  });

  describe.skipIf(!RUN)("seeding", () => {
    let A: string;
    beforeAll(async () => {
      await initTestDb();
      A = await createCompany("Gaia Digital Agency", ["lms", "hr"]);
      await seedWebdevCurriculum("Gaia Digital Agency");
      await seedWebdevLabs("Gaia Digital Agency");
    });
    afterAll(async () => { await teardownTestDb(); });

    it("attaches a gradeable lab to each of the three courses", async () => {
      const counts = await verifyWebdevLabs(A);
      expect(counts.labs).toBe(3);
      // A lab that is not gradeable makes its whole path permanently uncompletable — the failure
      // L4 refused to ship, and the reason no lab was authored before the runner existed.
      expect(counts.gradeable).toBe(3);
    });

    it("every seeded lab satisfies the L1 constraints that make a lab passable at all", async () => {
      const rows = await withTenants(
        [A],
        (c) => c.query<{ title: string; grading: string; pass_threshold: string | null; max_attempts: number | null;
                         spec: { files?: unknown[]; starter?: unknown[]; gradingSpec?: { checks?: unknown[] } } }>(
          `SELECT title, grading, pass_threshold, max_attempts, spec FROM lms_activities WHERE kind = 'lab'`,
        ),
        { modules: ["lms"] },
      );
      expect(rows.rows).toHaveLength(3);
      for (const r of rows.rows) {
        // ck_lms_activities_lab_graded: a lab is graded by the runner, so it must be auto.
        expect(r.grading, `${r.title}`).toBe("auto");
        // ck_lms_activities_threshold: without one, nothing could ever pass.
        expect(r.pass_threshold, `${r.title}`).not.toBeNull();
        expect(r.max_attempts, `${r.title}`).toBeGreaterThan(0);
        expect((r.spec.files ?? []).length, `${r.title} has no fixtures`).toBeGreaterThan(0);
        expect((r.spec.starter ?? []).length, `${r.title} has no starter`).toBeGreaterThan(0);
        expect((r.spec.gradingSpec?.checks ?? []).length, `${r.title} has no checks`).toBeGreaterThan(0);
      }
    });

    it("is idempotent — a second run creates nothing", async () => {
      const again = await seedWebdevLabs("Gaia Digital Agency");
      expect(again.created).toEqual([]);
      expect(again.existing).toHaveLength(3);
      expect((await verifyWebdevLabs(A)).labs).toBe(3);
    });

    it("REPORTS a lab whose course is missing rather than silently dropping it", async () => {
      // A silent skip leaves a discipline with no practice and no message anywhere saying why.
      const bare = await createCompany("No Curriculum Co", ["lms", "hr"]);
      expect(bare).toBeTruthy();
      const r = await seedWebdevLabs("No Curriculum Co");
      expect(r.created).toEqual([]);
      expect(r.skippedMissingCourse).toHaveLength(3);
      expect(r.skippedMissingCourse[0]).toMatch(/not found/);
    });
  });
});
