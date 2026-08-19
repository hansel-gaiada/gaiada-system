// Module-contributed tools (WS2 §6 aggregation). Instead of hardcoding each vertical's tools,
// the hub fetches the platform's ModuleContract.mcpTools union from GET /mcp/tool-defs at boot and
// registers a GENERIC platform-front handler per def. This keeps the backbone rule (the hub fronts
// the platform, no DB access, no authz logic) while letting modules own their own tool surface.
//
// Fail-soft: if the platform is unreachable at boot the hub keeps its local tools and logs — it
// does not crash. A def with no pathTemplate is informational-only and is skipped (not callable).
//
// SM-45: a one-shot fetch at boot froze the hub at zero module tools forever whenever the platform
// wasn't up yet (a boot-order race) or restarted later (no ordering fix can help with that case).
// startModuleToolsBootstrap() below retries with backoff until the first successful fetch, then
// keeps re-fetching periodically so a platform redeploy's new/changed tools show up without a hub
// restart. moduleToolsStatus() makes the state observable (server.ts /health + WS9 metrics) so a
// persistent zero-tools state is never silent again.
import { config } from "./config";
import { registerTool, type Impact } from "./registry";
import type { Principal } from "./principal";

export interface ModuleToolsStatus {
  /** Tools registered as of the last successful fetch (0 if never succeeded). */
  registered: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  /** Fetches that have failed back-to-back since the last success (or since boot). */
  consecutiveFailures: number;
  lastError: string | null;
}

const status: ModuleToolsStatus = {
  registered: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastError: null,
};

/** Read-only snapshot for /health, /admin/info and the WS9 gauge. */
export function moduleToolsStatus(): ModuleToolsStatus {
  return { ...status };
}

/** Test-only reset (mirrors registry.resetRegistry()). */
export function resetModuleToolsStatus(): void {
  status.registered = 0;
  status.lastAttemptAt = null;
  status.lastSuccessAt = null;
  status.consecutiveFailures = 0;
  status.lastError = null;
}

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
  if (!res.ok) {
    // SMM-10: extract the platform's own typed `.error` token when the response body carries one
    // (every platform-nest error body is `{error, code?}` — `http-error.filter.ts`/publisher-error
    // filters both build it), for EVERY non-2xx status, not only 401/403. Before this fix, a 409-
    // shaped domain refusal (e.g. a publish precondition failing at the SMM-10 dispatch endpoint)
    // lost its token entirely — `executeApprovedAutomationWrite` recorded only
    // `tool_error: platform /api/.../publish 409`, discarding exactly the information an operator
    // reading `automation_approvals.execution_error` needs. 401/403 stay first because their default
    // fallback text ("platform denied the request") differs from the generic one below.
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 || res.status === 403) {
      throw new Error(b.error ?? "platform denied the request");
    }
    throw new Error(b.error ?? `platform ${path} ${res.status}`);
  }
  return JSON.stringify(await res.json());
}

/** Fetch the platform's module tool-defs and register each callable one. Returns the count
 *  registered (0 on any failure). `fetchImpl` is injectable for tests. */
export async function registerModuleTools(fetchImpl: typeof fetch = fetch): Promise<number> {
  status.lastAttemptAt = Date.now();
  if (!config.platformUrl) return 0;
  let defs: RemoteToolDef[];
  try {
    const res = await fetchImpl(`${config.platformUrl}/mcp/tool-defs`, {
      headers: { Authorization: `Bearer ${config.platformToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    defs = (await res.json()) as RemoteToolDef[];
  } catch (err) {
    status.consecutiveFailures += 1;
    status.lastError = (err as Error).message;
    // WARN (not once-only info): every failed attempt logs, so a stuck-at-zero hub is audible in
    // the logs on its own, not just discoverable by someone thinking to count /tools.
    console.warn(
      `[module-tools] /mcp/tool-defs unavailable (${status.lastError}) — module tools not loaded ` +
        `(consecutive failures: ${status.consecutiveFailures}, will retry)`,
    );
    return 0;
  }
  status.consecutiveFailures = 0;
  status.lastError = null;
  status.lastSuccessAt = Date.now();
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
      // Attribution for the admin console: these came from a platform ModuleContract, not from a
      // built-in group. /mcp/tool-defs is a flat union so the owning module key isn't recoverable
      // here — "module" is as specific as the contract allows.
      source: "module",
    });
    n++;
  }
  status.registered = n;
  return n;
}

const RETRY_BASE_MS = Number(process.env.HUB_MODULE_TOOLS_RETRY_BASE_MS ?? 2_000);
const RETRY_MAX_MS = Number(process.env.HUB_MODULE_TOOLS_RETRY_MAX_MS ?? 60_000);
// Once a fetch has succeeded, keep re-fetching on this cadence so tools added/changed by a platform
// redeploy show up without a hub restart. 0 disables the periodic refresh (retry-until-success only).
const REFRESH_MS = Number(process.env.HUB_MODULE_TOOLS_REFRESH_MS ?? 5 * 60_000);

let bootstrapTimer: NodeJS.Timeout | undefined;
let bootstrapping = false;

/** Exponential backoff capped at RETRY_MAX_MS, keyed off consecutive failure count. */
function backoffMs(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

/**
 * Start the self-healing bootstrap loop (SM-45). Call once at server start, AFTER the HTTP
 * listener is up — the hub must serve its core tools immediately even if the platform is down;
 * this keeps trying in the background instead of blocking startup or giving up after one try.
 *
 * - On failure: retries with exponential backoff (RETRY_BASE_MS..RETRY_MAX_MS), forever.
 * - On success: schedules the next attempt REFRESH_MS later (periodic re-fetch), so a platform
 *   restart AFTER the hub is already up — which no compose ordering constraint can fix — also
 *   self-heals, and so does a redeploy that adds/changes module tools.
 */
export function startModuleToolsBootstrap(fetchImpl: typeof fetch = fetch): void {
  if (bootstrapping) return; // idempotent — a second call (e.g. in tests) doesn't double-schedule
  bootstrapping = true;
  const tick = async (): Promise<void> => {
    await registerModuleTools(fetchImpl);
    const ok = status.lastError === null;
    if (ok && REFRESH_MS <= 0) return; // succeeded and periodic refresh is disabled — done
    const delay = ok ? REFRESH_MS : backoffMs(status.consecutiveFailures);
    bootstrapTimer = setTimeout(() => void tick(), delay);
  };
  void tick();
}

/** Test/shutdown helper — stops the background loop and allows a fresh bootstrap. */
export function stopModuleToolsBootstrap(): void {
  if (bootstrapTimer) clearTimeout(bootstrapTimer);
  bootstrapTimer = undefined;
  bootstrapping = false;
}
