// M5-W3 — the advisory editorial content checks (src/control/content/lint-rules). Pure unit tests: no
// database. Per rule: a pass case, a fail case, and a degraded case (a rule that cannot run is listed
// in `unavailable`, never reported as a clean list).
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_RULES, lintContent, resolveContentRules, type ContentLintInput } from "../src/control/content/content-lint";
import { CONTENT_RULES } from "../src/control/content/lint-rules/rules";
import { parseMarkdown } from "../src/control/content/lint-rules/markdown";

const words = (n: number, w = "word"): string => Array.from({ length: n }, () => w).join(" ");
const answer = (): string => `seo agency bali ${words(46)}.`; // 49 words, inside 40-60

const composition = {
  fields: [
    { name: "h1", primitive: "text" },
    { name: "primary_keyword", primitive: "text" },
    { name: "image_alt_texts", primitive: "text", multiple: true },
    { name: "body", primitive: "markdown" },
  ],
} as ContentLintInput["composition"];

/** A body that passes every rule at the default config. */
function goodBody(): string {
  const links = Array.from({ length: 20 }, (_, i) => `[page ${i}](/services/page-${i}/)`).join(" ");
  return [
    "# SEO Agency Bali",
    "",
    answer(),
    "",
    "## What does an SEO agency Bali team do?",
    "",
    `${words(75)}. ${links}`,
    "",
    "## How do we measure results?",
    "",
    `${words(75)}. Rankings rose 40% in 6 months ([source](https://example.org/study)).`,
    "",
    "- one",
    "- two",
    "",
    "## Frequently asked questions",
    "",
    `${words(75)}.`,
    "",
    "![A Bali SEO team reviewing a report](/img/a.jpg)",
  ].join("\n");
}

function input(over: Partial<{ body: string; seo: Record<string, unknown>; props: Record<string, unknown>; locale: string; groupLocales: string[] | null }> = {}): ContentLintInput {
  return {
    blocks: [{ type: "fields", props: { h1: "SEO Agency Bali", primary_keyword: "seo agency bali", image_alt_texts: ["SEO agency Bali team"], body: over.body ?? goodBody(), ...(over.props ?? {}) } }],
    seo: over.seo ?? { title: "SEO Agency Bali | Gaia Digital Agency", description: `SEO agency Bali for hotels and villas: ${"x".repeat(100)}` },
    composition,
    locale: over.locale ?? "en",
    groupLocales: over.groupLocales === undefined ? ["en", "id"] : over.groupLocales,
  };
}

const codes = (i: ContentLintInput, cfg = DEFAULT_CONTENT_RULES): string[] => lintContent(i, cfg).findings.map((f) => f.code);

describe("content lint: the passing page", () => {
  it("raises nothing and degrades nothing", () => {
    const r = lintContent(input());
    expect(r.findings).toEqual([]);
    expect(r.unavailable).toEqual([]);
    expect(r.aeo).not.toBeNull();
  });
});

describe("h1", () => {
  it("fail: two H1 headings; missing H1 without a field", () => {
    expect(codes(input({ body: `${goodBody()}\n\n# Another H1` }))).toContain("h1.multiple");
    const noH1 = goodBody().replace("# SEO Agency Bali\n", "");
    expect(codes(input({ body: noH1, props: { h1: "" } }))).toContain("h1.missing");
  });
  it("pass: no body H1 but the H1 field is filled", () => {
    const c = codes(input({ body: goodBody().replace("# SEO Agency Bali\n", "") }));
    expect(c).not.toContain("h1.missing");
  });
  it("degraded: a throwing rule is listed as unavailable", () => {
    const boom = [{ id: "h1", run: () => { throw new Error("boom"); } }];
    expect(lintContent(input(), DEFAULT_CONTENT_RULES, boom).unavailable).toEqual([{ rule: "h1", reason: "boom" }]);
  });
});

