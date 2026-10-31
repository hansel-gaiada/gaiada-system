import "server-only";
// SCP-5 W5-C5 (BFF §63.29.1, §63.29.2) — what DEMO_MODE answers for the onboarding template the rules page edits:
//
//   GET   <pm>/templates?kind=project        the company's project templates (the seeded "Social media client onboarding": the team's fifteen steps in six phases)
//   PATCH <pm>/templates/:id                 `{payload}`: PM's own route; 400 `invalid_field` `{field: 'payload.<path>'}` as `validateProjectTemplatePayload` refuses it
//   PUT   settings `onboardingTemplateId`    the company's choice (null clears it); anything but a live project template is 400 `{field: 'onboardingTemplateId'}`
//
// PM's gate is `pm_task` · `manage`; in the demo that is the four approvers (a client contact and the other staff are refused with PM's own 403 words). A template already applied keeps its own copy
// (63.29.1), so editing the steps here changes no running onboarding in the demo either. The list answers only `kind=project`, and the PATCH only this store's templates: any other is left to PM's own demo.
import { isDemoSocialApprover, type DemoResult } from "./demoSocialPipeline";
import { DEMO_ONBOARDING_PHASES, DEMO_ONBOARDING_ROLES, DEMO_ONBOARDING_STEPS, DEMO_ONBOARDING_TEMPLATE } from "./demoSocialOnboarding";
import { TEMPLATE_LIMITS, type TemplatePayload } from "./socialOnboardingTemplate";

interface DemoTemplate { id: string; name: string; updatedAt: string; payload: TemplatePayload }
interface Store { chosen: string | null; templates: DemoTemplate[] }
const STORE = "__demoOnboardingTemplate";
type G = typeof globalThis & { [STORE]?: Store };

function seed(): Store {
  const payload: TemplatePayload = {
    title: "Client onboarding",
    phases: DEMO_ONBOARDING_PHASES.map((p) => ({ key: p.key, title: p.title })),
    roles: Object.entries(DEMO_ONBOARDING_ROLES).map(([key, label]) => ({ key, label })),
    tasks: DEMO_ONBOARDING_STEPS.map((s) => ({ key: s.key, title: s.title, phase: s.phase, role: s.role, dueOffsetWorkingDays: s.offset })),
  };
  return { chosen: DEMO_ONBOARDING_TEMPLATE.id, templates: [{ id: DEMO_ONBOARDING_TEMPLATE.id, name: DEMO_ONBOARDING_TEMPLATE.name, updatedAt: "2026-10-30T09:00:00.000Z", payload }] };
}
const store = (): Store => ((globalThis as G)[STORE] ??= seed());
/** Test hook: back to the seed. */
export function resetDemoOnboardingTemplate(): void { delete (globalThis as G)[STORE]; }

/** The company's chosen template, as `GET settings` answers it. */
export function demoChosenTemplate(): { id: string; name: string } | null {
  const s = store();
  const t = s.templates.find((x) => x.id === s.chosen);
  return t ? { id: t.id, name: t.name } : null;
}
/** `onboardingTemplateId` of `PUT settings`: null clears, a live project template's id sets, anything else is refused by field. */
export function demoChooseTemplate(id: unknown): boolean {
  const s = store();
  if (id === null) { s.chosen = null; return true; }
  if (typeof id !== "string" || !s.templates.some((t) => t.id === id)) return false;
  s.chosen = id;
  return true;
}

// ── PM's `validateProjectTemplatePayload`, for the demo ─────────────────────────────────────────────────────────────────────

const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;
type Obj = Record<string, unknown>;
class Bad extends Error { constructor(readonly field: string) { super(field); } }
const bad = (path: string): never => { throw new Bad(`payload${path ? `.${path}` : ""}`); };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
function text(v: unknown, path: string, max: number, required = true): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string") return bad(path);
  const t = v.trim();
  if ((required && t.length === 0) || t.length > max) return bad(path);
  return t;
}
function key(v: unknown, path: string): string { if (typeof v !== "string" || v.length === 0 || v.length > 40 || !KEY_RE.test(v)) return bad(path); return v; }
function list(v: unknown, path: string, min: number, max: number): unknown[] { if (!Array.isArray(v) || v.length < min || v.length > max) return bad(path); return v; }

