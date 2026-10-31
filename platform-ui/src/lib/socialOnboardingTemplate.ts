// SCP-5 W5-C5 (BFF §63.29, §63.30.1) — the company's onboarding template as the rules page edits it. The template is a PM `project` template: Social only remembers WHICH one is the company's
// (`PUT settings` `onboardingTemplateId`, 63.29.2), and the steps are edited through PM's own template routes (`GET templates?kind=project`, `PATCH templates/:id`, 63.29.1). No server-only import, so a client component
// may import the values.
//
// WHAT THE SERVER GIVES THIS PAGE, and where it falls short of the contract's picture (reported, not changed): PM's template routes are gated `pm_task` · `manage`, not Social's four, so a Social approver without PM
// management cannot list or edit a template (the page says so and still shows the chosen template's name); `PATCH` has no version, so two editors overwrite each other (the last save wins); and a refusal of the
// payload is a 400 `invalid_field` `{field: 'payload.<path>'}` with PM's own paths, not `<section>.<path>`.
import { PLAN_REFUSAL_REASON } from "./socialCycles";
import type { Refusal } from "./socialPipeline";
import { REFUSAL_WORDS } from "./socialPipeline";
import { slugKey } from "./socialRules";

/** The server's limits (`PROJECT_TEMPLATE_LIMITS`). */
export const TEMPLATE_LIMITS = {
  phases: { min: 1, max: 12 }, roles: { min: 1, max: 10 }, tasks: { min: 1, max: 80 }, subtasks: { max: 20 }, offset: { min: 0, max: 250 }, titleMax: 200, descriptionMax: 2000, labelMax: 120,
} as const;

export interface TemplatePhase { key: string; title: string }
export interface TemplateRole { key: string; label: string }
export interface TemplateTask { key: string; title: string; description?: string; phase: string; role: string; dueOffsetWorkingDays: number; subtasks?: string[] }
export interface TemplatePayload { title: string; phases: TemplatePhase[]; roles: TemplateRole[]; tasks: TemplateTask[] }
export interface ProjectTemplate { id: string; name: string; updatedAt: string | null; payload: TemplatePayload }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A payload as the editor reads it. Tolerant of a value the server stored by an older rule; the server validates what is sent back. */
export function asPayload(raw: unknown): TemplatePayload {
  const o = isObj(raw) ? raw : {};
  const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);
  return {
    title: str(o.title),
    phases: rows(o.phases).map((p) => ({ key: str(p.key), title: str(p.title) })),
    roles: rows(o.roles).map((r) => ({ key: str(r.key), label: str(r.label) })),
    tasks: rows(o.tasks).map((t) => ({
      key: str(t.key), title: str(t.title), phase: str(t.phase), role: str(t.role), dueOffsetWorkingDays: typeof t.dueOffsetWorkingDays === "number" ? t.dueOffsetWorkingDays : 0,
      ...(typeof t.description === "string" && t.description ? { description: t.description } : {}),
      ...(Array.isArray(t.subtasks) && t.subtasks.length ? { subtasks: t.subtasks.filter((s): s is string => typeof s === "string") } : {}),
    })),
  };
}

/** `GET templates?kind=project`. Throws on a body that is not a list, so the page says "cannot tell". */
export function asProjectTemplates(raw: unknown): ProjectTemplate[] {
  if (!Array.isArray(raw)) throw new Error("templates: not a list");
  return raw.filter(isObj).filter((t) => typeof t.id === "string" && (t.kind === undefined || t.kind === "project")).map((t) => ({
    id: t.id as string, name: str(t.name) || "Untitled template", updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : null, payload: asPayload(t.payload),
  }));
}

/** The body of `PATCH templates/:id`: the payload alone (the name is PM's own and is not edited here). Optional empty fields are left out, as the server treats them as none. */
export function templateBody(p: TemplatePayload): { payload: TemplatePayload } {
  return {
    payload: {
      title: p.title, phases: p.phases, roles: p.roles,
      tasks: p.tasks.map((t) => {
        const { description, subtasks, ...rest } = t;
        const subs = (subtasks ?? []).filter((x) => x.trim() !== "");
        return { ...rest, ...(description && description.trim() ? { description } : {}), ...(subs.length ? { subtasks: subs } : {}) };
      }),
    },
  };
}

// ── The lists' helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

