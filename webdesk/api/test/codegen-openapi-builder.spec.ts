// WSK-15 — unit coverage for `buildOpenApiDocument` (pure, no DB/storage). Proves the document
// (a) validates structurally, (b) describes the REAL routes `webdesk/payload/collections/router.ts`
// serves (design §06's AC: "describe exactly what these routes actually return"), and (c) honours
// composition.ts's own documented interpretation of the `blocks` axis (absent = unrestricted,
// present-including-empty = a closed set) plus the renderer invariant (an unknown block type is
// never a schema-level error, design §05 hard rule 2).
//
// No env vars needed — this file touches no DB/storage.
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/codegen/generator/openapi-builder.mts";

const BASE_INPUT = {
  tenantSlug: "unit-tenant",
  contractVersion: "1.0.0",
  vocabularyVersion: "1.0.0",
  defaultLocale: "id-ID",
  locales: ["id-ID", "en-US"],
};

describe("openapi-builder — structural validity", () => {
  it("is a valid-shaped OpenAPI 3.1 document", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["richText"] } } }) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toBeTruthy();
    expect(doc.info.version).toBe("1.0.0");
    expect(doc.paths).toBeTruthy();
    expect(doc.components.schemas).toBeTruthy();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer", description: expect.any(String) });
  });

  it("every operationId is unique across the whole document", () => {
    const doc = buildOpenApiDocument({
      ...BASE_INPUT,
      composition: { article: { blocks: ["richText"] }, "case-study": { blocks: ["hero"] } },
    }) as any;
    const ids: string[] = [];
    for (const pathItem of Object.values(doc.paths) as any[]) {
      for (const op of Object.values(pathItem) as any[]) {
        if (op && typeof op === "object" && "operationId" in op) ids.push(op.operationId);
      }
    }
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every $ref points at a schema that actually exists in components.schemas", () => {
    const doc = buildOpenApiDocument({
      ...BASE_INPUT,
      composition: { article: { blocks: ["richText"] }, "case-study": { blocks: ["hero", "testimonial"] } },
    }) as any;
    const refs = new Set<string>();
    (function walk(node: unknown) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "$ref" && typeof v === "string") refs.add(v);
          else walk(v);
        }
      }
    })(doc);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      const name = ref.replace("#/components/schemas/", "");
      expect(doc.components.schemas[name], `missing schema for ${ref}`).toBeTruthy();
    }
  });
});

describe("openapi-builder — describes the real router.ts routes", () => {
  it("emits list + item paths per collection, plus search and sitemap.xml, under /v1/t/{tenantSlug}", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["richText"] } } }) as any;
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual([
      "/v1/t/unit-tenant/article",
      "/v1/t/unit-tenant/article/{slug}",
      "/v1/t/unit-tenant/search",
      "/v1/t/unit-tenant/sitemap.xml",
    ]);
  });

  it("list/item/search all declare 401 problem+json and require no request body (GET-only, router.ts's own 'read-only contract' rule)", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["richText"] } } }) as any;
    for (const key of ["/v1/t/unit-tenant/article", "/v1/t/unit-tenant/article/{slug}", "/v1/t/unit-tenant/search"]) {
      const item = doc.paths[key];
      expect(Object.keys(item)).toEqual(["get"]);
      expect(item.get.responses["401"].content["application/problem+json"]).toBeTruthy();
    }
  });

  it("list carries locale/cursor/limit/expand query params; item carries slug path param + locale; search carries q/collection/locale/cursor/limit", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["richText"] } } }) as any;
    const listParams = doc.paths["/v1/t/unit-tenant/article"].get.parameters.map((p: any) => p.name);
    expect(listParams.sort()).toEqual(["cursor", "expand", "limit", "locale"]);

    const itemParams = doc.paths["/v1/t/unit-tenant/article/{slug}"].get.parameters.map((p: any) => p.name);
    expect(itemParams.sort()).toEqual(["locale", "slug"]);
    expect(doc.paths["/v1/t/unit-tenant/article/{slug}"].get.parameters.find((p: any) => p.name === "slug").in).toBe("path");

    const searchParams = doc.paths["/v1/t/unit-tenant/search"].get.parameters.map((p: any) => p.name);
    expect(searchParams.sort()).toEqual(["collection", "cursor", "limit", "locale", "q"]);
  });

  it("sitemap.xml responds with application/xml, not JSON", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["richText"] } } }) as any;
    const content = doc.paths["/v1/t/unit-tenant/sitemap.xml"].get.responses["200"].content;
    expect(Object.keys(content)).toEqual(["application/xml"]);
  });
});

