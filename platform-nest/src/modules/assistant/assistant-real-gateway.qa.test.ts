// ASST-08 QA GATE — adversarial re-drive of ASST-06's stream relay against the REAL running
// ai-gateway-go binary (echo provider chain, keyless), not the ASST-06 test suite's fake gateway
// double. Closes two gaps the ticket calls out explicitly: (c) newline fidelity and (d) DLP
// through the FULL relay path, both "in the real path", not just at the gateway's own unit tests
// or through a hand-rolled fake reproducing the grammar.
//
// Requires a real ai-gateway-go listening at GATEWAY_URL (started for this QA pass via
// `HOST=127.0.0.1 GATEWAY_TLS_MODE=off LLM_CHAIN=echo GATEWAY_TOKEN=qa-token go run ./cmd/gateway`
// inside WSL, port-forwarded to Windows localhost:3002) — skips cleanly if unset/unreachable so it
// never blocks a normal test run.
//
// Deliberately calls `relayGeneration` DIRECTLY with a raw prompt (bypassing `assembleContext`'s
// system preamble): the echo provider truncates `Complete()`'s input to 200 runes, and the
// preamble alone is ~250 chars, so a full HTTP round-trip through the controller would have its
// PII/code-block content pushed past the truncation boundary by the preamble — a dev-fixture
// artifact of the keyless echo terminator, not something ASST-06 or the gateway control. Calling
// `relayGeneration` directly still exercises the REAL wire: real HTTP to the real gateway, real
// SSE parsing (`parseGatewayStream`), real DLP scrubbing inside the real `ai-gateway-go` process.
import { describe, it, expect } from "vitest";
import { relayGeneration, reserveGeneration } from "./stream";

const GATEWAY_URL = process.env.QA_GATEWAY_URL ?? "http://127.0.0.1:3002";
const GATEWAY_TOKEN = process.env.QA_GATEWAY_TOKEN ?? "qa-token";

async function gatewayReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

describe("ASST-08 adversarial: real ai-gateway-go through the ASST-06 relay (not a fake)", async () => {
  const live = await gatewayReachable();

  it.skipIf(!live)(
    "a PAN + multi-paragraph fenced-code prompt arrives DLP-redacted and newline-byte-identical through the real relay",
    async () => {
      const prompt =
        "please echo this back: card 4111 1111 1111 1111 and here is code:\n" +
        "```js\nfunction f() {\n  return 1;\n}\n```\n\nSecond paragraph after a blank line.";

      const tokens: string[] = [];
      const generation = reserveGeneration("qa-real-gw-thread", "qa-real-gw-msg");
      expect(generation).toBeTruthy();

      const result = await relayGeneration(generation!, {
        tenantId: "qa-tenant",
        prompt,
        gatewayUrl: GATEWAY_URL,
        gatewayToken: GATEWAY_TOKEN,
        emit: {
          token: (t) => tokens.push(t),
          meta: () => {},
          usage: () => {},
          done: () => {},
          error: (msg) => tokens.push(`__ERROR__:${msg}`),
        },
      });

      const full = tokens.join("");

      // (d) DLP in the real path: the raw PAN must never appear; the typed redaction marker must.
      expect(full).not.toContain("4111 1111 1111 1111");
      expect(full).toContain("[REDACTED-CARD]");

      // (c) newline fidelity: the fenced code block and the blank-line paragraph break survive
      // through gateway -> SSE -> parseGatewayStream -> re-joined tokens, byte-identical to what
      // was sent (module the redaction itself) — no line silently dropped, no event truncated.
      expect(full).toContain("```js\nfunction f() {\n  return 1;\n}\n```\n\nSecond paragraph");

      // Clean completion — not an abnormal drop, not an upstream error.
      expect(result.outcome).toBe("done");
      expect(tokens.some((t) => t.startsWith("__ERROR__"))).toBe(false);
    },
  );

  it.skipIf(!live)("a clean prompt with no PII passes through with zero redaction markers", async () => {
    const prompt = "please echo: hello world, this has no personal data in it at all.";
    const tokens: string[] = [];
    const generation = reserveGeneration("qa-real-gw-thread-2", "qa-real-gw-msg-2");
    const result = await relayGeneration(generation!, {
      tenantId: "qa-tenant",
      prompt,
      gatewayUrl: GATEWAY_URL,
      gatewayToken: GATEWAY_TOKEN,
      emit: { token: (t) => tokens.push(t), meta: () => {}, usage: () => {}, done: () => {}, error: (m) => tokens.push(`__ERROR__:${m}`) },
    });
    const full = tokens.join("");
    expect(full).not.toContain("REDACTED");
    expect(full).toContain("hello world");
    expect(result.outcome).toBe("done");
  });
});
