// webdesk/payload/vocabulary/index.ts
//
// WSK-14 — the vocabulary's explicit public surface (webdesk-design.md §05 Layer 1: primitives,
// block `props` schemas, and envelope types "defined once, in the vocabulary package, consumed by
// Payload config, codegen, and the block-renderer library"). Every file in this directory was
// already independently importable (WSK-06 shipped them that way, and every existing import site —
// payload.config.ts, collections/*.ts, test/*.test.mjs — keeps importing by direct path; this
// barrel is ADDITIVE, not a replacement for those paths, and changes nothing about them).
//
// What this file promotes: a single, reviewable list of what three downstream consumers are meant
// to build against —
//   - payload.config.ts / the Payload runtime           (VOCABULARY_SUMMARY, primitives, blocks)
//   - WSK-15's codegen (openapi.v1.json hand-authoring)  (everything — the whole surface below)
//   - WSK-16's block-renderer library                    (BLOCK_TYPE_NAMES, BlockDef, validateBlock,
//                                                          the unknown-type renderer invariant)
//   - WSK-19's Zone A mirror / WSK-32's AI drafting flow  (composition.ts, breaking-change.ts)
//
// A change to what this file exports is itself governed by the vocabulary's own versioning rule
// (./version.ts, ./breaking-change.ts): removing or renaming an export here is the same class of
// event as removing/renaming the primitive or block type it represents.

// --- Layer 1: primitives -------------------------------------------------------------------
export {
  PRIMITIVES,
  PRIMITIVE_NAMES,
  isPrimitiveName,
  validateField,
  type PrimitiveName,
  type PrimitiveDef,
  type FieldDef,
} from './primitives.ts'

// --- Layer 1: block types -----------------------------------------------------------------
export {
  BLOCKS,
  BLOCK_TYPE_NAMES,
  isBlockType,
  validateBlock,
  type BlockType,
  type BlockDef,
  type BlockValidation,
} from './blocks.ts'

// --- Layer 1: the frozen /v1 envelope -------------------------------------------------------
export {
  buildItemEnvelope,
  buildListEnvelope,
  type ItemEnvelope,
  type ListEnvelope,
  type LocalizationLink,
  type SeoShape,
  type MetaShape,
  type PageInfo,
} from './envelope.ts'

export { problemDetails, problemResponse, type ProblemDetails } from './problem-details.ts'

// --- Locale rules -----------------------------------------------------------------------------
export { resolveRequestedLocale, localeFallbackFlag, type LocaleFallback } from './locale.ts'

// --- Cache-tag scheme -------------------------------------------------------------------------
export { buildCacheTags, cacheTagHeaderValue, applyCacheTagHeader } from './cache-tags.ts'

// --- Versioning identity ------------------------------------------------------------------
export { VOCABULARY_VERSION, ENVELOPE_VERSION, ENVELOPE_PATH_PREFIX, VOCABULARY_SUMMARY } from './version.ts'

// --- WSK-14: Layer 2 composition validator -----------------------------------------------
export {
  validateCollectionComposition,
  validateTenantComposition,
  formatCompositionIssue,
  formatCompositionIssues,
  type CollectionComposition,
  type TenantComposition,
  type CompositionIssue,
  type CompositionValidationResult,
  type ValidateTenantCompositionOptions,
} from './composition.ts'

// --- WSK-14: the breaking-change ruleset, encoded and testable ---------------------------
export {
  classifyVocabularyChange,
  classifyTenantContractChange,
  classifyRendererChange,
  currentEnvelopeShapeSignature,
  currentVocabularySnapshot,
  bumpVersion,
  compareBump,
  maxBump,
  type Bump,
  type ChangeClassification,
  type VocabularySnapshot,
  type TenantContractSnapshot,
  type CollectionFieldSet,
  type VocabularyChangeContext,
  type RendererDiff,
} from './breaking-change.ts'
