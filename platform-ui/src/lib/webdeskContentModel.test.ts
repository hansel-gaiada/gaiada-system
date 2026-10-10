import { describe, it, expect } from "vitest";
import service from "../../e2e/webdesk-stub/compositions/service.json";
import navigation from "../../e2e/webdesk-stub/compositions/navigation.json";
import tokenRegistry from "../../e2e/webdesk-stub/compositions/token-registry.json";
import company from "../../e2e/webdesk-stub/compositions/company.json";
import {
  authorLabel, defaultFields, deepEqual, describeReasonToken, diffContent, fieldLabel, fieldPointer, groupCollections,
  hasNeutralDescendant, hasPendingChanges, humanize, isLive, isNeutral, issuesAt, issuesUnder, moveItem, overlayNeutrals,
  parseInline, parseMarkdown, parseWebdeskPublishArgs, phaseOf, pointerSegment, publishStateLabel, splitVersionContent,
  toWire, writeNeutralsThrough,
  type CollectionComposition, type CollectionSummary, type EditableContent, type FieldDef,
} from "./webdeskContentModel";

// The real gaiada.com compositions (copied read-only from the site repo's scripts/webdesk/compositions/):
// every shape the editor must render is exercised here on the genuine article, not a toy.
const SERVICE = service as unknown as CollectionComposition;
const NAV = navigation as unknown as CollectionComposition;
const TOKENS = tokenRegistry as unknown as CollectionComposition;
const COMPANY = company as unknown as CollectionComposition;
const defs = (c: CollectionComposition) => c.fields as FieldDef[];

describe("pointers (§2.2 ItemIssue.path)", () => {
  it("builds /blocks/0/props/… pointers and escapes ~ and /", () => {
    expect(fieldPointer("faq", 2, "answer")).toBe("/blocks/0/props/faq/2/answer");
    expect(pointerSegment("a/b~c")).toBe("a~1b~0c");
    expect(fieldPointer("a/b")).toBe("/blocks/0/props/a~1b");
  });
  it("finds issues at, and under, a pointer", () => {
    const issues = [
      { path: "/blocks/0/props/plan/why", message: "x" },
      { path: "/blocks/0/props/plan", message: "y" },
      { path: "/blocks/0/props/planet", message: "z" },
    ];
    expect(issuesAt(issues, "/blocks/0/props/plan").map((i) => i.message)).toEqual(["y"]);
    // `planet` is NOT under `plan`: a prefix match must respect the segment boundary
    expect(issuesUnder(issues, "/blocks/0/props/plan").map((i) => i.message)).toEqual(["x", "y"]);
  });
});

describe("splitVersionContent", () => {
  it("takes the fields from blocks[0] and keeps later vocabulary blocks verbatim", () => {
    const r = splitVersionContent("service", [{ type: "fields", props: { h1: "A" } }, { type: "hero", props: { t: 1 } }], { title: "T" });
    expect(r.fields).toEqual({ h1: "A" });
    expect(r.extraBlocks).toEqual([{ type: "hero", props: { t: 1 } }]);
    expect(r.seo).toEqual({ title: "T" });
  });
  it("treats a missing fields block as empty fields, never as the first vocabulary block", () => {
    const r = splitVersionContent("service", [{ type: "hero", props: {} }], {});
    expect(r.fields).toEqual({});
    expect(r.extraBlocks).toHaveLength(1);
  });
  it("§2.7: the `redirect` system collection carries its fields under seo.redirect", () => {
    const r = splitVersionContent("redirect", [], { redirect: { toPath: "/x/", status: "301" }, title: "keep" });
    expect(r.fields).toEqual({ toPath: "/x/", status: "301" });
    expect(r.seo).toEqual({ title: "keep" }); // the carrier key is not part of the editable seo
  });
});

describe("defaults for a NEW item (the real service composition)", () => {
  const f = defaultFields(defs(SERVICE));
  it("starts required text empty-but-present and required booleans false", () => {
    expect(f.url).toBe("");
    expect(f.source_path).toBe("");
    expect(f.body).toBe("");
    expect(f.publish_ready).toBe(false);
  });
  it("leaves optional scalars ABSENT (never invents a value) and optional lists empty", () => {
    expect("h1" in f).toBe(false);
    expect("author" in f).toBe(false);
    expect(f.schema).toEqual([]);
    expect(f.image_alt_texts).toEqual([]);
  });
  it("starts required selects absent so the author must choose, and a required group as an object", () => {
    expect("template" in f).toBe(false);
    expect("phase" in f).toBe(false);
    expect(f.plan).toEqual({});
  });
});

