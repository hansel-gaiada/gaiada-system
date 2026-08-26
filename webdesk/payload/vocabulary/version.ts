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
import { PRIMITIVE_NAMES } from './primitives.ts'
import { BLOCK_TYPE_NAMES } from './blocks.ts'

export const VOCABULARY_VERSION = '1.0.0'

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
