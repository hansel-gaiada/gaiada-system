// VENDORED from webdesk/delivery/vocabulary/client-editable.ts by platform-nest/scripts/vendor-webdesk-vocabulary.mjs (WSK-49c).
// DO NOT HAND-EDIT. Regenerate with `npm run vendor:webdesk-vocabulary`; `npm run vendor:check` (and the test
// suite) fails when this file and its source disagree. The only change from the source is that a relative
// import's `.ts` suffix is dropped (this package compiles to CommonJS with tsc).

// webdesk/delivery/vocabulary/client-editable.ts
//
// WSK-49a (vocabulary 1.2.0, ruling WSK-D59) — which parts of an item a CLIENT EDITOR may change.
//
// D59: "Clients change only what the composition marks client-editable." A collection's composition
// and each FieldDef may carry `ui.clientEditable`. This file is the ONE place that decides what that
// means; the write plane (webdesk/api/src/control/content/content-commands.service.ts) and, by the same
// rule, the ERP's portal BFF (49c) and the portal UI (49d) all ask `isClientEditable`. Nothing else
// restates the rule.
//
// THE RULE, exactly:
//
//     a field is client-editable  iff
//         field.ui.clientEditable
//           ?? <its parent group's effective value>
//           ?? collection.ui.clientEditable
//           ?? false
//
//   * A top-level field's parent is the collection, so it falls through to `collection.ui.clientEditable`.
//   * A nested group's members inherit from the group, and the group's own effective value is computed the
//     same way, so inheritance is transitive: a member's own flag wins, else the group's effective value.
//   * A generic block (any block after the composition-typed `fields` block, or any block of a collection
//     that declares no `fields`) is client-editable iff the COLLECTION is.
//   * `seo` is NEVER client-editable, whatever any flag says. This is a design default, not an accident:
//     the agency keeps SEO-critical fields (titles, descriptions, canonicals, redirects) because a client
//     edit there can silently cost search rankings, and D59's reason for the whole mechanism is that
//     "agency-built sites keep structure and SEO-critical fields under the agency's control". The owner
//     may widen it by a new ruling; until then nothing in a composition can open it.
//   * The `fields` block itself (blocks[0]: its type, its props object, its slot) is STRUCTURE, never
//     editable; only the values of its declared fields are.
//   * Anything that does not resolve (an unknown field name, a malformed pointer, an index that is not a
//     canonical non-negative integer, a composition that is not an object) is NOT editable. Every doubt
//     answers false: this is the least-trusted write path in the system.
//
// Editor metadata only: no stored value changes and the /v1 envelope is unchanged by a byte.
//
// POINTERS. Everything here speaks RFC 6901 JSON pointers into the item's stored content, `{ blocks,
// seo }` (the same coordinates `validateItemContent` reports its issues in): `/blocks/0/props/title`,
// `/blocks/0/props/faq/2/answer`, `/blocks/1/props/html`, `/seo/title`.
import type { FieldDef } from './primitives'
import type { CollectionComposition } from './composition'

