import "dotenv/config";

export const config = {
  port: Number(process.env.GATEWAY_PORT ?? 3002),
  host: process.env.HOST ?? "0.0.0.0",
  // Bearer token callers must present. Empty -> every request rejected (fail-closed).
  gatewayToken: process.env.GATEWAY_TOKEN ?? "",
  // Provider keys live HERE and nowhere else (D8).
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
  // Local model server (Ollama). Set OLLAMA_URL="" to disable; local-first per WS3.
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.2",
  ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
  // Self-hosted faster-whisper (5a.3): any OpenAI-compatible /v1/audio/transcriptions
  // server (faster-whisper-server / speaches / whisper.cpp bridge). Empty = disabled.
  whisperUrl: process.env.WHISPER_URL ?? "",
  whisperModel: process.env.WHISPER_MODEL ?? "Systran/faster-whisper-small",
  // Ordered capability chains (comma-separated provider names; first healthy wins).
  // LOCAL-FIRST (WS3 §2): ollama, then cloud failover. No Ollama running → the breaker
  // skips it after a few fast local refusals.
  llmChain: (process.env.LLM_CHAIN ?? "ollama,gemini,claude").split(",").map((s) => s.trim()),
  mediaChain: (process.env.MEDIA_CHAIN ?? "whisper,gemini").split(",").map((s) => s.trim()),
  embedChain: (process.env.EMBED_CHAIN ?? "ollama,gemini").split(",").map((s) => s.trim()),
  // Cost governance: a global daily call cap AND a per-tenant daily cap. Over either ->
  // 429 + degrade + an audited alert (management escalation), never unbounded spend.
  dailyCallCap: Number(process.env.GATEWAY_DAILY_CALL_CAP ?? 2000),
  perTenantDailyCallCap: Number(process.env.GATEWAY_PER_TENANT_DAILY_CALL_CAP ?? 1000),
  // Deterministic egress floor (D8.3): default-deny outbound. Only provider hosts (derived
  // from configured keys/URLs) plus any explicitly allowlisted FQDNs may be reached; every
  // other outbound fetch throws and is audited. EGRESS_ALLOWLIST is a comma-separated host list.
  egressAllowlist: (process.env.EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Circuit breaker: consecutive failures before a provider is skipped, and for how long.
  breakerThreshold: Number(process.env.BREAKER_THRESHOLD ?? 3),
  breakerCooldownMs: Number(process.env.BREAKER_COOLDOWN_MS ?? 60_000),
  // Egress audit trail (JSONL, metadata only — never payload content).
  auditFile: process.env.AUDIT_FILE ?? "data/egress-audit.jsonl",
  // Max media payload accepted (base64 body limit derives from this).
  mediaMaxBytes: Number(process.env.MEDIA_MAX_BYTES ?? 15 * 1024 * 1024),
};
