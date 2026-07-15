// Gaiada MCP Hub (WS2): Streamable-HTTP MCP endpoint. Stateless mode — each request
// authenticates the calling SERVICE (bearer, fail-closed) and mints the end-user
// principal from the OBO envelope headers (x-obo-provider / x-obo-external-id).
// Zero-trust floor items (mTLS, peer allowlist) come with infra; auth here is the v1 floor.
// WS9: start OpenTelemetry FIRST (before express/pg/MCP SDK) so auto-instrumentation patches them.
// No-op unless OTEL_ENABLED. Keep this import above the others.
import "./telemetry";
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
import { registerModuleTools } from "./module-tools";
import { take } from "./ratelimit";
import { isRevoked } from "./revocation";
import { tlsEnabled, loadTlsOptions, checkPeer } from "./tls";
import { auditToolCall, principalRef } from "./audit";
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

  // Read-only tool catalog for the platform admin console (name/description/minAssurance).
  // Non-sensitive metadata (like /health's name list); the actual per-principal filtering
  // happens over /mcp's tools/list. No handler/inputSchema is exposed here.
  app.get("/tools", (_req, res) => {
    res.json(
      allTools().map((t) => ({
        name: t.name,
        description: t.description,
        minAssurance: t.minAssurance,
        write: !!t.write,
        impact: t.impact ?? null,
      })),
    );
  });

  app.post("/mcp", async (req, res) => {
    // Zero-trust floor (§3): verify the mTLS peer for this sensitive route. No-op when TLS is off.
    const peer = checkPeer(req);
    if (!peer.ok) {
      res.status(403).json({ error: `mTLS: ${peer.reason}` });
      return;
    }
    if (peer.reason) console.warn(`[mtls] ${peer.reason}`);
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
    // Rate limit (§8): per end-user principal AND a coarser per-service-token ceiling. 429 on breach.
    const principalOk = take(`p:${principal.provider}:${principal.externalId}`, config.rateLimitPerMin, config.rateLimitBurst);
    const tokenOk = take(`t:${token}`, config.rateLimitPerMin * 10, config.rateLimitBurst * 10);
    if (!principalOk || !tokenOk) {
      auditToolCall({ ts: Date.now(), tool: "(rate-limit)", principal: principalRef(principal), decision: "deny", reason: "rate_limited" });
      res.status(429).json({ error: "rate limit exceeded — slow down" });
      return;
    }
    // D11: reject a revoked identity (verified link → deactivated user) for the whole request,
    // before any tool runs — this covers gateway-backed tools that never re-hit the platform.
    // Per-principal, cached; fail-open if the platform is unreachable.
    if (await isRevoked(principal)) {
      auditToolCall({ ts: Date.now(), tool: "(revoked)", principal: principalRef(principal), decision: "deny", reason: "revoked" });
      res.status(403).json({ error: "access revoked" });
      return;
    }
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
  // Aggregate module-contributed tools from the platform (WS2 §6). Fail-soft: keeps local tools
  // and logs if the platform is unreachable — the MCP server reads allTools() live per request,
  // so any tools registered here appear on subsequent calls.
  const moduleCount = await registerModuleTools();
  const banner = (scheme: string) =>
    console.log(
      `Gaiada MCP Hub on ${scheme}://${config.host}:${config.port} — tools: [${allTools().map((t) => t.name).join(", ")}] (${moduleCount} from modules), auth: ${config.serviceToken ? "on" : "OFF-reject"}, tls: ${config.tlsMode}, topology: ${config.topology}`,
    );
  if (tlsEnabled()) {
    // Zero-trust floor (§3): mTLS listener. Certs come from the shared internal CA (see tls.ts).
    const { createServer } = await import("node:https");
    createServer(loadTlsOptions(), app).listen(config.port, config.host, () => banner("https"));
  } else {
    app.listen(config.port, config.host, () => banner("http"));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void start();
}
