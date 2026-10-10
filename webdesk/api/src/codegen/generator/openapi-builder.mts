// WSK-15 — hand-authors `openapi.v1.json` per tenant, from composition × vocabulary (WSK-D19:
// "the pipeline hand-authors openapi.v1.json only"). This is the ONE artifact this ticket's own
// code constructs directly; the TS SDK (sdk-ts.mts) and CONTENT-CONTRACT.md
// (content-contract-md.mts) are DERIVED from what this file builds, by standard tooling.
//
// This document must describe EXACTLY what `webdesk/api/src/delivery/router.ts` (WSK-06,
// frozen, DEV-VERIFIED) actually returns — per this ticket's brief ("the OpenAPI you author must
// describe exactly what these routes actually return") — not an aspirational or convenience
// shape. The correspondence, read directly off `router.ts` + `content-read.ts` + `redirects.ts`:
//
//   GET /v1/t/{tenantSlug}/{collectionKey}            -> listItems()   -> ListEnvelope
//   GET /v1/t/{tenantSlug}/{collectionKey}/{slug}      -> getItem()     -> ItemEnvelope | 404
//   GET /v1/t/{tenantSlug}/search?q=...                -> searchItems() -> ListEnvelope
//   GET /v1/t/{tenantSlug}/sitemap.xml                 -> renderSitemapXml() -> text/xml
//   every other shape                                  -> RFC 9457 problem+json (problem-details.ts)
//
// Auth: `Authorization: Bearer <plaintext key>` (auth.ts's `extractBearerKey`) — modelled as an
// OpenAPI `http`/`bearer` security scheme, applied globally (router.ts requires it on every path).
//
// Query params (`router.ts`'s own `url.searchParams` reads, restated exactly):
//   locale, cursor, limit (1-100, default 25), expand=blocks (list only), q + collection (search only).
//
// WSK-64 (vocabulary 1.1.0, ruling WSK-D44): a collection that declares `fields` carries its typed
// values as `blocks[0] = { type: "fields", props }`. How the item route describes that:
//   - composition `blocks: []` (no generic block may follow; every gaiada.com collection):
//     `prefixItems: [FieldsBlock_<key>]`, `minItems: 1`, `maxItems: 1`. openapi-typescript emits
//     the exact tuple `[FieldsBlock_<key>]`.
//   - generic blocks may follow: FALLBACK to `items.anyOf: [FieldsBlock_<key>, ...generic, unknown]`
//     with `minItems: 1` and `x-webdesk-blocks-prefix: "FieldsBlock_<key>"`. Why: openapi-typescript
//     7.13 renders `prefixItems` as a CLOSED tuple and silently drops `items`, so
//     `prefixItems: [F], items: {...}` became `[F]` and a valid page carrying a generic block after
//     the fields block would not type-check. Position is still stated in the description and the
//     extension; `validateItemContent` (delivery/vocabulary/item-fields.ts) enforces it at write time.
//
// `anyOf`, never `oneOf`, for every generic block `items` union (T2 / D-a): the unknown-block branch
// (UNKNOWN_BLOCK_SCHEMA: any string `type` + object `props`) is deliberately permissive, so a VALID
// known block matches both its own branch and that one. Under `oneOf` ("exactly one") a strict JSON
// Schema validator rejected every valid known block. `anyOf` ("at least one") accepts it. The branches
// overlap by design, so they are not disjoint and `oneOf` can never be right here. openapi-typescript
// renders both keywords as the same TS union, so the generated SDK types are unchanged.
// List routes strip blocks to `[]` unless `?expand=blocks` (router.ts), so a fields collection's list
// items use a separate `ListItemEnvelope_<key>` whose `blocks` makes no positional claim. A
// collection without `fields` produces exactly the 1.0.0 document.
import type { ComposableBlockType } from "../../../../delivery/vocabulary/blocks.ts";
import { BLOCKS, COMPOSABLE_BLOCK_TYPE_NAMES, FIELDS_BLOCK_TYPE } from "../../../../delivery/vocabulary/blocks.ts";
import { ENVELOPE_VERSION } from "../../../../delivery/vocabulary/version.ts";
import type { TenantComposition } from "../../../../delivery/vocabulary/composition.ts";
import { fieldsToObjectSchema, type JsonSchema } from "./vocabulary-field-schema.mts";

export interface OpenApiBuilderInput {
  tenantSlug: string;
  contractVersion: string;
  vocabularyVersion: string;
  defaultLocale: string;
  locales: string[];
  /** Excludes the fixed `redirect` collection (§05 v1.1: "modelled as data ... not new DDL", and
   *  never served through the generic list/item routes as page content — see `redirects.ts`'s own
   *  header: "a redirect is never page content and never flows through the block vocabulary").
   *  The caller (`fetch-composition.mts`) is responsible for this exclusion; this file trusts it. */
  composition: TenantComposition;
}