export const newPhase = (taken: string[]): TemplatePhase => ({ key: slugKey("phase", taken), title: "New phase" });
export const newRole = (taken: string[]): TemplateRole => ({ key: slugKey("role", taken), label: "New role" });
export function newTask(t: TemplatePayload): TemplateTask {
  return { key: slugKey("step", t.tasks.map((x) => x.key)), title: "New step", phase: t.phases[0]?.key ?? "", role: t.roles[0]?.key ?? "", dueOffsetWorkingDays: 0 };
}
/** Steps shown by phase, in the template's phase order, each phase's steps in the order they are listed. */
export function tasksByPhase(t: TemplatePayload): Array<{ phase: TemplatePhase; tasks: Array<{ task: TemplateTask; index: number }> }> {
  return t.phases.map((phase) => ({ phase, tasks: t.tasks.map((task, index) => ({ task, index })).filter((x) => x.task.phase === phase.key) }));
}
/** Remove a phase or a role only when no step uses it. */
export const phaseInUse = (t: TemplatePayload, key: string): boolean => t.tasks.some((x) => x.phase === key);
export const roleInUse = (t: TemplatePayload, key: string): boolean => t.tasks.some((x) => x.role === key);

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const LAST: Readonly<Record<string, string>> = {
  title: "the title", key: "the key", label: "the name", phase: "the phase", role: "the role", dueOffsetWorkingDays: "the working days after the kickoff", description: "the description", subtasks: "the sub-steps",
  phases: "the phases", roles: "the roles", tasks: "the steps",
};
const NOUN: Readonly<Record<string, string>> = { phases: "phase", roles: "role", tasks: "step", subtasks: "sub-step" };

/** "payload.tasks.3.phase" in words: "Step 4, the phase". */
export function payloadFieldWords(field: string): string {
  const parts = field.split(".").slice(1);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (NOUN[p] && /^\d+$/.test(parts[i + 1] ?? "")) { out.push(`${NOUN[p]} ${Number(parts[i + 1]) + 1}`); i++; continue; }
    out.push(LAST[p] ?? p);
  }
  const s = out.join(", ") || "The template";
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

function payloadHint(field: string): string | null {
  const last = field.split(".").pop() ?? "";
  if (field === "payload.phases") return "Keep one to 12 phases.";
  if (field === "payload.roles") return "Keep one to 10 roles.";
  if (field === "payload.tasks") return "Keep one to 80 steps.";
  if (last === "key") return "A key is unique, in lower case, and uses letters, digits, dashes and underscores.";
  if (last === "phase" || last === "role") return "Choose one of the template's own.";
  if (last === "dueOffsetWorkingDays") return "Use a whole number of working days from 0 to 250.";
  if (last === "title" || last === "label") return "It needs some words, within its length limit.";
  if (last === "description") return "A description is at most 2,000 characters.";
  if (/subtasks/.test(field)) return "A sub-step needs some words; keep at most 20 sub-steps.";
  return null;
}

export type TemplateWrite = "choose" | "save";

/** The sentence for a refusal of a template write: the contract's code stays the code; this is its words. */
export function templateRefusalText(r: Refusal, kind: TemplateWrite): string {
  if (r.error === "session_expired") return "Session expired — sign in again.";
  if (r.error === "no_company") return "No active company selected.";
  if (r.error === "not_a_social_approver") return PLAN_REFUSAL_REASON.replace("change this", "choose the onboarding template");
  if (r.error === "automation_cannot_act") return "An automated account cannot do this. A person does.";
  if (r.error === "invalid_field") {
    if (r.field === "onboardingTemplateId") return "That is not a live project template of this company. Reload the page and choose again.";
    if (r.field?.startsWith("payload")) { const h = payloadHint(r.field); return `${payloadFieldWords(r.field)} is not valid.${h ? ` ${h}` : ""}`; }
    return r.field ? `${r.field} is not valid.` : "A value is not valid.";
  }
  if (r.status === 403) return kind === "save"
    ? "Editing the template's steps needs the right to manage Project Management templates. Ask an admin to give you that, or ask someone who has it."
    : PLAN_REFUSAL_REASON.replace("change this", "choose the onboarding template");
  if (r.status === 404) return "That template is gone. It may have been deleted. Reload the page.";
  return REFUSAL_WORDS[r.error] ?? "That did not work. Reload the page and try again.";
}

/** A due day in words, for the step list: 0 is the kickoff day itself. */
export const offsetWords = (n: number): string => (n === 0 ? "On the kickoff day" : `${n} working ${n === 1 ? "day" : "days"} after the kickoff`);
