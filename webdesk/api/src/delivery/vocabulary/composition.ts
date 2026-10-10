// VENDORED — generated from webdesk/payload/vocabulary/composition.ts (WSK-06/WSK-14, frozen per
// webdesk-design.md §05) by webdesk/api/src/delivery/vocabulary/vendor.mjs. DO NOT HAND-EDIT.
// The only transform: LF line endings and relative '.ts' import extensions stripped (this
// package is CommonJS). Re-vendor with `node src/delivery/vocabulary/vendor.mjs`; drift is
// caught by test/delivery/vocabulary-vendor-drift.spec.ts.

// webdesk/payload/vocabulary/composition.ts
//
// WSK-14 — the composition validator (webdesk-design.md §05 Layer 2: "A tenant's collections are
// arrangements of Layer-1 primitives stored as schema data (`collections.schema` jsonb), validated
// by the composition validator (WSK-14) against the vocabulary version.").
//
// Scope note on what this file does NOT do: it does not validate CONTENT (a content_items row's
// actual `blocks` array against a block's props) — that is `./blocks.ts`'s `validateBlock` for the
// generic blocks and `./item-fields.ts`'s `validateItemContent` for the composition-typed `fields`
// block (WSK-64). This file validates the COMPOSITION ITSELF — the tenant-authored (or AI-drafted,
// WSK-32) declaration of which primitives/block types a collection is built from — which is a
// different moment with a different correctness rule: a composition proposing a primitive or block
// type that does not exist in the vocabulary is an authoring mistake, not a forward-compatibility
// scenario, and must be rejected loudly with an actionable error (design's WSK-14 AC: "rejects
// out-of-vocabulary constructs with actionable errors").
//
// WSK-64 (vocabulary 1.1.0, ruling WSK-D44, write-plane design §2.2) adds the composition keys
// `singleton`, `localized`, `ui` and `lint`, the FieldDef keys `fields`, `itemKey`, `localized` and
// `ui`, the field-name grammar, group nesting (depth <= 4), and the rule that the composition-typed
// `fields` block is implied by declaring `fields` and is never listed in `blocks`.
import {
  FIELD_DEF_KEYS,
  FIELD_NAME_PATTERN,
  FIELD_UI_KEYS,
  FIELD_WIDGETS,
  MAX_GROUP_DEPTH,
  PRIMITIVE_NAMES,
  isPrimitiveName,
  type FieldDef,
} from './primitives'
import { COMPOSABLE_BLOCK_TYPE_NAMES, FIELDS_BLOCK_TYPE, isComposableBlockType, type ComposableBlockType } from './blocks'
import { VOCABULARY_VERSION } from './version'

/** 1.1.0, advisory lint: a literal-delimited placeholder syntax. No regex, so a tenant pattern cannot cause ReDoS. */
export type PlaceholderRule =
  | {
      kind: 'token'
      open: string
      close: string
      /** Where token values are registered: a list field of a (singleton) collection. */
      registry?: { collection: string; listField: string; keyField: string; valueField: string }
    }
  | { kind: 'marker'; open: string; close: string; label: string }

/** 1.1.0: editor-only presentation of a collection. */
export interface CollectionUi {
  label: string
  description?: string
  group?: string
  order?: number
  /** Names a top-level field whose value is the item's display title in the editor. */
  titleField?: string
}

/**
 * `collections.schema` jsonb (migrations/0002_content.sql), Layer-2 composition-as-data.
 *
 * `fields` — the collection's own typed fields, reusing the exact `FieldDef` shape Layer 1 defines
 * for a block's fields. 1.1.0: when present, every item carries `blocks[0] = { type: 'fields',
 * props }`, typed by these fields (see ./item-fields.ts). The `redirect` system collection is the
 * one documented exception: its values are stored under `seo.redirect` (write-plane design §2.7).
 *
 * `blocks` — the generic block types allowed AFTER the fields block. Presence of this key, even as
 * `[]`, is a deliberate closed set; ABSENCE means "no restriction declared" (any generic vocabulary
 * block type may appear). `fields` may never be listed here.
 */
