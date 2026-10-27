import { describe, it, expect } from "vitest";

// SCP-3c (BFF §63.10 "Metrics"): the post page's metrics helpers: the parsing of the two answers, the words, who is offered the form, the form's body, and the maths twin
// DEMO_MODE answers with. The maths pins the SAME golden values as the server's `post-metrics.test.ts`, so the two sides cannot drift apart unseen.
import {
  CAPTURED_AT_SKEW_MS, COUNTERS, MAX_COUNT, asPostMetrics, asStoredMetrics, buildMetricsBody, canEnterMetrics, combineSnapshots, emptyMetricsForm, formatCount, formatRate,
  isBoostCandidate, meanRate, postRate, round6, SOURCE_WORDS, type MetricsForm, type Snapshot,
} from "./socialMetrics";
import { isoToZoneInput } from "./socialPipeline";

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  reach: null, impressions: null, likes: null, comments: null, shares: null, saves: null, clicks: null, videoViews: null, source: "pull", capturedAt: new Date("2026-11-09T08:00:00Z"), ...o,
});
const NOW = new Date("2026-11-10T12:00:00Z");
const form = (over: Partial<Record<string, string>> = {}): MetricsForm => {
  const f = emptyMetricsForm(NOW);
  return { capturedAt: over.capturedAt ?? isoToZoneInput("2026-11-10T11:00:00Z"), values: { ...f.values, reach: "1000", ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "capturedAt")) } };
};

describe("asPostMetrics", () => {
  const ok = {
    latest: { reach: 1000, impressions: null, likes: 40, comments: 5, shares: 2, saves: 3, clicks: null, videoViews: null, source: "manual", capturedAt: "2026-11-09T08:00:00.000Z" },
    engagementRate: 0.05, accountAverageRate: 0.03, boostCandidate: true, simulated: false,
  };
  it("reads the contract's answer, keeping a counter nobody reported null", () => {
    const m = asPostMetrics(ok);
    expect(m.latest).toMatchObject({ reach: 1000, likes: 40, impressions: null, clicks: null, videoViews: null, source: "manual", capturedAt: "2026-11-09T08:00:00.000Z" });
    expect(m).toMatchObject({ engagementRate: 0.05, accountAverageRate: 0.03, boostCandidate: true, simulated: false });
  });
  it("reads the empty answer: no snapshot, no rate, no average", () => {
    expect(asPostMetrics({ latest: null, engagementRate: null, accountAverageRate: null, boostCandidate: false, simulated: false })).toEqual({
      latest: null, engagementRate: null, accountAverageRate: null, boostCandidate: false, simulated: false,
    });
  });
  it("refuses a body of the wrong shape instead of drawing a plausible empty block", () => {
    for (const bad of [null, "x", [], {}, { ...ok, boostCandidate: "yes" }, { ...ok, simulated: undefined }, { ...ok, latest: { ...ok.latest, source: "typed" } },
      { ...ok, latest: { ...ok.latest, capturedAt: 5 } }, { ...ok, latest: "yesterday" }, { engagementRate: null, boostCandidate: false, simulated: false }]) {
      expect(() => asPostMetrics(bad), JSON.stringify(bad)).toThrow();
    }
  });
  it("a number that is not a finite number reads as not reported", () => {
    expect(asPostMetrics({ ...ok, engagementRate: "5%", accountAverageRate: Number.NaN }).engagementRate).toBeNull();
  });
});

describe("asStoredMetrics", () => {
  it("reads a 201's row", () => {
    const r = asStoredMetrics({ id: "m1", variantId: "v1", postId: "p1", source: "manual", capturedAt: "2026-11-09T08:00:00.000Z", reach: 10, likes: 2, impressions: null, enteredBy: "u1" });
    expect(r).toMatchObject({ id: "m1", variantId: "v1", postId: "p1", reach: 10, likes: 2, impressions: null, comments: null, enteredBy: "u1", source: "manual" });
  });
  it("refuses a body that is not a stored snapshot", () => {
    for (const bad of [null, {}, { id: "m1" }, { id: "m1", variantId: "v1" }, []]) expect(() => asStoredMetrics(bad)).toThrow();
  });
});

describe("the words", () => {
  it("a rate is a percentage with one decimal, and not known when there is none", () => {
    expect(formatRate(0.05)).toBe("5.0%");
    expect(formatRate(0.0423)).toBe("4.2%");
    expect(formatRate(0)).toBe("0.0%");
    expect(formatRate(null)).toBe("Not known");
  });
  it("a count has separators, and a counter nobody reported is Not reported (never 0)", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe("Not reported");
  });
  it("names the three sources", () => {
    expect(SOURCE_WORDS).toEqual({ pull: "Pulled", manual: "Typed in", simulated: "Simulated" });
  });
});

describe("canEnterMetrics", () => {
  const post = (status: string, officer: string | null) => ({ pipelineStatus: status, officer: officer ? { id: officer, name: "Mock Officer" } : null });
  it("is the client's officer, on a live post", () => {
    expect(canEnterMetrics(post("live", "u1"), "u1")).toBe(true);
  });
  it("is nobody else, no signed-in person, a post that is not live, or a post with no officer", () => {
    expect(canEnterMetrics(post("live", "u1"), "u2")).toBe(false);
    expect(canEnterMetrics(post("live", "u1"), null)).toBe(false);
    expect(canEnterMetrics(post("live", "u1"), undefined)).toBe(false);
    expect(canEnterMetrics(post("scheduled", "u1"), "u1")).toBe(false);
    expect(canEnterMetrics(post("live", null), "u1")).toBe(false);
  });
});

