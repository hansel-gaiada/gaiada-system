// SMM-19 — pure prompt/parse unit tests. No DB, no network, no Cerbos (mirrors media-rules.test.ts
// and search/ai-drafts.test.ts). The load-bearing claims here: hashtags are ALWAYS re-derived
// through applyHashtagStrategy (the AI's own count/content is advisory input, never the final
// answer), the network's own cap (media-rules.ts) is reused rather than duplicated, and every
// parse* function is fail-soft — malformed/empty/absent AI output never throws and never blocks a
// draft from persisting.
import { describe, it, expect } from "vitest";
import {
  applyHashtagStrategy, buildCaptionPrompt, parseCaptionDraft, buildIdeaPrompt, parseIdeaDraft,
  MAX_IDEA_COUNT, type CaptionGroundingFacts, type IdeaGroundingFacts, type HashtagStrategy,
  buildTriagePrompt, parseTriageDraft, type TriageGroundingFacts,
} from "./ai-drafts";
import { maxHashtagsFor } from "./media-rules";

const baseCaptionFacts: CaptionGroundingFacts = {
  network: "instagram",
  engagementName: "Acme Coffee",
  postBrief: "Announce the new seasonal blend",
  existingBody: "",
  tone: { voice: "warm", bannedWords: ["cheap"] },
  hashtagStrategy: {},
  knowledgeHits: [],
};

describe("applyHashtagStrategy — the ONE enforcement point (SMM-19)", () => {
  it("caps at the network's own limit from media-rules.ts, never a second table", () => {
    const proposed = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    const out = applyHashtagStrategy(proposed, "instagram", {});
    expect(out.length).toBe(maxHashtagsFor("instagram"));
  });

  it("tightens further when the brand strategy asks for fewer than the network allows", () => {
    const proposed = ["coffee", "morning", "latte", "roast", "beans"];
    const out = applyHashtagStrategy(proposed, "instagram", { maxCount: 2 });
    expect(out.length).toBe(2);
    expect(out).toEqual(["coffee", "morning"]);
  });

  it("a strategy asking for MORE than the network's cap still stops at the network's cap", () => {
    const proposed = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const out = applyHashtagStrategy(proposed, "x", { maxCount: 999 }); // x has no maxHashtags in media-rules
    expect(maxHashtagsFor("x")).toBeUndefined();
    expect(out.length).toBe(10); // uncapped by network, still bounded by what was proposed
  });

  it("never posts a banned tag, even if the model proposes it", () => {
    const out = applyHashtagStrategy(["coffee", "SALE", "sale", "morning"], "instagram", { bannedTags: ["sale"] });
    expect(out.map((t) => t.toLowerCase())).not.toContain("sale");
    expect(out).toContain("coffee");
  });

  it("required tags are always included (subject to the ban list) even if the model omits them", () => {
    const out = applyHashtagStrategy(["morning"], "instagram", { requiredTags: ["#AcmeCoffee"] });
    expect(out).toContain("AcmeCoffee"); // sanitized: leading # stripped
  });

  it("a tag that is both required AND banned is never posted — banned wins", () => {
    const out = applyHashtagStrategy([], "instagram", { requiredTags: ["forbidden"], bannedTags: ["forbidden"] });
    expect(out).not.toContain("forbidden");
  });

  it("dedupes case-insensitively", () => {
    const out = applyHashtagStrategy(["Coffee", "coffee", "COFFEE"], "instagram", {});
    expect(out).toEqual(["Coffee"]);
  });

  it("sanitizes stray punctuation and leading #s from the model's output", () => {
    const out = applyHashtagStrategy(["##coffee!", "morning-vibes"], "instagram", {});
    expect(out).toContain("coffee");
    expect(out).toContain("morningvibes");
  });
});

