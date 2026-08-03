// Writer-side client for the WS8 knowledge service (D9: WS8 is the SOLE owner of the derived
// vector store; the platform never writes chunks itself). Mirrors modules/search/knowledge-client.ts
// — service-token auth, an abortable fetch — but is the GENERAL ingestion path used by both tiers
// rather than the search module's property-specific one.
//
// Unlike the search module's proxy, ingestion here is NOT fail-soft-silent: an ingest run that
// cannot reach the store must report the failure, because a run that silently wrote nothing looks
// identical to a run that had nothing to write, and that is exactly how a RAG quietly goes stale.
// Per-document errors are collected and surfaced in the run summary instead of aborting the sweep,
// so one bad record cannot strand the other few thousand.
import { config } from "../../../config";
import type { Audience, IngestDocument } from "./types";

const HTTP_TIMEOUT_MS = 30_000;

export class KnowledgeUnavailableError extends Error {}

function base(): string {
  return config.services.knowledge.url.replace(/\/$/, "");
}

/** True when the knowledge service is configured at all. Callers use this to no-op cleanly in
 *  environments (tests, a bare dev box) where WS8 simply is not running. */
export function knowledgeConfigured(): boolean {
  return !!(config.services.knowledge.url && config.services.knowledge.token);
}

async function post(path: string, body: unknown): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(`${base()}${path}`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.services.knowledge.token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new KnowledgeUnavailableError(`knowledge ${path}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Ingest one source. D9.2: this REPLACES every chunk previously stored under `sourceRef`, which is
 *  what makes the scheduled re-ingest idempotent — a re-run of an unchanged corpus converges to the
 *  same rows rather than duplicating them, and an edited record's stale text disappears. */
export async function ingestDocument(doc: IngestDocument): Promise<number> {
  if (doc.chunks.length === 0) return 0;
  const res = await post("/ingest", {
    tenantId: doc.tenantId,
    sourceRef: doc.sourceRef,
    acl: doc.acl ?? [],
    kind: doc.kind ?? "doc",
    chunks: doc.chunks,
    provenance: doc.provenance ?? "human",
    trust: "trusted",
    audience: doc.audience,
  });
  if (!res.ok) throw new Error(`knowledge /ingest ${res.status}: ${await res.text().catch(() => "")}`);
  return ((await res.json()) as { written?: number }).written ?? doc.chunks.length;
}

/** Hard-delete a source's chunks (D9.2). Used to retire records that were deleted or fell out of
 *  the ingestion scope — without this, a deleted project stays answerable forever. */
export async function eraseSource(sourceRef: string): Promise<number> {
  const res = await post("/erase", { sourceRef });
  if (!res.ok) throw new Error(`knowledge /erase ${res.status}`);
  return ((await res.json()) as { deleted?: number }).deleted ?? 0;
}

/** Every source_ref currently stored for a tenant, with its tier. The reconciliation read that
 *  makes retirement possible: whatever the store holds and this run did NOT re-ingest is stale. */
export async function listSourceRefs(tenantId: string): Promise<Array<{ sourceRef: string; audience: Audience }>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${base()}/sources?tenant=${encodeURIComponent(tenantId)}`, {
      signal: ac.signal,
      headers: { Authorization: `Bearer ${config.services.knowledge.token}` },
    });
    if (!res.ok) throw new Error(`knowledge /sources ${res.status}`);
    const rows = (await res.json()) as Array<{ sourceRef?: unknown; audience?: unknown }>;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is { sourceRef: string; audience?: unknown } => typeof r.sourceRef === "string")
      .map((r) => ({ sourceRef: r.sourceRef, audience: r.audience === "public" ? "public" : "internal" }));
  } catch (err) {
    throw new KnowledgeUnavailableError(`knowledge /sources: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
