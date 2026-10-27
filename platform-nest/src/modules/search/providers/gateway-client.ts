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
import {
  outcomeForGatewayStatus, readGatewayUsage, recordGatewayCall, statusFromError,
  type AiCallAttribution, type GatewayCallFacts, type GatewayUsage,
} from "../../ai-usage/gateway-usage";

export interface GatewayCallOptions {
  /** Override the configured gateway URL (tests only; production always reads config). */
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Injected in tests so no real network call ever happens — same pattern as
   *  providers/dataforseo.ts's `fetchImpl`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** AIP-03a: every call through this client writes one `ai_usage_events` row. The attribution is REQUIRED in the type, so a new caller cannot skip it. */
export interface AttributedCallOptions extends GatewayCallOptions {
  attribution: AiCallAttribution;
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

/** A gateway answer as read for the usage record: the body plus the HTTP status that produced it. */
class GatewayHttpError extends Error {
  constructor(path: string, readonly status: number) {
    super(`ai-gateway ${path} returned HTTP ${status}`);
    this.name = "GatewayHttpError";
  }
}

/**
 * One call, and ONE usage row for it (AIP-03a): after the answer is in hand, fire-and-forget, never throwing, never delaying. A refusal (429 budget,
 * 503 DLP) or any other failure that reached the gateway is a row too, with the matching outcome and no tokens. An unconfigured gateway made no call and
 * records nothing. `read` maps the body to the call's facts.
 */
async function callGateway<T>(
  path: string,
  body: unknown,
  opts: AttributedCallOptions,
  capability: GatewayCallFacts["capability"],
  read: (answer: T) => Pick<GatewayCallFacts, "provider" | "model" | "usage">,
  providerHint?: string,
): Promise<T> {
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
    if (!res.ok) throw new GatewayHttpError(path, res.status);
    const answer = (await res.json()) as T;
    let facts: Pick<GatewayCallFacts, "provider" | "model" | "usage"> = {};
    try {
      facts = read(answer);
    } catch {
      facts = {}; // a malformed answer is still a call that was made: it records with no figures
    }
    if (opts.attribution) void recordGatewayCall(opts.attribution, { capability, outcome: "ok", providerHint, ...facts });
    return answer;
  } catch (err) {
    // The call reached the gateway (or tried to) and failed: record it. A configured-but-unreachable gateway is an `error` with no tokens.
    if (opts.attribution) {
      const status = err instanceof GatewayHttpError ? err.status : statusFromError(err);
      void recordGatewayCall(opts.attribution, { capability, outcome: status === null ? "error" : outcomeForGatewayStatus(status), providerHint });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** `POST /embed` — text -> embedding vector. Used for keyword-clustering embeddings (an operational
 *  feature column, design D-7 — NOT the WS8 retrieval-shaped RAG store, which stays WS8-owned). */
export async function embedViaGateway(text: string, opts: AttributedCallOptions): Promise<number[]> {
  // The gateway's /embed answer carries no token figures, so the row is `none` (AIP-03a).
  const body = await callGateway<{ embedding: number[] }>("/embed", { text }, opts, "embed", () => ({}));
  return body.embedding;
}

export interface CompletionResult {
  text: string;
  provider?: string;
  /** AIP-02: the provider's own counts and cost, when the serving provider reported them. */
  usage?: { promptTokens: number; completionTokens: number; costUsd?: number; source?: string };
  /** Additive and forward-compatible: the model that served, when the gateway reports it (it does not on /complete today). */
  model?: string;
}

/** What a /complete answer says about the call, for the usage record. */
export function completionFacts(answer: CompletionResult): Pick<GatewayCallFacts, "provider" | "model" | "usage"> {
  const usage: GatewayUsage | null = readGatewayUsage(answer?.usage);
  return { provider: answer?.provider ?? null, model: typeof answer?.model === "string" ? answer.model : null, usage };
}

/** `POST /complete` — prompt -> completion text (+ the provider the gateway actually served, after
 *  its own chain/failover). Hermes is the gateway's default chain member for bulk work like
 *  intent-tagging (design §01); this file never picks a provider itself, the gateway does. */
export async function completeViaGateway(prompt: string, opts: AttributedCallOptions): Promise<CompletionResult> {
  return callGateway<CompletionResult>("/complete", { prompt }, opts, "llm", completionFacts);
}
