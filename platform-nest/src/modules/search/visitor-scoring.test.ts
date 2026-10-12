// M5-V3-e — the pure interests/score module (design §4.6). No services needed.
import { describe, it, expect } from "vitest";
import {
  SCORE_MAX, computeInterests, computeScore, countVisits, depthPoints, frequencyPoints, intentPoints, recencyPoints, summarizeVisitor,
  type InterestRule, type ScoredEvent,
} from "./visitor-scoring";

const NOW = new Date("2026-10-12T12:00:00Z");
const daysAgo = (d: number, minutes = 0) => new Date(NOW.getTime() - d * 86400000 - minutes * 60000);
const pv = (path: string, at = daysAgo(1), section?: string): ScoredEvent => ({ occurredAt: at, kind: "pageview", path, name: null, data: section ? { section_id: section } : null });
const ev = (name: string, at = daysAgo(1), data: Record<string, unknown> | null = null): ScoredEvent => ({ occurredAt: at, kind: "event", path: "/x/", name, data });

const RULES: InterestRule[] = [
  { match: "path_prefix", pattern: "/services/web", facet: "service", tag: "web", weight: 5 },
  { match: "path_prefix", pattern: "/services/seo", facet: "service", tag: "seo", weight: 3 },
  { match: "path_prefix", pattern: "/work/hotel", facet: "industry", tag: "hospitality", weight: 4 },
  { match: "section_prefix", pattern: "pricing.", facet: "service", tag: "web", weight: 2 },
  { match: "path_prefix", pattern: "/services/ads", facet: "service", tag: "ads", weight: 1 },
  { match: "path_prefix", pattern: "/services/brand", facet: "service", tag: "brand", weight: 1 },
];

describe("interests", () => {
  it("no rules means no interests, never a guess", () => {
    expect(computeInterests([pv("/services/web/"), pv("/work/hotel-a/")], [], NOW)).toEqual({});
    expect(summarizeVisitor([pv("/services/web/")], [], NOW).interests).toEqual({});
  });

  it("rules but no match means no interests", () => {
    expect(computeInterests([pv("/about/")], RULES, NOW)).toEqual({});
  });

  it("sums weights over DISTINCT pages and sections: ten views of one page count once", () => {
    const events = [...Array.from({ length: 10 }, () => pv("/services/web/")), pv("/services/web/shop/"), pv("/home/", daysAgo(1), "pricing.step3")];
    // /services/web/ (5) + /services/web/shop/ (5) + section pricing.step3 (2) = 12
    expect(computeInterests(events, RULES, NOW)).toEqual({ service: [{ tag: "web", score: 12 }] });
  });

  it("only the last 90 days count", () => {
    expect(computeInterests([pv("/services/web/", daysAgo(91))], RULES, NOW)).toEqual({});
    expect(computeInterests([pv("/services/web/", daysAgo(89))], RULES, NOW)).toEqual({ service: [{ tag: "web", score: 5 }] });
  });

  it("keeps the top three per facet, score desc then tag asc", () => {
    const events = [pv("/services/web/"), pv("/services/seo/"), pv("/services/ads/"), pv("/services/brand/"), pv("/work/hotel-a/")];
    expect(computeInterests(events, RULES, NOW)).toEqual({
      industry: [{ tag: "hospitality", score: 4 }],
      service: [{ tag: "web", score: 5 }, { tag: "seo", score: 3 }, { tag: "ads", score: 1 }],
    });
  });
});

