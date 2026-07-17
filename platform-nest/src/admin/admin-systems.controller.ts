// Phase C: Systems/Intelligence admin console aggregator. Read-only. The platform proxies
// each downstream service's own surface (mostly its open GET /health) and reshapes it into
// the UI's SystemStatus/ConfigField contract (platform-ui/src/lib/admin.ts). It NEVER
// fabricates data: an unreachable or not-configured system reports ok:false with a reason,
// and extra reads that a service doesn't expose degrade to an empty list.
//
// Access is platform-global admin (platform_admin) or owner (group_executive) — checked in
// code (these are not tenant resources). Non-admins get 403, which the UI absorbs gracefully.
import { Controller, ForbiddenException, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { authorize } from "../core/http";
import { AuthGuard } from "../auth/guards";

type SystemKey = "bot" | "gateway" | "hub" | "agents" | "knowledge" | "automation";
const SYSTEMS: SystemKey[] = ["bot", "gateway", "hub", "agents", "knowledge", "automation"];

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
  editable: boolean;
}

function isElevated(req: FastifyRequest): boolean {
  return req.principal.roles.some(
    (r) =>
      (r.role === "platform_admin" && r.scopeType === "global") ||
      (r.role === "group_executive" && r.scopeType === "global"),
  );
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

/** Reshape one system's /health payload into SystemStatus; fail-soft on unreachable. */
async function probeStatus(system: SystemKey): Promise<SystemStatus> {
  if (system === "agents") {
    return { ok: false, detail: { note: "ai-agents runs as a CLI/library, not an HTTP service; no live status." } };
  }
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
      return { ok: true, counters: { workflows: workflows.length }, detail: { url: base, n8nUrl: base, workflows } };
    }
    const h = (await getJson(`${base}${healthPath}`)) as Record<string, unknown>;
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
    case "bot":
      return { ok, detail: { ai: h.ai } };
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

/** Read-only connection descriptor per system — what the PLATFORM knows, honestly. Remote
 *  service config is not editable from here (editable:false everywhere). */
function connectionConfig(system: SystemKey): ConfigField[] {
  if (system === "agents") {
    return [{ key: "kind", label: "Deployment", value: "CLI/library (no HTTP service)", kind: "text", editable: false }];
  }
  const svc = config.services[system];
  const fields: ConfigField[] = [
    { key: "url", label: "Service URL", value: svc?.url || "(not set)", kind: "text", editable: false },
  ];
  const tokenLabel = system === "automation" ? "Public-API key configured" : "Auth token configured";
  fields.push({ key: "tokenConfigured", label: tokenLabel, value: !!svc?.token, kind: "secretPresence", editable: false });
  return fields;
}

@Controller("api/admin")
@UseGuards(AuthGuard)
export class AdminSystemsController {
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
    return { fields: connectionConfig(system as SystemKey) };
  }

  // ---- Extra reads (optional per surface; degrade to [] when the service lacks the route) ----
  @Get("gateway/egress-audit")
  async egressAudit(@Req() req: FastifyRequest) {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const svc = config.services.gateway;
    if (!svc.url) return [];
    try {
      const rows = (await getJson(`${svc.url.replace(/\/$/, "")}/egress-audit`, svc.token)) as Array<{
        ts?: number; capability?: string; provider?: string | null; ok?: boolean; blocked?: string; redactions?: number; latencyMs?: number;
      }>;
      if (!Array.isArray(rows)) return [];
      // Reshape the gateway's native EgressAudit into the UI's AuditRow.
      return rows.map((r) => ({
        time: r.ts ? new Date(r.ts).toISOString() : "",
        provider: r.provider ?? undefined,
        decision: r.ok ? "allow" : r.blocked ? `blocked:${r.blocked}` : "deny",
        detail: [r.capability, r.latencyMs ? `${r.latencyMs}ms` : "", r.redactions ? `redactions=${r.redactions}` : ""]
          .filter(Boolean)
          .join(" "),
      }));
    } catch {
      return []; // graceful empty (UI shows "no audit")
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
