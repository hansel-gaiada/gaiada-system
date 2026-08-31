// WSK-32 — builds the `llm.extract(kind=webdesk_schema)` prompt. The model's output is NEVER
// trusted structurally — every proposal it returns still goes through
// ./vocabulary-vendor.ts's `validateCollectionComposition` before anything downstream sees it
// (design §07's prompt-injection posture: "the model can only *propose*"). This file's only job
// is giving the model the best chance of proposing something valid; it does not change what gets
// accepted.
import { BLOCK_TYPE_NAMES, PRIMITIVE_NAMES, VOCABULARY_VERSION, type CollectionComposition } from "./vocabulary-vendor";

export function buildSchemaDraftPrompt(input: { collectionKey: string; prd: string; currentSchema: CollectionComposition | null }): string {
  const currentBlock = input.currentSchema
    ? `The collection "${input.collectionKey}" ALREADY has this composition (propose changes relative to it, not a whole new one, unless the PRD clearly wants a full replacement):\n${JSON.stringify(input.currentSchema)}`
    : `The collection "${input.collectionKey}" does not exist yet — propose its composition from scratch.`;

  return (
    `You are drafting a WebDesk Layer-2 "composition" for the collection "${input.collectionKey}", vocabulary ` +
    `v${VOCABULARY_VERSION}. A composition declares which vocabulary primitives/block types this collection is ` +
    `built from — it is a PROPOSAL only, never applied by you.\n\n` +
    `You MUST use ONLY these ${PRIMITIVE_NAMES.length} field primitives: ${PRIMITIVE_NAMES.join(", ")}.\n` +
    `You MUST use ONLY these ${BLOCK_TYPE_NAMES.length} block types (if the collection carries page blocks at all): ${BLOCK_TYPE_NAMES.join(", ")}.\n` +
    `Inventing any other primitive or block type will cause the proposal to be REJECTED before a human ever sees it.\n\n` +
    `${currentBlock}\n\n` +
    `PRD:\n${input.prd}\n\n` +
    `Respond with ONLY a JSON object, no prose, of the exact shape:\n` +
    `{"fields": [{"name": string, "primitive": <one of the primitives above>, "required": boolean (optional), ` +
    `"options": string[] (only for "select"), "relationTo": string (only for "relation")}], ` +
    `"blocks": [<one of the block types above>]}\n` +
    `Omit "fields" entirely if this collection carries no flat fields of its own. Omit "blocks" entirely if this ` +
    `collection's content is not restricted to a closed set of block types.`
  );
}