describe("buildMetricsBody", () => {
  it("builds the body from the form: the capture time as an instant, every filled counter a number, a blank one left out", () => {
    const r = buildMetricsBody(form({ likes: "40", comments: " 5 ", impressions: "" }), NOW);
    expect(r).toEqual({ ok: true, body: { capturedAt: "2026-11-10T11:00:00.000Z", reach: 1000, likes: 40, comments: 5 } });
  });
  it("takes reach 0 (a number), and the integer ceiling", () => {
    expect(buildMetricsBody(form({ reach: "0" }), NOW)).toMatchObject({ ok: true, body: { reach: 0 } });
    expect(buildMetricsBody(form({ likes: String(MAX_COUNT) }), NOW)).toMatchObject({ ok: true, body: { likes: MAX_COUNT } });
  });
  it("names reach when it is missing, and each counter that is not a whole number from 0", () => {
    const missing = buildMetricsBody(form({ reach: "  " }), NOW);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && Object.keys(missing.errors)).toEqual(["reach"]);
    for (const k of COUNTERS) {
      for (const v of ["-1", "1.5", "1e3", "abc", "12 000", String(MAX_COUNT + 1), "99999999999"]) {
        const r = buildMetricsBody(form({ [k]: v }), NOW);
        expect(r.ok, `${k}=${v}`).toBe(false);
        expect(!r.ok && r.errors[k], `${k}=${v}`).toBeTruthy();
      }
    }
  });
  it("refuses a capture time that is blank, or ahead of the clock by more than the skew", () => {
    const blank = buildMetricsBody(form({ capturedAt: "" }), NOW);
    expect(!blank.ok && blank.errors.capturedAt).toBeTruthy();
    const ahead = isoToZoneInput(new Date(NOW.getTime() + CAPTURED_AT_SKEW_MS + 120_000).toISOString());
    const future = buildMetricsBody(form({ capturedAt: ahead }), NOW);
    expect(!future.ok && future.errors.capturedAt).toBe("These numbers cannot be from the future.");
    const near = isoToZoneInput(new Date(NOW.getTime() + 60_000).toISOString());
    expect(buildMetricsBody(form({ capturedAt: near }), NOW).ok).toBe(true);
  });
  it("reports every bad field at once", () => {
    const r = buildMetricsBody(form({ capturedAt: "", reach: "", likes: "x" }), NOW);
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(["capturedAt", "likes", "reach"]);
  });
});

describe("the maths twin (the server's golden values)", () => {
  it("sums each counter across variants and keeps a counter nobody reported null", () => {
    const c = combineSnapshots([snap({ reach: 600, likes: 30, comments: 2, source: "manual" }), snap({ reach: 400, likes: 10, shares: 1, clicks: 4, source: "manual" })])!;
    expect(c).toMatchObject({ reach: 1000, likes: 40, comments: 2, shares: 1, saves: null, clicks: 4, videoViews: null, impressions: null });
    expect(combineSnapshots([])).toBeNull();
  });
  it("the source is simulated if any is, else manual if any is, else pull; the capture time the newest", () => {
    const t2 = new Date("2026-11-09T00:00:00Z");
    expect(combineSnapshots([snap(), snap()])!.source).toBe("pull");
    expect(combineSnapshots([snap(), snap({ source: "manual" })])!.source).toBe("manual");
    expect(combineSnapshots([snap({ source: "manual" }), snap({ source: "simulated" }), snap()])!.source).toBe("simulated");
    expect(combineSnapshots([snap({ capturedAt: new Date("2026-11-08T00:00:00Z") }), snap({ capturedAt: t2 })])!.capturedAt).toEqual(t2);
  });
  it("a post's rate keeps to the variants that report a reach, and pools them", () => {
    expect(postRate([snap({ reach: 500, likes: 20, saves: 5 }), snap({ likes: 900 })])).toBeCloseTo(0.05, 12);
    expect(postRate([snap({ reach: 1000, likes: 100 }), snap({ reach: 1000, likes: 0 })])).toBeCloseTo(0.05, 12);
    expect(postRate([])).toBeNull();
    expect(postRate([snap({ likes: 10 }), snap({ reach: 0, likes: 10 })])).toBeNull();
    expect(postRate([snap({ reach: 800, likes: 0 })])).toBe(0);
  });
  it("the mean ignores the posts with no rate, and a zero rate is a rate", () => {
    expect(meanRate([0.02, null, 0.04])).toBeCloseTo(0.03, 12);
    expect(meanRate([null, null])).toBeNull();
    expect(meanRate([0, 0.04])).toBeCloseTo(0.02, 12);
  });
  it("a candidate is at or above factor times the average: the exact bar counts, a hair under does not, and a null side is never one", () => {
    expect(isBoostCandidate(0.0501, 0.04, 1.25)).toBe(true);
    expect(isBoostCandidate(0.05, 0.04, 1.25)).toBe(true);
    expect(isBoostCandidate(0.0499, 0.04, 1.25)).toBe(false);
    expect(isBoostCandidate(0.06, 0.04, 2)).toBe(false);
    expect(isBoostCandidate(0.04, 0.04, 1)).toBe(true);
    expect(isBoostCandidate(null, 0.04, 1.25)).toBe(false);
    expect(isBoostCandidate(0.5, null, 1.25)).toBe(false);
    expect(isBoostCandidate(0, 0, 1.25)).toBe(true);
  });
  it("answers six decimals and keeps null", () => {
    expect(round6(0.0123456789)).toBe(0.012346);
    expect(round6(null)).toBeNull();
  });
});
