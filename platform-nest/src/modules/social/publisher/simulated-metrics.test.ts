// SCP-Sd — the simulated numbers, proved WITHOUT a database, Cerbos or a network (runs anywhere). Two halves:
//   1. the pure generator (simulated-metrics.ts): determinism (with golden values, so a changed constant fails on purpose),
//      cumulative and non-decreasing across days 1 -> 3 -> 7, the format ordering (reels above, stories below), the
//      engagement-rate spread (some posts clear the 1.25x boost bar, most do not), and the daily account series;
//   2. the simulator driver's two metrics methods (simulated-driver.ts) against a STUB facts reader: the refusal order (switch,
//      then handle, then our rows), the due-day arithmetic and the catch-up, the honest absence of what a format cannot have.
// The DB half (the job writing source = 'simulated', idempotent, flag off, a real account untouched, and SCP-3c's read) is
// simulated-metrics.db.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../../../config";
import { OrgHandle, SocialPublisherError } from "./types";
import { SimulatedOrgHandle, SOCIAL_SIMULATION_REFUSAL } from "./simulation";
import { createSimulatedPublisher, type SimulatedMetricsFacts, type SimulatedPostFact } from "./simulated-driver";
import {
  MAX_DAILY_RANGE_DAYS, SIMULATED_FORMATS, SNAPSHOT_DAYS, dueSnapshotDays, normalizeFormat, parseIsoDay, simulatedDailyMetrics,
  simulatedDailySeries, simulatedEngagementRate, simulatedPostMetrics, snapshotCapturedAt, unit,
  type SimulatedFormat, type SimulatedPostSnapshot,
} from "./simulated-metrics";

