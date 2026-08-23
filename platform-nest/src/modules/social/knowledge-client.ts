// SMM-19 — brand-corpus ingest + retrieval against the WS8 knowledge service. Design D-13 (binding,
// smm-design-addendum-2026-08-12 §A1 Δ... / smm-design.md §07): "the corpus (approved past posts,
// brand guidelines, tone docs) is ingested as tenant-ACL'd WS8 knowledge sources — WS8 stays the
// sole owner of derived knowledge stores; the module stores only `knowledge_source_ids` pointers on
// `social_brand_profiles`." This file is the ONLY place the social module touches that boundary; it
// mirrors search/knowledge-client.ts's SM-10 proxy pattern (service-token auth, self-link OBO
// upsert, fail-soft degrade) rather than importing it — see gateway-client.ts's header for why a
// small duplicated client is this estate's idiom across separate projects.
//
// NOT an AI-egress call: gateway-client.ts (ai-gateway-go's /complete) remains the ONLY path this
// module uses to reach an LLM provider directly. This file calls a SIBLING ERP service (WS8's own
// HTTP API) — the knowledge service does its OWN embedding internally against ITS OWN gateway
// client, which is WS8's concern, not this module's.
//
// ── THE ISOLATION PROPERTY THIS FILE EXISTS TO PRESERVE (the cross-client leak test) ─────────────
// WS8's `/search` predicate (ai-agents/src/knowledge/store.ts) is
//   tenant_id = ANY(callerTenantSet) AND (acl = '{}' OR scope = ANY(acl))
// `callerTenantSet` comes from resolving the CALLING PRINCIPAL's own authorized companies via OBO —
// it is what stops one TENANT reading another's chunks, and it is out of this file's hands entirely.
// The `scope`/`acl` pair is the SECOND, finer-grained wall, and it is the one THIS module is
// responsible for: an agency tenant runs engagements for MANY clients, and a brand-voice draft for
// client A must never retrieve client B's unpublished campaign even though both corpora live under
// the same tenant. `brandCorpusScope()` is the ONE place that scope string is computed, and it is
// built from a `clientId` the CALLER (social.controller.ts) must have already resolved from the
// engagement/variant's own DB row — never from a client-supplied field in the request body. That is
// the property the leak test in social-ai-drafts.test.ts drives end to end.
import { config } from "../../config";
import type { Assurance } from "../../rbac/principal";
import { newId, withGlobal } from "../../db";

export interface KnowledgeHit {
  sourceRef: string;
  text: string;
  score: number;
}