/** An item's stored content: what a version holds. */
export interface ItemContent {
  blocks: unknown
  seo: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function unescapeSegment(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~')
}

function escapeSegment(key: string | number): string {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1')
}

/** A canonical array index: "0", "1", "23" — never "01", "-1", "1.5", "" or "1e2". */
function isIndex(s: string | undefined): boolean {
  return s !== undefined && /^(0|[1-9][0-9]{0,8})$/.test(s)
}

function fieldNamed(fields: unknown, name: string): FieldDef | null {
  if (!Array.isArray(fields)) return null
  for (const f of fields) {
    if (isPlainObject(f) && f.name === name) return f as unknown as FieldDef
  }
  return null
}

/** `field.ui.clientEditable ?? inherited`: the rule for ONE field, given its parent's effective value. */
function effective(field: FieldDef, inherited: boolean): boolean {
  const own = isPlainObject(field.ui) ? (field.ui as Record<string, unknown>).clientEditable : undefined
  return typeof own === 'boolean' ? own : inherited
}

function collectionDefault(composition: CollectionComposition): boolean {
  return isPlainObject(composition) && isPlainObject(composition.ui) && composition.ui.clientEditable === true
}

/**
 * Resolves the effective value of the field a chain of pointer segments (after `/blocks/0/props`) lands
 * in. `null` = the chain does not resolve to a declared field.
 */
function resolveFieldChain(composition: CollectionComposition, segments: string[]): boolean | null {
  let fields: unknown = composition.fields
  let inherited = collectionDefault(composition)
  let i = 0
  for (;;) {
    const name = segments[i]
    if (name === undefined) return null
    const field = fieldNamed(fields, name)
    if (!field) return null
    const eff = effective(field, inherited)
    i++
    // Anything below a non-group field is inside that field's own value (a media object's `alt`, an
    // element of a multiple scalar): it is the field's.
    if (field.primitive !== 'group') return eff
    if (field.multiple) {
      // A list of objects: the next segment is an index, which the rule skips.
      if (i >= segments.length) return eff
      if (!isIndex(segments[i])) return null
      i++
    }
    if (i >= segments.length) return eff // the pointer ends at the group (or one of its items)
    fields = field.fields
    inherited = eff
  }
}

/**
 * THE rule. Is the part of an item that `pointer` names client-editable under `composition`?
 * Pure, synchronous, never throws.
 */
export function isClientEditable(composition: CollectionComposition, pointer: string): boolean {
  if (!isPlainObject(composition) || typeof pointer !== 'string' || !pointer.startsWith('/')) return false
  const segments = pointer.slice(1).split('/').map(unescapeSegment)
  const root = segments[0]
  // seo is NEVER client-editable (see the header). Checked first so no flag can reach it.
  if (root === 'seo') return false
  if (root !== 'blocks') return false
  if (!isIndex(segments[1])) return false
  const index = Number(segments[1])
  const declaresFields = Array.isArray(composition.fields)
  if (declaresFields && index === 0) {
    // The composition-typed fields block: only `/blocks/0/props/<field>...` can be editable.
    if (segments[2] !== 'props' || segments.length < 4) return false
    return resolveFieldChain(composition, segments.slice(3)) === true
  }
  // A generic block: editable iff the collection is.
  return collectionDefault(composition)
}

function anyFieldEditable(fields: unknown, inherited: boolean): boolean {
  if (!Array.isArray(fields)) return false
  for (const f of fields) {
    if (!isPlainObject(f)) continue
    const field = f as unknown as FieldDef
    const eff = effective(field, inherited)
    if (eff) return true
    if (field.primitive === 'group' && anyFieldEditable(field.fields, eff)) return true
  }
  return false
}

/**
 * Can a client editor CREATE an item in this collection at all? True iff at least one field is
 * client-editable (at any depth), or the collection is client-editable and allows generic blocks.
 * A collection where nothing is editable gives a client nothing to author.
 */
export function collectionAcceptsClientCreate(composition: CollectionComposition): boolean {
  if (!isPlainObject(composition)) return false
  if (anyFieldEditable(composition.fields, collectionDefault(composition))) return true
  const blocksAllowed = composition.blocks === undefined || (Array.isArray(composition.blocks) && composition.blocks.length > 0)
  return collectionDefault(composition) && blocksAllowed
}

// =================================================================================================
// The content diff
// =================================================================================================

/** Deeper than any legitimate item (group nesting is <= 4; a Lexical tree is far shallower). Beyond it, fail closed. */
const MAX_DIFF_DEPTH = 100

/** Structural JSON equality. Key order is not significant. Past MAX_DIFF_DEPTH it answers "not equal". */
function deepEqual(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true
  if (depth > MAX_DIFF_DEPTH) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false
    return true
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false
    const ak = Object.keys(a)
    if (ak.length !== Object.keys(b).length) return false
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], depth + 1)) return false
    }
    return true
  }
  return false
}

