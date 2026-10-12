// WSK-32 — builds the `llm.extract(kind=webdesk_schema)` prompt. The model's output is NEVER
// trusted structurally — every proposal it returns still goes through
// ./vocabulary-vendor.ts's `validateCollectionComposition` before anything downstream sees it
// (design §07's prompt-injection posture: "the model can only *propose*"). This file's only job
// is giving the model the best chance of proposing something valid; it does not change what gets
// accepted.
//
// T2 (D-b): teaches vocabulary 1.1.0; WSK-49a (1.2.0) adds the `ui.clientEditable` line. Every list the prompt states (primitives, composable block
// types, composition keys, widgets, the group depth) is read from the vendored vocabulary constants,
// never typed here, so a vocabulary change cannot leave the prompt teaching a stale rule. The block
// list is COMPOSABLE_BLOCK_TYPE_NAMES (BLOCK_TYPE_NAMES in ./vocabulary-vendor.ts): the composition-typed
// `fields` block is implied by declaring `fields` and is never offered as a block.
import {
  BLOCK_TYPE_NAMES,
  COMPOSITION_KEYS,
  FIELD_UI_KEYS,
  COLLECTION_UI_KEYS,
  FIELD_WIDGETS,
  MAX_GROUP_DEPTH,
  PRIMITIVE_NAMES,
  VOCABULARY_VERSION,
  type CollectionComposition,
} from "./vocabulary-vendor";

/** The tiny worked examples the prompt shows. Kept as data so a test can prove they pass the real validator. */
export const PROMPT_EXAMPLES = {
  group: { name: "address", primitive: "group", fields: [{ name: "city", primitive: "text" }, { name: "zip", primitive: "text" }] },
  itemKey: {
    name: "faq",
    primitive: "group",
    multiple: true,
    itemKey: "question",
    fields: [{ name: "question", primitive: "text", required: true }, { name: "answer", primitive: "markdown" }],
  },
  multiple: { name: "tags", primitive: "text", multiple: true },
  collection: {
    singleton: true,
    localized: false,
    ui: { label: "Site settings", titleField: "siteName" },
    lint: { placeholders: [{ kind: "marker", open: "[[", close: "]]", label: "TODO placeholder" }] },
    fields: [{ name: "siteName", primitive: "text", required: true }],
  },
} satisfies Record<string, unknown>;

export function buildSchemaDraftPrompt(input: { collectionKey: string; prd: string; currentSchema: CollectionComposition | null }): string {
  const currentBlock = input.currentSchema
    ? `The collection "${input.collectionKey}" ALREADY has this composition (propose changes relative to it, not a whole new one, unless the PRD clearly wants a full replacement):\n${JSON.stringify(input.currentSchema)}`
    : `The collection "${input.collectionKey}" does not exist yet — propose its composition from scratch.`;

  const ex = (v: unknown): string => JSON.stringify(v);

  return (
    `You are drafting a WebDesk Layer-2 "composition" for the collection "${input.collectionKey}", vocabulary ` +
    `v${VOCABULARY_VERSION}. A composition declares which vocabulary primitives/block types this collection is ` +
    `built from — it is a PROPOSAL only, never applied by you.\n\n` +
    `You MUST use ONLY these ${PRIMITIVE_NAMES.length} field primitives: ${PRIMITIVE_NAMES.join(", ")}.\n` +
    `You MUST use ONLY these ${BLOCK_TYPE_NAMES.length} block types in "blocks" (if the collection carries page blocks at all): ${BLOCK_TYPE_NAMES.join(", ")}. ` +
    `Never put "fields" in "blocks": the collection's own typed values are carried by an implicit block that exists as soon as you ` +
    `declare "fields", and listing it yourself is REJECTED.\n` +
    `Inventing any other primitive, block type or key will cause the proposal to be REJECTED before a human ever sees it.\n\n` +
    `${currentBlock}\n\n` +
    `PRD:\n${input.prd}\n\n` +
    `FIELD SHAPE. Each entry of "fields" is {"name": string, "primitive": <one of the primitives above>, ...optional keys}. ` +
    `"name" starts with a letter, then letters, digits or underscores, at most 64 characters. Optional keys: "required": boolean; ` +
    `"options": string[] (only for "select", non-empty); "relationTo": string (only for "relation", a collection key); ` +
    `"multiple": boolean; "fields": FieldDef[] (only for "group"); "itemKey": string (only for "group" with "multiple": true); ` +
    `"localized": boolean; "ui": {"label"?: string, "help"?: string, "readOnly"?: boolean, "widget"?: ${FIELD_WIDGETS.map((w) => `"${w}"`).join(" | ")}, "clientEditable"?: boolean} ` +
    `(editor-only hints, they never change the stored value; the "ui" keys are: ${FIELD_UI_KEYS.join(", ")}). No other key is allowed.\n` +
    `- "multiple": true works on EVERY primitive and means the value is an ordered list of that primitive. ` +
    `Example, a list of text values: ${ex(PROMPT_EXAMPLES.multiple)}\n` +
    `- "group" is a closed nested object. It REQUIRES a non-empty "fields" array holding its sub-fields (same shape as above). ` +
    `Groups may nest at most ${MAX_GROUP_DEPTH} levels deep. Example: ${ex(PROMPT_EXAMPLES.group)}\n` +
    `- "itemKey" is only for a "group" with "multiple": true (a list of objects). It names a sub-field of that group that is ` +
    `"primitive": "text" and "required": true and not "multiple"; its values must be unique across the list. ` +
    `Example: ${ex(PROMPT_EXAMPLES.itemKey)}\n\n` +
    `COLLECTION KEYS. The top-level object may carry only these keys: ${COMPOSITION_KEYS.join(", ")}.\n` +
    `- "fields" and "blocks" are described above ("blocks" lists block type names only).\n` +
    `- "singleton": boolean. true means at most one item per locale (site settings, a footer).\n` +
    `- "localized": boolean, default true. false means items exist only in the default locale.\n` +
    `- "ui": editor presentation {"label": string (REQUIRED), "description"?: string, "group"?: string, "order"?: number, ` +
    `"titleField"?: string naming a top-level field you declared, "clientEditable"?: boolean, "routePattern"?: string, e.g. "/blog/{slug}/" or "/{locale}/insights/{slug}/": the public page path of ` +
    `the collection's items, lowercase literal segments plus {slug} (required) and optional {locale}; omit it when unsure}. The "ui" keys are: ${COLLECTION_UI_KEYS.join(", ")}.\n` +
    `- "clientEditable" (in a collection's "ui" and in a field's "ui"): true means the CLIENT's own staff may edit that content in the client ` +
    `portal. A field inherits its group's value, a top-level field inherits the collection's, and the default is false. Set it true ONLY for ` +
    `copy the PRD says the client maintains; leave structure, settings and anything SEO-critical false ("seo" is never client-editable). ` +
    `It is editor metadata: it never changes a stored value.\n` +
    `- "lint": {"placeholders": [{"kind": "marker", "open": string, "close": string, "label": string} | ` +
    `{"kind": "token", "open": string, "close": string, "registry"?: {"collection", "listField", "keyField", "valueField"}}]} ` +
    `advisory checks only, literal delimiters, never a regex.\n` +
    `Example: ${ex(PROMPT_EXAMPLES.collection)}\n\n` +
    `Respond with ONLY a JSON object, no prose, using the keys above. ` +
    `Omit "fields" entirely if this collection carries no fields of its own. Omit "blocks" entirely if this ` +
    `collection's content is not restricted to a closed set of block types.`
  );
}
