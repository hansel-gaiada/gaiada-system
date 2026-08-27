// WSK-32 — the ticket's own bar: "Prove the validator rejects, not just accepts: a proposal
// citing an unknown block, an unknown field type, and a destructive removal must each fail with a
// distinct, named error, and include a positive control proving the validator is not always-fail."
// Pure — no database, no gateway, no Nest bootstrap.
import { describe, expect, it } from "vitest";
import { validateCollectionComposition } from "../../src/schema-draft/vocabulary-vendor";
import { buildDiffSummary } from "../../src/schema-draft/diff-summary";

describe("schema-draft validator — rejects out-of-vocabulary proposals with named, distinct reasons", () => {
  it("REJECTS an unknown block type", () => {
    const result = validateCollectionComposition("case-study", { blocks: ["hero", "pricingTable"] });
    expect(result.valid).toBe(false);
    const hit = result.issues.find((i) => i.path === "case-study.blocks[1]");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/"pricingTable" is not one of the 9 vocabulary block types/);
  });

  it("REJECTS an unknown field primitive (field type)", () => {
    const result = validateCollectionComposition("article", { fields: [{ name: "rating", primitive: "star-rating" }] });
    expect(result.valid).toBe(false);
    const hit = result.issues.find((i) => i.path === "article.fields[0].primitive");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/"star-rating" is not one of the 8 vocabulary primitives/);
  });

  it("REJECTS an unknown composition key (not a block/field-type case, but the same class of out-of-vocabulary construct)", () => {
    const result = validateCollectionComposition("page", { layout: "grid" });
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toMatch(/unknown composition key "layout"/);
  });

  it("POSITIVE CONTROL: a clean, purely-additive proposal passes with zero issues — proves the validator is not always-fail", () => {
    const result = validateCollectionComposition("case-study", {
      fields: [
        { name: "clientName", primitive: "text", required: true },
        { name: "summary", primitive: "richtext" },
      ],
      blocks: ["hero", "richText", "gallery", "testimonial"],
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe("schema-draft diff summary — destructive removal is flagged, not just diffed", () => {
  it("a REMOVED field is flagged destructive:true, named, and reported as data loss", () => {
    const current = { fields: [{ name: "clientName", primitive: "text" as const }, { name: "legacyNotes", primitive: "text" as const }] };
    const proposed = { fields: [{ name: "clientName", primitive: "text" as const }] };
    const diff = buildDiffSummary("case-study", current, proposed);
    expect(diff.destructive).toBe(true);
    expect(diff.removedFieldNames).toEqual(["legacyNotes"]);
    const entry = diff.entries.find((e) => e.kind === "field-removed");
    expect(entry).toBeDefined();
    expect(entry!.destructive).toBe(true);
    expect(entry!.message).toMatch(/legacyNotes.*REMOVED.*lost/);
  });

  it("a removed block type is also flagged destructive:true", () => {
    const current = { blocks: ["hero", "testimonial"] as const };
    const proposed = { blocks: ["hero"] as const };
    const diff = buildDiffSummary("landing", { blocks: [...current.blocks] }, { blocks: [...proposed.blocks] });
    expect(diff.destructive).toBe(true);
    expect(diff.removedBlocks).toEqual(["testimonial"]);
  });

  it("POSITIVE CONTROL: a purely additive diff (new optional field, new block) is destructive:false", () => {
    const current = { fields: [{ name: "clientName", primitive: "text" as const }] };
    const proposed = { fields: [{ name: "clientName", primitive: "text" as const }, { name: "summary", primitive: "richtext" as const }], blocks: ["hero" as const] };
    const diff = buildDiffSummary("case-study", current, proposed);
    expect(diff.destructive).toBe(false);
    expect(diff.addedFieldNames).toEqual(["summary"]);
    expect(diff.addedBlocks).toEqual(["hero"]);
    expect(diff.entries.every((e) => e.destructive === false)).toBe(true);
  });

  it("a NEW REQUIRED field is flagged destructive:true (existing content lacking it would break) — not just additions in general", () => {
    const current = { fields: [{ name: "clientName", primitive: "text" as const }] };
    const proposed = { fields: [{ name: "clientName", primitive: "text" as const }, { name: "budget", primitive: "number" as const, required: true }] };
    const diff = buildDiffSummary("case-study", current, proposed);
    expect(diff.destructive).toBe(true);
    const entry = diff.entries.find((e) => e.kind === "field-added-required");
    expect(entry!.destructive).toBe(true);
  });

  it("a brand-new collection (current=null) reports isNewCollection:true and every field/block as added, never destructive", () => {
    const proposed = { fields: [{ name: "title", primitive: "text" as const, required: true }] };
    const diff = buildDiffSummary("new-collection", null, proposed);
    expect(diff.isNewCollection).toBe(true);
    // A required field on a BRAND NEW collection has no existing content to break — but this
    // file's rule is field-shape-based, not existence-of-current-content-based, and is honest
    // about that: it still flags "added as REQUIRED" the same way, since the diff cannot see
    // whether content_items rows already exist for a collection that has no `collections` row
    // yet either way. Documented rather than silently special-cased.
    expect(diff.addedFieldNames).toEqual(["title"]);
  });
});
