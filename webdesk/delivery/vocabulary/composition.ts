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
//
// WSK-49a (vocabulary 1.2.0, ruling WSK-D59) adds one optional key to each `ui` object (the collection's
// and the field's): `clientEditable`. Editor metadata only, so it is PATCH inside a tenant contract and a
// MINOR vocabulary release; the rule that resolves it is ./client-editable.ts.
//
// M5-W3c (vocabulary 1.3.0) adds one optional member to `lint`: `content`, the per-collection settings of the
// advisory editorial content checks (the rules live in webdesk/api/src/control/content/lint-rules). The
// validator CLOSES it: unknown rule ids, unknown knobs and out-of-range values are refused at the composition
// write, never ignored. A MINOR vocabulary release; advisory only, so it can never make a save fail.
//
// M5-W8b (vocabulary 1.4.0) adds one optional key to the collection `ui` object: `routePattern`, the public
// page path pattern of the collection's items ("/blog/{slug}/", "/{locale}/insights/{slug}/"). Editor/ops
// metadata only (the dashboard maps an item to its page with it): no stored value changes, so it is PATCH inside
// a tenant contract and a MINOR vocabulary release. `validateRoutePattern` is its grammar, `pagePathFor` applies it.
import {
  FIELD_DEF_KEYS,
  FIELD_NAME_PATTERN,
  FIELD_UI_KEYS,
  FIELD_WIDGETS,
  MAX_GROUP_DEPTH,
  PRIMITIVE_NAMES,
  isPrimitiveName,
  type FieldDef,
} from './primitives.ts'
import { COMPOSABLE_BLOCK_TYPE_NAMES, FIELDS_BLOCK_TYPE, isComposableBlockType, type ComposableBlockType } from './blocks.ts'
import { VOCABULARY_VERSION } from './version.ts'

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

/**
 * 1.3.0 (M5-W3c): per-collection settings of the advisory content checks. Every member is optional; an absent
 * member, rule or knob means "the platform default" (gaiada.com's documented values), so a composition without
 * `lint.content` behaves exactly as before. The defaults live with the rules (api), not in the vocabulary.
 */
export interface ContentLintSettings {
  /** Master switch: false = the item's lint report has no `content` member. */
  enabled?: boolean
  /** A body of at least this many words is long-form and gets the structural checks. */
  longFormMinWords?: number
  /** Top-level field holding the page H1 when the H1 is not a `# ` heading in the body. */
  h1Field?: string
  /** Top-level field holding the one primary keyword. */
  primaryKeywordField?: string
  /** Top-level fields (string or string[]) that hold image alt texts. */
  altFields?: string[]
  /** Per rule: `enabled` plus that rule's own thresholds (see CONTENT_LINT_RULE_KNOBS). */
  rules?: { [ruleId: string]: { enabled?: boolean; [knob: string]: unknown } }
}

