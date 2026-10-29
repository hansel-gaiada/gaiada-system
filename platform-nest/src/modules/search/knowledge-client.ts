// SM-10 — thin proxy to the WS8 knowledge service's /ingest + /search (design §07/§09: "RAG over
// the property's crawled content via WS8 knowledge.search" — D9: WS8 stays the SOLE owner of
// derived knowledge/vector stores; this module never runs its own retrieval index). Mirrors
// admin/intelligence.controller.ts's existing knowledge-service proxy pattern: service-token auth,
// a self-link identity upsert to mint the caller's OBO envelope (same idempotent
// ON CONFLICT DO NOTHING insert triggerAgentGoal already uses), and fail-soft degrade to a no-op /
// empty result on ANY error — the knowledge service being unreachable must never fail a brief
// draft, only narrow its grounding (same philosophy as clustering.ts's Hermes-label fallback: a
// missing nice-to-have never blocks the artifact that IS available from persisting).
//
// NOT an AI-egress call: gateway-client.ts (ai-gateway-go's /embed + /complete) remains the ONLY
// path this module uses to reach an LLM provider directly. This file calls a SIBLING ERP service
// (WS8's own HTTP API, exactly like intelligence.controller.ts's knowledge-sources proxy already
// does) — the knowledge service does its OWN embedding internally against ITS OWN gateway client,
// which is WS8's concern, not this module's.
import { config } from "../../config";
import { newId, withGlobal } from "../../db";
import { keepOwnCorpus, ownCorpusTopK } from "../knowledge/own-corpus";

export interface KnowledgeHit {
  sourceRef: string;
  text: string;
  score: number;
}

const HTTP_TIMEOUT_MS = 10_000;

async function selfLinkUpsert(userId: string): Promise<void> {
  await withGlobal((c) =>
    c.query(
      `INSERT INTO identity_links (id, user_id, provider, external_id, verified_at)
       VALUES ($1, $2, 'platform', $3, now())
       ON CONFLICT (provider, external_id) DO NOTHING`,
      [newId(), userId, userId],
    ),
  );
}

/** Best-effort ingest of this module's OWN derived grounding text as a WS8 knowledge source,
 *  ACL-scoped to `aclScope` (design §07/D9: "crawler output is ingested as tenant-ACL'd knowledge
 *  sources"). Re-ingesting the SAME sourceRef REPLACES its prior chunks (WS8 D9.2) — safe to call
 *  every time a brief is (re)drafted. Never throws: an unreachable/unconfigured knowledge service
 *  just means the immediately-following search() call returns fewer/no hits; it never fails the
 *  draft itself. */
