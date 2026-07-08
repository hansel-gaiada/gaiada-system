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
};
