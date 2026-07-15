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
    name: "clients.create",
    description: "Create a client in a company you belong to.",
    minAssurance: "low",
    write: true,
    impact: "low", // in-tenant, reversible
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, name: { type: "string" }, contact: { type: "object" } },
      required: ["tenantId", "name"],
    },
    handler: (args, principal) =>
      platformSend("POST", `/api/${String(args.tenantId)}/clients`, { name: args.name, contact: args.contact ?? {} }, principal),
  });

  registerTool({
    name: "clients.update",
    description: "Update a client: name, contact, or status.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, clientId: { type: "string" }, name: { type: "string" }, contact: { type: "object" }, status: { type: "string" } },
      required: ["tenantId", "clientId"],
    },
    handler: (args, principal) =>
      platformSend("PATCH", `/api/${String(args.tenantId)}/clients/${String(args.clientId)}`, { name: args.name, contact: args.contact, status: args.status }, principal),
  });

  registerTool({
    name: "deliverables.create",
    description: "Create a deliverable under a project.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, projectId: { type: "string" }, name: { type: "string" }, clientId: { type: "string" }, dueDate: { type: "string" } },
      required: ["tenantId", "projectId", "name"],
    },
    handler: (args, principal) =>
      platformSend(
        "POST",
        `/api/${String(args.tenantId)}/deliverables`,
        { projectId: args.projectId, name: args.name, clientId: args.clientId, dueDate: args.dueDate },
        principal,
      ),
  });

  registerTool({
    name: "deliverables.update",
    description: "Update a deliverable: name, status, due date, or client.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, deliverableId: { type: "string" }, name: { type: "string" }, status: { type: "string" }, dueDate: { type: "string" }, clientId: { type: "string" } },
      required: ["tenantId", "deliverableId"],
    },
    handler: (args, principal) =>
      platformSend(
        "PATCH",
        `/api/${String(args.tenantId)}/deliverables/${String(args.deliverableId)}`,
        { name: args.name, status: args.status, dueDate: args.dueDate, clientId: args.clientId },
        principal,
      ),
  });

  registerTool({
    name: "time.log",
    description: "Log a time entry (owned by the caller) against a project/task. minutes must be a positive integer.",
    minAssurance: "low",
    write: true,
    impact: "low", // records the caller's own time; reversible
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        projectId: { type: "string" },
        taskId: { type: "string" },
        minutes: { type: "number" },
        billable: { type: "boolean" },
        entryDate: { type: "string", description: "YYYY-MM-DD (defaults to today)" },
        notes: { type: "string" },
      },
      required: ["tenantId", "projectId", "minutes"],
    },
    handler: (args, principal) =>
      platformSend(
        "POST",
        `/api/${String(args.tenantId)}/time-entries`,
        { projectId: args.projectId, taskId: args.taskId, minutes: args.minutes, billable: args.billable ?? false, entryDate: args.entryDate, notes: args.notes ?? "" },
        principal,
      ),
  });

  registerTool({
    name: "time.update",
    description: "Update one of the caller's own time entries: minutes, billable, or notes.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, entryId: { type: "string" }, minutes: { type: "number" }, billable: { type: "boolean" }, notes: { type: "string" } },
      required: ["tenantId", "entryId"],
    },
    handler: (args, principal) =>
      platformSend(
        "PATCH",
        `/api/${String(args.tenantId)}/time-entries/${String(args.entryId)}`,
        { minutes: args.minutes, billable: args.billable, notes: args.notes },
        principal,
      ),
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

  // WS4 §3 / D14 — the suspension surface. When the automation write gate (policy.ts) refuses a
  // medium+/unclassified write with a `suspend:` reason, the workflow calls THIS (a low-impact
  // write: it only records an intent for a human to review, it performs no business mutation) to
  // file a pending approval. A human decides it from the platform-ui approvals inbox. Keeping this
  // on the hub preserves the backbone rule: n8n → MCP (OBO) → platform, so the request is audited
  // under the workflow's least-privilege identity like every other action.
  registerTool({
    name: "approvals.request",
    description: "Record a suspended automation write for human approval (used after the gate returns suspend). workflowId + toolName required.",
    minAssurance: "low",
    write: true,
    impact: "low", // records an intent only; the gated write itself is NOT performed here
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        workflowId: { type: "string", description: "the OBO external id — wf:<name> for automation, or the agent's id" },
        toolName: { type: "string", description: "the tool that was suspended" },
        toolArgs: { type: "object", description: "the arguments it intended to use" },
        impact: { type: "string", enum: ["medium", "high", "unclassified"] },
        reason: { type: "string", description: "the suspend reason (hub gate for automation; high_write for an agent)" },
        origin: { type: "string", enum: ["automation", "agent"], description: "who was suspended (default automation)" },
        agentName: { type: "string", description: "the WS8 agent name when origin=agent" },
      },
      required: ["tenantId", "workflowId", "toolName"],
    },
    handler: (args, principal) =>
      platformSend(
        "POST",
        `/api/${String(args.tenantId)}/automation-approvals`,
        {
          workflowId: args.workflowId,
          toolName: args.toolName,
          toolArgs: args.toolArgs ?? {},
          impact: args.impact ?? "unclassified",
          reason: args.reason,
          origin: args.origin ?? "automation",
          agentName: args.agentName,
        },
        principal,
      ),
  });
}