export interface KnowledgeClientOptions {
  /** Injected in tests so no real network call ever happens (same pattern as gateway-client.ts). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const HTTP_TIMEOUT_MS = 10_000;

/** The ACL scope string every ingest/query call for one client's brand corpus shares. Deterministic
 *  per (tenantId, clientId) so re-ingesting REPLACES the prior chunks (WS8 D9.2) rather than
 *  accreting duplicates, and so a query can only ever ask for the requesting client's own scope. */
export function brandCorpusScope(tenantId: string, clientId: string): string {
  return `social-brand:${tenantId}:${clientId}`;
}

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

/** Best-effort ingest of a client's brand corpus (approved past posts + guidelines) into WS8
 *  knowledge, ACL-scoped to `brandCorpusScope(tenantId, clientId)`. Re-ingesting the SAME client
 *  REPLACES its prior chunks (WS8 D9.2) — safe to call every time the corpus is refreshed. Never
 *  throws: an unreachable/unconfigured knowledge service just means the following query() call
 *  returns fewer/no hits; it never fails the caller's write. */
/** Which provenance the platform can HONESTLY assert for a brand-corpus ingest, from the only
 *  authorship signal it actually has: the caller's assurance.
 *
 *  `auth/guards.ts` mints exactly two levels for a real caller — `"high"` on the interactive path
 *  (an IdP JWT, or `x-user-id` in dev/tests) and `"linked"` on the OBO envelope path, which is how an
 *  AGENT calls (`x-obo-provider`/`x-obo-external-id`/`x-obo-agent`). `"low"` is `ANONYMOUS`.
 *
 *  So ONLY `"high"` evidences an interactive human. `"linked"` is agent-driven by construction, and
 *  `"low"` is unknown — both resolve to `"agent"`.
 *
 *  ⚠ I first wrote this as `assurance === "low" ? "agent" : "human"`, reasoning from
 *  "automation principals are minted assurance low". That was WRONG in the dangerous direction: an
 *  agent arriving through a VERIFIED identity link is `"linked"`, so the rule would have stamped its
 *  output `"human"` — leaving the exact defect in place while appearing to fix it. Keep this
 *  allow-list shaped (only `"high"` earns `"human"`) rather than deny-list shaped, so a future
 *  assurance level added to the union defaults to the safe answer instead of the harmful one. */
export function brandCorpusProvenance(assurance: Assurance): "human" | "agent" {
  return assurance === "high" ? "human" : "agent";
}

export async function ingestBrandKnowledge(
  tenantId: string,
  clientId: string,
  chunks: string[],
  /** REQUIRED, and deliberately not defaulted. See the note above the body's `provenance` field: the
   *  wrong value here does not merely mislabel a row, it re-ranks it above genuine human guidance in
   *  the retrieval that grounds the next AI draft. A default would let a new call site inherit the
   *  dangerous direction silently, so `tsc` names every caller instead. */
  provenance: "human" | "agent",
  opts?: KnowledgeClientOptions,
): Promise<void> {
  const svc = config.services.knowledge;
  if (!svc.url || chunks.length === 0) return;
  const scope = brandCorpusScope(tenantId, clientId);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    await fetchImpl(`${svc.url.replace(/\/$/, "")}/ingest`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${svc.token}` },
      body: JSON.stringify({
        tenantId,
        sourceRef: scope,
        acl: [scope],
        kind: "doc",
        chunks,
        // WAS HARDCODED `"human"` with the comment "caller-supplied approved content, not
        // agent-generated". That claim was unfounded: this endpoint accepts arbitrary
        // `body.chunks`, and `social.ingestBrandCorpus` is an MCP tool that EXECUTES UNATTENDED, so
        // an agent could submit its own generated text and have it stamped as human-authored.
        //
        // Why it matters more than a label: WS8 scores retrieval as
        // `cosine × confidence × provenance factor`, and `ai-agents/src/knowledge/store.ts` sets
        // `confidence = provenance === "agent" ? 0.6 : 1`. Agent text mislabelled `human` therefore
        // OUTRANKS real human brand guidance in the very retrieval that grounds the next draft —
        // a self-reinforcing loop that degrades the corpus every cycle, invisibly.
        provenance,
        trust: "trusted",
      }),
    });
  } catch {
    // fail-soft — see file header.
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort RAG query against ONE client's brand corpus. `clientId` MUST already be validated
 *  server-side (the engagement/variant's own `client_id` column) — this function has no way to
 *  re-check that, which is exactly why the caller-side contract matters (file header). Resolves the
 *  caller's own OBO envelope the same way search/knowledge-client.ts's queryPropertyKnowledge does,
 *  so WS8's tenant pre-filter matches the CALLER's own authorized-tenant-set, never a service-wide
 *  bypass. Returns [] on ANY failure: RAG grounding is additive, never a hard dependency for a
 *  draft to proceed (the same fail-soft contract search's ai-drafts.ts documents). */
export async function queryBrandKnowledge(
  userId: string | null,
  tenantId: string,
  clientId: string,
  query: string,
  topK: number,
  opts?: KnowledgeClientOptions,
): Promise<KnowledgeHit[]> {
  const svc = config.services.knowledge;
  if (!svc.url || !userId) return [];
  const scope = brandCorpusScope(tenantId, clientId);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    await selfLinkUpsert(userId);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? HTTP_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${svc.url.replace(/\/$/, "")}/search`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${svc.token}`,
          "x-obo-provider": "platform",
          "x-obo-external-id": userId,
        },
        body: JSON.stringify({ query, scope, topK }),
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
