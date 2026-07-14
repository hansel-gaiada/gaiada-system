import "dotenv/config";

export const config = {
  port: Number(process.env.PLATFORM_PORT ?? 3004),
  host: process.env.HOST ?? "0.0.0.0",
  // Postgres. Connect as a NON-superuser NOBYPASSRLS role in any real deployment —
  // superusers bypass RLS entirely (D5).
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Service token surfaces (bot, mcp-hub, n8n) must present. Empty -> reject (fail-closed).
  serviceToken: process.env.PLATFORM_SERVICE_TOKEN ?? "",
  // This site's identifier (sync retrofit later; recorded on every row now).
  originSite: process.env.ORIGIN_SITE ?? "main",
  // Auth mode (5b): "oidc" requires a verified IdP JWT; "dev" keeps the x-user-id header
  // (local + tests). OBO-envelope resolution works in both modes.
  authMode: process.env.AUTH_MODE ?? "dev",
  oidcIssuer: process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/gaiada",
  oidcJwksUri:
    process.env.OIDC_JWKS_URI ?? "http://localhost:8080/realms/gaiada/protocol/openid-connect/certs",
  oidcAudience: process.env.OIDC_AUDIENCE ?? "gaiada-platform",
  // Cerbos policy decision point (5b.4). The platform calls it for every authorization.
  cerbosUrl: process.env.CERBOS_URL ?? "http://localhost:3592",
  // File storage (5c.4). Local-first backend now (a directory on disk / mounted volume);
  // an object store is the target-state swap behind the same StorageBackend interface.
  filesDir: process.env.FILES_DIR ?? "./data/files",
  // Event backbone (5c continuation): Redis Streams for outbox relay + consumption.
  redisUrl: process.env.REDIS_URL ?? "",
  // Downstream service endpoints the admin/systems console aggregates (Phase C). All
  // read-only; empty URL -> that system reports "not configured" (fail-soft, never fake).
  services: {
    gateway: { url: process.env.GATEWAY_URL ?? "", token: process.env.GATEWAY_TOKEN ?? "" },
    bot: { url: process.env.BOT_URL ?? "", token: process.env.BOT_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "" },
    hub: { url: process.env.HUB_URL ?? "", token: process.env.HUB_SERVICE_TOKEN ?? "" },
    knowledge: { url: process.env.KNOWLEDGE_URL ?? "", token: process.env.KNOWLEDGE_SERVICE_TOKEN ?? "" },
    automation: { url: process.env.AUTOMATION_URL ?? "", token: "" },
  },
  // Per-outbound-call timeout for the admin aggregator's probes (ms).
  adminProbeTimeoutMs: Number(process.env.ADMIN_PROBE_TIMEOUT_MS ?? 3000),
};
