// webdesk/qa/p3-gate/fixtures/tenant-fixtures.mjs
//
// WSK-18 — static, DB-free `TenantComposition` fixtures for the P3 gate's determinism and
// coherence checks. Deliberately does NOT touch Postgres (unlike WSK-15's own
// `generate-single.mts`, which fetches a live tenant's composition): the determinism
// cross-machine condition needs to run inside two SEPARATE, throwaway Docker containers that do
// not share a database, so the input to `buildContractArtifacts` must be self-contained data, not
// a DB row. Two differently-composed tenants, mirroring WSK-15/WSK-06's own "two differently-
// composed tenants" pattern (never one fixture alone — a single-tenant fixture cannot catch a bug
// that only shows up when a second collection or a closed block-list is present).
//
// Shapes match `webdesk/payload/vocabulary/composition.ts`'s `TenantComposition`
// (`Record<collectionKey, { fields?: FieldDef[], blocks?: BlockType[] }>`) exactly — these are
// fed straight into `buildContractArtifacts`, which itself calls `validateTenantComposition` and
// throws on anything invalid, so an invalid fixture here fails loudly at generation time, not
// silently.

export const TENANT_FIXTURES = {
  acme: {
    tenantSlug: 'qa-p3-acme',
    defaultLocale: 'en',
    locales: ['en', 'es'],
    composition: {
      article: {
        blocks: ['hero', 'richText', 'cta'],
      },
      caseStudy: {
        fields: [
          { name: 'client', primitive: 'text', required: true },
          { name: 'industry', primitive: 'select', options: ['retail', 'finance', 'health'] },
        ],
        blocks: ['hero', 'testimonial', 'gallery'],
      },
      redirect: {
        fields: [{ name: 'target', primitive: 'text', required: true }],
        blocks: [],
      },
    },
  },
  globex: {
    tenantSlug: 'qa-p3-globex',
    defaultLocale: 'en',
    locales: ['en'],
    composition: {
      // No `blocks` key at all — deliberately exercises composition.ts's documented "absence =
      // unrestricted" interpretation, the opposite of acme's closed lists.
      page: {},
      faqEntry: {
        blocks: ['faq'],
      },
    },
  },
}

export function fixtureFor(name) {
  const f = TENANT_FIXTURES[name]
  if (!f) {
    throw new Error(`[qa-p3-gate] unknown fixture tenant "${name}" — known: ${Object.keys(TENANT_FIXTURES).join(', ')}`)
  }
  return f
}
