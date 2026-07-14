// Company-data WRITE tools (action-agent Phase D). Like the read tools, these are thin
// fronts over the PLATFORM API that forward the caller's OBO envelope — the platform mints
// the principal, runs Cerbos + RLS, writes the activity audit, and returns the result. The
// hub holds no DB access and duplicates no authz logic. `authz.check` is a non-mutating
// probe the surface uses before asking a user to confirm.
import { config } from "./config";
import { registerTool } from "./registry";
import type { Principal } from "./principal";

async function platformSend(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  principal: Principal,
): Promise<string> {
  const res = await fetch(`${config.platformUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.platformToken}`,
      "x-obo-provider": principal.provider,
      "x-obo-external-id": principal.externalId,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

export function registerPlatformWriteTools(): void {
  registerTool({
    name: "authz.check",
    description: "Non-mutating check: may the caller perform <action> on <resource>? Returns allow/deny/stepup.",
    minAssurance: "low", // the platform resolves the real identity + Cerbos decision
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string", description: "used to derive the company/tenant" },
        resource: { type: "string" },
        action: { type: "string" },
        tenantId: { type: "string" },
        projectId: { type: "string" },
        id: { type: "string" },
      },
      required: ["resource", "action"],
    },
    handler: (args, principal) => {
      const tenantId = String(args.tenantId ?? "");
      return platformSend(
        "POST",
        `/api/${tenantId}/authz/check`,
        { resource: args.resource, action: args.action, projectId: args.projectId, id: args.id },
        principal,
      );
    },
  });

  registerTool({
    name: "projects.create",
    description: "Create a project in a company you belong to.",
    minAssurance: "low",
    write: true,
    impact: "low", // in-tenant, reversible; Cerbos + RLS still enforced at the platform
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, name: { type: "string" }, clientId: { type: "string" } },
      required: ["tenantId", "name"],
    },
    handler: (args, principal) =>
      platformSend("POST", `/api/${String(args.tenantId)}/projects`, { name: args.name, clientId: args.clientId }, principal),
  });

  registerTool({
    name: "tasks.create",
    description: "Create a task under a project.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" }, title: { type: "string" } },
      required: ["tenantId", "projectId", "title"],
    },
    handler: (args, principal) =>
      platformSend("POST", `/api/${String(args.tenantId)}/projects/${String(args.projectId)}/tasks`, { title: args.title }, principal),
  });

  registerTool({
    name: "notify",
    description: "Raise an in-app notification for a member (elevated/automation). recipientId + type required.",
    minAssurance: "low",
    write: true,
    impact: "low", // in-tenant, reversible (a notification row); Cerbos gates create to admin/manager
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        recipientId: { type: "string" },
        type: { type: "string" },
        payload: { type: "object" },
      },
      required: ["tenantId", "recipientId", "type"],
    },
    handler: (args, principal) =>
      platformSend(
        "POST",
        `/api/${String(args.tenantId)}/notifications`,
        { recipientId: args.recipientId, type: args.type, payload: args.payload ?? {} },
        principal,
      ),
  });

  registerTool({
    name: "tasks.update",
    description: "Update a task: assign (assigneeId), change status (e.g. done), priority, or due date.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        taskId: { type: "string" },
        assigneeId: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        dueDate: { type: "string" },
      },
      required: ["tenantId", "taskId"],
    },
    handler: (args, principal) =>
      platformSend(
        "PATCH",
        `/api/${String(args.tenantId)}/tasks/${String(args.taskId)}`,
        { assigneeId: args.assigneeId, status: args.status, priority: args.priority, dueDate: args.dueDate },
        principal,
      ),
  });
}
