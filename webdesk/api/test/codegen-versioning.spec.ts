// WSK-15 — proves `computeNextContractVersion`/`toContractSnapshot` do not reimplement any
// version-bump rule of their own: they only adapt shapes and call straight through to WSK-14's
// OWN `classifyTenantContractChange`/`bumpVersion` (webdesk/payload/vocabulary/breaking-change.ts,
// frozen/DEV-VERIFIED). No DB/storage — pure.
import { describe, expect, it } from "vitest";
import { computeNextContractVersion, toContractSnapshot } from "../src/codegen/generator/versioning.mts";
import type { TenantComposition } from "../../payload/vocabulary/composition.ts";

describe("versioning — first generation", () => {
  it("with no previous state, always lands on 1.0.0", () => {
    const composition: TenantComposition = { article: { blocks: ["richText"] } };
    const result = computeNextContractVersion(null, composition);
    expect(result.version).toBe("1.0.0");
    expect(result.reasons).toEqual(["first generation for this tenant"]);
  });
});

describe("versioning — subsequent generations, via WSK-14's classifier unmodified", () => {
  const before: TenantComposition = { article: { blocks: ["richText"] } };

  it("adding a collection is MINOR", () => {
    const after: TenantComposition = { ...before, "case-study": { blocks: ["hero"] } };
    const result = computeNextContractVersion({ version: "1.0.0", snapshot: toContractSnapshot(before) }, after);
    expect(result.version).toBe("1.1.0");
  });

  it("removing a collection is MAJOR", () => {
    const after: TenantComposition = {};
    const result = computeNextContractVersion({ version: "1.4.2", snapshot: toContractSnapshot(before) }, after);
    expect(result.version).toBe("2.0.0");
  });

  it("adding a block type to a collection's allow-list is MINOR", () => {
    const after: TenantComposition = { article: { blocks: ["richText", "gallery"] } };
    const result = computeNextContractVersion({ version: "1.0.0", snapshot: toContractSnapshot(before) }, after);
    expect(result.version).toBe("1.1.0");
  });

  it("removing a block type from a collection's allow-list is MAJOR", () => {
    const withTwo: TenantComposition = { article: { blocks: ["richText", "gallery"] } };
    const after: TenantComposition = { article: { blocks: ["richText"] } };
    const result = computeNextContractVersion({ version: "3.2.1", snapshot: toContractSnapshot(withTwo) }, after);
    expect(result.version).toBe("4.0.0");
  });

  it("no structural change at all is PATCH", () => {
    const result = computeNextContractVersion({ version: "1.0.0", snapshot: toContractSnapshot(before) }, before);
    expect(result.version).toBe("1.0.1");
    expect(result.reasons).toEqual(["no structural change detected"]);
  });
});

describe("toContractSnapshot — adapts TenantComposition to WSK-14's TenantContractSnapshot", () => {
  it("defaults a blocks-only collection's `fields` to [] (never undefined)", () => {
    const snapshot = toContractSnapshot({ article: { blocks: ["richText"] } });
    expect(snapshot.collections.article.fields).toEqual([]);
    expect(snapshot.collections.article.blocks).toEqual(["richText"]);
  });

  it("preserves a fields-only collection's fields and leaves blocks undefined", () => {
    const snapshot = toContractSnapshot({ redirect: { fields: [{ name: "toPath", primitive: "text", required: true }] } });
    expect(snapshot.collections.redirect.fields).toEqual([{ name: "toPath", primitive: "text", required: true }]);
    expect(snapshot.collections.redirect.blocks).toBeUndefined();
  });
});
