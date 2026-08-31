// VENDORED — copied verbatim from webdesk/payload/vocabulary/blocks.ts (WSK-06/WSK-14,
// frozen per webdesk-design.md §05). DO NOT HAND-EDIT THIS FILE.
//
// Regenerate with `npm run vendor:vocabulary` from webdesk/blocks/. Check for drift with
// `npm run vendor:check` (also runs as part of `npm run build` / `prepack`).
//
// Why a copy exists at all instead of a relative import: this package ships as an installable
// tarball to sites OUTSIDE this repo (WSK-16, OQ-6 — no registry infra), where
// `../../payload/vocabulary` will not exist. See scripts/vendor-vocabulary.mjs's header for
// the full reasoning. The vocabulary source above this banner is byte-identical to the real
// file — this script has never rewritten a single line of it.

// webdesk/payload/vocabulary/blocks.ts
//
// WSK-06 — the 9 block types (webdesk-design.md §05, Layer 1), each with a typed `props` schema
// built once from the primitives in ./primitives.ts. This is the shared code every tenant's page
// composition (Layer 2, collections.schema jsonb) draws its blocks from.
import { type FieldDef, validateField } from './primitives.ts'

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
}

export const BLOCK_TYPE_NAMES: BlockType[] = Object.keys(BLOCKS) as BlockType[]

export function isBlockType(v: string): v is BlockType {
  return (BLOCK_TYPE_NAMES as string[]).includes(v)
}

export interface BlockValidation {
  valid: boolean
  /** Empty when valid, or when the type is unknown (see the renderer-invariant note below). */
  errors: string[]
  /** True when `type` is not one of the 9 known block types. */
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
