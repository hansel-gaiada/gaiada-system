// WSK-32 — parses the model's raw completion text into a candidate composition object. Mirrors
// mcp-hub's llm.extract regex-JSON-extraction technique (`raw.match(/\{[\s\S]*\}/)`) for
// robustness to a non-compliant local model wrapping JSON in prose/markdown fences — but UNLIKE
// that tool (which falls back to wrapping raw text as a valid "content" string when parsing
// fails), a composition proposal has no such fallback: if the model did not return a parseable
// JSON object, there is nothing to validate, and the draft must be rejected with a NAMED reason
// rather than silently downgraded into something that looks like a composition but isn't.

export type ParsedModelOutput = { ok: true; value: unknown } | { ok: false; reason: string };

export function parseModelCompositionOutput(raw: string): ParsedModelOutput {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "the model returned an empty response" };
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return { ok: false, reason: "the model's response contained no JSON object" };
  }
  try {
    const value = JSON.parse(match[0]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: `the model's response was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}
