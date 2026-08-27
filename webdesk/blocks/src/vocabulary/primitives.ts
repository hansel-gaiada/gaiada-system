// VENDORED — copied verbatim from webdesk/payload/vocabulary/primitives.ts (WSK-06/WSK-14,
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

// webdesk/payload/vocabulary/primitives.ts
//
// WSK-06 — the 8 field primitives (webdesk-design.md §05, Layer 1). Defined ONCE here; consumed
// by payload.config.ts (this ticket), and later by codegen (WSK-15) and the block-renderer
// library (WSK-16) per the design's explicit instruction ("a typed props schema defined once ...
// consumed by Payload config, codegen, and the block-renderer library").
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

/** A field on a block, described in terms of one primitive (§05 Layer 2: "composition-as-data"). */
export interface FieldDef {
  name: string
  primitive: PrimitiveName
  required?: boolean
  /** 'select' only: the closed set of allowed string values. */
  options?: string[]
  /** 'relation' only: which collection key the relation points at. */
  relationTo?: string
  /** 'relation' | 'media' only: value is an array of the primitive's shape, not a single one. */
  multiple?: boolean
}

export interface PrimitiveDef {
  name: PrimitiveName
  /** Human-readable description of the JSON shape this primitive serializes to on the wire. */
  jsonShape: string
  /** Returns validation error strings; an empty array means the value is valid. */
  validate: (value: unknown, field?: FieldDef) => string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateOne(primitive: PrimitiveName, v: unknown, field?: FieldDef): string[] {
  switch (primitive) {
    case 'text':
      return typeof v === 'string' ? [] : ['expected a string']
    case 'richtext':
      // A Lexical-shaped document ({ root: {...} }, matching @payloadcms/richtext-lexical's
      // already-vendored shape) OR a plain string fallback — the design does not mandate Lexical
      // specifically, only that richtext round-trips through the envelope as structured content.
      if (typeof v === 'string') return []
      if (isPlainObject(v) && 'root' in v) return []
      return ['expected a richtext document ({ root: ... }) or a plain string']
    case 'media':
      if (!isPlainObject(v)) return ['expected a media object']
      if (typeof v.url !== 'string' || v.url.length === 0) return ['media.url must be a non-empty string']
      return []
    case 'relation': {
      const checkOne = (item: unknown): string[] =>
        isPlainObject(item) && typeof item.collection === 'string' && typeof item.slug === 'string'
          ? []
          : ['expected { collection, slug }']
      if (field?.multiple) {
        if (!Array.isArray(v)) return ['expected an array of relations']
        return v.flatMap(checkOne)
      }
      return checkOne(v)
    }
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? [] : ['expected a finite number']
    case 'date':
      if (typeof v !== 'string') return ['expected an ISO-8601 date string']
      return Number.isNaN(Date.parse(v)) ? ['not a parseable ISO-8601 date'] : []
    case 'select':
      if (typeof v !== 'string') return ['expected a string']
      if (field?.options && !field.options.includes(v)) {
        return [`"${v}" is not one of: ${field.options.join(', ')}`]
      }
      return []
    case 'geo': {
      if (!isPlainObject(v)) return ['expected a geo object']
      if (typeof v.lat !== 'number' || typeof v.lng !== 'number') return ['geo requires numeric lat/lng']
      const errors: string[] = []
      if (v.lat < -90 || v.lat > 90) errors.push('lat out of range (-90..90)')
      if (v.lng < -180 || v.lng > 180) errors.push('lng out of range (-180..180)')
      return errors
    }
    default:
      return [`unknown primitive "${primitive}"`]
  }
}

export const PRIMITIVES: Record<PrimitiveName, PrimitiveDef> = {
  text: { name: 'text', jsonShape: 'string', validate: (v, f) => validateOne('text', v, f) },
  richtext: {
    name: 'richtext',
    jsonShape: 'a Lexical-shaped JSON document ({ root: {...} }) or a plain string fallback',
    validate: (v, f) => validateOne('richtext', v, f),
  },
  media: {
    name: 'media',
    jsonShape: '{ url: string, alt?: string, width?: number, height?: number, mime?: string }',
    validate: (v, f) => validateOne('media', v, f),
  },
  relation: {
    name: 'relation',
    jsonShape: '{ collection: string, slug: string } (or an array of the same when field.multiple)',
    validate: (v, f) => validateOne('relation', v, f),
  },
  number: { name: 'number', jsonShape: 'number', validate: (v, f) => validateOne('number', v, f) },
  date: {
    name: 'date',
    jsonShape: 'an ISO-8601 date/time string',
    validate: (v, f) => validateOne('date', v, f),
  },
  select: {
    name: 'select',
    jsonShape: 'string (one of field.options)',
    validate: (v, f) => validateOne('select', v, f),
  },
  geo: {
    name: 'geo',
    jsonShape: '{ lat: number, lng: number }',
    validate: (v, f) => validateOne('geo', v, f),
  },
}

export const PRIMITIVE_NAMES: PrimitiveName[] = Object.keys(PRIMITIVES) as PrimitiveName[]

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
  return PRIMITIVES[field.primitive].validate(value, field).map((e) => `${field.name}: ${e}`)
}
