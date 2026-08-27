// WSK-37 — env config for per-tenant outbound webhooks. Same live-getter discipline as
// ../config.ts / ../events/events.config.ts (see either file's own header): every field reads
// `process.env` at CALL time, never at module-import time, because ESM import hoisting can race a
// test's own `process.env.X = ...` assignment against this module's evaluation otherwise.
//
// None of these vars exist in ../../.env.example yet (WSK-01's file, out of this ticket's owned
// scope — reported as a required addition in webdesk/api/README.md's WSK-37 section, same posture
// every prior ticket that needed a new var took: WSK-05 for API_KEY_PEPPER, WSK-12 for the
// WEBDESK_ZONEB_* block).
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function requireInProd(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[webdesk:tenant-webhooks] ${name} is not set — refusing to boot in production.`);
  }
  return devFallback;
}

export const tenantWebhooksConfig = {
  /** sha256(secret + pepper) at rest — the SAME pattern as api_keys.key_hash (§04), but a
   *  DELIBERATELY SEPARATE pepper from API_KEY_PEPPER: a webhook secret and an ingest API key are
   *  different trust domains (one authenticates the client's own server reading OUR outbound
   *  calls; the other authenticates a caller writing INTO Zone B) and must not share key material
   *  — a pepper leak on one path must not silently weaken the other. */
  get secretPepper(): string {
    return requireInProd("TENANT_WEBHOOK_SECRET_PEPPER", "dev-only-insecure-webhook-pepper-do-not-use-in-prod");
  },

  get queueName(): string {
    return process.env.TENANT_WEBHOOK_QUEUE_NAME || "tenant-webhook-delivery";
  },

  /** BullMQ `attempts` — the retry ceiling, mirroring mail.config.ts's own `maxAttempts` shape. */
  get maxAttempts(): number {
    return num("TENANT_WEBHOOK_MAX_ATTEMPTS", 5);
  },
  /** BullMQ exponential `backoff.delay` base, ms. */
  get backoffDelayMs(): number {
    return num("TENANT_WEBHOOK_BACKOFF_DELAY_MS", 1_000);
  },

  /** Per-attempt HTTP request timeout, ms — a slow/hanging client endpoint must not pin a worker
   *  slot forever (part of the SSRF/egress hardening this ticket's report calls out: an internal
   *  service that accepts-but-never-responds is itself a resource-exhaustion vector). */
  get requestTimeoutMs(): number {
    return num("TENANT_WEBHOOK_REQUEST_TIMEOUT_MS", 5_000);
  },

  /** How many redirect hops `dispatch()` will follow, each one independently re-validated by the
   *  SSRF guard (ssrf-guard.ts's own header explains why a redirect target needs the FULL check
   *  again, not just the original URL). 0 disables redirect-following entirely. */
  get maxRedirects(): number {
    return num("TENANT_WEBHOOK_MAX_REDIRECTS", 2);
  },

  /** Serialized JSON body size cap, bytes — bounds what a single delivery can push at a client
   *  endpoint (and, symmetrically, what we are willing to hold in memory to send). */
  get maxPayloadBytes(): number {
    return num("TENANT_WEBHOOK_MAX_PAYLOAD_BYTES", 64 * 1024);
  },
};
