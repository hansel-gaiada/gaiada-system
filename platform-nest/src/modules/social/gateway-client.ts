// SMM-19 — the thin ai-gateway-go client for brand-voice drafting (caption/hashtag/idea). This file
// is the ONLY place the social module is allowed to reach the network for an AI call — no vendor
// SDK, no direct provider HTTP call, ever (root CLAUDE.md: "Only the Gateway holds provider keys").
// Mirrors search/providers/gateway-client.ts's SM-09 contract byte-for-byte (same host, same
// endpoints, same fail-closed posture) rather than importing it — components stay separate projects
// with no shared package layer, so a thin, deliberately duplicated client is the estate's own idiom
// here (canonical-args.ts's header explains the same tradeoff for the D14 hash).
//
// Fail-closed, not fail-open: an unconfigured gateway (no GATEWAY_URL) throws before any fetch is
// attempted (GatewayNotConfiguredError) — never a silent local fallback, never a call to some other
// host. gateway-client.test.ts asserts exactly that, plus that every call targets the ONE configured
// host — the assertion SMM-19 was told matters most alongside the cross-client leak test.
//
// `provider` hint (design §07: "Hermes draft -> Claude polish when tool_scope.ai.cloudPolish"): a
// PURE REORDERING hint honoured by /complete (2026-08-07) — never a requirement. Omit it and the
// gateway's own chain order serves the call (Hermes by default); pass `{provider:"claude"}` only
// when the engagement's `tool_scope.ai.cloudPolish` is on. This module never asserts a vendor
// identity or holds a vendor key — it only asks the gateway to try one name first.
import { config } from "../../config";
import {
  outcomeForGatewayStatus, readGatewayUsage, recordGatewayCall, statusFromError,
  type AiCallAttribution, type GatewayCallFacts,
} from "../ai-usage/gateway-usage";

export interface GatewayCallOptions {
  /** Override the configured gateway URL (tests only; production always reads config). */
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Injected in tests so no real network call ever happens. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Optional per-request provider-order hint (cloudPolish). See file header. */
  provider?: string;
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

/** A non-2xx gateway answer: the status is what the usage record classifies (429 budget, 503 DLP, anything else an error). */
class GatewayHttpError extends Error {
  constructor(path: string, readonly status: number) {
    super(`ai-gateway ${path} returned HTTP ${status}`);
    this.name = "GatewayHttpError";
  }
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
  return { provider: answer?.provider ?? null, model: typeof answer?.model === "string" ? answer.model : null, usage: readGatewayUsage(answer?.usage) };
}

/**
 * One call, and ONE usage row for it (AIP-03a): after the answer is in hand, fire-and-forget, never throwing, never delaying. A refusal (429 budget,
 * 503 DLP) or any other failure that reached the gateway is a row too, with the matching outcome and no tokens. An unconfigured gateway made no call
 * and records nothing.
 */
async function callGateway<T extends CompletionResult>(path: string, body: unknown, opts: AttributedCallOptions): Promise<T> {
  const { url, token, fetchImpl, timeoutMs } = resolve(opts);
  if (!url) throw new GatewayNotConfiguredError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const providerHint = opts.provider ?? null;
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
      facts = completionFacts(answer);
    } catch {
      facts = {}; // a malformed answer is still a call that was made: it records with no figures
    }
    if (opts.attribution) void recordGatewayCall(opts.attribution, { capability: "llm", outcome: "ok", providerHint, ...facts });
    return answer;
  } catch (err) {
    if (opts.attribution) {
      const status = err instanceof GatewayHttpError ? err.status : statusFromError(err);
      void recordGatewayCall(opts.attribution, { capability: "llm", outcome: status === null ? "error" : outcomeForGatewayStatus(status), providerHint });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** `POST /complete` — prompt -> completion text (+ the provider that actually served it, after the
 *  gateway's own failover). `opts.provider` is the cloudPolish hint (see file header); it is the
 *  ONLY provider-selection knob this module has — everything past that is the gateway's chain. */
export async function completeViaGateway(prompt: string, opts: AttributedCallOptions): Promise<CompletionResult> {
  const body: { prompt: string; provider?: string } = { prompt };
  if (opts.provider) body.provider = opts.provider;
  return callGateway<CompletionResult>("/complete", body, opts);
}
