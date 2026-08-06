import "dotenv/config";

export const config = {
  port: Number(process.env.HUB_PORT ?? 3003),
  host: process.env.HOST ?? "0.0.0.0",
  // Service token calling clients (bot, agents, n8n) must present. Empty -> reject all
  // (fail-closed). This authenticates the SERVICE; the end user rides in the OBO envelope.
  serviceToken: process.env.HUB_SERVICE_TOKEN ?? "",
  // Assurance elevation (design §2, 2026-08-06): a SECOND service token, distinct from the one above
  // and held ONLY by callers entitled to mint `verified` principals — platform-nest (it IS the IdP)
  // and ai-agents (it carries the triggering human's envelope). A caller presenting this token may
  // reach `verified` when the platform ALSO vouches for the envelope's identity; a caller presenting
  // the ordinary token above is capped at `low` no matter whose link is verified, which is what keeps
  // `principal.ts`'s "chat-surface envelopes can only ever mint LOW assurance" literally true.
  // Accepted as ordinary service auth too, so an elevated caller needs one token, not two.
  //
  // EMPTY ⇒ NOBODY EVER ELEVATES (fail-closed; behaviour identical to before this existed). It must be
  // listed in the `environment:` block of BOTH the hub and every elevated caller — a value in .env
  // alone does nothing, the failure class that has shipped four features silently disabled in this
  // repo. Never give this value to n8n or the bot; an n8n principal is refused in code regardless
  // (the §A13 ruling), but the bot is not, and handing it over would quietly lift the chat ceiling.
  assuranceToken: process.env.HUB_ASSURANCE_TOKEN ?? "",
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
  // D14 execution grant (D14-04, plan §1): the HMAC secret shared with platform-nest, which mints a
  // single-use `x-approval-grant` when a human approves a suspended automation write. Empty ⇒ every
  // presented grant is REJECTED (fail closed — the impact gate keeps suspending), never skipped.
  // Must be listed in BOTH services' compose `environment:` blocks; a value in .env alone does
  // nothing (this repo has shipped four features silently disabled that exact way).
  approvalGrantSecret: process.env.APPROVAL_GRANT_SECRET ?? "",
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
  // WS11 delivery tools (build item 9). GitHub repo checks + staging deploy trigger. All fail
  // CLOSED with a clear message when unset (like image.enhance), so the tools register but never
  // pretend. github: a PAT/app token + API base (default github.com). deploy: a workflow_dispatch-
  // style webhook the release pipeline (WS10) exposes, plus its auth token.
  githubApiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  githubOrg: process.env.GITHUB_ORG ?? "",
  deployStagingUrl: process.env.DEPLOY_STAGING_URL ?? "",
  deployStagingToken: process.env.DEPLOY_STAGING_TOKEN ?? "",
  // Production deploy (WS11 tail B): a SEPARATE dispatch webhook from staging — production is
  // customer-facing + not trivially reversible, so it is HIGH-impact and gated on a human PM
  // prod-approval AND the client's staging sign-off before the workflow ever calls it.
  deployProductionUrl: process.env.DEPLOY_PRODUCTION_URL ?? "",
  deployProductionToken: process.env.DEPLOY_PRODUCTION_TOKEN ?? "",
};