const PROBLEM_SCHEMA_NAME = "ProblemDetails";
const ITEM_SCHEMA_NAME = "ItemEnvelope";
const LIST_SCHEMA_NAME = "ListEnvelope";
const LIST_ITEM_SCHEMA_NAME = "ListItemEnvelope";

function blockObjectSchema(type: ComposableBlockType): JsonSchema {
  return {
    type: "object",
    properties: {
      type: { const: type },
      props: fieldsToObjectSchema(BLOCKS[type].fields),
    },
    required: ["type", "props"],
    additionalProperties: false,
  };
}

/** The unknown-block-type branch — design §05 hard rule 2 (the renderer invariant): a block type
 *  outside the closed set this collection currently declares is NOT a wire-level error (a
 *  vocabulary-MINOR addition must flow through an older pinned contract without breaking it), so
 *  the schema must accept it, not reject it. Kept permissive on purpose. */
const UNKNOWN_BLOCK_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "An unknown/future block type. Per design §05 hard rule 2 (the renderer invariant), a vocabulary-" +
    "MINOR addition (a new block type) must be able to flow through an older pinned contract without " +
    "becoming a read-time error here or a crash in the renderer — it is the RENDERER's job to skip " +
    "and report it, never this contract's job to reject it.",
  properties: { type: { type: "string" }, props: { type: "object" } },
  required: ["type", "props"],
};

/** A collection's `blocks` array schema — the ONE place a tenant's composition actually narrows
 *  the frozen envelope shape (see this file's header: nothing else about ItemEnvelope varies by
 *  collection, because the read path (`content-read.ts`) serves the same fixed shape for every
 *  collection key it knows). Composition interpretation carried verbatim from `composition.ts`'s
 *  own documented choice: `blocks` ABSENT = unrestricted (every known vocabulary block type may
 *  appear); `blocks` PRESENT (even `[]`) = a closed set. */
function collectionBlocksSchema(allowedBlocks: ComposableBlockType[] | undefined): JsonSchema {
  const types = allowedBlocks ?? COMPOSABLE_BLOCK_TYPE_NAMES;
  if (allowedBlocks !== undefined && allowedBlocks.length === 0) {
    return {
      type: "array",
      maxItems: 0,
      items: {},
      description: "This collection's composition declares an empty allowed-block set — it never carries page blocks (e.g. a fields-only collection like `redirect`).",
    };
  }
  return {
    type: "array",
    items: { anyOf: [...types.map(blockObjectSchema), UNKNOWN_BLOCK_SCHEMA] },
  };
}

/** WSK-64: the item route of a collection that declares `fields` — the fields block is always blocks[0].
 *  See this file's header for why only the closed case uses `prefixItems`. */
function fieldsCollectionItemBlocksSchema(
  allowedBlocks: ComposableBlockType[] | undefined,
  fieldsBlockRef: string,
  fieldsBlockName: string,
): JsonSchema {
  const closed = allowedBlocks !== undefined && allowedBlocks.length === 0;
  const lead = `blocks[0] is always the "${FIELDS_BLOCK_TYPE}" block carrying this collection's typed field values (vocabulary 1.1.0, ruling WSK-D44)`;
  if (closed) {
    return {
      type: "array",
      description: `${lead}; this collection allows no other blocks.`,
      prefixItems: [{ $ref: fieldsBlockRef }],
      minItems: 1,
      maxItems: 1,
    };
  }
  const types = allowedBlocks ?? COMPOSABLE_BLOCK_TYPE_NAMES;
  return {
    type: "array",
    description: `${lead}; the collection's generic blocks may follow it. (Expressed as a union, not prefixItems: see openapi-builder.mts's header.)`,
    "x-webdesk-blocks-prefix": fieldsBlockName,
    minItems: 1,
    items: { anyOf: [{ $ref: fieldsBlockRef }, ...types.map(blockObjectSchema), UNKNOWN_BLOCK_SCHEMA] },
  };
}

/** WSK-64: a list item of a fields collection — `[]` unless ?expand=blocks, so no positional claim. */
function fieldsCollectionListBlocksSchema(allowedBlocks: ComposableBlockType[] | undefined, fieldsBlockRef: string): JsonSchema {
  const types = allowedBlocks ?? COMPOSABLE_BLOCK_TYPE_NAMES;
  return {
    type: "array",
    description: `[] unless ?expand=blocks (router.ts). When expanded, blocks[0] is the "${FIELDS_BLOCK_TYPE}" block, as on the item route.`,
    items: { anyOf: [{ $ref: fieldsBlockRef }, ...types.map(blockObjectSchema), UNKNOWN_BLOCK_SCHEMA] },
  };
}

