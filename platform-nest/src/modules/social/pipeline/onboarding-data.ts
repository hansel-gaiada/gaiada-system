// SCP-5h (W5-C4) — the rows behind the onboarding routes (FRONTEND-BFF-CONTRACT §63.29.4). READS ONLY: starting onboarding is PM's
// `applyProjectTemplate` (modules/pm/pm.controller.ts), which this file never reimplements, and a tick or a kickoff move is PM's own
// route. Every function takes the caller's `PoolClient` inside `withTenants([tenantId], ..., { modules: ["social"] })`; the social tables
// carry the third wall, so each declares the module scope itself (`declareSocialModuleScope`). PM's tables are core (the plain wall).
//
// WHAT "IN ONBOARDING" MEANS (§63.29.4): the engagements still in `draft`, and every engagement whose project carries an application of
// the company's chosen template with a task still open. An engagement with a finished application leaves the list.
import type { PoolClient } from "pg";
import { declareSocialModuleScope } from "../module-scope";
import { effectiveStatuses, readTemplateApplicationsInTx, type TemplateApplicationItem } from "../../pm/pm.controller";
import { validateProjectTemplatePayload, type ProjectTemplatePayload } from "../../pm/project-templates";
import { userNames } from "./pipeline-data";
import {
  hasOpenTask, isLateDay, sortOnboarding, startBlockOf, type OnboardingItem, type OnboardingStep,
} from "./onboarding";

/** The company's chosen onboarding template id (`social_settings.onboarding_template_id`), or null: nothing chosen. */
export async function readOnboardingTemplateId(c: PoolClient, tenantId: string): Promise<string | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string | null }>(
    `SELECT onboarding_template_id::text AS id FROM social_settings WHERE tenant_id = $1`, [tenantId]);
  return rows[0]?.id ?? null;
}

export interface TemplateRef { id: string; name: string; payload: ProjectTemplatePayload }

/**
 * A LIVE `project` template of this company, with its payload read through the validator, or null (missing, deleted, another company's
 * or another kind). The same test the settings route applies before it writes, and the one the start applies before it reads roles.
 */
export async function readProjectTemplate(c: PoolClient, tenantId: string, templateId: string): Promise<TemplateRef | null> {
  const { rows } = await c.query<{ id: string; name: string; payload: unknown }>(
    `SELECT id::text AS id, name, payload FROM pm_templates WHERE tenant_id = $1 AND id = $2 AND kind = 'project' AND deleted_at IS NULL`,
    [tenantId, templateId]);
  const r = rows[0];
  if (!r) return null;
  try {
    return { id: r.id, name: r.name, payload: validateProjectTemplatePayload(r.payload) };
  } catch {
    // A stored payload that no longer validates cannot be applied: it reads as "not a usable template".
    return null;
  }
}

