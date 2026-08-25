// LMS L5c/L6b/L6c — the FE/BE/QA/DevOps/Cyber labs.
//
// Two properties matter more than anything else here, and neither is about the database:
//   1. a lab's REFERENCE solution must pass, or the lab teaches people that correct work fails;
//   2. a lab's STARTER must fail, or the lab teaches nothing at all.
//
// FE/BE/QA were verified against the DEPLOYED runner on 2026-08-25 (reference: 100/100/100; starter:
// 0/0/14.29). DevOps and Cyber were verified the same way, against a throwaway sibling runner on
// SumoPod (never the production `gaiada-lms-lab-runner` container) — see the L6 drive notes. That
// cannot run here — this suite has no Docker and no runner — so what it pins is everything that would
// make those two properties silently stop holding: the fixtures are present, the graded entry script
// is a FIXTURE (not a starter file the learner could overwrite), the checks assert on output rather
// than on `fileExists` alone, every lab is gradeable at all, and the two L6 shapes this file newly
// introduces — a real-tool-graded DevOps lab and a Cyber lab with a companion `target` — are actually
// present and shaped correctly.
//
// Needs DATABASE_URL_TEST. Skips otherwise — CHECK THE SKIP COUNT.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedWebdevCurriculum } from "./lms-webdev-curriculum";
import { seedWebdevLabs, verifyWebdevLabs, LABS } from "./lms-webdev-labs";

const RUN = !!TEST_URL;