function validatePayload(payload: unknown): TemplatePayload {
  const L = TEMPLATE_LIMITS;
  if (!isObj(payload)) return bad("");
  const title = text(payload.title, "title", L.titleMax)!;
  const pk = new Set<string>();
  const phases = list(payload.phases, "phases", L.phases.min, L.phases.max).map((p, i) => {
    if (!isObj(p)) return bad(`phases.${i}`);
    const k = key(p.key, `phases.${i}.key`);
    if (pk.has(k)) bad(`phases.${i}.key`);
    pk.add(k);
    return { key: k, title: text(p.title, `phases.${i}.title`, L.labelMax)! };
  });
  const rk = new Set<string>();
  const roles = list(payload.roles, "roles", L.roles.min, L.roles.max).map((r, i) => {
    if (!isObj(r)) return bad(`roles.${i}`);
    const k = key(r.key, `roles.${i}.key`);
    if (rk.has(k)) bad(`roles.${i}.key`);
    rk.add(k);
    return { key: k, label: text(r.label, `roles.${i}.label`, L.labelMax)! };
  });
  const tk = new Set<string>();
  const tasks = list(payload.tasks, "tasks", L.tasks.min, L.tasks.max).map((t, i) => {
    if (!isObj(t)) return bad(`tasks.${i}`);
    const k = key(t.key, `tasks.${i}.key`);
    if (tk.has(k)) bad(`tasks.${i}.key`);
    tk.add(k);
    const out: TemplatePayload["tasks"][number] = { key: k, title: text(t.title, `tasks.${i}.title`, L.titleMax)!, phase: key(t.phase, `tasks.${i}.phase`), role: key(t.role, `tasks.${i}.role`), dueOffsetWorkingDays: 0 };
    if (!pk.has(out.phase)) bad(`tasks.${i}.phase`);
    if (!rk.has(out.role)) bad(`tasks.${i}.role`);
    const off = t.dueOffsetWorkingDays;
    if (typeof off !== "number" || !Number.isInteger(off) || off < L.offset.min || off > L.offset.max) bad(`tasks.${i}.dueOffsetWorkingDays`);
    out.dueOffsetWorkingDays = off as number;
    const description = text(t.description, `tasks.${i}.description`, L.descriptionMax, false);
    if (description) out.description = description;
    if (t.subtasks !== undefined) {
      const subs = list(t.subtasks, `tasks.${i}.subtasks`, 0, L.subtasks.max).map((s, j) => text(s, `tasks.${i}.subtasks.${j}`, L.titleMax)!);
      if (subs.length > 0) out.subtasks = subs;
    }
    return out;
  });
  return { title, phases, roles, tasks };
}

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });

/** PM's template routes for a project template of this store; null for anything else, so PM's own demo answers. `path` is the full path, `search` its query. */
export function demoOnboardingTemplateRoute(m: string, path: string, search: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const list_ = path.match(/^\/api\/[^/]+\/pm\/templates$/);
  if (list_ && m === "GET" && search.get("kind") === "project") {
    if (!isDemoSocialApprover(userId)) return err(403, "not authorized: cerbos denied manage on pm_task");
    return { status: 200, json: store().templates.map((t) => ({ id: t.id, kind: "project", name: t.name, payload: t.payload, updatedAt: t.updatedAt })) };
  }
  const one = path.match(/^\/api\/[^/]+\/pm\/templates\/([^/]+)$/);
  if (!one || m !== "PATCH") return null;
  const t = store().templates.find((x) => x.id === one[1]);
  if (!t) return null;
  if (!isDemoSocialApprover(userId)) return err(403, "not authorized: cerbos denied manage on pm_task");
  let b: unknown = null;
  try { b = body ? JSON.parse(body) : null; } catch { b = null; }
  if (!isObj(b) || b.payload === undefined) return { status: 200, json: { id: t.id, kind: "project", name: t.name, payload: t.payload } };
  try {
    t.payload = validatePayload(b.payload);
  } catch (e) {
    if (e instanceof Bad) return err(400, "invalid_field", { field: e.field });
    throw e;
  }
  t.updatedAt = new Date().toISOString();
  return { status: 200, json: { id: t.id, kind: "project", name: t.name, payload: t.payload } };
}
