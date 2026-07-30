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
export async function queryPropertyKnowledge(userId: string, aclScope: string, query: string, topK: number): Promise<KnowledgeHit[]> {
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
        body: JSON.stringify({ query, scope: aclScope, topK }),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { hits?: Array<{ sourceRef?: unknown; text?: unknown; score?: unknown }> };
      if (!Array.isArray(json.hits)) return [];
      return json.hits
        .filter((h): h is { sourceRef: string; text: string; score?: unknown } => typeof h.sourceRef === "string" && typeof h.text === "string")
        .map((h) => ({ sourceRef: h.sourceRef, text: h.text, score: typeof h.score === "number" ? h.score : 0 }));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}
