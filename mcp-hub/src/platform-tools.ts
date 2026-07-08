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
    name: "agency.pendingApprovals",
    description: "Approvals waiting for a decision (agency module).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) =>
      platformGet(`/api/${String(args.tenantId)}/modules/agency/approvals/pending`, principal),
  });
}
