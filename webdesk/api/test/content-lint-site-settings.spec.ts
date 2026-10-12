// M5-W3c — per-site settings for the advisory content checks (composition `lint.content`, vocabulary 1.3.0).
// Pure unit tests, no database. What is pinned:
//   1. the composition validator CLOSES the new member (unknown rule ids / knobs and out-of-range values are
//      refused at the write, never ignored);
//   2. an absent member or key = today's constants, and gaiada.com's results are BYTE-IDENTICAL through both paths;
//   3. the settings really change what the rules say, and no setting can make the lint throw (advisory only);
//   4. save and item.get resolve the SAME settings (both go through computeContentLint; W3b's read == save invariant).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { CONTENT_RULES } from "../src/control/content/lint-rules/rules";
import { DEFAULT_CONTENT_RULES, computeContentLint, lintContent, resolveContentRulesFromComposition, type ContentLintInput } from "../src/control/content/content-lint";
import {
  CONTENT_LINT_RULE_IDS,
  validateCollectionComposition,
  validateTenantComposition,
  type CollectionComposition,
} from "../src/delivery/vocabulary/composition";

const words = (n: number, w = "word"): string => Array.from({ length: n }, () => w).join(" ");

const FIELDS = [
  { name: "h1", primitive: "text" },
  { name: "primary_keyword", primitive: "text" },
  { name: "image_alt_texts", primitive: "text", multiple: true },
  { name: "body", primitive: "markdown" },
];
const baseComposition = (lintContentSettings?: unknown): CollectionComposition =>
  ({ fields: FIELDS, ...(lintContentSettings === undefined ? {} : { lint: { content: lintContentSettings } }) }) as CollectionComposition;

/** A body that passes every rule at the default config (same shape as content-lint-rules.spec.ts). */
function goodBody(): string {
  const links = Array.from({ length: 20 }, (_, i) => `[page ${i}](/services/page-${i}/)`).join(" ");
  return [
    "# SEO Agency Bali", "", `seo agency bali ${words(46)}.`, "",
    "## What does an SEO agency Bali team do?", "", `${words(75)}. ${links}`, "",
    "## How do we measure results?", "", `${words(75)}. Rankings rose 40% in 6 months ([source](https://example.org/study)).`, "",
    "- one", "- two", "", "## Frequently asked questions", "", `${words(75)}.`, "",
    "![A Bali SEO team reviewing a report](/img/a.jpg)",
  ].join("\n");
}

type Over = { body?: string; seo?: Record<string, unknown>; locale?: string; groupLocales?: string[] | null };
function input(composition: CollectionComposition, over: Over = {}): ContentLintInput {
  return {
    blocks: [{ type: "fields", props: { h1: "SEO Agency Bali", primary_keyword: "seo agency bali", image_alt_texts: ["SEO agency Bali team"], body: over.body ?? goodBody() } }],
    seo: over.seo ?? { title: "SEO Agency Bali | Gaia Digital Agency", description: `SEO agency Bali for hotels and villas: ${"x".repeat(100)}` },
    composition,
    locale: over.locale ?? "en",
    groupLocales: over.groupLocales === undefined ? ["en", "id"] : over.groupLocales,
  };
}

/** The fixtures: the passing page plus one page per finding family. */
const FIXTURES: Array<[string, Over]> = [
  ["passing page", {}],
  ["long title, long description", { seo: { title: "x".repeat(70), description: "y".repeat(170) } }],
  ["short description", { seo: { title: "Short", description: "too short" } }],
  ["no seo at all", { seo: {} }],
  ["no internal links", { body: goodBody().replace(/\[page \d+\]\([^)]*\)/g, "page") }],
  ["a statistic with no source", { body: goodBody().replace(/\(\[source\]\([^)]*\)\)/, "") }],
  ["banned words", { body: `${goodBody()}\n\nWe leverage a seamless, robust stack!` }],
  ["no ID twin", { groupLocales: ["en"] }],
  ["twin group unreadable", { groupLocales: null }],
  ["an Indonesian page, EN twin missing", { locale: "id", groupLocales: ["id"] }],
  ["short body (not long-form)", { body: "# T\n\nshort." }],
];

