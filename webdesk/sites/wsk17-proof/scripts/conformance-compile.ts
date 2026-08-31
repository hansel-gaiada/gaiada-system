// webdesk/sites/wsk17-proof/scripts/conformance-compile.ts
//
// WSK-17 -- the COMPILE-TIME half of the generated conformance test (design §06: "compile-time:
// SDK types satisfy every block/collection the site references"). Not executed -- type-checked
// only, via `npm run conformance:compile` (tsc --noEmit against tsconfig.conformance.json). A
// failure here means the generated SDK (src/sdk/sdk.d.ts) and the block-renderer library
// (@gaiada/webdesk-blocks) have drifted apart from what this site's pages actually consume; it is
// the mechanical version of "reading every page and checking the types by eye".
import type { paths } from '../src/sdk/sdk.d.ts'
// Imported from the package's leaf .ts files (via its "./*": "./src/*" export map entry), NOT
// from '@gaiada/webdesk-blocks''s own barrel (src/index.ts) -- the barrel also re-exports the 9
// .astro components, which plain `tsc` (no Astro language plugin) cannot resolve module types
// for. These two files (types.ts, vocabulary/envelope.ts) are pure TypeScript with no .astro
// import anywhere in their own graph, so the SAME type identities the barrel re-exports type-check
// here without needing the Astro compiler in the loop -- the compile-time proof this file exists
// for is about the TYPES agreeing, not about compiling the components themselves (astro check,
// run separately over src/**, already proves the components compile -- see README.md).
import type { HeroProps, RichTextProps, GalleryProps, CtaProps, FeatureGridProps, FormProps, TestimonialProps, FaqProps, LogoCloudProps } from '@gaiada/webdesk-blocks/types.ts'
import type { ItemEnvelope, ListEnvelope } from '@gaiada/webdesk-blocks/vocabulary/envelope.ts'

// --- 1) Every /v1 path this site's pages reference exists in the generated SDK, with the exact
// literal shape src/pages/**/*.astro uses (template-literal-typed against site-tenant.ts's
// `as const` exports -- see that file's own header). A typo in either place breaks this block.
type ListPath = paths['/v1/t/wsk17-proof/case-study']['get']
type ItemPath = paths['/v1/t/wsk17-proof/case-study/{slug}']['get']

type ListResponse = ListPath['responses']['200']['content']['application/json']
type ItemResponse = ItemPath['responses']['200']['content']['application/json']

// The generated response schemas are structurally the SAME frozen envelope shape the block
// library's own vocabulary types declare (design §05 hard rule 1) -- assignability both ways
// proves the codegen output and the block library have not drifted from each other.
const _listAssignableToListEnvelope: ListEnvelope = {} as ListResponse
const _itemAssignableToItemEnvelope: ItemEnvelope = {} as ItemResponse
void _listAssignableToListEnvelope
void _itemAssignableToItemEnvelope

// --- 2) Every block type this site's fixtures use (scripts/seed-tenant.mjs's `ALL_BLOCK_TYPES`,
// the full 9) has a Props interface in @gaiada/webdesk-blocks whose required fields are satisfied
// by the exact literal props this site seeds -- if the vocabulary ever adds a required field, this
// block fails to compile until the seed script and this file both catch up.
const _hero: HeroProps = { heading: 'x', subheading: 'x', media: { url: 'x' }, ctaLabel: 'x', ctaHref: 'x' }
const _richText: RichTextProps = { content: 'x' }
const _gallery: GalleryProps = { items: [{ url: 'x' }], caption: 'x' }
const _cta: CtaProps = { heading: 'x', body: 'x', buttonLabel: 'x', buttonHref: 'x' }
const _featureGrid: FeatureGridProps = { heading: 'x', items: [{ collection: 'feature', slug: 'x' }] }
const _form: FormProps = { formKey: { collection: 'form_defs', slug: 'x' } }
const _testimonial: TestimonialProps = { quote: 'x', author: 'x', role: 'x', avatar: { url: 'x' } }
const _faq: FaqProps = { heading: 'x', items: [{ collection: 'faqItem', slug: 'x' }] }
const _logoCloud: LogoCloudProps = { heading: 'x', logos: [{ url: 'x' }] }
void _hero; void _richText; void _gallery; void _cta; void _featureGrid; void _form; void _testimonial; void _faq; void _logoCloud
