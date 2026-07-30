// SM-18 — pure unit tests for sem-drafts.ts: RSA draft parsing/fallback and negatives-proposal
// parsing/fallback. No DB, no HTTP, no gateway — mirrors ai-drafts.ts's own test split (this file
// only proves the prompt/parse contract; search-sem.test.ts proves the controller wiring).
import { describe, it, expect } from "vitest";
import {
  buildNegativesProposalPrompt, buildRsaDraftPrompt, MAX_RSA_DESCRIPTIONS, MAX_RSA_HEADLINES,
  parseNegativesProposal, parseRsaDraft, RSA_DESCRIPTION_MAX_CHARS, RSA_HEADLINE_MAX_CHARS,
  type RsaKeywordFact,
} from "./sem-drafts";

const kws: RsaKeywordFact[] = [
  { keyword: "running shoes", intent: "commercial" },
  { keyword: "trail running shoes", intent: "commercial" },
];

describe("RSA draft (SM-18)", () => {
  it("buildRsaDraftPrompt names the ad group, the keywords and (when present) the landing page", () => {
    const prompt = buildRsaDraftPrompt("Running Shoes", "https://example.com/shoes", kws);
    expect(prompt).toContain("Running Shoes");
    expect(prompt).toContain("running shoes [commercial]");
    expect(prompt).toContain("https://example.com/shoes");
  });

  it("parses a well-formed AI response", () => {
    const raw = JSON.stringify({
      headlines: ["Great Running Shoes", "Shop Now", "Best Prices"],
      descriptions: ["Find your perfect fit.", "Free shipping today."],
    });
    const { draft, draftedVia } = parseRsaDraft(raw, "Running Shoes", kws);
    expect(draftedVia).toBe("ai");
    expect(draft.headlines).toEqual(["Great Running Shoes", "Shop Now", "Best Prices"]);
    expect(draft.descriptions).toEqual(["Find your perfect fit.", "Free shipping today."]);
  });

  it("truncates over-length lines defensively rather than rejecting the whole draft", () => {
    const longHeadline = "H".repeat(RSA_HEADLINE_MAX_CHARS + 20);
    const longDescription = "D".repeat(RSA_DESCRIPTION_MAX_CHARS + 40);
    const raw = JSON.stringify({ headlines: [longHeadline, "b", "c"], descriptions: [longDescription, "d"] });
    const { draft, draftedVia } = parseRsaDraft(raw, "Running Shoes", kws);
    expect(draftedVia).toBe("ai");
    expect(draft.headlines[0].length).toBe(RSA_HEADLINE_MAX_CHARS);
    expect(draft.descriptions[0].length).toBe(RSA_DESCRIPTION_MAX_CHARS);
  });

  it("caps headline/description arrays at the platform maximums", () => {
    const raw = JSON.stringify({
      headlines: Array.from({ length: MAX_RSA_HEADLINES + 10 }, (_, i) => `H${i}`),
      descriptions: Array.from({ length: MAX_RSA_DESCRIPTIONS + 10 }, (_, i) => `D${i}`),
    });
    const { draft } = parseRsaDraft(raw, "Running Shoes", kws);
    expect(draft.headlines.length).toBe(MAX_RSA_HEADLINES);
    expect(draft.descriptions.length).toBe(MAX_RSA_DESCRIPTIONS);
  });

  it("falls back to a deterministic draft when the AI response is short of the platform minimums", () => {
    const raw = JSON.stringify({ headlines: ["only one"], descriptions: ["only one"] });
    const { draft, draftedVia } = parseRsaDraft(raw, "Running Shoes", kws);
    expect(draftedVia).toBe("fallback");
    expect(draft.headlines.length).toBeGreaterThanOrEqual(3);
    expect(draft.descriptions.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back on malformed JSON and on a null response (gateway threw), never throwing itself", () => {
    expect(() => parseRsaDraft("not json at all", "Running Shoes", kws)).not.toThrow();
    expect(parseRsaDraft("not json at all", "Running Shoes", kws).draftedVia).toBe("fallback");
    expect(parseRsaDraft(null, "Running Shoes", kws).draftedVia).toBe("fallback");
  });

  // Mutation probe: deleting the `headlines.length >= MIN_RSA_HEADLINES && descriptions.length >=
  // MIN_RSA_DESCRIPTIONS` gate would let a 1-headline/1-description "ad" through as draftedVia:'ai',
  // which is not a usable RSA — this test fails the moment that gate is removed.
  it("mutation probe: a below-minimum AI draft is NEVER accepted as draftedVia:'ai'", () => {
    const raw = JSON.stringify({ headlines: ["one", "two"], descriptions: ["one"] });
    const { draftedVia } = parseRsaDraft(raw, "Running Shoes", kws);
    expect(draftedVia).toBe("fallback");
  });
});

describe("negative-keyword proposal (SM-18)", () => {
  const terms = ["free shoes", "shoe repair jobs", "best running shoes"];

  it("buildNegativesProposalPrompt names the campaign and lists every submitted term", () => {
    const prompt = buildNegativesProposalPrompt("Spring Campaign", terms);
    expect(prompt).toContain("Spring Campaign");
    for (const t of terms) expect(prompt).toContain(t);
  });

  it("parses well-formed candidates and defaults an invalid matchType to 'exact'", () => {
    const raw = JSON.stringify({
      negatives: [
        { term: "free shoes", matchType: "phrase", reason: "free-seeking" },
        { term: "shoe repair jobs", matchType: "bogus-type", reason: "job-seeking" },
      ],
    });
    const { candidates, draftedVia } = parseNegativesProposal(raw, terms);
    expect(draftedVia).toBe("ai");
    expect(candidates).toEqual([
      { term: "free shoes", matchType: "phrase", reason: "free-seeking" },
      { term: "shoe repair jobs", matchType: "exact", reason: "job-seeking" },
    ]);
  });

  // Mutation probe: deleting the `known.get(termKey)` filter would let the AI insert a negative-
  // keyword row for a term this request never submitted — the exact defense-in-depth this parser
  // exists to provide (search.controller.ts enforces the same rule a second, independent time).
  it("mutation probe: drops any candidate term not in the submitted list", () => {
    const raw = JSON.stringify({
      negatives: [
        { term: "free shoes", matchType: "exact", reason: "ok" },
        { term: "a term nobody submitted", matchType: "exact", reason: "should be dropped" },
      ],
    });
    const { candidates } = parseNegativesProposal(raw, terms);
    expect(candidates.map((c) => c.term)).toEqual(["free shoes"]);
  });

  it("is case-insensitive when matching a candidate term back to the submitted list, but returns the CANONICAL casing", () => {
    const raw = JSON.stringify({ negatives: [{ term: "FREE SHOES", matchType: "exact", reason: "x" }] });
    const { candidates } = parseNegativesProposal(raw, terms);
    expect(candidates).toEqual([{ term: "free shoes", matchType: "exact", reason: "x" }]);
  });

  it("dedupes a term the AI repeated", () => {
    const raw = JSON.stringify({
      negatives: [
        { term: "free shoes", matchType: "exact", reason: "a" },
        { term: "free shoes", matchType: "phrase", reason: "b" },
      ],
    });
    const { candidates } = parseNegativesProposal(raw, terms);
    expect(candidates.length).toBe(1);
  });

  // The deliberate honesty rule: fallback is EMPTY, never a fabricated rule-based judgment.
  it("falls back to an EMPTY candidate list on malformed JSON, a null response, or no usable candidates", () => {
    expect(parseNegativesProposal("not json", terms)).toEqual({ candidates: [], draftedVia: "fallback" });
    expect(parseNegativesProposal(null, terms)).toEqual({ candidates: [], draftedVia: "fallback" });
    expect(parseNegativesProposal(JSON.stringify({ negatives: [] }), terms)).toEqual({ candidates: [], draftedVia: "fallback" });
  });
});