function itemEnvelopeSchema(allowedBlocks: ComposableBlockType[] | undefined, blocksOverride?: JsonSchema): JsonSchema {
  return {
    type: "object",
    description: "webdesk/delivery/vocabulary/envelope.ts's ItemEnvelope — frozen, identical for every tenant/collection except `blocks`, per design §05 hard rule 1 (\"the /v1 envelope is frozen\").",
    properties: {
      collection: { type: "string" },
      slug: { type: "string" },
      locale: { type: "string" },
      localizations: {
        type: "array",
        items: { type: "object", properties: { locale: { type: "string" }, slug: { type: "string" } }, required: ["locale", "slug"] },
      },
      seo: { type: "object", description: "Free-form jsonb (SeoShape) — title/description/ogImage are documented conventions, not an exhaustive schema.", additionalProperties: true },
      meta: {
        type: "object",
        properties: {
          publishedAt: { type: ["string", "null"], format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          draft: { type: "boolean" },
          x: { type: "object", description: "Reserved extension namespace (§05 v1.1) — additive forever.", additionalProperties: true },
        },
        required: ["publishedAt", "updatedAt", "draft", "x"],
      },
      blocks: blocksOverride ?? collectionBlocksSchema(allowedBlocks),
    },
    required: ["collection", "slug", "locale", "localizations", "seo", "meta", "blocks"],
  };
}

function listEnvelopeSchema(itemRef: string): JsonSchema {
  return {
    type: "object",
    description: "webdesk/delivery/vocabulary/envelope.ts's ListEnvelope. `items[].blocks` is `[]` unless `?expand=blocks` (router.ts).",
    properties: {
      collection: { type: "string" },
      locale: { type: "string" },
      items: { type: "array", items: { $ref: itemRef } },
      page: {
        type: "object",
        properties: { cursor: { type: ["string", "null"] }, hasMore: { type: "boolean" }, limit: { type: "integer" } },
        required: ["cursor", "hasMore", "limit"],
      },
    },
    required: ["collection", "locale", "items", "page"],
  };
}

const PROBLEM_DETAILS_SCHEMA: JsonSchema = {
  type: "object",
  description: "RFC 9457 Problem Details — the one error shape for every /v1 failure (design §05 v1.1, WSK-D18).",
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    requestId: { type: "string" },
  },
  required: ["type", "title", "status", "instance", "requestId"],
};

function problemResponse(description: string): JsonSchema {
  return { description, content: { "application/problem+json": { schema: { $ref: `#/components/schemas/${PROBLEM_SCHEMA_NAME}` } } } };
}

const LOCALE_PARAM: JsonSchema = { name: "locale", in: "query", required: false, schema: { type: "string" }, description: "Falls back to the tenant default when omitted or untranslated (design §05 locale rules)." };
const CURSOR_PARAM: JsonSchema = { name: "cursor", in: "query", required: false, schema: { type: "string" } };
const LIMIT_PARAM: JsonSchema = { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } };
const EXPAND_PARAM: JsonSchema = { name: "expand", in: "query", required: false, schema: { type: "string", enum: ["blocks"] }, description: "?expand=blocks inlines full block content in a list response (router.ts default: blocks stripped)." };

