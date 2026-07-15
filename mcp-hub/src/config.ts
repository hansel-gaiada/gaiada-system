import "dotenv/config";

export const config = {
  port: Number(process.env.HUB_PORT ?? 3003),
  host: process.env.HOST ?? "0.0.0.0",
  // Service token calling clients (bot, agents, n8n) must present. Empty -> reject all
  // (fail-closed). This authenticates the SERVICE; the end user rides in the OBO envelope.
  serviceToken: process.env.HUB_SERVICE_TOKEN ?? "",
  // Tool-call audit trail (JSONL — decision + metadata, args redacted).
  auditFile: process.env.HUB_AUDIT_FILE ?? "data/tool-audit.jsonl",
  // AI Gateway (WS3) — AI-backed tools call it; the hub holds no provider keys (D8).
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3002",
  gatewayToken: process.env.GATEWAY_TOKEN ?? "",
  // Platform (WS1) — company-data tools front its API with the OBO envelope; the hub
  // NEVER touches the platform database.
  platformUrl: process.env.PLATFORM_URL ?? "http://localhost:3004",
  platformToken: process.env.PLATFORM_SERVICE_TOKEN ?? "",
  // Knowledge service (WS8-owned derived store). The hub's search tool is a THIN wrapper (D9).
  knowledgeUrl: process.env.KNOWLEDGE_URL ?? "http://localhost:3005",
  knowledgeToken: process.env.KNOWLEDGE_SERVICE_TOKEN ?? "",
  // Cerbos (WS2 §5): when set, the hub's tool-visibility + per-call decisions are made by the
  // versioned `mcp_tool` policy in Cerbos instead of the in-code engine (which remains the
  // fail-closed fallback). Empty ⇒ in-code mode (dev/tests). Same Cerbos as the platform.
  cerbosUrl: process.env.CERBOS_URL ?? "",
  // Rate limiting (§8): token bucket per principal (provider:externalId) AND per service token.
  // 0 disables. Sustained rate/min + burst ceiling.
  rateLimitPerMin: Number(process.env.HUB_RATE_LIMIT_PER_MIN ?? 120),
  rateLimitBurst: Number(process.env.HUB_RATE_LIMIT_BURST ?? 40),
  // D11 revocation: when true (and PLATFORM_URL set), every call re-checks the caller isn't a
  // revoked (verified-then-deactivated) identity via POST /principal/resolve, cached per principal.
  revocationCheck: (process.env.HUB_REVOCATION_CHECK ?? "true") !== "false",
  revocationTtlMs: Number(process.env.HUB_REVOCATION_TTL_MS ?? 60_000),
  // mTLS / zero-trust floor (§3), mirroring the Go gateway's TLS modes:
  //   off        — plain HTTP (dev/tests; compose default until certs are enrolled).
  //   permissive — HTTPS, request a client cert, LOG unknown/absent peers but still serve (rollout).
  //   enforced   — HTTPS, /mcp requires a CA-signed cert whose CN is on the peer allowlist.
  // Certs are minted from the shared internal CA the gateway persists (data/ca-cert.pem) via the
  // synccert tool: `synccert -cn mcp-hub -out-cert certs/mcp-hub.crt -out-key certs/mcp-hub.key`.
  tlsMode: process.env.HUB_TLS_MODE ?? "off",
  tlsCertFile: process.env.HUB_TLS_CERT_FILE ?? "certs/mcp-hub.crt",
  tlsKeyFile: process.env.HUB_TLS_KEY_FILE ?? "certs/mcp-hub.key",
  tlsCaFile: process.env.HUB_TLS_CA_FILE ?? "data/ca-cert.pem",
  tlsPeerAllowlist: (process.env.HUB_TLS_PEER_CNS ?? "bot,ai-agents,n8n,platform,ai-gateway")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Deployment topology (§2/§7): same codebase, scope set by deployment.
  //   site    — fronts the LOCAL platform's tenant data + tools (default).
  //   central — additionally exposes cross-company/management tools (real rollup.metrics over the
  //             central platform's D12 rollup read path — the only sanctioned cross-company read).
  topology: (process.env.HUB_TOPOLOGY ?? "site") as "site" | "central",
};
