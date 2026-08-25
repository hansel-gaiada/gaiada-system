// Dispatching a lab attempt to the runner, and recording what came back.
//
// The runner (`lab-runner/`) is a separate service with NO ERP network path. It holds no learner
// identity, never reaches Postgres, and returns a graded result over HTTP. This file is the whole
// of the platform's side of that seam.
//
// ── THE GRADE IS AUTHORITATIVE SERVER-SIDE ────────────────────────────────────────────────────
// The browser never asserts a pass, and neither does the learner's container: the runner evaluates
// the challenge's own grading spec and this module records the verdict. A learner controls the code
// that runs, never the sentence that says whether it passed.
//
// ── FAIL-SOFT, LIKE EVERY OTHER OPTIONAL DOWNSTREAM IN THIS ESTATE ────────────────────────────
// No runner configured means a lab attempt is REFUSED with a clear message, not accepted and left
// pending forever. "Submitted, awaiting the runner" when no runner exists is the shape that leaves
// somebody waiting on a service nobody is building — and their path uncompletable.
import type { PoolClient } from "pg";
import { config } from "../../config";

export interface LabCheckResult {
  kind: string; passed: boolean; weight: number; describe: string; detail: string;
}
export interface LabGrade { score: number; passed: boolean; checks: LabCheckResult[] }

export interface LabRunOutcome {
  runnerRunId: string | null;
  status: "succeeded" | "failed" | "error";
  score: number | null;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  checks: LabCheckResult[];
  artefacts: string[];
  error?: string;
  durationMs: number | null;
}

export interface LabSpec {
  image: string;
  files: { path: string; content: string }[];
  command?: string[];
  limits?: Record<string, unknown>;
  gradingSpec: { checks: unknown[]; passThreshold?: number };
}

/** Bounded before it reaches Postgres. A runaway `yes` would otherwise put megabytes per attempt
 *  into the database that backs the whole ERP. */
const CAP = 32 * 1024;
export const clampOutput = (s: string | undefined): string => {
  if (!s) return "";
  return s.length <= CAP ? s : `${s.slice(0, CAP)}\n… truncated at ${CAP} bytes …`;
};

export const labRunnerConfigured = (): boolean =>
  Boolean(config.labRunner.url && config.labRunner.token);

/**
 * Build the runner request from an activity's `spec` plus the learner's files.
 *
 * ⚠ THE CHALLENGE OWNS THE GRADING SPEC AND THE IMAGE; THE LEARNER OWNS ONLY THE FILES. They are
 *   assembled here rather than passed through from the request body, because a learner who could
 *   supply their own `gradingSpec` could pass every lab, and one who could supply their own `image`
 *   would be naming a container to run on a host carrying other people's production. The runner
 *   refuses an unknown image key as well — two locks, on the same door, on purpose.
 */
export function buildLabRequest(
  activitySpec: Record<string, unknown>,
  learnerFiles: { path: string; content: string }[],
  challengeId: string,
): LabSpec & { challengeId: string } {
  const image = typeof activitySpec.image === "string" ? activitySpec.image : "node22";
  const fixtures = Array.isArray(activitySpec.files)
    ? (activitySpec.files as { path: string; content: string }[])
    : [];
  const grading = (activitySpec.gradingSpec ?? { checks: [] }) as LabSpec["gradingSpec"];

  // Challenge fixtures FIRST, learner files second — but a learner file may not overwrite a
  // fixture, or the graded tests are whatever the learner decided they should be. Filtered rather
  // than merged: last-write-wins here would be a silent full-marks exploit.
  const fixturePaths = new Set(fixtures.map((f) => f.path));
  const safeLearnerFiles = learnerFiles.filter((f) => !fixturePaths.has(f.path));

  return {
    challengeId,
    image,
    files: [...fixtures, ...safeLearnerFiles],
    ...(Array.isArray(activitySpec.command) ? { command: activitySpec.command as string[] } : {}),
    ...(activitySpec.limits ? { limits: activitySpec.limits as Record<string, unknown> } : {}),
    gradingSpec: grading,
  };
}

