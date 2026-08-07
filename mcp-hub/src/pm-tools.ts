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
import type { Principal } from "./principal";

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// P4-J1 — PM READ tools (Phase-4 Repsona-parity plan, workstream J: "Integrate WA bot to read,
// modify and write if the requesting user has the RBAC to do that, otherwise read only. The AI
// agents also capable of full access if the RBAC is enough.")
//
// Placement of logic: as with every tool above, NONE lives here. Each handler is a thin GET front
// over an existing platform-nest PM endpoint, forwarding the caller's OBO envelope exactly like
// platform-tools.ts's platformGet — the platform resolves the envelope to a real principal and its
// OWN Cerbos policies (`resource_pm_task.yaml` / `resource_pm_project.yaml`, derived roles
// company_admin/manager/member/viewer/team_lead scoped `inTenant`) decide what that principal may
// see. A client-tier principal, a staff principal with no PM role in this tenant, or a forged
// cross-tenant id all get whatever the platform's RLS + Cerbos already do to every other PM caller
// (403/404) — there is no bot-side or hub-side re-implementation of that check. That is the
// "otherwise read-only" outcome from the owner's request: it is Cerbos deciding, not this file.
//
// No impact gate: none of these four tools sets `write` (they are GETs), so the D14 write-suspend
// branch in policy.ts/cerbos.ts never engages for them, and they need no approval-executables.ts
// entry — reads carry no impact tier, mirroring workActivity.feed/staleTasks above them in the
// registry.
//
// minAssurance: "low", same as every other thin-front read tool in this hub (projects.list,
// tasks.list, workActivity.feed, …) — the real gate is downstream in the platform, not the
// assurance rank. Cerbos's hub-level `mcp_tool` policy (resource_mcp_tool.yaml) already authorizes
// any write:false tool at this assurance generically; no new conjunct is needed there for a plain
// read (see that file's own note next to this ticket's id).
//
// Vocabulary (owner decision 2026-08-06): Ball = `assignee.refId`/`assignee.kind`, Responsible =
// `assignee.responsibleId`. There is no "ball" column — the `ball` facet below maps onto the
// backend's `ball[]` query param, which matches `assignee->>'refId'` regardless of kind (a
// department/division can hold the ball, not only a person).
async function platformGetPm(path: string, principal: Principal): Promise<string> {
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

/** Comma-joins a string-array arg for a facet — the backend's `parseArrayParam`/
 *  `parseUuidArrayParam` accept either repeated keys OR one CSV value; CSV is the simpler shape
 *  to build from a tool-call's JSON args array. */
function csv(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const parts = arr.map(String).filter((s) => s.length > 0);
  return parts.length ? parts.join(",") : undefined;
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

  // ---- P4-J1 reads (see the header block above) ----

  registerTool({
    name: "pm.listTasks",
    description:
      "List PM tasks tenant-wide (thin front over GET /api/:t/pm/tasks, the P4-A1 server-side-filtered/paginated endpoint) — Cerbos-gated on YOUR identity, read-only, no impact gate. " +
      "Facets: status[]/tag[]/priority[]/responsible[]/ball[]/milestone[] (arrays), dueFrom/dueTo (YYYY-MM-DD), q (title/description search), overdueOnly/dueSoon (booleans, dueSoonDays sets the due-soon window), includeClosed (default false — closed tasks are hidden unless set), mine (your own tasks, by Ball or Responsible), cursor+limit for pagination (1..200, default 50). " +
      "Ball = assignee.refId/kind (who's doing it now, may be a person or a department); Responsible = assignee.responsibleId (who's accountable). Returns { items, nextCursor } — pass nextCursor back as cursor to page.",
    minAssurance: "low", // real authorization happens IN the platform per the OBO principal (resource_pm_task.yaml)
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        status: { type: "array", items: { type: "string" }, description: "status ids to include" },
        tag: { type: "array", items: { type: "string" }, description: "tag ids to include" },
        priority: { type: "array", items: { type: "string" }, description: "low|normal|high|urgent" },
        responsible: { type: "array", items: { type: "string" }, description: "responsibleId(s) — the accountable person/entity" },
        ball: { type: "array", items: { type: "string" }, description: "refId(s) — who currently holds the ball" },
        milestone: { type: "array", items: { type: "string" }, description: "milestone ids to include" },
        dueFrom: { type: "string", description: "YYYY-MM-DD" },
        dueTo: { type: "string", description: "YYYY-MM-DD" },
        q: { type: "string", description: "title/description search text" },
        overdueOnly: { type: "boolean" },
        dueSoon: { type: "boolean" },
        dueSoonDays: { type: "number", description: "window for dueSoon, default 3" },
        includeClosed: { type: "boolean", description: "default false — done tasks are hidden unless set" },
        includeSubtasks: { type: "boolean", description: "accepted for forward-compat; currently a no-op (subtasks are a checklist blob, not separate rows)" },
        mine: { type: "boolean", description: "restrict to tasks where you are Ball or Responsible" },
        cursor: { type: "string", description: "opaque page cursor from a prior call's nextCursor" },
        limit: { type: "number", description: "1..200 (default 50)" },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const qs = new URLSearchParams();
      const setCsv = (key: string, v: unknown) => {
        const s = csv(v);
        if (s) qs.set(key, s);
      };
      setCsv("status", args.status);
      setCsv("tag", args.tag);
      setCsv("priority", args.priority);
      setCsv("responsible", args.responsible);
      setCsv("ball", args.ball);
      setCsv("milestone", args.milestone);
      if (args.dueFrom) qs.set("dueFrom", String(args.dueFrom));
      if (args.dueTo) qs.set("dueTo", String(args.dueTo));
      if (args.q) qs.set("q", String(args.q));
      if (args.overdueOnly !== undefined) qs.set("overdueOnly", String(!!args.overdueOnly));
      if (args.dueSoon !== undefined) qs.set("dueSoon", String(!!args.dueSoon));
      if (args.dueSoonDays !== undefined) qs.set("dueSoonDays", String(Number(args.dueSoonDays)));
      if (args.includeClosed !== undefined) qs.set("includeClosed", String(!!args.includeClosed));
      if (args.includeSubtasks !== undefined) qs.set("includeSubtasks", String(!!args.includeSubtasks));
      if (args.mine === true) qs.set("assignee", "me");
      if (args.cursor) qs.set("cursor", String(args.cursor));
      if (args.limit !== undefined) qs.set("limit", String(Number(args.limit)));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return platformGetPm(`/api/${String(args.tenantId)}/pm/tasks${suffix}`, principal);
    },
  });

  registerTool({
    name: "pm.getTask",
    description:
      "Get one PM task's full detail (thin front over GET /api/:t/pm/tasks/:id) — assignee (Ball+Responsible), status, dates, tags, dependsOn, and blockedBy (live-computed open blockers). Cerbos-gated on YOUR identity, read-only.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, taskId: { type: "string" } },
      required: ["tenantId", "taskId"],
    },
    handler: (args, principal) => platformGetPm(`/api/${String(args.tenantId)}/pm/tasks/${String(args.taskId)}`, principal),
  });

  registerTool({
    name: "pm.listProjects",
    description:
      "List the tenant's projects (thin front over GET /api/:t/projects — there is no separate PM-only projects-list endpoint; PM projects are the same `projects` rows pm.getTask's project reference points at). Cerbos-gated on YOUR identity, read-only.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" } },
      required: ["tenantId"],
    },
    handler: (args, principal) => platformGetPm(`/api/${String(args.tenantId)}/projects`, principal),
  });

  registerTool({
    name: "pm.taskAssignmentHistory",
    description:
      "Full assignment/ball-pass history for one task, newest first (thin front over GET /api/:t/pm/tasks/:taskId/assignment-history) — each row is a real ledgered assignment-change event (ref/Ball, responsible, status, note, changed-by, timestamp), not a derived guess. Gated identically to pm.getTask (same task, same read action) — read-only.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, taskId: { type: "string" } },
      required: ["tenantId", "taskId"],
    },
    handler: (args, principal) => platformGetPm(`/api/${String(args.tenantId)}/pm/tasks/${String(args.taskId)}/assignment-history`, principal),
  });
}
