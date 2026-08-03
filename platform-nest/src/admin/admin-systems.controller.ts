// Phase C: Systems/Intelligence admin console aggregator. Read-only. The platform proxies
// each downstream service's own surface (mostly its open GET /health) and reshapes it into
// the UI's SystemStatus/ConfigField contract (platform-ui/src/lib/admin.ts). It NEVER
// fabricates data: an unreachable or not-configured system reports ok:false with a reason,
// and extra reads that a service doesn't expose degrade to an empty list.
//
// Access is platform-global admin (platform_admin) or owner (group_executive) — checked in
// code (these are not tenant resources). Non-admins get 403, which the UI absorbs gracefully.
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { authorize } from "../core/http";
import { AuthGuard } from "../auth/guards";
import { isElevated } from "./elevated";
import { getBridgeHealth, replayBridgeDeadLetters, type BridgeHealth } from "../events/bridge-health";
import { allModules } from "../modules/registry";

type SystemKey = "bot" | "gateway" | "hub" | "agents" | "knowledge" | "automation";
const SYSTEMS: SystemKey[] = ["bot", "gateway", "hub", "agents", "knowledge", "automation"];

/** One downstream service's build identity, as IT reports it. `version: null` means the service
 *  is reachable but exposes no version field — distinct from unreachable, which the UI renders
 *  differently. Never inferred from the platform's own APP_VERSION. */
export interface AboutService {
  key: SystemKey;
  reachable: boolean;
  version: string | null;
  note: string | null;
}

export interface AboutInfo {
  app: { version: string; originSite: string; node: string; modules: string[] };
  services: AboutService[];
}

interface SystemStatus {
  ok: boolean;
  version?: string;
  uptimeSec?: number;
  counters?: Record<string, number | string>;
  detail?: Record<string, unknown>;
}
interface ConfigField {
  key: string;
  label: string;
  value: unknown;
  kind: "text" | "number" | "boolean" | "select" | "secretPresence";
  options?: string[];
  // Value/label pairs for a select whose raw value isn't fit for display (e.g. the bot's
  // management-group JID) — mirrors platform-ui's Field component's own options/optionItems
  // split. Purely additive: every existing "select" projection keeps using `options` untouched.
  optionItems?: Array<{ value: string; label: string }>;
  editable: boolean;
}

// ---- Downstream detail shapes -------------------------------------------------------------
// Structural mirrors of the services' own admin payloads (ai-gateway-go GET /admin/config,
// mcp-hub GET /admin/info). Kept as local mirrors per this repo's "separate standalone projects"
// convention. Everything is optional: these cross a service boundary, and a partially-populated
// payload from an older build must degrade a card, never throw the request.
interface ChainReport {
  order?: string[];
  providers?: Array<{
    name: string;
    position: number;
    state: string;
    available: boolean;
    consecutiveFails?: number;
    rateLimited?: boolean;
    openUntil?: string;
  }>;
}

interface GatewayDetail {
  chains?: { llm?: ChainReport; media?: ChainReport; embed?: ChainReport };
  providers?: Array<{
    name: string;
    model?: string;
    endpoint?: string;
    keyRequired: boolean;
    keyConfigured: boolean;
    siteExcluded?: boolean;
  }>;
  budget?: {
    day?: string;
    used?: number;
    cap?: number;
    effectiveCap?: number;
    perTenantCap?: number;
    tenants?: Record<string, number>;
    drActive?: boolean;
    drBurstCap?: number;
    drUntil?: string;
  };
  reliability?: { breakerThreshold?: number; breakerCooldownMs?: number; providerTimeoutMs?: number };
  security?: {
    tlsMode?: string;
    egressAllowlist?: string[];
    dlpClassifierEnabled?: boolean;
    dlpClassifierModel?: string;
    classifierReachable?: boolean;
    auditFile?: string;
  };
  topology?: {
    mode?: string;
    centralConfigured?: boolean;
    drBurstCap?: number;
    drDurationMinutes?: number;
    mediaMaxBytes?: number;
  };
  /** Keys this gateway build accepts on PUT /admin/config. Empty (or absent, on an older build)
   *  means writes aren't wired, so the console must render everything read-only rather than offer a
   *  save that 404s. This is the gateway's allowlist — never duplicated or widened here. */
  writableKeys?: string[];
  /** Which values are console overrides shadowing the env, so the console can say so. */
  overriddenKeys?: Record<string, boolean>;
}

interface HubDetail {
  policy?: {
    engine?: string;
    cerbosConfigured?: boolean;
    denyByDefault?: boolean;
    assuranceRanks?: string[];
    automationWriteGate?: string;
    revocationCheck?: boolean;
    revocationTtlMs?: number;
  };
  rateLimit?: {
    perPrincipalPerMin?: number;
    perPrincipalBurst?: number;
    perServiceTokenPerMin?: number;
    perServiceTokenBurst?: number;
  };
  transport?: { tlsMode?: string; peerAllowlist?: string[]; topology?: string; serviceAuthConfigured?: boolean };
  tools?: { total?: number; bySource?: Record<string, number> };
  resources?: Array<{ uriTemplate: string; name: string; description: string; mimeType: string }>;
  prompts?: Array<{ name: string; description: string; arguments: Array<{ name: string; description: string; required: boolean }> }>;
  workflowScopes?: Array<{ workflow: string; tools: string[] }>;
  upstreams?: Record<string, boolean>;
}