/** Every leaf pointer under a container (an empty container is itself the leaf). Stops at the depth cap. */
function addLeaves(value: unknown, ptr: string, out: Set<string>, depth: number): void {
  if (depth > MAX_DIFF_DEPTH) {
    out.add(ptr)
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.add(ptr)
    value.forEach((v, i) => addLeaves(v, `${ptr}/${i}`, out, depth + 1))
    return
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) out.add(ptr)
    for (const k of keys) addLeaves(value[k], `${ptr}/${escapeSegment(k)}`, out, depth + 1)
    return
  }
  out.add(ptr)
}

/** An OWN property or undefined: a hostile `__proto__` key must never be read through the prototype chain. */
function own(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined
}

function diffInto(a: unknown, b: unknown, ptr: string, out: Set<string>, depth: number): void {
  if (deepEqual(a, b, depth)) return
  if (depth > MAX_DIFF_DEPTH) {
    out.add(ptr)
    return
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffInto(own(a, k), own(b, k), `${ptr}/${escapeSegment(k)}`, out, depth + 1)
    }
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) diffInto(a[i], b[i], `${ptr}/${i}`, out, depth + 1)
    return
  }
  // A scalar changed, a key or element appeared or vanished, or the KIND changed. A scalar side is a
  // change at this pointer. A container side contributes every leaf under it instead of itself, so a
  // non-editable member inside a newly added, removed or replaced object cannot hide behind an editable
  // parent, and an editable member can still be set when its non-editable parent object is new.
  const isContainer = (v: unknown): boolean => Array.isArray(v) || isPlainObject(v)
  if ((a !== undefined && !isContainer(a)) || (b !== undefined && !isContainer(b))) out.add(ptr)
  for (const side of [a, b]) if (isContainer(side)) addLeaves(side, ptr, out, depth)
}

/** The RFC 6901 pointers (sorted) of every leaf that differs between two stored contents. Pure; never throws. */
export function changedContentPointers(before: ItemContent, after: ItemContent): string[] {
  const out = new Set<string>()
  diffInto(before.blocks, after.blocks, '/blocks', out, 0)
  diffInto(before.seo, after.seo, '/seo', out, 0)
  return [...out].sort()
}

/**
 * UPDATE / RESTORE by a client editor: the changed pointers that are NOT client-editable. Empty = the
 * change is allowed. Every changed path must be editable; one non-editable path refuses the whole write.
 */
export function clientEditViolations(composition: CollectionComposition, before: ItemContent, after: ItemContent): string[] {
  return changedContentPointers(before, after).filter((p) => !isClientEditable(composition, p))
}

/** Drops `null`/`undefined` object members recursively: "absent" and "null" both mean "its default". */
function withoutNulls(v: unknown, depth: number): unknown {
  if (depth > MAX_DIFF_DEPTH) return v
  if (Array.isArray(v)) return v.map((x) => withoutNulls(x, depth + 1))
  if (isPlainObject(v)) {
    // A null-prototype object, so a "__proto__" key is copied as an ordinary key rather than re-parenting `out`.
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) out[k] = withoutNulls(x, depth + 1)
    return out
  }
  return v
}

/**
 * CREATE by a client editor: every non-editable part of the new content must be absent or equal to its
 * default, so the new content is compared with a blank item (an empty fields block when the collection
 * declares fields, no blocks otherwise, empty seo). A FieldDef has no declared default, so a field's
 * default is "unset": absent or `null`. `seo` must therefore be empty. Returns the non-editable pointers
 * that carry a value. (A required non-editable field cannot be satisfied by a client; the collection's
 * ordinary validation reports it as missing.)
 */
export function clientCreateViolations(composition: CollectionComposition, content: ItemContent): string[] {
  const blank: ItemContent = {
    blocks: isPlainObject(composition) && Array.isArray(composition.fields) ? [{ type: 'fields', props: {} }] : [],
    seo: {},
  }
  const given: ItemContent = { blocks: withoutNulls(content.blocks, 0), seo: withoutNulls(content.seo, 0) }
  return changedContentPointers(blank, given).filter((p) => !isClientEditable(composition, p))
}
