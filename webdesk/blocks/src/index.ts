// webdesk/blocks/src/index.ts
//
// WSK-16 — the block-renderer library's public surface. A scaffolded site (WSK-17/WSK-20) imports
// from here (or, for a single component, directly from `@gaiada/webdesk-blocks/components/Hero.astro`
// — see package.json's `"./*"` export map entry).

// --- The 9 vocabulary block components (webdesk-design.md §05 Layer 1), 1:1 -------------------
export { default as Hero } from './components/Hero.astro'
export { default as RichText } from './components/RichText.astro'
export { default as Gallery } from './components/Gallery.astro'
export { default as Cta } from './components/Cta.astro'
export { default as FeatureGrid } from './components/FeatureGrid.astro'
export { default as Form } from './components/FormBlock.astro'
export { default as Testimonial } from './components/Testimonial.astro'
export { default as Faq } from './components/Faq.astro'
export { default as LogoCloud } from './components/LogoCloud.astro'

// --- Envelope-level UI the design calls for by name (§05/§06/WSK-D18) --------------------------
export { default as DraftBanner } from './components/DraftBanner.astro'
export { default as LocaleFallbackNotice, type LocaleFallbackShape } from './components/LocaleFallbackNotice.astro'

// --- The renderer: THE RENDERER INVARIANT lives here (§05 hard rule 2) -------------------------
export { default as BlockRenderer } from './renderer/BlockRenderer.astro'
export { default as ItemRenderer } from './renderer/ItemRenderer.astro'
export { resolveBlocks, partitionResolvedBlocks, type RawBlock, type ResolvedBlock, type ResolvedKnownBlock, type ResolvedUnknownBlock } from './renderer/resolve-blocks.ts'
export { defaultUnknownBlockReport, type UnknownBlockReport, type UnknownBlockReportHook } from './renderer/report.ts'

// --- Props types, typed from the vocabulary (see src/types.ts's own header for how) ------------
export type {
  TextValue,
  RichTextValue,
  MediaValue,
  RelationValue,
  NumberValue,
  DateValue,
  SelectValue,
  GeoValue,
  HeroProps,
  RichTextProps,
  GalleryProps,
  CtaProps,
  FeatureGridProps,
  FormProps,
  TestimonialProps,
  FaqProps,
  LogoCloudProps,
  BlockPropsByType,
} from './types.ts'

// --- Re-exported straight from the vendored vocabulary (see src/vocabulary/*.ts) ---------------
// Deliberately re-exported rather than requiring a second import path: a host that wants to
// validate a block BEFORE handing it to the renderer (e.g. a CMS-side preview) should not have to
// know this package vendors its own copy of the vocabulary internally.
export { BLOCK_TYPE_NAMES, isBlockType, validateBlock, type BlockType, type BlockDef, type BlockValidation } from './vocabulary/blocks.ts'
export { PRIMITIVE_NAMES, isPrimitiveName, validateField, type PrimitiveName, type PrimitiveDef, type FieldDef } from './vocabulary/primitives.ts'
export type { ItemEnvelope, ListEnvelope, LocalizationLink, SeoShape, MetaShape, PageInfo } from './vocabulary/envelope.ts'
export { VOCABULARY_VERSION, ENVELOPE_VERSION, ENVELOPE_PATH_PREFIX } from './vocabulary/version.ts'