describe("buildCaptionPrompt / parseCaptionDraft (SMM-19)", () => {
  it("grounds the prompt in the brief, tone and knowledge hits", () => {
    const facts: CaptionGroundingFacts = {
      ...baseCaptionFacts,
      knowledgeHits: [{ sourceRef: "social-brand:t:c", text: "we never discount, we reward loyalty" }],
    };
    const prompt = buildCaptionPrompt(facts);
    expect(prompt).toContain("seasonal blend");
    expect(prompt).toContain("warm");
    expect(prompt).toContain("we never discount");
    // D-17: the prompt itself must never invite an image request — there is no backend for one.
    expect(prompt.toLowerCase()).toContain("no image-generation capability");
  });

  it("parses a strict-JSON caption + hashtags and applies the hashtag strategy", () => {
    const raw = JSON.stringify({ body: "Meet our new seasonal blend.", hashtags: ["coffee", "coffee", "morning"] });
    const { draft, draftedVia } = parseCaptionDraft(raw, baseCaptionFacts);
    expect(draftedVia).toBe("ai");
    expect(draft.hashtags).toEqual(["coffee", "morning"]); // deduped
    expect(draft.body).toContain("Meet our new seasonal blend");
    expect(draft.body).toContain("#coffee");
    expect(draft.firstComment).toBeNull(); // no placement strategy -> body
  });

  it("routes hashtags to firstComment when the strategy asks and the network supports it", () => {
    const strategy: HashtagStrategy = { placement: "first_comment" };
    const raw = JSON.stringify({ body: "Meet our new blend.", hashtags: ["coffee"] });
    const { draft } = parseCaptionDraft(raw, { ...baseCaptionFacts, hashtagStrategy: strategy });
    expect(draft.firstComment).toBe("#coffee");
    expect(draft.body).not.toContain("#coffee");
  });

  it("falls back to 'body' placement on a network with no first-comment surface, even if asked", () => {
    const strategy: HashtagStrategy = { placement: "first_comment" };
    const raw = JSON.stringify({ body: "Short update.", hashtags: ["deal"] });
    const { draft } = parseCaptionDraft(raw, { ...baseCaptionFacts, network: "x", hashtagStrategy: strategy });
    expect(draft.firstComment).toBeNull();
    expect(draft.body).toContain("#deal");
  });

  it("tolerates surrounding prose around the JSON object", () => {
    const raw = `Sure, here you go:\n${JSON.stringify({ body: "Prose-wrapped caption.", hashtags: [] })}\nHope that helps!`;
    const { draft, draftedVia } = parseCaptionDraft(raw, baseCaptionFacts);
    expect(draftedVia).toBe("ai");
    expect(draft.body).toBe("Prose-wrapped caption.");
  });

  it("NEVER throws on malformed JSON, and falls back to a deterministic draft", () => {
    expect(() => parseCaptionDraft("not json at all", baseCaptionFacts)).not.toThrow();
    const { draft, draftedVia } = parseCaptionDraft("not json at all", baseCaptionFacts);
    expect(draftedVia).toBe("fallback");
    expect(draft.body.length).toBeGreaterThan(0); // never an empty draft
  });

  it("NEVER throws on a null completion (gateway unreachable) and falls back", () => {
    expect(() => parseCaptionDraft(null, baseCaptionFacts)).not.toThrow();
    expect(parseCaptionDraft(null, baseCaptionFacts).draftedVia).toBe("fallback");
  });

  it("a required tag still lands in the fallback draft, not only the AI path", () => {
    const facts: CaptionGroundingFacts = { ...baseCaptionFacts, hashtagStrategy: { requiredTags: ["AcmeCoffee"] } };
    const { draft, draftedVia } = parseCaptionDraft(null, facts);
    expect(draftedVia).toBe("fallback");
    expect(draft.hashtags).toContain("AcmeCoffee");
  });
});