export interface CollectionComposition {
  fields?: FieldDef[]
  blocks?: ComposableBlockType[]
  /** 1.1.0: at most one non-deleted item per locale. */
  singleton?: boolean
  /** 1.1.0, default true. false = items exist only in the tenant's default locale. */
  localized?: boolean
  /** 1.1.0: editor-only. */
  ui?: CollectionUi
  /** 1.1.0: advisory checks computed on save and publish; never blocking. */
  lint?: { placeholders?: PlaceholderRule[] }
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

/** 1.1.0: every key a collection composition may carry. */
export const COMPOSITION_KEYS = ['fields', 'blocks', 'singleton', 'localized', 'ui', 'lint'] as const

const KNOWN_COLLECTION_KEYS = new Set<string>(COMPOSITION_KEYS)
const KNOWN_FIELD_KEYS = new Set<string>(FIELD_DEF_KEYS)
const KNOWN_FIELD_UI_KEYS = new Set<string>(FIELD_UI_KEYS)
const KNOWN_COLLECTION_UI_KEYS = new Set(['label', 'description', 'group', 'order', 'titleField'])
const KNOWN_LINT_KEYS = new Set(['placeholders'])
const TOKEN_RULE_KEYS = new Set(['kind', 'open', 'close', 'registry'])
const MARKER_RULE_KEYS = new Set(['kind', 'open', 'close', 'label'])
const REGISTRY_KEYS = ['collection', 'listField', 'keyField', 'valueField'] as const

function issue(path: string, message: string, expected?: string): CompositionIssue {
  return expected ? { path, message, expected } : { path, message }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function closedKeys(path: string, obj: Record<string, unknown>, known: Set<string>, what: string): CompositionIssue[] {
  const out: CompositionIssue[] = []
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) out.push(issue(`${path}.${k}`, `unknown ${what} key "${k}"`, [...known].sort().join(' | ')))
  }
  return out
}

function validateBooleanKey(path: string, v: unknown, key: string): CompositionIssue[] {
  return v !== undefined && typeof v !== 'boolean' ? [issue(`${path}.${key}`, `${key} must be a boolean when present`, 'boolean')] : []
}

