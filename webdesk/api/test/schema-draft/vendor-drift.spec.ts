// WSK-32 — proves src/schema-draft/vocabulary-vendor.ts's constants still match the REAL
// source of truth (webdesk/payload/vocabulary/*.ts), by reading those files as TEXT (never
// importing them — see vocabulary-vendor.ts's header for why importing is off the table under
// this project's commonjs tsconfig). If the vocabulary changes and this file is not re-vendored,
// THIS test goes red rather than the vendor silently drifting. Mirrors webdesk/blocks's own
// test/unit/vendor-drift.test.mjs pattern (WSK-16), adapted to a read-only text comparison
// instead of that package's copy-and-diff script.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIMITIVE_NAMES, BLOCK_TYPE_NAMES, VOCABULARY_VERSION } from "../../src/schema-draft/vocabulary-vendor";

const VOCAB_DIR = join(__dirname, "..", "..", "..", "payload", "vocabulary");

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

  it("BLOCK_TYPE_NAMES matches blocks.ts's BlockType union", () => {
    const source = readNormalized(join(VOCAB_DIR, "blocks.ts"));
    const match = source.match(/export type BlockType =\n([\s\S]*?)\n\n/);
    if (!match) throw new Error("BlockType union not found in blocks.ts");
    const names = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...BLOCK_TYPE_NAMES]);
  });

  it("VOCABULARY_VERSION matches version.ts", () => {
    const source = readNormalized(join(VOCAB_DIR, "version.ts"));
    const match = source.match(/export const VOCABULARY_VERSION = '([^']+)'/);
    if (!match) throw new Error("VOCABULARY_VERSION not found in version.ts");
    expect(match[1]).toBe(VOCABULARY_VERSION);
  });

  it("both vendored unions are non-empty (a marker-regex silently matching nothing must not read as a pass)", () => {
    expect(PRIMITIVE_NAMES.length).toBeGreaterThan(0);
    expect(BLOCK_TYPE_NAMES.length).toBeGreaterThan(0);
  });
});
