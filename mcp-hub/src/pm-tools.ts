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

// P4-J2: unlike the older 401/403-only special-case below (still exactly what it was — untouched
// for the two pre-existing writes), EVERY non-2xx here now surfaces the platform's own `{error}`
// body verbatim, not a bare status code. This is load-bearing for `pm.setStatus`: a chain-enforced
// (P4-I1) status write can come back 409 with the platform's HttpErrorFilter-flattened message
// naming the actual blockers (e.g. `cannot move to "doing": blocked by 1 open dependency (Design
// mockup)`) — that text lives ONLY in `{error}`, the filter has already discarded any structured
// field, so a generic `platform ${path} 409` would silently swallow the one thing that makes the
// refusal actionable. An agent that can't see "blocked by X" retries forever; this is the fix.
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
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `platform ${path} ${res.status}`);
  }
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

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // P4-J2 — PM WRITE tools (decision 16: all FOUR classified `impact: "low"`, matching
  // pm.createTask/pm.createDoc above). Why low is safe rather than lax, and not a loophole — see
  // §4.2 of the Phase-4 plan:
  //   - The D14 gate only ever suspends `write && impact !== "low"` (policy.ts's authorize()).
  //     `low` means these NEVER suspend for an automation/agent caller and need NO
  //     approval-executables.ts entry — filing one would imply a protection that does not apply,
  //     since `automation_approvals.impact` is CHECK'd to medium|high|unclassified and a
  //     low-impact write cannot even be filed as a pending approval.
  //   - Impact tier is orthogonal to AUTHORIZATION. Cerbos + the platform's own RLS gate every one
  //     of these exactly as they gate a human's PATCH — `low` is a statement about blast radius and
  //     reversibility, never about permission. No handler below checks role/tenant/client-vs-staff;
  //     that would be a security bug wearing a feature's clothes (non-negotiable #1).
  //   - `pm.passBall` is genuinely cheap and reversible: it appends to the append-only assignment-
  //     history ledger (migration 0087, the same ledger `pm.taskAssignmentHistory` reads) — nothing
  //     is ever destroyed; a wrong pass is corrected by passing again.
  //   - `pm.setStatus` is the one to think hardest about: with P4-I1 chain enforcement a status
  //     write can be REJECTED server-side with a 409 when the task has open dependencies. That
  //     409's message (the blocker names, produced by platform-nest's `enforceStartGate`) reaches
  //     the caller VERBATIM via `platformSend`'s error path above, not a bare status code —
  //     specifically so an agent sees "blocked by X" instead of retrying a write that will fail
  //     identically forever.
  //
  // No tool here bypasses the endpoint a human uses: every one PATCHes/POSTs the exact same
  // /pm/tasks/:id or /comments route platform-ui's own lib/pmActions.ts calls (setTaskStatus,
  // reassignBall, rescheduleTask) / core/collab.controller.ts's createComment — same coupling
  // rules (progress/done/recurrence-spawn/dependency-clear cascade), same authorize() action
  // derivation (managing := "assignee" key present -> "manage", else "update"), same Cerbos
  // policies (resource_pm_task.yaml / resource_comment.yaml). No handler re-implements any of it.
  //
  // Cerbos hub-gate check (resource_mcp_tool.yaml): VERIFIED, not assumed — these four are
  // write:true + impact:"low", the exact shape the policy's automation conjunct already matches
  // generically (`request.resource.attr.impact == "low"` short-circuits the `all.of` before the
  // grant/executable-list term is ever reached). No edit to that file, no Cerbos restart needed;
  // see the ticket report for the live CheckResources calls that proved it.

  registerTool({
    name: "pm.setStatus",
    description:
      "Move a PM task to a different status (thin front over PATCH /api/:t/pm/tasks/:taskId {status}). LOW write — never suspends for an automation/agent caller. " +
      "May be REJECTED with a 409 whose message names the exact open dependency/dependencies blocking the move (P4-I1 chain enforcement) — that message reaches you VERBATIM (never a bare status code); do not retry the same status unless the named blocker has actually closed. " +
      "blockReason is an optional free-text reason, applied only when moving INTO an isBlocked status that has NO open dependencies (an external wait, e.g. 'waiting on the client') — moving into Blocked WITH open dependencies always attributes to the system instead and ignores this field. Cerbos-gated exactly like a human's status change (member-level 'update' action, not the assignee-only 'manage').",
    minAssurance: "low",
    write: true,
    impact: "low", // decision 16 — see the header block above; a chain-blocked move 409s server-side rather than corrupting the ladder, so an unattended low write can't silently violate P4-I1
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string", description: "a status id from the task's project's EFFECTIVE status registry (default ladder: backlog/todo/doing/blocked/done, or a project's own custom ids)" },
        blockReason: { type: "string", description: "optional; applied only when the target status isBlocked and there are no open dependencies" },
      },
      required: ["tenantId", "taskId", "status"],
    },
    handler: (args, principal) => {
      const body: Record<string, unknown> = { status: args.status };
      if (typeof args.blockReason === "string") body.blockReason = args.blockReason;
      return platformSend("PATCH", `/api/${String(args.tenantId)}/pm/tasks/${String(args.taskId)}`, body, principal);
    },
  });

  registerTool({
    name: "pm.setDueDate",
    description:
      "Set (or clear) a PM task's due date (thin front over PATCH /api/:t/pm/tasks/:taskId {dueDate}). LOW write. Pass a YYYY-MM-DD string to set it, or null/'' to clear it. Does not touch startDate, status, or the assignee. Cerbos-gated exactly like a human's due-date edit (member-level 'update' action).",
    minAssurance: "low",
    write: true,
    impact: "low", // same tier as pm.createTask/pm.createDoc — a scalar-date edit on an internal PM task, no cross-tenant or money effect
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        taskId: { type: "string" },
        dueDate: { type: ["string", "null"], description: "YYYY-MM-DD, or null/'' to clear" },
      },
      required: ["tenantId", "taskId", "dueDate"],
    },
    handler: (args, principal) => {
      const dueDate = args.dueDate === null || args.dueDate === undefined ? null : String(args.dueDate);
      return platformSend("PATCH", `/api/${String(args.tenantId)}/pm/tasks/${String(args.taskId)}`, { dueDate }, principal);
    },
  });

  registerTool({
    name: "pm.passBall",
    description:
      "Pass the Ball on a task to a person (thin front over PATCH /api/:t/pm/tasks/:taskId {assignee}). Ball = assignee.refId/kind, and the ball is ALWAYS a person — a department/division cannot take a turn. " +
      "Leaves Responsible (assignee.responsibleId) exactly as it was: this tool reads the task's CURRENT assignee first (GET /pm/tasks/:id) and carries the existing responsibleId/responsibleName forward unchanged, mirroring platform-ui's own reassignBall(); a task with no prior assignee bootstraps BOTH Ball and Responsible onto the new holder (same bootstrap convention as the UI). " +
      "Every pass appends to the append-only assignment-history ledger (migration 0087, read back via pm.taskAssignmentHistory) — it never overwrites or deletes a prior entry, so a wrong pass is corrected by passing again, never undone. assignmentNote is an optional free-text reason for this specific pass. " +
      "LOW write. Changing the Ball is the PRIVILEGED 'manage' action server-side (same as any assignee edit) — Cerbos requires company_admin/manager/team_lead, NOT a plain member or viewer, unlike pm.setStatus/pm.setDueDate/pm.comment.",
    minAssurance: "low",
    write: true,
    impact: "low", // decision 16 — cheap and reversible: an append-only ledger row, never a mutation of history
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        taskId: { type: "string" },
        refId: { type: "string", description: "the person now holding the ball (a user id) — Ball is always a person" },
        refName: { type: "string", description: "optional display name; defaults to refId if omitted" },
        assignmentNote: { type: "string", description: "optional free-text reason for this pass" },
      },
      required: ["tenantId", "taskId", "refId"],
    },
    handler: async (args, principal) => {
      const tenantId = String(args.tenantId);
      const taskId = String(args.taskId);
      const refId = String(args.refId);
      const refName = typeof args.refName === "string" && args.refName ? args.refName : refId;
      // Read-before-write is not a choice here: the platform's `validAssignee` treats a partial
      // assignee (refId with no responsibleId) as INVALID and nulls the whole field out, which
      // would silently clear the task's Responsible instead of leaving it alone. Fetching the
      // current assignee first — exactly what reassignBall does — is the only way to preserve it.
      const currentRaw = await platformGetPm(`/api/${tenantId}/pm/tasks/${taskId}`, principal);
      const current = JSON.parse(currentRaw) as {
        assignee: { kind: string; refId: string; refName: string; responsibleId: string; responsibleName: string } | null;
      };
      const assignee = current.assignee
        ? { ...current.assignee, kind: "person", refId, refName }
        : { kind: "person", refId, refName, responsibleId: refId, responsibleName: refName };
      const body: Record<string, unknown> = { assignee };
      if (typeof args.assignmentNote === "string") body.assignmentNote = args.assignmentNote;
      return platformSend("PATCH", `/api/${tenantId}/pm/tasks/${taskId}`, body, principal);
    },
  });

  registerTool({
    name: "pm.comment",
    description:
      "Post a comment on a PM task (thin front over POST /api/:t/comments {entityType:'task', entityId, body, ...}) — the same generic comment endpoint the platform UI uses for tasks; there is no PM-specific comment route. Triggers the platform's own @mention/assignee/follower notifications for free. LOW write. Cerbos-gated on the generic 'comment' resource (company_admin/manager/member/team_lead — viewers are read-only and excluded from commenting, same as a human).",
    minAssurance: "low",
    write: true,
    impact: "low", // same tier as pm.createDoc — an append-only comment row
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        taskId: { type: "string" },
        body: { type: "string", description: "comment text" },
        parentCommentId: { type: "string", description: "optional — reply to an existing comment" },
        mentions: { type: "array", items: { type: "string" }, description: "optional user ids to @-mention (each gets a notification)" },
      },
      required: ["tenantId", "taskId", "body"],
    },
    handler: (args, principal) => {
      const commentBody: Record<string, unknown> = { entityType: "task", entityId: String(args.taskId), body: args.body };
      if (typeof args.parentCommentId === "string") commentBody.parentCommentId = args.parentCommentId;
      if (Array.isArray(args.mentions)) commentBody.mentions = args.mentions.map(String);
      return platformSend("POST", `/api/${String(args.tenantId)}/comments`, commentBody, principal);
    },
  });
}
