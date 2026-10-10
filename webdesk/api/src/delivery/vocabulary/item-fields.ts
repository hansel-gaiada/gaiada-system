// VENDORED — generated from webdesk/payload/vocabulary/item-fields.ts (WSK-06/WSK-14, frozen per
// webdesk-design.md §05) by webdesk/api/src/delivery/vocabulary/vendor.mjs. DO NOT HAND-EDIT.
// The only transform: LF line endings and relative '.ts' import extensions stripped (this
// package is CommonJS). Re-vendor with `node src/delivery/vocabulary/vendor.mjs`; drift is
// caught by test/delivery/vocabulary-vendor-drift.spec.ts.

// webdesk/payload/vocabulary/item-fields.ts
//
// WSK-64 (vocabulary 1.1.0, ruling WSK-D44, write-plane design §2.2) — the composition-aware
// content check. An item's typed field values travel as ONE block, `{ type: 'fields', props }`,
// which is always `blocks[0]` when the collection's composition declares `fields`. Its props are
// typed by the composition, not by the vocabulary, so `validateBlock` (./blocks.ts) only knows the
// block exists; this file checks what is inside it, and where it sits.
//
// What `validateItemContent` enforces:
//   * a `fields` block exists IFF `composition.fields` is declared, it is at index 0, and it appears once;
//   * the remaining blocks are in `composition.blocks` (absent = every generic block type, never `fields`),
//     and a known generic block's props pass `validateBlock`;
//   * the fields block's props are closed, typed and recursive, and the composition's group nesting is <= 4;
//   * `itemKey` values are unique per list, and every `multiple` value is an array (validateFieldValue).
//
// Write-time only. The read path never calls this: on read, an unknown block type stays valid and
// is skipped by the renderer (design §05 hard rule 2). At write time an unknown type is an authoring
// mistake, exactly as composition.ts treats an unknown type in a composition.
//
// Values are never modified: markdown and every other string are checked verbatim.
//
// The `redirect` system collection is the one documented exception (write-plane design §2.7): its
// values live under `seo.redirect`, so WSK-41's write path does not run it through this check.
import { MAX_GROUP_DEPTH, pointerSegment, validateFieldValue, type FieldDef } from './primitives'
import { COMPOSABLE_BLOCK_TYPE_NAMES, FIELDS_BLOCK_TYPE, isBlockType, isComposableBlockType, validateBlock } from './blocks'
import type { CollectionComposition } from './composition'

export { FIELDS_BLOCK_TYPE }

/** One content problem. `path` is an RFC 6901 JSON pointer into the item, e.g. `/blocks/0/props/faq/2/answer`. */
export interface ItemIssue {
  path: string
  message: string
  expected?: string
}