/** Files a learner may overwrite were dropped — reported so a puzzled learner can be told why. */
export function droppedLearnerFiles(
  activitySpec: Record<string, unknown>,
  learnerFiles: { path: string; content: string }[],
): string[] {
  const fixtures = Array.isArray(activitySpec.files)
    ? (activitySpec.files as { path: string }[])
    : [];
  const fixturePaths = new Set(fixtures.map((f) => f.path));
  return learnerFiles.filter((f) => fixturePaths.has(f.path)).map((f) => f.path);
}

/**
 * How many labs this person has dispatched in the window.
 *
 * Counted from `lms_lab_runs` rather than from attempts, because a run that errored still consumed
 * compute on somebody else's box — and a rate limit that only counts successes is one an attacker
 * can drive by failing.
 */
export async function recentLabRunCount(
  c: PoolClient, subjectUserId: string, windowMinutes: number,
): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lms_lab_runs
      WHERE subject_user_id = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [subjectUserId, String(windowMinutes)],
  );
  return Number(r.rows[0].n);
}

class LabRunnerError extends Error {}

/**
 * Submit to the runner and wait for the verdict.
 *
 * Polls rather than blocking the runner: its queue is deliberately shallow (the host it lives on
 * runs other people's production), so a request that held a connection open would tie up a platform
 * worker for the length of somebody else's queue as well as its own.
 */
export async function runLab(req: LabSpec & { challengeId: string }): Promise<LabRunOutcome> {
  const base = config.labRunner.url.replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${config.labRunner.token}`,
    "content-type": "application/json",
  };
  const empty: Omit<LabRunOutcome, "status" | "error"> = {
    runnerRunId: null, score: null, exitCode: null, timedOut: false,
    stdout: "", stderr: "", checks: [], artefacts: [], durationMs: null,
  };

  let runId: string;
  try {
    const res = await fetch(`${base}/runs`, {
      method: "POST", headers, body: JSON.stringify(req),
      signal: AbortSignal.timeout(config.labRunner.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string };
    if (res.status === 429) {
      // The runner is saturated. Reported as-is: "try again shortly" is the truth, and dressing it
      // up as a failure would tell a learner their code was wrong when it was never run.
      throw new LabRunnerError(body.error ?? "the lab runner is busy — try again shortly");
    }
    if (!res.ok || !body.runId) {
      throw new LabRunnerError(body.error ?? `the lab runner refused the submission (${res.status})`);
    }
    runId = body.runId;
  } catch (e) {
    return { ...empty, status: "error", error: describe(e) };
  }

  const deadline = Date.now() + config.labRunner.pollTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, config.labRunner.pollIntervalMs));
    try {
      const res = await fetch(`${base}/runs/${runId}`, {
        headers, signal: AbortSignal.timeout(config.labRunner.timeoutMs),
      });
      if (res.status === 404) {
        // The runner drops results after its TTL. Reaching here means we polled past it, which is
        // a configuration error on our side, not a learner failure.
        return { ...empty, runnerRunId: runId, status: "error", error: "the lab result expired before it was collected" };
      }
      const body = (await res.json()) as Record<string, unknown>;
      const status = String(body.status ?? "");
      if (status === "queued" || status === "running") continue;

      const grade = body.grade as LabGrade | null;
      return {
        runnerRunId: String(body.runId ?? runId),
        status: status === "succeeded" ? "succeeded" : status === "failed" ? "failed" : "error",
        score: grade ? grade.score : null,
        exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
        timedOut: body.timedOut === true,
        stdout: clampOutput(body.stdout as string),
        stderr: clampOutput(body.stderr as string),
        checks: grade?.checks ?? [],
        artefacts: Array.isArray(body.artefacts) ? (body.artefacts as string[]).slice(0, 200) : [],
        ...(body.error ? { error: String(body.error) } : {}),
        durationMs: typeof body.durationMs === "number" ? body.durationMs : null,
      };
    } catch (e) {
      return { ...empty, runnerRunId: runId, status: "error", error: describe(e) };
    }
  }
  // We gave up waiting; the RUN may still be going. Deliberately not called a failure — nobody
  // knows yet whether the code was right, and saying "failed" would be a claim we cannot support.
  return { ...empty, runnerRunId: runId, status: "error", error: "timed out waiting for the lab runner" };
}

function describe(e: unknown): string {
  if (e instanceof LabRunnerError) return e.message;
  if (e instanceof Error && e.name === "TimeoutError") return "the lab runner did not respond in time";
  return `could not reach the lab runner: ${e instanceof Error ? e.message : String(e)}`;
}
