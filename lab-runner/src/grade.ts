// Grading a finished run.
//
// The grading spec is written by a course author and evaluated HERE, server-side. The browser never
// asserts a pass — an LMS whose grade is computed client-side grades whoever reads the JavaScript.
//
// Four check kinds, chosen because they cover FE/BE/QA and DevOps artefact grading between them
// without becoming a programming language:
//
//   exitCode      — the process succeeded (or failed, when failing is the point)
//   stdoutMatches — a regex over captured stdout: the test runner's own summary line
//   stdoutLacks   — a regex that must NOT appear: the failure signature
//   fileExists    — an artefact the submission was asked to produce
//
// Deliberately NOT a sandboxed grading script. A grader that runs author-supplied code is a second
// execution surface with none of sandbox.ts's protections, and it would be reached by exactly the
// people this system is teaching to look for such things.

export type Check =
  | { kind: "exitCode"; equals: number; weight?: number; describe?: string }
  | { kind: "stdoutMatches"; pattern: string; flags?: string; weight?: number; describe?: string }
  | { kind: "stdoutLacks"; pattern: string; flags?: string; weight?: number; describe?: string }
  | { kind: "fileExists"; path: string; weight?: number; describe?: string };

export interface GradingSpec {
  checks: Check[];
  /** Percentage needed to pass. The platform stores its own threshold too; this one is the
   *  runner's, so a run is self-describing in the log even when read in isolation. */
  passThreshold?: number;
}

export interface CheckResult {
  kind: Check["kind"];
  passed: boolean;
  weight: number;
  describe: string;
  /** What was actually seen. The single most useful field for a learner — a check that says only
   *  "failed" teaches nothing, and the whole point of a lab is that the failure is informative. */
  detail: string;
}

export interface Grade {
  score: number;
  passed: boolean;
  checks: CheckResult[];
}

export interface RunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Relative paths the run produced under its writable area. */
  artefacts: string[];
  timedOut: boolean;
}

/** A regex from an author-written spec. Compiled defensively — a bad pattern must fail the CHECK,
 *  never the whole run, or one typo in a course makes every submission error out. */
function compile(pattern: string, flags: string | undefined): RegExp | null {
  try {
    return new RegExp(pattern, flags ?? "");
  } catch {
    return null;
  }
}

const describeOf = (c: Check): string => {
  if (c.describe) return c.describe;
  switch (c.kind) {
    case "exitCode": return `the command exits with ${c.equals}`;
    case "stdoutMatches": return `output contains /${c.pattern}/`;
    case "stdoutLacks": return `output does not contain /${c.pattern}/`;
    case "fileExists": return `${c.path} was produced`;
  }
};

export function grade(spec: GradingSpec, outcome: RunOutcome): Grade {
  const checks: CheckResult[] = [];

  for (const c of spec.checks) {
    const weight = c.weight && c.weight > 0 ? c.weight : 1;
    const describe = describeOf(c);
    let passed = false;
    let detail = "";

    // A run killed by the wall clock fails everything, and says so once rather than producing four
    // confusing per-check failures. An infinite loop should read as "it did not finish".
    if (outcome.timedOut) {
      checks.push({ kind: c.kind, passed: false, weight, describe, detail: "the run hit its time limit" });
      continue;
    }

    switch (c.kind) {
      case "exitCode": {
        passed = outcome.exitCode === c.equals;
        detail = `exit code was ${outcome.exitCode ?? "none (killed)"}`;
        break;
      }
      case "stdoutMatches": {
        const re = compile(c.pattern, c.flags);
        if (!re) { detail = `the challenge's pattern is not valid: /${c.pattern}/`; break; }
        passed = re.test(outcome.stdout);
        detail = passed ? "found in output" : "not found in output";
        break;
      }
      case "stdoutLacks": {
        const re = compile(c.pattern, c.flags);
        if (!re) { detail = `the challenge's pattern is not valid: /${c.pattern}/`; break; }
        const hit = re.exec(outcome.stdout);
        passed = hit === null;
        detail = passed ? "absent, as required" : `found: ${truncate(hit![0], 120)}`;
        break;
      }
      case "fileExists": {
        // Compared on a normalised relative path so `./dist/app.js` and `dist/app.js` agree.
        const want = c.path.replace(/^\.\//, "").replace(/\\/g, "/");
        passed = outcome.artefacts.some((a) => a.replace(/\\/g, "/") === want);
        detail = passed
          ? "produced"
          : outcome.artefacts.length
            ? `not produced. The run produced: ${outcome.artefacts.slice(0, 8).join(", ")}`
            : "not produced, and the run produced no files at all";
        break;
      }
    }
    checks.push({ kind: c.kind, passed, weight, describe, detail });
  }

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const earned = checks.reduce((n, c) => n + (c.passed ? c.weight : 0), 0);
  // NULL-shaped case: a spec with no checks scores ZERO, never 100. "Nothing to check" and "passed
  // everything" are different findings, and a misconfigured challenge that auto-passes would
  // certify people against nothing — the same rule completionPct follows on the UI side.
  const score = total > 0 ? Math.round((earned / total) * 10000) / 100 : 0;
  const threshold = spec.passThreshold ?? 100;
  return { score, passed: total > 0 && score >= threshold, checks };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
