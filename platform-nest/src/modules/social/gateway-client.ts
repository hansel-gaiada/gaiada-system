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

export interface CompletionResult {
  text: string;
  provider?: string;
}

/** `POST /complete` — prompt -> completion text (+ the provider that actually served it, after the
 *  gateway's own failover). `opts.provider` is the cloudPolish hint (see file header); it is the
 *  ONLY provider-selection knob this module has — everything past that is the gateway's chain. */
export async function completeViaGateway(prompt: string, opts?: GatewayCallOptions): Promise<CompletionResult> {
  const body: { prompt: string; provider?: string } = { prompt };
  if (opts?.provider) body.provider = opts.provider;
  return callGateway<CompletionResult>("/complete", body, opts);
}
