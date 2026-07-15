import "dotenv/config";

export const config = {
  port: Number(process.env.PLATFORM_PORT ?? 3004),
  host: process.env.HOST ?? "0.0.0.0",
  // Postgres. Connect as a NON-superuser NOBYPASSRLS role in any real deployment —
  // superusers bypass RLS entirely (D5).
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Migrations/DDL + runtime-grant provisioning run as the OWNER role (migrate() uses this, not
  // the restricted runtime role). Empty -> migrate() falls back to databaseUrl at call time
  // (dev/tests, where owner==runtime).
  migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL ?? "",
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
    // n8n: token is its Public-API key (X-N8N-API-KEY) used to list workflows/executions.
    automation: { url: process.env.AUTOMATION_URL ?? "", token: process.env.AUTOMATION_API_KEY ?? "" },
  },
  // Per-outbound-call timeout for the admin aggregator's probes (ms).
  adminProbeTimeoutMs: Number(process.env.ADMIN_PROBE_TIMEOUT_MS ?? 3000),
  // Event → n8n bridge (WS4 §4): forwards allow-listed event-backbone events to n8n webhooks
  // so automations can trigger on business events, not just CRON/webhook. Fail-closed: the
  // bridge only starts when a webhook base URL, a shared secret, an event allow-list, AND the
  // entity_type streams to watch are ALL set (empty anything -> bridge disabled).
  n8nBridge: {
    webhookBaseUrl: process.env.N8N_WEBHOOK_BASE_URL ?? "",
    secret: process.env.N8N_BRIDGE_SECRET ?? "",
    // Event types (event_type column) allowed to cross to n8n, e.g. "org_structure.updated".
    events: (process.env.N8N_BRIDGE_EVENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // Redis Streams to watch (keyed by entity_type), e.g. "deliverable,org_structure,client".
    entityTypes: (process.env.N8N_BRIDGE_ENTITY_TYPES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMs: Number(process.env.N8N_BRIDGE_TIMEOUT_MS ?? 5000),
  },
  // Event → knowledge-graph bridge (WS8 Step E live wire): forwards every business event on the
  // watched entity_type streams to the WS8 knowledge service's /graph/ingest, which turns each into
  // source-of-truth graph nodes/edges (D9.2). Reuses services.knowledge.{url,token}. Fail-closed:
  // starts only when the knowledge URL+token AND an entity-type list are all set.
  graphBridge: {
    entityTypes: (process.env.GRAPH_BRIDGE_ENTITY_TYPES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMs: Number(process.env.GRAPH_BRIDGE_TIMEOUT_MS ?? 5000),
  },
};

/** The bridge is fully configured (all four knobs present) and may start. */
export function n8nBridgeEnabled(): boolean {
  const b = config.n8nBridge;
  return !!(b.webhookBaseUrl && b.secret && b.events.length && b.entityTypes.length);
}

/** The graph bridge may start: a reachable knowledge service + at least one entity stream to watch. */
export function graphBridgeEnabled(): boolean {
  return !!(config.services.knowledge.url && config.services.knowledge.token && config.graphBridge.entityTypes.length);
}
