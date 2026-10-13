// DW-6f (docs/FRONTEND-BFF-CONTRACT.md §34.7) — the Pull requests section's four states, and the chip and state mapping.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PullRequestsSection } from "./PullRequests";
import {
  CI_CHIP_LABEL, ciRunText, pullRequestStateLabel,
  type TaskPullRequest, type TaskPullRequests,
} from "@/lib/pmPullRequests-data";
import type { ReadResult } from "@/lib/readResult";

const pr = (over: Partial<TaskPullRequest> = {}): TaskPullRequest => ({
  repo: "gaiadabali/site", number: 7, title: "WEB-12 add the nav", state: "open", merged: false, draft: false,
  headRef: "feature/web-12-nav", url: "https://github.com/gaiadabali/site/pull/7", authorLogin: "octocat",
  updatedAt: "2026-10-13T10:00:00.000Z", ci: { summary: "none", runs: [] },
  ...over,
});
const ok = (over: Partial<TaskPullRequests> = {}): ReadResult<TaskPullRequests> => ({
  kind: "ok",
  data: { taskKey: "WEB-12", linkable: true, repoLinked: true, pullRequests: [], ...over },
});

describe("PullRequestsSection states", () => {
  it("lists each pull request as a repo#number link plus title, opening GitHub in a new tab", () => {
    render(<PullRequestsSection result={ok({ pullRequests: [pr()] })} />);
    const link = screen.getByRole("link", { name: /gaiadabali\/site#7/ });
    expect(link).toHaveAttribute("href", "https://github.com/gaiadabali/site/pull/7");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link).toHaveTextContent("WEB-12 add the nav");
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("feature/web-12-nav")).toBeInTheDocument();
    expect(screen.getByText("Pull requests")).toBeInTheDocument();
  });

  it("shows the state in words: Open, Draft, Merged, Closed", () => {
    render(
      <PullRequestsSection
        result={ok({
          pullRequests: [
            pr({ number: 1 }),
            pr({ number: 2, draft: true }),
            pr({ number: 3, state: "closed", merged: true }),
            pr({ number: 4, state: "closed" }),
          ],
        })}
      />,
    );
    for (const word of ["Open", "Draft", "Merged", "Closed"]) expect(screen.getByText(word)).toBeInTheDocument();
  });

  it("shows no CI chip when a pull request has no CI entries", () => {
    const { container } = render(<PullRequestsSection result={ok({ pullRequests: [pr()] })} />);
    expect(container.querySelector(".pm-pr__ci")).toBeNull();
  });

  it("shows a CI chip with the word, and the per-workflow detail as a tooltip and as text", () => {
    const { container } = render(
      <PullRequestsSection
        result={ok({
          pullRequests: [
            pr({
              ci: {
                summary: "failing",
                runs: [
                  { name: "CI", status: "completed", conclusion: "failure", url: null, at: null },
                  { name: "Lint", status: "in_progress", conclusion: null, url: null, at: null },
                ],
              },
            }),
          ],
        })}
      />,
    );
    const chip = container.querySelector(".pm-pr__ci--failing")!;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("CI Failing");
    expect(chip.getAttribute("title")).toBe("CI: failure\nLint: running");
    expect(container.querySelector(".pm-sr-only")!.textContent).toBe("CI: failure; Lint: running");
  });

  it("with none, and a linked repository and a task key: the one quiet teaching line naming the key", () => {
    render(<PullRequestsSection result={ok()} />);
    expect(screen.getByText("Pull requests")).toBeInTheDocument();
    expect(screen.getByText("No pull requests yet. Put WEB-12 in a branch name or pull request title to link one.")).toBeInTheDocument();
  });

  it("with none and no linked repository: nothing at all", () => {
    const { container } = render(<PullRequestsSection result={ok({ repoLinked: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("with none and no task key: nothing at all", () => {
    const { container } = render(<PullRequestsSection result={ok({ taskKey: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("with none in a company that cannot link: nothing at all, even with a linked repository", () => {
    const { container } = render(<PullRequestsSection result={ok({ linkable: false, repoLinked: true })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a failed read says so, and never reads as an empty section", () => {
    render(<PullRequestsSection result={{ kind: "unavailable", reason: "platform 502" }} />);
    expect(screen.getByText("Pull requests unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/No pull requests yet/)).toBeNull();
  });

  it("a refused read says so too", () => {
    render(<PullRequestsSection result={{ kind: "forbidden" }} />);
    expect(screen.getByText(/don.t have access to pull requests/i)).toBeInTheDocument();
  });
});

describe("pullRequestStateLabel", () => {
  it("merged beats closed; draft only while open", () => {
    expect(pullRequestStateLabel({ state: "open", merged: false, draft: false })).toBe("Open");
    expect(pullRequestStateLabel({ state: "open", merged: false, draft: true })).toBe("Draft");
    expect(pullRequestStateLabel({ state: "closed", merged: true, draft: false })).toBe("Merged");
    expect(pullRequestStateLabel({ state: "closed", merged: false, draft: false })).toBe("Closed");
    expect(pullRequestStateLabel({ state: "closed", merged: false, draft: true })).toBe("Closed");
  });
});

describe("CI chip mapping", () => {
  it("maps every summary to its word, and none to no chip", () => {
    expect(CI_CHIP_LABEL).toEqual({ passing: "Passing", failing: "Failing", running: "Running", none: null });
  });

  it("words each workflow line for the tooltip", () => {
    expect(ciRunText({ name: "CI", status: "completed", conclusion: "success", url: null, at: null })).toBe("CI: success");
    expect(ciRunText({ name: "CI", status: "completed", conclusion: "timed_out", url: null, at: null })).toBe("CI: timed out");
    expect(ciRunText({ name: "CI", status: "completed", conclusion: null, url: null, at: null })).toBe("CI: completed");
    expect(ciRunText({ name: "Lint", status: "in_progress", conclusion: null, url: null, at: null })).toBe("Lint: running");
    expect(ciRunText({ name: "Deploy", status: "queued", conclusion: null, url: null, at: null })).toBe("Deploy: queued");
    expect(ciRunText({ name: "X", status: null, conclusion: null, url: null, at: null })).toBe("X: unknown");
  });
});
