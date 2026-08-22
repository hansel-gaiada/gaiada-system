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
  findUngroundedNumbers, parseReportNarrativeDraft, type ReportNarrativeGroundingFacts,
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

// ── numeric provenance guard ────────────────────────────────────────────────────────────────────
// The report narrative was the one AI output with NO runtime guard: the prompt told the model never
// to state an ungiven number, and nothing checked. These pin the guard that now refuses such a
// draft. Note what is deliberately NOT claimed: this cannot repair prose, only decline to ship it.

const narrativeFacts: ReportNarrativeGroundingFacts = {
  engagementName: "Acme Social",
  clientName: "Acme Coffee",
  periodLabel: "2026-07-01 – 2026-07-31",
  kpis: [
    { label: "Impressions", value: 12480, unit: "impressions" },
    { label: "Engagement rate", value: 3.7, unit: "%" },
  ],
  topPosts: [{ network: "instagram", publishedAt: "2026-07-14", impressions: 5120 }],
  knowledgeHits: [],
};

describe("findUngroundedNumbers — narrative numeric provenance", () => {
  it("accepts a narrative that states only given numbers", () => {
    const text = "Impressions reached 12480 over the period, with an engagement rate of 3.7%.";
    expect(findUngroundedNumbers(text, narrativeFacts)).toEqual([]);
  });

  it("accepts thousands separators — 12,480 traces to the KPI 12480, not to '12' and '480'", () => {
    // Without normalisation this is the guard's worst false-positive: the single most likely way a
    // model renders a large KPI would be flagged as two inventions.
    expect(findUngroundedNumbers("Impressions reached 12,480.", narrativeFacts)).toEqual([]);
  });

  it("accepts a truncated or rounded rendering of a decimal KPI (3.7 -> '3' or '4')", () => {
    expect(findUngroundedNumbers("Engagement held around 4%.", narrativeFacts)).toEqual([]);
    expect(findUngroundedNumbers("Engagement held around 3%.", narrativeFacts)).toEqual([]);
  });

  it("accepts dates from the period label and from a top post", () => {
    const text = "Across 2026-07-01 to 2026-07-31, the strongest post landed 2026-07-14.";
    expect(findUngroundedNumbers(text, narrativeFacts)).toEqual([]);
  });

  it("CATCHES an invented figure — the whole point", () => {
    const text = "Impressions reached 12480, and followers grew by 431 this period.";
    expect(findUngroundedNumbers(text, narrativeFacts)).toEqual(["431"]);
  });

  it("reports each invented figure once, in order of appearance", () => {
    const text = "We saw 900 new followers, 12480 impressions, 41 shares and 900 again.";
    expect(findUngroundedNumbers(text, narrativeFacts)).toEqual(["900", "41"]);
  });

  it("is DELIBERATELY strict: an ungrounded incidental count is rejected too", () => {
    // Documented trade-off, not an oversight. "6" is not WRONG here, but the guard cannot tell an
    // innocuous count from an invented metric, and the cost of erring the other way is a fabricated
    // figure in a client-facing report. Asserted so a future reader sees this was chosen rather than
    // missed — and so loosening it is a visible decision, not a silent drift.
    expect(findUngroundedNumbers("The top 6 posts drove most of it.", narrativeFacts)).toEqual(["6"]);
  });

  it("the decimal allowance WIDENS the grounded set — a small integer can pass incidentally", () => {
    // Found by writing the strictness test above with "3" and watching it come back clean. The
    // rounding/truncation allowance for 3.7 puts BOTH "3" and "4" in the grounded set, so an
    // incidental "the top 3 posts" is accepted while "the top 6 posts" is not. That is a real,
    // slightly arbitrary edge of this design, recorded here rather than left for someone to
    // rediscover as a phantom bug: the allowance is still worth having, because a model rendering a
    // 3.7% rate as "4%" is reporting a given fact, not inventing one.
    expect(findUngroundedNumbers("The top 3 posts drove most of it.", narrativeFacts)).toEqual([]);
    expect(findUngroundedNumbers("The top 4 posts drove most of it.", narrativeFacts)).toEqual([]);
  });
});

describe("parseReportNarrativeDraft — the guard is wired at the choke point", () => {
  it("passes a clean AI narrative through as draftedVia:'ai' with no rejectedNumbers", () => {
    const raw = JSON.stringify({ narrative: "Impressions reached 12480 this period." });
    const out = parseReportNarrativeDraft(raw, narrativeFacts);
    expect(out.draftedVia).toBe("ai");
    expect(out.text).toContain("12480");
    // ABSENT, not an empty array — see the controller's own comment on why [] would conflate
    // "checked and clean" with "not checked".
    expect(out.rejectedNumbers).toBeUndefined();
  });

  it("REJECTS a narrative with an invented number and falls back, naming what it rejected", () => {
    const raw = JSON.stringify({ narrative: "Followers grew by 431 and reach doubled." });
    const out = parseReportNarrativeDraft(raw, narrativeFacts);
    expect(out.draftedVia).toBe("fallback");
    expect(out.rejectedNumbers).toEqual(["431"]);
    // The invented figure must not survive anywhere in the shipped text.
    expect(out.text).not.toContain("431");
    // And the fallback still states the real numbers rather than going silent.
    expect(out.text).toContain("12480");
  });

  it("a gateway hiccup and a rejected draft are DISTINGUISHABLE, though both are 'fallback'", () => {
    const hiccup = parseReportNarrativeDraft(null, narrativeFacts);
    const rejected = parseReportNarrativeDraft(
      JSON.stringify({ narrative: "Followers grew by 431." }), narrativeFacts);
    expect(hiccup.draftedVia).toBe("fallback");
    expect(rejected.draftedVia).toBe("fallback");
    // The ONLY thing that separates them — which is why the controller records it.
    expect(hiccup.rejectedNumbers).toBeUndefined();
    expect(rejected.rejectedNumbers).toEqual(["431"]);
  });

  it("still never throws on malformed JSON", () => {
    expect(() => parseReportNarrativeDraft("not json at all", narrativeFacts)).not.toThrow();
    expect(parseReportNarrativeDraft("not json at all", narrativeFacts).draftedVia).toBe("fallback");
  });
});
