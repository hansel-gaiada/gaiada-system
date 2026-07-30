// WD-06 — Report sink v1 (D-4). Thin OBO fronts over the existing PM module endpoints
// (`/api/:t/pm/projects/:projectId/docs`, `/api/:t/pm/tasks`), scoped to `wf:report` ONLY
// (automation-policy.ts) — no other automation identity may see or call these tools.
//
// Placement of logic: none lives here. Both handlers forward the caller's OBO envelope to
// platform-nest exactly like pipeline-tools.ts's platformSend — Cerbos + RLS + writeActivity +
// events all run in the platform, not the hub. `pm.createTask`'s own bell notification comes
// for free from the platform's createTask handler (it notifies `assignee.responsibleId` on
// create) — no separate `notify` call is needed for the "bell" part of the D-4 acceptance
// criterion.
//
// Known data-model gap (documented, not invented around): `pipeline_runs` has no `project_id`
// or "assigned PM" column (0017_pipeline.sql), so there is no literal "the run's project" /
// "the run's PM" to read. Pending a schema link (tracked as a WD-06 follow-up), the report
// branch files the doc/task under a configured project (`WEBDEV_REPORT_PROJECT_ID`, mirroring
// the existing `INTAKE_PROJECT_ID`/`SLA_PROJECT_ID` env pattern) and assigns the task to the
// configured ops lead (`NOTIFY_USER_ID`, already reused by the pre-existing report/scope STUB
// notifies) as an honest placeholder — not a fabricated per-run lookup.
import { config } from "./config";
import { registerTool } from "./registry";

async function platformSend(method: "POST" | "PATCH", path: string, body: unknown, principal: { provider: string; externalId: string }): Promise<string> {
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
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

export function registerPmTools(): void {
  registerTool({
    name: "pm.createDoc",
    description:
      "Create a PM doc under a project (thin front over POST /api/:t/pm/projects/:projectId/docs). LOW write, allowlisted to wf:report only (WD-06 report sink). Returns { id }.",
    minAssurance: "low",
    write: true,
    impact: "low", // creates an internal PM doc row only — the same tier as pipeline.createRun
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        projectId: { type: "string", description: "the PM project to file the doc under" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["tenantId", "projectId", "title"],
    },
    handler: (args, principal) =>
      platformSend("POST", `/api/${String(args.tenantId)}/pm/projects/${String(args.projectId)}/docs`, {
        title: args.title, body: args.body,
      }, principal),
  });

  registerTool({
    name: "pm.createTask",
    description:
      "Create a PM task, optionally assigned to a person (thin front over POST /api/:t/pm/tasks). LOW write, allowlisted to wf:report only (WD-06 report sink). Assigning a person triggers the platform's own bell notification — no separate notify call needed. Returns { id }.",
    minAssurance: "low",
    write: true,
    impact: "low", // same tier as tasks.create (already an allow-listed low write elsewhere)
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        projectId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        assigneeUserId: { type: "string", description: "if set, assigned to this user (kind=person) — triggers the platform's assignment notification" },
      },
      required: ["tenantId", "projectId", "title"],
    },
    handler: (args, principal) => {
      const assigneeUserId = args.assigneeUserId ? String(args.assigneeUserId) : undefined;
      return platformSend("POST", `/api/${String(args.tenantId)}/pm/tasks`, {
        projectId: args.projectId,
        title: args.title,
        description: args.description,
        assignee: assigneeUserId
          ? { kind: "person", refId: assigneeUserId, responsibleId: assigneeUserId }
          : undefined,
      }, principal);
    },
  });
}
