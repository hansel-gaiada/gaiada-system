// WSK-15 — proves `computeNextContractVersion`/`toContractSnapshot` do not reimplement any
// version-bump rule of their own: they only adapt shapes and call straight through to WSK-14's
// OWN `classifyTenantContractChange`/`bumpVersion` (webdesk/payload/vocabulary/breaking-change.ts,
// frozen/DEV-VERIFIED). No DB/storage — pure.
import { describe, expect, it } from "vitest";
import { computeNextContractVersion, toContractSnapshot } from "../src/codegen/generator/versioning.mts";
import type { TenantComposition } from "../../payload/vocabulary/composition.ts";
import { classifyTenantContractChange } from "../../payload/vocabulary/breaking-change.ts";

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

// WSK-41 — toContractSnapshot used to carry only {fields, blocks}, so the classifier's WSK-64
// tenant-axis rules never saw `singleton`/`localized`/`ui`/`lint` and every composition flip was
// rated "no structural change" (PATCH). These pin that each key now reaches the classifier and is
// rated as breaking-change.ts rates it: singleton/localized flips MAJOR, ui/lint edits PATCH.
describe("toContractSnapshot — carries the 1.1.0 collection keys (WSK-41 fix)", () => {
  const base: TenantComposition = {
    navigation: { fields: [{ name: "label", primitive: "text" }], ui: { label: "Navigation" } },
  };
  const prev = (v: string, c: TenantComposition) => ({ version: v, snapshot: toContractSnapshot(c) });

  it("copies singleton/localized/ui/lint when declared, and adds no key when they are absent", () => {
    const snap = toContractSnapshot({
      a: {
        fields: [],
        singleton: true,
        localized: false,
        ui: { label: "A" },
        lint: { placeholders: [{ kind: "marker", open: "[CONFIRM:", close: "]", label: "CONFIRM" }] },
      },
      b: { blocks: ["richText"] },
    });
    expect(snap.collections.a.singleton).toBe(true);
    expect(snap.collections.a.localized).toBe(false);
    expect(snap.collections.a.ui).toEqual({ label: "A" });
    expect(snap.collections.a.lint?.placeholders).toHaveLength(1);
    expect(Object.keys(snap.collections.b).sort()).toEqual(["blocks", "fields"]);
  });

  it("a singleton flip is MAJOR (was PATCH before the fix)", () => {
    const after: TenantComposition = { navigation: { ...base.navigation, singleton: true } };
    const r = computeNextContractVersion(prev("1.2.3", base), after);
    expect(r.version).toBe("2.0.0");
    expect(r.reasons.join("\n")).toMatch(/singleton flipped false -> true/);
  });

  it("a localized flip is MAJOR", () => {
    const after: TenantComposition = { navigation: { ...base.navigation, localized: false } };
    const r = computeNextContractVersion(prev("1.2.3", base), after);
    expect(r.version).toBe("2.0.0");
    expect(r.reasons.join("\n")).toMatch(/localized flipped true -> false/);
  });

  it("a ui edit is PATCH, with its own reason (not 'no structural change')", () => {
    const after: TenantComposition = { navigation: { ...base.navigation, ui: { label: "Main navigation" } } };
    const r = computeNextContractVersion(prev("1.2.3", base), after);
    expect(r.version).toBe("1.2.4");
    expect(r.reasons.join("\n")).toMatch(/ui changed/);
  });

  it("a lint edit is PATCH, with its own reason", () => {
    const after: TenantComposition = {
      navigation: { ...base.navigation, lint: { placeholders: [{ kind: "token", open: "{{", close: "}}" }] } },
    };
    const r = computeNextContractVersion(prev("1.2.3", base), after);
    expect(r.version).toBe("1.2.4");
    expect(r.reasons.join("\n")).toMatch(/lint changed/);
  });

  it("negative control: the pre-fix {fields, blocks}-only adapter rated the same singleton flip PATCH", () => {
    const blind = (c: TenantComposition) => ({
      collections: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { fields: v.fields ?? [], blocks: v.blocks }])),
    });
    const after: TenantComposition = { navigation: { ...base.navigation, singleton: true } };
    expect(classifyTenantContractChange(blind(base), blind(after)).bump).toBe("patch");
    expect(classifyTenantContractChange(toContractSnapshot(base), toContractSnapshot(after)).bump).toBe("major");
  });
});
