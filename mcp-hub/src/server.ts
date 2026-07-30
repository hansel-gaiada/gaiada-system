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
import { registerPipelineTools } from "./pipeline-tools";
import { registerDeliveryTools } from "./delivery-tools";
import { registerPmTools } from "./pm-tools";
import { registerWorkActivityTools } from "./work-activity-tools";
import { startModuleToolsBootstrap, moduleToolsStatus } from "./module-tools";
import { take } from "./ratelimit";
import { isRevoked } from "./revocation";
import { tlsEnabled, loadTlsOptions, checkPeer } from "./tls";
import { auditToolCall, principalRef, readRecentAudit } from "./audit";
import { allTools, withSource } from "./registry";
import { cerbosEnabled } from "./cerbos";
import { RESOURCE_TEMPLATES } from "./resources";
import { PROMPTS } from "./prompts";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function buildHttpApp(): express.Express {
  if (allTools().length === 0) {
    // Each group is labeled so the admin console can say WHERE a tool came from (a core probe vs a
    // platform read vs a WS11 delivery action) instead of showing one undifferentiated list.
    withSource("core", registerCoreTools);
    withSource("platform-read", registerPlatformTools);
    withSource("platform-write", registerPlatformWriteTools);
    withSource("pipeline", registerPipelineTools);
    withSource("delivery", registerDeliveryTools);
    withSource("pm", registerPmTools);
    withSource("work-activity", registerWorkActivityTools);
  }
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req, res) => {
    // SM-45: surface the module-tools bootstrap state so a persistent zero-module-tools condition
    // (platform unreachable at boot, or a restart the hub hasn't recovered from yet) is visible on
    // the same probe everything else already polls, not just discoverable by counting /tools.
    res.json({ ok: true, tools: allTools().map((t) => t.name), moduleTools: moduleToolsStatus() });
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
        source: t.source ?? "unknown",
      })),
    );
  });

  // Service-token gate for the admin reads below. /health and /tools stay open (non-sensitive
  // metadata); the audit trail carries principal identifiers and the info block describes the
  // security posture, so both are bearer-gated exactly like /mcp. Fail-closed on an unset token.
  const adminAuthorized = (req: express.Request): boolean => {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    return !!config.serviceToken && safeEqual(token, config.serviceToken);
  };

  // Read side of the §8 tool-call audit — every allow/deny decision with its reason. This is the
  // hub's accountability record; without a read route it existed on disk and nowhere else.
  app.get("/audit", (req, res) => {
    if (!adminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const raw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 100;
    res.json(readRecentAudit(config.auditFile, limit));
  });

  // Operational posture for the admin console: what the policy engine is, what the limits are,
  // which primitives exist beyond Tools, and the per-workflow least-privilege matrix. No secrets —
  // only presence flags, mirroring the gateway's /admin/config rule.
  app.get("/admin/info", (req, res) => {
    if (!adminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const tools = allTools();
    const bySource: Record<string, number> = {};
    for (const t of tools) bySource[t.source ?? "unknown"] = (bySource[t.source ?? "unknown"] ?? 0) + 1;
    res.json({
      policy: {
        // Which engine actually decided: Cerbos when configured, else the in-code fallback. This is
        // the single most load-bearing fact about the hub and it was previously invisible.
        engine: cerbosEnabled() ? "cerbos" : "in-code",
        cerbosConfigured: cerbosEnabled(),
        denyByDefault: true,
        assuranceRanks: ["anonymous", "low", "verified"],
        // §3 / D14: the rule that decides whether an unattended automation write runs or suspends.
        automationWriteGate: "unattended automation runs LOW-impact writes only; medium/high/unclassified writes suspend for human approval",
        revocationCheck: config.revocationCheck,
        revocationTtlMs: config.revocationTtlMs,
      },
      rateLimit: {
        perPrincipalPerMin: config.rateLimitPerMin,
        perPrincipalBurst: config.rateLimitBurst,
        // The per-service-token ceiling is deliberately 10x the per-principal one (server.ts /mcp).
        perServiceTokenPerMin: config.rateLimitPerMin * 10,
        perServiceTokenBurst: config.rateLimitBurst * 10,
      },
      transport: {
        tlsMode: config.tlsMode,
        peerAllowlist: config.tlsPeerAllowlist,
        topology: config.topology,
        serviceAuthConfigured: !!config.serviceToken,
      },
      tools: { total: tools.length, bySource },
      // The other two MCP primitives — the console previously showed Tools only.
      resources: RESOURCE_TEMPLATES,
      prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: p.arguments })),
      // Per-workflow scoped service accounts (§3): the least-privilege matrix for ALL automation.
      workflowScopes: Object.entries(AUTOMATION_ALLOWLIST).map(([workflow, allowed]) => ({
        workflow,
        tools: [...allowed],
      })),
      upstreams: {
        gatewayConfigured: !!config.gatewayUrl,
        platformConfigured: !!config.platformUrl,
        knowledgeConfigured: !!config.knowledgeUrl,
      },
      // SM-45: module-tool aggregation is fail-soft by design (the hub must still serve its core
      // tools when the platform is down) — this is the one place that state stops being silent.
      moduleTools: moduleToolsStatus(),
    });
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
  // SM-45: the hub must start and serve its core tools even if the platform isn't up yet (fail-soft
  // stays the rule) — so the listener comes up FIRST, and module-tool aggregation (WS2 §6) runs as a
  // background self-healing loop: retry-with-backoff until the first success, then periodic
  // re-fetch. This also recovers from a platform restart AFTER the hub is already running, which no
  // compose depends_on ordering can help with. The MCP server reads allTools() live per request, so
  // tools registered later (by a retry or the periodic refresh) appear on subsequent calls without a
  // hub restart. The startup banner logs the count at THIS instant only — moduleToolsStatus()
  // (surfaced on /health and /admin/info) is the live source of truth from here on.
  const banner = (scheme: string) =>
    console.log(
      `Gaiada MCP Hub on ${scheme}://${config.host}:${config.port} — tools: [${allTools().map((t) => t.name).join(", ")}] (${moduleToolsStatus().registered} from modules so far), auth: ${config.serviceToken ? "on" : "OFF-reject"}, tls: ${config.tlsMode}, topology: ${config.topology}`,
    );
  if (tlsEnabled()) {
    // Zero-trust floor (§3): mTLS listener. Certs come from the shared internal CA (see tls.ts).
    const { createServer } = await import("node:https");
    createServer(loadTlsOptions(), app).listen(config.port, config.host, () => banner("https"));
  } else {
    app.listen(config.port, config.host, () => banner("http"));
  }
  startModuleToolsBootstrap();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void start();
}
