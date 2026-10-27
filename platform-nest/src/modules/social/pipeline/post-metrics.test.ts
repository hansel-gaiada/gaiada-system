// SCP-3c — the pure maths and body rules of a post's metrics (post-metrics.ts; BFF §63.10 "Metrics"). No database, no clock: `now` is an argument.
import { describe, it, expect } from "vitest";
import {
  CAPTURED_AT_SKEW_MS, DEFAULT_BOOST_FACTOR, MAX_COUNT, combineSnapshots, engagementRate, isBoostCandidate, meanRate, parseDateTime, parseMetricsBody,
  postRate, round6, type Snapshot,
} from "./post-metrics";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  reach: null, impressions: null, likes: null, comments: null, shares: null, saves: null, videoViews: null, clicks: null,
  source: "pull", capturedAt: new Date("2026-11-09T08:00:00Z"), ...o,
});
const bad = (body: unknown, field: string, message = "invalid_field") => {
  try {
    parseMetricsBody(body, NOW);
  } catch (e) {
    const r = (e as { getResponse(): { message: string; field: string }; getStatus(): number });
    expect(r.getStatus()).toBe(400);
    expect(r.getResponse()).toMatchObject({ message, field });
    return;
  }
  throw new Error(`expected a 400 on ${field}`);
};

