// WSK-32 — proves src/schema-draft/vocabulary-vendor.ts still matches the REAL source of truth
// (webdesk/delivery/vocabulary/*.ts), by reading those files as TEXT (never importing them — see
// vocabulary-vendor.ts's header for why importing is off the table under this project's commonjs
// tsconfig). If the vocabulary changes and the api is not re-vendored, THIS test goes red rather
// than the vendor silently drifting.
//
// WSK-64 (vocabulary 1.1.0): vocabulary-vendor.ts now re-exports the mechanically vendored
// ../delivery/vocabulary/ copy instead of a hand transcription, so this spec additionally proves the
// validator it exposes IS that copy, and that the 1.1.0 rules reach the drafting flow.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRIMITIVE_NAMES,
  BLOCK_TYPE_NAMES,
  VOCABULARY_VERSION,
  validateCollectionComposition,
  formatCompositionIssues,
} from "../../src/schema-draft/vocabulary-vendor";
import * as vendoredComposition from "../../src/delivery/vocabulary/composition";

const VOCAB_DIR = join(__dirname, "..", "..", "..", "delivery", "vocabulary");

/** Some vocabulary source files carry CRLF line endings (git-autocrlf artifact) and some don't —
 *  observed directly while running this test (primitives.ts needed this, blocks.ts happened not
 *  to). Normalize unconditionally rather than assume either file's line-ending convention. */
function readNormalized(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

describe("schema-draft vocabulary vendor — drift check against the REAL source (text-only, never imported)", () => {
  it("PRIMITIVE_NAMES matches primitives.ts's PrimitiveName union", () => {
    const source = readNormalized(join(VOCAB_DIR, "primitives.ts"));
    // export type PrimitiveName = | 'text' | 'richtext' | ... up to the next blank-line-terminated block
    const match = source.match(/export type PrimitiveName =\n([\s\S]*?)\n\n/);
    if (!match) throw new Error("PrimitiveName union not found in primitives.ts");
    const names = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...PRIMITIVE_NAMES]);
  });

  it("BLOCK_TYPE_NAMES matches blocks.ts's BlockType union minus the non-composable `fields` and `experiment` blocks", () => {
    const source = readNormalized(join(VOCAB_DIR, "blocks.ts"));
    const match = source.match(/export type BlockType =\n([\s\S]*?)\n\n/);
    if (!match) throw new Error("BlockType union not found in blocks.ts");
    const names = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names).toContain("fields");
    expect(names).toContain("experiment");
    expect(names.filter((n) => n !== "fields" && n !== "experiment")).toEqual([...BLOCK_TYPE_NAMES]);
    expect(BLOCK_TYPE_NAMES).not.toContain("fields");
    expect(BLOCK_TYPE_NAMES).not.toContain("experiment");
  });

  it("VOCABULARY_VERSION matches version.ts", () => {
    const source = readNormalized(join(VOCAB_DIR, "version.ts"));
    const match = source.match(/export const VOCABULARY_VERSION = '([^']+)'/);
    if (!match) throw new Error("VOCABULARY_VERSION not found in version.ts");
    expect(match[1]).toBe(VOCABULARY_VERSION);
    expect(VOCABULARY_VERSION).toBe("1.5.0"); // M5-V5-a (1.4.0 was M5-W8b, 1.3.0 M5-W3c, 1.2.0 was WSK-49a, 1.1.0 WSK-64)
  });

  it("both vendored unions are non-empty (a marker-regex silently matching nothing must not read as a pass)", () => {
    expect(PRIMITIVE_NAMES.length).toBeGreaterThan(0);
    expect(BLOCK_TYPE_NAMES.length).toBeGreaterThan(0);
  });

  it("the validator is the mechanically vendored one (no hand transcription left to drift)", () => {
    expect(validateCollectionComposition).toBe(vendoredComposition.validateCollectionComposition);
    expect(formatCompositionIssues).toBe(vendoredComposition.formatCompositionIssues);
  });

  it("the 1.1.0 rules reach the drafting flow: a group is accepted, `fields` in blocks and a hyphenated name are refused", () => {
    expect(validateCollectionComposition("faq", { fields: [{ name: "faq", primitive: "group", multiple: true, fields: [{ name: "q", primitive: "text" }] }] }).valid).toBe(true);
    const banned = validateCollectionComposition("page", { blocks: ["fields"] });
    expect(banned.valid).toBe(false);
    expect(banned.issues[0].path).toBe("page.blocks[0]");
    const badName = validateCollectionComposition("page", { fields: [{ name: "image-alt", primitive: "text" }] });
    expect(badName.valid).toBe(false);
    expect(badName.issues[0].path).toBe("page.fields[0].name");
  });
});
