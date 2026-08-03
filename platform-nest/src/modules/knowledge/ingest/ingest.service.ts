// Orchestrates the two knowledge ingestion tiers.
//
// ── THE SHAPE OF A RUN ───────────────────────────────────────────────────────────────────────────
//   build documents  →  ingest each (D9.2 replaces that source's chunks)  →  retire what vanished
//
// The retire step is what makes a SCHEDULED re-ingest a true mirror rather than an append-only pile.
// Ingest alone only ever adds or replaces; a project deleted in the ERP, or a page removed from the
// site, would stay answerable forever. So after a successful build we diff the store's current
// source list for the tier against the refs this run produced, and hard-delete the difference.
//
// That diff is only safe because it is gated on a CLEAN build: if the document build threw, or any
// document failed to ingest, we skip retirement entirely. Otherwise a transient DB error that
// produced 0 documents would be indistinguishable from "everything was deleted upstream", and one
// bad run would wipe the corpus. Losing freshness for one cycle is recoverable; deleting the whole
// index is not.
import { config } from "../../../config";
import { withGlobal } from "../../../db";
import { buildErpDocuments } from "./erp-source";
import { extractFileText } from "./file-text";
import { eraseSource, ingestDocument, knowledgeConfigured, listSourceRefs } from "./ingest-client";
import type { IngestDocument, IngestRunResult } from "./types";
import { emptyResult } from "./types";
import { crawlSite, pagesToDocuments } from "./web-source";

/** Refs this run wrote, plus whether the build+ingest was clean enough to retire against. */
interface IngestOutcome {
  written: Set<string>;
  chunks: number;
  errors: string[];
}

async function ingestAll(docs: IngestDocument[]): Promise<IngestOutcome> {
  const written = new Set<string>();
  const errors: string[] = [];
  let chunks = 0;
  for (const d of docs) {
    try {
      chunks += await ingestDocument(d);
      written.add(d.sourceRef);
    } catch (err) {
      // Per-document isolation: one oversized record or one transient 5xx must not strand the rest.
      errors.push(`${d.sourceRef} (${d.label}): ${(err as Error).message}`);
    }
  }
  return { written, chunks, errors };
}

/** Delete stored sources of `tier` for `tenantId` that this run did not write. Returns the count. */
async function retireMissing(tenantId: string, tier: "public" | "internal", written: Set<string>, prefixes: string[]): Promise<number> {
  const stored = await listSourceRefs(tenantId);
  let retired = 0;
  for (const s of stored) {
    if (s.audience !== tier) continue;
    // Only ever retire refs this pipeline owns. Other producers (the search module writes its own
    // sources into the same store) must not be collected as "missing" by a run that never built them.
    if (!prefixes.some((p) => s.sourceRef.startsWith(p))) continue;
    if (written.has(s.sourceRef)) continue;
    await eraseSource(s.sourceRef);
    retired++;
  }
  return retired;
}

/** PUBLIC tier: crawl the configured first-party sites and mirror them into world-readable chunks. */
export async function runPublicIngest(): Promise<IngestRunResult> {
  const cfg = config.knowledgeIngest;
  const result = emptyResult("public", cfg.publicTenantId);
  if (!knowledgeConfigured()) {
    result.errors.push("knowledge service not configured (KNOWLEDGE_URL / KNOWLEDGE_SERVICE_TOKEN)");
    result.finishedAt = new Date().toISOString();
    return result;
  }
  if (!cfg.publicTenantId) {
    // Chunks need an owning company row even though the tier is world-readable. Refusing here beats
    // guessing a tenant and scattering public content under an arbitrary company.
    result.errors.push("KNOWLEDGE_PUBLIC_TENANT_ID not set — refusing to guess the owning company");
    result.finishedAt = new Date().toISOString();
    return result;
  }

  let docs: IngestDocument[] = [];
  try {
    const pages = await crawlSite({ sites: cfg.publicSites, maxPages: cfg.publicMaxPages, tenantId: cfg.publicTenantId });
    docs = pagesToDocuments(pages, cfg.publicTenantId);
  } catch (err) {
    result.errors.push(`crawl failed: ${(err as Error).message}`);
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const out = await ingestAll(docs);
  result.sources = out.written.size;
  result.chunks = out.chunks;
  result.errors.push(...out.errors);

  // Retire only after a clean, non-empty crawl — see the file header.
  if (out.errors.length === 0 && docs.length > 0) {
    try {
      result.retired = await retireMissing(cfg.publicTenantId, "public", out.written, ["web:"]);
    } catch (err) {
      result.errors.push(`retire failed: ${(err as Error).message}`);
    }
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/** INTERNAL tier for ONE company. */
export async function runInternalIngest(tenantId: string): Promise<IngestRunResult> {
  const result = emptyResult("internal", tenantId);
  if (!knowledgeConfigured()) {
    result.errors.push("knowledge service not configured (KNOWLEDGE_URL / KNOWLEDGE_SERVICE_TOKEN)");
    result.finishedAt = new Date().toISOString();
    return result;
  }

  let docs: IngestDocument[] = [];
  try {
    docs = await buildErpDocuments(tenantId, config.knowledgeIngest.indexFileContents ? extractFileText : undefined);
  } catch (err) {
    result.errors.push(`build failed: ${(err as Error).message}`);
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const out = await ingestAll(docs);
  result.sources = out.written.size;
  result.chunks = out.chunks;
  result.errors.push(...out.errors);

  if (out.errors.length === 0 && docs.length > 0) {
    try {
      result.retired = await retireMissing(tenantId, "internal", out.written, ["erp:"]);
    } catch (err) {
      result.errors.push(`retire failed: ${(err as Error).message}`);
    }
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/** Companies to index internally: the explicit allowlist, or every active company. */
export async function internalTenantIds(): Promise<string[]> {
  const configured = config.knowledgeIngest.internalTenantIds;
  if (configured.length > 0) return configured;
  // `companies` is the tenant REGISTRY and carries no tenant_id/RLS predicate of its own, so this is
  // correctly a global read — not an RLS bypass.
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL AND status = 'active'`),
  );
  return rows.map((r) => r.id);
}

/** One full sweep: the public corpus once, then every company's internal corpus. */
export async function runFullIngest(): Promise<IngestRunResult[]> {
  const results: IngestRunResult[] = [];
  results.push(await runPublicIngest());
  for (const tenantId of await internalTenantIds()) {
    results.push(await runInternalIngest(tenantId));
  }
  return results;
}
