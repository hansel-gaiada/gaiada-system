// WSK-32 — proves HttpGatewayCompleter's wire contract against a REAL HTTP server (not a mocked
// `fetch`), mirroring this project's own established convention (test/events-emitter.spec.ts).
// No live ai-gateway-go instance is reachable from this sandbox/CI environment — this test stands
// in a local http server implementing the same `POST /complete -> {text}` contract
// completeViaGateway (platform-nest) and gatewayComplete (mcp-hub) already establish elsewhere in
// this estate, and is explicit in its own name/comments that it is NOT a live-AI-brain assertion.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { HttpGatewayCompleter, SchemaDraftGatewayNotConfiguredError } from "../../src/schema-draft/gateway-client";

type CapturedRequest = { headers: IncomingMessage["headers"]; rawBody: string };

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: { text: '{"blocks":["hero"]}' } };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(nextResponse.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(nextResponse.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to bind test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  nextResponse = { status: 200, body: { text: '{"blocks":["hero"]}' } };
});

describe("HttpGatewayCompleter", () => {
  it("POSTs to /complete with the prompt body and a Bearer token, and returns the gateway's text", async () => {
    const completer = new HttpGatewayCompleter();
    const text = await completer.complete("draft me a schema", { gatewayUrl: baseUrl, gatewayToken: "test-token" });
    expect(text).toBe('{"blocks":["hero"]}');
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(captured[0].rawBody)).toEqual({ prompt: "draft me a schema" });
  });

  it("fails CLOSED when no gateway URL is configured — never a silent local fallback", async () => {
    const completer = new HttpGatewayCompleter();
    await expect(completer.complete("x", { gatewayUrl: "" })).rejects.toThrow(SchemaDraftGatewayNotConfiguredError);
    expect(captured).toHaveLength(0);
  });

  it("throws on a non-2xx gateway response", async () => {
    nextResponse = { status: 500, body: { error: "boom" } };
    const completer = new HttpGatewayCompleter();
    await expect(completer.complete("x", { gatewayUrl: baseUrl, gatewayToken: "t" })).rejects.toThrow(/HTTP 500/);
  });

  it("throws if the gateway response has no text field", async () => {
    nextResponse = { status: 200, body: { provider: "hermes" } };
    const completer = new HttpGatewayCompleter();
    await expect(completer.complete("x", { gatewayUrl: baseUrl, gatewayToken: "t" })).rejects.toThrow(/no text field/);
  });
});
