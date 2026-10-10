// VENDORED — generated from webdesk/payload/vocabulary/breaking-change.ts (WSK-06/WSK-14, frozen per
// webdesk-design.md §05) by webdesk/api/src/delivery/vocabulary/vendor.mjs. DO NOT HAND-EDIT.
// The only transform: LF line endings and relative '.ts' import extensions stripped (this
// package is CommonJS). Re-vendor with `node src/delivery/vocabulary/vendor.mjs`; drift is
// caught by test/delivery/vocabulary-vendor-drift.spec.ts.

// webdesk/payload/vocabulary/breaking-change.ts
//
// WSK-14 — the breaking-change ruleset (webdesk-design.md §05 "Versioning & what makes a change
// breaking"), encoded as three computable classifiers, one per axis of the versioning table:
//
//   1. Vocabulary semver (one, platform-wide)     -> classifyVocabularyChange
//   2. Tenant contract semver (per tenant)         -> classifyTenantContractChange
//   3. Block-renderer library semver               -> classifyRendererChange
//
// The point (design's own words, restated in the WSK-14 ticket): "'breaking' must be computed,
// never judged." Each classifier takes a structural before/after description and returns a bump
// plus the concrete reasons that produced it — never a bare "major"/"minor" with no explanation,
// for the same reason the composition validator never says just "invalid" (WSK-32's AI drafting
// flow, and the humans reviewing its diffs, both need to see WHY).
//
// WSK-64 (vocabulary 1.1.0, write-plane design §2.3) extended the classifier BEFORE the 1.1.0
// shapes landed, because the 1.0.0 version was blind in three places and would have under-rated:
//   - the snapshot now also records which primitives honour `multiple`, which keys a FieldDef may
//     carry and which keys a composition may carry (widening = MINOR, narrowing = MAJOR);
//   - `diffFieldDefs` recurses into a group's sub-fields (1.0.0 rated a removed sub-field PATCH);
//   - it rates `itemKey` (any change MAJOR), `localized` (true->false MAJOR, false->true MINOR) and
//     `ui` (PATCH, editor-only), and on the tenant axis `singleton`/`localized` flips (MAJOR) and
//     `ui`/`lint` edits (PATCH).
// A snapshot missing one of the 1.1.0 dimensions is refused loudly, never silently compared.
import { MULTIPLE_CAPABLE_PRIMITIVES, PRIMITIVE_NAMES, FIELD_DEF_KEYS, type FieldDef, type PrimitiveName } from './primitives'
import { BLOCKS, BLOCK_TYPE_NAMES, FIELDS_BLOCK_TYPE, type BlockDef, type BlockType } from './blocks'
import { COMPOSITION_KEYS, type CollectionUi, type PlaceholderRule } from './composition'
import { buildItemEnvelope, buildListEnvelope } from './envelope'
import { problemDetails } from './problem-details'

export type Bump = 'major' | 'minor' | 'patch'

export interface ChangeClassification {
  bump: Bump
  /** Never empty — even a no-op diff reports "no structural change detected" as its one reason,
   *  so a caller can always render SOMETHING more useful than a bare version bump. */
  reasons: string[]
}

const BUMP_RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 }

export function compareBump(a: Bump, b: Bump): number {
  return BUMP_RANK[a] - BUMP_RANK[b]
}

export function maxBump(...bumps: Bump[]): Bump {
  return bumps.reduce((acc, b) => (compareBump(b, acc) > 0 ? b : acc), 'patch' as Bump)
}

export function bumpVersion(version: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`bumpVersion: "${version}" is not a plain MAJOR.MINOR.PATCH semver string`)
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

interface ReasonedBump {
  bump: Bump
  reason: string
}

function classify(reasoned: ReasonedBump[]): ChangeClassification {
  if (reasoned.length === 0) return { bump: 'patch', reasons: ['no structural change detected'] }
  return { bump: maxBump(...reasoned.map((r) => r.bump)), reasons: reasoned.map((r) => r.reason) }
}

