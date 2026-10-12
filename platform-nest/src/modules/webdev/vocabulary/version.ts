// VENDORED from webdesk/delivery/vocabulary/version.ts by platform-nest/scripts/vendor-webdesk-vocabulary.mjs (WSK-49c).
// DO NOT HAND-EDIT. Regenerate with `npm run vendor:webdesk-vocabulary`; `npm run vendor:check` (and the test
// suite) fails when this file and its source disagree. The only change from the source is that a relative
// import's `.ts` suffix is dropped (this package compiles to CommonJS with tsc).

// webdesk/payload/vocabulary/version.ts
//
// WSK-06 — vocabulary v1 semver (webdesk-design.md §05 "Versioning & what makes a change
// breaking"). ONE version, platform-wide — not the per-tenant "tenant contract" semver (that
// ledger belongs to WSK-14/WSK-19's `webdev_contract_snapshots.contract_version`).
//
// Bump rules (verbatim from §05's table, restated here so this file is the single place a
// reviewer checks when deciding "is this change MAJOR/MINOR/PATCH"):
//   MAJOR — remove/rename a primitive or block type; change a block's props non-additively;
//           ANY envelope shape change (hard rule 1: envelope evolution is /v2, never a mutation).
//   MINOR — new block type; new optional prop on an existing block; new primitive.
//   PATCH — docs/descriptions only.
//
// The bump is COMPUTED, never asserted: ./breaking-change.ts's classifyVocabularyChange, run
// against the previous version's committed snapshot (test/fixtures/vocabulary-<v>.snapshot.json).
//
// History:
//   1.0.0 — WSK-06: 8 primitives, 9 block types, the frozen /v1 envelope.
//   1.1.0 — WSK-64 (ruling WSK-D44), MINOR: primitives group/boolean/markdown; `multiple` on every
//           primitive; FieldDef fields/itemKey/localized/ui; composition singleton/localized/ui/lint;
//           the composition-typed `fields` block. The envelope did not change by a byte.
//   1.2.0 — WSK-49a (ruling WSK-D59), MINOR: `ui.clientEditable` on the composition and on FieldDef. Editor
//           metadata only: no stored value changes, the envelope did not change by a byte. The classifier
//           COMPUTES the bump from test/fixtures/vocabulary-1.1.0.snapshot.json (the two `ui` key sets
//           are snapshot dimensions since 1.2.0).
//   1.3.0 — M5-W3c, MINOR: `lint.content` on the composition (per-collection settings of the advisory editorial content
//           checks: `enabled`, per-rule `enabled` + thresholds). Advisory only, no stored item value changes, the
//           envelope did not change by a byte. The classifier COMPUTES the bump from
//           test/fixtures/vocabulary-1.2.0.snapshot.json (the `lint` key set is a snapshot dimension since 1.3.0).
//   1.4.0 — M5-W8b, MINOR: `ui.routePattern` on the composition (the public page path pattern of a collection's items,
//           tokens {slug} and {locale}; the writers dashboard maps an item to its page with it). Editor/ops metadata
//           only: no stored value changes, the envelope did not change by a byte. The classifier COMPUTES the bump
//           from test/fixtures/vocabulary-1.3.0.snapshot.json (the collection `ui` key set is a snapshot dimension).
//   1.5.0 — M5-V5-a, MINOR: the `experiment` block type (an A/B test over one block or the item's fields: arms with
//           their overrides, a goal, weights; design docs/plans/2026-10-12-m5-phase5-design.md section 5.1). Like `fields`
//           it is non-composable and non-visual (an older renderer shows arm `a`, the control, and reports nothing),
//           never client-editable, and a publish that changes a RUNNING experiment or its control is refused by the write
//           plane. The envelope did not change by a byte and /v1 serves the block as any other. The classifier COMPUTES
//           the bump from test/fixtures/vocabulary-1.4.0.snapshot.json (`block type "experiment" added`).
import { PRIMITIVE_NAMES } from './primitives'
import { BLOCK_TYPE_NAMES } from './blocks'

export const VOCABULARY_VERSION = '1.5.0'

/** The frozen path segment (design §05 hard rule 1). Never mutated — evolution is a new /v2. */
export const ENVELOPE_VERSION = 'v1'
export const ENVELOPE_PATH_PREFIX = `/${ENVELOPE_VERSION}`

export { PRIMITIVE_NAMES, BLOCK_TYPE_NAMES }

/** What payload.config.ts exposes via `config.custom.vocabulary` (this ticket's scope item 1). */
export const VOCABULARY_SUMMARY = {
  version: VOCABULARY_VERSION,
  envelopePath: ENVELOPE_PATH_PREFIX,
  primitiveCount: PRIMITIVE_NAMES.length,
  blockTypeCount: BLOCK_TYPE_NAMES.length,
  primitives: PRIMITIVE_NAMES,
  blockTypes: BLOCK_TYPE_NAMES,
} as const
