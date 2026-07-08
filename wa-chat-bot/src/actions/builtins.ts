// Built-in business actions (Phase D). Each execute() calls a hub write-tool with the
// sender's OBO envelope — never the DB. Authorization + confirmation are handled by the
// executor before execute() is ever reached. tenantId comes from DEFAULT_TENANT_ID (a
// per-chat company mapping can replace this later).
import { config } from "../config";
import { registerAction } from "./registry";
import type { ActionResult } from "./types";

function needTenant(): string | null {
  return config.defaultTenantId || null;
}

export function registerBusinessActions(): void {
  registerAction<{ name: string }>({
    name: "project.create",
    description: "create a project (needs a verified, linked identity)",
    category: "business",
    riskTier: "medium",
    cerbos: { resource: "project", action: "create" },
    validate: (raw) => {
      const name = (typeof raw === "string" ? raw : String((raw as any).name ?? "")).trim();
      return name ? { ok: true, args: { name } } : { ok: false, error: "Usage: /project create <name>" };
    },
    preview: (a) => `Create a new project named "${a.name}".`,
    execute: async (a, ctx): Promise<ActionResult> => {
      const tenantId = needTenant();
      if (!tenantId) return { ok: false, message: "No company is configured for this bot (DEFAULT_TENANT_ID unset)." };
      const raw = await ctx.hub("projects.create", { tenantId, name: a.name });
      const { id } = JSON.parse(raw) as { id?: string };
      return { ok: true, message: `✅ Created project "${a.name}".`, ref: id };
    },
  });

  registerAction<{ projectId: string; title: string }>({
    name: "task.create",
    description: "create a task under a project",
    category: "business",
    riskTier: "low",
    cerbos: { resource: "task", action: "create" },
    validate: (raw) => {
      if (typeof raw !== "string") {
        const projectId = String((raw as any).projectId ?? "").trim();
        const title = String((raw as any).title ?? "").trim();
        return projectId && title ? { ok: true, args: { projectId, title } } : { ok: false, error: "Usage: /task create <projectId> <title>" };
      }
      const words = raw.trim().split(/\s+/);
      const projectId = words.shift() ?? "";
      const title = words.join(" ").trim();
      return projectId && title ? { ok: true, args: { projectId, title } } : { ok: false, error: "Usage: /task create <projectId> <title>" };
    },
    preview: (a) => `Create task "${a.title}" in project ${a.projectId}.`,
    execute: async (a, ctx): Promise<ActionResult> => {
      const tenantId = needTenant();
      if (!tenantId) return { ok: false, message: "No company is configured (DEFAULT_TENANT_ID unset)." };
      const raw = await ctx.hub("tasks.create", { tenantId, projectId: a.projectId, title: a.title });
      const { id } = JSON.parse(raw) as { id?: string };
      return { ok: true, message: `✅ Created task "${a.title}".`, ref: id };
    },
  });

  registerAction<{ taskId: string; assigneeId: string }>({
    name: "task.assign",
    description: "assign a task to a member",
    category: "business",
    riskTier: "medium",
    cerbos: { resource: "task", action: "update" },
    validate: (raw) => {
      const words = typeof raw === "string" ? raw.trim().split(/\s+/) : [String((raw as any).taskId ?? ""), String((raw as any).assigneeId ?? "")];
      const [taskId, assigneeId] = words;
      return taskId && assigneeId ? { ok: true, args: { taskId, assigneeId } } : { ok: false, error: "Usage: /task assign <taskId> <userId>" };
    },
    preview: (a) => `Assign task ${a.taskId} to ${a.assigneeId}.`,
    execute: async (a, ctx): Promise<ActionResult> => {
      const tenantId = needTenant();
      if (!tenantId) return { ok: false, message: "No company is configured (DEFAULT_TENANT_ID unset)." };
      await ctx.hub("tasks.update", { tenantId, taskId: a.taskId, assigneeId: a.assigneeId });
      return { ok: true, message: `✅ Assigned task ${a.taskId}.` };
    },
  });

  registerAction<{ taskId: string }>({
    name: "task.complete",
    description: "mark a task done",
    category: "business",
    riskTier: "low",
    cerbos: { resource: "task", action: "update" },
    validate: (raw) => {
      const taskId = (typeof raw === "string" ? raw : String((raw as any).taskId ?? "")).trim().split(/\s+/)[0] ?? "";
      return taskId ? { ok: true, args: { taskId } } : { ok: false, error: "Usage: /task complete <taskId>" };
    },
    preview: (a) => `Mark task ${a.taskId} as done.`,
    execute: async (a, ctx): Promise<ActionResult> => {
      const tenantId = needTenant();
      if (!tenantId) return { ok: false, message: "No company is configured (DEFAULT_TENANT_ID unset)." };
      await ctx.hub("tasks.update", { tenantId, taskId: a.taskId, status: "done" });
      return { ok: true, message: `✅ Completed task ${a.taskId}.` };
    },
  });
}