// =================================================================================================
// Shared: diffing two FieldDef[] sets. Used by BOTH the vocabulary axis (a block's `props`, i.e.
// its FieldDef[]) and the tenant-contract axis (a collection's `fields`) — same underlying shape,
// same rules, per §05's table cells sharing near-identical language ("remove/rename a primitive
// or block type" / "remove/rename a collection or field"; "new optional prop on an existing
// block" / "add a collection/field/optional prop").
// =================================================================================================
/** Order-independent structural equality for small JSON values (ui/lint objects). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

function diffFieldDefs(scope: string, before: FieldDef[], after: FieldDef[]): ReasonedBump[] {
  const out: ReasonedBump[] = []
  const beforeByName = new Map(before.map((f) => [f.name, f]))
  const afterByName = new Map(after.map((f) => [f.name, f]))

  for (const [name] of beforeByName) {
    if (!afterByName.has(name)) {
      out.push({ bump: 'major', reason: `${scope}: field "${name}" removed (removal/rename is always MAJOR)` })
    }
  }
  for (const [name, field] of afterByName) {
    if (!beforeByName.has(name)) {
      // A new REQUIRED field breaks existing composed content that never supplied it — only a
      // new OPTIONAL field is the MINOR case §05 names explicitly ("new optional prop").
      if (field.required) {
        out.push({ bump: 'major', reason: `${scope}: field "${name}" added as REQUIRED (existing content lacking it would break)` })
      } else {
        out.push({ bump: 'minor', reason: `${scope}: field "${name}" added as optional` })
      }
    }
  }
  for (const [name, beforeField] of beforeByName) {
    const afterField = afterByName.get(name)
    if (!afterField) continue

    if (beforeField.primitive !== afterField.primitive) {
      out.push({
        bump: 'major',
        reason: `${scope}: field "${name}" primitive changed from "${beforeField.primitive}" to "${afterField.primitive}" (type narrowed/changed)`,
      })
    }

    const wasRequired = !!beforeField.required
    const isRequired = !!afterField.required
    if (!wasRequired && isRequired) {
      out.push({ bump: 'major', reason: `${scope}: field "${name}" flipped optional -> required` })
    } else if (wasRequired && !isRequired) {
      out.push({ bump: 'minor', reason: `${scope}: field "${name}" relaxed required -> optional` })
    }

    // Interpretation (flagged in the ticket report): §05 lists "narrow a type" without spelling
    // out select-option or multiplicity narrowing specifically. Treated here as the same MAJOR
    // bucket because both are, structurally, exactly that — a narrower/incompatible wire shape.
    if (beforeField.primitive === 'select' && afterField.primitive === 'select' && beforeField.options && afterField.options) {
      const removedOptions = beforeField.options.filter((o) => !afterField.options!.includes(o))
      const addedOptions = afterField.options.filter((o) => !beforeField.options!.includes(o))
      if (removedOptions.length > 0) {
        out.push({ bump: 'major', reason: `${scope}: field "${name}" select options narrowed (removed: ${removedOptions.join(', ')})` })
      } else if (addedOptions.length > 0) {
        out.push({ bump: 'minor', reason: `${scope}: field "${name}" select options widened (added: ${addedOptions.join(', ')})` })
      }
    }

    if (!!beforeField.multiple !== !!afterField.multiple) {
      out.push({
        bump: 'major',
        reason: `${scope}: field "${name}" multiplicity changed (multiple: ${!!beforeField.multiple} -> ${!!afterField.multiple}) — the wire shape changes between a single value and an array`,
      })
    }

    // WSK-64: recurse into a group's sub-fields. Without this a removed sub-field rated PATCH.
    if (beforeField.primitive === 'group' && afterField.primitive === 'group') {
      out.push(...diffFieldDefs(`${scope} > group "${name}"`, beforeField.fields ?? [], afterField.fields ?? []))
    }

    // WSK-64: itemKey is list-item identity. Adding, removing or renaming it changes identity.
    const beforeKey = beforeField.itemKey ?? null
    const afterKey = afterField.itemKey ?? null
    if (beforeKey !== afterKey) {
      out.push({
        bump: 'major',
        reason: `${scope}: field "${name}" itemKey changed (${JSON.stringify(beforeKey)} -> ${JSON.stringify(afterKey)}) — list item identity changes`,
      })
    }

    // WSK-64: localized defaults to true. true -> false drops every non-default-locale value for consumers.
    const wasLocalized = beforeField.localized !== false
    const isLocalized = afterField.localized !== false
    if (wasLocalized && !isLocalized) {
      out.push({ bump: 'major', reason: `${scope}: field "${name}" localized true -> false (consumers lose non-default-locale values)` })
    } else if (!wasLocalized && isLocalized) {
      out.push({ bump: 'minor', reason: `${scope}: field "${name}" localized false -> true` })
    }

    // WSK-64: ui is editor-only and never reaches the wire.
    if (canonical(beforeField.ui ?? {}) !== canonical(afterField.ui ?? {})) {
      out.push({ bump: 'patch', reason: `${scope}: field "${name}" ui changed (editor-only, descriptive)` })
    }
  }

  return out
}

// =================================================================================================
// Axis 1 — Vocabulary semver
// =================================================================================================
export interface VocabularySnapshot {
  primitives: PrimitiveName[]
  blocks: Record<string, Pick<BlockDef, 'fields'>>
  /** Canonical, sorted list of dot-paths the frozen envelope(s) expose. Build with
   *  `currentEnvelopeShapeSignature()` for "the real shipped shape", or hand-construct a mutated
   *  copy for a test. `x` (the reserved extension namespace) and `seo` (documented free-form
   *  jsonb) are deliberately opaque leaves — their INNER keys are not part of the frozen shape. */
  envelopeShape: string[]
  /** WSK-64: primitives whose validator honours `multiple`. Widening is MINOR, narrowing MAJOR. */
  multipleCapable: PrimitiveName[]
  /** WSK-64: keys a FieldDef may carry. A new key is MINOR, a removed one MAJOR. */
  fieldDefKeys: string[]
  /** WSK-64: keys a collection composition may carry. A new key is MINOR, a removed one MAJOR. */
  compositionKeys: string[]
}

