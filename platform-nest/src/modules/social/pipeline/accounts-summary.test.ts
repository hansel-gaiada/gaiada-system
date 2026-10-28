// SCP-Sg — the pure rules of the accounts read back (accounts-summary.ts, feed-preview.ts): no database, no clock. The routes' own tests are
// accounts-summary.http.test.ts and feed-preview.http.test.ts (real Postgres and Cerbos, run in CI).
import { describe, it, expect } from "vitest";
import { buildSummary, followersDelta, newestOf } from "./accounts-summary";
import { liveReachOf } from "./feed-preview";

type Row = Parameters<typeof buildSummary>[0][number];
const row = (o: Partial<Row> = {}): Row => ({
  account_id: "acc-1", network: "instagram", handle: "@mock-a", simulated: false, followers: null, followers_date: null, base_followers: null, base_date: null,
  reach_30d: null, impressions_30d: null, last_synced_at: null, ...o,
});
const TODAY = "2027-04-30"; // the window is 2027-04-01 .. 2027-04-30

describe("followersDelta", () => {
  it("is the newest followers minus the oldest in the window", () => {
    expect(followersDelta({ followers: 1250, day: "2027-04-30" }, { followers: 1000, day: "2027-04-01" }, "2027-04-01")).toBe(250);
    expect(followersDelta({ followers: 900, day: "2027-04-30" }, { followers: 1000, day: "2027-04-01" }, "2027-04-01")).toBe(-100); // a loss is a real answer
    expect(followersDelta({ followers: 1000, day: "2027-04-30" }, { followers: 1000, day: "2027-04-01" }, "2027-04-01")).toBe(0); // 0 is measured here
  });
  it("is null with no newest row, no baseline, a stale newest row, or a single point", () => {
    expect(followersDelta(null, { followers: 1, day: "2027-04-02" }, "2027-04-01")).toBeNull();
    expect(followersDelta({ followers: 1, day: "2027-04-02" }, null, "2027-04-01")).toBeNull();
    expect(followersDelta({ followers: 5, day: "2027-03-31" }, { followers: 1, day: "2027-03-01" }, "2027-04-01")).toBeNull();
    expect(followersDelta({ followers: 5, day: "2027-04-02" }, { followers: 5, day: "2027-04-02" }, "2027-04-01")).toBeNull();
  });
});

describe("newestOf", () => {
  it("is the latest instant, or null", () => {
    expect(newestOf(["2027-04-01T10:00:00.000Z", null, "2027-04-02T09:00:00.000Z", "2027-04-01T23:00:00.000Z"])).toBe("2027-04-02T09:00:00.000Z");
    expect(newestOf([null, null])).toBeNull();
    expect(newestOf([])).toBeNull();
  });
});

describe("buildSummary", () => {
  it("answers nothing for a client with no account: null totals, not simulated", () => {
    expect(buildSummary([], TODAY)).toEqual({ accounts: [], totals: { followers: null, reach30d: null }, simulated: false, lastSyncedAt: null });
  });

  it("marks an account with no row `source: null` and never counts it as simulated", () => {
    const j = buildSummary([row({ simulated: true })], TODAY);
    expect(j.accounts[0]).toMatchObject({ simulated: true, source: null, followers: null, reach30d: null, lastSyncedAt: null });
    expect(j.simulated).toBe(false);
  });

  it("reads bigint sums as numbers, marks the source by the account, and totals what was reported (null counters stay null)", () => {
    const j = buildSummary([
      row({
        account_id: "a", simulated: true, followers: 3100, followers_date: "2027-04-30", base_followers: 3000, base_date: "2027-04-10", reach_30d: "250",
        impressions_30d: "900", last_synced_at: new Date("2027-04-30T11:00:00.000Z"),
      }),
      row({ account_id: "b", network: "facebook", followers: 700, followers_date: "2027-04-27", reach_30d: null, last_synced_at: "2027-04-27T08:00:00.000Z" }),
    ], TODAY);
    expect(j.accounts[0]).toMatchObject({ followers: 3100, followersDelta30d: 100, reach30d: 250, impressions30d: 900, source: "simulated", lastSyncedAt: "2027-04-30T11:00:00.000Z" });
    expect(j.accounts[1]).toMatchObject({ followers: 700, followersDelta30d: null, reach30d: null, source: "pull", lastSyncedAt: "2027-04-27T08:00:00.000Z" });
    expect(j.totals).toEqual({ followers: 3800, reach30d: 250 });
    expect(j.simulated).toBe(true);
    expect(j.lastSyncedAt).toBe("2027-04-30T11:00:00.000Z");
  });

  it("is not simulated when only real accounts reported", () => {
    const j = buildSummary([row({ followers: 10, followers_date: "2027-04-30", last_synced_at: "2027-04-30T01:00:00.000Z" })], TODAY);
    expect(j.simulated).toBe(false);
    expect(j.accounts[0].source).toBe("pull");
  });

  it("anchors the window on the answer's own today: a newest row 31 days old is outside it", () => {
    const j = buildSummary([row({ followers: 5, followers_date: "2027-03-31", base_followers: 1, base_date: "2027-03-02" })], TODAY);
    expect(j.accounts[0].followersDelta30d).toBeNull();
    const inside = buildSummary([row({ followers: 5, followers_date: "2027-04-02", base_followers: 1, base_date: "2027-04-01" })], TODAY);
    expect(inside.accounts[0].followersDelta30d).toBe(4);
  });
});

describe("liveReachOf (the feed preview's reach of a live post)", () => {
  const snap = (reach: number | null, source: "pull" | "manual" | "simulated", at = "2027-04-02T08:00:00Z") => ({ reach, source, fetched_at: at });
  it("adds the variants' newest snapshots, and is null when none reported a reach (never 0)", () => {
    expect(liveReachOf([snap(400, "pull"), snap(250, "pull")])).toEqual({ reach: 650, source: "pull" });
    expect(liveReachOf([snap(null, "pull"), snap(null, "pull")])).toEqual({ reach: null, source: "pull" });
    expect(liveReachOf([snap(null, "pull"), snap(30, "pull")])).toEqual({ reach: 30, source: "pull" });
    expect(liveReachOf([])).toEqual({ reach: null, source: null });
  });
  it("marks the post by the strongest source: simulated, then manual, then pulled", () => {
    expect(liveReachOf([snap(1, "pull"), snap(2, "simulated")]).source).toBe("simulated");
    expect(liveReachOf([snap(1, "pull"), snap(2, "manual")]).source).toBe("manual");
  });
});
