// VENDORED — generated from webdesk/delivery/vocabulary/version.ts (WSK-06/WSK-14, frozen per
// webdesk-design.md §05) by webdesk/api/src/delivery/vocabulary/vendor.mjs. DO NOT HAND-EDIT.
// The only transform: LF line endings and relative '.ts' import extensions stripped (this
// package is CommonJS). Re-vendor with `node src/delivery/vocabulary/vendor.mjs`; drift is
// caught by test/delivery/vocabulary-vendor-drift.spec.ts.

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
import { PRIMITIVE_NAMES } from './primitives'
import { BLOCK_TYPE_NAMES } from './blocks'

export const VOCABULARY_VERSION = '1.4.0'

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