// The n8n workflow VIEWER (read-only canvas in the IT section) is reachable by IT staff too,
// not just platform admins. Any it_admin/it_manager/it grant (any scope) qualifies.
function isItOrElevated(req: FastifyRequest): boolean {
  return (
    isElevated(req) ||
    req.principal.roles.some((r) => r.role === "it_admin" || r.role === "it_manager" || r.role === "it")
  );
}

/** GET with a hard timeout; returns parsed JSON or throws. */
async function getJson(url: string, token?: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** GET the n8n Public API with the configured API key; throws on non-2xx. */
async function getN8n(base: string, apiKey: string, path: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: ac.signal, headers: { "X-N8N-API-KEY": apiKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** POST to the n8n Public API with the configured API key; throws on non-2xx. n8n's activate/
 *  deactivate routes take no body. */
async function postN8n(base: string, apiKey: string, path: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      signal: ac.signal,
      headers: { "X-N8N-API-KEY": apiKey },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `HTTP ${res.status}`);
    }
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

/** Reshape one system's /health payload into SystemStatus; fail-soft on unreachable. */
async function probeStatus(system: SystemKey): Promise<SystemStatus> {
  const svc = config.services[system];
  if (!svc?.url) return { ok: false, detail: { note: "not configured (no service URL set on the platform)" } };
  const base = svc.url.replace(/\/$/, "");
  // n8n exposes /healthz (plain text 200); everyone else exposes JSON /health.
  const healthPath = system === "automation" ? "/healthz" : "/health";
  try {
    if (system === "automation") {
      await getJson(`${base}${healthPath}`).catch(async () => {
        // /healthz returns non-JSON "OK"; a non-throwing fetch is enough to prove liveness.
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
        try {
          const r = await fetch(`${base}${healthPath}`, { signal: ac.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } finally {
          clearTimeout(t);
        }
      });
      // With a Public-API key we can list real workflows; without one the UI still degrades.
      const workflows = await listN8nWorkflows(base, config.services.automation.token);
      // `url` is the in-cluster base this probe just used; `n8nUrl` is what the UI turns into an
      // "Open in n8n" link, so it MUST be the browser-reachable origin. They were the same value,
      // which made the button point at http://n8n:5678 — unreachable from any browser. Omitted
      // when unset so the UI hides the button instead of rendering a dead link.
      return {
        ok: true,
        counters: { workflows: workflows.length },
        detail: { url: base, n8nUrl: config.automationPublicUrl || undefined, workflows },
      };
    }
    const h = (await getJson(`${base}${healthPath}`)) as Record<string, unknown>;
    if (system === "bot") {
      // A4: bot's own /health carries a session status string; if it's missing (older bot
      // build) fall back to the ADMIN_TOKEN-gated session/status route. Fail-soft either way —
      // never let a broken session lookup fail the whole status probe.
      // "unknown" is the bot's placeholder for "no session event observed yet", NOT a status —
      // treat it as missing so the fallback below asks WAHA (via the bot) for the real one.
      let session = typeof h.session === "string" && h.session !== "unknown" ? h.session : undefined;
      if (!session && svc.token) {
        try {
          const s = (await getJson(`${base}/admin/session/status`, svc.token)) as { status?: string };
          if (typeof s.status === "string") session = s.status;
        } catch {
          /* leave undefined -> "unknown" below */
        }
      }
      return { ok: h.ok === true, detail: { ai: h.ai, session: session ?? "unknown" } };
    }
    return shapeHealth(system, h);
  } catch (e) {
    return { ok: false, detail: { error: (e as Error).message, url: base } };
  }
}

interface WorkflowRow {
  name: string;
  status: string;
  lastRun: string | null;
}

/** List n8n workflows via its Public API (needs an API key), each annotated with its most
 *  recent execution's status/time. Fail-soft: no key or unreachable API -> [] (UI degrades). */
async function listN8nWorkflows(base: string, apiKey: string): Promise<WorkflowRow[]> {
  if (!apiKey) return [];
  const key = (url: string) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
    return fetch(url, { signal: ac.signal, headers: { "X-N8N-API-KEY": apiKey } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .finally(() => clearTimeout(timer));
  };
  try {
    const [wfRes, exRes] = await Promise.all([
      key(`${base}/api/v1/workflows`) as Promise<{ data?: Array<{ id: string; name: string; active: boolean }> }>,
      key(`${base}/api/v1/executions?limit=100`).catch(() => ({ data: [] })) as Promise<{
        data?: Array<{ workflowId: string; status?: string; finished?: boolean; stoppedAt?: string; startedAt?: string }>;
      }>,
    ]);
    // Most-recent execution per workflow (executions come newest-first).
    const latest = new Map<string, { status?: string; finished?: boolean; stoppedAt?: string; startedAt?: string }>();
    for (const e of exRes.data ?? []) if (!latest.has(e.workflowId)) latest.set(e.workflowId, e);
    return (wfRes.data ?? []).map((w) => {
      const e = latest.get(w.id);
      const runStatus = e ? (e.status ?? (e.finished ? "success" : "running")) : "never run";
      return {
        name: w.name,
        status: w.active ? runStatus : "inactive",
        lastRun: e?.stoppedAt ?? e?.startedAt ?? null,
      };
    });
  } catch {
    return [];
  }
}

function shapeHealth(system: SystemKey, h: Record<string, unknown>): SystemStatus {
  const ok = h.ok === true;
  switch (system) {
    case "gateway":
      return {
        ok,
        counters: typeof h.budget === "object" && h.budget ? flatten(h.budget as Record<string, unknown>) : undefined,
        detail: { providers: h.providers, budget: h.budget, classifierReachable: h.classifierReachable },
      };
    case "hub": {
      const tools = Array.isArray(h.tools) ? (h.tools as string[]) : [];
      return { ok, counters: { tools: tools.length }, detail: { tools } };
    }
    // B3: the runner's own /health ({ok, agents, writeAgents, queue:{queued,running}}).
    // `detail.agents` is what the UI's agentOptions() reads to populate the trigger select.
    case "agents": {
      const queue = (h.queue ?? {}) as { queued?: number; running?: number };
      return {
        ok,
        counters: { queued: queue.queued ?? 0, running: queue.running ?? 0 },
        detail: { agents: h.agents, writeAgents: h.writeAgents },
      };
    }
    // "bot" is handled inline in probeStatus (session enrichment) and never reaches here.
    case "knowledge":
      return { ok };
    default:
      return { ok, detail: h };
  }
}

/** One level of number/string counters out of a nested object (best-effort). */
function flatten(obj: Record<string, unknown>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" || typeof v === "string") out[k] = v;
  }
  return out;
}

// Bot config fields don't come with a UI label (the bot's shape is {key,value,editable,type});
// fill in a friendly label per known key, falling back to the raw key for anything new.
const BOT_FIELD_LABELS: Record<string, string> = {
  wahaSession: "WAHA session name",
  botName: "Bot display name",
  postToGroups: "Post digests to groups",
  managementGroupId: "Management group",
  monitoredCount: "Monitored groups",
};

function mapBotConfigField(f: {
  key: string;
  value: unknown;
  editable: boolean;
  type: "text" | "bool" | "number" | "select";
  optionItems?: Array<{ value: string; label: string }>;
}): ConfigField {
  return {
    key: f.key,
    label: BOT_FIELD_LABELS[f.key] ?? f.key,
    value: f.value,
    kind: f.type === "bool" ? "boolean" : f.type,
    editable: f.editable,
    ...(f.optionItems ? { optionItems: f.optionItems } : {}),
  };
}

// ---- Real config projections (the console's "Configuration" card) -------------------------
// Previously every non-bot system reported only {url, tokenConfigured}, so three consoles showed a
// two-row descriptor and nothing else. These project the service's OWN admin surface into the same
// ConfigField[] contract. Secrets are always kind:"secretPresence" (presence only, never a value),
// and every projection is fail-soft: an unreachable service falls back to the honest descriptor.

function field(
  key: string,
  label: string,
  value: unknown,
  kind: ConfigField["kind"] = "text",
  editable = false,
): ConfigField {
  return { key, label, value, kind, editable };
}

/** Project the gateway's GET /admin/config into ConfigField[].
 *
 *  `editable` is driven by the gateway's OWN `writableKeys` allowlist, so this layer can never offer
 *  a save the gateway would refuse — and an older gateway without the write route yields a fully
 *  read-only page automatically. A secretPresence field is never editable regardless. */
function gatewayConfigFields(d: GatewayDetail): ConfigField[] {
  const sec = d.security ?? {};
  const top = d.topology ?? {};
  const rel = d.reliability ?? {};
  const writable = new Set(d.writableKeys ?? []);
  const w = (key: string) => writable.has(key);
  return [
    // `providers` is the chain order the gateway page renders as an ordered list — the key the UI
    // has always looked for, which nothing previously emitted. It is written under the gateway's own
    // key name `llmChain`, so the editable twin is emitted separately below.
    field("providers", "LLM failover chain", d.chains?.llm?.order ?? []),
    field("llmChain", "LLM failover chain (order)", (d.chains?.llm?.order ?? []).join(", "), "text", w("llmChain")),
    field("mediaChain", "Media failover chain", (d.chains?.media?.order ?? []).join(", "), "text", w("mediaChain")),
    field("embedChain", "Embedding failover chain", (d.chains?.embed?.order ?? []).join(", "), "text", w("embedChain")),
    field("dailyCallCap", "Daily call cap (global)", d.budget?.cap ?? "—", "number", w("dailyCallCap")),
    field("perTenantDailyCallCap", "Daily call cap (per tenant)", d.budget?.perTenantCap ?? "—", "number", w("perTenantDailyCallCap")),
    field("breakerThreshold", "Circuit-breaker threshold", rel.breakerThreshold ?? "—", "number", w("breakerThreshold")),
    field("breakerCooldownMs", "Circuit-breaker cooldown (ms)", rel.breakerCooldownMs ?? "—", "number", w("breakerCooldownMs")),
    field("providerTimeoutMs", "Per-provider timeout (ms)", rel.providerTimeoutMs ?? "—", "number", w("providerTimeoutMs")),
    field("dlpClassifierEnabled", "Model-assisted DLP classifier", !!sec.dlpClassifierEnabled, "boolean", w("dlpClassifierEnabled")),
    field("dlpClassifierModel", "DLP classifier model", sec.dlpClassifierModel ?? "—"),
    // Security boundary + topology are env+restart only — a console session must not be able to
    // widen the service's own boundary (see the gateway's adminconfig package comment).
    field("tlsMode", "Internal TLS mode", sec.tlsMode ?? "—"),
    field("egressAllowlist", "Egress allowlist", (sec.egressAllowlist ?? []).join(", ") || "(none — unrestricted)"),
    field("topologyMode", "Topology", top.mode ?? "—"),
    field("centralConfigured", "Central gateway configured", !!top.centralConfigured, "secretPresence"),
    field("drBurstCap", "DR burst allowance (calls)", top.drBurstCap ?? "—", "number"),
    field("drDurationMinutes", "DR window (minutes)", top.drDurationMinutes ?? "—", "number"),
  ];
}

/** Project the hub's GET /admin/info into ConfigField[]. */
function hubConfigFields(d: HubDetail): ConfigField[] {
  const p = d.policy ?? {};
  const r = d.rateLimit ?? {};
  const t = d.transport ?? {};
  return [
    field("policyEngine", "Authorization engine", p.engine ?? "—"),
    field("denyByDefault", "Deny by default", p.denyByDefault !== false, "boolean"),
    // The rule that decides whether an unattended automation write runs or suspends (§3 / D14).
    field("automationWriteGate", "Automation write gate", p.automationWriteGate ?? "—"),
    field("revocationCheck", "D11 revocation check", !!p.revocationCheck, "boolean"),
    field("rateLimitPerMin", "Rate limit — per principal (calls/min)", r.perPrincipalPerMin ?? "—", "number"),
    field("rateLimitBurst", "Rate limit — per principal (burst)", r.perPrincipalBurst ?? "—", "number"),
    field("rateLimitTokenPerMin", "Rate limit — per service token (calls/min)", r.perServiceTokenPerMin ?? "—", "number"),
    field("tlsMode", "mTLS mode", t.tlsMode ?? "—"),
    field("peerAllowlist", "mTLS peer allowlist", (t.peerAllowlist ?? []).join(", ") || "(none)"),
    field("topology", "Topology", t.topology ?? "—"),
    field("serviceAuthConfigured", "Service token configured", !!t.serviceAuthConfigured, "secretPresence"),
  ];
}

/** Project the n8n/bridge posture into ConfigField[]. */
function automationConfigFields(base: string, apiKey: string, bridge: BridgeHealth): ConfigField[] {
  return [
    // Both, labelled: they are different values for different callers and conflating them is
    // exactly how the "Open in n8n" button ended up pointing into the compose network.
    field("n8nUrl", "n8n URL (in-cluster, used by the platform)", base || "(not set)"),
    field("n8nPublicUrl", "n8n editor URL (browser)", config.automationPublicUrl || "(not set)"),
    field("apiKeyConfigured", "Public-API key configured", !!apiKey, "secretPresence"),
    field("bridgeEnabled", "Event bridge enabled", bridge.enabled, "boolean"),
    field("bridgeWebhook", "Bridge webhook configured", bridge.webhookConfigured, "secretPresence"),
    field("bridgeSecret", "Bridge shared secret configured", bridge.secretConfigured, "secretPresence"),
    field("bridgeEvents", "Bridged event types", bridge.events.join(", ") || "(none)"),
    field("bridgeMaxRetries", "Dead-letter after N retries", bridge.maxRetries, "number"),
    field("bridgeTimeoutMs", "Webhook timeout (ms)", bridge.timeoutMs, "number"),
  ];
}

/** Read-only connection descriptor per system — what the PLATFORM knows, honestly, UNLESS the
 *  system is "bot" and reachable: then (A4) proxy the bot's own GET /admin/config fields, which
 *  is what makes the /systems/bot ConfigField save flow light up with real editable:true fields.
 *  Falls back to the honest url/tokenConfigured descriptor when the bot isn't configured or
 *  isn't reachable (fail-soft, never fabricated). */
async function connectionConfig(system: SystemKey): Promise<ConfigField[]> {
  if (system === "bot") {
    const svc = config.services.bot;
    if (svc?.url && svc.token) {
      try {
        const res = (await getJson(`${svc.url.replace(/\/$/, "")}/admin/config`, svc.token)) as {
          fields?: Array<{
            key: string;
            value: unknown;
            editable: boolean;
            type: "text" | "bool" | "number" | "select";
            optionItems?: Array<{ value: string; label: string }>;
          }>;
        };
        if (Array.isArray(res.fields)) return res.fields.map(mapBotConfigField);
      } catch {
        /* fall through to the honest read-only descriptor below */
      }
    }
  }
  // Gateway/hub: project the service's OWN admin surface. Fail-soft — an unreachable or older
  // service (no such route) falls through to the honest connection descriptor below.
  if (system === "gateway") {
    const d = await fetchGatewayDetail();
    if (d) return [...gatewayConfigFields(d), ...connectionDescriptor(system)];
  }
  if (system === "hub") {
    const d = await fetchHubDetail();
    if (d) return [...hubConfigFields(d), ...connectionDescriptor(system)];
  }
  if (system === "automation") {
    const svc = config.services.automation;
    return automationConfigFields(svc?.url ?? "", svc?.token ?? "", await getBridgeHealth());
  }
  return connectionDescriptor(system);
}

/** The honest "what the platform knows" fallback: where the service is and whether we hold a
 *  credential for it. Always appended, so a projection never hides an unreachable/unset URL. */
function connectionDescriptor(system: SystemKey): ConfigField[] {
  const svc = config.services[system];
  const tokenLabel = system === "automation" ? "Public-API key configured" : "Auth token configured";
  return [
    field("url", "Service URL", svc?.url || "(not set)"),
    field("tokenConfigured", tokenLabel, !!svc?.token, "secretPresence"),
  ];
}

/** GET the gateway's own admin config. null when not configured/unreachable/older build. */
async function fetchGatewayDetail(): Promise<GatewayDetail | null> {
  const svc = config.services.gateway;
  if (!svc?.url) return null;
  try {
    return (await getJson(`${svc.url.replace(/\/$/, "")}/admin/config`, svc.token)) as GatewayDetail;
  } catch {
    return null;
  }
}

/** Proxy one config write/revert to the gateway, preserving its status code + message.
 *
 *  A 4xx from the gateway is a VALIDATION result the operator needs to read, so it is re-thrown as
 *  the equivalent HTTP error rather than collapsed into "gateway unreachable" — that distinction is
 *  the difference between "your value is out of range" and "the service is down". */
async function gatewayConfigWrite(
  method: "PUT" | "DELETE",
  body: { key: string; value?: unknown },
): Promise<{ ok: boolean; key: string; applied?: unknown }> {
  const svc = config.services.gateway;
  if (!svc?.url) throw new NotFoundException("gateway not configured");
  const base = svc.url.replace(/\/$/, "");
  const url =
    method === "DELETE" ? `${base}/admin/config?key=${encodeURIComponent(body.key)}` : `${base}/admin/config`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ac.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${svc.token}` },
      ...(method === "PUT" ? { body: JSON.stringify({ key: body.key, value: body.value }) } : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    if (!res.ok) {
      const msg = parsed.error ?? `gateway responded ${res.status}`;
      // 404/405 = this gateway build has no write route at all → surface as not-found so the UI's
      // existing "saving isn't available yet" path fires instead of showing a scary error.
      if (res.status === 404 || res.status === 405) throw new NotFoundException(msg);
      if (res.status === 409) throw new ConflictException(msg);
      if (res.status >= 400 && res.status < 500) throw new BadRequestException(msg);
      throw new ServiceUnavailableException(msg);
    }
    return parsed as { ok: boolean; key: string; applied?: unknown };
  } catch (e) {
    if (e instanceof HttpException) throw e;
    throw new ServiceUnavailableException(`gateway config write failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** GET the hub's own posture block. null when not configured/unreachable/older build. */
async function fetchHubDetail(): Promise<HubDetail | null> {
  const svc = config.services.hub;
  if (!svc?.url) return null;
  try {
    return (await getJson(`${svc.url.replace(/\/$/, "")}/admin/info`, svc.token)) as HubDetail;
  } catch {
    return null;
  }
}

@Controller("api/admin")
@UseGuards(AuthGuard)
export class AdminSystemsController {
  // ---- Software information (docs/modules/VERSIONING.md) ----
  // "What is actually running here?" Declared before :system/status only for readability — the
  // paths differ in segment count, so there is no route ambiguity.
  //
  // The app version is NOT computed here: /VERSION is the single source, deploy.yml validates the
  // git tag against it and passes it as APP_VERSION. This endpoint only REPORTS what the running
  // process was given. Rule 5 of the doc ("if they disagree, the running app is wrong") is why
  // each service's self-reported version is returned verbatim rather than being reconciled — the
  // UI shows the disagreement instead of hiding it. A service that reports nothing is "unknown",
  // never backfilled from the platform's own value.
  @Get("about")
  async about(@Req() req: FastifyRequest): Promise<AboutInfo> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const services = await Promise.all(
      SYSTEMS.map(async (key): Promise<AboutService> => {
        const svc = config.services[key];
        if (!svc?.url) return { key, reachable: false, version: null, note: "not configured" };
        const base = svc.url.replace(/\/$/, "");
        try {
          const h = (await getJson(`${base}${key === "automation" ? "/healthz" : "/health"}`, svc.token)) as
            | Record<string, unknown>
            | null;
          const v = h && typeof h.version === "string" ? h.version.trim() : "";
          return { key, reachable: true, version: v || null, note: v ? null : "does not report a version" };
        } catch (e) {
          return { key, reachable: false, version: null, note: (e as Error).message };
        }
      }),
    );
    return {
      app: {
        version: process.env.APP_VERSION?.trim() || "unknown",
        originSite: config.originSite,
        node: process.version,
        modules: allModules().map((m) => m.key),
      },
      services,
    };
  }

  @Get(":system/status")
  async status(@Req() req: FastifyRequest, @Param("system") system: string): Promise<SystemStatus> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    if (!SYSTEMS.includes(system as SystemKey)) throw new ForbiddenException("unknown system");
    return probeStatus(system as SystemKey);
  }

  @Get(":system/config")
  async config(@Req() req: FastifyRequest, @Param("system") system: string): Promise<{ fields: ConfigField[] }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    if (!SYSTEMS.includes(system as SystemKey)) throw new ForbiddenException("unknown system");
    return { fields: await connectionConfig(system as SystemKey) };
  }

  // ---- Extra reads (optional per surface; degrade to [] when the service lacks the route) ----
  // Filterable egress audit. The gateway's `blocked` taxonomy (auth/budget/dlp/rate_limit/
  // timeout/provider_error) is the whole diagnostic value of this trail, so it is carried through
  // as a structured field instead of being flattened into the free-text detail string. The legacy
  // {time, provider, decision, detail} fields are kept so older UI builds keep rendering.
  @Get("gateway/egress-audit")
  async egressAudit(
    @Req() req: FastifyRequest,
    @Query("limit") limit?: string,
    @Query("provider") provider?: string,
    @Query("capability") capability?: string,
    @Query("decision") decision?: string,
  ) {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const svc = config.services.gateway;
    if (!svc.url) return [];
    const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    try {
      const rows = (await getJson(`${svc.url.replace(/\/$/, "")}/egress-audit?limit=${n}`, svc.token)) as Array<{
        ts?: number; capability?: string; provider?: string | null; ok?: boolean; blocked?: string; redactions?: number; latencyMs?: number;
      }>;
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => !provider || (r.provider ?? "") === provider)
        .filter((r) => !capability || r.capability === capability)
        .filter((r) => {
          if (!decision) return true;
          if (decision === "allow") return r.ok === true;
          if (decision === "blocked") return r.ok !== true;
          // Anything else is treated as a specific block reason ("dlp", "budget", …).
          return r.blocked === decision;
        })
        .map((r) => ({
          time: r.ts ? new Date(r.ts).toISOString() : "",
          provider: r.provider ?? undefined,
          decision: r.ok ? "allow" : r.blocked ? `blocked:${r.blocked}` : "deny",
          detail: [r.capability, r.latencyMs ? `${r.latencyMs}ms` : "", r.redactions ? `redactions=${r.redactions}` : ""]
            .filter(Boolean)
            .join(" "),
          capability: r.capability ?? null,
          ok: r.ok === true,
          blocked: r.blocked ?? null,
          redactions: r.redactions ?? 0,
          latencyMs: r.latencyMs ?? null,
        }));
    } catch {
      return []; // graceful empty (UI shows "no audit")
    }
  }

  /** Structured gateway detail: chain order + live breaker state, per-tenant budget spend, and
   *  the security/topology posture. null when the gateway is unreachable (the UI degrades). */
  @Get("gateway/detail")
  async gatewayDetail(@Req() req: FastifyRequest): Promise<GatewayDetail | null> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    return fetchGatewayDetail();
  }

  /** WS9 D15 — declare or resolve a failover, (un)locking the bounded DR-burst AI budget.
   *  This is a real blast-radius lever (it raises the daily cap), so it is platform-admin only and
   *  proxied rather than exposed: the gateway token never reaches the browser. */
  @Post("gateway/dr-mode")
  async setDrMode(
    @Req() req: FastifyRequest,
    @Body() body: { enable?: boolean; durationMinutes?: number },
  ): Promise<{ drMode: boolean; budget?: unknown }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const svc = config.services.gateway;
    if (!svc?.url) throw new NotFoundException("gateway not configured");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
    try {
      const res = await fetch(`${svc.url.replace(/\/$/, "")}/admin/dr-mode`, {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${svc.token}` },
        body: JSON.stringify({
          enable: body?.enable === true,
          ...(body?.durationMinutes ? { durationMinutes: Number(body.durationMinutes) } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { drMode: boolean; budget?: unknown };
    } catch (e) {
      throw new ServiceUnavailableException(`gateway dr-mode failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Write one gateway config key. The gateway validates + bounds-checks + persists; this proxies so
   *  the gateway token never reaches the browser, and surfaces the gateway's own message verbatim so
   *  a rejected value explains itself ("dailyCallCap must be between 1 and 10000000") instead of
   *  becoming a generic 502. Only the gateway's allowlisted keys are writable — that list is the
   *  gateway's to enforce, not something this layer should duplicate and let drift. */
  @Put("gateway/config")
  async putGatewayConfig(
    @Req() req: FastifyRequest,
    @Body() body: { key?: string; value?: unknown },
  ): Promise<{ ok: boolean; key: string; applied?: unknown }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key) throw new BadRequestException("key required");
    return gatewayConfigWrite("PUT", { key, value: body?.value });
  }

  /** Drop a gateway config override, reverting that key to its env value (live, not restart-deferred).
   *  Without this a console write is permanently sticky: the override file keeps shadowing the env
   *  even after the env is corrected. */
  @Delete("gateway/config")
  async deleteGatewayConfig(
    @Req() req: FastifyRequest,
    @Query("key") key?: string,
  ): Promise<{ ok: boolean; key: string }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const k = (key ?? "").trim();
    if (!k) throw new BadRequestException("key required");
    return gatewayConfigWrite("DELETE", { key: k });
  }

  /** Structured hub posture: policy engine, limits, transport, primitives, workflow scopes. */
  @Get("hub/detail")
  async hubDetail(@Req() req: FastifyRequest): Promise<HubDetail | null> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    return fetchHubDetail();
  }

  /** The hub's tool-call decision audit — who called what, allowed or denied, and why. */
  @Get("hub/audit")
  async hubAudit(@Req() req: FastifyRequest, @Query("limit") limit?: string) {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const svc = config.services.hub;
    if (!svc?.url) return [];
    const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    try {
      const rows = (await getJson(`${svc.url.replace(/\/$/, "")}/audit?limit=${n}`, svc.token)) as unknown;
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  /** Recent n8n executions across all workflows, newest-first — the run history the workflow
   *  list only ever summarized as one "last run" cell. */
  @Get("automation/executions")
  async executions(@Req() req: FastifyRequest, @Query("limit") limit?: string) {
    if (!isItOrElevated(req)) throw new ForbiddenException("IT or platform admin required");
    const svc = config.services.automation;
    if (!svc.url || !svc.token) return [];
    const n = Math.min(Math.max(Number(limit) || 50, 1), 250);
    const base = svc.url.replace(/\/$/, "");
    try {
      const [exRes, wfRes] = await Promise.all([
        getN8n(base, svc.token, `/api/v1/executions?limit=${n}`) as Promise<{
          data?: Array<{ id: string | number; workflowId: string; status?: string; finished?: boolean; mode?: string; startedAt?: string; stoppedAt?: string }>;
        }>,
        getN8n(base, svc.token, `/api/v1/workflows`).catch(() => ({ data: [] })) as Promise<{
          data?: Array<{ id: string; name: string }>;
        }>,
      ]);
      // n8n returns workflowId only; resolve names so the console isn't a wall of opaque ids.
      const names = new Map((wfRes.data ?? []).map((w) => [String(w.id), w.name]));
      return (exRes.data ?? []).map((e) => {
        const started = e.startedAt ? Date.parse(e.startedAt) : NaN;
        const stopped = e.stoppedAt ? Date.parse(e.stoppedAt) : NaN;
        return {
          id: String(e.id),
          workflowId: String(e.workflowId),
          workflowName: names.get(String(e.workflowId)) ?? String(e.workflowId),
          status: e.status ?? (e.finished ? "success" : "running"),
          mode: e.mode ?? null,
          startedAt: e.startedAt ?? null,
          stoppedAt: e.stoppedAt ?? null,
          durationMs: Number.isFinite(started) && Number.isFinite(stopped) ? stopped - started : null,
        };
      });
    } catch {
      return [];
    }
  }

  /** Event → n8n bridge delivery health: backlog, dead-letters and the bridged event allow-list.
   *  A stalled bridge silently stops every event-triggered workflow; this makes that visible. */
  @Get("automation/bridge")
  async bridge(@Req() req: FastifyRequest): Promise<BridgeHealth> {
    if (!isItOrElevated(req)) throw new ForbiddenException("IT or platform admin required");
    return getBridgeHealth();
  }

  /** Activate or deactivate an n8n workflow.
   *
   *  This is **platform-admin/owner only, NOT IT** — unlike the read-only viewer. Deactivating a
   *  workflow silently stops business automation (SLA chasing, client seeding) with no other signal,
   *  so it is a narrower gate than viewing the canvas. */
  @Post("automation/workflows/:workflowId/:action")
  async setWorkflowActive(
    @Req() req: FastifyRequest,
    @Param("workflowId") workflowId: string,
    @Param("action") action: string,
  ): Promise<{ id: string; active: boolean }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    if (action !== "activate" && action !== "deactivate") throw new BadRequestException("unknown action");
    const svc = config.services.automation;
    if (!svc.url || !svc.token) throw new NotFoundException("automation not configured (no n8n Public-API key)");
    const base = svc.url.replace(/\/$/, "");
    try {
      const w = (await postN8n(base, svc.token, `/api/v1/workflows/${encodeURIComponent(workflowId)}/${action}`)) as {
        id?: string | number;
        active?: boolean;
      };
      // Report n8n's own resulting state rather than assuming the action's name took effect.
      return { id: String(w.id ?? workflowId), active: w.active ?? action === "activate" };
    } catch (e) {
      throw new ServiceUnavailableException(`n8n ${action} failed: ${(e as Error).message}`);
    }
  }

  /** Replay dead-lettered events for one bridge stream: move parked entries back onto the source
   *  stream so the bridge's consumer group redelivers them.
   *
   *  This is the real "retry a failed automation" lever. n8n's Public API has no execution-retry
   *  route (retry lives on its internal /rest surface, which needs a UI session), so re-delivering
   *  the triggering EVENT is both the honest and the more correct fix — it re-runs the workflow from
   *  its actual input rather than replaying a half-finished run. */
  @Post("automation/bridge/:entityType/replay")
  async replayDeadLetters(
    @Req() req: FastifyRequest,
    @Param("entityType") entityType: string,
    @Query("limit") limit?: string,
  ): Promise<{ entityType: string; replayed: number; remaining: number }> {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    if (!config.n8nBridge.entityTypes.includes(entityType)) {
      // Refuse an arbitrary stream name: this writes to Redis, so the target must be one the bridge
      // is actually configured to watch.
      throw new BadRequestException(`${entityType} is not a watched bridge stream`);
    }
    try {
      return await replayBridgeDeadLetters(entityType, n);
    } catch (e) {
      throw new ServiceUnavailableException(`replay failed: ${(e as Error).message}`);
    }
  }

  // ---- n8n workflow viewer (IT section, read-only canvas). Fail-soft to []/404. ----
  @Get("automation/workflows")
  async workflows(@Req() req: FastifyRequest) {
    if (!isItOrElevated(req)) throw new ForbiddenException("IT or platform admin required");
    const svc = config.services.automation;
    if (!svc.url || !svc.token) return []; // no n8n API key → UI degrades to empty
    const base = svc.url.replace(/\/$/, "");
    try {
      const res = (await getN8n(base, svc.token, `/api/v1/workflows`)) as {
        data?: Array<{ id: string; name: string; active: boolean; updatedAt?: string }>;
      };
      return (res.data ?? []).map((w) => ({ id: String(w.id), name: w.name, active: !!w.active, updatedAt: w.updatedAt ?? null }));
    } catch {
      return [];
    }
  }

  @Get("automation/workflows/:workflowId")
  async workflow(@Req() req: FastifyRequest, @Param("workflowId") workflowId: string) {
    if (!isItOrElevated(req)) throw new ForbiddenException("IT or platform admin required");
    const svc = config.services.automation;
    if (!svc.url || !svc.token) throw new NotFoundException("automation not configured");
    const base = svc.url.replace(/\/$/, "");
    let w: { id: string; name: string; active?: boolean; nodes?: unknown[]; connections?: Record<string, unknown> };
    try {
      w = (await getN8n(base, svc.token, `/api/v1/workflows/${encodeURIComponent(workflowId)}`)) as typeof w;
    } catch {
      throw new NotFoundException("workflow not found");
    }
    // Pass through only the subset the canvas needs (nodes positions + connections map).
    return { id: String(w.id), name: w.name, active: w.active, nodes: w.nodes ?? [], connections: w.connections ?? {} };
  }

  @Get("hub/tools")
  async hubTools(@Req() req: FastifyRequest) {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const svc = config.services.hub;
    if (!svc.url) return [];
    const base = svc.url.replace(/\/$/, "");
    // Prefer the full catalog endpoint; fall back to names-only from /health.
    try {
      const rows = (await getJson(`${base}/tools`, svc.token)) as unknown;
      if (Array.isArray(rows)) return rows;
    } catch {
      /* fall through */
    }
    try {
      const h = (await getJson(`${base}/health`)) as { tools?: unknown };
      const names = Array.isArray(h.tools) ? (h.tools as string[]) : [];
      return names.map((name) => ({ name, description: "", minAssurance: "" }));
    } catch {
      return [];
    }
  }
}
