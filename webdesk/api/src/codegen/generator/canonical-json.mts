// WSK-15 — canonical serialization (design §05/§06: "canonical serialization (sorted keys, no
// timestamps inside artifact bodies)"). This file is the entire determinism guarantee for every
// JSON artifact this pipeline produces — get this wrong and the double-run gate is meaningless.
import { createHash } from "node:crypto";

/** Recursively sorts every plain object's keys (arrays keep their element ORDER — only object
 *  KEY order is unstable in JS, array order is caller-controlled and must already be
 *  deterministic, e.g. an `ORDER BY key` on the SQL side). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = sortKeysDeep(input[key]);
    }
    return out;
  }
  return value;
}

/** Pretty (2-space), sorted-key JSON — deterministic across runs given deterministic input.
 *  Deliberately still human-diffable (this is what ships as `openapi.v1.json` on disk), which
 *  `JSON.stringify(x)` with no indent would not be. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