describe("openapi-builder — composition.ts's `blocks` interpretation, honoured exactly", () => {
  it("blocks ABSENT -> unrestricted: every known vocabulary block type is a oneOf branch, plus the unknown-type branch", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { anything: {} } }) as any;
    const itemSchema = doc.components.schemas["ItemEnvelope_anything"];
    const oneOf = itemSchema.properties.blocks.items.oneOf;
    // 9 known block types + 1 "unknown/future" branch.
    expect(oneOf.length).toBe(10);
  });

  it("blocks PRESENT (non-empty) -> a closed set: only those types + the unknown-type branch", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["richText", "hero"] } } }) as any;
    const oneOf = doc.components.schemas["ItemEnvelope_article"].properties.blocks.items.oneOf;
    expect(oneOf.length).toBe(3); // richText + hero + unknown-type branch
    const constValues = oneOf.filter((b: any) => "properties" in b && b.properties.type.const).map((b: any) => b.properties.type.const);
    expect(constValues.sort()).toEqual(["hero", "richText"]);
  });

  it("blocks PRESENT and EMPTY, no fields -> this collection never carries page blocks", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { fixedstuff: { blocks: [] } } }) as any;
    const blocksSchema = doc.components.schemas["ItemEnvelope_fixedstuff"].properties.blocks;
    expect(blocksSchema.maxItems).toBe(0);
  });

  it("WSK-64: blocks PRESENT and EMPTY with fields -> exactly one block, the fields block (prefixItems)", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { fixedstuff: { blocks: [], fields: [{ name: "toPath", primitive: "text", required: true }] } } }) as any;
    const blocksSchema = doc.components.schemas["ItemEnvelope_fixedstuff"].properties.blocks;
    expect(blocksSchema.prefixItems).toEqual([{ $ref: "#/components/schemas/FieldsBlock_fixedstuff" }]);
    expect(blocksSchema.minItems).toBe(1);
    expect(blocksSchema.maxItems).toBe(1);
    expect(blocksSchema.items).toBeUndefined();
  });

  it("the unknown-type branch never restricts `type` to an enum (renderer invariant, §05 hard rule 2)", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["hero"] } } }) as any;
    const oneOf = doc.components.schemas["ItemEnvelope_article"].properties.blocks.items.oneOf;
    const unknownBranch = oneOf.find((b: any) => !("const" in (b.properties?.type ?? {})));
    expect(unknownBranch).toBeTruthy();
    expect(unknownBranch.properties.type.type).toBe("string");
  });
});

describe("openapi-builder — every field primitive maps to a JSON Schema fragment", () => {
  it("covers the 8 vocabulary 1.0.0 primitives, surfaced as the CollectionFields_* component", () => {
    const doc = buildOpenApiDocument({
      ...BASE_INPUT,
      composition: {
        kitchen_sink: {
          fields: [
            { name: "a", primitive: "text", required: true },
            { name: "b", primitive: "richtext" },
            { name: "c", primitive: "media", multiple: true },
            { name: "d", primitive: "relation", relationTo: "feature" },
            { name: "e", primitive: "number" },
            { name: "f", primitive: "date" },
            { name: "g", primitive: "select", options: ["x", "y"] },
            { name: "h", primitive: "geo" },
          ],
        },
      },
    }) as any;
    expect(doc.paths["/v1/t/unit-tenant/kitchen_sink"]).toBeTruthy();

    const fieldsSchema = doc.components.schemas["CollectionFields_kitchen_sink"];
    expect(fieldsSchema.required).toEqual(["a"]);
    expect(fieldsSchema.properties.a).toEqual({ type: "string" });
    expect(fieldsSchema.properties.c).toEqual({ type: "array", items: expect.objectContaining({ type: "object" }) });
    expect(fieldsSchema.properties.g).toEqual({ type: "string", enum: ["x", "y"] });
    expect(fieldsSchema.properties.h.properties.lat.type).toBe("number");

    // The pointer on the list operation is kept for existing readers (WSK-64 gave `fields` its wire
    // location: the fields block at blocks[0], whose props ARE this component).
    expect(doc.paths["/v1/t/unit-tenant/kitchen_sink"].get["x-webdesk-fields-schema"]).toEqual({
      $ref: "#/components/schemas/CollectionFields_kitchen_sink",
    });
  });

  it("WSK-64: maps group (closed, recursive), boolean, markdown, scalar multiple, itemKey and localized:false", () => {
    const doc = buildOpenApiDocument({
      ...BASE_INPUT,
      vocabularyVersion: "1.1.0",
      composition: {
        page: {
          blocks: [],
          fields: [
            { name: "publish_ready", primitive: "boolean", required: true },
            { name: "body", primitive: "markdown", required: true },
            { name: "schema", primitive: "text", multiple: true },
            { name: "plan", primitive: "group", fields: [{ name: "action", primitive: "select", options: ["SHOW"], required: true }, { name: "to", primitive: "text" }] },
            {
              name: "primary",
              primitive: "group",
              multiple: true,
              itemKey: "key",
              fields: [
                { name: "key", primitive: "text", required: true, localized: false },
                { name: "label", primitive: "text", required: true },
              ],
            },
          ],
        },
      },
    }) as any;
    const props = doc.components.schemas["CollectionFields_page"].properties;
    expect(doc.components.schemas["CollectionFields_page"].required).toEqual(["publish_ready", "body"]);
    expect(doc.components.schemas["CollectionFields_page"].additionalProperties).toBe(false);
    expect(props.publish_ready).toEqual({ type: "boolean" });
    expect(props.body.type).toBe("string");
    expect(props.body.contentMediaType).toBe("text/markdown");
    expect(props.schema).toEqual({ type: "array", items: { type: "string" } });
    expect(props.plan).toEqual({
      type: "object",
      properties: { action: { type: "string", enum: ["SHOW"] }, to: { type: "string" } },
      additionalProperties: false,
      required: ["action"],
    });
    expect(props.primary.type).toBe("array");
    expect(props.primary["x-webdesk-item-key"]).toBe("key");
    expect(props.primary.items.additionalProperties).toBe(false);
    expect(props.primary.items.properties.key).toEqual({ type: "string", "x-webdesk-localized": false });
  });
});