describe("deepEqual / toWire / moveItem", () => {
  it("treats undefined and absent as the same thing (the wire drops undefined)", () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual([{ k: 1 }], [{ k: 1 }])).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
  });
  it("toWire drops undefined members", () => {
    expect(toWire({ a: 1, b: undefined, c: [undefined] })).toEqual({ a: 1, c: [null] });
  });
  it("moveItem is pure and bounds-safe", () => {
    const a = ["x", "y", "z"];
    expect(moveItem(a, 0, 2)).toEqual(["y", "z", "x"]);
    expect(a).toEqual(["x", "y", "z"]);
    expect(moveItem(a, 0, 9)).toEqual(a);
    expect(moveItem(a, 1, 1)).toEqual(a);
  });
});

describe("locale neutrality (§2.5 rule 2) on the real navigation composition", () => {
  const nav = defs(NAV);
  it("finds neutral members anywhere below a field", () => {
    const primary = nav.find((d) => d.name === "primary") as FieldDef;
    expect(hasNeutralDescendant(primary)).toBe(true); // url + children are localized:false
    expect(isNeutral(primary)).toBe(false);
    expect(hasNeutralDescendant(nav.find((d) => d.name === "cta") as FieldDef)).toBe(true);
    expect(isNeutral(nav.find((d) => d.name === "footer_extra") as FieldDef)).toBe(true);
    expect(hasNeutralDescendant((primary.fields as FieldDef[]).find((d) => d.name === "label") as FieldDef)).toBe(false);
  });

  const en = {
    primary: [
      { url: "/services/", label: "Services", children: ["/a/", "/b/"] },
      { url: "/work/", label: "Work", children: [] },
    ],
    cta: { label: "Audit", url: "/free-audit/" },
    footer_extra: ["/privacy/"],
  };
  const id = {
    primary: [
      { url: "/work/", label: "Karya", children: ["/stale/"] }, // reordered relative to en: order is per locale
      { url: "/services/", label: "Layanan", children: ["/stale/"] },
    ],
    cta: { label: "Audit ID", url: "/stale-cta/" },
    footer_extra: ["/stale/"],
  };

  it("writes the default locale's neutral values through, matching list rows by itemKey and keeping localized text", () => {
    const out = writeNeutralsThrough(nav, id, en) as typeof id;
    expect(out.primary.map((r) => r.label)).toEqual(["Karya", "Layanan"]); // id's order and copy kept
    expect(out.primary[0].children).toEqual([]); // matched /work/ -> en's children
    expect(out.primary[1].children).toEqual(["/a/", "/b/"]); // matched /services/
    expect(out.cta).toEqual({ label: "Audit ID", url: "/free-audit/" }); // nested group: only the neutral member
    expect(out.footer_extra).toEqual(["/privacy/"]);
  });
  it("leaves an unmatched row exactly as typed (it cannot be matched safely) and does not mutate its input", () => {
    const before = JSON.stringify(id);
    const orphan = { ...id, primary: [{ url: "/new/", label: "Baru", children: ["/x/"] }] };
    const out = writeNeutralsThrough(nav, orphan, en) as typeof id;
    expect(out.primary[0]).toEqual({ url: "/new/", label: "Baru", children: ["/x/"] });
    expect(JSON.stringify(id)).toBe(before);
  });
  it("with no authoritative copy it returns the local value untouched", () => {
    expect(writeNeutralsThrough(nav, id, null)).toBe(id);
  });
  it("overlayNeutrals is the same mapping, used for what the id form DISPLAYS", () => {
    expect((overlayNeutrals(nav, id, en) as typeof id).footer_extra).toEqual(["/privacy/"]);
  });
  it("company (a locale-neutral collection) declares no per-field neutrality — the collection is the unit", () => {
    expect(COMPANY.localized).toBe(false);
    expect(defs(COMPANY).some(hasNeutralDescendant)).toBe(false);
  });
});