export interface ItemContentValidation {
  valid: boolean
  issues: ItemIssue[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function itemIssue(path: string, message: string, expected?: string): ItemIssue {
  return expected ? { path, message, expected } : { path, message }
}

/** Composition-side guard: group nesting deeper than MAX_GROUP_DEPTH makes the item uncheckable. */
function groupDepthIssues(fields: FieldDef[], ptr: string, depth: number): ItemIssue[] {
  const out: ItemIssue[] = []
  for (const f of fields) {
    if (!isPlainObject(f) || f.primitive !== 'group') continue
    const d = depth + 1
    const at = `${ptr}/${pointerSegment(String(f.name))}`
    if (d > MAX_GROUP_DEPTH) {
      out.push(itemIssue(at, `the composition nests groups deeper than ${MAX_GROUP_DEPTH} (depth ${d}); fix the composition first`, `depth <= ${MAX_GROUP_DEPTH}`))
    } else if (Array.isArray(f.fields)) {
      out.push(...groupDepthIssues(f.fields, f.multiple ? `${at}/-` : at, d))
    }
  }
  return out
}

/**
 * Validates a fields-block `props` object against a FieldDef list. Closed: a key the composition
 * does not declare is a violation. `path` is the pointer of `props` itself.
 */
export function validateFieldValues(fields: FieldDef[], props: unknown, path = ''): ItemIssue[] {
  const depthIssues = groupDepthIssues(fields, path, 0)
  if (depthIssues.length > 0) return depthIssues
  if (!isPlainObject(props)) {
    return [itemIssue(path, 'expected an object of field values', `{ ${fields.map((f) => f.name).join(', ')} }`)]
  }
  const issues: ItemIssue[] = []
  const declared = new Set(fields.map((f) => f.name))
  for (const k of Object.keys(props)) {
    if (!declared.has(k)) {
      issues.push(itemIssue(`${path}/${pointerSegment(k)}`, `unknown field "${k}": the fields block is closed to the composition's fields`, [...declared].join(' | ')))
    }
  }
  for (const f of fields) {
    issues.push(...validateFieldValue(f, props[f.name], `${path}/${pointerSegment(f.name)}`))
  }
  return issues
}

/** Validates an item's whole `blocks` array against its collection's composition. Pure, synchronous. */
export function validateItemContent(composition: CollectionComposition, blocks: unknown): ItemContentValidation {
  if (!Array.isArray(blocks)) {
    return { valid: false, issues: [itemIssue('/blocks', 'blocks must be an array', '[{ type, props }, ...]')] }
  }
  const issues: ItemIssue[] = []
  const declaresFields = Array.isArray(composition.fields)
  const allowed = composition.blocks ?? COMPOSABLE_BLOCK_TYPE_NAMES
  const fieldsAt: number[] = []

  blocks.forEach((b, i) => {
    const at = `/blocks/${i}`
    if (!isPlainObject(b) || typeof b.type !== 'string') {
      issues.push(itemIssue(at, 'expected a block object { type: string, props: object }'))
      return
    }
    if (b.props !== undefined && !isPlainObject(b.props)) {
      issues.push(itemIssue(`${at}/props`, 'block props must be an object'))
      return
    }
    if (b.type === FIELDS_BLOCK_TYPE) {
      fieldsAt.push(i)
      return
    }
    if (!isComposableBlockType(b.type) || !(allowed as string[]).includes(b.type)) {
      const why = isBlockType(b.type) ? "is not allowed by this collection's composition" : 'is not a vocabulary block type'
      issues.push(itemIssue(`${at}/type`, `block type "${b.type}" ${why}`, (allowed as string[]).join(' | ') || '(no blocks allowed)'))
      return
    }
    const v = validateBlock({ type: b.type, props: b.props })
    for (const e of v.errors) issues.push(itemIssue(`${at}/props`, e))
  })

  if (declaresFields) {
    if (fieldsAt.length === 0) {
      issues.push(itemIssue('/blocks/0', `missing the "${FIELDS_BLOCK_TYPE}" block: this collection declares fields, so blocks[0] must be { type: "${FIELDS_BLOCK_TYPE}", props }`))
    } else {
      if (fieldsAt[0] !== 0) {
        issues.push(itemIssue(`/blocks/${fieldsAt[0]}`, `the "${FIELDS_BLOCK_TYPE}" block must be blocks[0] (found at index ${fieldsAt[0]})`))
      }
      for (const extra of fieldsAt.slice(1)) {
        issues.push(itemIssue(`/blocks/${extra}`, `duplicate "${FIELDS_BLOCK_TYPE}" block: it appears exactly once`))
      }
      const first = blocks[fieldsAt[0]] as Record<string, unknown>
      issues.push(...validateFieldValues(composition.fields as FieldDef[], first.props ?? {}, `/blocks/${fieldsAt[0]}/props`))
    }
  } else {
    for (const i of fieldsAt) {
      issues.push(itemIssue(`/blocks/${i}`, `this collection declares no fields, so a "${FIELDS_BLOCK_TYPE}" block is not allowed`))
    }
  }

  return { valid: issues.length === 0, issues }
}

/** The fields block's props when `blocks[0]` is a well-formed fields block; otherwise null. */
export function fieldsBlockOf(blocks: unknown): Record<string, unknown> | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  const b = blocks[0]
  if (!isPlainObject(b) || b.type !== FIELDS_BLOCK_TYPE || !isPlainObject(b.props)) return null
  return b.props
}
