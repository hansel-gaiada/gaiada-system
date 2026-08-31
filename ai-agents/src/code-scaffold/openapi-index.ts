// WSK-20 — turns the pinned snapshot's `openapi.v1.json` (already-generated, pure JSON) into an
// index of what collections a page may reference. PURE DATA READ: `JSON.parse` only, never a require/
// import/eval of anything — that is what makes reading this artifact safe under WSK-D6 (the SDK
// tarball's ACTUAL code is never touched; the openapi document is the machine-readable description of
// what the code has, and describing is not executing).
//
// Path shape, restated from webdesk/api/src/codegen/generator/openapi-builder.mts (read-only
// reference — this ticket does not depend on that file):
//   GET /v1/t/{tenantSlug}/{collectionKey}            operationId `list_{key}`
//   GET /v1/t/{tenantSlug}/{collectionKey}/{slug}      operationId `get_{key}`
//   GET /v1/t/{tenantSlug}/search                      operationId `search`
//   GET /v1/t/{tenantSlug}/sitemap.xml                  operationId `sitemap`
export interface CollectionIndex {
  tenantSlug: string;
  /** collectionKey -> whether both list_{key} and get_{key} operations exist (openapi-builder.mts
   *  always emits both together per collection, but the index is built defensively rather than
   *  assuming that pairing holds forever). */
  collections: Map<string, { hasList: boolean; hasItem: boolean }>;
  hasSearch: boolean;
  hasSitemap: boolean;
}

const LIST_PATH_RE = /^\/v1\/t\/([^/]+)\/([^/]+)$/;
const ITEM_PATH_RE = /^\/v1\/t\/([^/]+)\/([^/]+)\/\{slug\}$/;

export function parseOpenApiCollections(doc: Record<string, unknown>): CollectionIndex {
  const paths = (doc.paths as Record<string, unknown>) ?? {};
  const collections = new Map<string, { hasList: boolean; hasItem: boolean }>();
  let tenantSlug = "";
  let hasSearch = false;
  let hasSitemap = false;

  for (const p of Object.keys(paths)) {
    if (p.endsWith("/search")) {
      hasSearch = true;
      continue;
    }
    if (p.endsWith("/sitemap.xml")) {
      hasSitemap = true;
      continue;
    }
    const itemMatch = ITEM_PATH_RE.exec(p);
    if (itemMatch) {
      tenantSlug = itemMatch[1];
      const key = itemMatch[2];
      const entry = collections.get(key) ?? { hasList: false, hasItem: false };
      entry.hasItem = true;
      collections.set(key, entry);
      continue;
    }
    const listMatch = LIST_PATH_RE.exec(p);
    if (listMatch) {
      tenantSlug = listMatch[1];
      const key = listMatch[2];
      const entry = collections.get(key) ?? { hasList: false, hasItem: false };
      entry.hasList = true;
      collections.set(key, entry);
    }
  }

  return { tenantSlug, collections, hasSearch, hasSitemap };
}

export function collectionExists(index: CollectionIndex, key: string): boolean {
  return index.collections.has(key);
}
