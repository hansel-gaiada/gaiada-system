// Shared types for knowledge ingestion. Kept separate from the client so the source builders
// (web + ERP) can be pure functions returning IngestDocument[] and be unit-tested without any
// network or DB — the network/DB edges live in ingest-client.ts and erp-source.ts respectively.

/** D9.4 tier. `public` escapes the tenant pre-filter and is world-readable; `internal` keeps the
 *  full D9.1 contract. Always explicit here — this codebase never lets the tier be inferred. */
export type Audience = "public" | "internal";

export interface IngestDocument {
  tenantId: string;
  /** Stable, collision-free identity for the source. Re-ingesting the same ref REPLACES its chunks,
   *  so this must be derived from the record's permanent identity (its uuid / canonical URL) and
   *  never from mutable content. Convention: `web:<url>` and `erp:<entity>:<uuid>`. */
  sourceRef: string;
  audience: Audience;
  /** Read scopes within the tenant. Empty = every member of the tenant, which is what "open for
   *  employees only" means. Ignored entirely for the public tier. */
  acl?: string[];
  kind?: "doc" | "memory";
  provenance?: "human" | "agent" | "external";
  chunks: string[];
  /** Human-readable label for run reporting/logs only — never persisted as a chunk. */
  label: string;
}

/** Per-run outcome. `retired` counts sources deleted because they no longer exist upstream. */
export interface IngestRunResult {
  tier: Audience;
  tenantId: string;
  sources: number;
  chunks: number;
  retired: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

export function emptyResult(tier: Audience, tenantId: string): IngestRunResult {
  const now = new Date().toISOString();
  return { tier, tenantId, sources: 0, chunks: 0, retired: 0, errors: [], startedAt: now, finishedAt: now };
}
