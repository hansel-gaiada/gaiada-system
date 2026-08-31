// WSK-15 — maps ONE vocabulary FieldDef (webdesk/payload/vocabulary/primitives.ts, WSK-06/frozen)
// to a JSON Schema fragment. This is the "hand-authored" half of WSK-D19: every other artifact is
// DERIVED by standard tooling from the document this file helps build, but the mapping from "the
// 8 vocabulary primitives" to "JSON Schema" is our own domain knowledge, written once, here.
import type { FieldDef, PrimitiveName } from "../../../../payload/vocabulary/primitives.ts";

export type JsonSchema = Record<string, unknown>;

const MEDIA_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    alt: { type: "string" },
    width: { type: "number" },
    height: { type: "number" },
    mime: { type: "string" },
  },
  required: ["url"],
  additionalProperties: false,
};

const RELATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: { collection: { type: "string" }, slug: { type: "string" } },
  required: ["collection", "slug"],
  additionalProperties: false,
};

const GEO_SCHEMA: JsonSchema = {
  type: "object",
  properties: { lat: { type: "number", minimum: -90, maximum: 90 }, lng: { type: "number", minimum: -180, maximum: 180 } },
  required: ["lat", "lng"],
  additionalProperties: false,
};

const RICHTEXT_SCHEMA: JsonSchema = {
  description:
    "A Lexical-shaped JSON document ({ root: ... }) or a plain string fallback " +
    "(primitives.ts's own documented jsonShape for 'richtext').",
  oneOf: [
    { type: "string" },
    { type: "object", properties: { root: { type: "object" } }, required: ["root"], additionalProperties: true },
  ],
};

/** One primitive, value-shape only (no `required`/`multiple` wrapping — that is the caller's job,
 *  since those are FieldDef-level, not primitive-level, concerns). */
function primitiveSchema(primitive: PrimitiveName, field: FieldDef): JsonSchema {
  switch (primitive) {
    case "text":
      return { type: "string" };
    case "richtext":
      return RICHTEXT_SCHEMA;
    case "media":
      return MEDIA_SCHEMA;
    case "relation":
      return RELATION_SCHEMA;
    case "number":
      return { type: "number" };
    case "date":
      return { type: "string", format: "date-time" };
    case "select":
      return { type: "string", enum: field.options ?? [] };
    case "geo":
      return GEO_SCHEMA;
    default: {
      // Exhaustiveness guard — a new primitive reaching this file without an update here is a
      // vocabulary MINOR the codegen pipeline has not caught up with; fail loud rather than emit
      // a silently-wrong schema (matches the "computed, never judged" doctrine of breaking-change.ts,
      // applied here to "unmapped primitive" rather than "version bump").
      const exhaustive: never = primitive;
      throw new Error(`vocabulary-field-schema: unmapped primitive "${String(exhaustive)}"`);
    }
  }
}

/** A FieldDef, wrapped for `multiple` (`relation`/`media` only, per primitives.ts's own comment). */
export function fieldValueSchema(field: FieldDef): JsonSchema {
  const base = primitiveSchema(field.primitive, field);
  return field.multiple ? { type: "array", items: base } : base;
}

/** `fields[]` -> a JSON Schema object with `properties`/`required` — used for both a block's
 *  `props` (Layer 1) and a fields-only collection's composition (Layer 2, e.g. `redirect`). */
export function fieldsToObjectSchema(fields: FieldDef[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = fieldValueSchema(f);
    if (f.required) required.push(f.name);
  }
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}