function paths(obj: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(obj).flatMap((k) => {
    const v = obj[k]
    const p = `${prefix}.${k}`
    // 'x' (meta.x) is explicitly "additive forever" (§05 v1.1) and 'seo' is explicitly free-form
    // jsonb ("not exhaustive", envelope.ts's own SeoShape doc comment) — neither is descended
    // into; only their PRESENCE at this level is part of the frozen shape.
    if (k === 'x' || k === 'seo') return [p]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return paths(v as Record<string, unknown>, p)
    return [p]
  })
}

/** The envelope shape as it is ACTUALLY shipped right now, read off the real frozen builders in
 *  ./envelope.ts and ./problem-details.ts — not an independently hand-maintained parallel list
 *  that could silently drift out of sync with the frozen files. */
export function currentEnvelopeShapeSignature(): string[] {
  const item = buildItemEnvelope({
    collectionKey: 'x',
    slug: 'x',
    locale: 'x',
    localizations: [],
    seo: {},
    publishedAt: null,
    updatedAt: 'x',
    draft: false,
    blocks: [],
  })
  const list = buildListEnvelope({ collectionKey: 'x', locale: 'x', items: [], cursor: null, hasMore: false, limit: 1 })
  const err = problemDetails({ slug: 'x', title: 'x', status: 500, instance: 'x', requestId: 'x' })
  return [
    ...paths(item as unknown as Record<string, unknown>, 'item'),
    ...paths(list as unknown as Record<string, unknown>, 'list'),
    ...paths(err as unknown as Record<string, unknown>, 'error'),
  ].sort()
}

export function currentVocabularySnapshot(): VocabularySnapshot {
  const blocks: Record<string, Pick<BlockDef, 'fields'>> = {}
  for (const type of BLOCK_TYPE_NAMES) blocks[type] = { fields: BLOCKS[type].fields }
  return {
    primitives: [...PRIMITIVE_NAMES],
    blocks,
    envelopeShape: currentEnvelopeShapeSignature(),
    multipleCapable: [...MULTIPLE_CAPABLE_PRIMITIVES].sort(),
    fieldDefKeys: [...FIELD_DEF_KEYS].sort(),
    compositionKeys: [...COMPOSITION_KEYS].sort(),
  }
}

