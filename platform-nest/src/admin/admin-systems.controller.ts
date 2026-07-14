// Phase C: Systems/Intelligence admin console aggregator. Read-only. The platform proxies
// each downstream service's own surface (mostly its open GET /health) and reshapes it into
// the UI's SystemStatus/ConfigField contract (platform-ui/src/lib/admin.ts). It NEVER
// fabricates data: an unreachable or not-configured system reports ok:false with a reason,
// and extra reads that a service doesn't expose degrade to an empty list.
//
// Access is platform-global admin (platform_admin) or owner (group_executive) — checked in
// code (these are not tenant resources). Non-admins get 403, which the UI absorbs gracefully.
import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from "@nestjs/common";
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
      return { ok: true, detail: { url: base } };
    }
    const h = (await getJson(`${base}${healthPath}`)) as Record<string, unknown>;
    return shapeHealth(system, h);
  } catch (e) {
    return { ok: false, detail: { error: (e as Error).message, url: base } };
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
  if (system !== "automation") {
    fields.push({ key: "tokenConfigured", label: "Auth token configured", value: !!svc?.token, kind: "secretPresence", editable: false });
  }
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