const NETWORKS = ["instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "threads", "pinterest", "bluesky", "mastodon"];
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const COUNTERS = ["reach", "impressions", "likes", "comments", "shares", "saves", "clicks"] as const;
const engaged = (s: SimulatedPostSnapshot): number => s.likes + s.comments + s.saves + s.shares;

describe("SCP-Sd · the generator is deterministic", () => {
  it("unit() is a uniform in [0, 1), the same for the same seed and label, and independent per label", () => {
    const a = unit("seed", "a");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(unit("seed", "a")).toBe(a);
    expect(unit("seed", "b")).not.toBe(a);
    expect(unit("other", "a")).not.toBe(a);
    for (let i = 0; i < 500; i++) {
      const u = unit(id(i), "x");
      expect(u >= 0 && u < 1).toBe(true);
    }
  });

  it("the same (variant, network, format, day) gives the same numbers on every call", () => {
    for (const fmt of SIMULATED_FORMATS) {
      for (const day of SNAPSHOT_DAYS) {
        expect(simulatedPostMetrics(id(7), "instagram", fmt, day)).toEqual(simulatedPostMetrics(id(7), "instagram", fmt, day));
      }
    }
  });

  it("GOLDEN VALUES: the numbers of one variant, pinned so a changed constant fails on purpose (every number already seen would move)", () => {
    const v = id(1);
    expect(simulatedPostMetrics(v, "instagram", "feed", 1)).toEqual({ day: 1, reach: 864, impressions: 1350, likes: 35, comments: 3, shares: 5, saves: 5, clicks: 21 });
    expect(simulatedPostMetrics(v, "instagram", "feed", 7)).toEqual({ day: 7, reach: 1688, impressions: 2638, likes: 69, comments: 6, shares: 9, saves: 9, clicks: 41 });
    expect(simulatedPostMetrics(v, "instagram", "reel", 3)).toEqual({ day: 3, reach: 2973, impressions: 4647, likes: 183, comments: 15, shares: 23, saves: 24, clicks: 72, videoViews: 3159 });
    expect(simulatedPostMetrics(v, "instagram", "story", 7)).toEqual({ day: 7, reach: 759, impressions: 1186, likes: 16, comments: 1, shares: 2, saves: 0, clicks: 18 });
    expect(simulatedDailyMetrics(id(0xb2), "instagram", "2026-10-27")).toEqual({
      date: "2026-10-27", followers: 4487, reach: 509, impressions: 805, engagements: 37, linkClicks: 6, videoViews: 280,
    });
  });

  it("different variants and different networks give different numbers (the seed is the VARIANT, so two networks of one post differ)", () => {
    const a = simulatedPostMetrics(id(1), "instagram", "feed", 7);
    expect(simulatedPostMetrics(id(2), "instagram", "feed", 7)).not.toEqual(a);
    expect(simulatedPostMetrics(id(1), "tiktok", "feed", 7)).not.toEqual(a);
  });

  it("a format that is NULL or unknown reads as feed", () => {
    expect(normalizeFormat(null)).toBe("feed");
    expect(normalizeFormat(undefined)).toBe("feed");
    expect(normalizeFormat("podcast")).toBe("feed");
    expect(normalizeFormat("reel")).toBe("reel");
    expect(simulatedPostMetrics(id(3), "facebook", null, 3)).toEqual(simulatedPostMetrics(id(3), "facebook", "feed", 3));
  });
});

describe("SCP-Sd · a post's numbers are cumulative: never lower on day 3 than day 1, nor on day 7 than day 3", () => {
  it("holds for every counter, for 300 variants x 4 formats x 10 networks", () => {
    for (let i = 0; i < 300; i++) {
      for (const fmt of SIMULATED_FORMATS) {
        const network = NETWORKS[i % NETWORKS.length];
        const [d1, d3, d7] = SNAPSHOT_DAYS.map((d) => simulatedPostMetrics(id(i), network, fmt, d));
        for (const c of COUNTERS) {
          expect(d3[c], `${fmt} ${c} #${i}`).toBeGreaterThanOrEqual(d1[c]);
          expect(d7[c], `${fmt} ${c} #${i}`).toBeGreaterThanOrEqual(d3[c]);
        }
        if (fmt === "reel") {
          expect(d3.videoViews as number).toBeGreaterThanOrEqual(d1.videoViews as number);
          expect(d7.videoViews as number).toBeGreaterThanOrEqual(d3.videoViews as number);
        }
        // And it really grows: day 7 holds more reach than day 1 for a feed/carousel/reel (a story is nearly complete on day 1).
        if (fmt !== "story") expect(d7.reach).toBeGreaterThan(d1.reach);
      }
    }
  });

  it("every counter is a whole number from 0, impressions are at least reach, engagements never exceed reach", () => {
    for (let i = 0; i < 300; i++) {
      for (const fmt of SIMULATED_FORMATS) {
        for (const day of SNAPSHOT_DAYS) {
          const s = simulatedPostMetrics(id(i), NETWORKS[i % NETWORKS.length], fmt, day);
          for (const c of [...COUNTERS, "videoViews"] as const) {
            const v = (s as unknown as Record<string, number | undefined>)[c];
            if (v === undefined) continue;
            expect(Number.isInteger(v) && v >= 0, `${fmt} ${c}`).toBe(true);
          }
          expect(s.impressions).toBeGreaterThanOrEqual(s.reach);
          expect(engaged(s)).toBeLessThanOrEqual(s.reach);
        }
      }
    }
  });

  it("video views exist for reels only: any other format reports NONE (absent, never 0)", () => {
    for (let i = 0; i < 50; i++) {
      for (const fmt of SIMULATED_FORMATS) {
        const s = simulatedPostMetrics(id(i), "instagram", fmt, 7);
        if (fmt === "reel") expect(s.videoViews).toBeGreaterThan(0);
        else expect("videoViews" in s).toBe(false);
      }
    }
  });
});

describe("SCP-Sd · reels higher, stories lower (plan §5)", () => {
  const ids = Array.from({ length: 300 }, (_, i) => id(i));
  const avg = (fmt: SimulatedFormat, pick: (s: SimulatedPostSnapshot) => number) =>
    mean(ids.map((v) => pick(simulatedPostMetrics(v, "instagram", fmt, 7))));

  it("day-7 reach: reel > carousel > feed > story, on the same network", () => {
    const r = Object.fromEntries(SIMULATED_FORMATS.map((f) => [f, avg(f, (s) => s.reach)])) as Record<SimulatedFormat, number>;
    expect(r.reel).toBeGreaterThan(r.carousel);
    expect(r.carousel).toBeGreaterThan(r.feed);
    expect(r.feed).toBeGreaterThan(r.story);
  });

  it("day-7 engagements follow the same order, and so does the average engagement rate: reel above feed above story", () => {
    const e = Object.fromEntries(SIMULATED_FORMATS.map((f) => [f, avg(f, engaged)])) as Record<SimulatedFormat, number>;
    expect(e.reel).toBeGreaterThan(e.feed);
    expect(e.feed).toBeGreaterThan(e.story);
    const rate = (f: SimulatedFormat) => mean(ids.map((v) => simulatedEngagementRate(v, f)));
    expect(rate("reel")).toBeGreaterThan(rate("feed"));
    expect(rate("feed")).toBeGreaterThan(rate("story"));
  });

  it("the curve is format-shaped: a story is nearly all there on day 1, a reel keeps climbing", () => {
    const share1 = (fmt: SimulatedFormat) => mean(ids.map((v) => {
      const d1 = simulatedPostMetrics(v, "instagram", fmt, 1).reach;
      const d7 = simulatedPostMetrics(v, "instagram", fmt, 7).reach;
      return d1 / d7;
    }));
    expect(share1("story")).toBeGreaterThan(0.8);
    expect(share1("reel")).toBeLessThan(0.45);
    expect(share1("story")).toBeGreaterThan(share1("feed"));
    expect(share1("feed")).toBeGreaterThan(share1("reel"));
  });

  it("a bigger network reaches further (tiktok above mastodon) for the same variants", () => {
    const reach = (n: string) => mean(ids.map((v) => simulatedPostMetrics(v, n, "feed", 7).reach));
    expect(reach("tiktok")).toBeGreaterThan(reach("mastodon") * 5);
  });
});

describe("SCP-Sd · the engagement-rate spread: some posts clear the 1.25x boost bar, most do not", () => {
  it("within one format, between 8% and 35% of posts are at least 1.25x the mean rate", () => {
    for (const fmt of SIMULATED_FORMATS) {
      const rates = Array.from({ length: 800 }, (_, i) => simulatedEngagementRate(id(i), fmt));
      const m = mean(rates);
      const share = rates.filter((r) => r >= 1.25 * m).length / rates.length;
      expect(share, fmt).toBeGreaterThan(0.08);
      expect(share, fmt).toBeLessThan(0.35);
    }
  });

  it("across a mixed month (the four formats together) the same holds, and no rate is implausible", () => {
    const rates = Array.from({ length: 1200 }, (_, i) => simulatedEngagementRate(id(i), SIMULATED_FORMATS[i % 4]));
    const m = mean(rates);
    const share = rates.filter((r) => r >= 1.25 * m).length / rates.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.4);
    expect(Math.max(...rates)).toBeLessThanOrEqual(0.3);
    expect(Math.min(...rates)).toBeGreaterThan(0.002);
  });

  it("the rate a post's day-7 snapshot shows is the drawn one (the SCP-3c read computes (likes+comments+saves+shares)/reach)", () => {
    for (let i = 0; i < 100; i++) {
      const s = simulatedPostMetrics(id(i), "instagram", "feed", 7);
      expect(engaged(s) / s.reach).toBeCloseTo(simulatedEngagementRate(id(i), "feed"), 1);
    }
  });
});

