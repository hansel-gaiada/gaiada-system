// The `agents.*` namespace (P1) — what converts Hermes from one big agent into a CONTROL PLANE.
//
// Design: docs/superpowers/plans/2026-08-10-hermes-orchestration-architecture.md §3, which calls this
// "the single highest-leverage change in the plan". Today Hermes holds the whole aggregated hub tool
// surface (~70 tools) as one flat list under one identity. After this, the router holds roughly these
// four and reaches everything else THROUGH a department seat that carries its own bounded identity,
// its own tool view, and its own audit trail.
//
// ── THE DIVISION OF LABOUR THIS FILE ENFORCES ────────────────────────────────────────────────────
// Hermes ROUTES. `ai-agents` EXECUTES. Two orchestrators already exist in this estate, and letting
// both execute produces a split brain where budget, D14 suspension, tracing and evals are enforced on
// one path and not the other. So nothing here runs an agent in-process: every invoke is a POST to the
// runner service, which already owns the durable goal store, the bounded queue, the per-goal budget,
// the cycle/fan-out guards and the D13/D14 gates.
//
// ── WHY THESE TOOLS CARRY NO `impact` ────────────────────────────────────────────────────────────
// `agents.invoke` does not itself mutate business data — it files a GOAL. Whatever the seat then does
// is authorised as that seat, at its own `max_impact`, through this same hub, with its own OBO
// envelope. Marking invoke as a high-impact write would double-gate the request (once to ask, once to
// act) and, worse, would let an approved invoke imply approval of whatever the agent later attempts.
// The gate belongs at the act, not at the ask. `write: true` is still set on invoke because it
// CREATES durable state (a goal row) — that is honest, and `impact: "low"` is the floor the risk
// ladder may raise per-call once computed tiers land.
import { config } from "./config";
import { oboHeaders, type OboSubject } from "./obo-headers";
import { registerTool } from "./registry";
import type { Principal } from "./principal";

/** One place the runner's absence is turned into an honest refusal rather than a confusing 500. */
function requireRunner(): string {
  if (!config.agentRunnerUrl) {
    throw new Error(
      "agent runner not configured (AGENT_RUNNER_URL empty) — the hub routes to agents, it does not run them",
    );
  }
  return config.agentRunnerUrl.replace(/\/$/, "");
}

