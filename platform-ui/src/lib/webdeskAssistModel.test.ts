import { describe, expect, it } from "vitest";
import service from "../../e2e/webdesk-stub/compositions/service.json";
import type { FieldDef } from "./webdeskContentModel";
import {
  applyOptions, applySuggestion, assistFailureCopy, copyTextOf, fieldKeyOfPointer, putAltOnImage, resetsIn,
  type ApplyCtx, type AssistFailure, type AssistSuggestion,
} from "./webdeskAssistModel";

const DEFS = (service as unknown as { fields: FieldDef[] }).fields;

const ctx = (over: Partial<ApplyCtx> = {}, fields: Record<string, unknown> = { h1: "SEO", body: "# SEO\n" }, seo: Record<string, unknown> = {}): ApplyCtx => ({
  defs: DEFS, draft: { fields, seo }, locale: "en", defaultLocale: "en", seoCarrier: false, localeNeutralCollection: false, ...over,
});

const META: AssistSuggestion = { id: "s1", kind: "meta_description", target: "/seo/description", text: "A description of the page.", length: 26 };
const OUTLINE: AssistSuggestion = { id: "s1", kind: "outline", headings: [{ level: 2, text: "Intro" }, { level: 3, text: "Why" }], markdown: "## Intro\n\n### Why" };
const FAQ: AssistSuggestion = { id: "s1", kind: "faq", question: "What is it?", answer: "It is a thing that does stuff for you." };
const TRANSLATE: AssistSuggestion = { id: "s1", kind: "translate_draft", sourcePath: "/blocks/0/props/h1", field: "h1", locale: "id", text: "Agen SEO", notice: "First draft — needs a human" };
const ALT: AssistSuggestion = { id: "s1", kind: "alt_text", target: "/blocks/0/props/body", index: 0, imageRef: "/img/team-photo.jpg", alt: "The team at their desks" };

