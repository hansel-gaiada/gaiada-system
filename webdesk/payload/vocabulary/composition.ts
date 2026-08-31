// webdesk/payload/vocabulary/composition.ts
//
// WSK-14 — the composition validator (webdesk-design.md §05 Layer 2: "A tenant's collections are
// arrangements of Layer-1 primitives stored as schema data (`collections.schema` jsonb), validated
// by the composition validator (WSK-14) against the vocabulary version.").
//
// Scope note on what this file does NOT do: it does not validate CONTENT (a content_items row's
// actual `blocks` array against a block's props) — that is `./blocks.ts`'s `validateBlock`,
// already shipped by WSK-06, and it deliberately treats an unknown block TYPE as valid (the
// renderer invariant — see blocks.ts's own doc comment and test/wsk14-renderer-invariant.test.mjs).
// This file validates the COMPOSITION ITSELF — the tenant-authored (or AI-drafted, WSK-32)
// declaration of which primitives/block types a collection is built from — which is a different
// moment with a different correctness rule: a composition proposing a primitive or block type that
// does not exist in the vocabulary is an authoring mistake, not a forward-compatibility scenario,
// and must be rejected loudly with an actionable error (design's WSK-14 AC: "rejects
// out-of-vocabulary constructs with actionable errors").
import { PRIMITIVE_NAMES, isPrimitiveName, type FieldDef } from './primitives.ts'
import { BLOCK_TYPE_NAMES, isBlockType, type BlockType } from './blocks.ts'
import { VOCABULARY_VERSION } from './version.ts'

/**
 * `collections.schema` jsonb (migrations/0002_content.sql), Layer-2 composition-as-data.
 *
 * `fields` — flat fields on the collection ITSELF, reusing the exact `FieldDef` shape Layer 1
 * already defines for a block's own fields (§05: compositions are "arrangements of Layer-1
 * primitives" — there is no second field-definition vocabulary). Used by fixed/data-only
 * collections that carry no page blocks at all (e.g. the `redirect` collection, redirects.ts).
 *
 * `blocks` — the block types THIS collection's `content_items.blocks` may use. **Interpretation
 * choice (flagged in the ticket report):** presence of this key, even as `[]`, is a deliberate
 * closed set; ABSENCE of the key means "no restriction declared" (any known vocabulary block type
 * may appear). Nothing shipped before this ticket disambiguated that, since no page collection in
 * the WSK-06 fixtures ever populated `collections.schema` at all (createFixtureCollection leaves
 * it at its DB default `{}` — verified by reading test/v1-fixtures.mjs).
 */
export interface CollectionComposition {
  fields?: FieldDef[]
  blocks?: BlockType[]
}

/** A whole tenant's collections, keyed by `collections.key` (§04). What WSK-19/WSK-15's codegen
 *  input and the WSK-32 AI drafting flow's proposal object both compile from/into. */
export type TenantComposition = Record<string, CollectionComposition>

export interface CompositionIssue {
  /** JSON-pointer-ish path to the offending construct, e.g. `case-study.fields[2].primitive` or
   *  `article.blocks[1]` — always names the exact location, never just "invalid" (WSK-14 AC). */
  path: string
  message: string
  /** What would have been accepted there, when it is renderable as a short string. */
  expected?: string
}

export interface CompositionValidationResult {
  valid: boolean
  issues: CompositionIssue[]
}

const KNOWN_COLLECTION_KEYS = new Set(['fields', 'blocks'])
const KNOWN_FIELD_KEYS = new Set(['name', 'primitive', 'required', 'options', 'relationTo', 'multiple'])