describe("meta lengths", () => {
  it("fail: title over 60, description over 155 and under 120, both missing", () => {
    expect(codes(input({ seo: { title: "x".repeat(61), description: "x".repeat(156) } }))).toEqual(expect.arrayContaining(["meta.title.too-long", "meta.description.too-long"]));
    expect(codes(input({ seo: { title: "ok", description: "x".repeat(50) } }))).toContain("meta.description.too-short");
    expect(codes(input({ seo: {} }))).toEqual(expect.arrayContaining(["meta.title.missing", "meta.description.missing"]));
  });
  it("pass: boundaries are inclusive (60, 120, 155)", () => {
    expect(codes(input({ seo: { title: "x".repeat(60), description: "x".repeat(120) } })).filter((c) => c.startsWith("meta."))).toEqual([]);
    expect(codes(input({ seo: { title: "x", description: "x".repeat(155) } })).filter((c) => c.startsWith("meta."))).toEqual([]);
  });
  it("skips an item that is not a page (no body, no seo)", () => {
    const r = lintContent({ blocks: [], seo: {}, composition: {}, locale: "en", groupLocales: [] });
    expect(r.findings.filter((f) => f.code.startsWith("meta."))).toEqual([]);
  });
  it("is configurable: a tenant's own limits replace the gaiada defaults", () => {
    const cfg = resolveContentRules({ metaTitleMax: 80 });
    expect(codes(input({ seo: { title: "x".repeat(70), description: "x".repeat(130) } }), cfg)).not.toContain("meta.title.too-long");
  });
  it("degraded: a throwing rule is unavailable", () => {
    const r = lintContent(input(), DEFAULT_CONTENT_RULES, CONTENT_RULES.map((x) => (x.id === "meta" ? { id: "meta", run: () => { throw new Error("nope"); } } : x)));
    expect(r.unavailable.map((u) => u.rule)).toEqual(["meta"]);
  });
});

describe("image alt text", () => {
  it("fail: a markdown image with empty alt; an empty alt field", () => {
    expect(codes(input({ body: `${goodBody()}\n\n![](/img/b.jpg)` }))).toContain("images.alt.missing");
    expect(codes(input({ props: { image_alt_texts: [] } }))).toContain("images.alt.field-empty");
  });
  it("pass: described images and a filled alt field", () => {
    expect(codes(input()).filter((c) => c.startsWith("images."))).toEqual([]);
  });
  it("degraded: a throwing rule is unavailable", () => {
    const r = lintContent(input(), DEFAULT_CONTENT_RULES, [{ id: "image-alt", run: () => { throw new Error("x"); } }]);
    expect(r.unavailable[0].rule).toBe("image-alt");
  });
});

describe("sources", () => {
  const stat = `${words(75)}. Conversion rose 40% last year.`;
  it("fail: a percentage with no source", () => {
    const body = ["# T", "", answer(), "", "## Results", "", stat, "", `${words(300)}.`].join("\n");
    expect(codes(input({ body }))).toContain("sources.missing");
  });
  it("pass: the same statistic with an external link, or a Sources heading", () => {
    const linked = ["# T", "", answer(), "", "## Results", "", `${stat} [Study](https://example.org/x)`, "", `${words(300)}.`].join("\n");
    expect(codes(input({ body: linked }))).not.toContain("sources.missing");
    const listed = ["# T", "", answer(), "", "## Results", "", stat, "", `${words(300)}.`, "", "## Sources", "", "- a"].join("\n");
    expect(codes(input({ body: listed }))).not.toContain("sources.missing");
  });
  it("degraded: a throwing rule is unavailable", () => {
    expect(lintContent(input(), DEFAULT_CONTENT_RULES, [{ id: "sources", run: () => { throw new Error("x"); } }]).unavailable[0].rule).toBe("sources");
  });
});

describe("internal links", () => {
  it("fail: fewer than the configured minimum (info)", () => {
    const r = lintContent(input({ body: goodBody().replace(/\[page \d+\]\([^)]*\)/g, "page") }));
    const f = r.findings.find((x) => x.code === "links.internal.few");
    expect(f?.severity).toBe("info");
  });
  it("pass: 20 internal links; and a tenant minimum of 2", () => {
    expect(codes(input())).not.toContain("links.internal.few");
    expect(codes(input({ body: goodBody().replace(/\[page (\d+)\]\([^)]*\)/g, (m, n) => (Number(n) < 2 ? m : "page")) }), resolveContentRules({ minInternalLinks: 2 }))).not.toContain("links.internal.few");
  });
  it("external links do not count", () => {
    const body = goodBody().replace(/\(\/services\/page-/g, "(https://other.example/page-");
    expect(codes(input({ body }))).toContain("links.internal.few");
  });
});

describe("ID twin", () => {
  it("fail: an en item with no id sibling is a warn; an id item with no en sibling is info", () => {
    const en = lintContent(input({ groupLocales: ["en"] })).findings.find((f) => f.code === "twin.missing.id");
    expect(en?.severity).toBe("warn");
    const id = lintContent(input({ locale: "id", groupLocales: ["id"] })).findings.find((f) => f.code === "twin.missing.en");
    expect(id?.severity).toBe("info");
  });
  it("pass: both present, region subtags are folded (en-GB, id-ID)", () => {
    expect(codes(input({ locale: "en-GB", groupLocales: ["en-GB", "id-ID"] })).filter((c) => c.startsWith("twin."))).toEqual([]);
  });
  it("does not apply to a non-localized collection or an unconfigured locale", () => {
    expect(codes({ ...input({ groupLocales: ["en"] }), composition: { ...composition, localized: false } }).filter((c) => c.startsWith("twin."))).toEqual([]);
    expect(codes(input({ locale: "fr", groupLocales: ["fr"] })).filter((c) => c.startsWith("twin."))).toEqual([]);
  });
  it("degraded: an unreadable group is unavailable, not 'no twin' and not clean", () => {
    const r = lintContent(input({ groupLocales: null }));
    expect(r.unavailable).toEqual([{ rule: "id-twin", reason: "the localization group could not be read" }]);
    expect(r.findings.some((f) => f.code.startsWith("twin."))).toBe(false);
  });
});