describe("openapi-builder — WSK-64 the fields block at blocks[0]", () => {
  const FIELDS = [{ name: "title", primitive: "text", required: true }] as const;

  it("FieldsBlock_<key> is { type: const 'fields', props: CollectionFields_<key> }, closed", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { page: { fields: [...FIELDS], blocks: [] } } }) as any;
    expect(doc.components.schemas["FieldsBlock_page"]).toEqual({
      type: "object",
      properties: { type: { const: "fields" }, props: { $ref: "#/components/schemas/CollectionFields_page" } },
      required: ["type", "props"],
      additionalProperties: false,
    });
  });

  it("generic blocks allowed after it -> the documented union fallback, fields block first, position stated", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { page: { fields: [...FIELDS], blocks: ["richText"] } } }) as any;
    const blocks = doc.components.schemas["ItemEnvelope_page"].properties.blocks;
    expect(blocks.prefixItems).toBeUndefined();
    expect(blocks.minItems).toBe(1);
    expect(blocks["x-webdesk-blocks-prefix"]).toBe("FieldsBlock_page");
    expect(blocks.items.oneOf[0]).toEqual({ $ref: "#/components/schemas/FieldsBlock_page" });
    expect(blocks.items.oneOf.length).toBe(3); // fields + richText + unknown
  });

  it("list items of a fields collection use ListItemEnvelope_<key>, which makes no positional claim", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { page: { fields: [...FIELDS], blocks: [] } } }) as any;
    expect(doc.components.schemas["ListEnvelope_page"].properties.items.items).toEqual({ $ref: "#/components/schemas/ListItemEnvelope_page" });
    const listBlocks = doc.components.schemas["ListItemEnvelope_page"].properties.blocks;
    expect(listBlocks.prefixItems).toBeUndefined();
    expect(listBlocks.minItems).toBeUndefined();
    expect(listBlocks.items.oneOf[0]).toEqual({ $ref: "#/components/schemas/FieldsBlock_page" });
  });

  it("a collection without fields produces no FieldsBlock/ListItemEnvelope components and no fields branch", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { article: { blocks: ["richText"] } } }) as any;
    const names = Object.keys(doc.components.schemas);
    expect(names.some((n) => n.startsWith("FieldsBlock_") || n.startsWith("ListItemEnvelope_") || n.startsWith("CollectionFields_"))).toBe(false);
    const oneOf = doc.components.schemas["ItemEnvelope_article"].properties.blocks.items.oneOf;
    expect(oneOf.some((b: any) => b.properties?.type?.const === "fields")).toBe(false);
  });

  it("an unrestricted composition never offers `fields` as a generic block", () => {
    const doc = buildOpenApiDocument({ ...BASE_INPUT, composition: { anything: {} } }) as any;
    const consts = doc.components.schemas["ItemEnvelope_anything"].properties.blocks.items.oneOf.map((b: any) => b.properties?.type?.const).filter(Boolean);
    expect(consts).not.toContain("fields");
    expect(consts.length).toBe(9);
  });
});