describe("parseDateTime", () => {
  it("accepts a real date-time with a zone, in any of the usual shapes", () => {
    expect(parseDateTime("2026-11-09T08:00:00Z")?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(parseDateTime("2026-11-09T08:00Z")?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(parseDateTime("2026-11-09T08:00:00.123Z")?.toISOString()).toBe("2026-11-09T08:00:00.123Z");
    expect(parseDateTime("2026-11-09T15:00:00+07:00")?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(parseDateTime("2024-02-29T00:00:00Z")).not.toBeNull(); // a leap day
  });
  it("refuses a day that does not exist, a clock that does not exist, a missing zone and anything that is not a string", () => {
    for (const v of ["2026-02-30T08:00:00Z", "2026-13-01T08:00:00Z", "2026-11-09T24:00:00Z", "2026-11-09T08:60:00Z", "2026-11-09T08:00:60Z",
      "2026-11-09T08:00:00", "2026-11-09", "yesterday", "", "2026-11-09T08:00:00+25:00", "2026-11-09T08:00:00+07:99", "0050-01-01T00:00:00Z", "2025-02-29T00:00:00Z"]) {
      expect(parseDateTime(v), v).toBeNull();
    }
    for (const v of [undefined, null, 1_700_000_000_000, {}, []]) expect(parseDateTime(v)).toBeNull();
  });
});

describe("parseMetricsBody", () => {
  const ok = { capturedAt: "2026-11-09T08:00:00Z", reach: 1000 };

  it("takes the minimum body: reach and capturedAt, the rest not reported (null, never 0)", () => {
    expect(parseMetricsBody(ok, NOW)).toEqual({
      capturedAt: new Date("2026-11-09T08:00:00Z"), reach: 1000,
      impressions: null, likes: null, comments: null, shares: null, saves: null, videoViews: null, clicks: null,
    });
  });
  it("takes every counter, and a zero is a zero", () => {
    const m = parseMetricsBody({ ...ok, reach: 0, impressions: 1500, likes: 40, comments: 3, shares: 2, saves: 5, videoViews: 0, clicks: 7 }, NOW);
    expect(m).toMatchObject({ reach: 0, impressions: 1500, likes: 40, comments: 3, shares: 2, saves: 5, videoViews: 0, clicks: 7 });
  });
  it("treats an explicit null on an optional counter as not reported", () => {
    expect(parseMetricsBody({ ...ok, likes: null }, NOW).likes).toBeNull();
  });
  it("a counter is a whole number from 0 to the integer column's ceiling", () => {
    expect(parseMetricsBody({ ...ok, likes: MAX_COUNT }, NOW).likes).toBe(MAX_COUNT);
    for (const v of [-1, 1.5, "7", NaN, Infinity, MAX_COUNT + 1, true, [], {}]) {
      bad({ ...ok, likes: v }, "likes");
      bad({ ...ok, reach: v }, "reach");
    }
  });
  it("names each bad field", () => {
    for (const k of ["impressions", "comments", "shares", "saves", "videoViews", "clicks"]) bad({ ...ok, [k]: -1 }, k);
  });
  it("capturedAt and reach are required", () => {
    bad({ reach: 1 }, "capturedAt", "missing_field");
    bad({ capturedAt: null, reach: 1 }, "capturedAt", "missing_field");
    bad({ capturedAt: ok.capturedAt }, "reach", "missing_field");
    bad({ capturedAt: ok.capturedAt, reach: null }, "reach", "missing_field");
    bad(undefined, "capturedAt", "missing_field");
    bad([], "capturedAt", "missing_field");
    bad("nope", "capturedAt", "missing_field");
  });
  it("capturedAt is a real date-time, not more than five minutes ahead of now", () => {
    bad({ ...ok, capturedAt: "2026-02-30T08:00:00Z" }, "capturedAt");
    bad({ ...ok, capturedAt: "not a date" }, "capturedAt");
    bad({ ...ok, capturedAt: 1_700_000_000 }, "capturedAt");
    const edge = new Date(NOW.getTime() + CAPTURED_AT_SKEW_MS).toISOString();
    expect(parseMetricsBody({ ...ok, capturedAt: edge }, NOW).capturedAt.toISOString()).toBe(edge);
    bad({ ...ok, capturedAt: new Date(NOW.getTime() + CAPTURED_AT_SKEW_MS + 1000).toISOString() }, "capturedAt");
  });
  it("names the first bad field in the body's own order: capturedAt, then reach, then the counters", () => {
    bad({ capturedAt: "x", reach: -1, likes: -1 }, "capturedAt");
    bad({ capturedAt: ok.capturedAt, reach: -1, likes: -1 }, "reach");
    bad({ ...ok, likes: -1, clicks: -1 }, "likes");
  });
});

describe("engagementRate", () => {
  it("is (likes + comments + saves + shares) / reach", () => {
    expect(engagementRate({ reach: 1000, likes: 40, comments: 5, saves: 3, shares: 2 })).toBeCloseTo(0.05, 12);
  });
  it("counts an unreported counter as 0, and is null without a reach", () => {
    expect(engagementRate({ reach: 200, likes: 10, comments: null, saves: null, shares: null })).toBeCloseTo(0.05, 12);
    expect(engagementRate({ reach: null, likes: 10, comments: 1, saves: 1, shares: 1 })).toBeNull();
    expect(engagementRate({ reach: 0, likes: 10, comments: 1, saves: 1, shares: 1 })).toBeNull(); // nothing to divide by
  });
  it("is 0, not null, for a post with reach and no engagement", () => {
    expect(engagementRate({ reach: 500, likes: 0, comments: 0, saves: 0, shares: 0 })).toBe(0);
  });
});

describe("combineSnapshots", () => {
  it("is null with no snapshot", () => {
    expect(combineSnapshots([])).toBeNull();
  });
  it("sums each counter across variants and keeps a counter nobody reported null", () => {
    const c = combineSnapshots([
      snap({ reach: 600, likes: 30, comments: 2, source: "manual" }),
      snap({ reach: 400, likes: 10, shares: 1, clicks: 4, source: "manual" }),
    ])!;
    expect(c).toMatchObject({ reach: 1000, likes: 40, comments: 2, shares: 1, saves: null, clicks: 4, videoViews: null, impressions: null });
  });
  it("adds only what is reported: one variant with a reach and one without", () => {
    const c = combineSnapshots([snap({ reach: 600, likes: 30 }), snap({ likes: 5 })])!;
    expect(c.reach).toBe(600);
    expect(c.likes).toBe(35);
  });
  it("the source is simulated if any is, else manual if any is, else pull; the capture time is the newest", () => {
    const t1 = new Date("2026-11-08T00:00:00Z");
    const t2 = new Date("2026-11-09T00:00:00Z");
    expect(combineSnapshots([snap({ source: "pull" }), snap({ source: "pull" })])!.source).toBe("pull");
    expect(combineSnapshots([snap({ source: "pull" }), snap({ source: "manual" })])!.source).toBe("manual");
    expect(combineSnapshots([snap({ source: "manual" }), snap({ source: "simulated" }), snap({ source: "pull" })])!.source).toBe("simulated");
    expect(combineSnapshots([snap({ capturedAt: t1 }), snap({ capturedAt: t2 })])!.capturedAt).toEqual(t2);
  });
});

describe("postRate", () => {
  it("keeps to the variants that report a reach, numerator and denominator both", () => {
    // 500 reach with 25 engaged is 5%; the pulled variant's 900 likes have no reach behind them and must not lift it.
    expect(postRate([snap({ reach: 500, likes: 20, saves: 5 }), snap({ likes: 900 })])).toBeCloseTo(0.05, 12);
  });
  it("pools the variants that do: total engaged over total reach", () => {
    expect(postRate([snap({ reach: 1000, likes: 100 }), snap({ reach: 1000, likes: 0 })])).toBeCloseTo(0.05, 12);
  });
  it("is null when no variant has a reach", () => {
    expect(postRate([])).toBeNull();
    expect(postRate([snap({ likes: 10 }), snap({ reach: 0, likes: 10 })])).toBeNull();
  });
});

describe("meanRate and isBoostCandidate", () => {
  it("the mean ignores the posts with no rate, and is null when none has one", () => {
    expect(meanRate([0.02, null, 0.04])).toBeCloseTo(0.03, 12);
    expect(meanRate([null, null])).toBeNull();
    expect(meanRate([])).toBeNull();
    expect(meanRate([0, 0.04])).toBeCloseTo(0.02, 12); // a zero rate is a rate
  });
  it("the default factor is 1.25", () => {
    expect(DEFAULT_BOOST_FACTOR).toBe(1.25);
  });
  it("a post is a candidate at or above factor times the average, and not below it", () => {
    expect(isBoostCandidate(0.0501, 0.04, 1.25)).toBe(true);
    expect(isBoostCandidate(0.05, 0.04, 1.25)).toBe(true); // exactly the bar (0.04 x 1.25 is 0.05 in decimals, a hair off in binary)
    expect(isBoostCandidate(0.0499, 0.04, 1.25)).toBe(false);
  });
  it("the factor is the company's: a higher one raises the bar, 1.00 means anything at the average", () => {
    expect(isBoostCandidate(0.06, 0.04, 1.25)).toBe(true);
    expect(isBoostCandidate(0.06, 0.04, 2)).toBe(false);
    expect(isBoostCandidate(0.04, 0.04, 1)).toBe(true);
    expect(isBoostCandidate(0.0399, 0.04, 1)).toBe(false);
  });
  it("is false when either side is null, and a zero average is met by any rate", () => {
    expect(isBoostCandidate(null, 0.04, 1.25)).toBe(false);
    expect(isBoostCandidate(0.5, null, 1.25)).toBe(false);
    expect(isBoostCandidate(null, null, 1.25)).toBe(false);
    expect(isBoostCandidate(0, 0, 1.25)).toBe(true); // 0 >= 0: the average is zero, so nothing beats it but nothing is below it
  });
});

describe("round6", () => {
  it("answers six decimals and keeps null", () => {
    expect(round6(0.0123456789)).toBe(0.012346);
    expect(round6(0)).toBe(0);
    expect(round6(null)).toBeNull();
  });
});
