// WSK-15 — hand-authors `openapi.v1.json` per tenant, from composition × vocabulary (WSK-D19:
// "the pipeline hand-authors openapi.v1.json only"). This is the ONE artifact this ticket's own
// code constructs directly; the TS SDK (sdk-ts.mts) and CONTENT-CONTRACT.md
// (content-contract-md.mts) are DERIVED from what this file builds, by standard tooling.
//
// This document must describe EXACTLY what `webdesk/payload/collections/router.ts` (WSK-06,
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
import type { BlockType } from "../../../../payload/vocabulary/blocks.ts";
import { BLOCKS, BLOCK_TYPE_NAMES } from "../../../../payload/vocabulary/blocks.ts";
import { ENVELOPE_VERSION } from "../../../../payload/vocabulary/version.ts";
import type { TenantComposition } from "../../../../payload/vocabulary/composition.ts";
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

function blockObjectSchema(type: BlockType): JsonSchema {
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
function collectionBlocksSchema(allowedBlocks: BlockType[] | undefined): JsonSchema {
  const types = allowedBlocks ?? BLOCK_TYPE_NAMES;
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
    items: { oneOf: [...types.map(blockObjectSchema), UNKNOWN_BLOCK_SCHEMA] },
  };
}

function itemEnvelopeSchema(allowedBlocks: BlockType[] | undefined): JsonSchema {
  return {
    type: "object",
    description: "webdesk/payload/vocabulary/envelope.ts's ItemEnvelope — frozen, identical for every tenant/collection except `blocks`, per design §05 hard rule 1 (\"the /v1 envelope is frozen\").",
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
      blocks: collectionBlocksSchema(allowedBlocks),
    },
    required: ["collection", "slug", "locale", "localizations", "seo", "meta", "blocks"],
  };
}

function listEnvelopeSchema(itemRef: string): JsonSchema {
  return {
    type: "object",
    description: "webdesk/payload/vocabulary/envelope.ts's ListEnvelope. `items[].blocks` is `[]` unless `?expand=blocks` (router.ts).",
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
    schemas[itemSchemaName] = itemEnvelopeSchema(comp.blocks);
    schemas[listSchemaName] = listEnvelopeSchema(`#/components/schemas/${itemSchemaName}`);

    // A collection's own `fields` composition (Layer 2, composition.ts) has NO distinct wire
    // location — content-read.ts serves it, if at all, folded into the generic free-form `seo`
    // object (see redirects.ts's own convention: `seo.redirect = {...}`), never as a separate
    // top-level ItemEnvelope property. Documenting it as an informational component + an
    // `x-webdesk-fields-schema` extension is honest about that: it describes the EDITORIAL
    // composition contract without claiming the read response exposes a dedicated `fields` key it
    // does not have.
    let fieldsSchemaRef: string | undefined;
    if (comp.fields && comp.fields.length > 0) {
      const fieldsSchemaName = `CollectionFields_${key}`;
      schemas[fieldsSchemaName] = {
        ...fieldsToObjectSchema(comp.fields),
        description: `"${key}"'s own composition-as-data fields (design §05 Layer 2). Informational only — not a distinct wire property; where this collection's content surfaces these values (if at all) is folded into the generic, free-form \`seo\` object (e.g. the fixed \`redirect\` collection's \`seo.redirect\`).`,
      };
      fieldsSchemaRef = `#/components/schemas/${fieldsSchemaName}`;
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
        `vocabulary v${input.vocabularyVersion}. Describes exactly what webdesk/payload/collections/router.ts ` +
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
