// webdesk/payload/vocabulary/primitives.ts
//
// WSK-06 — the field primitives (webdesk-design.md §05, Layer 1). Defined ONCE here; consumed
// by payload.config.ts (this ticket), and later by codegen (WSK-15) and the block-renderer
// library (WSK-16) per the design's explicit instruction ("a typed props schema defined once ...
// consumed by Payload config, codegen, and the block-renderer library").
//
// WSK-64 (vocabulary 1.1.0, ruling WSK-D44, write-plane design §2.2) — a MINOR:
//   - three new primitives: `group` (a closed nested object), `boolean`, `markdown`;
//   - `multiple` is honoured for EVERY primitive (1.0.0 honoured it for media/relation only);
//   - FieldDef gains the optional keys `fields`, `itemKey`, `localized` and `ui`.
// Nothing here changed meaning for a value 1.0.0 accepted: no shipped composition declared a scalar
// `multiple` (checked in the WSK-62 design, §2.3 row 5), so no stored value changes validity.
//
// Deliberately hand-rolled (no zod/ajv dependency added): this project's existing validation code
// (webdesk/api/src/auth/*, webdesk/api/src/content/*) is all plain hand-written TypeScript, no
// schema-validation library anywhere in this repo yet — adding one here for a single ticket would
// be an unreviewed dependency choice a freeze ticket should not make unilaterally. WSK-14 (the
// vocabulary contract + composition validator) is the ticket chartered to decide that; this file
// only needs to be correct and typed, not depend on a specific validation library.

export type PrimitiveName =
  | 'text'
  | 'richtext'
  | 'media'
  | 'relation'
  | 'number'
  | 'date'
  | 'select'
  | 'geo'
  | 'group'
  | 'boolean'
  | 'markdown'

/** 1.1.0: the editor widget a `ui` hint may ask for. Editor-only; never changes the wire value. */
export type FieldWidget = 'input' | 'textarea' | 'code'

/** 1.1.0: editor-only presentation hints. Changing them never changes what a consumer receives. */
export interface FieldUi {
  label?: string
  help?: string
  readOnly?: boolean
  widget?: FieldWidget
}

/** A field on a block or a collection, described in terms of one primitive (§05 Layer 2). */
export interface FieldDef {
  /** `^[A-Za-z][A-Za-z0-9_]{0,63}$`. snake_case is allowed: importers keep source keys verbatim. */
  name: string
  primitive: PrimitiveName
  /** "Present": not null/undefined. `[]` still satisfies a required `multiple` field. */
  required?: boolean
  /** 'select' only: the closed set of allowed string values. */
  options?: string[]
  /** 'relation' only: which collection key the relation points at. */
  relationTo?: string
  /** 1.1.0: honoured for EVERY primitive. The value is an ordered array of the primitive's shape. */
  multiple?: boolean
  /** 1.1.0, 'group' only (required, non-empty): the group's sub-fields. Group nesting depth <= 4. */
  fields?: FieldDef[]
  /** 1.1.0, 'group' + `multiple` only: names a required `text` sub-field whose values are unique in the list. */
  itemKey?: string
  /** 1.1.0, default true. false = locale-neutral: the default-locale item's value is authoritative (advisory). */
  localized?: boolean
  /** 1.1.0: editor-only hints. */
  ui?: FieldUi
}

export interface PrimitiveDef {
  name: PrimitiveName
  /** Human-readable description of the JSON shape this primitive serializes to on the wire. */
  jsonShape: string
  /** Returns validation error strings; an empty array means the value is valid. */
  validate: (value: unknown, field?: FieldDef) => string[]
}

/** 1.1.0: every key a FieldDef may carry. The composition validator rejects any other key. */
export const FIELD_DEF_KEYS = [
  'name',
  'primitive',
  'required',
  'options',
  'relationTo',
  'multiple',
  'fields',
  'itemKey',
  'localized',
  'ui',
] as const

/** 1.1.0: the keys a FieldDef's `ui` object may carry. */
export const FIELD_UI_KEYS = ['label', 'help', 'readOnly', 'widget'] as const
export const FIELD_WIDGETS: FieldWidget[] = ['input', 'textarea', 'code']

/** 1.1.0: the grammar every field name follows (it is also a JSON-pointer segment and a TS property). */
export const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** 1.1.0: the deepest a `group` may nest. A top-level group is depth 1. */
export const MAX_GROUP_DEPTH = 4

