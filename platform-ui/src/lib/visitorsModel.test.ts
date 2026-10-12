import { describe, it, expect } from "vitest";
import {
  HEADER_LINE, LEAD_RESTRICTED_WORDS, VisitorsShapeError, botFilterNote, checkRuleDrafts, cleanListQuery, fmtWhen, interestChips,
  parseInterestRules, parseVisitorDetail, parseVisitorList, parseVisitorStatus, placeLabel, ruleRefusalSentence, shortId, whoLabel,
} from "./visitorsModel";

const V1 = "0194a3b2-1111-7000-8000-000000000001";
const V2 = "ffff0000-2222-7000-8000-000000000002";
const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const row = (id: string, o: Record<string, unknown> = {}) => ({
  visitorId: id, firstSeenAt: "2026-10-01T08:00:00.000Z", lastSeenAt: "2026-10-12T09:30:00.000Z", visits: 4, pageviews: 11, device: "desktop",
  country: "ID", city: "Denpasar", network: { kind: "network", name: "Telkom", asn: 7713 }, company: null,
  interests: { industry: [{ tag: "hospitality", score: 8 }], service: [{ tag: "web-design", score: 5 }] }, score: 61, lead: { state: "none" }, ...o,
});

describe("header line", () => {
  it("is exactly the design's sentence", () => {
    expect(HEADER_LINE).toBe("Only visitors who accepted analytics. A score is a guide for follow-up, never a decision about a person.");
  });
});

describe("shortId", () => {
  it("is the first 8 characters of the id", () => {
    expect(shortId(V1)).toBe("0194a3b2");
    expect(shortId(V2)).toBe("ffff0000");
    expect(shortId(V1)).toHaveLength(8);
  });
});

describe("parseVisitorList", () => {
  it("keeps the server's order (never sorts)", () => {
    const out = parseVisitorList({ propertyId: P, nextCursor: "abc", visitors: [row(V2, { score: 10 }), row(V1, { score: 90 })] });
    expect(out.visitors.map((v) => v.visitorId)).toEqual([V2, V1]);
    expect(out.nextCursor).toBe("abc");
  });
  it("refuses a list row that carries a lead id (a row says only linked or none)", () => {
    expect(() => parseVisitorList({ propertyId: P, nextCursor: null, visitors: [row(V1, { lead: { state: "linked", id: V2 } })] })).toThrow(VisitorsShapeError);
    expect(() => parseVisitorList({ propertyId: P, nextCursor: null, visitors: [row(V1, { lead: { state: "readable" } })] })).toThrow(VisitorsShapeError);
  });
  it("an off-contract body is a defect, not an empty list", () => {
    expect(() => parseVisitorList({ propertyId: P, nextCursor: null })).toThrow(VisitorsShapeError);
    expect(() => parseVisitorList({ propertyId: P, nextCursor: null, visitors: [row("not-an-id")] })).toThrow(VisitorsShapeError);
    expect(() => parseVisitorList("nope")).toThrow(VisitorsShapeError);
  });
  it("accepts an empty list from a successful read", () => {
    expect(parseVisitorList({ propertyId: P, nextCursor: null, visitors: [] }).visitors).toEqual([]);
  });
});

describe("parseVisitorDetail", () => {
  const detail = (lead: unknown, o: Record<string, unknown> = {}) => ({
    propertyId: P,
    visitor: {
      ...row(V1), lead, scoreParts: { recency: 20, frequency: 10, depth: 15, intent: 16 }, scoreMax: { recency: 25, frequency: 15, depth: 30, intent: 30 },
      events: [{ occurredAt: "2026-10-12T09:30:00.000Z", kind: "pageview", path: "/services/", name: null, data: null },
        { occurredAt: "2026-10-12T09:20:00.000Z", kind: "event", path: "/contact/", name: "lead_form_start", data: { form_id: "contact", nested: { x: 1 } } }],
      eventsTruncated: false, ...o,
    },
  });
  it("readable carries the id; restricted carries words and no id; none carries neither", () => {
    expect(parseVisitorDetail(detail({ state: "readable", id: V2 })).lead).toEqual({ state: "readable", id: V2 });
    const r = parseVisitorDetail(detail({ state: "restricted", message: LEAD_RESTRICTED_WORDS, id: V2 })).lead;
    expect(r).toEqual({ state: "restricted", message: "a lead you cannot open" });
    expect(JSON.stringify(r)).not.toContain(V2);
    expect(parseVisitorDetail(detail({ state: "none" })).lead).toEqual({ state: "none" });
  });
  it("keeps event order and drops non-scalar event data", () => {
    const d = parseVisitorDetail(detail({ state: "none" }));
    expect(d.events.map((e) => e.path)).toEqual(["/services/", "/contact/"]);
    expect(d.events[1].data).toEqual({ form_id: "contact" });
  });
  it("refuses an unknown lead state", () => {
    expect(() => parseVisitorDetail(detail({ state: "linked" }))).toThrow(VisitorsShapeError);
  });
});

