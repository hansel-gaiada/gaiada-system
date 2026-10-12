// VENDORED from webdesk/delivery/vocabulary/blocks.ts by platform-nest/scripts/vendor-webdesk-vocabulary.mjs (WSK-49c).
// DO NOT HAND-EDIT. Regenerate with `npm run vendor:webdesk-vocabulary`; `npm run vendor:check` (and the test
// suite) fails when this file and its source disagree. The only change from the source is that a relative
// import's `.ts` suffix is dropped (this package compiles to CommonJS with tsc).

// webdesk/payload/vocabulary/blocks.ts
//
// WSK-06 — the 9 block types (webdesk-design.md §05, Layer 1), each with a typed `props` schema
// built once from the primitives in ./primitives.ts. This is the shared code every tenant's page
// composition (Layer 2, collections.schema jsonb) draws its blocks from.
//
// WSK-64 (vocabulary 1.1.0, ruling WSK-D44) adds ONE block type, `fields`: the composition-typed
// block. It carries an item's typed field values as `{ type: 'fields', props: {...} }` at
// `blocks[0]`, and its props are typed by the collection's composition, NOT by the vocabulary —
// so its vocabulary `fields` list is empty and `validateBlock` treats it as a known block with no
// vocabulary props. The composition-aware check lives in ./item-fields.ts. The 9 generic blocks
// are unchanged. `fields` is never listed in a composition's `blocks` (see COMPOSABLE_BLOCK_TYPE_NAMES)
// and is non-visual: a renderer resolves it as known and renders nothing for it.
//
// M5-V5-a (vocabulary 1.5.0) adds a second such block type, `experiment`: an A/B test over one other block of the
// item (design docs/plans/2026-10-12-m5-phase5-design.md section 5.1). Like `fields` its props are not typed here (its
// vocabulary `fields` list is empty): their shape is checked by ./item-fields.ts, where the item's own fields and
// blocks are in reach. It is non-composable (allowed in any collection without being listed, at most one per item,
// never at index 0), non-visual, and never client-editable (./client-editable.ts).
import { type FieldDef, validateField } from './primitives'

export type BlockType =
  | 'hero'
  | 'richText'
  | 'gallery'
  | 'cta'
  | 'featureGrid'
  | 'form'
  | 'testimonial'
  | 'faq'
  | 'logoCloud'
  | 'fields'
  | 'experiment'

export interface BlockDef {
  type: BlockType
  fields: FieldDef[]
}

export const BLOCKS: Record<BlockType, BlockDef> = {
  hero: {
    type: 'hero',
    fields: [
      { name: 'heading', primitive: 'text', required: true },
      { name: 'subheading', primitive: 'text' },
      { name: 'media', primitive: 'media' },
      { name: 'ctaLabel', primitive: 'text' },
      { name: 'ctaHref', primitive: 'text' },
    ],
  },
  richText: {
    type: 'richText',
    fields: [{ name: 'content', primitive: 'richtext', required: true }],
  },
  gallery: {
    type: 'gallery',
    fields: [
      { name: 'items', primitive: 'media', multiple: true, required: true },
      { name: 'caption', primitive: 'text' },
    ],
  },
  cta: {
    type: 'cta',
    fields: [
      { name: 'heading', primitive: 'text', required: true },
      { name: 'body', primitive: 'text' },
      { name: 'buttonLabel', primitive: 'text', required: true },
      { name: 'buttonHref', primitive: 'text', required: true },
    ],
  },
  featureGrid: {
    type: 'featureGrid',
    fields: [
      { name: 'heading', primitive: 'text' },
      // Each grid item is itself { heading, body, icon } — modelled as a relation to a
      // conceptual `feature` sub-collection rather than a nested-object primitive (there is no
      // "object" primitive in the frozen 8; relation is the vocabulary's own composition
      // mechanism for "one of several structured things").
      { name: 'items', primitive: 'relation', relationTo: 'feature', multiple: true, required: true },
    ],
  },
  form: {
    type: 'form',
    fields: [{ name: 'formKey', primitive: 'relation', relationTo: 'form_defs', required: true }],
  },
  testimonial: {
    type: 'testimonial',
    fields: [
      { name: 'quote', primitive: 'richtext', required: true },
      { name: 'author', primitive: 'text', required: true },
      { name: 'role', primitive: 'text' },
      { name: 'avatar', primitive: 'media' },
    ],
  },
  faq: {
    type: 'faq',
    fields: [
      { name: 'heading', primitive: 'text' },
      { name: 'items', primitive: 'relation', relationTo: 'faqItem', multiple: true, required: true },
    ],
  },
  logoCloud: {
    type: 'logoCloud',
    fields: [
      { name: 'heading', primitive: 'text' },
      { name: 'logos', primitive: 'media', multiple: true, required: true },
    ],
  },
  // 1.1.0: the composition-typed block. Empty on purpose: its props are typed per collection.
  fields: { type: 'fields', fields: [] },
  // 1.5.0: the A/B-test block. Empty on purpose: its props are checked per item (item-fields.ts).
  experiment: { type: 'experiment', fields: [] },
}