/** 1.1.0: editor-only presentation of a collection. */
export interface CollectionUi {
  label: string
  description?: string
  group?: string
  order?: number
  /** Names a top-level field whose value is the item's display title in the editor. */
  titleField?: string
  /**
   * 1.2.0 (WSK-D59): a client editor may edit this collection's fields and generic blocks. It is the
   * DEFAULT a field inherits; a field's own `ui.clientEditable` wins. `seo` is never client-editable.
   * Editor metadata only: no stored value changes. Resolved by `isClientEditable` (./client-editable.ts).
   */
  clientEditable?: boolean
  /**
   * 1.4.0 (M5-W8b): the public page path pattern of this collection's items. Starts with `/`; segments are literal
   * (`[a-z0-9-]`), `{slug}` (required, once) or `{locale}` (optional, once), each a whole segment; a trailing slash is
   * allowed; no query, fragment or `..`; at most 200 characters. Resolved by `pagePathFor`.
   */
  routePattern?: string
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
  lint?: { placeholders?: PlaceholderRule[]; content?: ContentLintSettings }
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
/** 1.1.0: the keys a composition's `ui` object may carry (1.2.0 added `clientEditable`, 1.4.0 `routePattern`). */
export const COLLECTION_UI_KEYS = ['label', 'description', 'group', 'order', 'titleField', 'clientEditable', 'routePattern'] as const
const KNOWN_COLLECTION_UI_KEYS = new Set<string>(COLLECTION_UI_KEYS)
/** 1.1.0 `placeholders`; 1.3.0 added `content`. */
export const LINT_KEYS = ['placeholders', 'content'] as const
const KNOWN_LINT_KEYS = new Set<string>(LINT_KEYS)
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
  if (!isPlainObject(raw)) return [issue(path, 'ui must be an object', '{ label?, help?, readOnly?, widget?, clientEditable? }')]
  const out = closedKeys(path, raw, KNOWN_FIELD_UI_KEYS, 'field ui')
  for (const k of ['label', 'help'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') out.push(issue(`${path}.${k}`, `ui.${k} must be a string when present`, 'string'))
  }
  out.push(...validateBooleanKey(path, raw.readOnly, 'readOnly'))
  out.push(...validateBooleanKey(path, raw.clientEditable, 'clientEditable'))
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

// -------------------------------------------------------------------------------------------------
// 1.4.0 (M5-W8b): ui.routePattern
// -------------------------------------------------------------------------------------------------
export const ROUTE_PATTERN_MAX_LENGTH = 200
const ROUTE_LITERAL_SEGMENT = /^[a-z0-9-]+$/
const ROUTE_SLUG_VALUE = /^[a-z0-9][a-z0-9._~-]{0,199}$/i
const ROUTE_LOCALE_VALUE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** The reason a route pattern is not acceptable, or null when it is. Pure; the grammar is documented on `CollectionUi.routePattern`. */
export function routePatternProblem(p: unknown): string | null {
  if (typeof p !== 'string') return 'routePattern must be a string'
  if (p.length === 0 || p.length > ROUTE_PATTERN_MAX_LENGTH) return `routePattern must be 1 to ${ROUTE_PATTERN_MAX_LENGTH} characters`
  if (!p.startsWith('/')) return 'routePattern must start with "/"'
  const parts = p.slice(1).split('/')
  if (parts[parts.length - 1] === '') parts.pop() // a trailing slash
  if (parts.length === 0) return 'routePattern must contain {slug}'
  let slugs = 0
  let locales = 0
  for (const seg of parts) {
    if (seg === '{slug}') slugs++
    else if (seg === '{locale}') locales++
    else if (!ROUTE_LITERAL_SEGMENT.test(seg)) {
      return `segment "${seg}" is not allowed: use lowercase letters, digits and "-" (no empty segments, query, fragment or ".."), or the tokens {slug} and {locale}`
    }
  }
  if (slugs !== 1) return 'routePattern must contain {slug} exactly once'
  if (locales > 1) return 'routePattern may contain {locale} at most once'
  return null
}

/**
 * The public page path of an item: the pattern with `{slug}` and `{locale}` filled in, or null when the pattern is not
 * valid or a value cannot be put in a URL. For the tenant's DEFAULT language the `/{locale}` segment is left out (the
 * site serves its default language at the root); a pattern with no `{locale}` serves every language at the same
 * address, so it applies to each. Pure, no I/O.
 */
export function pagePathFor(routePattern: unknown, args: { slug: string; locale: string; defaultLocale: string }): string | null {
  if (routePatternProblem(routePattern) !== null) return null
  const { slug, locale, defaultLocale } = args
  if (typeof slug !== 'string' || !ROUTE_SLUG_VALUE.test(slug)) return null
  const segs = (routePattern as string).slice(1).split('/')
  const trailing = segs[segs.length - 1] === ''
  if (trailing) segs.pop()
  const out: string[] = []
  for (const seg of segs) {
    if (seg === '{slug}') out.push(slug)
    else if (seg === '{locale}') {
      if (locale === defaultLocale) continue
      if (typeof locale !== 'string' || !ROUTE_LOCALE_VALUE.test(locale)) return null
      out.push(locale)
    } else out.push(seg)
  }
  return '/' + out.join('/') + (trailing && out.length > 0 ? '/' : '')
}

function validateCollectionUi(path: string, raw: unknown, fields: unknown): CompositionIssue[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [issue(path, 'ui must be an object', '{ label: string, description?, group?, order?, titleField?, clientEditable?, routePattern? }')]
  const out = closedKeys(path, raw, KNOWN_COLLECTION_UI_KEYS, 'collection ui')
  if (!isNonEmptyString(raw.label)) out.push(issue(`${path}.label`, 'ui.label is required and must be a non-empty string', 'string'))
  for (const k of ['description', 'group'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') out.push(issue(`${path}.${k}`, `ui.${k} must be a string when present`, 'string'))
  }
  if (raw.order !== undefined && !(typeof raw.order === 'number' && Number.isFinite(raw.order))) {
    out.push(issue(`${path}.order`, 'ui.order must be a finite number when present', 'number'))
  }
  out.push(...validateBooleanKey(path, raw.clientEditable, 'clientEditable'))
  if (raw.routePattern !== undefined) {
    const why = routePatternProblem(raw.routePattern)
    if (why) out.push(issue(`${path}.routePattern`, `ui.${why}`, '"/blog/{slug}/" or "/{locale}/insights/{slug}/"'))
  }
  if (raw.titleField !== undefined) {
    const names = Array.isArray(fields) ? fields.filter(isPlainObject).map((f) => f.name) : []
    if (typeof raw.titleField !== 'string' || !names.includes(raw.titleField)) {
      out.push(issue(`${path}.titleField`, 'ui.titleField must name a top-level field declared in this composition', names.length ? names.join(' | ') : '(declare fields first)'))
    }
  }
  return out
}

// -------------------------------------------------------------------------------------------------
// 1.3.0 (M5-W3c): lint.content
// -------------------------------------------------------------------------------------------------
type ContentKnob =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'ratio'; min: number; max: number }
  | { kind: 'strings'; maxItems: number; maxLen: number }
  | { kind: 'localeMap'; maxKeys: number; maxItems: number; maxLen: number; valuesAreLocales?: boolean }

const INT = (min: number, max: number): ContentKnob => ({ kind: 'int', min, max })

/** The editorial content rules a composition can switch off or tune, with the knobs each one has (ids = the runner's rule ids). */
export const CONTENT_LINT_RULE_KNOBS: Record<string, Record<string, ContentKnob>> = {
  h1: {},
  meta: { titleMax: INT(1, 1000), descriptionMin: INT(0, 1000), descriptionMax: INT(0, 1000) },
  'image-alt': {},
  sources: {},
  'internal-links': { min: INT(0, 10000) },
  'id-twin': { twin: { kind: 'localeMap', maxKeys: 20, maxItems: 20, maxLen: 3, valuesAreLocales: true } },
  'answer-first': { minWords: INT(0, 1000), maxWords: INT(0, 1000) },
  'question-headings': { minShare: { kind: 'ratio', min: 0, max: 1 }, starters: { kind: 'strings', maxItems: 200, maxLen: 120 } },
  'primary-keyword': {},
  'banned-language': { phrases: { kind: 'localeMap', maxKeys: 20, maxItems: 200, maxLen: 120 } },
  // The AEO score is not a finding rule; it is switched and tuned here like one.
  aeo: { shortParagraphMaxWords: INT(1, 10000) },
}
export const CONTENT_LINT_RULE_IDS: readonly string[] = Object.keys(CONTENT_LINT_RULE_KNOBS)
/** Top-level members of lint.content. */
export const CONTENT_LINT_TOP_KEYS = ['enabled', 'longFormMinWords', 'h1Field', 'primaryKeywordField', 'altFields', 'rules'] as const
const LOCALE_FAMILY = /^[A-Za-z]{2,3}$/

function validateStringList(path: string, v: unknown, maxItems: number, maxLen: number, pattern?: RegExp): CompositionIssue[] {
  if (!Array.isArray(v)) return [issue(path, 'must be an array of strings', `string[] (at most ${maxItems})`)]
  if (v.length > maxItems) return [issue(path, `has ${v.length} entries; at most ${maxItems} are allowed`, `string[] (at most ${maxItems})`)]
  const out: CompositionIssue[] = []
  v.forEach((x, i) => {
    if (typeof x !== 'string' || x.length === 0 || x.length > maxLen || (pattern && !pattern.test(x))) {
      out.push(issue(`${path}[${i}]`, `must be a non-empty string of at most ${maxLen} characters${pattern ? ' (a language code such as "en")' : ''}`, 'string'))
    }
  })
  return out
}

function validateKnob(path: string, knob: ContentKnob, v: unknown): CompositionIssue[] {
  switch (knob.kind) {
    case 'int':
      return typeof v === 'number' && Number.isInteger(v) && v >= knob.min && v <= knob.max ? [] : [issue(path, `must be a whole number from ${knob.min} to ${knob.max}`, `integer ${knob.min}..${knob.max}`)]
    case 'ratio':
      return typeof v === 'number' && Number.isFinite(v) && v >= knob.min && v <= knob.max ? [] : [issue(path, `must be a number from ${knob.min} to ${knob.max}`, `number ${knob.min}..${knob.max}`)]
    case 'strings':
      return validateStringList(path, v, knob.maxItems, knob.maxLen)
    case 'localeMap': {
      if (!isPlainObject(v)) return [issue(path, 'must be an object keyed by language code', '{ [language]: string[] }')]
      const keys = Object.keys(v)
      if (keys.length > knob.maxKeys) return [issue(path, `has ${keys.length} languages; at most ${knob.maxKeys} are allowed`)]
      const out: CompositionIssue[] = []
      for (const k of keys) {
        if (!LOCALE_FAMILY.test(k)) out.push(issue(`${path}.${k}`, 'the key must be a language code such as "en"', 'language code'))
        out.push(...validateStringList(`${path}.${k}`, v[k], knob.maxItems, knob.maxLen, knob.valuesAreLocales ? LOCALE_FAMILY : undefined))
      }
      return out
    }
  }
}

/** Validates ONE collection's `lint.content` value (1.3.0). Strict: unknown keys and out-of-range values are issues. */
export function validateContentLintSettings(path: string, raw: unknown): CompositionIssue[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [issue(path, 'lint.content must be an object', '{ enabled?, longFormMinWords?, h1Field?, primaryKeywordField?, altFields?, rules? }')]
  const out = closedKeys(path, raw, new Set<string>(CONTENT_LINT_TOP_KEYS), 'lint.content')
  out.push(...validateBooleanKey(path, raw.enabled, 'enabled'))
  if (raw.longFormMinWords !== undefined) out.push(...validateKnob(`${path}.longFormMinWords`, INT(1, 100000), raw.longFormMinWords))
  for (const k of ['h1Field', 'primaryKeywordField'] as const) {
    if (raw[k] !== undefined && !(typeof raw[k] === 'string' && FIELD_NAME_PATTERN.test(raw[k] as string))) {
      out.push(issue(`${path}.${k}`, `${k} must be a field name`, FIELD_NAME_PATTERN.source))
    }
  }
  if (raw.altFields !== undefined) {
    const list = validateStringList(`${path}.altFields`, raw.altFields, 50, 64)
    out.push(...list)
    if (list.length === 0) {
      ;(raw.altFields as string[]).forEach((f, i) => {
        if (!FIELD_NAME_PATTERN.test(f)) out.push(issue(`${path}.altFields[${i}]`, 'must be a field name', FIELD_NAME_PATTERN.source))
      })
    }
  }
  if (raw.rules !== undefined) {
    const rp = `${path}.rules`
    if (!isPlainObject(raw.rules)) {
      out.push(issue(rp, 'rules must be an object keyed by rule id', CONTENT_LINT_RULE_IDS.join(' | ')))
    } else {
      out.push(...closedKeys(rp, raw.rules, new Set(CONTENT_LINT_RULE_IDS), 'content rule'))
      for (const [id, body] of Object.entries(raw.rules)) {
        const knobs = CONTENT_LINT_RULE_KNOBS[id]
        if (!knobs) continue // already reported as an unknown rule id
        const bp = `${rp}.${id}`
        if (!isPlainObject(body)) {
          out.push(issue(bp, 'a rule setting must be an object', `{ enabled?${Object.keys(knobs).map((k) => `, ${k}?`).join('')} }`))
          continue
        }
        out.push(...closedKeys(bp, body, new Set(['enabled', ...Object.keys(knobs)]), `${id} rule`))
        out.push(...validateBooleanKey(bp, body.enabled, 'enabled'))
        for (const [k, knob] of Object.entries(knobs)) if (body[k] !== undefined) out.push(...validateKnob(`${bp}.${k}`, knob, body[k]))
      }
      // Cross-knob order: only when both are numbers, so one mistake yields one issue.
      const order = (id: string, lo: string, hi: string): void => {
        const b = (raw.rules as Record<string, unknown>)[id]
        if (isPlainObject(b) && typeof b[lo] === 'number' && typeof b[hi] === 'number' && (b[lo] as number) > (b[hi] as number)) {
          out.push(issue(`${rp}.${id}.${lo}`, `${lo} must not be greater than ${hi}`, `${lo} <= ${hi}`))
        }
      }
      order('meta', 'descriptionMin', 'descriptionMax')
      order('answer-first', 'minWords', 'maxWords')
    }
  }
  return out
}

function validateLint(path: string, raw: unknown): CompositionIssue[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [issue(path, 'lint must be an object', '{ placeholders?: PlaceholderRule[], content?: ContentLintSettings }')]
  const out = closedKeys(path, raw, KNOWN_LINT_KEYS, 'lint')
  out.push(...validateContentLintSettings(`${path}.content`, raw.content))
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