describe("SCP-Sd · due days", () => {
  const wentLive = new Date("2026-10-20T10:00:00.000Z");
  const at = (h: number) => new Date(wentLive.getTime() + h * 3_600_000);

  it("day d is due exactly when go-live + d days has passed (inclusive)", () => {
    expect(dueSnapshotDays(wentLive, at(0))).toEqual([]);
    expect(dueSnapshotDays(wentLive, at(23.99))).toEqual([]);
    expect(dueSnapshotDays(wentLive, at(24))).toEqual([1]);
    expect(dueSnapshotDays(wentLive, at(71))).toEqual([1]);
    expect(dueSnapshotDays(wentLive, at(72))).toEqual([1, 3]);
    expect(dueSnapshotDays(wentLive, at(24 * 7 - 1))).toEqual([1, 3]);
    expect(dueSnapshotDays(wentLive, at(24 * 7))).toEqual([1, 3, 7]);
    expect(dueSnapshotDays(wentLive, at(24 * 400))).toEqual([1, 3, 7]);
  });

  it("a post that is not live yet, or has no valid go-live, has none", () => {
    expect(dueSnapshotDays(at(48), wentLive)).toEqual([]);
    expect(dueSnapshotDays(new Date(NaN), at(24 * 9))).toEqual([]);
  });

  it("the stamp is go-live + d days, a pure function of the post (so a rerun finds its own row)", () => {
    expect(snapshotCapturedAt(wentLive, 1).toISOString()).toBe("2026-10-21T10:00:00.000Z");
    expect(snapshotCapturedAt(wentLive, 3).toISOString()).toBe("2026-10-23T10:00:00.000Z");
    expect(snapshotCapturedAt(wentLive, 7).toISOString()).toBe("2026-10-27T10:00:00.000Z");
  });
});