/** 1.1.0: the one composition-typed block type. */
export const FIELDS_BLOCK_TYPE = 'fields' as const

/** 1.5.0: the A/B-test block type. */
export const EXPERIMENT_BLOCK_TYPE = 'experiment' as const

/** The block types no composition lists in `blocks`: each is implied by something else (`fields` by declaring fields, `experiment` by being allowed everywhere). */
export const NON_COMPOSABLE_BLOCK_TYPE_NAMES: readonly BlockType[] = [FIELDS_BLOCK_TYPE, EXPERIMENT_BLOCK_TYPE]

/** The block types a composition may list in `blocks`: every block type except `fields` and `experiment`. */
export type ComposableBlockType = Exclude<BlockType, typeof FIELDS_BLOCK_TYPE | typeof EXPERIMENT_BLOCK_TYPE>

export const BLOCK_TYPE_NAMES: BlockType[] = Object.keys(BLOCKS) as BlockType[]

export function isBlockType(v: string): v is BlockType {
  return (BLOCK_TYPE_NAMES as string[]).includes(v)
}

/** 1.1.0: the 9 generic (visual) block types: what a composition's `blocks` may list (1.5.0 still 9: `experiment` is not one). */
export const COMPOSABLE_BLOCK_TYPE_NAMES: ComposableBlockType[] = BLOCK_TYPE_NAMES.filter(
  (t): t is ComposableBlockType => t !== FIELDS_BLOCK_TYPE && t !== EXPERIMENT_BLOCK_TYPE,
)

export function isComposableBlockType(v: string): v is ComposableBlockType {
  return (COMPOSABLE_BLOCK_TYPE_NAMES as string[]).includes(v)
}

export interface BlockValidation {
  valid: boolean
  /** Empty when valid, or when the type is unknown (see the renderer-invariant note below). */
  errors: string[]
  /** True when `type` is not one of the known block types (the 9 generic ones plus `fields` and `experiment`). */
  unknownType: boolean
}

/**
 * Validates one `{ type, props }` block entry against the vocabulary.
 *
 * Renderer invariant (design §05, "Hard rules" (2)): an unknown block `type` is deliberately
 * NEVER a validation failure here — `valid: true, unknownType: true`. The frozen contract's
 * compensating invariant is that an unknown block type renders nothing and reports (console +
 * QA), so a vocabulary-MINOR addition (a new block type) can flow through an older pinned site
 * without ever becoming a write-time or read-time error. Only a KNOWN type with malformed props
 * is a real validation error.
 */
export function validateBlock(block: { type: string; props?: unknown }): BlockValidation {
  if (!isBlockType(block.type)) {
    return { valid: true, errors: [], unknownType: true }
  }
  const def = BLOCKS[block.type]
  const props = (block.props ?? {}) as Record<string, unknown>
  const errors = def.fields.flatMap((f) => validateField(f, props[f.name]))
  return { valid: errors.length === 0, errors, unknownType: false }
}
