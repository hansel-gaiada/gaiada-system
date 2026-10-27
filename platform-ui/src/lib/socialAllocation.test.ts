import { describe, it, expect } from "vitest";
import { PLAN_REFUSAL_REASON } from "./socialCycles";
import {
  allocationRefusalText, asAllocationRow, asAllocationRows, cycleCountsText, estimateProblem, type AllocationRow,
} from "./socialAllocation";
import {
  EMPTY_BRAND_BOOK, asBrandBook, brandBookRefusalText, isHttpUrl, isKeyDate, parseLines, parseTags, validateBrandBook, type BrandBook,
} from "./socialBrandBook";

// SCP-1a: the Allocation page's and the brand book's pure side. The rules are the server's (BFF §63.1); this file pins the parsing, the words and the
// client-side mirror of the limits.

const raw = (over: Record<string, unknown> = {}) => ({
  engagementId: "e-1", clientId: "c-1", clientName: "Brand Alpha", status: "active", officer: { id: "u-1", name: "Sam Officer" }, postsPerCycle: 12,
  creativeSource: "in_team", deliveryBatch: "A", reportFormat: "meeting", reportDueDay: 5, platforms: ["instagram", 7], formats: ["feed"],
  defaultPostTime: "09:30", stepEstimates: { hod: 2, design: 99, nope: 1, client: 1.5 },
  thisCycle: { cycleId: "cy-1", month: "2026-10", target: 12, counted: 8, extra: 1, stories: 2 }, canPlan: true, ...over,
});

describe("asAllocationRow", () => {
  it("reads every field of the contract's AllocationRow", () => {
    expect(asAllocationRow(raw())).toEqual({
      engagementId: "e-1", clientId: "c-1", clientName: "Brand Alpha", status: "active", officer: { id: "u-1", name: "Sam Officer" }, postsPerCycle: 12,
      creativeSource: "in_team", deliveryBatch: "A", reportFormat: "meeting", reportDueDay: 5, platforms: ["instagram"], formats: ["feed"],
      defaultPostTime: "09:30", stepEstimates: { hod: 2 }, // out-of-range, unknown and non-integer estimates are dropped, never trusted
      thisCycle: { cycleId: "cy-1", month: "2026-10", target: 12, counted: 8, extra: 1, stories: 2 }, canPlan: true,
    });
  });
  it("reads absent values as the contract's null, empty and default", () => {
    const r = asAllocationRow({ engagementId: "e-2", clientName: "Brand Beta", officer: null, thisCycle: null });
    expect(r).toMatchObject({
      officer: null, postsPerCycle: null, creativeSource: "creatives", deliveryBatch: null, reportFormat: null, reportDueDay: null,
      platforms: [], formats: [], defaultPostTime: null, stepEstimates: {}, thisCycle: null, canPlan: false,
    });
  });
  it("canPlan is true only for the literal true", () => {
    expect(asAllocationRow(raw({ canPlan: "yes" })).canPlan).toBe(false);
  });
  it("throws on a body that is not a row or a list, so the reader says 'cannot tell'", () => {
    expect(() => asAllocationRow({ nope: 1 })).toThrow();
    expect(() => asAllocationRows({ items: "x" })).toThrow();
    expect(() => asAllocationRows([])).toThrow();
    expect(asAllocationRows({ items: [raw(), raw({ engagementId: "e-9" })] }).map((x) => x.engagementId)).toEqual(["e-1", "e-9"]);
  });
});

describe("cycleCountsText", () => {
  const row = (over: Partial<AllocationRow>) => ({ ...asAllocationRow(raw()), ...over });
  it("counts against the target, with the stories and extra posts beside it", () => {
    expect(cycleCountsText(row({}))).toEqual({ main: "8 of 12", beside: "1 extra · 2 stories" });
  });
  it("shows the count alone with no target, and says nothing for a client with no cycle", () => {
    expect(cycleCountsText(row({ postsPerCycle: null, thisCycle: { cycleId: "c", month: "2026-10", target: null, counted: 3, extra: 0, stories: 1 } }))).toEqual({ main: "3", beside: "1 story" });
    expect(cycleCountsText(row({ thisCycle: null }))).toBeNull();
  });
});

describe("the words of a refusal", () => {
  it("not_a_social_approver is the plan reason, and the other codes are worded", () => {
    expect(allocationRefusalText("not_a_social_approver")).toBe(PLAN_REFUSAL_REASON);
    expect(allocationRefusalText("officer_not_member")).toMatch(/active employee/);
    expect(allocationRefusalText("invalid_field", "postsPerCycle")).toMatch(/0 to 200/);
    expect(allocationRefusalText("invalid_field", "reportDueDay")).toMatch(/1 to 31/);
    expect(allocationRefusalText("invalid_field", "stepEstimates")).toMatch(/0 to 30/);
    expect(allocationRefusalText("invalid_field", "other")).toBe("other is not valid.");
    expect(allocationRefusalText("something_new")).toBe("something_new");
  });
  it("estimateProblem: empty clears, a whole number 0 to 30 is fine, the rest is a problem", () => {
    for (const ok of ["", "  ", "0", "30", "7"]) expect(estimateProblem(ok), ok).toBeNull();
    for (const bad of ["31", "-1", "2.5", "abc"]) expect(estimateProblem(bad), bad).not.toBeNull();
  });
});

