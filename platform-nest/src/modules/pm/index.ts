// Project-management module contract (WSA-2). Routes live in PmController (mounted at
// /api/:tenantId/pm/*, gated by ModuleEnabledGuard("pm")); this object carries the
// registry/catalog/MCP metadata. Rollups for PM tasks are currently emitted by the CORE
// task rollup provider (rollups/engine coreTaskRollups), so this contract adds no rollupProvider.
import type { ModuleContract } from "../contract";

export const pmModule: ModuleContract = {
  key: "pm",
  migrations: [
    "0018_pm.sql", "0036_pm_tags.sql", "0037_pm_task_custom_fields.sql", "0038_pm_project_statuses.sql",
    "0039_pm_task_recurrence.sql", "0040_pm_progress_snapshots.sql",
    // SCP-1n (BFF §63.1 item 5, §63.13) — a task can point at a social post, and the content-month task at its cycle.
    "202610271410_pm_task_links.sql",
    // SCP-5h (BFF §63.29.1) — the `project` template kind and pm_template_applications (apply-template, the kickoff move).
    "202610301200_pm_project_templates.sql",
    // SCP-5f (BFF §63.27.1) — the monthly cycle's step tasks: `linked_type` 'social_cycle_step' and `linked_step`, one task per step and cycle.
    "202610301310_pm_task_cycle_steps.sql",
  ],
  // IAM-01d migration: all 3 CLEAN — pure colon-to-dot renames onto the catalog's pm.task.* keys.
  permissions: [
    { key: "pm.task.read", description: "View project tasks" },
    { key: "pm.task.create", description: "Create project tasks" },
    { key: "pm.task.manage", description: "Assign/manage tasks, milestones and docs" },
  ],
  customFieldTargets: [],
  mcpTools: [
    {
      name: "pm.listTasks",
      description: "List the tenant's project tasks (Repsona-style rich tasks)",
      minAssurance: "low",
      method: "GET",
      pathTemplate: "/api/:tenantId/pm/tasks",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "pm.runTracker",
      description: "Run the AI Tracker on a task to propose progress/status updates",
      minAssurance: "verified",
      method: "POST",
      pathTemplate: "/api/:tenantId/pm/tasks/:taskId/tracker/run",
      write: true,
      impact: "low",
      inputSchema: {
        type: "object",
        properties: { tenantId: { type: "string" }, taskId: { type: "string" } },
        required: ["tenantId", "taskId"],
      },
    },
    // SCP-5h (BFF §63.29.5): apply a project template. It hands a project's worth of tasks to people, so it is a medium-impact
    // write: an agent's call is confirmed by the person in the thread (63.15) before it runs.
    {
      name: "pm.applyTemplate",
      description:
        "Apply a PM project template to a project: one milestone per phase and one task per template step, each due a number of "
        + "working days after the kickoff (the company's holiday calendar), its Ball and Responsible the person named for the "
        + "step's role. One transaction; a replayed id answers the same application, and a template already applied to the "
        + "project is refused (409 template_already_applied).",
      minAssurance: "low",
      write: true,
      impact: "medium",
      method: "POST",
      pathTemplate: "/api/:tenantId/pm/projects/:projectId/apply-template",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string", description: "Company id (route scope)." },
          projectId: { type: "string", description: "The project the tasks are made in." },
          id: { type: "string", description: "A new uuid for the application (a replay with the same id answers the same application)." },
          templateId: { type: "string", description: "A project template of the company (kind 'project')." },
          kickoff: { type: "string", description: "The kickoff day, YYYY-MM-DD." },
          people: { type: "object", description: "The person per role of the template: {<roleKey>: userId}. A role left out gets no assignee." },
        },
        required: ["tenantId", "projectId", "id", "templateId", "kickoff"],
      },
    },
  ],
  rollupProviders: [],
  uiManifest: [
    { label: "Projects", path: "/projects" },
    { label: "Tasks", path: "/tasks" },
  ],
  // routes: served by PmController in the NestJS port.
};
