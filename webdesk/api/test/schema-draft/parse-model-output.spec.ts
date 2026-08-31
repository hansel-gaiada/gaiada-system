import { describe, expect, it } from "vitest";
import { parseModelCompositionOutput } from "../../src/schema-draft/parse-model-output";

describe("parseModelCompositionOutput", () => {
  it("parses a clean JSON object", () => {
    const out = parseModelCompositionOutput('{"fields":[{"name":"title","primitive":"text"}]}');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ fields: [{ name: "title", primitive: "text" }] });
  });

  it("extracts JSON wrapped in prose/markdown fences (robust to a non-compliant local model, same technique as mcp-hub's llm.extract)", () => {
    const out = parseModelCompositionOutput('Sure, here you go:\n```json\n{"blocks":["hero"]}\n```\nLet me know if you need changes.');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ blocks: ["hero"] });
  });

  it("REJECTS an empty response with a named reason", () => {
    const out = parseModelCompositionOutput("");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/empty response/);
  });

  it("REJECTS a response with no JSON object at all, with a named reason", () => {
    const out = parseModelCompositionOutput("I'm not sure what schema you want, can you clarify?");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/no JSON object/);
  });

  it("REJECTS malformed JSON with a named reason (never silently wraps it as a fallback composition)", () => {
    const out = parseModelCompositionOutput('{"fields": [{"name": "title", "primitive": }');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/not valid JSON/);
  });
});