describe("collections grouping (§10)", () => {
  const mk = (key: string, c: CollectionComposition): CollectionSummary => ({
    key, composition: c, vocabularyVersion: "1.1.0", updatedAt: "2026-10-10T00:00:00Z",
    counts: { items: 1, byLocale: { en: 1 }, live: 0, pendingChanges: 0 },
  });
  it("orders groups Pages before Globals, and collections by ui.order inside a group", () => {
    const groups = groupCollections([
      mk("company", COMPANY), mk("service", SERVICE), mk("navigation", NAV), mk("token-registry", TOKENS),
      mk("loose", { fields: [] }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(["Pages", "Globals", "Other"]);
    expect(groups[1].collections.map((c) => c.key)).toEqual(["company", "navigation", "token-registry"]); // ui.order 1,2,3
  });
  it("falls back to a humanised key when a composition has no label", () => {
    expect(humanize("token-registry")).toBe("Token registry");
    expect(fieldLabel({ name: "source_path", primitive: "text" })).toBe("Source path");
    expect(fieldLabel({ name: "x", primitive: "text", ui: { label: "Custom" } })).toBe("Custom");
  });
});

describe("state vocabulary", () => {
  it("only claims 'live' for a published, non-deleted item with a published version", () => {
    const base = { publishedVersion: 2, publishState: "published", deletedAt: null };
    expect(isLive(base)).toBe(true);
    expect(isLive({ ...base, deletedAt: "2026-10-10" })).toBe(false);
    expect(isLive({ ...base, publishedVersion: null })).toBe(false);
    expect(isLive({ ...base, publishState: "unpublished" })).toBe(false);
  });
  it("pending changes = never published, or head differs from published", () => {
    expect(hasPendingChanges({ headVersion: 3, publishedVersion: 2 })).toBe(true);
    expect(hasPendingChanges({ headVersion: 3, publishedVersion: 3 })).toBe(false);
    expect(hasPendingChanges({ headVersion: 1, publishedVersion: null })).toBe(true);
  });
  it("renders a state this UI has never seen verbatim instead of coercing it", () => {
    expect(publishStateLabel("draft")).toBe("Draft");
    expect(publishStateLabel("under_review")).toBe("Under review");
  });
  it("labels an author by name, else a short id, never blank", () => {
    expect(authorLabel("u-1", { "u-1": "Dewi" })).toBe("Dewi");
    expect(authorLabel("3f2a9c10-aaaa", {})).toBe("user 3f2a9c10");
    expect(authorLabel(null, {})).toBe("unknown author");
  });
});

describe("approval phase (§10: pending · rejected/failed · published)", () => {
  const row = (over: Partial<Parameters<typeof phaseOf>[0]>) => ({ id: "ap-1", status: "pending" as const, executionStatus: null, executionError: null, decidedByName: null, decidedBy: null, ...over });
  it.each([
    [{ status: "pending" }, "pending"],
    [{ status: "rejected", decidedByName: "Dewi" }, "rejected"],
    [{ status: "approved", executionStatus: "executed", decidedByName: "Dewi" }, "executed"],
    [{ status: "approved", executionStatus: "failed", executionError: "version-conflict" }, "failed"],
    [{ status: "approved", executionStatus: "executing" }, "approved_publishing"],
    [{ status: "approved", executionStatus: "pending" }, "approved_publishing"],
    // a row from a deployment that omits the column is UNKNOWN, not "executed" (CLAUDE.md: missing reads as null)
    [{ status: "approved", executionStatus: null }, "approved_publishing"],
    [{ status: "approved", executionStatus: "not_applicable" }, "approved_publishing"],
  ] as const)("%j -> %s", (over, phase) => {
    expect(phaseOf(row(over as never)).phase).toBe(phase);
  });
  it("carries the approver's name, falling back to the opaque id", () => {
    expect(phaseOf(row({ status: "rejected", decidedBy: "u-9" }))).toMatchObject({ decidedByName: "u-9" });
  });
  it("turns reason tokens into plain words, and shows an unknown token verbatim", () => {
    expect(describeReasonToken("version-conflict")).toMatch(/newer version/);
    expect(describeReasonToken("failed: version-conflict")).toMatch(/newer version/);
    expect(describeReasonToken("something-new")).toBe("Reason: something-new");
    expect(describeReasonToken(null)).toBe("No reason was recorded.");
  });
});

describe("parseWebdeskPublishArgs — tool_args are never trusted (§6)", () => {
  const ok = { tenantSlug: "gaiada", siteId: "s1", items: [{ itemId: "i1", version: 3, contentHash: "abc" }], rebuild: "staging" };
  it("parses the §6 shape", () => {
    expect(parseWebdeskPublishArgs(ok)).toEqual({ tenantSlug: "gaiada", siteId: "s1", items: [{ itemId: "i1", version: 3, contentHash: "abc" }], publishAt: null, rebuild: "staging", bundleSha256: null, counts: null });
  });
  it("carries WSK-67's bulk-import extras and a schedule", () => {
    const r = parseWebdeskPublishArgs({ ...ok, publishAt: "2026-11-01T00:00:00Z", bundleSha256: "ff", counts: { service: 40, post: "x" } });
    expect(r).toMatchObject({ publishAt: "2026-11-01T00:00:00Z", bundleSha256: "ff", counts: { service: 40 } });
  });
  it.each([null, "x", [], {}, { ...ok, items: "no" }, { ...ok, items: [{ itemId: "i", version: "3" }] }, { ...ok, siteId: 1 }])("rejects %j", (bad) => {
    expect(parseWebdeskPublishArgs(bad)).toBeNull();
  });
});

describe("diffContent — history 'diff against live' on the real compositions", () => {
  const content = (fields: Record<string, unknown>, seo: Record<string, unknown> = {}): EditableContent => ({ fields, seo, extraBlocks: [] });
  it("labels changed scalar, nested-group and seo fields from the composition", () => {
    const a = content({ h1: "Old", plan: { action: "SHOW", why: "a" }, body: "same" }, { title: "T" });
    const b = content({ h1: "New", plan: { action: "SHOW", why: "b" }, body: "same" }, { title: "T2" });
    const d = diffContent(SERVICE, a, b);
    expect(d.map((c) => [c.label, c.kind])).toEqual([["H1", "changed"], ["Plan › Why", "changed"], ["SEO title", "changed"]]);
    expect(d[0]).toMatchObject({ before: "Old", after: "New", pointer: "/blocks/0/props/h1" });
  });
  it("matches itemKey lists by key: added, removed, changed-in-place and reordered are distinct", () => {
    const row = (url: string, label: string, children: string[] = []) => ({ url, label, children });
    const a = content({ primary: [row("/a/", "A"), row("/b/", "B"), row("/c/", "C")] });
    const b = content({ primary: [row("/c/", "C"), row("/a/", "A2"), row("/d/", "D")] });
    const d = diffContent(NAV, a, b);
    const kinds = Object.fromEntries(d.map((c) => [c.label, c.kind]));
    expect(kinds["Primary › /a/ › Label"]).toBe("changed");
    expect(kinds["Primary › /b/"]).toBe("removed");
    expect(kinds["Primary › /d/"]).toBe("added");
    expect(kinds["Primary"]).toBe("reordered");
  });
  it("reports nothing for identical content (so 'no difference' is evidence, not a default)", () => {
    const x = content({ h1: "Same", schema: ["Service"] });
    expect(diffContent(SERVICE, x, x)).toEqual([]);
  });
  it("sees a read-only derived column change like any other", () => {
    const a = content({ tokens: [{ token: "{{X}}", occurrences: 1, source: "factsheet" }] });
    const b = content({ tokens: [{ token: "{{X}}", occurrences: 2, source: "factsheet" }] });
    expect(diffContent(TOKENS, a, b).map((c) => c.label)).toEqual(["Tokens › {{X}} › Occurrences"]);
  });
});

describe("markdown preview is built from data, never from HTML (§2.2: source is stored verbatim)", () => {
  it("parses headings, lists, paragraphs, emphasis and code", () => {
    const b = parseMarkdown("# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n1. a\n2. b\n\n```\nraw <b>\n```\n---\n");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol", "pre", "hr"]);
    expect(b[2]).toMatchObject({ t: "ul" });
    expect((b[2] as { items: unknown[] }).items).toHaveLength(2);
    expect(b[4]).toEqual({ t: "pre", v: "raw <b>" });
  });
  it("refuses a link with a script scheme and keeps raw HTML as inert text", () => {
    const inline = parseInline("[x](javascript:alert(1)) and <img src=x onerror=alert(1)> and [ok](https://gaiada.com/a)");
    expect(inline.some((p) => p.t === "link" && p.href.startsWith("javascript"))).toBe(false);
    expect(inline.filter((p) => p.t === "link")).toEqual([{ t: "link", v: "ok", href: "https://gaiada.com/a" }]);
    expect(inline.map((p) => p.t)).not.toContain("html");
  });
  it("an empty source parses to no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});
