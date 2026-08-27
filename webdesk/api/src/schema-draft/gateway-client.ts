// WSK-32 — the thin ai-gateway-go client for `llm.extract(kind=webdesk_schema)` (design §07's
// task-routing table). Mirrors the two already-established call sites for the SAME gateway
// contract elsewhere in the estate (POST /complete -> {text, provider?}, Bearer token,
// fail-closed when unconfigured, timeout via AbortController):
//   - platform-nest/src/modules/search/providers/gateway-client.ts (completeViaGateway)
//   - mcp-hub/src/gateway-client.ts (gatewayComplete, used by the hub's OWN llm.extract tool for
//     kind=prd|report|scope)
// This file does not add a new capability class to ai-gateway-go (design §07: "no new capability
// classes") — `/complete` already exists; this project supplies its own prompt (./prompt.ts) the
// same way mcp-hub's llm.extract does for its three kinds, `webdesk_schema` simply being a fourth
// kind this project owns because mcp-hub is out of this ticket's owned files (see final report).
//
// Reads GATEWAY_URL / GATEWAY_TOKEN directly from process.env — the SAME env var names every
// other gateway client in this estate already reads (not re-declared in ../config.ts, which is a
// shared file this ticket does not own; see final report for why this is a self-contained getter
// here rather than a config.ts edit).
export interface GatewayCallOptions {
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Injected in tests so no real network call happens outside a local http server the test
   *  itself stands up (mirrors events-emitter.spec.ts's own convention of a real node:http
   *  server rather than a monkeypatched global fetch). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class SchemaDraftGatewayNotConfiguredError extends Error {
  constructor() {
    super("ai-gateway-go is not configured (GATEWAY_URL unset) — AI schema drafting fails closed, never a silent local fallback");
    this.name = "SchemaDraftGatewayNotConfiguredError";
  }
}

function resolve(opts?: GatewayCallOptions) {
  return {
    url: opts?.gatewayUrl ?? process.env.GATEWAY_URL ?? "",
    token: opts?.gatewayToken ?? process.env.GATEWAY_TOKEN ?? "",
    fetchImpl: opts?.fetchImpl ?? fetch,
    timeoutMs: opts?.timeoutMs ?? 20000,
  };
}

export interface GatewayCompleter {
  complete(prompt: string, opts?: GatewayCallOptions): Promise<string>;
}

/** The real completer — talks to ai-gateway-go's `POST /complete`. */
export class HttpGatewayCompleter implements GatewayCompleter {
  async complete(prompt: string, opts?: GatewayCallOptions): Promise<string> {
    const { url, token, fetchImpl, timeoutMs } = resolve(opts);
    if (!url) throw new SchemaDraftGatewayNotConfiguredError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url.replace(/\/$/, "")}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ai-gateway /complete returned HTTP ${res.status}`);
      const body = (await res.json()) as { text?: string };
      if (typeof body.text !== "string") throw new Error("ai-gateway /complete returned no text field");
      return body.text;
    } finally {
      clearTimeout(timer);
    }
  }
}