function validateFieldUi(path: string, raw: unknown): CompositionIssue[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [issue(path, 'ui must be an object', '{ label?, help?, readOnly?, widget? }')]
  const out = closedKeys(path, raw, KNOWN_FIELD_UI_KEYS, 'field ui')
  for (const k of ['label', 'help'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') out.push(issue(`${path}.${k}`, `ui.${k} must be a string when present`, 'string'))
  }
  out.push(...validateBooleanKey(path, raw.readOnly, 'readOnly'))
  if (raw.widget !== undefined && !(FIELD_WIDGETS as unknown[]).includes(raw.widget)) {
    out.push(issue(`${path}.widget`, `ui.widget must be one of the editor widgets`, FIELD_WIDGETS.join(' | ')))
  }
  return out
}

/** Validates a FieldDef list (a collection's `fields`, or a group's sub-fields) at `depth` (0 = top level). */
function validateFieldList(path: string, raw: unknown, depth: number, ownerLabel: string): CompositionIssue[] {
  if (!Array.isArray(raw)) return [issue(path, 'fields must be an array', 'FieldDef[]')]
  const issues: CompositionIssue[] = []
  const seen = new Set<string>()
  raw.forEach((f, i) => {
    const fieldPath = `${path}[${i}]`
    issues.push(...validateFieldDef(fieldPath, f, depth))
    const name = isPlainObject(f) && typeof f.name === 'string' ? f.name : null
    if (name) {
      if (seen.has(name)) issues.push(issue(`${fieldPath}.name`, `duplicate field name "${name}" within ${ownerLabel}`))
      seen.add(name)
    }
  })
  return issues
}

function validateFieldDef(path: string, raw: unknown, depth: number): CompositionIssue[] {
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
  } else if (!FIELD_NAME_PATTERN.test(f.name)) {
    issues.push(issue(`${path}.name`, `field name "${f.name}" does not match the field-name grammar`, FIELD_NAME_PATTERN.source))
  }

  const primitive = typeof f.primitive === 'string' && isPrimitiveName(f.primitive) ? f.primitive : null
  if (typeof f.primitive !== 'string') {
    issues.push(issue(`${path}.primitive`, 'primitive must be a string', PRIMITIVE_NAMES.join(' | ')))
  } else if (!primitive) {
    issues.push(
      issue(`${path}.primitive`, `"${f.primitive}" is not one of the ${PRIMITIVE_NAMES.length} vocabulary primitives`, PRIMITIVE_NAMES.join(' | ')),
    )
  } else {
    if (primitive === 'select') {
      const opts = f.options
      if (!Array.isArray(opts) || opts.length === 0 || !opts.every((o) => typeof o === 'string')) {
        issues.push(issue(`${path}.options`, 'a "select" field requires a non-empty array of string options', 'string[]'))
      }
    }
    if (primitive === 'relation') {
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
  issues.push(...validateBooleanKey(path, f.localized, 'localized'))
  issues.push(...validateFieldUi(`${path}.ui`, f.ui))

  // --- 1.1.0: group sub-fields and nesting depth --------------------------------------------
  if (primitive === 'group') {
    const groupDepth = depth + 1
    if (groupDepth > MAX_GROUP_DEPTH) {
      issues.push(issue(`${path}.fields`, `group nesting deeper than ${MAX_GROUP_DEPTH} is not allowed (this group is at depth ${groupDepth})`, `depth <= ${MAX_GROUP_DEPTH}`))
    } else if (!Array.isArray(f.fields) || f.fields.length === 0) {
      issues.push(issue(`${path}.fields`, 'a "group" field requires a non-empty fields array (its sub-fields)', 'FieldDef[]'))
    } else {
      issues.push(...validateFieldList(`${path}.fields`, f.fields, groupDepth, `group "${String(f.name)}"`))
    }
  } else if (f.fields !== undefined) {
    issues.push(issue(`${path}.fields`, `"fields" is only allowed on a "group" field (this field is "${String(f.primitive)}")`, 'primitive: "group"'))
  }

  // --- 1.1.0: itemKey -------------------------------------------------------------------------
  if (f.itemKey !== undefined) {
    if (typeof f.itemKey !== 'string' || f.itemKey.length === 0) {
      issues.push(issue(`${path}.itemKey`, 'itemKey must be a non-empty string naming a sub-field', 'string'))
    } else if (primitive !== 'group' || f.multiple !== true) {
      issues.push(issue(`${path}.itemKey`, 'itemKey is only allowed on a "group" field with multiple: true (a list of objects)', 'primitive: "group", multiple: true'))
    } else if (Array.isArray(f.fields)) {
      const target = f.fields.find((s) => isPlainObject(s) && s.name === f.itemKey) as Record<string, unknown> | undefined
      if (!target) {
        issues.push(issue(`${path}.itemKey`, `itemKey "${f.itemKey}" does not name a sub-field of this group`, 'the name of a required text sub-field'))
      } else if (target.primitive !== 'text' || target.required !== true || target.multiple === true) {
        issues.push(issue(`${path}.itemKey`, `itemKey "${f.itemKey}" must name a REQUIRED, single-valued "text" sub-field`, 'a sub-field with primitive "text", required: true'))
      }
    }
  }

  return issues
}

function validateCollectionUi(path: string, raw: unknown, fields: unknown): CompositionIssue[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [issue(path, 'ui must be an object', '{ label: string, description?, group?, order?, titleField? }')]
  const out = closedKeys(path, raw, KNOWN_COLLECTION_UI_KEYS, 'collection ui')
  if (!isNonEmptyString(raw.label)) out.push(issue(`${path}.label`, 'ui.label is required and must be a non-empty string', 'string'))
  for (const k of ['description', 'group'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') out.push(issue(`${path}.${k}`, `ui.${k} must be a string when present`, 'string'))
  }
  if (raw.order !== undefined && !(typeof raw.order === 'number' && Number.isFinite(raw.order))) {
    out.push(issue(`${path}.order`, 'ui.order must be a finite number when present', 'number'))
  }
  if (raw.titleField !== undefined) {
    const names = Array.isArray(fields) ? fields.filter(isPlainObject).map((f) => f.name) : []
    if (typeof raw.titleField !== 'string' || !names.includes(raw.titleField)) {
      out.push(issue(`${path}.titleField`, 'ui.titleField must name a top-level field declared in this composition', names.length ? names.join(' | ') : '(declare fields first)'))
    }
  }
  return out
}

function validateLint(path: string, raw: unknown): CompositionIssue[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [issue(path, 'lint must be an object', '{ placeholders?: PlaceholderRule[] }')]
  const out = closedKeys(path, raw, KNOWN_LINT_KEYS, 'lint')
  if (raw.placeholders === undefined) return out
  if (!Array.isArray(raw.placeholders)) return [...out, issue(`${path}.placeholders`, 'lint.placeholders must be an array', 'PlaceholderRule[]')]
  raw.placeholders.forEach((rule, i) => {
    const rp = `${path}.placeholders[${i}]`
    if (!isPlainObject(rule)) {
      out.push(issue(rp, 'expected a placeholder rule object', '{ kind: "token" | "marker", open, close, ... }'))
      return
    }
    if (rule.kind !== 'token' && rule.kind !== 'marker') {
      out.push(issue(`${rp}.kind`, 'placeholder rule kind must be "token" or "marker"', 'token | marker'))
      return
    }
    out.push(...closedKeys(rp, rule, rule.kind === 'token' ? TOKEN_RULE_KEYS : MARKER_RULE_KEYS, `${rule.kind} rule`))
    for (const k of ['open', 'close'] as const) {
      if (!isNonEmptyString(rule[k])) out.push(issue(`${rp}.${k}`, `${k} must be a non-empty literal delimiter string (no regex)`, 'string'))
    }
    if (rule.kind === 'marker' && !isNonEmptyString(rule.label)) {
      out.push(issue(`${rp}.label`, 'a marker rule requires a non-empty label', 'string'))
    }
    if (rule.kind === 'token' && rule.registry !== undefined) {
      if (!isPlainObject(rule.registry)) {
        out.push(issue(`${rp}.registry`, 'registry must be an object', '{ collection, listField, keyField, valueField }'))
      } else {
        out.push(...closedKeys(`${rp}.registry`, rule.registry, new Set(REGISTRY_KEYS), 'registry'))
        for (const k of REGISTRY_KEYS) {
          if (!isNonEmptyString(rule.registry[k])) out.push(issue(`${rp}.registry.${k}`, `registry.${k} must be a non-empty string`, 'string'))
        }
      }
    }
  })
  return out
}

/** Validates ONE collection's `schema` jsonb value against the vocabulary. Pure, synchronous. */
export function validateCollectionComposition(collectionKey: string, raw: unknown): CompositionValidationResult {
  if (!isPlainObject(raw)) {
    return {
      valid: false,
      issues: [issue(collectionKey, 'expected a composition object', '{ fields?: FieldDef[], blocks?: BlockType[], singleton?, localized?, ui?, lint? }')],
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
    issues.push(...validateFieldList(`${collectionKey}.fields`, c.fields, 0, `collection "${collectionKey}"`))
  }

  if (c.blocks !== undefined) {
    if (!Array.isArray(c.blocks)) {
      issues.push(issue(`${collectionKey}.blocks`, 'blocks must be an array', 'BlockType[]'))
    } else {
      const seen = new Set<string>()
      c.blocks.forEach((b, i) => {
        const path = `${collectionKey}.blocks[${i}]`
        if (typeof b !== 'string') {
          issues.push(issue(path, 'a block-type entry must be a string', COMPOSABLE_BLOCK_TYPE_NAMES.join(' | ')))
        } else if (b === FIELDS_BLOCK_TYPE) {
          issues.push(
            issue(
              path,
              `"${FIELDS_BLOCK_TYPE}" is the composition-typed block: it is implied by declaring "fields" and may never be listed in "blocks"`,
              COMPOSABLE_BLOCK_TYPE_NAMES.join(' | '),
            ),
          )
        } else if (!isComposableBlockType(b)) {
          issues.push(issue(path, `"${b}" is not one of the ${COMPOSABLE_BLOCK_TYPE_NAMES.length} vocabulary block types`, COMPOSABLE_BLOCK_TYPE_NAMES.join(' | ')))
        } else if (seen.has(b)) {
          issues.push(issue(path, `duplicate block type "${b}" declared for collection "${collectionKey}"`))
        } else {
          seen.add(b)
        }
      })
    }
  }

  issues.push(...validateBooleanKey(collectionKey, c.singleton, 'singleton'))
  issues.push(...validateBooleanKey(collectionKey, c.localized, 'localized'))
  issues.push(...validateCollectionUi(`${collectionKey}.ui`, c.ui, c.fields))
  issues.push(...validateLint(`${collectionKey}.lint`, c.lint))

  return { valid: issues.length === 0, issues }
}

export interface ValidateTenantCompositionOptions {
  /** The vocabulary version the composition was authored against. Any version up to and including
   *  the current one within the same MAJOR is accepted and validated against the CURRENT rules,
   *  because a MINOR is a superset. A newer version, a different MAJOR, or a malformed string is refused. */
  vocabularyVersion?: string
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when a composition authored against `requested` can be validated by the current vocabulary. */
export function isVocabularyVersionSupported(requested: string): boolean {
  const r = parseSemver(requested)
  const c = parseSemver(VOCABULARY_VERSION)
  if (!r || !c) return false
  if (r[0] !== c[0]) return false
  if (r[1] !== c[1]) return r[1] < c[1]
  return r[2] <= c[2]
}

/**
 * Validates a WHOLE tenant's compositions (every collection it declares) in one pass — the shape
 * WSK-19's mirror and the WSK-32 drafting flow both hold before a `applySchema` commits it.
 */
export function validateTenantComposition(raw: unknown, opts: ValidateTenantCompositionOptions = {}): CompositionValidationResult {
  const requestedVersion = opts.vocabularyVersion ?? VOCABULARY_VERSION
  if (!isVocabularyVersionSupported(requestedVersion)) {
    return {
      valid: false,
      issues: [
        issue(
          '$.vocabularyVersion',
          `vocabulary "${requestedVersion}" cannot be validated by this vocabulary (${VOCABULARY_VERSION}): only versions up to the current one within the same MAJOR are accepted`,
          VOCABULARY_VERSION,
        ),
      ],
    }
  }

  if (!isPlainObject(raw)) {
    return {
      valid: false,
      issues: [issue('$', 'expected a tenant composition object keyed by collection key', 'Record<collectionKey, { fields?, blocks?, ... }>')],
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
