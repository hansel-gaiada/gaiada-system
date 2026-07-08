// Gaiada MCP Hub (WS2): Streamable-HTTP MCP endpoint. Stateless mode — each request
// authenticates the calling SERVICE (bearer, fail-closed) and mints the end-user
// principal from the OBO envelope headers (x-obo-provider / x-obo-external-id).
// Zero-trust floor items (mTLS, peer allowlist) come with infra; auth here is the v1 floor.
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config";
import { buildHubServer } from "./hub";
import { mintPrincipal } from "./principal";
import { registerCoreTools } from "./tools";
import { registerPlatformTools } from "./platform-tools";
import { registerPlatformWriteTools } from "./platform-write-tools";
import { allTools } from "./registry";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function buildHttpApp(): express.Express {
  if (allTools().length === 0) {
    registerCoreTools();
    registerPlatformTools();
    registerPlatformWriteTools();
  }
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, tools: allTools().map((t) => t.name) });
  });

  app.post("/mcp", async (req, res) => {
    // Service auth (fail-closed).
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!config.serviceToken || !safeEqual(token, config.serviceToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // OBO principal — minted HERE from the envelope; clients cannot assert assurance.
    const principal = mintPrincipal({
      provider: (req.headers["x-obo-provider"] as string) || undefined,
      externalId: (req.headers["x-obo-external-id"] as string) || undefined,
    });
    const server = buildHubServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}

async function start(): Promise<void> {
  const app = buildHttpApp();
  app.listen(config.port, config.host, () => {
    console.log(
      `Gaiada MCP Hub on ${config.host}:${config.port} — tools: [${allTools().map((t) => t.name).join(", ")}], auth: ${config.serviceToken ? "on" : "OFF-reject"}`,
    );
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void start();
}