describe("SCP-Sd · daily account numbers", () => {
  const acct = id(0xb2);

  it("deterministic by (account id, network, date); different accounts differ", () => {
    expect(simulatedDailyMetrics(acct, "instagram", "2026-11-03")).toEqual(simulatedDailyMetrics(acct, "instagram", "2026-11-03"));
    expect(simulatedDailyMetrics(id(0xc3), "instagram", "2026-11-03")).not.toEqual(simulatedDailyMetrics(acct, "instagram", "2026-11-03"));
    expect(simulatedDailyMetrics(acct, "instagram", "2026-11-04")).not.toEqual(simulatedDailyMetrics(acct, "instagram", "2026-11-03"));
  });

  it("followers grow slowly and NEVER fall, across 200 consecutive days, for every network and 20 accounts", () => {
    for (const network of NETWORKS) {
      for (let a = 0; a < 20; a++) {
        let prev = -1;
        let first = 0;
        for (let d = 0; d < 200; d++) {
          const date = new Date(Date.UTC(2026, 5, 1) + d * 86_400_000).toISOString().slice(0, 10);
          const row = simulatedDailyMetrics(id(a), network, date) as NonNullable<ReturnType<typeof simulatedDailyMetrics>>;
          if (d === 0) first = row.followers;
          expect(row.followers, `${network} ${date}`).toBeGreaterThanOrEqual(prev);
          // Slow: at most 5 followers a day (the per-account gain is 0.8 to 4.5).
          if (prev >= 0) expect(row.followers - prev).toBeLessThanOrEqual(5);
          prev = row.followers;
        }
        expect(prev).toBeGreaterThan(first); // and it does grow over 200 days
      }
    }
  });

  it("every other number is a whole number from 0; impressions are at least reach; engagements stay under reach", () => {
    for (let a = 0; a < 40; a++) {
      const row = simulatedDailyMetrics(id(a), NETWORKS[a % NETWORKS.length], "2026-11-09") as NonNullable<ReturnType<typeof simulatedDailyMetrics>>;
      for (const k of ["followers", "reach", "impressions", "engagements", "linkClicks", "videoViews"] as const) {
        expect(Number.isInteger(row[k]) && row[k] >= 0, k).toBe(true);
      }
      expect(row.impressions).toBeGreaterThanOrEqual(row.reach);
      expect(row.engagements).toBeLessThan(row.reach);
    }
  });

  it("a date before the growth epoch reads as day 0, never a negative count", () => {
    const row = simulatedDailyMetrics(acct, "instagram", "2025-06-01") as NonNullable<ReturnType<typeof simulatedDailyMetrics>>;
    expect(row.followers).toBeGreaterThan(0);
  });

  it("a date that is not a real day gives null; parseIsoDay refuses 30 February and other shapes", () => {
    expect(simulatedDailyMetrics(acct, "instagram", "2026-02-30")).toBeNull();
    expect(simulatedDailyMetrics(acct, "instagram", "2026-2-3")).toBeNull();
    expect(parseIsoDay("2026-10-27")).toBe(Date.UTC(2026, 9, 27));
    expect(parseIsoDay("2026-13-01")).toBeNull();
    expect(parseIsoDay("tomorrow")).toBeNull();
  });

  it("a series is oldest-first and inclusive, matches the single-day function, and an invalid or reversed range gives []", () => {
    const s = simulatedDailySeries(acct, "facebook", { from: "2026-10-25", to: "2026-10-27" });
    expect(s.map((r) => r.date)).toEqual(["2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(s[1]).toEqual(simulatedDailyMetrics(acct, "facebook", "2026-10-26"));
    expect(simulatedDailySeries(acct, "facebook", { from: "2026-10-27", to: "2026-10-25" })).toEqual([]);
    expect(simulatedDailySeries(acct, "facebook", { from: "nope", to: "2026-10-25" })).toEqual([]);
    expect(simulatedDailySeries(acct, "facebook", { from: "2026-10-27", to: "2026-10-27" })).toHaveLength(1);
  });

  it("a range is capped at MAX_DAILY_RANGE_DAYS, keeping the NEWEST days", () => {
    const s = simulatedDailySeries(acct, "facebook", { from: "2020-01-01", to: "2026-10-27" });
    expect(s).toHaveLength(MAX_DAILY_RANGE_DAYS);
    expect(s[s.length - 1].date).toBe("2026-10-27");
  });
});

// ── the driver's two methods ──────────────────────────────────────────────────────────────────────────────────────────

const T = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000b2";
const ORG = "00000000-0000-4000-8000-0000000000c3";
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const before = config.socialSimulationEnabled;
afterEach(() => { config.socialSimulationEnabled = before; });

const POST_ID = (n: number) => `simulated:instagram:${NOW}:${id(0x1000 + n)}`;

function stubFacts(posts: SimulatedPostFact[], account: { network: string } | null = { network: "instagram" }) {
  const calls = { posts: [] as Array<[string, string[]]>, account: [] as Array<[string, string]> };
  const facts: SimulatedMetricsFacts = {
    async posts(tenantId, ids) { calls.posts.push([tenantId, ids]); return posts.filter((p) => ids.includes(p.providerPostId)); },
    async account(tenantId, accountId) { calls.account.push([tenantId, accountId]); return account; },
  };
  return { facts, calls };
}
const fact = (n: number, wentLiveAt: string, over: Partial<SimulatedPostFact> = {}): SimulatedPostFact => ({
  providerPostId: POST_ID(n), variantId: id(n), network: "instagram", format: "reel", wentLiveAt: new Date(wentLiveAt), ...over,
});
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(SocialPublisherError);
    return (e as SocialPublisherError).code;
  }
  throw new Error("expected a typed refusal");
}

