import { describe, it, expect } from "vitest";
import { grade, type GradingSpec, type RunOutcome } from "./grade.js";

const outcome = (o: Partial<RunOutcome> = {}): RunOutcome => ({
  exitCode: 0, stdout: "", stderr: "", artefacts: [], timedOut: false, ...o,
});

describe("grade", () => {
  it("scores by weight and reports each check with what was actually seen", () => {
    const spec: GradingSpec = {
      passThreshold: 75,
      checks: [
        { kind: "exitCode", equals: 0, weight: 2 },
        { kind: "stdoutMatches", pattern: "12 passing" },
        { kind: "stdoutLacks", pattern: "failing" },
      ],
    };
    const g = grade(spec, outcome({ stdout: "12 passing (40ms)" }));
    expect(g.score).toBe(100);
    expect(g.passed).toBe(true);
    // The detail field is the whole value of a lab: a check that says only "failed" teaches nothing.
    expect(g.checks[0]!.detail).toContain("exit code was 0");
    expect(g.checks.every((c) => c.describe.length > 0)).toBe(true);
  });

  it("a spec with no checks scores ZERO, never 100", () => {
    // "Nothing to check" and "passed everything" are different findings. A misconfigured challenge
    // that auto-passed would certify people against nothing — the same rule completionPct follows.
    const g = grade({ checks: [] }, outcome());
    expect(g.score).toBe(0);
    expect(g.passed).toBe(false);
  });

  it("a timed-out run fails every check, and says why once", () => {
    const spec: GradingSpec = { checks: [{ kind: "exitCode", equals: 0 }, { kind: "stdoutMatches", pattern: "ok" }] };
    const g = grade(spec, outcome({ timedOut: true, stdout: "ok", exitCode: 0 }));
    expect(g.passed).toBe(false);
    // Even the checks that WOULD have passed. An infinite loop should read as "it did not finish",
    // not as four confusing unrelated failures.
    for (const c of g.checks) {
      expect(c.passed).toBe(false);
      expect(c.detail).toContain("time limit");
    }
  });

  it("an invalid author-written pattern fails the CHECK, not the whole run", () => {
    const g = grade({ checks: [{ kind: "stdoutMatches", pattern: "(unclosed" }] }, outcome({ stdout: "anything" }));
    // One typo in a course must not make every submission error out.
    expect(g.checks[0]!.passed).toBe(false);
    expect(g.checks[0]!.detail).toContain("not valid");
  });

  it("stdoutLacks quotes what it found, so the learner can see the failure", () => {
    const g = grade({ checks: [{ kind: "stdoutLacks", pattern: "TypeError.*undefined" }] },
                    outcome({ stdout: "TypeError: cannot read properties of undefined" }));
    expect(g.checks[0]!.passed).toBe(false);
    expect(g.checks[0]!.detail).toContain("TypeError");
  });

  it("fileExists normalises ./ and lists what WAS produced when it is missing", () => {
    const spec: GradingSpec = { checks: [{ kind: "fileExists", path: "./dist/app.js" }] };
    expect(grade(spec, outcome({ artefacts: ["dist/app.js"] })).checks[0]!.passed).toBe(true);
    const missing = grade(spec, outcome({ artefacts: ["dist/other.js", "build.log"] }));
    expect(missing.checks[0]!.passed).toBe(false);
    // Naming what WAS produced is the difference between "not produced" and a debuggable message.
    expect(missing.checks[0]!.detail).toContain("dist/other.js");
    expect(grade(spec, outcome({ artefacts: [] })).checks[0]!.detail).toContain("no files at all");
  });

  it("passThreshold defaults to 100 — a challenge that does not say is strict, not lenient", () => {
    const spec: GradingSpec = { checks: [{ kind: "exitCode", equals: 0 }, { kind: "stdoutMatches", pattern: "nope" }] };
    const g = grade(spec, outcome({ stdout: "" }));
    expect(g.score).toBe(50);
    expect(g.passed).toBe(false);
  });

  it("weights actually weight", () => {
    const spec: GradingSpec = {
      passThreshold: 50,
      checks: [
        { kind: "exitCode", equals: 0, weight: 9 },
        { kind: "stdoutMatches", pattern: "never", weight: 1 },
      ],
    };
    const g = grade(spec, outcome());
    expect(g.score).toBe(90);
    expect(g.passed).toBe(true);
  });
});