describe("W3c: the composition validator closes lint.content", () => {
  const ok = (content: unknown) => validateCollectionComposition("c", { fields: FIELDS, lint: { content } });
  const issues = (content: unknown) => ok(content).issues.map((i) => i.path);

  it("accepts every documented setting, and the empty object", () => {
    expect(ok({}).valid).toBe(true);
    expect(
      ok({
        enabled: true, longFormMinWords: 500, h1Field: "h1", primaryKeywordField: "primary_keyword", altFields: ["image_alt_texts"],
        rules: {
          h1: { enabled: false }, "image-alt": { enabled: true }, sources: { enabled: false }, "primary-keyword": { enabled: false },
          meta: { enabled: true, titleMax: 70, descriptionMin: 100, descriptionMax: 160 },
          "internal-links": { min: 5 },
          "id-twin": { twin: { en: ["id", "ms"], id: ["en"] } },
          "answer-first": { minWords: 30, maxWords: 80 },
          "question-headings": { minShare: 0.5, starters: ["what", "how"] },
          "banned-language": { phrases: { en: ["leverage"], id: ["unggulan"] } },
          aeo: { enabled: false, shortParagraphMaxWords: 60 },
        },
      }).issues,
    ).toEqual([]);
  });

  it("lists exactly the rule ids the runner knows (plus the aeo score)", () => {
    const runnerIds = [...CONTENT_RULES_IDS()];
    expect([...CONTENT_LINT_RULE_IDS].sort()).toEqual([...runnerIds, "aeo"].sort());
  });

  it("refuses unknown keys at every level, by path", () => {
    expect(issues({ nope: 1 })).toEqual(["c.lint.content.nope"]);
    expect(issues({ rules: { "no-such-rule": {} } })).toEqual(["c.lint.content.rules.no-such-rule"]);
    expect(issues({ rules: { meta: { titleMin: 3 } } })).toEqual(["c.lint.content.rules.meta.titleMin"]);
    expect(issues({ rules: { h1: { titleMax: 3 } } })).toEqual(["c.lint.content.rules.h1.titleMax"]);
    expect(validateCollectionComposition("c", { lint: { content: {}, other: 1 } }).issues.map((i) => i.path)).toEqual(["c.lint.other"]);
  });

  it("refuses out-of-range and wrong-typed values", () => {
    const bad: Array<[unknown, string]> = [
      [{ enabled: "yes" }, "c.lint.content.enabled"],
      [{ longFormMinWords: 0 }, "c.lint.content.longFormMinWords"],
      [{ longFormMinWords: 100001 }, "c.lint.content.longFormMinWords"],
      [{ longFormMinWords: 3.5 }, "c.lint.content.longFormMinWords"],
      [{ h1Field: "has space" }, "c.lint.content.h1Field"],
      [{ primaryKeywordField: "" }, "c.lint.content.primaryKeywordField"],
      [{ altFields: "alt" }, "c.lint.content.altFields"],
      [{ altFields: ["ok", "not ok"] }, "c.lint.content.altFields[1]"],
      [{ rules: [] }, "c.lint.content.rules"],
      [{ rules: { meta: "x" } }, "c.lint.content.rules.meta"],
      [{ rules: { meta: { enabled: 1 } } }, "c.lint.content.rules.meta.enabled"],
      [{ rules: { meta: { titleMax: 0 } } }, "c.lint.content.rules.meta.titleMax"],
      [{ rules: { meta: { titleMax: 1001 } } }, "c.lint.content.rules.meta.titleMax"],
      [{ rules: { meta: { descriptionMin: -1 } } }, "c.lint.content.rules.meta.descriptionMin"],
      [{ rules: { meta: { descriptionMax: "155" } } }, "c.lint.content.rules.meta.descriptionMax"],
      [{ rules: { "internal-links": { min: 10001 } } }, "c.lint.content.rules.internal-links.min"],
      [{ rules: { "internal-links": { min: -1 } } }, "c.lint.content.rules.internal-links.min"],
      [{ rules: { "answer-first": { minWords: 1001 } } }, "c.lint.content.rules.answer-first.minWords"],
      [{ rules: { "question-headings": { minShare: 1.5 } } }, "c.lint.content.rules.question-headings.minShare"],
      [{ rules: { "question-headings": { minShare: -0.1 } } }, "c.lint.content.rules.question-headings.minShare"],
      [{ rules: { "question-headings": { starters: [""] } } }, "c.lint.content.rules.question-headings.starters[0]"],
      [{ rules: { "question-headings": { starters: Array.from({ length: 201 }, () => "a") } } }, "c.lint.content.rules.question-headings.starters"],
      [{ rules: { "id-twin": { twin: { english: ["id"] } } } }, "c.lint.content.rules.id-twin.twin.english"],
      [{ rules: { "id-twin": { twin: { en: ["not a lang"] } } } }, "c.lint.content.rules.id-twin.twin.en[0]"],
      [{ rules: { "banned-language": { phrases: { en: [1] } } } }, "c.lint.content.rules.banned-language.phrases.en[0]"],
      [{ rules: { aeo: { shortParagraphMaxWords: 0 } } }, "c.lint.content.rules.aeo.shortParagraphMaxWords"],
    ];
    for (const [content, at] of bad) expect(issues(content), JSON.stringify(content)).toContain(at);
  });

  it("refuses an inverted min/max pair with one issue", () => {
    expect(issues({ rules: { meta: { descriptionMin: 200, descriptionMax: 100 } } })).toEqual(["c.lint.content.rules.meta.descriptionMin"]);
    expect(issues({ rules: { "answer-first": { minWords: 90, maxWords: 10 } } })).toEqual(["c.lint.content.rules.answer-first.minWords"]);
    expect(ok({ rules: { meta: { descriptionMin: 100, descriptionMax: 100 } } }).valid).toBe(true);
  });

  it("is refused by the whole-tenant validator too (the schema.apply path)", () => {
    expect(validateTenantComposition({ page: { fields: FIELDS, lint: { content: { rules: { meta: { titleMax: 0 } } } } } }).valid).toBe(false);
    expect(validateTenantComposition({ page: { fields: FIELDS, lint: { content: { rules: { meta: { titleMax: 70 } } } } } }, { vocabularyVersion: "1.2.0" }).valid).toBe(true);
  });
});