async function runnerFetch(
  method: "GET" | "POST",
  path: string,
  principal: OboSubject,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const base = requireRunner();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      // The runner authenticates the SERVICE with its own token and reads the human from the OBO
      // envelope — identical posture to platformSend/knowledge. The hub never asserts an identity.
      ...oboHeaders(principal, config.agentRunnerToken),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

/** Surface the runner's own `{error}` body verbatim — a status code alone strands the caller.
 *  Same reasoning as pm-tools.ts's P4-J2 note: a 429 that says "goal queue full" is actionable; a
 *  bare 429 makes an agent retry forever. */
function passthrough(what: string, r: { status: number; text: string }): string {
  if (r.status >= 200 && r.status < 300) return r.text;
  throw new Error(`agent runner ${what} ${r.status}: ${r.text.slice(0, 400)}`);
}

export function registerAgentsTools(): void {
  // ── agents.list ────────────────────────────────────────────────────────────────────────────────
  // The router's "who can help with this?" query. It reads the SEAT REGISTRY from the platform, not
  // the runner: the registry is the authority on which seats exist, what they may reach and whether
  // they are enabled, and it is the thing a new company adds ROWS to. Asking the runner instead would
  // answer "which agent definitions are compiled in", which is a different and much weaker question.
  registerTool({
    name: "agents.list",
    description:
      "List the agent seats this caller may address, from the platform's agent registry. Returns name, kind, capability tags, max impact and enabled state. Use this to choose WHO should handle a request; do not guess a seat name.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Company scope. Omit for group-scoped seats." },
        capability: { type: "string", description: "Optional capability tag to filter by." },
      },
      required: [],
    },
    handler: async (args, principal: Principal) => {
      const q = new URLSearchParams();
      if (typeof args.tenantId === "string") q.set("tenant", args.tenantId);
      if (typeof args.capability === "string") q.set("capability", args.capability);
      const res = await fetch(`${config.platformUrl}/api/agents${q.toString() ? `?${q}` : ""}`, {
        headers: oboHeaders(principal, config.platformToken),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`platform /api/agents ${res.status}: ${text.slice(0, 400)}`);
      return text;
    },
  });

  // ── agents.invoke ──────────────────────────────────────────────────────────────────────────────
  registerTool({
    name: "agents.invoke",
    description:
      "Hand a goal to an agent seat. Returns immediately with a goal id and status 'queued' — this is ASYNCHRONOUS; poll agents.status for the outcome. The seat executes under its OWN identity and impact ceiling, so a goal you can file is not necessarily a goal that will be permitted.",
    minAssurance: "low",
    write: true,
    // Creates durable state (a goal row) but mutates no business data — see the header note on why
    // this is the floor rather than the gate.
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Company uuid the goal belongs to." },
        agent: { type: "string", description: "Seat name from agents.list, e.g. 'dept-pm'. Defaults to the supervisor." },
        goal: { type: "string", description: "What to achieve, in one or two sentences (1..4000 chars)." },
        requestedBy: { type: "string", description: "Optional: the human this goal is for." },
      },
      required: ["tenantId", "goal"],
    },
    handler: async (args, principal: Principal) => {
      // The envelope is forwarded VERBATIM. An agent must never act with more authority than the
      // human it serves, so the runner receives this caller's identity rather than a service one.
      const r = await runnerFetch("POST", "/goals", principal, {
        tenantId: args.tenantId,
        goal: args.goal,
        ...(typeof args.agent === "string" ? { agent: args.agent } : {}),
        ...(typeof args.requestedBy === "string" ? { requestedBy: args.requestedBy } : {}),
        envelope: { provider: principal.provider, externalId: principal.externalId },
      });
      return passthrough("POST /goals", r);
    },
  });

  // ── agents.status ──────────────────────────────────────────────────────────────────────────────
  registerTool({
    name: "agents.status",
    description:
      "Read a goal's current status and outcome by id. Statuses include queued, running, done, suspended (awaiting human approval) and interrupted. A 'suspended' goal is NOT a failure — it is waiting on a person.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        goalId: { type: "string", description: "The id returned by agents.invoke." },
        tenantId: { type: "string", description: "Company uuid the goal belongs to." },
      },
      required: ["goalId"],
    },
    handler: async (args, principal: Principal) => {
      const q = typeof args.tenantId === "string" ? `?tenant=${encodeURIComponent(args.tenantId)}` : "";
      const r = await runnerFetch("GET", `/goals/${encodeURIComponent(String(args.goalId))}${q}`, principal);
      return passthrough("GET /goals/:id", r);
    },
  });

  // ── agents.runs ────────────────────────────────────────────────────────────────────────────────
  // Deliberately NOT `agents.cancel`. The runner exposes no cancel endpoint, and shipping a tool that
  // silently fails to cancel is worse than not shipping one — an operator who believes a runaway goal
  // was stopped will not go and stop it. The honest containment controls that DO exist are the
  // per-goal budget, the cycle/fan-out guards, and `enabled=false` on the seat's registry row.
  registerTool({
    name: "agents.runs",
    description:
      "Read the individual runs behind a goal, for tracing what an agent actually did. Use when a goal's outcome needs explaining rather than merely reporting.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "A run id, from agents.status." },
        tenantId: { type: "string", description: "Company uuid." },
      },
      required: ["runId"],
    },
    handler: async (args, principal: Principal) => {
      const q = typeof args.tenantId === "string" ? `?tenant=${encodeURIComponent(args.tenantId)}` : "";
      const r = await runnerFetch("GET", `/runs/${encodeURIComponent(String(args.runId))}${q}`, principal);
      return passthrough("GET /runs/:id", r);
    },
  });
}