export async function ingestPropertyKnowledge(
  tenantId: string,
  sourceRef: string,
  aclScope: string,
  chunks: string[],
): Promise<void> {
  const svc = config.services.knowledge;
  if (!svc.url || chunks.length === 0) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    await fetch(`${svc.url.replace(/\/$/, "")}/ingest`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svc.token}` },
      body: JSON.stringify({
        tenantId,
        sourceRef,
        acl: [aclScope],
        kind: "doc",
        chunks,
        provenance: "agent",
        trust: "trusted",
      }),
    });
  } catch {
    // fail-soft — see file header.
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort RAG query against WS8 knowledge, scoped to `aclScope` (must match an `acl` entry an
 *  ingest call used, e.g. the property id — WS8's D9.1 pre-filter is `acl = '{}' OR scope =
 *  ANY(acl)`, store.ts). Resolves the caller's own OBO envelope the same way
 *  admin/intelligence.controller.ts's triggerAgentGoal does (self-link upsert, provider='platform',
 *  externalId=userId) so the knowledge service's tenant pre-filter matches the caller's own
 *  authorized-tenant-set — never a service-wide bypass. Returns [] on ANY failure (unconfigured
 *  service, network error, malformed response): RAG grounding is additive, never a hard dependency
 *  for drafting to proceed. */
export async function queryPropertyKnowledge(
  userId: string,
  aclScope: string,
  /** DW-D31: the sourceRef the corpus was ingested under. Only its hits are returned (see `knowledge/own-corpus.ts`). */
  ownRef: string,
  query: string,
  topK: number,
): Promise<KnowledgeHit[]> {
  const svc = config.services.knowledge;
  if (!svc.url || !userId) return [];
  try {
    await selfLinkUpsert(userId);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(`${svc.url.replace(/\/$/, "")}/search`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${svc.token}`,
          "x-obo-provider": "platform",
          "x-obo-external-id": userId,
        },
        body: JSON.stringify({ query, scope: aclScope, topK: ownCorpusTopK(topK) }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { hits?: Array<{ sourceRef?: unknown; text?: unknown; score?: unknown }> };
      if (!Array.isArray(json.hits)) return [];
      const hits = json.hits
        .filter((h): h is { sourceRef: string; text: string; score?: unknown } => typeof h.sourceRef === "string" && typeof h.text === "string")
        .map((h) => ({ sourceRef: h.sourceRef, text: h.text, score: typeof h.score === "number" ? h.score : 0 }));
      // DW-D31: the scope also matches every internal ERP chunk (empty acl) of every company the caller is in. Only the corpus
      // ingested under `ownRef` may ground the draft.
      return keepOwnCorpus(hits, ownRef, topK);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

/** A hit as the knowledge service's `POST /search` returns it (the chunk's tenant, ref, tier, text and score). */
export interface KnowledgeStoreHit {
  tenantId: string;
  sourceRef: string;
  kind: string;
  text: string;
  provenance: string;
  confidence: number;
  score: number;
  audience: string;
  /** AIP-11/12: the org node id of the department that owns the chunk's record, or `null` (company-wide, or a store that does not
   *  report it yet). A RANKING fact only: it is never read for access (plan §3.3). */
  departmentId: string | null;
}

/** The knowledge service could not answer: not configured, unreachable, timed out, non-2xx or an unreadable body. The staff
 *  search route turns this into 503 `knowledge_unavailable`; it must never read as "no results". */
export class KnowledgeUnavailableError extends Error {
  constructor(reason: string) {
    super(`knowledge unavailable: ${reason}`);
    this.name = "KnowledgeUnavailableError";
  }
}

/** AIP-12: what the caller may add to a strict search. `department` asks the store to rank that department's internal chunks of
 *  that company first (a score boost inside the store, after its pre-filter); it narrows nothing and widens nothing. */
export interface StrictSearchOptions {
  department?: { tenantId: string; nodeId: string };
}

/** DW-8i. The same call as `queryPropertyKnowledge` (the caller's own OBO envelope, so the store's tenant pre-filter is the
 *  caller's own tenant set), but it RETURNS the store's hits whole, tier and tenant included, and THROWS `KnowledgeUnavailableError`
 *  on every failure instead of folding it into `[]`. The query text is sent to the service only; it is not logged here. */
export async function searchKnowledgeStrict(userId: string, query: string, topK: number, opts?: StrictSearchOptions): Promise<KnowledgeStoreHit[]> {
  const svc = config.services.knowledge;
  if (!svc.url) throw new KnowledgeUnavailableError("not configured");
  if (!userId) throw new KnowledgeUnavailableError("no caller");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    await selfLinkUpsert(userId);
    const res = await fetch(`${svc.url.replace(/\/$/, "")}/search`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svc.token}`,
        "x-obo-provider": "platform",
        "x-obo-external-id": userId,
      },
      // `department` rides only when given, so the body without it is byte for byte what it was before AIP-12.
      body: JSON.stringify({ query, scope: "", topK, publicOnly: false, ...(opts?.department ? { department: opts.department } : {}) }),
    });
    if (!res.ok) throw new KnowledgeUnavailableError(`HTTP ${res.status}`);
    const json = (await res.json()) as { hits?: unknown };
    if (!Array.isArray(json.hits)) throw new KnowledgeUnavailableError("malformed answer");
    const out: KnowledgeStoreHit[] = [];
    for (const h of json.hits as Array<Record<string, unknown>>) {
      // A hit missing the fields the filter keys on is dropped, not repaired: it cannot be tied to a record.
      if (!h || typeof h.sourceRef !== "string" || typeof h.text !== "string" || typeof h.tenantId !== "string" || typeof h.audience !== "string") continue;
      out.push({
        tenantId: h.tenantId,
        sourceRef: h.sourceRef,
        kind: typeof h.kind === "string" ? h.kind : "doc",
        text: h.text,
        provenance: typeof h.provenance === "string" ? h.provenance : "",
        confidence: typeof h.confidence === "number" ? h.confidence : 0,
        score: typeof h.score === "number" ? h.score : 0,
        audience: h.audience,
        departmentId: typeof h.departmentId === "string" ? h.departmentId : null,
      });
    }
    return out;
  } catch (e) {
    if (e instanceof KnowledgeUnavailableError) throw e;
    throw new KnowledgeUnavailableError(e instanceof Error ? e.name : "error");
  } finally {
    clearTimeout(timer);
  }
}