describe("the brand book", () => {
  const full: BrandBook = {
    toneSummary: "  Warm.  ", contentPillars: [" One ", "", "Two"], mustHaveNotes: ["Note"], brandRules: ["Rule"],
    hashtagSets: [{ name: " Set ", tags: ["#a", "b", ""] }], channels: [{ network: "instagram", handle: " @h ", url: " https://example.com/x " }, { network: "x", handle: "h2", url: "  " }],
    keyDates: [{ date: "02-29", label: " Leap " }, { date: "2026-12-24", label: "Eve" }], links: [{ label: "Guide", url: "https://example.com" }],
  };

  it("trims, drops empty lines and strips '#' before it sends", () => {
    const c = validateBrandBook(full);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.book.toneSummary).toBe("Warm.");
      expect(c.book.contentPillars).toEqual(["One", "Two"]);
      expect(c.book.hashtagSets).toEqual([{ name: "Set", tags: ["a", "b"] }]);
      expect(c.book.channels).toEqual([{ network: "instagram", handle: "@h", url: "https://example.com/x" }, { network: "x", handle: "h2" }]);
      expect(c.book.keyDates[0]).toEqual({ date: "02-29", label: "Leap" });
    }
  });

  const refused = (over: Partial<BrandBook>) => validateBrandBook({ ...EMPTY_BRAND_BOOK, ...over });
  it("names the field of the first value outside its limit", () => {
    expect(refused({ toneSummary: "x".repeat(201) })).toMatchObject({ ok: false, field: "toneSummary" });
    expect(refused({ contentPillars: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toMatchObject({ ok: false, field: "contentPillars" });
    expect(refused({ contentPillars: ["x".repeat(61)] })).toMatchObject({ ok: false, field: "contentPillars" });
    expect(refused({ mustHaveNotes: ["x".repeat(301)] })).toMatchObject({ ok: false, field: "mustHaveNotes" });
    expect(refused({ brandRules: Array.from({ length: 31 }, (_, i) => `r${i}`) })).toMatchObject({ ok: false, field: "brandRules" });
    expect(refused({ hashtagSets: Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, tags: [] })) })).toMatchObject({ ok: false, field: "hashtagSets" });
    expect(refused({ hashtagSets: [{ name: "", tags: ["a"] }] })).toMatchObject({ ok: false, field: "hashtagSets" });
    expect(refused({ hashtagSets: [{ name: "n", tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }] })).toMatchObject({ ok: false, field: "hashtagSets" });
    expect(refused({ channels: [{ network: "", handle: "h" }] })).toMatchObject({ ok: false, field: "channels" });
    expect(refused({ channels: [{ network: "x", handle: "" }] })).toMatchObject({ ok: false, field: "channels" });
    expect(refused({ channels: [{ network: "x", handle: "h", url: "ftp://x" }] })).toMatchObject({ ok: false, field: "channels" });
    expect(refused({ keyDates: [{ date: "13-01", label: "x" }] })).toMatchObject({ ok: false, field: "keyDates" });
    expect(refused({ keyDates: [{ date: "03-03", label: "" }] })).toMatchObject({ ok: false, field: "keyDates" });
    expect(refused({ links: [{ label: "x", url: "javascript:alert(1)" }] })).toMatchObject({ ok: false, field: "links" });
    expect(refused({ links: [{ label: "", url: "https://x.test" }] })).toMatchObject({ ok: false, field: "links" });
  });

  it("key dates are MM-DD (February 29 allowed) or a real YYYY-MM-DD; links are http or https", () => {
    for (const ok of ["01-31", "02-29", "12-24", "2026-02-28", "2028-02-29"]) expect(isKeyDate(ok), ok).toBe(true);
    for (const bad of ["02-30", "00-10", "13-01", "2026-02-29", "2026-13-01", "1-1", "x"]) expect(isKeyDate(bad), bad).toBe(false);
    expect(isHttpUrl("https://example.com/a")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    for (const bad of ["ftp://example.com", "example.com", "javascript:alert(1)", ""]) expect(isHttpUrl(bad), bad).toBe(false);
  });

  it("parses typed lines and tags", () => {
    expect(parseLines(" a \r\n\n b \n")).toEqual(["a", "b"]);
    expect(parseTags("#one, two  ##three")).toEqual(["one", "two", "three"]);
  });

  it("reads the new fields, and falls back to the keys inside tone and hashtagStrategy for an older server", () => {
    const fresh = asBrandBook({ toneSummary: "S", contentPillars: ["p"], hashtagSets: [{ name: "n", tags: ["t"] }], channels: [{ network: "x", handle: "h", url: "https://x.test" }], keyDates: [{ date: "01-01", label: "NY" }], links: [{ label: "l", url: "https://l.test" }], mustHaveNotes: ["m"], brandRules: ["r"] });
    expect(fresh).toMatchObject({ toneSummary: "S", contentPillars: ["p"], hashtagSets: [{ name: "n", tags: ["t"] }], mustHaveNotes: ["m"], brandRules: ["r"] });
    const old = asBrandBook({ tone: { summary: "From tone" }, hashtagStrategy: { sets: [{ name: "k", tags: ["z"] }] } });
    expect(old.toneSummary).toBe("From tone");
    expect(old.hashtagSets).toEqual([{ name: "k", tags: ["z"] }]);
    expect(old.contentPillars).toEqual([]);
    expect(() => asBrandBook("no")).toThrow();
  });

  it("words the server's refusals", () => {
    expect(brandBookRefusalText("invalid_field", "contentPillars")).toMatch(/Content pillars is not valid/);
    expect(brandBookRefusalText("invalid_field")).toBe("A value is not valid.");
    expect(brandBookRefusalText("not authorized: cerbos denied update on social_engagement")).toMatch(/read the brand book but not change/);
    expect(brandBookRefusalText("something_new")).toBe("something_new");
  });
});
