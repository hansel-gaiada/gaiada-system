// M5-W2b (writers' room design 4.1) — the review state machine as data. Pure: no database, no Nest, so it runs
// on any box. EVERY (command, state) pair is walked against the table: each legal one lands where the design says,
// each illegal one answers review-state-conflict, which the problem builder turns into 409 with that slug and the
// current state. The same pairs are driven over HTTP in editorial-commands.spec.ts (needs the Linux gate).
import { describe, expect, it } from "vitest";
import {
  EDITORIAL_EVENT_KINDS,
  EVENT_KIND_FORMAT,
  REVIEW_STATES,
  TRANSITIONS,
  TRANSITION_COMMANDS,
  evaluateTransition,
  stateAfterNewVersion,
  type ReviewState,
  type TransitionCommand,
} from "../src/control/editorial/editorial-model";
import { editorialProblems } from "../src/control/editorial/editorial-problems";

/** The design's table (4.1), written out independently of the implementation: [command, from] -> to, or null = illegal. */
const EXPECTED: Record<TransitionCommand, Record<ReviewState, ReviewState | null>> = {
  submit: { draft: "in_review", in_review: null, changes_requested: "in_review", approved: null },
  withdraw: { draft: null, in_review: "draft", changes_requested: null, approved: null },
  requestChanges: { draft: null, in_review: "changes_requested", changes_requested: null, approved: null },
  // a sign-off stamps a version; the state does not move
  seoSignoff: { draft: null, in_review: "in_review", changes_requested: null, approved: null },
  approve: { draft: null, in_review: "approved", changes_requested: null, approved: null },
};

describe("review state machine: every (command, state) pair", () => {
  it("covers every command and every state (a new one cannot slip in untested)", () => {
    expect([...TRANSITION_COMMANDS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...TRANSITION_COMMANDS].sort());
    for (const cmd of TRANSITION_COMMANDS) expect(Object.keys(EXPECTED[cmd]).sort()).toEqual([...REVIEW_STATES].sort());
  });

  for (const cmd of TRANSITION_COMMANDS) {
    for (const from of REVIEW_STATES) {
      const to = EXPECTED[cmd][from];
      if (to !== null) {
        it(`LEGAL   ${cmd} from ${from} -> ${to}`, () => {
          const r = evaluateTransition(cmd, from);
          expect(r).toEqual({ ok: true, to, event: TRANSITIONS[cmd].event });
        });
      } else {
        it(`ILLEGAL ${cmd} from ${from} -> 409 review-state-conflict {currentState: ${from}}`, () => {
          const r = evaluateTransition(cmd, from);
          expect(r).toEqual({ ok: false, slug: "review-state-conflict", currentState: from });
          const problem = editorialProblems.stateConflict(from, `editorial.${cmd}`);
          expect(problem.getStatus()).toBe(409);
          expect(problem.slug).toBe("review-state-conflict");
          expect(problem.getResponse()).toMatchObject({
            type: "https://webdesk.gaiada.online/errors/review-state-conflict",
            status: 409,
            currentState: from,
          });
        });
      }
    }
  }

  it("the other 409 / 403 slugs of the flow are exactly the documented ones", () => {
    const cases: Array<[ReturnType<(typeof editorialProblems)[keyof typeof editorialProblems]>, number, string]> = [
      [editorialProblems.notEnabled("post"), 409, "review-not-enabled"],
      [editorialProblems.versionMismatch(3, 2, "the version in review"), 409, "review-version-mismatch"],
      [editorialProblems.seoSignoffRequired(3), 409, "seo-signoff-required"],
      [editorialProblems.principalNotAllowed("editorial.approve"), 403, "review-principal-not-allowed"],
      [editorialProblems.selfApproval(3), 403, "review-self-approval"],
      [editorialProblems.commentNotFound(), 404, "comment-not-found"],
    ];
    for (const [p, status, slug] of cases) {
      expect(p.getStatus()).toBe(status);
      expect(p.slug).toBe(slug);
    }
  });

  it("only a submit ever starts a review, and only an approve ever lands on approved", () => {
    const into = (to: ReviewState) => TRANSITION_COMMANDS.filter((c) => TRANSITIONS[c].to === to);
    expect(into("in_review")).toEqual(["submit"]);
    expect(into("approved")).toEqual(["approve"]);
  });
});

describe("what a new version does to the review state (an edit in review / after approval)", () => {
  it("in_review stays in_review and the submitted version follows the new head", () => {
    expect(stateAfterNewVersion("in_review")).toEqual({ state: "in_review", followHead: true, event: "review.edited" });
  });
  it("approved goes back to draft (approved_version is left alone by the caller)", () => {
    expect(stateAfterNewVersion("approved")).toEqual({ state: "draft", followHead: false, event: "review.reopened" });
  });
  it("draft and changes_requested are unchanged and write no event", () => {
    expect(stateAfterNewVersion("draft")).toEqual({ state: "draft", followHead: false, event: null });
    expect(stateAfterNewVersion("changes_requested")).toEqual({ state: "changes_requested", followHead: false, event: null });
  });
});

describe("the event vocabulary", () => {
  it("every kind satisfies the 0016 format check, and is unique", () => {
    for (const k of EDITORIAL_EVENT_KINDS) expect(EVENT_KIND_FORMAT.test(k), k).toBe(true);
    expect(new Set(EDITORIAL_EVENT_KINDS).size).toBe(EDITORIAL_EVENT_KINDS.length);
  });
  it("every transition's event is in the vocabulary", () => {
    for (const c of TRANSITION_COMMANDS) expect(EDITORIAL_EVENT_KINDS).toContain(TRANSITIONS[c].event);
  });
});
