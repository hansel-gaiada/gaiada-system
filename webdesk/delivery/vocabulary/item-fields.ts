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
// M5-V5-a (vocabulary 1.5.0, design docs/plans/2026-10-12-m5-phase5-design.md section 5.1) adds the `experiment`
// block: an A/B test over the item's own fields or over one of its generic blocks. It is allowed in every
// collection without being listed, at most once per item, never at index 0. validateItemContent checks its
// shape (`validateExperimentBlock`); `experimentLockViolations` is the pure half of the publish lock: a version
// that changes a RUNNING experiment (the one the LIVE version carries) or the control values it overrides is
// refused by the write plane. Removing the block (the stop) is always allowed.
//
// The `redirect` system collection is the one documented exception (write-plane design §2.7): its
// values live under `seo.redirect`, so WSK-41's write path does not run it through this check.
import { MAX_GROUP_DEPTH, pointerSegment, validateFieldValue, type FieldDef } from './primitives.ts'
import { COMPOSABLE_BLOCK_TYPE_NAMES, EXPERIMENT_BLOCK_TYPE, FIELDS_BLOCK_TYPE, isBlockType, isComposableBlockType, validateBlock } from './blocks.ts'
import type { CollectionComposition } from './composition.ts'

export { FIELDS_BLOCK_TYPE, EXPERIMENT_BLOCK_TYPE }

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
  const experimentAt: number[] = []

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
    if (b.type === EXPERIMENT_BLOCK_TYPE) {
      experimentAt.push(i)
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

  // 1.5.0: the experiment block. Allowed in every collection (never listed), at most one, never at index 0.
  for (const [n, i] of experimentAt.entries()) {
    if (n > 0) {
      issues.push(itemIssue(`/blocks/${i}`, `duplicate "${EXPERIMENT_BLOCK_TYPE}" block: an item carries at most one experiment`))
    } else if (i === 0) {
      issues.push(itemIssue(`/blocks/${i}`, `the "${EXPERIMENT_BLOCK_TYPE}" block can never be blocks[0] (it tests the item's content, so that content comes first)`))
    } else {
      issues.push(...validateExperimentBlock(composition, blocks, i))
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

// =================================================================================================
// 1.5.0 (M5-V5-a): the `experiment` block
// =================================================================================================

/** `props.key`: unique per property (the ERP enforces that); this is the shape only. */
export const EXPERIMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/
/** The arm keys in order: `a` is the control and comes first; an experiment has 2 to 4 arms. */
export const EXPERIMENT_ARM_KEYS: readonly string[] = ['a', 'b', 'c', 'd']
export const EXPERIMENT_MIN_ARMS = 2
/** An arm's integer weight is at least this, and the weights sum to 100. */
export const EXPERIMENT_MIN_WEIGHT = 10
export const EXPERIMENT_ENROLMENTS: readonly string[] = ['consented', 'all']
/** The site events a goal may name (the site's own analytics event names). */
export const EXPERIMENT_GOAL_EVENTS: readonly string[] = [
  'generate_lead',
  'lead_form_start',
  'cta_click',
  'click_whatsapp',
  'click_phone',
  'click_email',
  'section_view',
]
/** A goal's `match` holds at most one of these, each value matching EXPERIMENT_MATCH_PATTERN. */
export const EXPERIMENT_MATCH_KEYS: readonly string[] = ['form_id', 'link_location', 'section_id']
export const EXPERIMENT_MATCH_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

const EXPERIMENT_PROP_KEYS = ['key', 'target', 'enrolment', 'goal', 'arms'] as const
const EXPERIMENT_ARM_PROP_KEYS = ['key', 'weight', 'override', 'replace'] as const

function ownKeyOf(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined
}

/** Structural JSON equality; key order is not significant (jsonb does not keep it). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => jsonEqual(x, b[i]))
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false
    const ak = Object.keys(a)
    if (ak.length !== Object.keys(b).length) return false
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

function closedKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, issues: ItemIssue[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) issues.push(itemIssue(`${path}/${pointerSegment(k)}`, `unknown key "${k}" on an experiment`, allowed.join(' | ')))
  }
}

/**
 * Validates the experiment block at `blocks[index]` (the caller has checked the block is an object with object
 * `props`, that it is the item's first experiment and that `index > 0`). The rules are design section 5.1's:
 *   * props closed to key, target, enrolment, goal, arms; `key` matches EXPERIMENT_KEY_PATTERN;
 *   * `enrolment` (optional, default "consented") is "consented" or "all";
 *   * `goal.event` is one of EXPERIMENT_GOAL_EVENTS; `goal.match` holds at most one of EXPERIMENT_MATCH_KEYS;
 *   * 2 to 4 arms keyed a, b, c, d in that order; integer weights >= 10 summing to 100; arm `a` (the control)
 *     never overrides;
 *   * `target: "fields"`: the collection declares fields, every other arm's `override` names declared fields
 *     only, and `{ ...fields, ...override }` passes validateFieldValues for the overridden keys;
 *   * `target: { block: i }`: `blocks[i]` is a generic block (not the fields block, not the experiment) and every
 *     other arm's `replace` is a block of the same type that passes validateBlock.
 */
export function validateExperimentBlock(composition: CollectionComposition, blocks: unknown[], index: number): ItemIssue[] {
  const at = `/blocks/${index}/props`
  const issues: ItemIssue[] = []
  const block = blocks[index] as Record<string, unknown>
  const props = (block.props ?? {}) as Record<string, unknown>
  closedKeys(props, EXPERIMENT_PROP_KEYS, at, issues)

  if (typeof props.key !== 'string' || !EXPERIMENT_KEY_PATTERN.test(props.key)) {
    issues.push(itemIssue(`${at}/key`, 'the experiment key must be 3 to 48 characters of a-z, 0-9 and "-", starting with a letter or digit', EXPERIMENT_KEY_PATTERN.source))
  }
  if (props.enrolment !== undefined && !(typeof props.enrolment === 'string' && EXPERIMENT_ENROLMENTS.includes(props.enrolment))) {
    issues.push(itemIssue(`${at}/enrolment`, 'enrolment must be "consented" (the default) or "all"', EXPERIMENT_ENROLMENTS.join(' | ')))
  }

  // goal
  const goal = props.goal
  if (!isPlainObject(goal)) {
    issues.push(itemIssue(`${at}/goal`, 'goal must be an object { event, match? }', '{ event, match? }'))
  } else {
    closedKeys(goal, ['event', 'match'], `${at}/goal`, issues)
    if (typeof goal.event !== 'string' || !EXPERIMENT_GOAL_EVENTS.includes(goal.event)) {
      issues.push(itemIssue(`${at}/goal/event`, 'goal.event is not one of the allowed site events', EXPERIMENT_GOAL_EVENTS.join(' | ')))
    }
    if (goal.match !== undefined) {
      if (!isPlainObject(goal.match)) {
        issues.push(itemIssue(`${at}/goal/match`, 'goal.match must be an object with at most one key', EXPERIMENT_MATCH_KEYS.join(' | ')))
      } else {
        const keys = Object.keys(goal.match)
        if (keys.length > 1) issues.push(itemIssue(`${at}/goal/match`, 'goal.match holds at most one of form_id, link_location, section_id', EXPERIMENT_MATCH_KEYS.join(' | ')))
        for (const k of keys) {
          const val = ownKeyOf(goal.match, k)
          if (!EXPERIMENT_MATCH_KEYS.includes(k)) {
            issues.push(itemIssue(`${at}/goal/match/${pointerSegment(k)}`, `unknown goal.match key "${k}"`, EXPERIMENT_MATCH_KEYS.join(' | ')))
          } else if (typeof val !== 'string' || !EXPERIMENT_MATCH_PATTERN.test(val)) {
            issues.push(itemIssue(`${at}/goal/match/${pointerSegment(k)}`, `goal.match.${k} must be 1 to 64 characters of A-Z, a-z, 0-9 and _ . : -`, EXPERIMENT_MATCH_PATTERN.source))
          }
        }
      }
    }
  }

  // target
  const target = props.target
  let targetFields = false
  let targetBlock = -1
  if (target === 'fields') {
    targetFields = true
    if (!Array.isArray(composition.fields)) {
      issues.push(itemIssue(`${at}/target`, 'target "fields" needs a collection that declares fields; target a generic block with { "block": i } instead'))
    }
  } else if (isPlainObject(target) && Object.keys(target).length === 1 && typeof target.block === 'number' && Number.isInteger(target.block) && target.block >= 0) {
    targetBlock = target.block
    const t = blocks[targetBlock]
    if (targetBlock === index) {
      issues.push(itemIssue(`${at}/target/block`, 'an experiment cannot target itself'))
    } else if (!isPlainObject(t) || typeof t.type !== 'string') {
      issues.push(itemIssue(`${at}/target/block`, `target.block ${targetBlock} does not name a block of this item`, `0..${blocks.length - 1}`))
    } else if (t.type === FIELDS_BLOCK_TYPE) {
      issues.push(itemIssue(`${at}/target/block`, `target.block ${targetBlock} is the "${FIELDS_BLOCK_TYPE}" block: target it with "fields"`))
    } else if (!isComposableBlockType(t.type)) {
      issues.push(itemIssue(`${at}/target/block`, `target.block ${targetBlock} is a "${t.type}" block: only a generic vocabulary block can be tested`, COMPOSABLE_BLOCK_TYPE_NAMES.join(' | ')))
    }
  } else {
    issues.push(itemIssue(`${at}/target`, 'target must be "fields" or { "block": <index of a generic block> }', '"fields" | { block: number }'))
  }

  // arms
  const arms = props.arms
  if (!Array.isArray(arms) || arms.length < EXPERIMENT_MIN_ARMS || arms.length > EXPERIMENT_ARM_KEYS.length) {
    issues.push(itemIssue(`${at}/arms`, `an experiment has ${EXPERIMENT_MIN_ARMS} to ${EXPERIMENT_ARM_KEYS.length} arms`, `${EXPERIMENT_MIN_ARMS}..${EXPERIMENT_ARM_KEYS.length} arms`))
    return issues
  }
  let weightSum = 0
  let weightsOk = true
  const control = fieldsBlockOf(blocks) ?? {}
  const declared = new Set(Array.isArray(composition.fields) ? composition.fields.map((f) => f.name) : [])
  arms.forEach((arm, j) => {
    const ap = `${at}/arms/${j}`
    if (!isPlainObject(arm)) {
      issues.push(itemIssue(ap, 'an arm must be an object { key, weight, override? | replace? }'))
      weightsOk = false
      return
    }
    closedKeys(arm, EXPERIMENT_ARM_PROP_KEYS, ap, issues)
    if (arm.key !== EXPERIMENT_ARM_KEYS[j]) {
      issues.push(itemIssue(`${ap}/key`, `arm ${j} must be keyed "${EXPERIMENT_ARM_KEYS[j]}" (arms are a, b, c, d in order; a is the control)`, EXPERIMENT_ARM_KEYS[j]))
    }
    if (typeof arm.weight !== 'number' || !Number.isInteger(arm.weight) || arm.weight < EXPERIMENT_MIN_WEIGHT) {
      issues.push(itemIssue(`${ap}/weight`, `an arm's weight is an integer of at least ${EXPERIMENT_MIN_WEIGHT}`, `integer >= ${EXPERIMENT_MIN_WEIGHT}`))
      weightsOk = false
    } else {
      weightSum += arm.weight
    }

    const hasOverride = arm.override !== undefined
    const hasReplace = arm.replace !== undefined
    if (j === 0) {
      if (hasOverride || hasReplace) issues.push(itemIssue(hasOverride ? `${ap}/override` : `${ap}/replace`, 'arm "a" is the control and never overrides or replaces anything'))
      return
    }
    if (targetFields) {
      if (hasReplace) issues.push(itemIssue(`${ap}/replace`, 'an experiment on "fields" overrides field values with "override"; "replace" is for a block target'))
      if (!isPlainObject(arm.override) || Object.keys(arm.override).length === 0) {
        issues.push(itemIssue(`${ap}/override`, 'a non-control arm of a "fields" experiment needs an override object with at least one field', [...declared].join(' | ')))
        return
      }
      const override = arm.override
      const bad = Object.keys(override).filter((k) => !declared.has(k))
      for (const k of bad) {
        issues.push(itemIssue(`${ap}/override/${pointerSegment(k)}`, `unknown field "${k}": an override may only set fields the collection declares`, [...declared].join(' | ')))
      }
      if (Array.isArray(composition.fields) && bad.length === 0) {
        const merged = { ...control, ...override }
        const prefixes = Object.keys(override).map((k) => `${ap}/override/${pointerSegment(k)}`)
        for (const iss of validateFieldValues(composition.fields as FieldDef[], merged, `${ap}/override`)) {
          if (prefixes.some((pre) => iss.path === pre || iss.path.startsWith(`${pre}/`))) issues.push(iss)
        }
      }
    } else if (targetBlock >= 0) {
      if (hasOverride) issues.push(itemIssue(`${ap}/override`, 'an experiment on a block replaces it with "replace"; "override" is for a "fields" target'))
      const t = blocks[targetBlock]
      if (!isPlainObject(arm.replace)) {
        issues.push(itemIssue(`${ap}/replace`, 'a non-control arm of a block experiment needs a replace block { type, props }'))
        return
      }
      closedKeys(arm.replace, ['type', 'props'], `${ap}/replace`, issues)
      const tType = isPlainObject(t) ? t.type : undefined
      if (typeof arm.replace.type !== 'string' || arm.replace.type !== tType) {
        issues.push(itemIssue(`${ap}/replace/type`, `the replacement must be a "${String(tType)}" block, the same type as the block under test`, String(tType)))
      } else if (arm.replace.props !== undefined && !isPlainObject(arm.replace.props)) {
        issues.push(itemIssue(`${ap}/replace/props`, 'block props must be an object'))
      } else {
        for (const e of validateBlock({ type: arm.replace.type, props: arm.replace.props }).errors) issues.push(itemIssue(`${ap}/replace/props`, e))
      }
    }
  })
  if (weightsOk && weightSum !== 100) {
    issues.push(itemIssue(`${at}/arms`, `the arm weights must sum to 100 (they sum to ${weightSum})`, '100'))
  }
  return issues
}

/** The item's experiment block, when there is one with object props: its index and props. */
export function experimentOf(blocks: unknown): { index: number; props: Record<string, unknown> } | null {
  if (!Array.isArray(blocks)) return null
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (isPlainObject(b) && b.type === EXPERIMENT_BLOCK_TYPE) return { index: i, props: isPlainObject(b.props) ? b.props : {} }
  }
  return null
}

/** One reason a version is refused by the experiment lock: the pointer (into the NEW version) and why. */
export interface ExperimentLockViolation {
  pointer: string
  reason: string
}

/**
 * THE PUBLISH LOCK (design section 5.1), the pure half. `live` is the blocks of the version that is live now,
 * `next` the blocks of the version about to go live. When the live version carries an experiment E and the new
 * one still carries an experiment, the new version may not (1) change E at all (key, target, enrolment, goal,
 * arms, weights, overrides) nor (2) change the CONTROL values E overrides: for a "fields" target the values of
 * every field any arm overrides, for a block target the whole block under test. Everything else may change.
 * Dropping the experiment block (the stop, with or without the winner's values merged in) is always allowed,
 * and a live version without an experiment locks nothing. Empty result = allowed.
 */
export function experimentLockViolations(live: unknown, next: unknown): ExperimentLockViolation[] {
  const e = experimentOf(live)
  if (!e) return []
  const n = experimentOf(next)
  if (!n) return []
  const out: ExperimentLockViolation[] = []
  const name = typeof e.props.key === 'string' ? ` "${e.props.key}"` : ''
  if (!jsonEqual(e.props, n.props)) {
    out.push({ pointer: `/blocks/${n.index}/props`, reason: `the running experiment${name} was changed` })
  }
  const liveBlocks = live as unknown[]
  const nextBlocks = next as unknown[]
  if (e.props.target === 'fields') {
    const keys = new Set<string>()
    if (Array.isArray(e.props.arms)) {
      for (const arm of e.props.arms) {
        if (isPlainObject(arm) && isPlainObject(arm.override)) for (const k of Object.keys(arm.override)) keys.add(k)
      }
    }
    const liveFields = fieldsBlockOf(liveBlocks) ?? {}
    const nextFields = fieldsBlockOf(nextBlocks) ?? {}
    for (const k of [...keys].sort()) {
      if (!jsonEqual(ownKeyOf(liveFields, k), ownKeyOf(nextFields, k))) {
        out.push({ pointer: `/blocks/0/props/${pointerSegment(k)}`, reason: `"${k}" is the control value of the running experiment${name}` })
      }
    }
  } else if (isPlainObject(e.props.target) && typeof e.props.target.block === 'number') {
    const t = e.props.target.block
    if (!jsonEqual(liveBlocks[t], nextBlocks[t])) {
      out.push({ pointer: `/blocks/${t}`, reason: `block ${t} is the control of the running experiment${name}` })
    }
  }
  return out
}
