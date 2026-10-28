// SCP-3f — `GET overview`'s pure side (BFF §63.7), no database and no Cerbos: the week, and the tiles composed from candidates. The database
// proof (the counts on real rows, the switch, the 403) is `overview.http.test.ts`.
import { describe, it, expect } from "vitest";
import type { FeedCandidate } from "./feed-data";
import { healthOfCandidate, phaseOfCandidate } from "./feed";
import { composeOverview, weekOf } from "./overview";
import type { OverviewFacts } from "./overview-data";

const TODAY = "2026-10-28"; // a Wednesday

function cand(id: string, status: string, o: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    id, engagementId: "e1", clientId: "c1", clientName: "Mock Client", title: id, format: null, isExtra: false, pipelineStatus: status,
    statusSince: "2026-10-01T00:00:00.000Z", scheduledAt: null, authorId: null, ownerId: null, simulated: false, creativeSource: null,
    creativeState: null, creativeRequestId: null, scheduleVia: null, changeBy: null, changeKind: null, returnTo: null, changedOnly: false,
    blockedFrom: null, blockWaitingOn: null, cycleId: "cy1", readyBy: "2026-10-10", stepEstimates: {}, iAmAssignee: false, ...o,
  };
}
const facts = (o: Partial<OverviewFacts> = {}): OverviewFacts => ({ failedPosts: 0, scheduledThisWeek: 0, simulatedIds: new Set(), ...o });
const ctx = (includeSimulated: boolean) => ({ today: TODAY, calendar: {}, samples: new Map(), includeSimulated });

describe("weekOf: Monday to Sunday of the day's week", () => {
  it.each([
    ["2026-10-26", "2026-10-26", "2026-11-02"], // a Monday is the first day
    ["2026-10-28", "2026-10-26", "2026-11-02"],
    ["2026-11-01", "2026-10-26", "2026-11-02"], // a Sunday is the last day
    ["2026-11-02", "2026-11-02", "2026-11-09"],
    ["2027-01-01", "2026-12-28", "2027-01-04"], // across the year
  ])("%s -> %s .. %s (exclusive)", (day, from, to) => {
    expect(weekOf(day)).toEqual({ from, to });
  });
});

describe("composeOverview", () => {
  const posts = [
    cand("a", "drafting"), cand("b", "proofread"), cand("c", "hod"), cand("d", "design"), cand("e", "final"),
    cand("f", "client"), cand("g", "approved"), cand("h", "live"),
  ];

  it("counts the phase of each post, the same phase the feed shows", () => {
    const r = composeOverview(posts, facts(), ctx(false));
    expect(r.tiles.inProduction).toBe(4);
    expect(r.tiles.withClient).toBe(1);
    expect(r.tiles.inProduction).toBe(posts.filter((p) => phaseOfCandidate(p) === "in_production").length);
  });

  it("counts late by the feed's own health rule: the open steps of an overdue cycle, never an approved or live post", () => {
    const r = composeOverview(posts, facts(), ctx(false));
    const feedLate = posts.filter((p) => healthOfCandidate(p, TODAY, {}, new Map(), new Map())?.state === "late").length;
    expect(r.tiles.late).toBe(feedLate);
    expect(r.tiles.late).toBe(6);
    // a cycle with no ready-by has no health at all
    expect(composeOverview([cand("x", "proofread", { readyBy: null })], facts(), ctx(false)).tiles.late).toBe(0);
    // a cycle with time to spare is not late
    expect(composeOverview([cand("y", "proofread", { readyBy: "2026-12-20" })], facts(), ctx(false)).tiles.late).toBe(0);
  });

  it("takes the SQL counts as they come and answers boostsWaiting null, never 0", () => {
    const r = composeOverview([], facts({ failedPosts: 3, scheduledThisWeek: 2 }), ctx(false));
    expect(r.tiles).toEqual({ inProduction: 0, withClient: 0, late: 0, scheduledThisWeek: 2, failedPosts: 3, boostsWaiting: null });
  });

  it("leaves simulated posts out while the switch is off (own mark or a variant's), counts them while it is on, and says which", () => {
    const sim = [cand("s1", "proofread", { simulated: true }), cand("s2", "client"), cand("s3", "client")];
    const f = facts({ simulatedIds: new Set(["s2"]) });
    const off = composeOverview([...posts, ...sim], f, ctx(false));
    expect(off.simulatedIncluded).toBe(false);
    expect(off.tiles.inProduction).toBe(4);
    expect(off.tiles.withClient).toBe(2); // f and s3
    const on = composeOverview([...posts, ...sim], facts(), ctx(true));
    expect(on.simulatedIncluded).toBe(true);
    expect(on.tiles.inProduction).toBe(5);
    expect(on.tiles.withClient).toBe(3);
    expect(on.tiles.late).toBe(off.tiles.late + 2); // s1 and s2 come back; s3 was never left out
  });
});
