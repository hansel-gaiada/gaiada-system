// DW-D31 (owner, 2026-10-15; docs/FRONTEND-BFF-CONTRACT.md §46.10): a lookup that searches ONE corpus keeps only that corpus.
//
// The knowledge store's pre-filter is `tenant_id = ANY(callerTenantSet) AND (acl = '{}' OR scope = ANY(acl))`. Every internal ERP
// chunk is ingested with an EMPTY acl ("any member of the company"), so it matches ANY scope: a query scoped to one property's
// grounding, or to one client's brand corpus, also gets back semantically close ERP chunks (a meeting transcript, a contract
// file), from every company the caller belongs to. Those must never reach an AI draft. The SEO property brief and social's brand
// drafts each ingest their corpus under ONE sourceRef, so the rule is an exact match on it. Public-tier and ERP hits are dropped.

/** How many chunks to ask the store for, so the hits of the one corpus are not crowded out by the ones that are dropped. */
export function ownCorpusTopK(topK: number): number {
  return Math.min(Math.max(1, Math.trunc(topK)) * 4, 80);
}

/** The hits whose sourceRef IS the corpus's own ref, best first as the store ranked them, at most `topK`. */
export function keepOwnCorpus<T extends { sourceRef: string }>(hits: readonly T[], ownRef: string, topK: number): T[] {
  return hits.filter((h) => h.sourceRef === ownRef).slice(0, Math.max(0, topK));
}
