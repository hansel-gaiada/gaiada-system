// Module-contributed tools (WS2 §6 aggregation). Instead of hardcoding each vertical's tools,
// the hub fetches the platform's ModuleContract.mcpTools union from GET /mcp/tool-defs at boot and
// registers a GENERIC platform-front handler per def. This keeps the backbone rule (the hub fronts
// the platform, no DB access, no authz logic) while letting modules own their own tool surface.
//
// Fail-soft: if the platform is unreachable at boot the hub keeps its local tools and logs — it
// does not crash. A def with no pathTemplate is informational-only and is skipped (not callable).
import { config } from "./config";
import { registerTool, type Impact } from "./registry";
import type { Principal } from "./principal";

export interface RemoteToolDef {
  name: string;
  description: string;
  minAssurance: "low" | "verified";
  inputSchema: Record<string, unknown>;
  method?: "GET" | "POST" | "PATCH";
  pathTemplate?: string;
  write?: boolean;
  impact?: Impact;
}

/** Fill :param tokens from args (URL-encoded); report which arg names were consumed. */
function fillPath(template: string, args: Record<string, unknown>): { path: string; used: Set<string> } {
  const used = new Set<string>();
  const path = template.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    used.add(name);
    const v = args[name];
    if (v == null || v === "") throw new Error(`missing path parameter: ${name}`);
    return encodeURIComponent(String(v));
  });
  return { path, used };
}

async function callPlatform(def: RemoteToolDef, args: Record<string, unknown>, principal: Principal): Promise<string> {
  const method = def.method ?? "GET";
  const { path, used } = fillPath(def.pathTemplate as string, args);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.platformToken}`,
    "x-obo-provider": principal.provider,
    "x-obo-external-id": principal.externalId,
  };
  let body: string | undefined;
  if (method !== "GET") {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(rest);
  }
  const res = await fetch(`${config.platformUrl}${path}`, { method, headers, body });
  if (res.status === 401 || res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

/** Fetch the platform's module tool-defs and register each callable one. Returns the count
 *  registered (0 on any failure). `fetchImpl` is injectable for tests. */
export async function registerModuleTools(fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!config.platformUrl) return 0;
  let defs: RemoteToolDef[];
  try {
    const res = await fetchImpl(`${config.platformUrl}/mcp/tool-defs`, {
      headers: { Authorization: `Bearer ${config.platformToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    defs = (await res.json()) as RemoteToolDef[];
  } catch (err) {
    console.warn(`[module-tools] /mcp/tool-defs unavailable (${(err as Error).message}) — module tools not loaded`);
    return 0;
  }
  let n = 0;
  for (const def of defs) {
    if (!def.pathTemplate) continue; // informational-only def — not callable over the hub
    registerTool({
      name: def.name,
      description: def.description,
      minAssurance: def.minAssurance,
      write: def.write,
      impact: def.impact,
      inputSchema: def.inputSchema,
      handler: (args, principal) => callPlatform(def, args, principal),
    });
    n++;
  }
  return n;
}
