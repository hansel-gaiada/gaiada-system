#!/usr/bin/env node
// webdesk/payload/test/wsk64-snapshot-probe.mjs
//
// WSK-64 — derives a vocabulary snapshot from a vocabulary directory's OWN runtime behaviour, so
// the same procedure can be run against the pre-WSK-64 tree (1.0.0, which has no notion of the
// three extra dimensions) and against the current tree, and the two results compared like for
// like.
//
// The 1.0.0 classifier snapshotted only {primitives, blocks, envelopeShape}. It was blind to three
// things a vocabulary change can alter (write-plane design §2.3): which primitives honour
// `multiple`, which keys a FieldDef may carry, and which keys a collection composition may carry.
// None of those were exported as data in 1.0.0, so this probe reads them off the validators:
//
//   multipleCapable — a primitive "honours multiple" when validateField() accepts an array of one
//                     valid sample value AND rejects the bare sample value, with `multiple: true`.
//   fieldDefKeys    — the composition validator's own unknown-key issue lists every key it accepts
//                     (its `expected`); each listed key is then re-probed to confirm it really is
//                     accepted, so a stale `expected` string cannot lie.
//   compositionKeys — the same procedure, one level up.
//
// WSK-49 (vocabulary 1.2.0) adds two more dimensions, because 1.1.0's classifier was blind to the
// KEYS OF the two `ui` objects (a new ui key is a new optional key: MINOR, a removed one MAJOR):
//
//   fieldUiKeys       — the keys a FieldDef's `ui` object accepts (same unknown-key procedure).
//   collectionUiKeys  — the keys a composition's `ui` object accepts.
//
// M5-W3c (vocabulary 1.3.0) adds one more:
//
//   lintKeys          — the keys a composition's `lint` object accepts (1.1.0 onward; same procedure).
//
// Both of the WSK-49 dimensions are readable from a 1.1.0 tree too (its validators already close both objects and list the
// accepted keys), so the committed 1.1.0 fixture was captured with THIS probe against the untouched
// 1.1.0 vocabulary (commit 85299efb, before any 1.2.0 edit).
//
// Usage:
//   node --import tsx test/wsk64-snapshot-probe.mjs [vocabularyDir]   — prints the snapshot JSON
// The committed fixture test/fixtures/vocabulary-1.0.0.snapshot.json was produced by running this
// against the untouched pre-WSK-64 tree (commit 8023c992), before any vocabulary file was edited.
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
export const DEFAULT_VOCABULARY_DIR = path.resolve(HERE, '..', 'vocabulary')

// One valid sample value (and the FieldDef extras it needs) per primitive. A primitive with no
// entry here makes the probe throw: a new primitive must be given a sample before it can be rated.
const SAMPLES = {
  text: { value: 'a' },
  richtext: { value: 'a' },
  media: { value: { url: 'https://cdn.example.com/a.jpg' } },
  relation: { value: { collection: 'c', slug: 's' }, extra: { relationTo: 'c' } },
  number: { value: 1 },
  date: { value: '2026-01-01T00:00:00.000Z' },
  select: { value: 'a', extra: { options: ['a'] } },
  geo: { value: { lat: 0, lng: 0 } },
  group: { value: { s: 'a' }, extra: { fields: [{ name: 's', primitive: 'text' }] } },
  boolean: { value: true },
  markdown: { value: '# a' },
}

const UNKNOWN_PROBE_KEY = 'zz_wsk64_probe_unknown'

async function load(dir, file) {
  return import(url.pathToFileURL(path.join(dir, file)).href)
}

export function probeMultipleCapable(primitivesModule) {
  const out = []
  for (const p of primitivesModule.PRIMITIVE_NAMES) {
    const sample = SAMPLES[p]
    if (!sample) throw new Error(`wsk64-snapshot-probe: no sample value for primitive "${p}" — add one to SAMPLES`)
    const field = { name: 'probe', primitive: p, multiple: true, ...(sample.extra ?? {}) }
    const acceptsArray = primitivesModule.validateField(field, [sample.value]).length === 0
    const rejectsScalar = primitivesModule.validateField(field, sample.value).length > 0
    if (acceptsArray && rejectsScalar) out.push(p)
  }
  return out.sort()
}

function keysFromUnknownKeyIssue(issues, unknownPath) {
  const hit = issues.find((i) => i.path === unknownPath)
  if (!hit || typeof hit.expected !== 'string') {
    throw new Error(`wsk64-snapshot-probe: the validator did not report the unknown probe key at ${unknownPath} — got ${JSON.stringify(issues)}`)
  }
  return hit.expected.split(' | ').map((s) => s.trim()).filter(Boolean)
}

