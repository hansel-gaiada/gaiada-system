// SCP-1n — the pure parts of the content-month task (BFF §63.13): its title, and the progress and done the pipeline writes from the cycle's counts.
// No database: the real-Postgres behaviour (the task made once, the progress following the stage actions, reopen, no task per post, the links) is in
// content-month.http.test.ts.
import { describe, it, expect } from "vitest";
import { contentMonthTitle } from "./content-month";
import { contentMonthFigures } from "./content-month-progress";
import { tallyCounts, type CountedPost } from "./schedule-health";

const post = (status: string, o: Partial<CountedPost> = {}): CountedPost => ({
  status, changeBy: null, changeKind: null, returnTo: null, changedOnly: false, blockedFrom: null, blockWaitingOn: null, isExtra: false, format: "feed", ...o,
});
const figures = (posts: CountedPost[], target: number | null) => contentMonthFigures(tallyCounts(posts), target);

describe("contentMonthTitle", () => {
  it("is '<Month YYYY> content'", () => {
    expect(contentMonthTitle("2027-03")).toBe("March 2027 content");
    expect(contentMonthTitle("2026-12")).toBe("December 2026 content");
    expect(contentMonthTitle("2028-01")).toBe("January 2028 content");
  });
});

describe("contentMonthFigures -- progress and done from the counts", () => {
  it("nothing counted: 0, not done (an empty month is not a finished one)", () => {
    expect(figures([], 12)).toMatchObject({ progress: 0, done: false, counted: 0, past: 0 });
    expect(figures([], null)).toMatchObject({ progress: 0, done: false });
  });

  it("past client approval ÷ the target: approved, scheduled and live count, the steps before the client do not", () => {
    const posts = [post("approved"), post("scheduled"), post("live"), post("drafting"), post("client"), post("planned")];
    expect(figures(posts, 12)).toMatchObject({ progress: 25, done: false, counted: 6, past: 3 });
  });

  it("with no target (null, or 0), the denominator is the counted posts", () => {
    const posts = [post("approved"), post("drafting"), post("client"), post("planned")];
    expect(figures(posts, null)).toMatchObject({ progress: 25, past: 1, counted: 4, target: null });
    expect(figures(posts, 0)).toMatchObject({ progress: 25, target: null });
  });

  it("done when every counted post is approved and the target is met: 100", () => {
    expect(figures([post("approved"), post("scheduled")], 2)).toMatchObject({ progress: 100, done: true });
    expect(figures([post("live")], null)).toMatchObject({ progress: 100, done: true });
    expect(figures([post("approved"), post("approved"), post("approved")], 2)).toMatchObject({ progress: 100, done: true });
  });

  it("every counted post approved but fewer than the target is NOT done (the month is unfinished), and shows its share", () => {
    expect(figures([post("approved"), post("approved")], 12)).toMatchObject({ progress: 17, done: false });
  });

  it("a counted post that is not approved keeps the month open, and progress is held at 99 (100 is what done means)", () => {
    // 2 of a target of 2 are approved, a third post is still with the client.
    expect(figures([post("approved"), post("approved"), post("client")], 2)).toMatchObject({ progress: 99, done: false });
    expect(figures([post("approved"), post("approved"), post("client")], null)).toMatchObject({ progress: 67, done: false });
  });

  it("a post back with the client after the client's approval is not past approval: the month reopens", () => {
    // reschedule / a Composer edit leave an approved post at `client`.
    expect(figures([post("approved"), post("client")], 2)).toMatchObject({ progress: 50, done: false, past: 1 });
  });

  it("a story and an extra post are not counted, however far they got", () => {
    const posts = [post("approved"), post("approved", { isExtra: true }), post("approved", { format: "story" }), post("drafting", { isExtra: true })];
    expect(figures(posts, 2)).toMatchObject({ counted: 1, past: 1, progress: 50, done: false });
    expect(figures(posts, null)).toMatchObject({ counted: 1, past: 1, progress: 100, done: true });
  });
});