describe("buildIdeaPrompt / parseIdeaDraft (SMM-19)", () => {
  const baseIdeaFacts: IdeaGroundingFacts = {
    engagementName: "Acme Coffee",
    campaignGoal: "Spring launch",
    recentPosts: [{ title: "Winter blend recap", brief: "how the winter blend performed" }],
    knowledgeHits: [],
    count: 3,
  };

  it("grounds the idea prompt in the campaign goal and recent posts, and forbids image requests", () => {
    const prompt = buildIdeaPrompt(baseIdeaFacts);
    expect(prompt).toContain("Spring launch");
    expect(prompt).toContain("Winter blend recap");
    expect(prompt.toLowerCase()).toContain("no image-generation capability");
  });

  it("parses ideas and caps at the CALLER's count, never the AI's own count", () => {
    const raw = JSON.stringify({
      ideas: Array.from({ length: 8 }, (_, i) => ({ title: `Idea ${i}`, brief: `brief ${i}` })),
    });
    const { ideas, draftedVia } = parseIdeaDraft(raw, { ...baseIdeaFacts, count: 3 });
    expect(draftedVia).toBe("ai");
    expect(ideas).toHaveLength(3);
  });

  it("never returns more than MAX_IDEA_COUNT even if count itself were somehow larger", () => {
    const raw = JSON.stringify({ ideas: Array.from({ length: 20 }, (_, i) => ({ title: `Idea ${i}`, brief: "b" })) });
    const { ideas } = parseIdeaDraft(raw, { ...baseIdeaFacts, count: 999 });
    expect(ideas.length).toBeLessThanOrEqual(MAX_IDEA_COUNT);
  });

  it("drops ideas with an empty title", () => {
    const raw = JSON.stringify({ ideas: [{ title: "", brief: "no title" }, { title: "Good one", brief: "b" }] });
    const { ideas } = parseIdeaDraft(raw, { ...baseIdeaFacts, count: 3 });
    expect(ideas.map((i) => i.title)).toEqual(["Good one"]);
  });

  it("NEVER throws and falls back to deterministic placeholder ideas", () => {
    expect(() => parseIdeaDraft("garbage", baseIdeaFacts)).not.toThrow();
    const { ideas, draftedVia } = parseIdeaDraft("garbage", baseIdeaFacts);
    expect(draftedVia).toBe("fallback");
    expect(ideas).toHaveLength(3);
    expect(ideas.every((i) => i.title.length > 0)).toBe(true);
  });

  it("NEVER throws on a null completion and falls back", () => {
    expect(() => parseIdeaDraft(null, baseIdeaFacts)).not.toThrow();
    expect(parseIdeaDraft(null, baseIdeaFacts).draftedVia).toBe("fallback");
  });
});

// ── Inbox triage (SMM-16) ────────────────────────────────────────────────────────────────────────
const baseTriageFacts: TriageGroundingFacts = {
  network: "linkedin",
  engagementName: "Acme Coffee",
  messages: [
    { authorHandle: "@commenter", body: "love the new blend!", postedAt: "2026-08-20T10:00:00.000Z" },
  ],
};

describe("buildTriagePrompt / parseTriageDraft (SMM-16)", () => {
  it("the prompt includes every message's own body and author, and only THIS thread's own facts", () => {
    const prompt = buildTriagePrompt(baseTriageFacts);
    expect(prompt).toContain("love the new blend!");
    expect(prompt).toContain("@commenter");
    expect(prompt).toContain("linkedin");
  });

  it("parses a well-formed classification into all three axes", () => {
    const raw = JSON.stringify({ sentiment: "positive", category: "praise", urgency: "low" });
    const { result, draftedVia } = parseTriageDraft(raw);
    expect(draftedVia).toBe("ai");
    expect(result).toEqual({ sentiment: "positive", category: "praise", urgency: "low" });
  });

  it("is case-insensitive and tolerates surrounding prose", () => {
    const raw = `Here you go:\n${JSON.stringify({ sentiment: "NEGATIVE", category: "Complaint", urgency: "High" })}\nHope that helps.`;
    const { result } = parseTriageDraft(raw);
    expect(result).toEqual({ sentiment: "negative", category: "complaint", urgency: "high" });
  });

  // ── NEVER a guessed value — the ticket's own named discipline ────────────────────────────────
  it("NEVER throws, and returns result:null (never a guessed value) on malformed JSON", () => {
    expect(() => parseTriageDraft("not json at all")).not.toThrow();
    expect(parseTriageDraft("not json at all")).toEqual({ result: null, draftedVia: "unavailable" });
  });

  it("returns result:null on a null completion (gateway unreachable/unconfigured)", () => {
    expect(parseTriageDraft(null)).toEqual({ result: null, draftedVia: "unavailable" });
  });

  it("returns result:null on an out-of-vocabulary value — never silently coerced to a valid one", () => {
    const raw = JSON.stringify({ sentiment: "furious", category: "praise", urgency: "low" });
    expect(parseTriageDraft(raw)).toEqual({ result: null, draftedVia: "unavailable" });
  });

  it("returns result:null when any one of the three axes is missing entirely", () => {
    const raw = JSON.stringify({ sentiment: "positive", category: "praise" }); // no urgency
    expect(parseTriageDraft(raw)).toEqual({ result: null, draftedVia: "unavailable" });
  });
});
