// Company-data tools (WS2 §6): thin fronts over the PLATFORM API. The hub forwards the
// caller's OBO envelope; the platform mints the principal, applies RBAC + RLS, and the
// hub returns whatever the platform allowed — no DB access, no authz logic duplicated.
import { config } from "./config";
import { registerTool } from "./registry";
import type { Principal } from "./principal";

async function platformGet(path: string, principal: Principal): Promise<string> {
  const res = await fetch(`${config.platformUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${config.platformToken}`,
      "x-obo-provider": principal.provider,
      "x-obo-external-id": principal.externalId,
    },
  });
  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

export function registerPlatformTools(): void {
  registerTool({
    name: "projects.list",
    description: "List projects in a company you belong to (platform-authorized on your identity).",
    minAssurance: "low", // real authorization happens IN the platform per the OBO principal
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string", description: "Company id" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/projects`, principal),
  });

  registerTool({
    name: "projects.get",
    description: "Get one project's detail (client, owner, dates, custom fields).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" } },
      required: ["tenantId", "projectId"],
    },
    handler: (args, principal) =>
      platformGet(`/api/${String(args.tenantId)}/projects/${String(args.projectId)}`, principal),
  });

  registerTool({
    name: "tasks.list",
    description: "List a project's tasks.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["tenantId", "projectId"],
    },
    handler: (args, principal) =>
      platformGet(`/api/${String(args.tenantId)}/projects/${String(args.projectId)}/tasks`, principal),
  });

  registerTool({
    name: "tasks.get",
    description: "Get one task's detail (assignee, status, project, custom fields).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, taskId: { type: "string" } },
      required: ["tenantId", "taskId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/tasks/${String(args.taskId)}`, principal),
  });

  registerTool({
    name: "clients.list",
    description: "List the tenant's clients.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/clients`, principal),
  });

  registerTool({
    name: "clients.get",
    description: "Get one client's detail (contact, status, custom fields).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, clientId: { type: "string" } },
      required: ["tenantId", "clientId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/clients/${String(args.clientId)}`, principal),
  });

  registerTool({
    name: "deliverables.list",
    description: "List deliverables, optionally filtered by projectId or clientId.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" }, clientId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const q = new URLSearchParams();
      if (args.projectId) q.set("projectId", String(args.projectId));
      if (args.clientId) q.set("clientId", String(args.clientId));
      const qs = q.toString();
      return platformGet(`/api/${String(args.tenantId)}/deliverables${qs ? `?${qs}` : ""}`, principal);
    },
  });

  registerTool({
    name: "deliverables.get",
    description: "Get one deliverable's detail.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, deliverableId: { type: "string" } },
      required: ["tenantId", "deliverableId"],
    },
    handler: (args, principal) =>
      platformGet(`/api/${String(args.tenantId)}/deliverables/${String(args.deliverableId)}`, principal),
  });

  registerTool({
    name: "time.list",
    description: "List time entries, optionally filtered by projectId, taskId, or mine=me.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        projectId: { type: "string" },
        taskId: { type: "string" },
        mine: { type: "string", description: "'me' to restrict to the caller's own entries" },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const q = new URLSearchParams();
      if (args.projectId) q.set("projectId", String(args.projectId));
      if (args.taskId) q.set("taskId", String(args.taskId));
      if (args.mine) q.set("mine", String(args.mine));
      const qs = q.toString();
      return platformGet(`/api/${String(args.tenantId)}/time-entries${qs ? `?${qs}` : ""}`, principal);
    },
  });

  registerTool({
    name: "activity.feed",
    description: "Recent activity feed for the company (who did what, newest first).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, limit: { type: "number", description: "1..100 (default 20)" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const limit = args.limit ? `?limit=${Number(args.limit)}` : "";
      return platformGet(`/api/${String(args.tenantId)}/activity${limit}`, principal);
    },
  });

  registerTool({
    name: "knowledge.search",
    description: "Search company knowledge/memory (WS8 store; results limited to what YOUR identity may see).",
    minAssurance: "low", // the knowledge service resolves the envelope and pre-filters (D9)
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, scope: { type: "string", description: "Your current scope, e.g. group chat id" } },
      required: ["query", "scope"],
    },
    handler: async (args, principal) => {
      const res = await fetch(`${config.knowledgeUrl}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.knowledgeToken}`,
          "x-obo-provider": principal.provider,
          "x-obo-external-id": principal.externalId,
        },
        body: JSON.stringify({ query: String(args.query ?? ""), scope: String(args.scope ?? "") }),
      });
      if (!res.ok) throw new Error(`knowledge /search ${res.status}`);
      return JSON.stringify(((await res.json()) as { hits: unknown[] }).hits);
    },
  });

  registerTool({
    name: "knowledge.graph",
    description: "Traverse the company knowledge graph from an entity (WS8 semantic layer; results limited to what YOUR identity may see).",
    minAssurance: "low", // the knowledge service resolves the envelope and pre-filters the walk (D9.1)
    inputSchema: {
      type: "object",
      properties: {
        startKey: { type: "string", description: "entity key to start from, e.g. client:acme" },
        scope: { type: "string", description: "Your current scope, e.g. group chat / project id" },
        rel: { type: "string", description: "optional relation filter, e.g. owns" },
        maxDepth: { type: "number", description: "traversal depth (default 2)" },
      },
      required: ["startKey", "scope"],
    },
    handler: async (args, principal) => {
      const res = await fetch(`${config.knowledgeUrl}/graph/neighbors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.knowledgeToken}`,
          "x-obo-provider": principal.provider,
          "x-obo-external-id": principal.externalId,
        },
        body: JSON.stringify({ startKey: String(args.startKey ?? ""), scope: String(args.scope ?? ""), rel: args.rel, maxDepth: args.maxDepth }),
      });
      if (!res.ok) throw new Error(`knowledge /graph/neighbors ${res.status}`);
      return JSON.stringify(((await res.json()) as { nodes: unknown[] }).nodes);
    },
  });

  registerTool({
    name: "agent.feedback",
    description: "Give 👍/👎 feedback on an agent run (WS8 trainer signal). Your identity sets its trust: an unverified chat session's feedback is quarantined, never used to train.",
    minAssurance: "low", // knowledge derives trust from the resolved identity (D9.3); low ⇒ quarantined
    write: true,
    impact: "low", // appends a feedback row; never a business mutation
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "the agent run id being rated" },
        rating: { type: "string", enum: ["up", "down"] },
        note: { type: "string" },
      },
      required: ["runId", "rating"],
    },
    handler: async (args, principal) => {
      const res = await fetch(`${config.knowledgeUrl}/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.knowledgeToken}`,
          "x-obo-provider": principal.provider,
          "x-obo-external-id": principal.externalId,
        },
        body: JSON.stringify({ runId: String(args.runId ?? ""), rating: args.rating, note: args.note }),
      });
      if (!res.ok) throw new Error(`knowledge /feedback ${res.status}`);
      return JSON.stringify(await res.json());
    },
  });

  // NOTE: module-owned tools (e.g. agency.listCampaigns / agency.pendingApprovals) are no longer
  // hardcoded here — they are aggregated from the platform's ModuleContract.mcpTools at boot via
  // module-tools.ts (WS2 §6). Only core/cross-module tools live in this file.

  registerTool({
    name: "compliance.gates",
    description: "Compliance-gate statuses for a company (admin surface). Read-only.",
    minAssurance: "low", // the platform's Cerbos policy is the real gate (company_admin only)
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/compliance-gates`, principal),
  });
}