describe("assistFailureCopy: every typed failure in plain words", () => {
  const all: AssistFailure[] = [
    { kind: "not_applicable", reason: "no_text" }, { kind: "not_applicable", reason: "not_enough_text" }, { kind: "not_applicable", reason: "source_not_english" },
    { kind: "not_applicable", reason: "no_image_without_alt" }, { kind: "not_applicable", reason: null }, { kind: "not_applicable", reason: "something_new" },
    { kind: "budget", retryAfterSeconds: 7200 }, { kind: "budget", retryAfterSeconds: null },
    { kind: "unavailable", reason: "gateway_busy" }, { kind: "unavailable", reason: null }, { kind: "invalid_output" }, { kind: "deleted" }, { kind: "forbidden" },
    { kind: "not_found" }, { kind: "bad_request", message: "Missing site." }, { kind: "session" }, { kind: "unreachable" }, { kind: "drift", reason: "assist.kind: expected string, got number" },
  ];

  it("never shows a slug, a status code or a raw token", () => {
    for (const f of all) {
      const t = assistFailureCopy(f);
      expect(t.length).toBeGreaterThan(20);
      expect(t).not.toMatch(/assist-|not_applicable|no_text|gateway_|\b[45]\d\d\b|undefined|null|\[object/);
    }
  });

  it("budget says when it resets; unavailable is the agreed sentence", () => {
    expect(assistFailureCopy({ kind: "budget", retryAfterSeconds: 7200 })).toBe("You have used today's AI suggestions. The allowance resets at 00:00 UTC (in about 2 hours). Nothing was changed.");
    expect(assistFailureCopy({ kind: "budget", retryAfterSeconds: null })).toContain("resets at 00:00 UTC.");
    expect(assistFailureCopy({ kind: "unavailable", reason: "not_configured" })).toMatch(/^The writing assistant is not available right now\./);
  });

  it("each 422 reason has its own sentence", () => {
    const seen = new Set(["no_text", "not_enough_text", "source_not_english", "no_image_without_alt"].map((r) => assistFailureCopy({ kind: "not_applicable", reason: r })));
    expect(seen.size).toBe(4);
  });
});

describe("resetsIn", () => {
  it("speaks in minutes and hours, never seconds", () => {
    expect(resetsIn(30)).toBe("in about a minute");
    expect(resetsIn(40 * 60)).toBe("in about 40 minutes");
    expect(resetsIn(3600)).toBe("in about 1 hour");
    expect(resetsIn(5 * 3600)).toBe("in about 5 hours");
    expect(resetsIn(null)).toBeNull();
    expect(resetsIn(-1)).toBeNull();
    expect(resetsIn(Number.NaN)).toBeNull();
  });
});

describe("fieldKeyOfPointer", () => {
  it("reads the editor's own field and nothing else", () => {
    expect(fieldKeyOfPointer("/blocks/0/props/body")).toBe("body");
    expect(fieldKeyOfPointer("/blocks/0/props/a~1b")).toBe("a/b");
    expect(fieldKeyOfPointer("/blocks/1/props/body")).toBeNull();
    expect(fieldKeyOfPointer("/blocks/0/props/faq/2/answer")).toBeNull();
    expect(fieldKeyOfPointer("/seo/description")).toBeNull();
  });
});

describe("meta description", () => {
  it("applies to the SEO description and touches nothing else (a pure function: the draft in is not mutated)", () => {
    const c = ctx();
    const before = JSON.stringify(c.draft);
    const out = applySuggestion(META, "seo.description", c);
    expect(out).toEqual({ ok: true, draft: { fields: c.draft.fields, seo: { description: "A description of the page." } } });
    expect(JSON.stringify(c.draft)).toBe(before);
  });
  it("a system collection with no description control: Copy only, and says why", () => {
    const o = applyOptions(META, ctx({ seoCarrier: true }));
    expect(o.targets).toEqual([]);
    expect(o.why).toMatch(/no search description field/);
    expect(applySuggestion(META, "seo.description", ctx({ seoCarrier: true })).ok).toBe(false);
  });
});

describe("outline and faq", () => {
  it("an outline goes at the end of a markdown field, after a blank line", () => {
    const o = applyOptions(OUTLINE, ctx());
    expect(o.targets).toEqual([{ key: "append:body", label: "Add to the end of Body" }]);
    const out = applySuggestion(OUTLINE, "append:body", ctx());
    expect(out).toMatchObject({ ok: true, draft: { fields: { body: "# SEO\n\n## Intro\n\n### Why" } } });
  });
  it("an outline into an empty field is just the outline", () => {
    const out = applySuggestion(OUTLINE, "append:body", ctx({}, { body: "" }));
    expect(out).toMatchObject({ ok: true, draft: { fields: { body: "## Intro\n\n### Why" } } });
  });
  it("an FAQ goes into the field as a bold question and its answer", () => {
    const out = applySuggestion(FAQ, "append:body", ctx());
    expect(out).toMatchObject({ ok: true, draft: { fields: { body: "# SEO\n\n**What is it?**\n\nIt is a thing that does stuff for you." } } });
  });
  it("an FAQ goes in as a ROW when the form has a question/answer list; the editor chooses", () => {
    const withList: FieldDef[] = [...DEFS, { name: "faq", primitive: "group", multiple: true, fields: [{ name: "question", primitive: "text", required: true }, { name: "answer", primitive: "markdown", required: true }] }];
    const c = ctx({ defs: withList }, { body: "x", faq: [{ question: "Old?", answer: "Yes." }] });
    const keys = applyOptions(FAQ, c).targets.map((t) => t.key);
    expect(keys).toEqual(["row:faq", "append:body"]);
    const out = applySuggestion(FAQ, "row:faq", c);
    expect(out).toMatchObject({ ok: true, draft: { fields: { faq: [{ question: "Old?", answer: "Yes." }, { question: "What is it?", answer: "It is a thing that does stuff for you." }] } } });
  });
  it("a list with another REQUIRED member is not offered (the new row would be invalid)", () => {
    const odd: FieldDef[] = [{ name: "faq", primitive: "group", multiple: true, fields: [{ name: "question", primitive: "text" }, { name: "answer", primitive: "text" }, { name: "topic", primitive: "text", required: true }] }];
    expect(applyOptions(FAQ, ctx({ defs: odd })).targets).toEqual([]);
  });
  it("no text field at all: Copy only", () => {
    const o = applyOptions(OUTLINE, ctx({ defs: DEFS.filter((d) => d.primitive !== "markdown") }));
    expect(o.targets).toEqual([]);
    expect(o.why).toBeTruthy();
  });
  it("a locale-neutral markdown field is not a target on a non-default locale", () => {
    const neutral: FieldDef[] = [{ name: "body", primitive: "markdown", localized: false }];
    expect(applyOptions(OUTLINE, ctx({ defs: neutral, locale: "id" })).targets).toEqual([]);
    expect(applyOptions(OUTLINE, ctx({ defs: neutral, locale: "en" })).targets).toHaveLength(1);
  });
  it("a key the options do not list is refused, never guessed", () => {
    expect(applySuggestion(OUTLINE, "append:h1", ctx()).ok).toBe(false);
  });
});

describe("translated first draft", () => {
  it("from an English item the editor has no Indonesian target: Copy only, with the reason", () => {
    const o = applyOptions(TRANSLATE, ctx({ locale: "en" }));
    expect(o.targets).toEqual([]);
    expect(o.why).toMatch(/separate item/);
    expect(o.why).toMatch(/ID version/);
    expect(applySuggestion(TRANSLATE, "set:h1", ctx({ locale: "en" })).ok).toBe(false);
  });
  it("applies only when the editor IS on that locale and has the field", () => {
    const c = ctx({ locale: "id" }, { h1: "" });
    expect(applyOptions(TRANSLATE, c).targets).toEqual([{ key: "set:h1", label: "Replace H1" }]);
    expect(applySuggestion(TRANSLATE, "set:h1", c)).toMatchObject({ ok: true, draft: { fields: { h1: "Agen SEO" } } });
  });
  it("a field the editor does not have is Copy only", () => {
    expect(applyOptions({ ...TRANSLATE, field: "nope" }, ctx({ locale: "id" })).targets).toEqual([]);
  });
});

describe("alt text", () => {
  const body = "Intro\n\n![](/img/team-photo.jpg)\n\nand ![kept](/img/other.png) and ![](/img/team-photo.jpg \"Title\")\n";
  it("puts the alt on the first image with no alt and that address, keeping the rest of the text byte for byte", () => {
    const out = applySuggestion(ALT, "alt:body", ctx({}, { body }));
    expect(out).toMatchObject({ ok: true });
    expect((out as unknown as { draft: { fields: { body: string } } }).draft.fields.body).toBe(
      "Intro\n\n![The team at their desks](/img/team-photo.jpg)\n\nand ![kept](/img/other.png) and ![](/img/team-photo.jpg \"Title\")\n",
    );
  });
  it("two suggestions for the same address land on successive images", () => {
    const first = applySuggestion(ALT, "alt:body", ctx({}, { body })) as unknown as { draft: { fields: { body: string } } };
    const second = applySuggestion({ ...ALT, id: "s2", alt: "A second view" }, "alt:body", ctx({}, first.draft.fields));
    expect((second as unknown as { draft: { fields: { body: string } } }).draft.fields.body).toContain('![A second view](/img/team-photo.jpg "Title")');
  });
  it("an image that already has alt (or is gone) is a refusal in words, not a silent no-op", () => {
    const out = applySuggestion(ALT, "alt:body", ctx({}, { body: "![has alt](/img/team-photo.jpg)" }));
    expect(out).toEqual({ ok: false, message: expect.stringMatching(/already has alt text, or is no longer in the text/) });
  });
  it("alt text with brackets cannot break out of the image syntax", () => {
    expect(putAltOnImage("![](/a.png)", "/a.png", "see [this] one")).toBe("![see \\[this\\] one](/a.png)");
  });
  it("an image in a block the form does not edit is Copy only", () => {
    const o = applyOptions({ ...ALT, target: "/blocks/2/props/body" }, ctx());
    expect(o.targets).toEqual([]);
    expect(o.why).toMatch(/does not edit/);
  });
  it("a read-only field is Copy only", () => {
    const ro: FieldDef[] = [{ name: "body", primitive: "markdown", ui: { readOnly: true } }];
    expect(applyOptions(ALT, ctx({ defs: ro })).targets).toEqual([]);
  });
});

describe("copyTextOf", () => {
  it("copies the thing a person would paste", () => {
    expect(copyTextOf(META)).toBe("A description of the page.");
    expect(copyTextOf(OUTLINE)).toBe("## Intro\n\n### Why");
    expect(copyTextOf(FAQ)).toBe("What is it?\n\nIt is a thing that does stuff for you.");
    expect(copyTextOf(TRANSLATE)).toBe("Agen SEO");
    expect(copyTextOf(ALT)).toBe("The team at their desks");
  });
});