describe("LMS L5c/L6b/L6c — the hands-on labs", () => {
  // These are pure and run everywhere, including without a database.
  describe("the lab definitions", () => {
    it("covers FE, BE, QA, DevOps and Cyber — every discipline the runner can now grade", () => {
      expect(LABS.map((l) => l.courseKey).sort()).toEqual([
        "webdev-be-practice", "webdev-cyber-practice", "webdev-devops-practice",
        "webdev-fe-practice", "webdev-qa-practice",
      ]);
    });

    it("every lab ships an entry script as a FIXTURE, and any graded test file is one too", () => {
      // Generalised from the L5c version of this assertion: FE/BE/QA grade via a JS harness and a
      // `test.js` fixture; DevOps and Cyber grade on a real tool's own output instead and have no
      // such file. The INTENT that survives across both shapes: whatever decides the verdict must be
      // a FIXTURE, never a starter file the learner could overwrite to pass unconditionally.
      for (const lab of LABS) {
        const paths = lab.fixtures.map((f) => f.path);
        const starterPaths = lab.starter.map((f) => f.path);
        expect(paths, `${lab.title} has no run.sh`).toContain("run.sh");
        expect(starterPaths, `${lab.title}: run.sh must not be a starter file`).not.toContain("run.sh");
        if (paths.includes("test.js") || starterPaths.includes("test.js")) {
          // THE assertion for the JS-harness labs. `lab-dispatch.ts` refuses to let a learner file
          // displace a fixture, so a graded test file listed as a STARTER instead would be
          // overwritable — and overwriting it with `process.exit(0)` is the obvious full-marks
          // exploit.
          expect(paths, `${lab.title} has no test.js`).toContain("test.js");
          expect(starterPaths, `${lab.title}: test.js must not be a starter file`).not.toContain("test.js");
        }
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

    it("the DevOps lab is graded on a REAL tool's own output, never on fileExists", () => {
      const devops = LABS.find((l) => l.courseKey === "webdev-devops-practice");
      expect(devops, "no DevOps lab found").toBeTruthy();
      expect(devops!.image).toBe("nginx");
      // The requirement nginx -t can actually catch, in nginx's own words — not a fabricated string
      // this course invented, which is the whole point of grading on the real binary.
      const patterns = devops!.checks.map((c) => (c as { pattern?: string }).pattern).filter(Boolean);
      expect(patterns.some((p) => /successful/.test(p!))).toBe(true);
      expect(devops!.checks.some((c) => c.kind === "exitCode")).toBe(true);
    });

    it("the Cyber lab carries a disposable companion target on an isolated network only", () => {
      const cyber = LABS.find((l) => l.courseKey === "webdev-cyber-practice");
      expect(cyber, "no Cyber lab found").toBeTruthy();
      expect(cyber!.target).toEqual({ image: "nettools", alias: "target", readySec: 4 });
      // A target without an isolated network would run against nothing reachable — explicit here
      // even though `runLab` in the runner also infers it from the presence of `target`, because a
      // spec that relied on inference alone would silently stop meaning anything if that inference
      // ever changed.
      expect(cyber!.limits?.network).toBe("isolated");
      // The flag is the answer key: it must live inside `gradingSpec` (checks), which
      // spec-redaction.ts strips WHOLESALE for a non-author, never in `brief` or a fixture a learner
      // can read. Matched on the flag's hex payload rather than the literal `FLAG{` — the pattern
      // field escapes its braces for `new RegExp()`, so `FLAG\{` (escaped) is what actually appears
      // in the serialised checks, not the bare `FLAG{` a learner-visible field would leak.
      // The flag is NOT asserted by VALUE — it is not in this repository at all (the seed reads
      // `LMS_CYBER_FLAG`). What is asserted is the SHAPE and, more importantly, that the flag never
      // appears anywhere a learner can read: `spec-redaction.ts` strips `gradingSpec` wholesale, so
      // a flag in `brief` or a fixture would be the one copy that leaks.
      // Asserted by SHAPE, never by value — the flag is not in this repository (the seed reads
      // `LMS_CYBER_FLAG`). Booleans rather than raw JSON on purpose: a failing `toMatch` against the
      // serialised checks would print the flag into the test output, which is the same leak by a
      // slower route. Learned the hard way.
      const checksJson = JSON.stringify(cyber!.checks);
      expect(/FLAG/.test(checksJson), "the Cyber grading spec must assert on a flag").toBe(true);
      expect(/[a-f0-9]{12,}/.test(checksJson), "the flag pattern must carry a hex payload").toBe(true);
      // And the flag must appear NOWHERE a learner can read: spec-redaction.ts strips `gradingSpec`
      // wholesale, so a copy in `brief` or a fixture would be the one that leaks.
      expect(/FLAG\{[a-f0-9]/.test(cyber!.brief), "the brief must not contain the flag").toBe(false);
      for (const f of [...cyber!.fixtures, ...cyber!.starter]) {
        expect(/FLAG\{[a-f0-9]/.test(f.content), `${f.path} must not contain the flag`).toBe(false);
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

    it("attaches a gradeable lab to each of the five courses", async () => {
      const counts = await verifyWebdevLabs(A);
      expect(counts.labs).toBe(5);
      // A lab that is not gradeable makes its whole path permanently uncompletable — the failure
      // L4 refused to ship, and the reason no lab was authored before the runner existed.
      expect(counts.gradeable).toBe(5);
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
      expect(rows.rows).toHaveLength(5);
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

    it("stores the Cyber lab's target in the row spec, ready for lab-dispatch.ts to forward it", async () => {
      const rows = await withTenants(
        [A],
        (c) => c.query<{ spec: { target?: { image: string; alias?: string; readySec?: number }; image: string } }>(
          `SELECT spec FROM lms_activities WHERE kind = 'lab' AND title = $1`,
          ["Lab: exploit a command injection and read the flag"],
        ),
        { modules: ["lms"] },
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.spec.image).toBe("node22");
      expect(rows.rows[0]!.spec.target).toEqual({ image: "nettools", alias: "target", readySec: 4 });
    });

    it("is idempotent — a second run creates nothing", async () => {
      const again = await seedWebdevLabs("Gaia Digital Agency");
      expect(again.created).toEqual([]);
      expect(again.existing).toHaveLength(5);
      expect((await verifyWebdevLabs(A)).labs).toBe(5);
    });

    it("REPORTS a lab whose course is missing rather than silently dropping it", async () => {
      // A silent skip leaves a discipline with no practice and no message anywhere saying why.
      const bare = await createCompany("No Curriculum Co", ["lms", "hr"]);
      expect(bare).toBeTruthy();
      const r = await seedWebdevLabs("No Curriculum Co");
      expect(r.created).toEqual([]);
      expect(r.skippedMissingCourse).toHaveLength(5);
      expect(r.skippedMissingCourse[0]).toMatch(/not found/);
    });
  });
});
