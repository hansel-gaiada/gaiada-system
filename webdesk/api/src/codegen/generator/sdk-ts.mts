// WSK-15 — derives the TS SDK from an already-built OpenAPI document (WSK-D19: "the TS SDK comes
// from openapi-typescript"). Confirmed empirically (this ticket's report has the transcript)
// that `openapiTS(doc, opts)` + `astToString(ast)` is byte-identical across repeated calls on the
// same input with NO wall-clock leakage (no header comment, no embedded timestamp) — the tool
// itself is safe for the double-run gate; this file adds no non-determinism of its own.
import openapiTS, { astToString } from "openapi-typescript";

export async function generateTsSdk(openApiDocument: Record<string, unknown>): Promise<string> {
  // `as never` here: openapi-typescript's own input type is a large union (URL | string |
  // pre-parsed OpenAPI3 object | ...) that does not narrow cleanly against our hand-built plain
  // object without importing its full internal schema types into this file for no benefit —
  // verified working against the actual shape this builder produces (see this ticket's
  // codegen-sdk-generation.spec.ts).
  const ast = await openapiTS(openApiDocument as never, { alphabetize: true });
  return astToString(ast);
}
