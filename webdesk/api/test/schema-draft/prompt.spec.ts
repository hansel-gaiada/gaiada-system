// T2 / D-b — the drafting prompt teaches vocabulary 1.1.0: it offers exactly the composable block
// types (never `fields`), and explains group / nested fields / itemKey / multiple and the four
// composition keys. Every worked example in the prompt must itself pass the real validator.
import { describe, expect, it } from "vitest";
import { buildSchemaDraftPrompt, PROMPT_EXAMPLES } from "../../src/schema-draft/prompt";
import { BLOCK_TYPE_NAMES, PRIMITIVE_NAMES, validateCollectionComposition } from "../../src/schema-draft/vocabulary-vendor";
import { BLOCK_TYPE_NAMES as ALL_BLOCK_TYPE_NAMES } from "../../src/delivery/vocabulary/blocks";

const prompt = buildSchemaDraftPrompt({ collectionKey: "faq-page", prd: "an FAQ page", currentSchema: null });

/** The sentence that lists the allowed block types, so assertions about "offered" are not fooled by prose. */
const blockListLine = prompt.split("\n").find((l) => l.startsWith("You MUST use ONLY these") && l.includes("block types"))!;

describe("buildSchemaDraftPrompt — vocabulary 1.1.0", () => {
  it("offers every composable block type, and the count it states is the composable count", () => {
    expect(BLOCK_TYPE_NAMES).toHaveLength(9);
    for (const t of BLOCK_TYPE_NAMES) expect(blockListLine).toContain(t);
    expect(blockListLine).toContain(`these ${BLOCK_TYPE_NAMES.length} block types`);
  });

  it("never offers `fields` as a block type, though the full vocabulary has it", () => {
    expect(ALL_BLOCK_TYPE_NAMES).toContain("fields");
    expect(BLOCK_TYPE_NAMES).not.toContain("fields");
    const listed = blockListLine.split(": ")[1].split(". ")[0].split(", ").map((s) => s.trim());
    expect(listed).toEqual([...BLOCK_TYPE_NAMES]);
    expect(prompt).toMatch(/Never put "fields" in "blocks"/);
  });

  it("lists every primitive, including the 1.1.0 ones", () => {
    for (const p of PRIMITIVE_NAMES) expect(prompt).toContain(p);
    for (const p of ["group", "boolean", "markdown"]) expect(PRIMITIVE_NAMES).toContain(p);
  });

  it("teaches group, nested fields, itemKey, multiple and the four composition keys", () => {
    for (const word of ["group", "nested", "itemKey", "multiple", "singleton", "localized", "ui", "lint"]) {
      expect(prompt, word).toContain(word);
    }
    expect(prompt).toMatch(/"fields" array/);
  });

  it("every worked example in the prompt is valid under the real composition validator", () => {
    const asComposition = {
      group: { fields: [PROMPT_EXAMPLES.group] },
      itemKey: { fields: [PROMPT_EXAMPLES.itemKey] },
      multiple: { fields: [PROMPT_EXAMPLES.multiple] },
      collection: PROMPT_EXAMPLES.collection,
    };
    for (const [name, c] of Object.entries(asComposition)) {
      const r = validateCollectionComposition("x", c);
      expect(r.issues, name).toEqual([]);
      expect(prompt, name).toContain(JSON.stringify(name === "collection" ? c : (c as any).fields[0]));
    }
  });

  it("still carries the PRD and the current composition", () => {
    const withCurrent = buildSchemaDraftPrompt({ collectionKey: "c", prd: "PRD-TEXT", currentSchema: { blocks: ["hero"] } });
    expect(withCurrent).toContain("PRD-TEXT");
    expect(withCurrent).toContain('{"blocks":["hero"]}');
  });
});
