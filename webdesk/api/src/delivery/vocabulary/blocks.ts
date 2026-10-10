// VENDORED — generated from webdesk/delivery/vocabulary/blocks.ts (WSK-06/WSK-14, frozen per
// webdesk-design.md §05) by webdesk/api/src/delivery/vocabulary/vendor.mjs. DO NOT HAND-EDIT.
// The only transform: LF line endings and relative '.ts' import extensions stripped (this
// package is CommonJS). Re-vendor with `node src/delivery/vocabulary/vendor.mjs`; drift is
// caught by test/delivery/vocabulary-vendor-drift.spec.ts.

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
}

/** 1.1.0: the one composition-typed block type. */
export const FIELDS_BLOCK_TYPE = 'fields' as const

/** The block types a composition may list in `blocks`: every block type except `fields`. */
export type ComposableBlockType = Exclude<BlockType, typeof FIELDS_BLOCK_TYPE>

export const BLOCK_TYPE_NAMES: BlockType[] = Object.keys(BLOCKS) as BlockType[]

export function isBlockType(v: string): v is BlockType {
  return (BLOCK_TYPE_NAMES as string[]).includes(v)
}

/** 1.1.0: the 9 generic (visual) block types: what a composition's `blocks` may list. */
export const COMPOSABLE_BLOCK_TYPE_NAMES: ComposableBlockType[] = BLOCK_TYPE_NAMES.filter(
  (t): t is ComposableBlockType => t !== FIELDS_BLOCK_TYPE,
)

export function isComposableBlockType(v: string): v is ComposableBlockType {
  return (COMPOSABLE_BLOCK_TYPE_NAMES as string[]).includes(v)
}

export interface BlockValidation {
  valid: boolean
  /** Empty when valid, or when the type is unknown (see the renderer-invariant note below). */
  errors: string[]
  /** True when `type` is not one of the known block types (the 9 generic ones plus `fields`). */
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
