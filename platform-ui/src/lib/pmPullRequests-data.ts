import "server-only";
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";

// DW-6f (docs/FRONTEND-BFF-CONTRACT.md §34.6, §34.7) — the pull requests linked to a PM task, with their CI status.
//
//   GET /api/:t/pm/tasks/:taskId/pull-requests
//     -> { taskKey, linkable, repoLinked, pullRequests: [{ repo, number, title, state, merged, draft, headRef, url,
//          authorLogin, updatedAt, ci: { summary, runs: [{ name, status, conclusion, url, at }] } }] }
//
// A `ReadResult`, not a degrade-to-[]: an empty list here is a CLAIM ("no pull requests"), and a read that failed must
// never say it. The page renders `unavailable` as "Pull requests unavailable", never as an empty section.

export type CiSummary = "passing" | "failing" | "running" | "none";

export interface PullRequestCiRun {
  name: string;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  at: string | null;
}

export interface TaskPullRequest {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  url: string;
  authorLogin: string | null;
  updatedAt: string;
  ci: { summary: CiSummary; runs: PullRequestCiRun[] };
}

export interface TaskPullRequests {
  /** The task's key (`WEB-12`), or null when its project has no short code. */
  taskKey: string | null;
  /** The company can link pull requests at all (it owns the GitHub organisation). False: the list is always empty. */
  linkable: boolean;
  /** A live repository is linked to the task's project. Decides whether the key convention is taught. */
  repoLinked: boolean;
  /** Open first, then newest. */
  pullRequests: TaskPullRequest[];
}

export const getTaskPullRequests = (userId: string, tenant: string, taskId: string): Promise<ReadResult<TaskPullRequests>> =>
  readResult(platformFetch<TaskPullRequests>(`/api/${tenant}/pm/tasks/${taskId}/pull-requests`, userId));

// ── presentation mapping (pure) ────────────────────────────────────────────────────────────────────

export type PullRequestStateLabel = "Open" | "Draft" | "Merged" | "Closed";

/** Merged beats Closed (a merged pull request is also closed); Draft only while open. */
export function pullRequestStateLabel(pr: Pick<TaskPullRequest, "state" | "merged" | "draft">): PullRequestStateLabel {
  if (pr.merged) return "Merged";
  if (pr.state === "closed") return "Closed";
  return pr.draft ? "Draft" : "Open";
}

/** The CI chip's word for a summary, or null for none (no chip at all). */
export const CI_CHIP_LABEL: Record<CiSummary, string | null> = {
  passing: "Passing",
  failing: "Failing",
  running: "Running",
  none: null,
};

/** One workflow's line in the chip's tooltip: "CI: success", "Lint: running", "Deploy: queued". */
export function ciRunText(run: PullRequestCiRun): string {
  const result = run.status === "completed" ? (run.conclusion ?? "completed") : (run.status === "in_progress" ? "running" : (run.status ?? "unknown"));
  return `${run.name}: ${result.replace(/_/g, " ")}`;
}