const CONTENT_RULES_IDS = (): string[] => CONTENT_RULES.map((r) => r.id);

describe("W3c: absent member / absent key = today's constants, byte-identical", () => {
  const equivalents: Array<[string, CollectionComposition]> = [
    ["no lint.content at all", baseComposition()],
    ["lint.content: {}", baseComposition({})],
    ["rules: {}", baseComposition({ rules: {} })],
    ["rules with only `enabled: true`", baseComposition({ rules: { meta: { enabled: true }, aeo: { enabled: true } } })],
    [
      "every knob set to today's constant",
      baseComposition({
        enabled: true, longFormMinWords: 300, h1Field: "h1", primaryKeywordField: "primary_keyword", altFields: ["image_alt_texts"],
        rules: {
          meta: { titleMax: 60, descriptionMin: 120, descriptionMax: 155 },
          "internal-links": { min: 20 },
          "id-twin": { twin: { en: ["id"], id: ["en"] } },
          "answer-first": { minWords: 40, maxWords: 60 },
          "question-headings": { minShare: 0.3, starters: DEFAULT_CONTENT_RULES.questionStarters },
          "banned-language": { phrases: { en: DEFAULT_CONTENT_RULES.bannedPhrases.en } },
          aeo: { shortParagraphMaxWords: 80 },
        },
      }),
    ],
  ];

  it("an absent member resolves to DEFAULT_CONTENT_RULES itself", () => {
    expect(resolveContentRulesFromComposition(undefined)).toBe(DEFAULT_CONTENT_RULES);
    expect(resolveContentRulesFromComposition(baseComposition())).toBe(DEFAULT_CONTENT_RULES);
    expect(resolveContentRulesFromComposition({ lint: {} })).toBe(DEFAULT_CONTENT_RULES);
  });

  it("every equivalent spelling resolves to a config deep-equal to the defaults", () => {
    for (const [name, comp] of equivalents) expect(resolveContentRulesFromComposition(comp), name).toEqual(DEFAULT_CONTENT_RULES);
  });

  it("the existing fixtures give byte-identical reports through the default path and the composition path", () => {
    let nonEmpty = 0;
    for (const [fixtureName, over] of FIXTURES) {
      const viaDefault = JSON.stringify(lintContent(input(baseComposition(), over), DEFAULT_CONTENT_RULES));
      for (const [name, comp] of equivalents) {
        const viaComposition = JSON.stringify(lintContent(input(comp, over), resolveContentRulesFromComposition(comp)));
        expect(viaComposition, `${fixtureName} / ${name}`).toBe(viaDefault);
      }
      if (JSON.parse(viaDefault).findings.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(8); // the comparison is not vacuous: most fixtures produce findings
  });
});

describe("W3c: the settings change what the rules say, and stay advisory", () => {
  const run = (settings: unknown, over: Over = {}) => {
    const comp = baseComposition(settings);
    return lintContent(input(comp, over), resolveContentRulesFromComposition(comp));
  };
  const codes = (settings: unknown, over: Over = {}): string[] => run(settings, over).findings.map((f) => f.code);

  it("meta thresholds: a longer title limit and a different description window", () => {
    const seo = { title: "x".repeat(70), description: "y".repeat(170) };
    expect(codes(undefined, { seo })).toEqual(expect.arrayContaining(["meta.title.too-long", "meta.description.too-long"]));
    expect(codes({ rules: { meta: { titleMax: 80, descriptionMax: 200 } } }, { seo })).not.toEqual(expect.arrayContaining(["meta.title.too-long"]));
    expect(codes({ rules: { meta: { titleMax: 80, descriptionMax: 200 } } }, { seo })).not.toContain("meta.description.too-long");
    expect(codes({ rules: { meta: { descriptionMin: 0 } } }, { seo: { title: "Short", description: "tiny" } })).not.toContain("meta.description.too-short");
    expect(codes(undefined, { seo: { title: "Short", description: "tiny" } })).toContain("meta.description.too-short");
  });

  it("internal-links.min, answer-first window and question share move their findings", () => {
    const noLinks = goodBody().replace(/\[page \d+\]\([^)]*\)/g, "page");
    expect(codes(undefined, { body: noLinks })).toContain("links.internal.few");
    expect(codes({ rules: { "internal-links": { min: 0 } } }, { body: noLinks })).not.toContain("links.internal.few");
    expect(codes({ rules: { "answer-first": { minWords: 60, maxWords: 80 } } })).toContain("answer-first.length");
    expect(codes(undefined)).not.toContain("answer-first.length");
    expect(codes({ rules: { "question-headings": { minShare: 1 } } })).toContain("headings.question-share");
  });

  it("longFormMinWords: a bigger threshold turns the structural checks off for a mid-size body", () => {
    expect(codes(undefined, { body: noAnswerBody() })).toContain("answer-first.length");
    expect(codes({ longFormMinWords: 5000 }, { body: noAnswerBody() })).not.toContain("answer-first.length");
  });

  it("id-twin.twin and banned-language.phrases replace the default maps", () => {
    expect(codes(undefined, { groupLocales: ["en"] })).toContain("twin.missing.id");
    expect(codes({ rules: { "id-twin": { twin: {} } } }, { groupLocales: ["en"] })).not.toContain("twin.missing.id");
    expect(codes({ rules: { "id-twin": { twin: { en: ["ms"] } } } }, { groupLocales: ["en", "id"] })).toContain("twin.missing.ms");
    const body = `${goodBody()}\n\nWe leverage things.`;
    expect(codes(undefined, { body })).toContain("language.banned-phrase");
    expect(codes({ rules: { "banned-language": { phrases: { en: ["unrelated"] } } } }, { body })).not.toContain("language.banned-phrase");
  });

  it("a rule switched off reports nothing and is NOT listed as unavailable", () => {
    const seo = {};
    const off = run({ rules: { meta: { enabled: false } } }, { seo });
    expect(off.findings.some((f) => f.code.startsWith("meta."))).toBe(false);
    expect(off.unavailable).toEqual([]);
    expect(run(undefined, { seo }).findings.some((f) => f.code.startsWith("meta."))).toBe(true);
    for (const id of CONTENT_RULES_IDS()) expect(() => run({ rules: { [id]: { enabled: false } } }), id).not.toThrow();
  });

  it("aeo off = no score (null), no `unavailable`; aeo.shortParagraphMaxWords moves the factor", () => {
    const off = run({ rules: { aeo: { enabled: false } } });
    expect(off.aeo).toBeNull();
    expect(off.unavailable).toEqual([]);
    const defaultShort = run(undefined).aeo!.factors.find((f) => f.id === "short-paragraphs")!;
    const strict = run({ rules: { aeo: { shortParagraphMaxWords: 5 } } }).aeo!.factors.find((f) => f.id === "short-paragraphs")!;
    expect(strict.points).toBeLessThan(defaultShort.points);
  });

  it("h1Field / primaryKeywordField / altFields point the rules at the site's own field names", () => {
    const comp = baseComposition({ primaryKeywordField: "focus_term" });
    const i = input(comp);
    (i.blocks as Array<{ props: Record<string, unknown> }>)[0].props.focus_term = "zebra crossing";
    const r = lintContent(i, resolveContentRulesFromComposition(comp));
    expect(r.findings.find((f) => f.code === "keyword.placement")?.message).toContain("zebra crossing");
  });

  it("an INVALID stored setting (only a hand-edited row can hold one) falls back to the defaults and never throws", () => {
    const bad = baseComposition({ rules: { meta: { titleMax: -5 } }, junk: true });
    expect(resolveContentRulesFromComposition(bad)).toBe(DEFAULT_CONTENT_RULES);
    expect(resolveContentRulesFromComposition({ lint: { content: "nope" } })).toBe(DEFAULT_CONTENT_RULES);
    expect(resolveContentRulesFromComposition({ lint: { content: null } })).toBe(DEFAULT_CONTENT_RULES);
  });

  it("advisory: the most extreme valid settings still return a report (nothing here can fail a save)", () => {
    const extreme = {
      longFormMinWords: 1, rules: {
        meta: { titleMax: 1, descriptionMin: 1000, descriptionMax: 1000 }, "internal-links": { min: 10000 },
        "answer-first": { minWords: 1000, maxWords: 1000 }, "question-headings": { minShare: 1 }, aeo: { shortParagraphMaxWords: 1 },
      },
    };
    expect(validateCollectionComposition("c", { fields: FIELDS, lint: { content: extreme } }).valid).toBe(true);
    const r = run(extreme);
    expect(Array.isArray(r.findings)).toBe(true);
    expect(r.findings.every((f) => f.severity === "info" || f.severity === "warn")).toBe(true);
  });
});

/** A ~100-word body with an H1, so it is long-form only when longFormMinWords is below its size. */
function noAnswerBody(): string {
  return `# Title\n\n${words(20)}.\n\n## Section\n\n${words(380)}.`;
}

describe("W3c: save and item.get resolve the same settings (W3b's read == save invariant)", () => {
  /** A PoolClient that answers the one query computeContentLint makes (the localization group). */
  const fakeClient = (locales: string[]): PoolClient => ({ query: async (sql: string) => (/^\s*SELECT locale/i.test(sql) ? { rows: locales.map((locale) => ({ locale })) } : { rows: [] }) }) as unknown as PoolClient;
  const compute = (settings: unknown, over: Over = {}) => {
    const i = input(baseComposition(settings), over);
    return computeContentLint(fakeClient(["en", "id"]), "site", "group", { blocks: i.blocks, seo: i.seo, composition: i.composition as CollectionComposition, locale: i.locale });
  };

  it("honours the composition's settings, and the same inputs give the same report (the save call and the get call)", async () => {
    const settings = { rules: { meta: { enabled: false }, aeo: { enabled: false }, "internal-links": { min: 0 } } };
    const seo = {};
    const saved = await compute(settings, { seo });
    const read = await compute(settings, { seo });
    expect(read).toEqual(saved);
    expect(saved!.findings.some((f) => f.code.startsWith("meta."))).toBe(false);
    expect(saved!.aeo).toBeNull();
    expect((await compute(undefined, { seo }))!.findings.some((f) => f.code.startsWith("meta."))).toBe(true);
  });

  it("the master switch: enabled:false = no `content` member at all", async () => {
    expect(await compute({ enabled: false })).toBeUndefined();
    expect(await compute({ enabled: true })).toBeDefined();
  });

  it("byte-identical to the pre-W3c behaviour when the composition has no lint.content", async () => {
    for (const [name, over] of FIXTURES) {
      const i = input(baseComposition(), over);
      const expected = lintContent({ ...i, groupLocales: over.groupLocales === undefined ? ["en", "id"] : over.groupLocales }, DEFAULT_CONTENT_RULES);
      const got = await computeContentLint(fakeClient(over.groupLocales === undefined || over.groupLocales === null ? ["en", "id"] : over.groupLocales), "s", "g", { blocks: i.blocks, seo: i.seo, composition: i.composition as CollectionComposition, locale: i.locale });
      if (over.groupLocales === null) continue; // the fake client cannot fail the group read; covered in content-lint-rules.spec.ts
      expect(JSON.stringify(got), name).toBe(JSON.stringify(expected));
    }
  });

  it("every call site goes through the one resolution: save, item.get and the sign-off snapshot", () => {
    const src = (p: string): string => fs.readFileSync(path.join(__dirname, "..", "src", "control", p), "utf8");
    const save = src("content/content-commands.service.ts");
    const get = src("content/content-reads.service.ts");
    const sign = src("editorial/editorial-commands.service.ts");
    expect(save).toMatch(/computeContentLint\(client, ctx\.siteId, groupId, \{ blocks, seo, composition, locale \}\)/);
    expect(get).toMatch(/computeContentLint\(c, siteId, groupId, \{ blocks, seo, composition: rawComposition as CollectionComposition, locale \}\)/);
    for (const s of [save, get]) expect(s).not.toMatch(/DEFAULT_CONTENT_RULES|lintContent\(/);
    expect(sign).toMatch(/resolveContentRulesFromComposition\(/);
    expect(sign).not.toMatch(/DEFAULT_CONTENT_RULES/);
  });
});
