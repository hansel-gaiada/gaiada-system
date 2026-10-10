// WSK-15 — maps ONE vocabulary FieldDef (webdesk/delivery/vocabulary/primitives.ts, WSK-06/frozen)
// to a JSON Schema fragment. This is the "hand-authored" half of WSK-D19: every other artifact is
// DERIVED by standard tooling from the document this file helps build, but the mapping from "the
// 8 vocabulary primitives" to "JSON Schema" is our own domain knowledge, written once, here.
//
// WSK-64 (vocabulary 1.1.0): `group` (a closed object, recursively), `boolean` and `markdown`, and
// `multiple` wraps EVERY primitive in an array (the validator now honours it everywhere; this file
// already wrapped any `multiple` field, which is fact 9 of the write-plane design). Editor-only
// FieldDef keys (`ui`) never reach the wire schema. `itemKey` and `localized: false` are carried as
// `x-webdesk-*` annotations: JSON Schema cannot express "unique by this sub-field", and locale
// neutrality is advisory (write-plane design §2.5 rule 2), so neither is a validation keyword here.
import type { FieldDef, PrimitiveName } from "../../../../delivery/vocabulary/primitives.ts";

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

// `oneOf` is correct here and deliberately kept (T2 / D-a; contrast the block unions in
// openapi-builder.mts, which are `anyOf`). The two branches are provably disjoint: one requires JSON
// type `string`, the other JSON type `object`, and no JSON value has both types. So a valid value
// matches exactly one branch, which is precisely what `oneOf` asserts.
// test/codegen-openapi-schema-validation.spec.ts proves it with a real validator.
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
    case "boolean":
      return { type: "boolean" };
    case "markdown":
      return { type: "string", contentMediaType: "text/markdown", description: "CommonMark + GFM source, stored verbatim." };
    case "group":
      return fieldsToObjectSchema(field.fields ?? []);
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

/** A FieldDef, wrapped for `multiple` (every primitive, vocabulary 1.1.0). */
export function fieldValueSchema(field: FieldDef): JsonSchema {
  const base = primitiveSchema(field.primitive, field);
  const schema: JsonSchema = field.multiple ? { type: "array", items: base } : { ...base };
  if (field.multiple && field.primitive === "group" && field.itemKey) schema["x-webdesk-item-key"] = field.itemKey;
  if (field.localized === false) schema["x-webdesk-localized"] = false;
  return schema;
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