/** One value-level problem, at an RFC 6901 JSON pointer relative to the value passed in. */
export interface ValueIssue {
  path: string
  message: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** RFC 6901 escaping for one pointer segment. */
export function pointerSegment(key: string | number): string {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1')
}

function arrayNoun(primitive: PrimitiveName): string {
  if (primitive === 'media') return 'an array of media objects'
  if (primitive === 'relation') return 'an array of relations'
  return `an array (field is "multiple")`
}

/** One value of the primitive, never an array wrapper (multiplicity is handled by the caller). */
function validateSingle(field: FieldDef, v: unknown, ptr: string, depth: number): ValueIssue[] {
  const one = (message: string): ValueIssue[] => [{ path: ptr, message }]
  switch (field.primitive) {
    case 'text':
      return typeof v === 'string' ? [] : one('expected a string')
    case 'richtext':
      // A Lexical-shaped document ({ root: {...} }, matching @payloadcms/richtext-lexical's
      // already-vendored shape) OR a plain string fallback — the design does not mandate Lexical
      // specifically, only that richtext round-trips through the envelope as structured content.
      if (typeof v === 'string') return []
      if (isPlainObject(v) && 'root' in v) return []
      return one('expected a richtext document ({ root: ... }) or a plain string')
    case 'media':
      // WSK-16 found that 1.0.0's `media` once ignored `multiple`; 1.1.0 handles multiplicity for
      // every primitive in one place (validateFieldValue), so that class of gap cannot recur.
      if (!isPlainObject(v)) return one('expected a media object')
      if (typeof v.url !== 'string' || v.url.length === 0) return one('media.url must be a non-empty string')
      return []
    case 'relation':
      return isPlainObject(v) && typeof v.collection === 'string' && typeof v.slug === 'string'
        ? []
        : one('expected { collection, slug }')
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? [] : one('expected a finite number')
    case 'date':
      if (typeof v !== 'string') return one('expected an ISO-8601 date string')
      return Number.isNaN(Date.parse(v)) ? one('not a parseable ISO-8601 date') : []
    case 'select':
      if (typeof v !== 'string') return one('expected a string')
      if (field.options && !field.options.includes(v)) {
        return one(`"${v}" is not one of: ${field.options.join(', ')}`)
      }
      return []
    case 'geo': {
      if (!isPlainObject(v)) return one('expected a geo object')
      if (typeof v.lat !== 'number' || typeof v.lng !== 'number') return one('geo requires numeric lat/lng')
      const errors: ValueIssue[] = []
      if (v.lat < -90 || v.lat > 90) errors.push({ path: ptr, message: 'lat out of range (-90..90)' })
      if (v.lng < -180 || v.lng > 180) errors.push({ path: ptr, message: 'lng out of range (-180..180)' })
      return errors
    }
    case 'boolean':
      return typeof v === 'boolean' ? [] : one('expected a boolean (JSON true/false)')
    case 'markdown':
      // CommonMark + GFM source, stored and compared VERBATIM: never trimmed or normalised here.
      return typeof v === 'string' ? [] : one('expected a markdown source string')
    case 'group': {
      if (depth > MAX_GROUP_DEPTH) return one(`group nesting deeper than ${MAX_GROUP_DEPTH} is not allowed`)
      const subs = Array.isArray(field.fields) ? field.fields : []
      if (subs.length === 0) return one('a "group" field must declare its sub-fields (FieldDef.fields)')
      if (!isPlainObject(v)) return one('expected an object (group)')
      const out: ValueIssue[] = []
      const known = new Set(subs.map((s) => s.name))
      for (const k of Object.keys(v)) {
        if (!known.has(k)) {
          out.push({ path: `${ptr}/${pointerSegment(k)}`, message: `unknown key "${k}" (a group is closed: ${[...known].join(', ')})` })
        }
      }
      for (const s of subs) {
        out.push(...validateAt(s, v[s.name], `${ptr}/${pointerSegment(s.name)}`, depth + 1))
      }
      return out
    }
    default:
      return one(`unknown primitive "${String(field.primitive)}"`)
  }
}

function validateAt(field: FieldDef, value: unknown, ptr: string, depth: number): ValueIssue[] {
  if (value === undefined || value === null) {
    return field.required ? [{ path: ptr, message: `${field.name} is required` }] : []
  }
  if (!isPrimitiveName(field.primitive)) {
    return [{ path: ptr, message: `unknown primitive "${String(field.primitive)}"` }]
  }
  if (!field.multiple) return validateSingle(field, value, ptr, depth)

  if (!Array.isArray(value)) return [{ path: ptr, message: `expected ${arrayNoun(field.primitive)}` }]
  const out: ValueIssue[] = []
  value.forEach((item, i) => out.push(...validateSingle(field, item, `${ptr}/${i}`, depth)))
  if (field.primitive === 'group' && typeof field.itemKey === 'string') {
    const firstAt = new Map<string, number>()
    value.forEach((item, i) => {
      if (!isPlainObject(item)) return
      const key = item[field.itemKey as string]
      if (typeof key !== 'string') return
      const prev = firstAt.get(key)
      if (prev === undefined) firstAt.set(key, i)
      else {
        out.push({
          path: `${ptr}/${i}/${pointerSegment(field.itemKey as string)}`,
          message: `duplicate itemKey "${field.itemKey}" value "${key}" (first used at index ${prev}); item keys are unique per list`,
        })
      }
    })
  }
  return out
}

/**
 * 1.1.0: validates one field's value, recursing into groups. Issue paths are RFC 6901 pointers
 * RELATIVE to `pointer` (the value's own location; '' for the value itself).
 */
export function validateFieldValue(field: FieldDef, value: unknown, pointer = ''): ValueIssue[] {
  return validateAt(field, value, pointer, field.primitive === 'group' ? 1 : 0)
}

function formatIssues(field: FieldDef, issues: ValueIssue[]): string[] {
  return issues.map((i) => {
    if (i.message === `${field.name} is required` && i.path === '') return i.message
    return i.path === '' ? `${field.name}: ${i.message}` : `${field.name}${i.path}: ${i.message}`
  })
}

function primitiveValidator(name: PrimitiveName) {
  return (v: unknown, f?: FieldDef): string[] => {
    const field: FieldDef = { ...(f ?? { name: name }), primitive: name }
    if (v === undefined || v === null) return validateSingle(field, v, '', 1).map((i) => i.message)
    return validateFieldValue(field, v).map((i) => (i.path === '' ? i.message : `${i.path}: ${i.message}`))
  }
}

export const PRIMITIVES: Record<PrimitiveName, PrimitiveDef> = {
  text: { name: 'text', jsonShape: 'string', validate: primitiveValidator('text') },
  richtext: {
    name: 'richtext',
    jsonShape: 'a Lexical-shaped JSON document ({ root: {...} }) or a plain string fallback',
    validate: primitiveValidator('richtext'),
  },
  media: {
    name: 'media',
    jsonShape: '{ url: string, alt?: string, width?: number, height?: number, mime?: string } (or an array of the same when field.multiple)',
    validate: primitiveValidator('media'),
  },
  relation: {
    name: 'relation',
    jsonShape: '{ collection: string, slug: string } (or an array of the same when field.multiple)',
    validate: primitiveValidator('relation'),
  },
  number: { name: 'number', jsonShape: 'number', validate: primitiveValidator('number') },
  date: {
    name: 'date',
    jsonShape: 'an ISO-8601 date/time string',
    validate: primitiveValidator('date'),
  },
  select: {
    name: 'select',
    jsonShape: 'string (one of field.options)',
    validate: primitiveValidator('select'),
  },
  geo: {
    name: 'geo',
    jsonShape: '{ lat: number, lng: number }',
    validate: primitiveValidator('geo'),
  },
  group: {
    name: 'group',
    jsonShape: '{ [subField.name]: value } — closed (unknown keys are a violation); an ordered array of the same when field.multiple',
    validate: primitiveValidator('group'),
  },
  boolean: { name: 'boolean', jsonShape: 'boolean (JSON true/false)', validate: primitiveValidator('boolean') },
  markdown: {
    name: 'markdown',
    jsonShape: 'string (CommonMark + GFM source, stored verbatim, never normalised)',
    validate: primitiveValidator('markdown'),
  },
}

export const PRIMITIVE_NAMES: PrimitiveName[] = Object.keys(PRIMITIVES) as PrimitiveName[]

/** 1.1.0: every primitive honours `multiple`. Narrowing this list is a vocabulary MAJOR. */
export const MULTIPLE_CAPABLE_PRIMITIVES: PrimitiveName[] = [...PRIMITIVE_NAMES]

export function isPrimitiveName(v: string): v is PrimitiveName {
  return (PRIMITIVE_NAMES as string[]).includes(v)
}

/** Validates one named field against its declared primitive. Prefixes errors with the field name. */
export function validateField(field: FieldDef, value: unknown): string[] {
  if (value === undefined || value === null) {
    return field.required ? [`${field.name} is required`] : []
  }
  if (!isPrimitiveName(field.primitive)) {
    return [`${field.name}: unknown primitive "${field.primitive}"`]
  }
  return formatIssues(field, validateFieldValue(field, value))
}