function issue(path: string, message: string, expected?: string): CompositionIssue {
  return expected ? { path, message, expected } : { path, message }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateFieldDef(path: string, raw: unknown): CompositionIssue[] {
  if (!isPlainObject(raw)) {
    return [issue(path, 'expected a field object', '{ name: string, primitive: <vocabulary primitive>, ... }')]
  }
  const issues: CompositionIssue[] = []
  const f = raw

  for (const k of Object.keys(f)) {
    if (!KNOWN_FIELD_KEYS.has(k)) {
      issues.push(issue(`${path}.${k}`, `unknown field key "${k}" — not part of the vocabulary's FieldDef shape`, [...KNOWN_FIELD_KEYS].sort().join(' | ')))
    }
  }

  if (typeof f.name !== 'string' || f.name.trim().length === 0) {
    issues.push(issue(`${path}.name`, 'field name must be a non-empty string', 'string'))
  }

  if (typeof f.primitive !== 'string') {
    issues.push(issue(`${path}.primitive`, 'primitive must be a string', PRIMITIVE_NAMES.join(' | ')))
  } else if (!isPrimitiveName(f.primitive)) {
    issues.push(
      issue(`${path}.primitive`, `"${f.primitive}" is not one of the ${PRIMITIVE_NAMES.length} vocabulary primitives`, PRIMITIVE_NAMES.join(' | ')),
    )
  } else {
    if (f.primitive === 'select') {
      const opts = f.options
      if (!Array.isArray(opts) || opts.length === 0 || !opts.every((o) => typeof o === 'string')) {
        issues.push(issue(`${path}.options`, 'a "select" field requires a non-empty array of string options', 'string[]'))
      }
    }
    if (f.primitive === 'relation') {
      if (typeof f.relationTo !== 'string' || f.relationTo.trim().length === 0) {
        issues.push(issue(`${path}.relationTo`, 'a "relation" field requires a non-empty relationTo', 'string (a collection key)'))
      }
    }
  }

  if (f.required !== undefined && typeof f.required !== 'boolean') {
    issues.push(issue(`${path}.required`, 'required must be a boolean when present', 'boolean'))
  }
  if (f.multiple !== undefined && typeof f.multiple !== 'boolean') {
    issues.push(issue(`${path}.multiple`, 'multiple must be a boolean when present', 'boolean'))
  }

  return issues
}

/** Validates ONE collection's `schema` jsonb value against the vocabulary. Pure, synchronous. */
export function validateCollectionComposition(collectionKey: string, raw: unknown): CompositionValidationResult {
  if (!isPlainObject(raw)) {
    return {
      valid: false,
      issues: [issue(collectionKey, 'expected a composition object', '{ fields?: FieldDef[], blocks?: BlockType[] }')],
    }
  }

  const issues: CompositionIssue[] = []
  const c = raw

  for (const k of Object.keys(c)) {
    if (!KNOWN_COLLECTION_KEYS.has(k)) {
      issues.push(
        issue(`${collectionKey}.${k}`, `unknown composition key "${k}" — not part of the Layer-2 composition shape`, [...KNOWN_COLLECTION_KEYS].sort().join(' | ')),
      )
    }
  }

  if (c.fields !== undefined) {
    if (!Array.isArray(c.fields)) {
      issues.push(issue(`${collectionKey}.fields`, 'fields must be an array', 'FieldDef[]'))
    } else {
      const seen = new Set<string>()
      c.fields.forEach((f, i) => {
        const path = `${collectionKey}.fields[${i}]`
        issues.push(...validateFieldDef(path, f))
        const name = isPlainObject(f) && typeof f.name === 'string' ? f.name : null
        if (name) {
          if (seen.has(name)) {
            issues.push(issue(`${path}.name`, `duplicate field name "${name}" within collection "${collectionKey}"`))
          }
          seen.add(name)
        }
      })
    }
  }

  if (c.blocks !== undefined) {
    if (!Array.isArray(c.blocks)) {
      issues.push(issue(`${collectionKey}.blocks`, 'blocks must be an array', 'BlockType[]'))
    } else {
      const seen = new Set<string>()
      c.blocks.forEach((b, i) => {
        const path = `${collectionKey}.blocks[${i}]`
        if (typeof b !== 'string') {
          issues.push(issue(path, 'a block-type entry must be a string', BLOCK_TYPE_NAMES.join(' | ')))
        } else if (!isBlockType(b)) {
          issues.push(issue(path, `"${b}" is not one of the ${BLOCK_TYPE_NAMES.length} vocabulary block types`, BLOCK_TYPE_NAMES.join(' | ')))
        } else if (seen.has(b)) {
          issues.push(issue(path, `duplicate block type "${b}" declared for collection "${collectionKey}"`))
        } else {
          seen.add(b)
        }
      })
    }
  }

  return { valid: issues.length === 0, issues }
}

export interface ValidateTenantCompositionOptions {
  /** Validate against a specific vocabulary version rather than the current frozen one. Only the
   *  current version has a resolvable snapshot today — see this file's header / the ticket report
   *  for why multi-version snapshotting is out of scope here. */
  vocabularyVersion?: string
}

/**
 * Validates a WHOLE tenant's compositions (every collection it declares) in one pass — the shape
 * WSK-19's mirror and the WSK-32 drafting flow both hold before a `applySchema` commits it.
 */
export function validateTenantComposition(raw: unknown, opts: ValidateTenantCompositionOptions = {}): CompositionValidationResult {
  const requestedVersion = opts.vocabularyVersion ?? VOCABULARY_VERSION
  if (requestedVersion !== VOCABULARY_VERSION) {
    return {
      valid: false,
      issues: [
        issue(
          '$.vocabularyVersion',
          `no vocabulary snapshot is registered for "${requestedVersion}" — this validator can only check against the current frozen vocabulary`,
          VOCABULARY_VERSION,
        ),
      ],
    }
  }

  if (!isPlainObject(raw)) {
    return {
      valid: false,
      issues: [issue('$', 'expected a tenant composition object keyed by collection key', 'Record<collectionKey, { fields?, blocks? }>')],
    }
  }

  const issues: CompositionIssue[] = []
  for (const [key, composition] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      issues.push(issue('$', 'a collection key must be a non-empty string'))
      continue
    }
    issues.push(...validateCollectionComposition(key, composition).issues)
  }
  return { valid: issues.length === 0, issues }
}

/** One actionable line: "<path>: <message> (expected: <expected>)". What error surfaces should render. */
export function formatCompositionIssue(i: CompositionIssue): string {
  return i.expected ? `${i.path}: ${i.message} (expected: ${i.expected})` : `${i.path}: ${i.message}`
}

export function formatCompositionIssues(issues: CompositionIssue[]): string[] {
  return issues.map(formatCompositionIssue)
}