export function buildOpenApiDocument(input: OpenApiBuilderInput): Record<string, unknown> {
  const collectionKeys = Object.keys(input.composition).sort();

  const schemas: Record<string, unknown> = { [PROBLEM_SCHEMA_NAME]: PROBLEM_DETAILS_SCHEMA };
  const paths: Record<string, unknown> = {};

  for (const key of collectionKeys) {
    const itemSchemaName = `${ITEM_SCHEMA_NAME}_${key}`;
    const listSchemaName = `${LIST_SCHEMA_NAME}_${key}`;
    const comp = input.composition[key];

    // WSK-64 (vocabulary 1.1.0): a collection's own `fields` composition has ONE wire location — the
    // composition-typed `fields` block at blocks[0] (ruling WSK-D44; the envelope itself is unchanged).
    // `CollectionFields_<key>` is that block's `props` schema and `FieldsBlock_<key>` is the block.
    // The `x-webdesk-fields-schema` pointer on the list operation is kept for existing readers.
    let fieldsSchemaRef: string | undefined;
    let fieldsBlockRef: string | undefined;
    if (comp.fields !== undefined) {
      const fieldsSchemaName = `CollectionFields_${key}`;
      const fieldsBlockName = `FieldsBlock_${key}`;
      schemas[fieldsSchemaName] = {
        ...fieldsToObjectSchema(comp.fields),
        description: `"${key}"'s typed field values: the props of the "${FIELDS_BLOCK_TYPE}" block at blocks[0] (vocabulary 1.1.0). Closed: no other keys.`,
      };
      fieldsSchemaRef = `#/components/schemas/${fieldsSchemaName}`;
      schemas[fieldsBlockName] = {
        type: "object",
        properties: { type: { const: FIELDS_BLOCK_TYPE }, props: { $ref: fieldsSchemaRef } },
        required: ["type", "props"],
        additionalProperties: false,
      };
      fieldsBlockRef = `#/components/schemas/${fieldsBlockName}`;
    }

    if (fieldsBlockRef) {
      const listItemSchemaName = `${LIST_ITEM_SCHEMA_NAME}_${key}`;
      schemas[itemSchemaName] = itemEnvelopeSchema(comp.blocks, fieldsCollectionItemBlocksSchema(comp.blocks, fieldsBlockRef, `FieldsBlock_${key}`));
      schemas[listItemSchemaName] = itemEnvelopeSchema(comp.blocks, fieldsCollectionListBlocksSchema(comp.blocks, fieldsBlockRef));
      schemas[listSchemaName] = listEnvelopeSchema(`#/components/schemas/${listItemSchemaName}`);
    } else {
      schemas[itemSchemaName] = itemEnvelopeSchema(comp.blocks);
      schemas[listSchemaName] = listEnvelopeSchema(`#/components/schemas/${itemSchemaName}`);
    }

    const listPath = `/v1/t/${input.tenantSlug}/${key}`;
    paths[listPath] = {
      get: {
        operationId: `list_${key}`,
        summary: `List "${key}" items (cursor-paginated)`,
        ...(fieldsSchemaRef ? { "x-webdesk-fields-schema": { $ref: fieldsSchemaRef } } : {}),
        parameters: [LOCALE_PARAM, CURSOR_PARAM, LIMIT_PARAM, EXPAND_PARAM],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${listSchemaName}` } } } },
          "401": problemResponse("Missing or invalid API key."),
          "500": problemResponse("Internal error."),
        },
      },
    };

    paths[`${listPath}/{slug}`] = {
      get: {
        operationId: `get_${key}`,
        summary: `Read one "${key}" item by slug`,
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }, LOCALE_PARAM],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${itemSchemaName}` } } } },
          "401": problemResponse("Missing or invalid API key."),
          "404": problemResponse("No published item with this slug in this collection."),
          "500": problemResponse("Internal error."),
        },
      },
    };
  }

  // search — a single ListEnvelope shape spanning every collection (router.ts's `searchItems`),
  // items minus blocks always (never `?expand=blocks`-able, per content-read.ts's own comment).
  const searchItemSchemaName = `${ITEM_SCHEMA_NAME}_search`;
  const searchListSchemaName = `${LIST_SCHEMA_NAME}_search`;
  schemas[searchItemSchemaName] = itemEnvelopeSchema(undefined);
  schemas[searchListSchemaName] = listEnvelopeSchema(`#/components/schemas/${searchItemSchemaName}`);
  paths[`/v1/t/${input.tenantSlug}/search`] = {
    get: {
      operationId: "search",
      summary: "Full-text search across every collection (Postgres tsvector, per-locale config)",
      parameters: [
        { name: "q", in: "query", required: true, schema: { type: "string" } },
        { name: "collection", in: "query", required: false, schema: { type: "string", enum: collectionKeys } },
        LOCALE_PARAM,
        CURSOR_PARAM,
        LIMIT_PARAM,
      ],
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${searchListSchemaName}` } } } },
        "401": problemResponse("Missing or invalid API key."),
        "500": problemResponse("Internal error."),
      },
    },
  };

  paths[`/v1/t/${input.tenantSlug}/sitemap.xml`] = {
    get: {
      operationId: "sitemap",
      summary: "Generated sitemap.xml for the resolved locale (design §05 v1.1)",
      parameters: [LOCALE_PARAM],
      responses: {
        "200": { description: "OK", content: { "application/xml": { schema: { type: "string" } } } },
        "401": problemResponse("Missing or invalid API key."),
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: `WebDesk content contract — ${input.tenantSlug}`,
      version: input.contractVersion,
      description:
        `Hand-authored per design §05/§06 (WSK-D19) from tenant "${input.tenantSlug}"'s composition × ` +
        `vocabulary v${input.vocabularyVersion}. Describes exactly what webdesk/api/src/delivery/router.ts ` +
        `serves under the frozen ${ENVELOPE_VERSION} envelope path — see that file for the source of truth.`,
      "x-webdesk-contract": {
        tenantSlug: input.tenantSlug,
        vocabularyVersion: input.vocabularyVersion,
        defaultLocale: input.defaultLocale,
        locales: [...input.locales].sort(),
        collectionKeys,
      },
    },
    servers: [{ url: "https://{host}", variables: { host: { default: "staging.webdesk.internal", description: "The tenant's Zone B environment host (console shows the real per-site domain, design §08)." } } }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "A tenant/environment-scoped API key (WSK-05), never the raw plaintext beyond its one-time mint response." } },
      schemas,
    },
    paths,
  };
}