describe("parseVisitorStatus", () => {
  const base = { configured: true, enabled: true, lastOkIngestAt: null, lastRunAt: null, lastOutcome: null };
  it.each(["not_configured", "disabled", "no_website", "unreachable", "rejected"])("%s keeps the server's words and has no bot counts", (state) => {
    const s = parseVisitorStatus({ ...base, state, message: `words for ${state}`, bots: null });
    expect(s.state).toBe(state);
    expect(s.message).toBe(`words for ${state}`);
    expect(s.bots).toBeNull();
  });
  it("ok carries bot counts; ok without them is a defect (the figure would silently be a zero)", () => {
    const s = parseVisitorStatus({ ...base, state: "ok", bots: { from: "2026-09-14", to: "2026-10-13", days: 30, total: 1234, byReason: { ua: 1000, asn: 234 } } });
    expect(s.bots?.total).toBe(1234);
    expect(() => parseVisitorStatus({ ...base, state: "ok", bots: null })).toThrow(VisitorsShapeError);
  });
  it("an unknown state is a defect", () => {
    expect(() => parseVisitorStatus({ ...base, state: "fine", bots: null })).toThrow(VisitorsShapeError);
  });
});

describe("parseInterestRules", () => {
  it("reads the rule set and refuses a rule with an unknown match", () => {
    const ok = parseInterestRules({ propertyId: P, note: "n", rules: [{ id: V1, match: "path_prefix", pattern: "/x/", facet: "service", tag: "web", weight: 3 }] });
    expect(ok.rules).toHaveLength(1);
    expect(() => parseInterestRules({ propertyId: P, note: "n", rules: [{ id: V1, match: "regex", pattern: "/x/", facet: "service", tag: "web", weight: 3 }] })).toThrow(VisitorsShapeError);
  });
});

describe("labels", () => {
  it("Network or Company by kind, with confidence", () => {
    expect(whoLabel({ network: { kind: "network", name: "Telkom", domain: null, confidence: null, source: null }, company: null })).toBe("Network: Telkom");
    expect(whoLabel({ network: { kind: "network", name: "Telkom", domain: null, confidence: null, source: null }, company: { kind: "company", name: "Acme Ltd", domain: "acme.test", confidence: "high", source: "x", version: null } as never }))
      .toBe("Company: Acme Ltd (high confidence)");
    expect(whoLabel({ network: null, company: null })).toBe("Not resolved");
  });
  it("place, interests, time", () => {
    expect(placeLabel({ country: "ID", city: "Denpasar" })).toBe("Denpasar, ID");
    expect(placeLabel({ country: null, city: null })).toBe("Unknown");
    expect(interestChips({ industry: [{ tag: "a", score: 1 }], service: [{ tag: "b", score: 1 }] })).toEqual(["a", "b"]);
    expect(fmtWhen("2026-10-12T09:30:00.000Z")).toBe("2026-10-12 09:30 UTC");
    expect(fmtWhen(null)).toBe("never");
  });
});

describe("bot filter note", () => {
  it("names the go-live day when known, and says it is not recorded when not", () => {
    expect(botFilterNote("2026-11-02")).toContain("2026-11-02");
    expect(botFilterNote(null)).toContain("not recorded");
  });
});

describe("interest-rule refusals are sentences", () => {
  it("never shows a code", () => {
    for (const [status, reason] of [[403, null], [404, null], [400, "rule_tag_invalid"], [400, "rule_duplicate"], [400, "unheard_of"], [500, null]] as const) {
      const s = ruleRefusalSentence(status, reason);
      expect(s).toMatch(/[.]$/);
      expect(s).not.toMatch(/_/);
    }
    expect(ruleRefusalSentence(403, null)).toContain("not allowed");
  });
  it("the client check catches a duplicate, a bad tag and a bad weight before the round trip", () => {
    const r = { match: "path_prefix", pattern: "/a/", facet: "service", tag: "web", weight: 2 } as const;
    expect(checkRuleDrafts([r])).toBeNull();
    expect(checkRuleDrafts([r, { ...r }])).toContain("identical");
    expect(checkRuleDrafts([{ ...r, tag: "Web Design" }])).toContain("lower-case");
    expect(checkRuleDrafts([{ ...r, weight: 11 }])).toContain("1 to 10");
    expect(checkRuleDrafts([{ ...r, pattern: "" }])).toContain("pattern");
  });
});

describe("cleanListQuery", () => {
  it("keeps valid filters and names the ones it ignored", () => {
    const { query, ignored } = cleanListQuery({ minScore: "40", order: "recent", hasLead: "true", facet: "service", tag: "web-design", seenFrom: "2026-10-01" });
    expect(query).toEqual({ minScore: "40", order: "recent", hasLead: "true", facet: "service", tag: "web-design", seenFrom: "2026-10-01" });
    expect(ignored).toEqual([]);
    const bad = cleanListQuery({ minScore: "500", order: "random", tag: "Bad Tag", seenFrom: "yesterday" });
    expect(bad.query).toEqual({});
    expect(bad.ignored).toEqual(["minimum score", "order", "interest tag", "seen-from date"]);
  });
});
