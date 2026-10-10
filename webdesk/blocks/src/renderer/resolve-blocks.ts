// webdesk/blocks/src/renderer/resolve-blocks.ts
//
// WSK-16 — pure resolution logic for the renderer invariant (webdesk-design.md §05 hard rule 2):
// "an unknown block type renders nothing and reports". This file decides KNOWN vs UNKNOWN, using
// the vendored vocabulary's own `isBlockType` (the same function WSK-06's `validateBlock` uses,
// so this renderer's notion of "known" can never drift from the vocabulary's). It does no
// rendering itself — kept plain TypeScript, with zero Astro dependency, specifically so it is
// testable with `node --test` alone, no Astro build/Container API required.
//
// WSK-64 (vocabulary 1.1.0): the composition-typed `fields` block is KNOWN (it is in the vocabulary)
// but NON-VISUAL: it carries an item's typed field values for the site's own code to read, so the
// renderer draws nothing for it and does NOT report it as unknown. A renderer pinned to 1.0.0
// treats it as unknown instead, which is exactly the MINOR forward-compatibility path.
import { FIELDS_BLOCK_TYPE, isBlockType, type BlockType } from '../vocabulary/blocks.ts'

/** Block types the vocabulary knows that never render markup (1.1.0: only `fields`). */
export const NON_VISUAL_BLOCK_TYPES: readonly BlockType[] = [FIELDS_BLOCK_TYPE]

export function isNonVisualBlockType(type: string): boolean {
  return (NON_VISUAL_BLOCK_TYPES as readonly string[]).includes(type)
}

/** One `{ type, props }` entry as it arrives in an envelope's `blocks` array (envelope.ts's shape). */
export interface RawBlock {
  type: string
  props?: Record<string, unknown>
}

export interface ResolvedKnownBlock {
  index: number
  type: BlockType
  props: Record<string, unknown>
  known: true
}

export interface ResolvedUnknownBlock {
  index: number
  /** The raw, unrecognized type string — kept verbatim for the report, never coerced/guessed. */
  type: string
  props: Record<string, unknown>
  known: false
}

export type ResolvedBlock = ResolvedKnownBlock | ResolvedUnknownBlock

/**
 * Resolves every block in an envelope's `blocks` array against the vocabulary, preserving order.
 * Never throws — an unrecognized `type` string, missing `props`, or any other malformed-but-
 * present entry resolves to `known: false` rather than raising, because a resolution failure here
 * is exactly the scenario the renderer invariant exists to survive (a vocabulary-MINOR block type
 * this renderer's pinned version predates).
 */
export function resolveBlocks(blocks: RawBlock[]): ResolvedBlock[] {
  return blocks.map((block, index) => {
    const props = block.props ?? {}
    if (isBlockType(block.type)) {
      return { index, type: block.type, props, known: true as const }
    }
    return { index, type: block.type, props, known: false as const }
  })
}

/** Convenience split, useful in tests and in any host that wants counts without re-walking the array. */
export function partitionResolvedBlocks(resolved: ResolvedBlock[]): {
  known: ResolvedKnownBlock[]
  unknown: ResolvedUnknownBlock[]
} {
  const known: ResolvedKnownBlock[] = []
  const unknown: ResolvedUnknownBlock[] = []
  for (const b of resolved) {
    if (b.known) known.push(b)
    else unknown.push(b)
  }
  return { known, unknown }
}
