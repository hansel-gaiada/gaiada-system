// T2 / D-a — validates REAL instances against the generated OpenAPI schemas with a REAL JSON Schema
// validator (ajv, already in the lockfile as a transitive dependency of fastify and redocly; no new
// package is added). Before this test existed nothing ever executed the schemas, and the generic
// block `items` used `oneOf: [...known blocks, UNKNOWN_BLOCK_SCHEMA]`. A known block also matches
// the permissive unknown-block branch (it has a string `type` and an object `props`), so under
// `oneOf` (exactly one) a strict validator rejected every valid known block. The fix is `anyOf`.
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { buildOpenApiDocument } from "../src/codegen/generator/openapi-builder.mts";
import { fieldValueSchema, type JsonSchema } from "../src/codegen/generator/vocabulary-field-schema.mts";

const BASE = { tenantSlug: "unit", contractVersion: "1.0.0", vocabularyVersion: "1.1.0", defaultLocale: "en-US", locales: ["en-US"] };

const ENVELOPE_BASE = {
  collection: "page",
  slug: "home",
  locale: "en-US",
  localizations: [],
  seo: {},
  meta: { publishedAt: null, updatedAt: "2026-10-11T00:00:00Z", draft: false, x: {} },
};

function validatorFor(doc: any, schemaName: string) {
  // OpenAPI 3.1 schemas are JSON Schema 2020-12 (prefixItems, const); `x-webdesk-*` are annotations.
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  return ajv.compile({ $ref: `#/components/schemas/${schemaName}`, components: doc.components });
}

const HERO = { type: "hero", props: { heading: "Hello" } };
const RICH = { type: "richText", props: { content: "plain" } };
const UNKNOWN = { type: "someFutureBlock", props: { anything: 1 } };

describe("openapi-builder — real instances validate against the generated schema (D-a)", () => {
  it("plain collection: a valid known block is accepted (was rejected under oneOf)", () => {
    const doc = buildOpenApiDocument({ ...BASE, composition: { page: { blocks: ["hero", "richText"] } } }) as any;
    const validate = validatorFor(doc, "ItemEnvelope_page");
    expect(validate({ ...ENVELOPE_BASE, blocks: [HERO, RICH] }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("plain collection with no `blocks` declared (unrestricted): known blocks validate", () => {
    const doc = buildOpenApiDocument({ ...BASE, composition: { page: {} } }) as any;
    const validate = validatorFor(doc, "ItemEnvelope_page");
    expect(validate({ ...ENVELOPE_BASE, blocks: [HERO] }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("an unknown/future block type still validates (renderer invariant, design §05 hard rule 2)", () => {
    const doc = buildOpenApiDocument({ ...BASE, composition: { page: { blocks: ["hero"] } } }) as any;
    const validate = validatorFor(doc, "ItemEnvelope_page");
    expect(validate({ ...ENVELOPE_BASE, blocks: [HERO, UNKNOWN] }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("a closed empty composition still refuses any block", () => {
    const doc = buildOpenApiDocument({ ...BASE, composition: { page: { blocks: [] } } }) as any;
    const validate = validatorFor(doc, "ItemEnvelope_page");
    expect(validate({ ...ENVELOPE_BASE, blocks: [HERO] })).toBe(false);
    expect(validate({ ...ENVELOPE_BASE, blocks: [] })).toBe(true);
  });

  it("fields collection with generic blocks allowed: item route accepts fields block + known block", () => {
    const doc = buildOpenApiDocument({
      ...BASE,
      composition: { page: { fields: [{ name: "title", primitive: "text", required: true }], blocks: ["hero"] } },
    }) as any;
    const fieldsBlock = { type: "fields", props: { title: "T" } };
    const item = validatorFor(doc, "ItemEnvelope_page");
    expect(item({ ...ENVELOPE_BASE, blocks: [fieldsBlock, HERO] }), JSON.stringify(item.errors)).toBe(true);
    const list = validatorFor(doc, "ListItemEnvelope_page");
    expect(list({ ...ENVELOPE_BASE, blocks: [fieldsBlock, HERO] }), JSON.stringify(list.errors)).toBe(true);
  });

  it("fields collection, closed (blocks: []): the tuple form accepts exactly the fields block", () => {
    const doc = buildOpenApiDocument({
      ...BASE,
      composition: { page: { fields: [{ name: "title", primitive: "text", required: true }], blocks: [] } },
    }) as any;
    const item = validatorFor(doc, "ItemEnvelope_page");
    expect(item({ ...ENVELOPE_BASE, blocks: [{ type: "fields", props: { title: "T" } }] }), JSON.stringify(item.errors)).toBe(true);
  });
});

describe("vocabulary-field-schema — richtext oneOf is provably disjoint (D-a)", () => {
  const schema = fieldValueSchema({ name: "body", primitive: "richtext" }) as JsonSchema & { oneOf: JsonSchema[] };

  it("keeps oneOf, and every valid value matches EXACTLY ONE branch", () => {
    expect(Array.isArray(schema.oneOf)).toBe(true);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const branches = schema.oneOf.map((b) => ajv.compile(b));
    const valid: unknown[] = ["plain text", "", { root: {} }, { root: { children: [] }, extra: 1 }];
    for (const v of valid) {
      expect(branches.filter((b) => b(v)).length, JSON.stringify(v)).toBe(1);
    }
    // and the whole schema (with oneOf semantics) accepts them
    const whole = ajv.compile(schema);
    for (const v of valid) expect(whole(v)).toBe(true);
    for (const bad of [1, null, [], {}, { notRoot: 1 }]) expect(whole(bad), JSON.stringify(bad)).toBe(false);
  });
});