describe("SCP-Sd · the simulator's getPostMetrics", () => {
  const build = (facts: SimulatedMetricsFacts) => createSimulatedPublisher({ metricsFacts: facts, now: () => NOW });
  const handle = () => new SimulatedOrgHandle(T, null, ORG);

  it("advertises the two metrics capabilities now", () => {
    const d = build(stubFacts([]).facts);
    expect(d.capabilities.has("account_metrics")).toBe(true);
    expect(d.capabilities.has("post_metrics")).toBe(true);
  });

  it("refuses with the switch off (before reading any row), then a real org handle (before reading any row)", async () => {
    const { facts, calls } = stubFacts([fact(1, "2026-11-01T00:00:00Z")]);
    const d = build(facts);
    config.socialSimulationEnabled = false;
    expect(await codeOf(d.getPostMetrics(handle(), [POST_ID(1)]))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    config.socialSimulationEnabled = true;
    expect(await codeOf(d.getPostMetrics(new OrgHandle("row", "org", "key"), [POST_ID(1)]))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(calls.posts).toEqual([]);
  });

  it("answers only for ids it minted: a real engine's id is silently absent, and with none of its own it reads no row at all", async () => {
    config.socialSimulationEnabled = true;
    const { facts, calls } = stubFacts([fact(1, "2026-11-01T00:00:00Z")]);
    const d = build(facts);
    expect(await d.getPostMetrics(handle(), ["postiz-123", "simulated:bogus"])).toEqual([]);
    expect(calls.posts).toEqual([]);
    const out = await d.getPostMetrics(handle(), ["postiz-123", POST_ID(1)]);
    expect(calls.posts).toEqual([[T, [POST_ID(1)]]]); // the tenant is the handle's, the ids are the minted ones only
    expect(out.every((m) => m.providerPostId === POST_ID(1))).toBe(true);
  });

  it("one entry per DUE day, each stamped go-live + day and carrying reach; numbers are the generator's", async () => {
    config.socialSimulationEnabled = true;
    // Went live 9.5 days before NOW: days 1, 3 and 7 are all due.
    const live = new Date(NOW - 9.5 * 86_400_000).toISOString();
    const d = build(stubFacts([fact(1, live)]).facts);
    const out = await d.getPostMetrics(handle(), [POST_ID(1)]);
    expect(out.map((m) => m.capturedAt)).toEqual(SNAPSHOT_DAYS.map((day) => snapshotCapturedAt(new Date(live), day).toISOString()));
    const s7 = simulatedPostMetrics(id(1), "instagram", "reel", 7);
    expect(out[2]).toEqual({
      providerPostId: POST_ID(1), reach: s7.reach, impressions: s7.impressions, likes: s7.likes, comments: s7.comments, shares: s7.shares,
      saves: s7.saves, clicks: s7.clicks, videoViews: s7.videoViews, capturedAt: snapshotCapturedAt(new Date(live), 7).toISOString(),
    });
  });

  it("THE CATCH-UP: a post live 3.5 days gets days 1 and 3 in one answer; live 12 hours gets nothing yet", async () => {
    config.socialSimulationEnabled = true;
    const d = build(stubFacts([
      fact(1, new Date(NOW - 3.5 * 86_400_000).toISOString()),
      fact(2, new Date(NOW - 12 * 3_600_000).toISOString()),
    ]).facts);
    const out = await d.getPostMetrics(handle(), [POST_ID(1), POST_ID(2)]);
    expect(out.filter((m) => m.providerPostId === POST_ID(1))).toHaveLength(2);
    expect(out.filter((m) => m.providerPostId === POST_ID(2))).toHaveLength(0);
  });

  it("a non-reel carries no video views (absent, never 0); the same call twice is the same answer", async () => {
    config.socialSimulationEnabled = true;
    const d = build(stubFacts([fact(1, new Date(NOW - 8 * 86_400_000).toISOString(), { format: "carousel" })]).facts);
    const a = await d.getPostMetrics(handle(), [POST_ID(1)]);
    expect(a.every((m) => !("videoViews" in m))).toBe(true);
    expect(await d.getPostMetrics(handle(), [POST_ID(1)])).toEqual(a);
  });
});

describe("SCP-Sd · the simulator's getAccountMetrics", () => {
  const build = (facts: SimulatedMetricsFacts) => createSimulatedPublisher({ metricsFacts: facts, now: () => NOW });
  const range = { from: "2026-11-08", to: "2026-11-10" };

  it("refuses: switch off, a real handle, a handle with no account, an account that is not simulated", async () => {
    const { facts, calls } = stubFacts([], null);
    const d = build(facts);
    config.socialSimulationEnabled = false;
    expect(await codeOf(d.getAccountMetrics(new SimulatedOrgHandle(T, ACCOUNT, ORG), "i", range))).toBe(SOCIAL_SIMULATION_REFUSAL.disabled);
    config.socialSimulationEnabled = true;
    expect(await codeOf(d.getAccountMetrics(new OrgHandle("row", "org", "key"), "i", range))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(await codeOf(d.getAccountMetrics(new SimulatedOrgHandle(T, null, ORG), "i", range))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(calls.account).toEqual([]);
    expect(await codeOf(d.getAccountMetrics(new SimulatedOrgHandle(T, ACCOUNT, ORG), "i", range))).toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);
    expect(calls.account).toEqual([[T, ACCOUNT]]);
  });

  it("returns one row per date, the generator's numbers, marked raw.simulated, for the account's own network", async () => {
    config.socialSimulationEnabled = true;
    const d = build(stubFacts([], { network: "tiktok" }).facts);
    const out = await d.getAccountMetrics(new SimulatedOrgHandle(T, ACCOUNT, ORG), "ignored", range);
    expect(out.map((r) => r.date)).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
    const g = simulatedDailyMetrics(ACCOUNT, "tiktok", "2026-11-09") as NonNullable<ReturnType<typeof simulatedDailyMetrics>>;
    expect(out[1]).toEqual({
      date: g.date, followers: g.followers, impressions: g.impressions, reach: g.reach, engagements: g.engagements,
      linkClicks: g.linkClicks, videoViews: g.videoViews, raw: { simulated: true },
    });
  });
});
