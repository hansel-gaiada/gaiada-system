// webdesk/blocks/test/fixtures/unknown-block-envelope.mjs
//
// WSK-16 — "unknown-type fixture renders nothing and reports; the page still renders its other
// blocks". The realistic scenario the renderer invariant exists for (webdesk-design.md §05 hard
// rule 2): a vocabulary MINOR ships a 10th block type server-side before this renderer is
// upgraded to know it. `pricingTable` here stands in for that future type — it is deliberately
// NOT one of the 9 in ../../src/vocabulary/blocks.ts. Sandwiched between two known blocks so a
// test can assert both neighbors still render.
//
// Also carries `meta.draft: true` and a `meta.x.localeFallback` — WSK-16 scope item 4's other two
// behaviors (honour draft, surface locale fallback visibly) — so one fixture exercises all three
// renderer behaviors this ticket is responsible for.
import { buildItemEnvelope } from '../../src/vocabulary/envelope.ts'

export const unknownBlockEnvelopeFixture = buildItemEnvelope({
  collectionKey: 'article',
  slug: 'pricing-2027',
  locale: 'en-US',
  localizations: [],
  seo: { title: 'Pricing (draft, EN fallback)' },
  publishedAt: null,
  updatedAt: '2026-08-25T00:00:00.000Z',
  draft: true,
  x: {
    localeFallback: { requested: 'id-ID', served: 'en-US', defaultLocale: 'en-US' },
  },
  blocks: [
    { type: 'hero', props: { heading: 'New pricing, explained' } },
    // From a vocabulary MINOR this renderer's pinned version predates — must render nothing and report.
    { type: 'pricingTable', props: { tiers: [{ name: 'Pro', price: 49 }] } },
    { type: 'richText', props: { content: 'The tier structure below replaces the old one.' } },
  ],
})
