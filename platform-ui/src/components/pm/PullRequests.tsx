import type { ReadResult } from "@/lib/readResult";
import {
  CI_CHIP_LABEL, ciRunText, pullRequestStateLabel,
  type TaskPullRequest, type TaskPullRequests,
} from "@/lib/pmPullRequests-data";
import { Section } from "@/components/pm/Section";
import "./pm.css"; // carries the shared `.pm-sr-only` helper
import "./task-detail.css";

// DW-6f (docs/FRONTEND-BFF-CONTRACT.md §34.7) — the "Pull requests" section of the task page: the pull requests linked
// to this task through its key, with their state and CI status. Presentational and hook-free, like UrgencyChip, so the
// task page (a Server Component) renders it and a test can render every state from a plain `ReadResult`.
//
// What shows when:
//   pull requests exist                 -> the list.
//   none, repoLinked and a task key     -> one quiet line teaching the key convention.
//   none, not linkable (or otherwise)   -> NOTHING AT ALL (the convention is not taught where it cannot work).
//   the read failed                     -> "Pull requests unavailable": an empty section would claim "none".

function CiChip({ pr }: { pr: TaskPullRequest }) {
  const word = CI_CHIP_LABEL[pr.ci.summary];
  if (!word) return null; // no CI entries: no chip
  const detail = pr.ci.runs.map(ciRunText).join("\n");
  return (
    <span className={`pm-pr__ci pm-pr__ci--${pr.ci.summary}`} title={detail}>
      <span className="pm-pr__ci-word">CI {word}</span>
      {/* The tooltip is not reliably announced or reachable, so the per-workflow results are also real (visually hidden) text. */}
      <span className="pm-sr-only">{pr.ci.runs.map(ciRunText).join("; ")}</span>
    </span>
  );
}

function PullRequestRow({ pr }: { pr: TaskPullRequest }) {
  const state = pullRequestStateLabel(pr);
  return (
    <li className="pm-pr__row">
      <div className="pm-pr__line">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="pm-pr__link">
          <span className="pm-pr__ref">{pr.repo}#{pr.number}</span> <span className="pm-pr__title">{pr.title}</span>
        </a>
      </div>
      <div className="pm-pr__meta">
        <span className={`pm-pr__state pm-pr__state--${state.toLowerCase()}`}>{state}</span>
        <code className="pm-pr__branch" title="Branch">{pr.headRef}</code>
        <CiChip pr={pr} />
      </div>
    </li>
  );
}

export function PullRequestsSection({ result }: { result: ReadResult<TaskPullRequests> }) {
  if (result.kind === "forbidden") {
    return (
      <Section label="Pull requests">
        <p className="pm-desc pm-desc--empty">You don&apos;t have access to pull requests.</p>
      </Section>
    );
  }
  if (result.kind === "unavailable") {
    return (
      <Section label="Pull requests">
        <p className="pm-desc pm-desc--empty" title={result.reason}>Pull requests unavailable</p>
      </Section>
    );
  }

  const { pullRequests, linkable, repoLinked, taskKey } = result.data;
  if (pullRequests.length > 0) {
    return (
      <Section label="Pull requests" count={pullRequests.length}>
        <ul className="pm-pr">
          {pullRequests.map((pr) => <PullRequestRow key={`${pr.repo}#${pr.number}`} pr={pr} />)}
        </ul>
      </Section>
    );
  }
  if (linkable && repoLinked && taskKey) {
    return (
      <Section label="Pull requests">
        <p className="pm-desc pm-desc--empty">
          No pull requests yet. Put {taskKey} in a branch name or pull request title to link one.
        </p>
      </Section>
    );
  }
  return null;
}