describe("answer-first, question headings, keyword, language", () => {
  it("answer-first fails outside 40-60 words, passes inside", () => {
    expect(codes(input({ body: goodBody().replace(answer(), `${words(10)}.`) }))).toContain("answer-first.length");
    expect(codes(input())).not.toContain("answer-first.length");
  });
  it("question headings: under 30% is info", () => {
    const body = goodBody().replace("What does an SEO agency Bali team do?", "Our services").replace("How do we measure results?", "Our results").replace("Frequently asked questions", "Details");
    expect(codes(input({ body }))).toContain("headings.question-share");
  });
  it("primary keyword missing from the meta title is reported", () => {
    const r = lintContent(input({ seo: { title: "Gaia Digital Agency", description: "x".repeat(130) } }));
    expect(r.findings.find((f) => f.code === "keyword.placement")?.message).toMatch(/meta title/);
  });
  it("banned phrases and exclamation marks (English only)", () => {
    const body = `${goodBody()}\n\nWe leverage a seamless approach!`;
    expect(codes(input({ body }))).toEqual(expect.arrayContaining(["language.banned-phrase", "language.exclamation"]));
    expect(codes(input({ body, locale: "id", groupLocales: ["id", "en"] }))).not.toContain("language.banned-phrase");
  });
  it("code fences are not prose", () => {
    const body = `${goodBody()}\n\n\`\`\`\nseamless!\n\`\`\``;
    expect(codes(input({ body }))).not.toContain("language.banned-phrase");
  });
});

describe("AEO extractability score", () => {
  it("the passing page scores high and lists every factor with points that sum to the score", () => {
    const { aeo } = lintContent(input());
    expect(aeo).not.toBeNull();
    expect(aeo!.factors.map((f) => f.id)).toEqual(["answer-first", "questions", "faq", "short-paragraphs", "structure", "citations"]);
    expect(aeo!.factors.reduce((s, f) => s + f.max, 0)).toBe(100);
    expect(aeo!.score).toBe(Math.round(aeo!.factors.reduce((s, f) => s + f.points, 0)));
    expect(aeo!.score).toBeGreaterThanOrEqual(90);
  });
  it("a bare wall of text scores low", () => {
    const body = `# T\n\n${words(400)}.`;
    const { aeo } = lintContent(input({ body }));
    expect(aeo!.score).toBeLessThan(40);
  });
  it("is null (not 0) when there is no long-form body", () => {
    const r = lintContent(input({ body: "# T\n\nshort." }));
    expect(r.aeo).toBeNull();
    expect(r.unavailable).toEqual([]);
  });
  it("degraded: a body that cannot be read makes every rule and the score unavailable", () => {
    const bad = { ...input(), blocks: new Proxy([], { get() { throw new Error("unreadable"); } }) } as ContentLintInput;
    const r = lintContent(bad);
    expect(r.findings).toEqual([]);
    expect(r.unavailable.map((u) => u.rule)).toContain("aeo");
    expect(r.unavailable.length).toBe(CONTENT_RULES.length + 1);
  });
});

describe("config and the markdown reader", () => {
  it("resolveContentRules ignores bad members and never throws", () => {
    const c = resolveContentRules({ metaTitleMax: -5, metaDescriptionMin: 200, metaDescriptionMax: 100, altFields: [1], enabled: "yes" });
    expect(c).toEqual(DEFAULT_CONTENT_RULES);
    expect(resolveContentRules(null)).toBe(DEFAULT_CONTENT_RULES);
  });
  it("the gaiada values are the documented defaults", () => {
    expect([DEFAULT_CONTENT_RULES.metaTitleMax, DEFAULT_CONTENT_RULES.metaDescriptionMin, DEFAULT_CONTENT_RULES.metaDescriptionMax]).toEqual([60, 120, 155]);
  });
  it("parseMarkdown finds headings, links, lists and the answer paragraph", () => {
    const d = parseMarkdown("# H\n\nlead para here.\n\n## Q?\n\n- a\n- b\n\n[x](/y) ![alt](/i.png)\n");
    expect(d.headings.map((h) => h.level)).toEqual([1, 2]);
    expect(d.paragraphs[d.answerParagraph].text).toBe("lead para here.");
    expect(d.lists).toBe(1);
    expect(d.links.map((l) => l.image)).toEqual([false, true]);
  });
});
