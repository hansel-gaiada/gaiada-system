// M5-W2b — the problem slugs of the review commands (RFC 9457, via content-problem.ts's ControlProblem).
import { ControlProblem, problems } from "../content/content-problem";
import type { ReviewState } from "./editorial-model";

export const editorialProblems = {
  /** Review is off for this collection (no policy row, or review_required false): every item command refuses. */
  notEnabled: (collectionKey: string) =>
    problems.conflict(
      "review-not-enabled",
      "Review is not enabled",
      `Editorial review is not enabled for the "${collectionKey}" collection on this site. Nothing was changed.`,
      { collectionKey },
    ),
  stateConflict: (currentState: ReviewState, command: string) =>
    problems.conflict(
      "review-state-conflict",
      "Review state conflict",
      `${command} is not allowed while the item is ${currentState}. Nothing was changed.`,
      { currentState },
    ),
  versionMismatch: (expectedVersion: number, givenVersion: number, what: string) =>
    problems.conflict(
      "review-version-mismatch",
      "Review version mismatch",
      `Version ${givenVersion} is not ${what} (${expectedVersion}). Reload the item and act on that version. Nothing was changed.`,
      { expectedVersion, givenVersion },
    ),
  seoSignoffRequired: (version: number) =>
    problems.conflict(
      "seo-signoff-required",
      "SEO sign-off required",
      `This collection requires an SEO/AEO sign-off of version ${version} before it can be approved. Nothing was changed.`,
      { version },
    ),
  /** 403: approving and signing off are human decisions; an automation or agent principal never makes them. */
  principalNotAllowed: (command: string) =>
    new ControlProblem(
      403,
      "review-principal-not-allowed",
      "Principal not allowed to review",
      `${command} is a human decision: an automation or agent principal may not make it. Nothing was changed.`,
    ),
  /** 403: maker is not checker. The approver may not be the creator of the very version being approved. */
  selfApproval: (version: number) =>
    new ControlProblem(
      403,
      "review-self-approval",
      "Maker may not approve",
      `Version ${version} was written by this principal, so it cannot approve it: a different person must. Nothing was changed.`,
    ),
  commentNotFound: () => new ControlProblem(404, "comment-not-found", "Comment not found", "No such comment on this item."),
};
