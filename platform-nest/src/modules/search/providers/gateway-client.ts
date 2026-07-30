// SM-09 — the thin ai-gateway-go client for keyword-clustering embeddings + Hermes intent/label
// drafting (design §01/§07/§12 SM-09: "AI is local-first via ai-gateway-go: Hermes for bulk
// (clustering, intent-tagging, ...); ... via the gateway `/embed`"). This file is the ONLY place
// search/clustering code is allowed to reach the network for an AI call — no vendor SDK, no direct
// provider HTTP call, ever (non-negotiable, design §01). It mirrors the two call sites that already
// establish this exact contract elsewhere in the estate: ai-agents/src/knowledge/service.ts's
// embedViaGateway (`POST /embed` -> `{embedding:number[]}`) and ai-agents/src/deps.ts's complete()
// (`POST /complete` -> `{text,provider?}`), same Bearer-token header shape, same gateway. Reuses
// `config.services.gateway.{url,token}` — the same admin-console binding admin-systems.controller.ts
// already reads, so there is exactly one place GATEWAY_URL/GATEWAY_TOKEN are wired from env.
//
// Fail-closed, not fail-open: an unconfigured gateway (no GATEWAY_URL) throws before any fetch is
// attempted (GatewayNotConfiguredError) — never a silent local fallback, never a call to some other
// host. gateway-client.test.ts asserts exactly that: every network call this file makes targets the
// configured gateway URL and nothing else.
import { config } from "../../../config";

export interface GatewayCallOptions {
  /** Override the configured gateway URL (tests only; production always reads config). */
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Injected in tests so no real network call ever happens — same pattern as
   *  providers/dataforseo.ts's `fetchImpl`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GatewayNotConfiguredError extends Error {
  constructor() {
    super(
      "ai-gateway-go is not configured (GATEWAY_URL unset) — AI features fail closed rather than " +
        "falling back to a direct vendor call",
    );
    this.name = "GatewayNotConfiguredError";
  }
}

function resolve(opts?: GatewayCallOptions) {
  return {
    url: opts?.gatewayUrl ?? config.services.gateway.url,
    token: opts?.gatewayToken ?? config.services.gateway.token,
    fetchImpl: opts?.fetchImpl ?? fetch,
    timeoutMs: opts?.timeoutMs ?? 20000,
  };
}

async function callGateway<T>(path: string, body: unknown, opts?: GatewayCallOptions): Promise<T> {
  const { url, token, fetchImpl, timeoutMs } = resolve(opts);
  if (!url) throw new GatewayNotConfiguredError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ai-gateway ${path} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** `POST /embed` — text -> embedding vector. Used for keyword-clustering embeddings (an operational
 *  feature column, design D-7 — NOT the WS8 retrieval-shaped RAG store, which stays WS8-owned). */
export async function embedViaGateway(text: string, opts?: GatewayCallOptions): Promise<number[]> {
  const body = await callGateway<{ embedding: number[] }>("/embed", { text }, opts);
  return body.embedding;
}

export interface CompletionResult {
  text: string;
  provider?: string;
}

/** `POST /complete` — prompt -> completion text (+ the provider the gateway actually served, after
 *  its own chain/failover). Hermes is the gateway's default chain member for bulk work like
 *  intent-tagging (design §01); this file never picks a provider itself, the gateway does. */
export async function completeViaGateway(prompt: string, opts?: GatewayCallOptions): Promise<CompletionResult> {
  return callGateway<CompletionResult>("/complete", { prompt }, opts);
}