describe("score parts", () => {
  it("recency: <=7 days 25, <=30 days 15, <=90 days 5, else 0", () => {
    expect(recencyPoints(daysAgo(0), NOW)).toBe(25);
    expect(recencyPoints(daysAgo(7), NOW)).toBe(25);
    expect(recencyPoints(daysAgo(8), NOW)).toBe(15);
    expect(recencyPoints(daysAgo(30), NOW)).toBe(15);
    expect(recencyPoints(daysAgo(31), NOW)).toBe(5);
    expect(recencyPoints(daysAgo(90), NOW)).toBe(5);
    expect(recencyPoints(daysAgo(91), NOW)).toBe(0);
    expect(recencyPoints(null, NOW)).toBe(0);
  });

  it("frequency: 2 -> 5, 3-4 -> 10, >=5 -> 15", () => {
    expect([0, 1, 2, 3, 4, 5, 40].map(frequencyPoints)).toEqual([0, 0, 5, 10, 10, 15, 15]);
  });

  it("depth: the sum of matched weights, capped at 30", () => {
    expect(depthPoints([pv("/services/web/")], RULES, NOW)).toBe(5);
    const many = Array.from({ length: 10 }, (_, i) => pv(`/services/web/p${i}/`));
    expect(depthPoints(many, RULES, NOW)).toBe(SCORE_MAX.depth);
    expect(depthPoints(many, [], NOW)).toBe(0);
  });

  it("intent: lead_form_start 15, one contact click 10, generate_lead 5, each once, capped at 30", () => {
    expect(intentPoints([ev("lead_form_start")], NOW)).toBe(15);
    expect(intentPoints([ev("cta_click"), ev("click_phone"), ev("click_email")], NOW)).toBe(10);
    expect(intentPoints([ev("generate_lead"), ev("generate_lead")], NOW)).toBe(5);
    expect(intentPoints([ev("lead_form_start"), ev("click_whatsapp"), ev("generate_lead"), ev("lead_form_start")], NOW)).toBe(30);
    expect(intentPoints([ev("lead_form_start", daysAgo(120))], NOW)).toBe(0);
    expect(intentPoints([ev("scroll_depth")], NOW)).toBe(0);
  });

  it("the score is exactly the sum of its parts, and within 0..100", () => {
    const cases: ScoredEvent[][] = [
      [],
      [pv("/about/")],
      [pv("/services/web/"), ev("lead_form_start")],
      [...Array.from({ length: 12 }, (_, i) => pv(`/services/web/p${i}/`, daysAgo(i * 3, i))), ev("lead_form_start"), ev("cta_click"), ev("generate_lead")],
      [pv("/work/hotel-a/", daysAgo(45)), pv("/work/hotel-b/", daysAgo(200))],
    ];
    for (const events of cases) {
      const s = summarizeVisitor(events, RULES, NOW);
      const p = s.scoreParts;
      expect(s.score).toBe(p.recency + p.frequency + p.depth + p.intent);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      for (const k of Object.keys(SCORE_MAX) as Array<keyof typeof SCORE_MAX>) expect(p[k]).toBeLessThanOrEqual(SCORE_MAX[k]);
    }
    const direct = computeScore({ lastSeenAt: daysAgo(2), visits: 3, events: [pv("/services/seo/")], rules: RULES, now: NOW });
    expect(direct).toEqual({ score: 25 + 10 + 3 + 0, parts: { recency: 25, frequency: 10, depth: 3, intent: 0 } });
  });

  it("the maximum is reachable and is 100", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => pv(`/services/web/p${i}/`, daysAgo(i, 0))),
      ev("lead_form_start"), ev("cta_click"), ev("generate_lead"),
    ];
    expect(summarizeVisitor(events, RULES, NOW).score).toBe(100);
  });
});

describe("visits and the summary", () => {
  it("a visit is a run of events with no gap over 30 minutes", () => {
    expect(countVisits([])).toBe(0);
    expect(countVisits([daysAgo(1)])).toBe(1);
    expect(countVisits([daysAgo(1, 0), daysAgo(1, 10), daysAgo(1, 39)])).toBe(1);
    expect(countVisits([daysAgo(1, 0), daysAgo(1, 31)])).toBe(2);
    expect(countVisits([daysAgo(1, 31), daysAgo(3), daysAgo(1, 0)])).toBe(3); // order does not matter
  });

  it("summarizes first/last seen, visits and pageviews from the events", () => {
    const events = [pv("/a/", daysAgo(10)), ev("cta_click", daysAgo(10, -5)), pv("/b/", daysAgo(2)), pv("/c/", daysAgo(2, 5))];
    const s = summarizeVisitor(events, [], NOW);
    expect(s.firstSeenAt).toEqual(daysAgo(10));
    expect(s.lastSeenAt).toEqual(daysAgo(2));
    expect(s.visits).toBe(2);
    expect(s.pageviews).toBe(3);
  });

  it("is deterministic: the same input gives the same output", () => {
    const events = [pv("/services/web/"), pv("/work/hotel-a/"), ev("lead_form_start")];
    expect(summarizeVisitor(events, RULES, NOW)).toEqual(summarizeVisitor([...events].reverse(), [...RULES].reverse(), NOW));
  });
});