const SNAPSHOT_DIMENSIONS = ['primitives', 'blocks', 'envelopeShape', 'multipleCapable', 'fieldDefKeys', 'compositionKeys'] as const

function assertCompleteSnapshot(which: string, snap: VocabularySnapshot): void {
  const missing = SNAPSHOT_DIMENSIONS.filter((d) => (snap as unknown as Record<string, unknown>)[d] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `classifyVocabularyChange: the ${which} snapshot lacks ${missing.join(', ')}, so it predates WSK-64's extended snapshot. ` +
        'Recapture it with payload/test/wsk64-snapshot-probe.mjs rather than comparing blind.',
    )
  }
}

function diffKeySet(label: string, before: string[], after: string[]): ReasonedBump[] {
  const out: ReasonedBump[] = []
  const b = new Set(before)
  const a = new Set(after)
  for (const k of [...b].sort()) {
    if (!a.has(k)) out.push({ bump: 'major', reason: `${label} key "${k}" removed (content or compositions using it no longer validate)` })
  }
  for (const k of [...a].sort()) {
    if (!b.has(k)) out.push({ bump: 'minor', reason: `${label} key "${k}" added (new optional key)` })
  }
  return out
}

export function classifyVocabularyChange(before: VocabularySnapshot, after: VocabularySnapshot): ChangeClassification {
  assertCompleteSnapshot('before', before)
  assertCompleteSnapshot('after', after)
  const reasoned: ReasonedBump[] = []

  // Hard rule 1 (§05): "the /v1 envelope is frozen ... envelope evolution means /v2 as a new
  // path, never a mutation." Unlike primitives/blocks (where an ADDITION is MINOR), ANY envelope
  // shape delta — added, removed, or renamed — is unconditionally MAJOR.
  const beforeShape = new Set(before.envelopeShape)
  const afterShape = new Set(after.envelopeShape)
  const removedPaths = before.envelopeShape.filter((p) => !afterShape.has(p))
  const addedPaths = after.envelopeShape.filter((p) => !beforeShape.has(p))
  if (removedPaths.length > 0 || addedPaths.length > 0) {
    const detail = [
      removedPaths.length ? `removed: ${removedPaths.join(', ')}` : null,
      addedPaths.length ? `added: ${addedPaths.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ')
    reasoned.push({ bump: 'major', reason: `envelope shape changed (${detail}) — envelope evolution is /v2, never a mutation (hard rule 1)` })
  }

  const beforePrimitives = new Set(before.primitives)
  const afterPrimitives = new Set(after.primitives)
  for (const p of beforePrimitives) {
    if (!afterPrimitives.has(p)) reasoned.push({ bump: 'major', reason: `primitive "${p}" removed/renamed` })
  }
  for (const p of afterPrimitives) {
    if (!beforePrimitives.has(p)) reasoned.push({ bump: 'minor', reason: `primitive "${p}" added` })
  }

  const beforeBlockTypes = new Set(Object.keys(before.blocks))
  const afterBlockTypes = new Set(Object.keys(after.blocks))
  for (const t of beforeBlockTypes) {
    if (!afterBlockTypes.has(t)) reasoned.push({ bump: 'major', reason: `block type "${t}" removed/renamed` })
  }
  for (const t of afterBlockTypes) {
    if (beforeBlockTypes.has(t)) continue
    reasoned.push({
      bump: 'minor',
      reason:
        t === FIELDS_BLOCK_TYPE
          ? `block type "${t}" added (the composition-typed block: its props are typed per collection, not by the vocabulary)`
          : `block type "${t}" added`,
    })
  }
  for (const t of beforeBlockTypes) {
    if (!afterBlockTypes.has(t)) continue
    reasoned.push(...diffFieldDefs(`block "${t}" props`, before.blocks[t].fields, after.blocks[t].fields))
  }

  // WSK-64: which primitives honour `multiple`. Only primitives present on both sides are rated
  // here; a primitive's own addition or removal is already rated above.
  const stillPresent = (p: PrimitiveName) => beforePrimitives.has(p) && afterPrimitives.has(p)
  const beforeMultiple = new Set(before.multipleCapable)
  const afterMultiple = new Set(after.multipleCapable)
  const widened = [...afterMultiple].filter((p) => stillPresent(p) && !beforeMultiple.has(p)).sort()
  const narrowed = [...beforeMultiple].filter((p) => stillPresent(p) && !afterMultiple.has(p)).sort()
  if (narrowed.length > 0) {
    reasoned.push({ bump: 'major', reason: `"multiple" no longer honoured for primitive(s) ${narrowed.join(', ')} (stored arrays stop validating)` })
  }
  if (widened.length > 0) {
    reasoned.push({ bump: 'minor', reason: `"multiple" now honoured for primitive(s) ${widened.join(', ')} (new capability)` })
  }

  reasoned.push(...diffKeySet('FieldDef', before.fieldDefKeys, after.fieldDefKeys))
  reasoned.push(...diffKeySet('composition', before.compositionKeys, after.compositionKeys))

  return classify(reasoned)
}

// =================================================================================================
// Axis 2 — Tenant contract semver
// =================================================================================================
export interface CollectionFieldSet {
  fields: FieldDef[]
  /** Which vocabulary block types this collection's content is composed from — the same
   *  information composition.ts's `CollectionComposition.blocks` carries — needed only for the
   *  usage-gated "vocabulary MAJOR reaching a block the tenant uses" propagation rule below.
   *  Omit (or `[]`) for a fields-only collection (e.g. `redirect`), which by definition uses no
   *  block types and can never be reached by a block-props MAJOR. */
  blocks?: BlockType[]
  /** WSK-64: at most one item per locale. Any flip is MAJOR. */
  singleton?: boolean
  /** WSK-64, default true. Any flip is MAJOR (the item set per locale changes). */
  localized?: boolean
  /** WSK-64: editor-only. Any change is PATCH. */
  ui?: CollectionUi
  /** WSK-64: advisory lint. Any change is PATCH. */
  lint?: { placeholders?: PlaceholderRule[] }
}

export interface TenantContractSnapshot {
  collections: Record<string, CollectionFieldSet>
}

export interface VocabularyChangeContext {
  bump: Bump
  /** Block types the vocabulary change touched (removed/renamed/non-additive props change).
   *  Required for the MAJOR-propagation rule to fire selectively; §05's MINOR cell has no
   *  "reaching a block the tenant uses" qualifier, so a MINOR vocabulary bump propagates to every
   *  tenant contract unconditionally — only the MAJOR case is usage-gated. */
  affectedBlockTypes?: BlockType[]
}

export function classifyTenantContractChange(
  before: TenantContractSnapshot,
  after: TenantContractSnapshot,
  vocabularyChange?: VocabularyChangeContext,
): ChangeClassification {
  const reasoned: ReasonedBump[] = []

  const beforeKeys = new Set(Object.keys(before.collections))
  const afterKeys = new Set(Object.keys(after.collections))

  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) reasoned.push({ bump: 'major', reason: `collection "${key}" removed/renamed` })
  }
  for (const key of afterKeys) {
    if (!beforeKeys.has(key)) reasoned.push({ bump: 'minor', reason: `collection "${key}" added` })
  }
  for (const key of beforeKeys) {
    if (!afterKeys.has(key)) continue
    reasoned.push(...diffFieldDefs(`collection "${key}"`, before.collections[key].fields, after.collections[key].fields))

    // Interpretation (flagged in the ticket report): §05's tenant-contract row names "field", not
    // a collection's own allowed-block-types set, explicitly — but a composition's `blocks` list
    // IS that collection's structural surface in exactly the same sense a field is, so the same
    // remove=MAJOR/add=MINOR rule is applied to it here.
    const beforeBlocks = new Set(before.collections[key].blocks ?? [])
    const afterBlocks = new Set(after.collections[key].blocks ?? [])
    for (const b of beforeBlocks) {
      if (!afterBlocks.has(b)) {
        reasoned.push({ bump: 'major', reason: `collection "${key}": block type "${b}" removed from its allowed set` })
      }
    }
    for (const b of afterBlocks) {
      if (!beforeBlocks.has(b)) {
        reasoned.push({ bump: 'minor', reason: `collection "${key}": block type "${b}" added to its allowed set` })
      }
    }

    // WSK-64: collection-level 1.1.0 keys.
    const bc = before.collections[key]
    const ac = after.collections[key]
    if (!!bc.singleton !== !!ac.singleton) {
      reasoned.push({ bump: 'major', reason: `collection "${key}": singleton flipped ${!!bc.singleton} -> ${!!ac.singleton}` })
    }
    if ((bc.localized !== false) !== (ac.localized !== false)) {
      reasoned.push({ bump: 'major', reason: `collection "${key}": localized flipped ${bc.localized !== false} -> ${ac.localized !== false}` })
    }
    if (canonical(bc.ui ?? {}) !== canonical(ac.ui ?? {})) {
      reasoned.push({ bump: 'patch', reason: `collection "${key}": ui changed (editor-only, descriptive)` })
    }
    if (canonical(bc.lint ?? {}) !== canonical(ac.lint ?? {})) {
      reasoned.push({ bump: 'patch', reason: `collection "${key}": lint changed (advisory only)` })
    }
  }

  if (vocabularyChange) {
    if (vocabularyChange.bump === 'minor') {
      reasoned.push({ bump: 'minor', reason: 'a vocabulary MINOR release reaches every tenant contract unconditionally' })
    } else if (vocabularyChange.bump === 'major') {
      // "a vocabulary MAJOR reaching a block the tenant uses" — usage-gated: a tenant whose
      // composition never references the affected block type is untouched by this MAJOR.
      const affected = new Set(vocabularyChange.affectedBlockTypes ?? [])
      for (const key of afterKeys) {
        const usedBlocks = after.collections[key].blocks ?? []
        const touched = usedBlocks.filter((b) => affected.has(b))
        if (touched.length > 0) {
          reasoned.push({
            bump: 'major',
            reason: `collection "${key}" uses block type(s) ${touched.join(', ')} affected by a vocabulary MAJOR change`,
          })
        }
      }
    }
  }

  return classify(reasoned)
}

// =================================================================================================
// Axis 3 — Block-renderer library semver
// =================================================================================================
export interface RendererDiff {
  addedComponents?: string[]
  removedComponents?: string[]
  /**
   * Component names whose markup contract changed in a way that breaks styling/slots. This is the
   * one place in this file that still requires a human/authoring judgment call, because it is the
   * design's OWN rule (§05: "a rendered block's markup contract in a way that breaks styling/
   * slots") — a renderer diff has no machine-checkable definition of "breaks styling" without a
   * rendered-output snapshot system this ticket does not build. Once a component is flagged here,
   * the resulting version bump is computed, never re-judged — the classifier does not second-guess
   * the flag, it only aggregates it deterministically alongside every other signal.
   */
  breakingMarkupChanges?: string[]
  fixes?: string[]
}

export function classifyRendererChange(diff: RendererDiff): ChangeClassification {
  const reasoned: ReasonedBump[] = []

  for (const c of diff.breakingMarkupChanges ?? []) {
    reasoned.push({ bump: 'major', reason: `"${c}"'s markup contract changed in a way that breaks styling/slots` })
  }
  // Interpretation (flagged in the ticket report): §05's table names only the markup-contract
  // case for MAJOR; a removed component is treated the same way here, since a site referencing a
  // now-absent component is exactly as broken as one referencing a changed-incompatibly one.
  for (const c of diff.removedComponents ?? []) {
    reasoned.push({ bump: 'major', reason: `component "${c}" removed` })
  }
  for (const c of diff.addedComponents ?? []) {
    reasoned.push({ bump: 'minor', reason: `new block component "${c}"` })
  }
  for (const f of diff.fixes ?? []) {
    reasoned.push({ bump: 'patch', reason: `fix: ${f}` })
  }

  return classify(reasoned)
}