/** The company's onboarding template for a read: id and name only (a template that was deleted since reads as not set). */
export async function readOnboardingTemplate(c: PoolClient, tenantId: string): Promise<{ id: string; name: string } | null> {
  const id = await readOnboardingTemplateId(c, tenantId);
  if (!id) return null;
  const { rows } = await c.query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM pm_templates WHERE tenant_id = $1 AND id = $2 AND kind = 'project' AND deleted_at IS NULL`, [tenantId, id]);
  return rows[0] ?? null;
}

/** The engagement the start works on: its client, officer and project (null when the project was deleted since). */
export interface StartEngagement { id: string; clientName: string; ownerId: string | null; projectId: string | null }

export async function loadStartEngagement(c: PoolClient, tenantId: string, engagementId: string): Promise<StartEngagement | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; client_name: string; owner_id: string | null; project_id: string | null }>(
    `SELECT e.id::text AS id, cl.name AS client_name, e.owner_id::text AS owner_id,
            (SELECT p.id::text FROM projects p WHERE p.tenant_id = e.tenant_id AND p.id = e.project_id AND p.deleted_at IS NULL) AS project_id
       FROM social_engagements e JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.id = $2 AND e.deleted_at IS NULL`,
    [tenantId, engagementId]);
  const r = rows[0];
  return r ? { id: r.id, clientName: r.client_name, ownerId: r.owner_id, projectId: r.project_id } : null;
}

interface EngagementRow {
  id: string; client_id: string; client_name: string; status: string; owner_id: string | null; project_id: string | null;
}

/** The engagements that are `draft`, or whose project is one of `projectIds` (the projects carrying an application). Live engagements only. */
async function readCandidates(c: PoolClient, tenantId: string, projectIds: readonly string[]): Promise<EngagementRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<EngagementRow>(
    `SELECT e.id::text AS id, e.client_id::text AS client_id, cl.name AS client_name, e.status, e.owner_id::text AS owner_id,
            (SELECT p.id::text FROM projects p WHERE p.tenant_id = e.tenant_id AND p.id = e.project_id AND p.deleted_at IS NULL) AS project_id
       FROM social_engagements e JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.deleted_at IS NULL AND (e.status = 'draft' OR e.project_id = ANY($2::uuid[]))
      ORDER BY cl.name, e.id`,
    [tenantId, projectIds]);
  return rows;
}

/**
 * Each engagement's baseline audit: the client's earliest FINAL audit (the dated record a new client starts from, §63.28), else its live
 * draft, else none. A prospect's audit attached to the client counts (`engagement_id` is set on attach).
 */
async function readBaselineAudits(c: PoolClient, tenantId: string, engagementIds: readonly string[]): Promise<Map<string, { auditId: string; status: string; overall: number | null }>> {
  const out = new Map<string, { auditId: string; status: string; overall: number | null }>();
  if (engagementIds.length === 0) return out;
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; engagement_id: string; status: string; overall: number | null }>(
    `SELECT DISTINCT ON (a.engagement_id) a.id::text AS id, a.engagement_id::text AS engagement_id, a.status, a.overall
       FROM social_audits a
      WHERE a.tenant_id = $1 AND a.engagement_id = ANY($2::uuid[]) AND a.deleted_at IS NULL
      ORDER BY a.engagement_id, (a.status = 'final') DESC, a.finalized_at ASC NULLS LAST, a.created_at DESC`,
    [tenantId, engagementIds]);
  for (const r of rows) out.set(r.engagement_id, { auditId: r.id, status: r.status, overall: r.overall === null ? null : Number(r.overall) });
  return out;
}

/** The checklist of each application: its tasks in the template's order, with the template's phase and role words and the task's own state. */
async function readSteps(
  c: PoolClient, apps: readonly TemplateApplicationItem[], today: string,
): Promise<{ steps: Map<string, OnboardingStep[]>; doneStatus: Map<string, string | null> }> {
  const steps = new Map<string, OnboardingStep[]>();
  const doneStatus = new Map<string, string | null>();
  if (apps.length === 0) return { steps, doneStatus };
  const stored = await c.query<{ id: string; tasks: Array<{ key: string; taskId: string; phase: string }>; template_payload: unknown }>(
    `SELECT id::text AS id, tasks, template_payload FROM pm_template_applications WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [apps.map((a) => a.id)]);
  const taskIds = stored.rows.flatMap((r) => r.tasks.map((t) => t.taskId));
  const tasks = await c.query<{ id: string; title: string; status: string; dueDate: string | null }>(
    `SELECT id::text AS id, title, status, to_char(due_date, 'YYYY-MM-DD') AS "dueDate" FROM pm_tasks WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [taskIds]);
  const byTask = new Map(tasks.rows.map((t) => [t.id, t]));
  const projectOf = new Map(apps.map((a) => [a.id, a.projectId]));
  const doneIds = new Map<string, Set<string>>();
  for (const projectId of new Set(apps.map((a) => a.projectId))) {
    const statuses = await effectiveStatuses(c, projectId);
    doneIds.set(projectId, new Set(statuses.filter((s) => s.isDone).map((s) => s.id)));
    doneStatus.set(projectId, statuses.find((s) => s.isDone)?.id ?? null);
  }
  for (const app of stored.rows) {
    const payload = app.template_payload as ProjectTemplatePayload;
    const phaseTitle = new Map((payload.phases ?? []).map((p) => [p.key, p.title]));
    const roleLabel = new Map((payload.roles ?? []).map((r) => [r.key, r.label]));
    const roleOf = new Map((payload.tasks ?? []).map((t) => [t.key, t.role]));
    const done = doneIds.get(projectOf.get(app.id) ?? "") ?? new Set<string>();
    const list: OnboardingStep[] = [];
    for (const t of app.tasks) {
      const row = byTask.get(t.taskId);
      if (!row) continue; // deleted since: not a step any more (PM's progress skips it too)
      const isDone = done.has(row.status);
      const role = roleOf.get(t.key) ?? "";
      list.push({
        key: t.key, taskId: row.id, title: row.title, phase: t.phase, phaseTitle: phaseTitle.get(t.phase) ?? t.phase, role,
        roleLabel: roleLabel.get(role) ?? role, dueDate: row.dueDate, done: isDone, late: isLateDay(row.dueDate, isDone, today),
      });
    }
    steps.set(app.id, list);
  }
  return { steps, doneStatus };
}

/**
 * The onboarding list (§63.29.4 `GET onboarding`), assembled from PM's applications of the company's template (`readTemplateApplicationsInTx`,
 * the one reader of progress and the next step), the engagements, the baseline audits and the steps. A fixed number of statements per
 * application's project, whatever the number of clients.
 */
export async function readOnboarding(
  c: PoolClient, tenantId: string, today: string, template: { id: string; name: string } | null, canPlan: boolean,
): Promise<{ template: { id: string; name: string } | null; items: OnboardingItem[]; canStart: boolean }> {
  const apps = template ? await readTemplateApplicationsInTx(c, { templateId: template.id }, today) : [];
  // A client is listed while it is a draft, or while its application has a task open; a draft whose application is finished is still
  // listed (it is still a draft), as 100%, never as "not started".
  const candidates = await readCandidates(c, tenantId, apps.filter((a) => hasOpenTask(a.progress)).map((a) => a.projectId));
  const appByProject = new Map(apps.map((a) => [a.projectId, a]));
  const listed = candidates;

  const audits = await readBaselineAudits(c, tenantId, listed.map((e) => e.id));
  const listedApps = listed.flatMap((e) => (e.project_id && appByProject.has(e.project_id) ? [appByProject.get(e.project_id)!] : []));
  const { steps, doneStatus } = await readSteps(c, listedApps, today);
  const names = await userNames(c, listed.map((e) => e.owner_id));

  const items = listed.map((e): OnboardingItem => {
    const app = e.project_id ? appByProject.get(e.project_id) ?? null : null;
    return {
      engagementId: e.id, clientId: e.client_id, clientName: e.client_name, engagementStatus: e.status,
      officer: e.owner_id ? { id: e.owner_id, name: names.get(e.owner_id) ?? "A colleague" } : null,
      projectId: e.project_id, applicationId: app?.id ?? null, kickoff: app?.kickoff ?? null,
      progress: app?.progress ?? { done: 0, total: 0 },
      next: app?.next ?? null,
      baselineAudit: audits.get(e.id) ?? null,
      steps: app ? steps.get(app.id) ?? [] : [],
      doneStatusId: e.project_id ? doneStatus.get(e.project_id) ?? null : null,
      startBlock: app ? null : startBlockOf(e.project_id, template),
    };
  });
  return { template, items: sortOnboarding(items), canStart: canPlan };
}