export function probeFieldDefKeys(compositionModule) {
  const r = compositionModule.validateCollectionComposition('probe', {
    fields: [{ name: 'p', primitive: 'text', [UNKNOWN_PROBE_KEY]: true }],
  })
  const listed = keysFromUnknownKeyIssue(r.issues, `probe.fields[0].${UNKNOWN_PROBE_KEY}`)
  // Re-probe: each listed key must NOT be reported unknown when present (value left undefined so
  // only key recognition is exercised, never the key's own value rules).
  for (const k of listed) {
    if (k === 'name' || k === 'primitive') continue
    const rr = compositionModule.validateCollectionComposition('probe', { fields: [{ name: 'p', primitive: 'text', [k]: undefined }] })
    if (rr.issues.some((i) => i.path === `probe.fields[0].${k}` && /unknown field key/.test(i.message))) {
      throw new Error(`wsk64-snapshot-probe: FieldDef key "${k}" is listed as accepted but rejected as unknown`)
    }
  }
  return [...listed].sort()
}

export function probeCompositionKeys(compositionModule) {
  const r = compositionModule.validateCollectionComposition('probe', { [UNKNOWN_PROBE_KEY]: true })
  const listed = keysFromUnknownKeyIssue(r.issues, `probe.${UNKNOWN_PROBE_KEY}`)
  for (const k of listed) {
    const rr = compositionModule.validateCollectionComposition('probe', { [k]: undefined })
    if (rr.issues.some((i) => i.path === `probe.${k}` && /unknown composition key/.test(i.message))) {
      throw new Error(`wsk64-snapshot-probe: composition key "${k}" is listed as accepted but rejected as unknown`)
    }
  }
  return [...listed].sort()
}

export function probeFieldUiKeys(compositionModule) {
  const r = compositionModule.validateCollectionComposition('probe', {
    fields: [{ name: 'p', primitive: 'text', ui: { [UNKNOWN_PROBE_KEY]: true } }],
  })
  const listed = keysFromUnknownKeyIssue(r.issues, `probe.fields[0].ui.${UNKNOWN_PROBE_KEY}`)
  for (const k of listed) {
    const rr = compositionModule.validateCollectionComposition('probe', { fields: [{ name: 'p', primitive: 'text', ui: { [k]: undefined } }] })
    if (rr.issues.some((i) => i.path === `probe.fields[0].ui.${k}` && /unknown field ui key/.test(i.message))) {
      throw new Error(`wsk64-snapshot-probe: field ui key "${k}" is listed as accepted but rejected as unknown`)
    }
  }
  return [...listed].sort()
}

export function probeCollectionUiKeys(compositionModule) {
  const r = compositionModule.validateCollectionComposition('probe', { ui: { label: 'probe', [UNKNOWN_PROBE_KEY]: true } })
  const listed = keysFromUnknownKeyIssue(r.issues, `probe.ui.${UNKNOWN_PROBE_KEY}`)
  for (const k of listed) {
    const rr = compositionModule.validateCollectionComposition('probe', { ui: { label: 'probe', [k]: undefined } })
    if (rr.issues.some((i) => i.path === `probe.ui.${k}` && /unknown collection ui key/.test(i.message))) {
      throw new Error(`wsk64-snapshot-probe: collection ui key "${k}" is listed as accepted but rejected as unknown`)
    }
  }
  return [...listed].sort()
}

export function probeLintKeys(compositionModule) {
  const r = compositionModule.validateCollectionComposition('probe', { lint: { [UNKNOWN_PROBE_KEY]: true } })
  const listed = keysFromUnknownKeyIssue(r.issues, `probe.lint.${UNKNOWN_PROBE_KEY}`)
  for (const k of listed) {
    const rr = compositionModule.validateCollectionComposition('probe', { lint: { [k]: undefined } })
    if (rr.issues.some((i) => i.path === `probe.lint.${k}` && /unknown lint key/.test(i.message))) {
      throw new Error(`wsk64-snapshot-probe: lint key "${k}" is listed as accepted but rejected as unknown`)
    }
  }
  return [...listed].sort()
}

/** The snapshot of the vocabulary at `dir`, computed from that directory's own code only. */
export async function probeVocabularySnapshot(dir = DEFAULT_VOCABULARY_DIR) {
  const breaking = await load(dir, 'breaking-change.ts')
  const primitives = await load(dir, 'primitives.ts')
  const composition = await load(dir, 'composition.ts')
  const version = await load(dir, 'version.ts')
  const base = breaking.currentVocabularySnapshot()
  return {
    vocabularyVersion: version.VOCABULARY_VERSION,
    primitives: [...base.primitives],
    blocks: JSON.parse(JSON.stringify(base.blocks)),
    envelopeShape: [...base.envelopeShape],
    multipleCapable: probeMultipleCapable(primitives),
    fieldDefKeys: probeFieldDefKeys(composition),
    compositionKeys: probeCompositionKeys(composition),
    fieldUiKeys: probeFieldUiKeys(composition),
    collectionUiKeys: probeCollectionUiKeys(composition),
    lintKeys: probeLintKeys(composition),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_VOCABULARY_DIR
  const snap = await probeVocabularySnapshot(dir)
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n')
}
