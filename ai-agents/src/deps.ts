// Live bindings: models via the AI Gateway, tools via the MCP hub (OBO envelope).
// The agent process holds NO provider keys and NO database access — by construction.
import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentDeps, ApprovalResolution, Envelope, RegistryToolImpact } from "./agent";

// Per-goal tenant context: the runner wraps each goal's execution in `tenantContext.run(tenantId, …)`
// so completions are attributed to the triggering tenant for the Gateway's existing per-tenant daily
// cap (design §3.5.4 — the cap already EXISTS; this only feeds `x-tenant-id`). Concurrency-safe (unlike
// a module-level variable) when AGENT_MAX_CONCURRENT_GOALS > 1.
export const tenantContext = new AsyncLocalStorage<string>();

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14-14 — the per-goal OBO envelope, mirroring `tenantContext` immediately above (same file, same
// reasoning, same concurrency hazard).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS: `resolveApproval` (below) must call the platform's `resolve-and-execute` endpoint
// AS THE ORIGINAL REQUESTER — the endpoint is Cerbos-gated to `requested_by == principal.id` (§1's
// authority rule; see `platform-nest/src/core/automation-approvals.controller.ts`'s header). But
// `AgentDeps.resolveApproval` (agent.ts, D14-10) deliberately carries NO envelope parameter — only
// `{agentName, toolName, toolArgs}` — so the concrete implementation must recover the run's envelope
// from context, exactly as `complete()` below recovers `tenantId` from `tenantContext`. `runOrchestrator`
// / `runWriteAgent` / `runAgent` all thread ONE envelope value through an entire goal unchanged (it is a
// function parameter, never re-derived per call), so capturing it ONCE per goal — at the SAME place
// `runner/service.ts` already opens `tenantContext.run(g.tenantId, …)` — is correct for the run's whole
// lifetime, and AsyncLocalStorage (not a module-level variable) keeps concurrent goals from clobbering
// each other's envelope, same as tenantContext's own header note.
//
// FAIL-SOFT BY DESIGN, NOT BY ACCIDENT: a caller that never wraps a run in this context (today: the CLI,
// `cli.ts`, which also never wraps `tenantContext`) gets `{ match: "none" }` from `resolveApproval` below
// — i.e. exactly the "no resolver configured" fallback, NEVER a thrown error. That is deliberately a
// DIFFERENT failure class from a fault DURING an attempted consultation (hub down / 403 / unknown tool,
// which DO throw, per this file's `resolveApproval` doc): "this call site was never wired to consult the
// platform" is not evidence of anything platform-side, so treating it as `none` cannot manufacture the
// duplicate-approval generator the way mapping a real fault to `none` would. Wiring MORE call sites is a
// matter of adding `envelopeContext.run(...)` at that site — never of relaxing this check.
export const envelopeContext = new AsyncLocalStorage<Envelope>();

const config = {
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3002",
  gatewayToken: process.env.GATEWAY_TOKEN ?? "",
  hubUrl: process.env.HUB_URL ?? "http://localhost:3003",
  hubServiceToken: process.env.HUB_SERVICE_TOKEN ?? "",
};

// The provider the Gateway reported for the most recent completion (after any failover). Used by the
// D13 write gate (runWriteAgent) + WS9 attribution; undefined until the first completion.
let lastServedProvider: string | undefined;

async function complete(prompt: string): Promise<string> {
  const tenantId = tenantContext.getStore();
  const res = await fetch(`${config.gatewayUrl}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.gatewayToken}`,
      ...(tenantId ? { "x-tenant-id": tenantId } : {}),
    },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  const body = (await res.json()) as { text: string; provider?: string };
  lastServedProvider = body.provider;
  return body.text;
}

async function callTool(name: string, args: Record<string, unknown>, envelope: Envelope): Promise<string> {
  const res = await fetch(`${config.hubUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${config.hubServiceToken}`,
      "x-obo-provider": envelope.provider,
      "x-obo-external-id": envelope.externalId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`hub ${res.status}`);
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data:")) ?? "";
  const rpc = JSON.parse(line.slice(5).trim()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  const text = rpc.result?.content?.[0]?.text ?? "";
  if (rpc.result?.isError) throw new Error(text || "denied");
  return text;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14-12 — background, fail-soft cache of the hub registry's write/impact classification.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// The hub already exposes this over `GET /tools` (`mcp-hub/src/server.ts`): open, non-sensitive
// metadata — `{ name, description, minAssurance, write, impact, source }` per tool — no hub change was
// needed for this ticket (verified before writing this). This module fetches that listing and keeps a
// synchronous in-memory snapshot, mirroring `mcp-hub/src/module-tools.ts`'s own bootstrap (retry with
// backoff until the first success, then periodic refresh) so a hub redeploy that reclassifies a tool
// is picked up without an ai-agents restart.
//
// WHY THIS MUST NEVER BLOCK A RUN: `agent.ts`'s write gate calls `AgentDeps.getRegistryImpact`
// synchronously on every tool dispatch — see that file's doc. `startRegistryImpactBootstrap` is
// therefore NEVER awaited by anything that also awaits an agent run: `getRegistryImpact` below reads
// whatever snapshot is already warm (possibly empty, on a cold start or a down hub) and returns
// `undefined` for anything not in it. `effectiveImpact()` treats `undefined` as "no registry opinion"
// — the AgentDef label wins, i.e. TODAY'S exact behaviour. A hub blip degrades reconciliation to a
// no-op, never to a failed or stalled agent run, and agent startup itself never calls the hub — the
// bootstrap is started explicitly by the runner's `start()`, not by importing this module.
const registryImpactCache = new Map<string, RegistryToolImpact>();

/** Synchronous, side-effect-free — safe to call from `agent.ts`'s hot path. */
function getRegistryImpact(name: string): RegistryToolImpact | undefined {
  return registryImpactCache.get(name);
}

interface HubToolsRow {
  name: string;
  write?: boolean;
  impact?: "low" | "medium" | "high" | null;
}

/** One fetch+swap of the cache. Exported for tests; returns whether it succeeded. Fail-soft: on any
 *  error the PREVIOUS snapshot is kept (never cleared to empty on a transient failure) and the error is
 *  logged, not thrown — a hub blip must never surface as an agent-run failure. */
export async function refreshRegistryImpacts(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${config.hubUrl}/tools`);
    if (!res.ok) throw new Error(`hub ${res.status}`);
    const rows = (await res.json()) as HubToolsRow[];
    registryImpactCache.clear();
    for (const r of rows) registryImpactCache.set(r.name, { write: !!r.write, impact: r.impact ?? undefined });
    return true;
  } catch (err) {
    console.warn(
      `[ai-agents] hub /tools unreachable (${(err as Error).message}) — D14-12 registry-impact ` +
        "reconciliation falls back to each AgentDef's own label until the next retry (never blocks a run)",
    );
    return false;
  }
}

const REGISTRY_IMPACT_RETRY_BASE_MS = Number(process.env.AGENT_REGISTRY_IMPACT_RETRY_BASE_MS ?? 2_000);
const REGISTRY_IMPACT_RETRY_MAX_MS = Number(process.env.AGENT_REGISTRY_IMPACT_RETRY_MAX_MS ?? 60_000);
// 0 disables periodic refresh (retry-until-success only) — mirrors module-tools.ts's REFRESH_MS.
const REGISTRY_IMPACT_REFRESH_MS = Number(process.env.AGENT_REGISTRY_IMPACT_REFRESH_MS ?? 5 * 60_000);

let registryImpactBootstrapping = false;
let registryImpactTimer: NodeJS.Timeout | undefined;
let registryImpactFailures = 0;

function registryImpactBackoffMs(failures: number): number {
  return Math.min(REGISTRY_IMPACT_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), REGISTRY_IMPACT_RETRY_MAX_MS);
}

/** Start the self-healing bootstrap loop. NOT called by importing this module — the runner's `start()`
 *  calls it explicitly, AFTER its own listener is up, so a down hub never blocks agent-runner startup
 *  (same ordering discipline mcp-hub uses for module-tools.ts's own bootstrap). Idempotent. */
export function startRegistryImpactBootstrap(fetchImpl: typeof fetch = fetch): void {
  if (registryImpactBootstrapping) return;
  registryImpactBootstrapping = true;
  const tick = async (): Promise<void> => {
    const ok = await refreshRegistryImpacts(fetchImpl);
    registryImpactFailures = ok ? 0 : registryImpactFailures + 1;
    if (ok && REGISTRY_IMPACT_REFRESH_MS <= 0) return;
    const delay = ok ? REGISTRY_IMPACT_REFRESH_MS : registryImpactBackoffMs(registryImpactFailures);
    registryImpactTimer = setTimeout(() => void tick(), delay);
  };
  void tick();
}

/** Test/shutdown helper. */
export function stopRegistryImpactBootstrap(): void {
  if (registryImpactTimer) clearTimeout(registryImpactTimer);
  registryImpactTimer = undefined;
  registryImpactBootstrapping = false;
  registryImpactFailures = 0;
}

/** Test-only reset of the cache itself (mirrors mcp-hub's resetRegistry()). */
export function resetRegistryImpactCache(): void {
  registryImpactCache.clear();
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// D14-14 — the live `resolveApproval` transport. Turns D14-10's proven-correct `AgentDeps.resolveApproval`
// contract (agent.ts) from an interface nothing implements into a real call through the hub's
// `approvals.resolveExecute` tool (mcp-hub/src/platform-write-tools.ts), which fronts platform-nest's
// `POST :tenantId/automation-approvals/resolve-and-execute` (D14-10).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// MUST NEVER MAP A FAULT TO `{ match: "none" }` (agent.ts's own contract doc, restated here because
// this is the one place it can be violated by accident): `none` means "nothing decided binds this call,
// file a fresh approval" — mapping a transport failure, a hub-side deny, or an unknown-tool response
// onto it would rebuild the exact duplicate-approval generator this ticket exists to kill. So this
// function is deliberately UNGUARDED against `callTool`'s own thrown errors: it lets them propagate.
// `callTool` (above) already throws on every one of those cases — a network failure (hub down; `fetch`
// itself rejects), a non-2xx HTTP response, or an MCP `isError` result (unknown tool, insufficient
// assurance, workflow-scope denial, or the tool handler's own thrown error, which for this tool
// includes the platform's 403 when a decided row exists but belongs to someone else, per §1's authority
// rule) — so simply not catching them is what satisfies the contract. The ONE thing this function adds
// beyond a bare passthrough is the context lookup below, whose OWN "nothing to consult" case resolves to
// `none` deliberately — see `envelopeContext`'s doc above for why that is a different failure class.
async function resolveApproval(input: {
  agentName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): Promise<ApprovalResolution> {
  const tenantId = tenantContext.getStore();
  const envelope = envelopeContext.getStore();
  if (!tenantId || !envelope) {
    // Not wired for this call site (see envelopeContext's doc) — behave exactly as if no resolver were
    // configured at all. This is NOT a fault during a consultation; no consultation was attempted.
    return { match: "none" };
  }
  const raw = await callTool(
    "approvals.resolveExecute",
    { tenantId, agentName: input.agentName, toolName: input.toolName, toolArgs: input.toolArgs },
    envelope,
  );
  // `raw` is the hub tool's text content — for this tool, the platform's JSON response verbatim
  // (mirrors `approvals.request`'s own handler in platform-write-tools.ts: `JSON.stringify(await
  // res.json())`). A response that fails to parse as JSON is exactly as much a fault as an HTTP error —
  // JSON.parse throwing here propagates for the same reason `callTool`'s own throws do: never silently
  // treated as "nothing decided".
  return JSON.parse(raw) as ApprovalResolution;
}

export const liveDeps: AgentDeps = {
  complete,
  callTool,
  lastProvider: () => lastServedProvider,
  getRegistryImpact,
  resolveApproval,
};
